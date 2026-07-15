import type { SupabaseClient } from '@supabase/supabase-js'

// ── Delivery tracking ─────────────────────────────────────────────────────────
// THE one place a provider's delivery event becomes our status vocabulary (see
// lib/comms/logStatus, which already renders every value below). Both webhooks —
// /api/sms/status (Twilio) and /api/email/status (Resend) — funnel through
// applyDelivery, so the mapping, the ordering guard and the write shape exist
// exactly once.
//
// Why this exists: the send layer records 'sent' when the provider ACCEPTS a
// message. That is not delivery. These updates carry a row forward to what
// actually happened, so the UI stops overclaiming.

export type Provider = 'twilio' | 'resend'

// Every state a row can hold once we successfully handed the message to a
// provider — i.e. the send HAPPENED, whatever became of it afterwards.
//
// Dedupe checks MUST use this instead of `status = 'sent'`. Before delivery
// tracking, a delivered message sat at 'sent' forever and an equality check was
// enough; now a webhook advances it to 'delivered' and that check silently stops
// matching — which would make the cron re-send a message the customer already got.
// Failure states are included on purpose: the send still happened, and retrying a
// bounced address (or an unreachable handset) every run would just spam.
// Send-time failures ('error') are deliberately NOT here — those never reached a
// provider and must stay retryable.
export const SENT_STATES = ['sent', 'delivered', 'opened', 'clicked', 'failed', 'bounced', 'spam'] as const

// How far along the delivery lifecycle each status sits. Providers do not
// guarantee ordering (Twilio will happily post `sent` after `delivered`, and a
// retry can re-post an old event), so a record may only ever ADVANCE — never
// regress a delivered message back to sent.
//
// Terminal failures outrank every progress state on purpose: an async bounce can
// legitimately arrive after `delivered`, and the failure is the outcome that
// matters to the owner.
const RANK: Record<string, number> = {
  queued: 1, sending: 1, retrying: 1,
  sent: 2,
  delivered: 3,
  opened: 4,
  clicked: 5,
  failed: 90, undelivered: 90, bounced: 91, spam: 92,
}

/** Statuses strictly less progressed than `next` — the only ones it may overwrite. */
function lowerRanked(next: string): string[] {
  const n = RANK[next] ?? 0
  return Object.keys(RANK).filter(k => (RANK[k] ?? 0) < n)
}

export function outranks(next: string, current: string | null | undefined): boolean {
  return (RANK[next] ?? 0) > (RANK[(current || '').toLowerCase()] ?? 0)
}

// Twilio MessageStatus → our vocabulary.
// twilio.com/docs/messaging/api/message-resource#message-status-values
export function twilioStatus(s: string): string | null {
  switch ((s || '').toLowerCase()) {
    case 'accepted': case 'scheduled': case 'queued': return 'queued'
    case 'sending': return 'sending'
    case 'sent': return 'sent'
    case 'delivered': return 'delivered'
    case 'read': return 'opened'        // WhatsApp/RCS read receipt; plain SMS has none
    case 'undelivered': case 'failed': return 'failed'
    default: return null                // unknown → ignore rather than guess
  }
}

// Resend event type → our vocabulary.
// resend.com/docs/dashboard/webhooks/event-types
export function resendStatus(t: string): string | null {
  switch ((t || '').toLowerCase()) {
    case 'email.sent': return 'sent'
    case 'email.delivered': return 'delivered'
    case 'email.delivery_delayed': return 'retrying'
    case 'email.opened': return 'opened'
    case 'email.clicked': return 'clicked'
    case 'email.bounced': return 'bounced'
    case 'email.complained': return 'spam'
    default: return null
  }
}

export interface DeliveryUpdate {
  provider: Provider
  providerMessageId: string
  status: string
  /** Provider's own reason, shown on the timeline pill (e.g. a Twilio error code). */
  detail?: string | null
  /** Event time from the provider; defaults to now. */
  at?: string
}

/**
 * Advance the send records for one provider message. Updates both the
 * notification_log audit row and the threaded message bubble.
 *
 * The ordering guard runs INSIDE the UPDATE (`status in (…lower ranked…)`) rather
 * than as a read-then-write, so two events racing (delivered + opened arriving
 * together) can't both read 'sent' and clobber each other.
 *
 * Requires a service-role client — RLS has no UPDATE policy for these tables.
 */
export async function applyDelivery(sb: SupabaseClient, u: DeliveryUpdate): Promise<{ updated: number }> {
  if (!u.providerMessageId || !u.status) return { updated: 0 }
  const at = u.at || new Date().toISOString()
  const below = lowerRanked(u.status)
  if (!below.length) return { updated: 0 }
  // Only overwrite a row that is genuinely less progressed (or has no status yet).
  const guard = `status.is.null,status.in.(${below.join(',')})`

  const logPatch: Record<string, unknown> = { status: u.status }
  if (u.detail) logPatch.detail = u.detail
  if (u.status === 'delivered') logPatch.delivered_at = at
  if (u.status === 'opened') logPatch.opened_at = at

  const { data: logs } = await sb.from('notification_log')
    .update(logPatch)
    .eq('provider', u.provider).eq('provider_message_id', u.providerMessageId)
    .or(guard)
    .select('id')

  const msgPatch: Record<string, unknown> = { status: u.status }
  if (u.status === 'delivered') msgPatch.delivered_at = at

  const { data: msgs } = await sb.from('messages')
    .update(msgPatch)
    .eq('provider', u.provider).eq('provider_message_id', u.providerMessageId)
    .or(guard)
    .select('id')

  return { updated: ((logs as unknown[]) || []).length + ((msgs as unknown[]) || []).length }
}
