import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'
import { addDays, format } from 'date-fns'
import { renderMessage, MsgType, prefAllows, type MessagePrefs } from '@/lib/comms/templates'
import { sendSms, sendEmail, commsEnabled } from '@/lib/comms/send'
import { SKIP_REASON } from '@/lib/comms/skipReasons'
import { SENT_STATES } from '@/lib/comms/delivery'
import { ensurePortalToken, portalUrl } from '@/lib/portal'
import { resolveAutomations, Automations } from '@/lib/comms/automations'

export const dynamic = 'force-dynamic'

// Scheduled sends (Vercel Cron → see vercel.json). Sends TOMORROW reminders and
// REVIEW requests for yesterday's completed visits. Fully guarded:
//   • requires CRON_SECRET (so the endpoint can't be triggered by anyone),
//   • no-ops when comms credentials are absent (nothing sends),
//   • needs SUPABASE_SERVICE_ROLE_KEY to read across customers,
//   • de-dupes via notification_log and honours per-customer opt-in.

interface CronCustomer { name: string; phone: string | null; email: string | null; sms_opt_in: boolean; email_opt_in: boolean; message_prefs?: MessagePrefs | null; reviewed_at: string | null; review_declined_at: string | null }
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
  const sel = 'id, user_id, customer_id, scheduled_date, customers(name, phone, email, sms_opt_in, email_opt_in, message_prefs, reviewed_at, review_declined_at)'
  let sent = 0

  async function runBatch(rows: CronJob[], template: 'reminder' | 'review_request', dateLabel?: string) {
    for (const j of rows) {
      const c = j.customers
      if (!c || !j.customer_id) continue
      if (await alreadySent(j.user_id, j.id, template)) continue
      const info = await bizInfo(j.user_id)
      if (template === 'reminder' && !info.automations.reminder) continue       // automation off for this owner
      if (template === 'review_request' && !info.automations.review) continue
      if (template === 'review_request' && (c.reviewed_at || c.review_declined_at)) continue  // already reviewed or opted out — don't ask again
      if (!prefAllows(c.message_prefs, template)) continue  // customer declined this category of message
      const token = await ensurePortalToken(supabase, j.user_id, j.customer_id)
      const msg = renderMessage(template, info.templates, { firstName: c.name, businessName: info.name, dateLabel, portalLink: token ? portalUrl(token) : undefined, reviewLink: info.reviewUrl || undefined, directPhone: info.phone || undefined, logoUrl: info.logoUrl || undefined, website: info.website || undefined })
      // Log EVERY outcome, including the skips. These two branches used to be bare
      // `if (opted_in && contact)` with no else: an opted-out customer produced no
      // send AND no notification_log row, so the timeline showed nothing at all and
      // the owner had no way to know a reminder/review request never went out. The
      // canonical reasons + branch order mirror lib/comms/dispatch.ts so automatic
      // sends read identically to manual ones. alreadySent() only blocks on
      // status='sent', so a skipped row never suppresses a later real send.
      const logRow = (channel: 'sms' | 'email', status: string, detail: string | null) =>
        supabase.from('notification_log').insert({ user_id: j.user_id, customer_id: j.customer_id, job_id: j.id, channel, template, status, detail })

      if (!c.sms_opt_in) await logRow('sms', 'skipped', SKIP_REASON.NO_OPT_IN)
      else if (!c.phone) await logRow('sms', 'skipped', SKIP_REASON.NO_PHONE)
      else { const r = await sendSms(c.phone, msg.sms); await logRow('sms', r.reason, r.error ?? null); if (r.sent) sent++ }

      if (!c.email_opt_in) await logRow('email', 'skipped', SKIP_REASON.NO_OPT_IN)
      else if (!c.email) await logRow('email', 'skipped', SKIP_REASON.NO_EMAIL)
      else { const r = await sendEmail(c.email, msg.subject, msg.html, msg.text); await logRow('email', r.reason, r.error ?? null); if (r.sent) sent++ }
    }
  }

  const { data: reminders } = await supabase.from('jobs').select(sel).eq('scheduled_date', tomorrow).eq('status', 'scheduled')
  await runBatch((reminders as unknown as CronJob[]) || [], 'reminder', `tomorrow (${format(addDays(new Date(), 1), 'EEE, MMM d')})`)

  const { data: reviews } = await supabase.from('jobs').select(sel).eq('scheduled_date', yesterday).eq('status', 'completed')
  await runBatch((reviews as unknown as CronJob[]) || [], 'review_request')

  return NextResponse.json({ ok: true, sent })
}
