import type { SupabaseClient } from '@supabase/supabase-js'
import { sendSms, sendEmail } from './send'
import { getOrCreateConversation } from './conversation'
import { SKIP_REASON } from './skipReasons'

// ── Shared customer dispatch ─────────────────────────────────────────────────
// Sends an already-rendered message to ONE customer over the requested channels,
// honouring per-customer opt-in, and (by default) threads a single outbound
// bubble into their conversation so it shows in Messages + the timeline. This is
// the exact gating /api/comms/send uses, extracted so automated campaign sends
// (the cron) behave identically to manual ones. Returns per-channel attempts for
// the caller to log to notification_log. Works with a service-role client.

export interface DispatchCustomer {
  id: string
  phone: string | null
  email: string | null
  sms_opt_in: boolean
  email_opt_in: boolean
}

export interface DispatchInput {
  userId: string
  customer: DispatchCustomer
  channels: string[]
  smsText: string
  emailSubject: string
  emailHtml: string
  emailText: string
  template: string          // for messages.meta + notification_log.template
  meta?: Record<string, unknown>
  thread?: boolean          // record an outbound bubble (default true)
}

export interface DispatchAttempt { channel: string; status: string; detail: string | null; sent: boolean }
export interface DispatchResult { attempts: DispatchAttempt[]; messageId: string | null; sentChannels: string[] }

export async function dispatchToCustomer(sb: SupabaseClient, inp: DispatchInput): Promise<DispatchResult> {
  const c = inp.customer
  const attempts: DispatchAttempt[] = []

  if (inp.channels.includes('sms')) {
    if (!c.sms_opt_in) attempts.push({ channel: 'sms', status: 'skipped', detail: SKIP_REASON.NO_OPT_IN, sent: false })
    else if (!c.phone) attempts.push({ channel: 'sms', status: 'skipped', detail: SKIP_REASON.NO_PHONE, sent: false })
    else { const r = await sendSms(c.phone, inp.smsText); attempts.push({ channel: 'sms', status: r.reason, detail: r.error ?? null, sent: r.sent }) }
  }
  if (inp.channels.includes('email')) {
    if (!c.email_opt_in) attempts.push({ channel: 'email', status: 'skipped', detail: SKIP_REASON.NO_OPT_IN, sent: false })
    else if (!c.email) attempts.push({ channel: 'email', status: 'skipped', detail: SKIP_REASON.NO_EMAIL, sent: false })
    else { const r = await sendEmail(c.email, inp.emailSubject, inp.emailHtml, inp.emailText); attempts.push({ channel: 'email', status: r.reason, detail: r.error ?? null, sent: r.sent }) }
  }

  const sentChannels = attempts.filter(a => a.sent).map(a => a.channel)
  let messageId: string | null = null
  if (sentChannels.length && inp.thread !== false) {
    const convoId = await getOrCreateConversation(sb, inp.userId, c.id)
    if (convoId) {
      const { data: m } = await sb.from('messages')
        .insert({ user_id: inp.userId, conversation_id: convoId, customer_id: c.id, direction: 'outbound', channel: sentChannels[0], body: inp.smsText, status: 'sent', meta: { template: inp.template, ...(inp.meta || {}) } })
        .select('id').single()
      messageId = (m as { id: string } | null)?.id ?? null
    }
  }
  return { attempts, messageId, sentChannels }
}
