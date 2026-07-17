import type { SupabaseClient } from '@supabase/supabase-js'
import { sendSms, sendEmail } from './send'
import { getOrCreateConversation } from './conversation'
import { reachCheck } from './reach'
import { type MessagePrefs } from './templates'

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
  // A receipt/confirmation for something the customer just did — email skips the
  // email_opt_in check (CASL s.6(6)(b)). SMS opt-in and the category preference
  // still apply. See lib/comms/reach.
  transactional?: boolean
}

// `provider`/`providerId` are the provider's own handle on the message (Twilio
// MessageSid / Resend id). They're what the delivery webhooks match on later to
// turn 'sent' (provider accepted) into 'delivered'/'bounced' — so callers must
// persist them alongside the status. Null when nothing was sent.
//
// `retryable` carries the send layer's verdict on a FAILURE (see lib/comms/send):
// would this exact message plausibly go through later? Automated callers spend a
// finite attempt budget, so they need to tell "the provider is down" apart from
// "the provider says no". Always false for a skip — a skip isn't a failure, it's
// the consent gate working, and there is nothing to retry.
//
// It is PURELY carried, never consulted here: nothing in this file, and nothing on
// the interactive send paths, branches on it. lib/comms/send already computes the
// verdict (429/5xx and timeouts are retryable; a 4xx rejection is not) — dispatch
// merely stops discarding it on the way to lib/automation/chase, which spends the
// budget. Adding the field changes no send decision, no consent check and no
// message; it only makes an answer that already existed reachable.
export interface DispatchAttempt {
  channel: string
  status: string
  detail: string | null
  sent: boolean
  provider: string | null
  providerId: string | null
  retryable: boolean
}
export interface DispatchResult { attempts: DispatchAttempt[]; messageId: string | null; sentChannels: string[] }

const PROVIDER: Record<string, string> = { sms: 'twilio', email: 'resend' }

export async function dispatchToCustomer(sb: SupabaseClient, inp: DispatchInput): Promise<DispatchResult> {
  const c = inp.customer
  const attempts: DispatchAttempt[] = []

  const skip = (channel: string, detail: string): DispatchAttempt =>
    ({ channel, status: 'skipped', detail, sent: false, provider: null, providerId: null, retryable: false })

  // Granular consent + channel opt-in + contact-on-file, resolved by the ONE
  // shared predicate (lib/comms/reach) so the campaign audience preview can
  // predict this exact outcome without re-deriving the rules.
  const gate = reachCheck(c, inp.channels, inp.template, { transactional: inp.transactional })
  const blocked = new Map(gate.map(g => [g.channel, g.blocked]))

  // The customer declined this CATEGORY of message — nothing goes out at all.
  // Reported per requested channel, in the caller's order.
  if (gate.length && gate.every(g => g.blocked === 'unsubscribed')) {
    for (const g of gate) attempts.push(skip(g.channel, g.blocked!))
    return { attempts, messageId: null, sentChannels: [] }
  }

  if (inp.channels.includes('sms')) {
    const b = blocked.get('sms')
    if (b) attempts.push(skip('sms', b))
    else {
      const r = await sendSms(c.phone!, inp.smsText)
      // `?? false` — SendResult.retryable is optional, and absent means "hasn't
      // thought about it", which must not license a retry.
      attempts.push({ channel: 'sms', status: r.reason, detail: r.error ?? null, sent: r.sent, provider: r.sent ? PROVIDER.sms : null, providerId: r.id ?? null, retryable: r.retryable ?? false })
    }
  }
  if (inp.channels.includes('email')) {
    const b = blocked.get('email')
    if (b) attempts.push(skip('email', b))
    else {
      const r = await sendEmail(c.email!, inp.emailSubject, inp.emailHtml, inp.emailText)
      attempts.push({ channel: 'email', status: r.reason, detail: r.error ?? null, sent: r.sent, provider: r.sent ? PROVIDER.email : null, providerId: r.id ?? null, retryable: r.retryable ?? false })
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
