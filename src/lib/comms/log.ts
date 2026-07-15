import type { SupabaseClient } from '@supabase/supabase-js'
import type { DispatchResult } from './dispatch'

// ── THE notification_log writer ───────────────────────────────────────────────
// Every sender records its per-channel outcome through here.
//
// Why this exists: this was six near-identical inline inserts (manual send, the
// receipt sender, and four crons). Three of them silently forgot
// provider_message_id — so the delivery webhooks could never find those rows and
// they read "Sent" forever, even after the message bounced. The UI was claiming
// an outcome nothing could ever correct.
//
// The bug wasn't carelessness, it was shape: there was no single place to forget
// IN. With one writer a new sender participates in delivery tracking by
// construction rather than by remembering.

export interface SendLogRow {
  userId: string
  customerId: string | null
  jobId?: string | null
  channel: string
  template: string
  /** Send-time outcome: 'sent' | 'skipped' | 'disabled' | 'error'. Delivery
   *  webhooks advance it later (see lib/comms/delivery). */
  status: string
  detail?: string | null
  /** Links this audit row to the threaded bubble, when one was written. */
  messageId?: string | null
  /** The provider's own handle on the message — what the webhooks match on.
   *  Omitting it means this send can never be corrected past 'sent'. */
  provider?: string | null
  providerId?: string | null
}

export async function logSend(sb: SupabaseClient, l: SendLogRow): Promise<void> {
  const base = {
    user_id: l.userId, customer_id: l.customerId, job_id: l.jobId ?? null,
    channel: l.channel, template: l.template, status: l.status, detail: l.detail ?? null,
  }
  const full: Record<string, unknown> = { ...base }
  if (l.messageId) full.message_id = l.messageId
  if (l.provider) full.provider = l.provider
  if (l.providerId) full.provider_message_id = l.providerId

  if (Object.keys(full).length === Object.keys(base).length) {
    await sb.from('notification_log').insert(base)
    return
  }
  const { error } = await sb.from('notification_log').insert(full)
  if (!error) return
  // Pre-migration fallback: message_id / provider columns may not exist yet. An
  // audit row must never be lost to a missing column.
  await sb.from('notification_log').insert(base)
}

/**
 * Log every per-channel attempt from a dispatchToCustomer() result — the shape
 * every automated sender wants, so none of them hand-roll the loop (and drop the
 * provider id on the way through).
 */
export async function logDispatch(
  sb: SupabaseClient,
  res: DispatchResult,
  ctx: { userId: string; customerId: string | null; jobId?: string | null; template: string },
): Promise<void> {
  for (const a of res.attempts) {
    await logSend(sb, {
      userId: ctx.userId,
      customerId: ctx.customerId,
      jobId: ctx.jobId ?? null,
      channel: a.channel,
      template: ctx.template,
      status: a.status,
      detail: a.detail,
      messageId: a.sent ? res.messageId : null,
      provider: a.provider,
      providerId: a.providerId,
    })
  }
}
