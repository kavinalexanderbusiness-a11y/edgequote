import type { SupabaseClient } from '@supabase/supabase-js'

// ── The No charge door (client half) ─────────────────────────────────────────
// A thin wrapper over `quote_set_no_charge` / `job_set_no_charge`. It is thin ON
// PURPOSE: every rule that matters — all-three-or-none, the actor coming from the
// session rather than the caller, the audit entry, and the refusal to clear a
// decision an accepted quote was authorised on — lives in the DATABASE, where no
// app path can go around it. This file only carries the request and translates
// the answer into something an owner can read.
//
// ⛔ There is no "set the columns directly" export here, and there must never be
// one. Ordinary price editing must not be able to manufacture or clear free-work
// evidence as a side effect.

/** The longest reason the database will accept (mirrors the CHECK constraint). */
export const NO_CHARGE_REASON_MAX = 500
/** Short enough to be meaningless is also a failure — the CHECK says 3. */
export const NO_CHARGE_REASON_MIN = 3

export type NoChargeEntity = 'quote' | 'job'

export interface NoChargeResult {
  ok: boolean
  /** Owner-facing. Present whenever ok is false. */
  error?: string
  /** True when the failure is "this database has not run the migration yet".
   *  Distinguished because it is an OPERATOR problem, not the owner's — and
   *  because saying "could not save" for it would send someone hunting a bug in
   *  their own data. */
  needsMigration?: boolean
}

/** What is wrong with this reason, or null when nothing is. Pure, so the form
 *  can say it before the round-trip and the guard can drive the same rule. */
export function noChargeReasonProblem(reason: string): string | null {
  const r = reason.trim()
  if (r.length < NO_CHARGE_REASON_MIN) return 'Say why this is free — a word or two is enough, and it goes on the record.'
  if (r.length > NO_CHARGE_REASON_MAX) return `Keep the reason under ${NO_CHARGE_REASON_MAX} characters.`
  return null
}

// PostgREST surfaces a missing function as 42883 and a missing column as 42703.
// Either means the same thing here: the migration has not been applied to this
// database. ⭐ This is the S111 lesson wired in as behaviour rather than a note —
// a build deployed ahead of its migration should SAY so, not fail obscurely.
const MISSING = new Set(['42883', '42703', 'PGRST202'])

async function call(
  supabase: SupabaseClient,
  fn: string,
  args: Record<string, unknown>,
): Promise<NoChargeResult> {
  const { data, error } = await supabase.rpc(fn, args)
  if (error) {
    if (MISSING.has(String(error.code))) {
      return {
        ok: false,
        needsMigration: true,
        error: 'No charge isn’t available on this database yet — its migration hasn’t been applied.',
      }
    }
    return { ok: false, error: error.message }
  }
  // The RPC returns false for a refusal it does not want to explain in detail
  // (not yours, signed out, or a clear that the record's state forbids).
  if (data !== true) {
    return { ok: false, error: 'That change wasn’t allowed — reload and check the current state.' }
  }
  return { ok: true }
}

/** Mark a quote deliberately free, on the record. */
export function markQuoteNoCharge(supabase: SupabaseClient, quoteId: string, reason: string): Promise<NoChargeResult> {
  return call(supabase, 'quote_set_no_charge', { p_quote_id: quoteId, p_reason: reason.trim() })
}

/**
 * Remove a no-charge designation. ⛔ The database refuses this once the quote is
 * past draft/sent: an accepted no-charge quote was authorised BECAUSE it was
 * free, and un-marking it afterwards would leave customer-authorised work with
 * no price and no free-work record.
 */
export function clearQuoteNoCharge(supabase: SupabaseClient, quoteId: string): Promise<NoChargeResult> {
  return call(supabase, 'quote_set_no_charge', { p_quote_id: quoteId, p_reason: null })
}

/** Mark one visit deliberately free, on the record. */
export function markJobNoCharge(supabase: SupabaseClient, jobId: string, reason: string): Promise<NoChargeResult> {
  return call(supabase, 'job_set_no_charge', { p_job_id: jobId, p_reason: reason.trim() })
}

/** Remove a visit's no-charge designation. Refused once the visit is completed. */
export function clearJobNoCharge(supabase: SupabaseClient, jobId: string): Promise<NoChargeResult> {
  return call(supabase, 'job_set_no_charge', { p_job_id: jobId, p_reason: null })
}
