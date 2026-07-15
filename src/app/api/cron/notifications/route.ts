import { NextRequest, NextResponse } from 'next/server'
import { cronSecretOk, serviceClient } from '@/lib/cron/guard'
import { addDays, format } from 'date-fns'
import { renderMessage, prefAllows, type MessagePrefs } from '@/lib/comms/templates'
import { commsEnabled } from '@/lib/comms/send'
import { dispatchToCustomer } from '@/lib/comms/dispatch'
import { SENT_STATES } from '@/lib/comms/delivery'
import { logDispatch } from '@/lib/comms/log'
import { claimSend, finalizeSend } from '@/lib/comms/idempotency'
import { loadOwnerContext, type OwnerContext } from '@/lib/automation/owner'
import { ensurePortalToken, portalUrl } from '@/lib/portal'

export const dynamic = 'force-dynamic'
// Each job costs up to two sequential provider round-trips, so the platform
// default (10–15s) would kill the run mid-batch and leave the tally a lie.
export const maxDuration = 300

// Scheduled sends (Vercel Cron → see vercel.json). Sends TOMORROW reminders and
// REVIEW requests for yesterday's completed visits. Fully guarded:
//   • requires CRON_SECRET (so the endpoint can't be triggered by anyone),
//   • no-ops when comms credentials are absent (nothing sends),
//   • needs SUPABASE_SERVICE_ROLE_KEY to read across customers,
//   • de-dupes via notification_log and honours per-customer opt-in.

interface CronCustomer { name: string; phone: string | null; email: string | null; sms_opt_in: boolean; email_opt_in: boolean; message_prefs?: MessagePrefs | null; reviewed_at: string | null; review_declined_at: string | null }
interface CronJob { id: string; user_id: string; customer_id: string | null; scheduled_date: string; customers: CronCustomer | null }

// Blast-radius guard, applied to each batch's scan. Unlike the chasers, truncation
// here is NOT harmless: both batches key off a specific date ('tomorrow',
// 'yesterday'), and the next daily run looks at a different date — so a job past
// the cap loses its reminder for good. That is exactly why the cap warns loudly.
// It is still the right trade: without it the run is killed mid-batch by the
// platform timeout and sends FEWER, at an arbitrary cut-off, silently. 500 jobs on
// one date is far beyond a single crew's day; if this ever warns, raise the cap.
const MAX_PER_RUN = 500

