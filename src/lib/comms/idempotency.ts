import type { SupabaseClient } from '@supabase/supabase-js'

// ── Message-send idempotency ─────────────────────────────────────────────────
// ONE guard for the whole comms pipeline. A client generates a stable
// client_message_id the moment the owner acts and reuses it across EVERY retry,
// offline replay, and concurrent tab for that same logical send. Before the ONE
// pipeline (/api/messages/send + /api/comms/send) dispatches any SMS/email it
// calls claimSend(): the composite PK (user_id, client_message_id) on
// public.message_sends means exactly one caller wins the insert (claimed:true) and
// may send; every other caller gets claimed:false and MUST NOT send. The database
// is the single serialization point, so this holds even across tabs with no Web
// Locks. This is not a second messaging system — nothing is sent from here; it is a
// reservation ledger the existing routes consult before they dispatch.

// A stable per-send id. Generated once at the call site (client) and threaded into
// BOTH the immediate request AND the offline-outbox payload, so an online send and
// a replayed-hours-later send carry the SAME id → at most one dispatch.
export function newClientMessageId(): string {
  try { return crypto.randomUUID() } catch { return `${Date.now()}-${Math.round(Math.random() * 1e9)}` }
}

// Atomically reserve a send. Returns:
//   { claimed: true }  → this caller owns the send and must perform it exactly once.
//   { claimed: false } → the send was already claimed (retry / replay / other tab) →
//                        DO NOT dispatch; the original attempt already did (or is doing) it.
// A missing key (legacy caller) is treated as always-claimed so the online path is
// unchanged. If the guard table itself is unreachable (e.g. migration not yet run →
// 42P01), we fail OPEN (claimed:true) so messaging is never blocked by an absent
// migration — idempotency simply isn't enforced until the table exists. Only a real
// unique_violation (23505) means "already handled".
export async function claimSend(
  sb: SupabaseClient,
  userId: string,
  key: string | null | undefined,
  channel?: string,
): Promise<{ claimed: boolean }> {
  if (!key) return { claimed: true }
  const { error } = await sb.from('message_sends')
    .insert({ user_id: userId, client_message_id: key, channel: channel ?? null, status: 'sending' })
  if (!error) return { claimed: true }
  if (error.code === '23505') return { claimed: false } // duplicate → already handled, never resend
  return { claimed: true } // guard unavailable (e.g. pre-migration) → don't block the send
}

// Record the final outcome on the reservation (best-effort, informational only —
// the claim itself is what enforces at-most-once, so a failed finalize is harmless).
export async function finalizeSend(
  sb: SupabaseClient,
  userId: string,
  key: string | null | undefined,
  status: string,
): Promise<void> {
  if (!key) return
  await sb.from('message_sends').update({ status }).eq('user_id', userId).eq('client_message_id', key)
}
