import type { SupabaseClient } from '@supabase/supabase-js'

// ── THE quote-number seam ────────────────────────────────────────────────────
//
// ⭐⭐ A QUOTE NUMBER IS ALLOCATED BY THE DATABASE, ONCE, ATOMICALLY. This module
// is the only way the app asks for one, and it does not compute anything: it
// calls `public.allocate_quote_number()`, which advances a per-tenant/prefix/year
// counter in a single INSERT … ON CONFLICT … RETURNING.
//
// ⛔ WHAT THIS REPLACES, AND WHY IT CANNOT COME BACK. Every caller used to read
// every quote number the tenant had, take the largest trailing digits, and add
// one — in the browser, before inserting. Two things went wrong with that, and
// only one of them is the obvious one:
//
//   • CONTENTION. Two callers read the same maximum and mint the same number.
//   • STALENESS, which is what actually happened. Production holds
//     EPS-2026-0008 and EPS-2026-0009 twice each, minted 70 and 76 minutes
//     after the originals — a snapshot read when the maximum was 0007, used
//     twice afterwards. No two requests were ever in flight together.
//
// Both are the same defect: a number derived from a value read earlier, with no
// database barrier to catch the result. `quotes` had no uniqueness constraint at
// all, so nothing noticed.
//
// ⛔ Do not add a retry loop, a re-read, or a fallback that computes a number
// when the RPC fails. A failure here must stop the save — a quote with a
// guessed number is worse than a quote that was not created.

/**
 * Ask the database for this tenant's next quote number.
 *
 * The tenant comes from the caller's own session inside the function, so there
 * is nothing to pass and nothing a client could point at another business.
 *
 * Returns null on failure — deliberately not a computed fallback. Callers must
 * abort the save and say so.
 */
export async function allocateQuoteNumber(
  supabase: SupabaseClient,
): Promise<{ quoteNumber?: string; error?: string }> {
  const { data, error } = await supabase.rpc('allocate_quote_number')
  if (error) return { error: error.message }
  const value = typeof data === 'string' ? data : null
  if (!value) return { error: 'The database did not return a quote number.' }
  return { quoteNumber: value }
}

/** The sentence every door shows when allocation fails. One wording, one place. */
export const QUOTE_NUMBER_FAILED =
  'Could not reserve a quote number, so nothing was saved. Check your connection and try again.'

/**
 * Allocate `count` numbers for a bulk operation (duplicating a selection).
 *
 * ⭐ It calls the allocator `count` times rather than reserving a range. Each
 * call is atomic on its own, so a partially-failed bulk duplicate leaves spent
 * numbers behind and no duplicates — which is the correct trade. Reserving a
 * range would need a second code path and a way to give a range back.
 */
export async function allocateQuoteNumbers(
  supabase: SupabaseClient,
  count: number,
): Promise<{ quoteNumbers?: string[]; error?: string }> {
  const out: string[] = []
  for (let i = 0; i < count; i++) {
    const one = await allocateQuoteNumber(supabase)
    if (one.error || !one.quoteNumber) return { error: one.error ?? 'allocation failed' }
    out.push(one.quoteNumber)
  }
  return { quoteNumbers: out }
}