// The channels this cron has always attempted. Hoisted so the RESERVATION and the
// dispatch can never disagree about what was claimed.
const CHANNELS = ['sms', 'email']

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
  // What the run actually did. `sent` counts CHANNELS (its long-standing meaning);
  // `errors` counts channel attempts that failed, plus any job that threw;
  // `skipped` counts jobs passed over without a send. Counting only successes is
  // what let an outage read as a quiet night.
  let sent = 0, skipped = 0, errors = 0

  async function runBatch(rows: CronJob[], template: 'reminder' | 'review_request', dateLabel?: string) {
    for (const j of rows) {
      const c = j.customers
      if (!c || !j.customer_id) { skipped++; continue }
      if (await alreadySent(j.user_id, j.id, template)) { skipped++; continue }
      const info = await bizInfo(j.user_id)
      if (template === 'reminder' && !info.automations.reminder) { skipped++; continue }       // automation off for this owner
      if (template === 'review_request' && !info.automations.review) { skipped++; continue }
      if (template === 'review_request' && (c.reviewed_at || c.review_declined_at)) { skipped++; continue }  // already reviewed or opted out — don't ask again
      // Category consent. dispatchToCustomer checks this too (and would return a
      // logged 'unsubscribed' skip); this pre-check keeps THIS cron's long-standing
      // behaviour of passing over the customer silently. It is the one outcome here
      // that isn't logged — see AUTOMATION_DEDUP_STATUS.md, pending an owner call.
      if (!prefAllows(c.message_prefs, template)) { skipped++; continue }

      // One bad row must not abort the batch — otherwise a single malformed job
      // takes the rest of tomorrow's reminders (and the whole review batch after
      // it) down with it. alreadySent() blocks only on a real prior send, so a job
      // that threw here is retried on the next run.
      try {
        const token = await ensurePortalToken(supabase, j.user_id, j.customer_id)
        const msg = renderMessage(template, info.templates, { firstName: c.name, businessName: info.name, dateLabel, portalLink: token ? portalUrl(token) : undefined, reviewLink: info.reviewUrl || undefined, directPhone: info.phone || undefined, logoUrl: info.logoUrl || undefined, website: info.website || undefined })

        // ── RESERVE, THEN SEND ────────────────────────────────────────────────
        // alreadySent() above is only a cheap PRE-FILTER, never a guard: the row it
        // reads isn't written until AFTER the provider has accepted the message. So
        // two overlapping runs (Vercel Cron is at-least-once) both see zero rows and
        // both dispatch — the customer gets two "your visit is tomorrow" texts. The
        // window is the full provider latency, up to 10s. This was the only sender in
        // the repo without an atomic reservation; the chasers CAS, campaigns claim a
        // crm_campaign_log row, and this now uses THE shared primitive.
        //
        // claimSend's composite PK (user_id, client_message_id) is the serialization
        // point: exactly one caller wins the insert and may send. Keyed per
        // (job, template) so a retry of this same logical reminder — not merely this
        // same invocation — is recognised and never sends twice.
        //
        // Claimed as LATE as possible, after the render: a render that throws (e.g.
        // ensurePortalToken failing) then hasn't spent the reservation, preserving the
        // "a job that threw is retried on the next run" property the catch documents.
        const claimKey = `${j.id}:${template}`
        const { claimed } = await claimSend(supabase, j.user_id, claimKey, CHANNELS.join('+'))
        // Losing the claim is an ordinary outcome, not an error: another run owns this
        // send. Pass the job over exactly as alreadySent() would have.
        if (!claimed) { skipped++; continue }

        // THE one dispatch pipeline — same opt-in checks, same branch order, same
        // canonical skip reasons and provider capture every other sender gets.
        // `thread: false` preserves this cron's behaviour: reminders and review
        // requests have never written a conversation bubble (unlike campaigns).
        // alreadySent() blocks only on a real prior send (SENT_STATES), so a skipped
        // row never suppresses a later one.
        const res = await dispatchToCustomer(supabase, {
          userId: j.user_id,
          customer: { id: j.customer_id, phone: c.phone, email: c.email, sms_opt_in: c.sms_opt_in, email_opt_in: c.email_opt_in, message_prefs: c.message_prefs },
          channels: CHANNELS,
          smsText: msg.sms, emailSubject: msg.subject, emailHtml: msg.html, emailText: msg.text,
          template,
          thread: false,
        })
        await logDispatch(supabase, res, { userId: j.user_id, customerId: j.customer_id, jobId: j.id, template })
        // Informational only — the CLAIM is what enforces at-most-once, so a failed
        // finalize is harmless. Mirrors the reserve-then-finalize shape
        // /api/cron/campaigns uses, and keeps the reservation row from reading
        // 'sending' forever. Deliberately NOT done on the throw path below: a throw
        // after dispatch means we genuinely don't know whether the provider took it,
        // and 'sending' is the honest record of that.
        await finalizeSend(supabase, j.user_id, claimKey,
          res.sentChannels.length ? 'sent' : (res.attempts.some(a => a.status === 'error') ? 'failed' : 'skipped'))
        if (res.sentChannels.length) sent += res.sentChannels.length
        else skipped++
        // Only a real send FAILURE is noise worth making: no phone, opted out or
        // unsubscribed are ordinary outcomes and stay quiet.
        const broke = res.attempts.filter(a => a.status === 'error')
        if (broke.length) {
          errors += broke.length
          console.error(`[cron/notifications] ${template} failed for job ${j.id}:`, broke.map(a => `${a.channel}: ${a.detail || 'no detail'}`).join(', '))
        }
      } catch (e) {
        errors++
        console.error(`[cron/notifications] ${template} threw for job ${j.id}:`, e)
      }
    }
  }

  const { data: reminders, error: remErr } = await supabase.from('jobs').select(sel)
    .eq('scheduled_date', tomorrow).eq('status', 'scheduled')
    .order('id', { ascending: true })
    .limit(MAX_PER_RUN + 1)
  if (remErr) {
    // A failed read is NOT a quiet night — say so, or an outage is indistinguishable
    // from having nothing to send.
    console.error('[cron/notifications] reminder job query failed:', remErr.message)
    return NextResponse.json({ ok: false, error: remErr.message, note: 'Could not read tomorrow\'s jobs — nothing was sent this run.' }, { status: 500 })
  }
  const remRows = (reminders as unknown as CronJob[]) || []
  const remTruncated = remRows.length > MAX_PER_RUN
  await runBatch(remRows.slice(0, MAX_PER_RUN), 'reminder', `tomorrow (${format(addDays(new Date(), 1), 'EEE, MMM d')})`)

  const { data: reviews, error: revErr } = await supabase.from('jobs').select(sel)
    .eq('scheduled_date', yesterday).eq('status', 'completed')
    .order('id', { ascending: true })
    .limit(MAX_PER_RUN + 1)
  if (revErr) {
    console.error('[cron/notifications] review job query failed:', revErr.message)
    return NextResponse.json({ ok: false, error: revErr.message, note: 'Could not read yesterday\'s jobs — reminders ran, review requests did not.', sent, skipped, errors }, { status: 500 })
  }
  const revRows = (reviews as unknown as CronJob[]) || []
  const revTruncated = revRows.length > MAX_PER_RUN
  await runBatch(revRows.slice(0, MAX_PER_RUN), 'review_request')

  const truncated = remTruncated || revTruncated
  // Not "we'll get them next run" — tomorrow's reminders and yesterday's review
  // requests have no next run. Raise the cap.
  if (truncated) console.warn(`[cron/notifications] hit MAX_PER_RUN=${MAX_PER_RUN} (reminders: ${remTruncated}, reviews: ${revTruncated}) — jobs past the cap were NOT messaged and this date will not be revisited.`)
  const summary = { ok: true, sent, skipped, errors, truncated }
  // Log only when there was something to do, so quiet runs stay quiet in the logs.
  if (remRows.length || revRows.length) console.log('[cron/notifications] run:', JSON.stringify(summary))
  return NextResponse.json(summary)
}
