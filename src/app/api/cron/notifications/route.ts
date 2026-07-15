import { NextRequest, NextResponse } from 'next/server'
import { cronSecretOk, serviceClient } from '@/lib/cron/guard'
import { addDays, format } from 'date-fns'
import { renderMessage, prefAllows, type MessagePrefs } from '@/lib/comms/templates'
import { commsEnabled } from '@/lib/comms/send'
import { dispatchToCustomer } from '@/lib/comms/dispatch'
import { SENT_STATES } from '@/lib/comms/delivery'
import { logDispatch } from '@/lib/comms/log'
import { loadOwnerContext, type OwnerContext } from '@/lib/automation/owner'
import { ensurePortalToken, portalUrl } from '@/lib/portal'

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
  if (!cronSecretOk(req)) return NextResponse.json({ error: 'forbidden' }, { status: 403 })
  const enabled = commsEnabled()
  if (!enabled.sms && !enabled.email) {
    return NextResponse.json({ ok: true, disabled: true, note: 'Comms disabled — set Twilio/Resend env vars to enable scheduled sends.' })
  }
  const client = serviceClient()
  if (!client) {
    return NextResponse.json({ ok: true, skipped: true, note: 'Set SUPABASE_SERVICE_ROLE_KEY to enable scheduled sends.' })
  }
  const supabase = client

  const tomorrow = format(addDays(new Date(), 1), 'yyyy-MM-dd')
  const yesterday = format(addDays(new Date(), -1), 'yyyy-MM-dd')
  // Per-owner settings — THE shared read, lib/automation/owner. Cached because
  // both batches below ask per job: one settings query per owner per run.
  const bizCache: Record<string, OwnerContext> = {}
  async function bizInfo(userId: string): Promise<OwnerContext> {
    return (bizCache[userId] ??= await loadOwnerContext(supabase, userId))
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
      // Category consent. dispatchToCustomer checks this too (and would return a
      // logged 'unsubscribed' skip); this pre-check keeps THIS cron's long-standing
      // behaviour of passing over the customer silently. It is the one outcome here
      // that isn't logged — see AUTOMATION_DEDUP_STATUS.md, pending an owner call.
      if (!prefAllows(c.message_prefs, template)) continue
      const token = await ensurePortalToken(supabase, j.user_id, j.customer_id)
      const msg = renderMessage(template, info.templates, { firstName: c.name, businessName: info.name, dateLabel, portalLink: token ? portalUrl(token) : undefined, reviewLink: info.reviewUrl || undefined, directPhone: info.phone || undefined, logoUrl: info.logoUrl || undefined, website: info.website || undefined })

      // THE one dispatch pipeline — same opt-in checks, same branch order, same
      // canonical skip reasons and provider capture every other sender gets.
      // `thread: false` preserves this cron's behaviour: reminders and review
      // requests have never written a conversation bubble (unlike campaigns).
      // alreadySent() blocks only on a real prior send (SENT_STATES), so a skipped
      // row never suppresses a later one.
      const res = await dispatchToCustomer(supabase, {
        userId: j.user_id,
        customer: { id: j.customer_id, phone: c.phone, email: c.email, sms_opt_in: c.sms_opt_in, email_opt_in: c.email_opt_in, message_prefs: c.message_prefs },
        channels: ['sms', 'email'],
        smsText: msg.sms, emailSubject: msg.subject, emailHtml: msg.html, emailText: msg.text,
        template,
        thread: false,
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
