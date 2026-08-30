import type { SupabaseClient } from '@supabase/supabase-js'
import type { AcceptanceState } from '@/lib/quoteAcceptance'

// ── Reading the acceptance record — ONE fetch shape ──────────────────────────
//
// lib/quoteAcceptance is pure and stays pure (client components import it for
// labels and verdicts, and must not drag a Supabase client into their bundle).
// This is its I/O half, the same split lib/pipeline ↔ lib/pipelineData and
// lib/sales/analytics ↔ lib/sales/data already use.
//
// ⭐⭐ THE FAILURE CONTRACT IS THE POINT OF THIS FILE. A read that FAILS is not a
// quote that was never accepted, and the difference is the difference between
// "we can't check right now" and "nobody ever agreed to this". Every caller gets
// `{ state, error }` and must branch on the error — the day-status engine's own
// rule (UNKNOWN ≠ OPEN) applied to consent.
//
// ⛔ A gate must therefore treat an ERROR as BLOCKING, never as permission:
// scheduling work or billing a customer because a network call failed is the one
// outcome worse than refusing to do it.

export interface AcceptanceRead {
  /** The record, or null when this quote genuinely has none. */
  state: AcceptanceState | null
  /** Set when the read itself failed. `state` is meaningless when this is set. */
  error: string | null
}

/** THE read. `quote_acceptance_state` asserts tenancy itself (SECURITY DEFINER). */
export async function loadAcceptanceState(
  supabase: SupabaseClient,
  quoteId: string,
): Promise<AcceptanceRead> {
  const { data, error } = await supabase.rpc('quote_acceptance_state', { p_quote_id: quoteId })
  if (error) return { state: null, error: error.message }
  const row = (Array.isArray(data) ? data[0] : data) as AcceptanceState | undefined
  // ⚠️ An EMPTY result is not an error and not an acceptance: the RPC returns no
  // rows for a quote that is not this tenant's, and one all-false row for a quote
  // that simply has no acceptance. Both mean "not authorized", neither means
  // "could not check", so both resolve to a null state with no error.
  return { state: row ?? null, error: null }
}

/**
 * The whole acceptance history for one quote, oldest first — the "accepted
 * version + changes pending reapproval" panel, and the proof that a reapproval
 * ADDED to the record rather than replacing it.
 *
 * Reads the table directly: RLS grants the owner SELECT on their own evidence
 * and nothing else, so there is no RPC to write for this.
 */
export async function loadAcceptanceHistory(
  supabase: SupabaseClient,
  quoteId: string,
): Promise<{ rows: AcceptanceHistoryRow[]; error: string | null }> {
  const { data, error } = await supabase
    .from('quote_acceptances')
    .select('id, seq, accepted_at, kind, source, actor_label, on_behalf_reason, on_behalf_note, accepted_amount, terms_acknowledged, supersedes_id, document')
    .eq('quote_id', quoteId)
    .order('seq', { ascending: true })
  if (error) return { rows: [], error: error.message }
  return { rows: (data as AcceptanceHistoryRow[]) || [], error: null }
}

export interface AcceptanceHistoryRow {
  id: string
  seq: number
  accepted_at: string
  kind: AcceptanceState['kind']
  source: AcceptanceState['source']
  actor_label: string | null
  on_behalf_reason: AcceptanceState['on_behalf_reason']
  on_behalf_note: string | null
  accepted_amount: number | string | null
  terms_acknowledged: boolean
  supersedes_id: string | null
  document: AcceptanceState['document']
}
