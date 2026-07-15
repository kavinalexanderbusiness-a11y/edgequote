import type { SupabaseClient } from '@supabase/supabase-js'
import { sendSms, sendEmail } from './send'
import { getOrCreateConversation } from './conversation'
import { SKIP_REASON } from './skipReasons'
import { prefAllows, type MessagePrefs } from './templates'

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
  // Granular per-category preference (customers.message_prefs). Optional so
  // existing callers keep working; missing/null = channel opt-in only.
  message_prefs?: MessagePrefs | null
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

// `provider`/`providerId` are the provider's own handle on the message (Twilio
// MessageSid / Resend id). They're what the delivery webhooks match on later to
// turn 'sent' (provider accepted) into 'delivered'/'bounced' — so callers must
// persist them alongside the status. Null when nothing was sent.
export interface DispatchAttempt {
  channel: string
  status: string
  detail: string | null
  sent: boolean
  provider: string | null
  providerId: string | null
}
export interface DispatchResult { attempts: DispatchAttempt[]; messageId: string | null; sentChannels: string[] }

const PROVIDER: Record<string, string> = { sms: 'twilio', email: 'resend' }

export async function dispatchToCustomer(sb: SupabaseClient, inp: DispatchInput): Promise<DispatchResult> {
  const c = inp.customer
  const attempts: DispatchAttempt[] = []

  // Granular consent: the customer declined this CATEGORY of message (e.g. opted
  // into invoices but out of marketing). One check, every sender inherits it.
  const skip = (channel: string, detail: string): DispatchAttempt =>
    ({ channel, status: 'skipped', detail, sent: false, provider: null, providerId: null })

  if (!prefAllows(c.message_prefs, inp.template)) {
    for (const ch of inp.channels) attempts.push(skip(ch, SKIP_REASON.UNSUBSCRIBED))
    return { attempts, messageId: null, sentChannels: [] }
  }

  if (inp.channels.includes('sms')) {
    if (!c.sms_opt_in) attempts.push(skip('sms', SKIP_REASON.NO_OPT_IN))
    else if (!c.phone) attempts.push(skip('sms', SKIP_REASON.NO_PHONE))
    else {
      const r = await sendSms(c.phone, inp.smsText)
      attempts.push({ channel: 'sms', status: r.reason, detail: r.error ?? null, sent: r.sent, provider: r.sent ? PROVIDER.sms : null, providerId: r.id ?? null })
    }
  }
  if (inp.channels.includes('email')) {
    if (!c.email_opt_in) attempts.push(skip('email', SKIP_REASON.NO_OPT_IN))
    else if (!c.email) attempts.push(skip('email', SKIP_REASON.NO_EMAIL))
    else {
      const r = await sendEmail(c.email, inp.emailSubject, inp.emailHtml, inp.emailText)
      attempts.push({ channel: 'email', status: r.reason, detail: r.error ?? null, sent: r.sent, provider: r.sent ? PROVIDER.email : null, providerId: r.id ?? null })
    }
  }

  const sentChannels = attempts.filter(a => a.sent).map(a => a.channel)
  let messageId: string | null = null
  if (sentChannels.length && inp.thread !== false) {
    const convoId = await getOrCreateConversation(sb, inp.userId, c.id)
    if (convoId) {
      // The bubble tracks the channel it was actually sent on, so a delivery
      // webhook for that provider id can advance THIS row's status.
      const primary = attempts.find(a => a.sent && a.channel === sentChannels[0])
      const { data: m } = await sb.from('messages')
        .insert({
          user_id: inp.userId, conversation_id: convoId, customer_id: c.id,
          direction: 'outbound', channel: sentChannels[0], body: inp.smsText, status: 'sent',
          provider: primary?.provider ?? null, provider_message_id: primary?.providerId ?? null,
          meta: { template: inp.template, ...(inp.meta || {}) },
        })
        .select('id').single()
      messageId = (m as { id: string } | null)?.id ?? null
    }
  }
  return { attempts, messageId, sentChannels }
}
