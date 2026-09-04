import { safeErrorHint } from './types'

// ── Operator run history: best-effort persistence, never silent ─────────────
//
// This lives in a lib rather than beside the handler for two reasons. A Next
// App Router `route.ts` may only export HTTP handlers and a small set of
// recognised config values, so a helper exported from there is outside that
// contract; and logic a guard cannot import is logic a guard can only assert
// ABOUT, from a distance. Here it can be driven directly with a stub client.

/** Only what an operator needs to size a silent audit gap. No business content. */
export interface RunAuditMeta {
  provider: string
  model: string | null
  tokens_in: number | null
  tokens_out: number | null
}

/** The narrow slice of the Supabase client this needs — so a test can stub it. */
export interface RunLogClient {
  from(table: string): {
    upsert(row: Record<string, unknown>, opts: Record<string, unknown>): PromiseLike<{ error: { message: string } | null }>
  }
}

/**
 * Write the run-history row, and make a failure VISIBLE instead of silent.
 *
 * Swallows nothing and re-throws nothing. The answer has already been produced
 * (and, when the pre-check allowed it, already paid for), so a failure here must
 * never take the answer away from the owner — but it must not vanish either.
 *
 * ⛔⛔ Both failure shapes are handled, because they are NOT the same branch:
 * supabase-js RESOLVES with `{ data: null, error }` on the common failures —
 * table absent, RLS refusal, constraint violation — and only rejects on a
 * transport/client fault. A handler placed solely on the rejection branch (the
 * previous `.then(() => undefined, () => undefined)`) therefore dropped exactly
 * the failures most likely to happen.
 *
 * ⭐ The log line is structured and carries NO business content: no question, no
 * answer, no customer text, no tenant identifier. It says only that a run went
 * unrecorded, the redacted shape of the failure, and — the number worth
 * alerting on — whether money was spent on a run that now has no record.
 *
 * @returns true when the row was written, false when it was not (and logged).
 */
export async function recordRun(
  sb: RunLogClient,
  row: Record<string, unknown>,
  audit: RunAuditMeta,
  log: (message: string, detail: string) => void = (m, d) => console.error(m, d),
): Promise<boolean> {
  let failure: string | null = null
  try {
    const { error } = await sb
      .from('operator_runs')
      .upsert(row, { onConflict: 'user_id,idempotency_key', ignoreDuplicates: true })
    if (error) failure = safeErrorHint(error.message)
  } catch (e) {
    failure = safeErrorHint(e)
  }
  if (!failure) return true
  log('[operator] audit write failed', JSON.stringify({
    event: 'operator_run_unrecorded',
    reason: failure,
    provider: audit.provider,
    model: audit.model,
    tokens_in: audit.tokens_in,
    tokens_out: audit.tokens_out,
    // The alarm worth grepping for: a paid run with no audit row. False when the
    // deterministic path answered, because then nothing was spent.
    spend_unrecorded: audit.provider !== 'deterministic',
  }))
  return false
}
