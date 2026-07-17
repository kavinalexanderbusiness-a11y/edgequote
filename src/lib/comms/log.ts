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

// The ONLY errors the base-row fallback may answer: the column genuinely is not
// there. 42703 = undefined_column (Postgres); PGRST204 = PostgREST's schema cache
// doesn't know the column. Anything else — a transient blip, a constraint, an auth
// failure — is NOT a missing column, and retrying without provider/provider_message_id
// is strictly worse than failing: see the fallback's own note below.
const MISSING_COLUMN_CODES = new Set(['42703', 'PGRST204'])

/** Writes the audit row. Returns whether it landed — a caller that ignores this is
 *  no worse off than before, but the failure is never silent again (it is logged
 *  here regardless). */
export async function logSend(sb: SupabaseClient, l: SendLogRow): Promise<{ ok: boolean }> {
  const base = {
    user_id: l.userId, customer_id: l.customerId, job_id: l.jobId ?? null,
    channel: l.channel, template: l.template, status: l.status, detail: l.detail ?? null,
  }
  const full: Record<string, unknown> = { ...base }
  if (l.messageId) full.message_id = l.messageId
  if (l.provider) full.provider = l.provider
  if (l.providerId) full.provider_message_id = l.providerId

  // A send that physically went out with no audit row, no error and a tally still
  // reporting success is indistinguishable from a quiet night. Say so, always.
  const failed = (e: { code?: string; message?: string }, note: string): { ok: false } => {
    console.error(`[comms/log] ${note} for ${l.template}/${l.channel} (user ${l.userId}): ${e.code ?? 'no-code'} ${e.message ?? ''}`.trim())
    return { ok: false }
  }

  if (Object.keys(full).length === Object.keys(base).length) {
    const { error } = await sb.from('notification_log').insert(base)
    if (error) return failed(error, 'audit row LOST')
    return { ok: true }
  }
  const { error } = await sb.from('notification_log').insert(full)
  if (!error) return { ok: true }

  // Pre-migration fallback — and ONLY that. `base` OMITS provider +
  // provider_message_id, which is exactly what lib/comms/delivery matches webhooks
  // on, so a fallback row can NEVER advance past 'sent': a bounced email reads
  // "Sent" forever. That is an acceptable trade against losing the row entirely to a
  // column that doesn't exist yet — and an unacceptable one for any other error.
  //
  // Firing on ANY error made it a permanent downgrade triggered by a transient blip.
  // Worse: when the first insert SUCCEEDED server-side but the client saw a timeout,
  // the fallback wrote a SECOND, untrackable row for one send. Gated to the
  // missing-column codes, neither can happen.
  if (!MISSING_COLUMN_CODES.has(error.code ?? '')) return failed(error, 'audit row LOST (not a missing column — no untrackable fallback written)')

  const { error: fallbackErr } = await sb.from('notification_log').insert(base)
  if (fallbackErr) return failed(fallbackErr, 'audit row LOST (pre-migration fallback also failed)')
  return { ok: true }
}

/**
 * Log every per-channel attempt from a dispatchToCustomer() result — the shape
 * every automated sender wants, so none of them hand-roll the loop (and drop the
 * provider id on the way through).
 *
 * Returns { ok: true } only when EVERY attempt was logged. Callers are free to
 * ignore it — the point is that a partly-unaudited dispatch is now knowable rather
 * than invisible.
 */
export async function logDispatch(
  sb: SupabaseClient,
  res: DispatchResult,
  ctx: { userId: string; customerId: string | null; jobId?: string | null; template: string },
): Promise<{ ok: boolean }> {
  let ok = true
  for (const a of res.attempts) {
    const r = await logSend(sb, {
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
    if (!r.ok) ok = false
  }
  return { ok }
}
