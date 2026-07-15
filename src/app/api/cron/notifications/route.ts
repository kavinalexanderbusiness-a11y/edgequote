import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'
import { addDays, format } from 'date-fns'
import { renderMessage, MsgType, type MessagePrefs } from '@/lib/comms/templates'
import { commsEnabled } from '@/lib/comms/send'
import { SENT_STATES } from '@/lib/comms/delivery'
import { dispatchToCustomer } from '@/lib/comms/dispatch'
import { logDispatch } from '@/lib/comms/log'
import { ensurePortalToken, portalUrl } from '@/lib/portal'
import { resolveAutomations, Automations } from '@/lib/comms/automations'
import { canAskForReview } from '@/lib/crm/reviews'

export const dynamic = 'force-dynamic'

// Scheduled sends (Vercel Cron → see vercel.json). Sends TOMORROW reminders and
// REVIEW requests for yesterday's completed visits. Fully guarded:
//   • requires CRON_SECRET (so the endpoint can't be triggered by anyone),
//   • no-ops when comms credentials are absent (nothing sends),
//   • needs SUPABASE_SERVICE_ROLE_KEY to read across customers,
//   • de-dupes via notification_log and honours per-customer opt-in.

interface CronCustomer { name: string; phone: string | null; email: string | null; sms_opt_in: boolean; email_opt_in: boolean; message_prefs?: MessagePrefs | null; reviewed_at: string | null; review_declined_at: string | null; review_requested_at: string | null }
interface CronJob { id: string; user_id: string; customer_id: string | null; scheduled_date: string; customers: CronCustomer | null }

