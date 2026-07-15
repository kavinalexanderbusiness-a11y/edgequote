import type { SupabaseClient } from '@supabase/supabase-js'
import { sendSms, sendEmail } from './send'
import { getOrCreateConversation } from './conversation'
import { reachCheck } from './reach'
import { SKIP_REASON } from './skipReasons'
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
  /** Attempted IN THIS ORDER. The threaded bubble records the first channel that
   *  actually sent, so order is meaningful, not cosmetic. */
  channels: string[]
  smsText: string
  emailSubject: string
  emailHtml: string
  emailText: string
  template: string          // for messages.meta + notification_log.template
  meta?: Record<string, unknown>
  thread?: boolean          // record an outbound bubble (default true)
  /** A record the customer is entitled to regardless of marketing preferences —
   *  today only the payment receipt. Bypasses the category check and email_opt_in,
   *  because a receipt for money someone just paid is not a message they can be
   *  unsubscribed from. SMS still requires sms_opt_in either way: carrier consent
   *  is not ours to waive. Default false — nothing is transactional by accident. */
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

// ── Legacy per-channel result vocabulary ─────────────────────────────────────
// /api/comms/send has always answered with a per-channel map of raw SendResults
// ({ sent, reason, error?, id? } — see lib/comms/send) using its OWN hyphenated
// skip reasons. Nine callers read that map. Dispatch speaks the newer attempt
// vocabulary (status:'skipped' + SKIP_REASON.*), so this translates back and the
// route can share the one consent gate without breaking its published contract.
//
// Absent fields are OMITTED, not nulled: the legacy values came straight off
// SendResult, where a skip carried only { sent, reason } and a success carried no
// `error` key at all. Emitting `error: null` would change the response bytes and
// `'error' in result` for every caller.
//
// This builds its output field by field for exactly that reason — never by
// spreading an attempt. `retryable` is internal to the automated senders and must
// NOT appear here; a spread would have published it to all nine callers the day it
// was added.
const LEGACY_REASON: Record<string, string> = {
  [SKIP_REASON.NO_OPT_IN]: 'no-optin',
  [SKIP_REASON.UNSUBSCRIBED]: 'no-optin',   // a declined CATEGORY reads as no-optin to callers
  [SKIP_REASON.NO_PHONE]: 'no-phone',
  [SKIP_REASON.NO_EMAIL]: 'no-email',
}

export interface LegacySendResult { sent: boolean; reason: string; error?: string | null; id?: string | null }

export function sendResultsFromAttempts(attempts: DispatchAttempt[]): Record<string, LegacySendResult> {
  const out: Record<string, LegacySendResult> = {}
  for (const a of attempts) {
    if (a.status === 'skipped') {
      // A skip never carried the provider fields — reason is the whole story.
      out[a.channel] = { sent: false, reason: LEGACY_REASON[a.detail ?? ''] ?? a.status }
      continue
    }
    // Reconstruct the provider's SendResult: `reason` IS the status ('sent' /
    // 'disabled' / 'error'), and error/id are only ever set one at a time.
    const r: LegacySendResult = { sent: a.sent, reason: a.status }
    if (a.detail != null) r.error = a.detail
    if (a.providerId != null) r.id = a.providerId
    out[a.channel] = r
  }
  return out
}

export async function dispatchToCustomer(sb: SupabaseClient, inp: DispatchInput): Promise<DispatchResult> {
  const c = inp.customer
  const attempts: DispatchAttempt[] = []

  const skip = (channel: string, detail: string): DispatchAttempt =>
    ({ channel, status: 'skipped', detail, sent: false, provider: null, providerId: null, retryable: false })

  // Granular consent + channel opt-in + contact-on-file, resolved by the ONE
  // shared predicate (lib/comms/reach) so the campaign audience preview can
  // predict this exact outcome without re-deriving the rules. `transactional`
  // rides through it too — otherwise the predicate and the send path would
  // disagree about receipts, which is the exact drift reach.ts exists to prevent.
  const gate = reachCheck(c, inp.channels, inp.template, { transactional: inp.transactional })
  const blocked = new Map(gate.map(g => [g.channel, g.blocked]))

  // The customer declined this CATEGORY of message — nothing goes out at all.
  // Reported per requested channel, in the caller's order.
  if (gate.length && gate.every(g => g.blocked === SKIP_REASON.UNSUBSCRIBED)) {
    for (const g of gate) attempts.push(skip(g.channel, g.blocked!))
    return { attempts, messageId: null, sentChannels: [] }
  }

  // Caller order — the bubble below records the first channel that SENT, so this
  // is meaningful, not cosmetic (the receipt asks for email first).
  for (const ch of inp.channels) {
    const b = blocked.get(ch)
    if (ch === 'sms') {
      if (b) attempts.push(skip('sms', b))
      else {
        const r = await sendSms(c.phone!, inp.smsText)
        attempts.push({ channel: 'sms', status: r.reason, detail: r.error ?? null, sent: r.sent, provider: r.sent ? PROVIDER.sms : null, providerId: r.id ?? null, retryable: r.retryable ?? false })
      }
    } else if (ch === 'email') {
      if (b) attempts.push(skip('email', b))
      else {
        const r = await sendEmail(c.email!, inp.emailSubject, inp.emailHtml, inp.emailText)
        attempts.push({ channel: 'email', status: r.reason, detail: r.error ?? null, sent: r.sent, provider: r.sent ? PROVIDER.email : null, providerId: r.id ?? null, retryable: r.retryable ?? false })
      }
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
