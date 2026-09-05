import {
  classifyTermsPaymentClaim, termsFingerprint, TERMS_CLASSIFIER_VERSION,
  type TermsPaymentClaim,
} from '@/lib/payments/termsTimingConflict'

// ── Is the stored terms classification still trustworthy, and what replaces it ─
//
// THE ONE decision behind the owner's self-heal, extracted so it can be tested
// against the real thing rather than a re-implementation.
//
// ⚠️⚠️ It exists because the first version of this repair was proven by a guard
// that simulated what the route does — a `reclassifyLikeTheRoute()` helper in the
// test. Every behavioural mutation to the ROUTE passed, because nothing compared
// the route to the simulation; the test agreed with itself. Same shape as the
// classifier corpus that agreed with itself and caught 0 of 114 live quotes.
// One function, two callers, no simulation.
//
// The staleness rule is deliberately identical to the DATABASE's, because the
// database is the thing that will refuse: a claim is trustworthy only when it
// exists, was computed from THESE EXACT terms (fingerprint), and by THIS
// classifier (version). Anything else is `unclassified` and fails closed.

export interface StoredTermsClaim {
  terms_text: string | null
  terms_payment_claim: string | null
  terms_payment_claim_fingerprint: string | null
  terms_payment_claim_version: number | null
}

export interface TermsClaimRefresh {
  /** The verdict on the terms as they read RIGHT NOW. */
  claim: TermsPaymentClaim
  /** Fingerprint of those exact terms — what makes the verdict belong to them. */
  fingerprint: string
  /** True when the stored verdict cannot be trusted and must be rewritten. */
  stale: boolean
  /**
   * Exactly what to persist. THE THREE CLASSIFICATION COLUMNS AND NOTHING ELSE —
   * `terms_text` is absent by construction, so no caller can rewrite the owner's
   * words through this path even by accident.
   */
  patch: {
    terms_payment_claim: TermsPaymentClaim
    terms_payment_claim_fingerprint: string
    terms_payment_claim_version: number
  }
}

/**
 * Given the stored row, decide whether the classification needs rewriting and
 * what it should become. Pure — no I/O, no clock, no tenant.
 *
 * `row === null` (no business_settings row at all) is treated as stale with a
 * `no_claim` verdict over empty terms: there is nothing to contradict. It is the
 * caller's job to decide whether writing to a non-existent row makes sense.
 */
export function termsClaimRefresh(row: StoredTermsClaim | null): TermsClaimRefresh {
  const termsText = row?.terms_text ?? null
  const claim = classifyTermsPaymentClaim(termsText)
  const fingerprint = termsFingerprint(termsText)
  const stale = row == null
    || row.terms_payment_claim == null
    || row.terms_payment_claim_fingerprint !== fingerprint
    || row.terms_payment_claim_version !== TERMS_CLASSIFIER_VERSION
  return {
    claim,
    fingerprint,
    stale,
    patch: {
      terms_payment_claim: claim,
      terms_payment_claim_fingerprint: fingerprint,
      terms_payment_claim_version: TERMS_CLASSIFIER_VERSION,
    },
  }
}