export async function GET(req: NextRequest) {
  const secret = req.headers.get('authorization')?.replace('Bearer ', '') || new URL(req.url).searchParams.get('secret') || ''
  if (!process.env.CRON_SECRET || secret !== process.env.CRON_SECRET) {
    return NextResponse.json({ error: 'forbidden' }, { status: 403 })
  }
  const enabled = commsEnabled()
  if (!enabled.sms && !enabled.email) {
    return NextResponse.json({ ok: true, disabled: true, note: 'Comms disabled — set Twilio/Resend env vars to enable scheduled sends.' })
  }
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL, svc = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!url || !svc) {
    return NextResponse.json({ ok: true, skipped: true, note: 'Set SUPABASE_SERVICE_ROLE_KEY to enable scheduled sends.' })
  }
  const supabase = createClient(url, svc)

  const tomorrow = format(addDays(new Date(), 1), 'yyyy-MM-dd')
  const yesterday = format(addDays(new Date(), -1), 'yyyy-MM-dd')
  const bizCache: Record<string, { name: string; templates: Partial<Record<MsgType, string>> | null; reviewUrl: string | null; logoUrl: string | null; website: string | null; phone: string | null; automations: Automations }> = {}
  async function bizInfo(userId: string) {
    if (bizCache[userId]) return bizCache[userId]
    const { data } = await supabase.from('business_settings').select('company_name, phone, website, logo_url, review_url, message_templates, automations').eq('user_id', userId).maybeSingle()
    const d = data as { company_name: string | null; phone: string | null; website: string | null; logo_url: string | null; review_url: string | null; message_templates: Partial<Record<MsgType, string>> | null; automations: unknown } | null
    return (bizCache[userId] = { name: d?.company_name || 'Edge Property Services', templates: d?.message_templates ?? null, reviewUrl: d?.review_url ?? null, logoUrl: d?.logo_url ?? null, website: d?.website ?? null, phone: d?.phone ?? null, automations: resolveAutomations(d?.automations) })
  }
  async function alreadySent(userId: string, jobId: string, template: string): Promise<boolean> {
    // Only a SUCCESSFUL prior send blocks a resend — otherwise a failed attempt
    // (Resend/Twilio down) would log a row and never be retried on the next run.
    // SENT_STATES, not status='sent': a delivery webhook may have already carried
    // that row to 'delivered'/'bounced', and an equality check on 'sent' would miss
    // it and text the customer a second time.
    const { data } = await supabase.from('notification_log').select('id').eq('user_id', userId).eq('job_id', jobId).eq('template', template).in('status', SENT_STATES as unknown as string[]).limit(1)
    return !!(data && data.length)
  }
  const sel = 'id, user_id, customer_id, scheduled_date, customers(name, phone, email, sms_opt_in, email_opt_in, message_prefs, reviewed_at, review_declined_at, review_requested_at)'
  let sent = 0

  async function runBatch(rows: CronJob[], template: 'reminder' | 'review_request', dateLabel?: string) {
    // A review ask is per PERSON, not per job. alreadySent() dedupes on job_id, and
    // every visit is a new job row — so a weekly-mow customer was asked again every
    // single week, all season, until they reviewed or the owner marked them declined.
    // This set stops the same customer being asked twice in one run (two properties,
    // or a mow + a hedge trim finished the same day); canAskForReview below stops it
    // across runs.
    const askedThisRun = new Set<string>()
    for (const j of rows) {
      const c = j.customers
      if (!c || !j.customer_id) continue
      if (await alreadySent(j.user_id, j.id, template)) continue
      const info = await bizInfo(j.user_id)
      if (template === 'reminder' && !info.automations.reminder) continue       // automation off for this owner
      if (template === 'review_request' && !info.automations.review) continue
      if (template === 'review_request') {
        // THE review lifecycle rule (lib/crm/reviews) — reviewed, declined, OR
        // already asked. review_requested_at is stamped by trg_crm_stamp_review_requested
        // on every successful ask, and canAskForReview() was written to read it;
        // nothing called it, so the one column that tracks "we've asked" was ignored
        // by the only thing that asks.
        if (!canAskForReview(c)) continue
        if (askedThisRun.has(j.customer_id)) continue
        // An ask with nowhere to go is worse than no ask — it burns the request and
        // stamps them Requested, so they'd never be asked again once the link exists.
        // ReviewLifecycle already refuses to send without a link; the cron didn't.
        if (!(info.reviewUrl || '').trim()) continue
        askedThisRun.add(j.customer_id)
      }
      const token = await ensurePortalToken(supabase, j.user_id, j.customer_id)
      const msg = renderMessage(template, info.templates, { firstName: c.name, businessName: info.name, dateLabel, portalLink: token ? portalUrl(token) : undefined, reviewLink: info.reviewUrl || undefined, directPhone: info.phone || undefined, logoUrl: info.logoUrl || undefined, website: info.website || undefined })

      // THE send path — the same one campaigns use. This block used to hand-roll
      // its own consent ladder + per-channel logging, which made it the copy that
      // reach.ts exists to prevent, and it never wrote a `messages` row. That
      // second part mattered more than it looks: trg_crm_touch_last_contacted
      // fires on messages INSERT, so a customer we reminded and review-asked every
      // week still looked untouched — and the win_back campaign
      // ("it's been a little while") would mail someone whose lawn we mowed
      // yesterday. Dispatch threads the bubble, so last_contacted_at is now true.
      // logDispatch records EVERY outcome including the skips, so a message that
      // never went out is still visible in the timeline with its reason.
      const res = await dispatchToCustomer(supabase, {
        userId: j.user_id,
        customer: { id: j.customer_id, phone: c.phone, email: c.email, sms_opt_in: c.sms_opt_in, email_opt_in: c.email_opt_in, message_prefs: c.message_prefs },
        channels: ['sms', 'email'],
        smsText: msg.sms, emailSubject: msg.subject, emailHtml: msg.html, emailText: msg.text,
        template, meta: { job_id: j.id },
      })
      await logDispatch(supabase, res, { userId: j.user_id, customerId: j.customer_id, jobId: j.id, template })
      sent += res.sentChannels.length
    }
  }

  const { data: reminders } = await supabase.from('jobs').select(sel).eq('scheduled_date', tomorrow).eq('status', 'scheduled')
  await runBatch((reminders as unknown as CronJob[]) || [], 'reminder', `tomorrow (${format(addDays(new Date(), 1), 'EEE, MMM d')})`)

  const { data: reviews } = await supabase.from('jobs').select(sel).eq('scheduled_date', yesterday).eq('status', 'completed')
  await runBatch((reviews as unknown as CronJob[]) || [], 'review_request')

  return NextResponse.json({ ok: true, sent })
}
