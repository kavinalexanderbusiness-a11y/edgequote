import { paymentTiming, type PaymentTiming } from '@/lib/payments/paymentTiming'
import type { GateQuote } from '@/lib/payments/depositGate'
// md5 in the browser — the fingerprint must equal Postgres's quote_terms_fingerprint().
import { md5 } from '@/lib/md5'

// ── Does the owner's free-text Terms contradict the quote's payment timing? ───
//
// `business_settings.terms_text` is the THIRD source of payment-timing truth,
// and the only ungoverned one. The other two are configuration the app derives
// from (`quotes.deposit_type/value` → lib/payments/depositGate → paymentTiming;
// `invoices.deposit_amount` → lib/payments/deposit). This one is a textarea an
// owner filled in once, and it prints on every quote.
//
// It became load-bearing when acceptance started requiring it: the customer is
// now shown the terms and must agree to them before they can accept. So an owner
// whose terms say "Payment is due in full upon completion", on a quote
// configured to require 50% before scheduling, is asking a customer to AGREE to
// a sentence the product will contradict at the next screen. That is not a
// cosmetic inconsistency any more — it is consent to the wrong thing.
//
// ⛔⛔ THE RULE THIS MODULE EXISTS TO PRESERVE: terms_text NEVER drives payment
// behaviour. It is not consulted by paymentTiming, by depositGate, by either
// charge route, or by any figure shown to a customer. It is prose we DETECT a
// contradiction in and then refuse to send — never an input to what is owed,
// when, or how much. If a future change makes any money path read terms_text,
// verify:payment-timing-copy fails.
//
// ⛔ And it is never REWRITTEN. These are the owner's own terms, likely their
// legal wording; silently "correcting" them would put words the owner never
// wrote in front of a customer under the owner's name. We surface the exact
// sentence, say what the quote is configured to do, and let a human decide.
//
// ── Precision over recall, deliberately ──────────────────────────────────────
// This gate BLOCKS a send, so a false positive stops an owner from doing
// business over wording that was fine. Every pattern below therefore demands an
// explicit, unhedged assertion, and three separate guards suppress the ordinary
// ways honest terms talk about money:
//
//   1. HEDGES — "a deposit may be required for larger jobs" asserts nothing.
//   2. THE BALANCE — "the balance is due upon completion" is CORRECT on a
//      deposit quote; it describes the remainder. Only claims about the TOTAL
//      ("payment in full", "100%", "the entire amount") conflict.
//   3. TERMS THAT ALREADY NAME A DEPOSIT — if the terms themselves say a deposit
//      is required, they agree with a deposit-gated quote, and any later
//      "due on completion" sentence is about what is left. Not a conflict.

/**
 * ⭐ THE NORMALIZED CLAIM — what the TERMS say, independent of any quote.
 *
 * Quote-independence is the whole point: this value is stored once per tenant
 * and compared against every quote's configured timing. A state meaning
 * "compatible" would be a category error, because compatibility is a property
 * of a (terms, quote) PAIR and would be wrong for the very next quote.
 *
 *   no_claim              the terms say nothing about when money is due. Safe
 *                         with either structured timing.
 *   no_money_before_work  "no deposit is required" / "payment in full upon
 *                         completion" — an unhedged claim that nothing precedes
 *                         the work.
 *   money_before_work     "a 50% deposit is required before we book".
 *   ambiguous             the terms assert BOTH. The owner has contradicted
 *                         themselves, so neither reading can be trusted to say
 *                         what the customer is agreeing to.
 *   unclassified          never classified, or classified against different
 *                         terms / an older classifier. NOT a verdict — the
 *                         absence of one. Never stored by the classifier; it is
 *                         the DB's word for "the stored verdict cannot be
 *                         trusted", and it fails closed at acceptance.
 */
export type TermsPaymentClaim =
  | 'no_claim'
  | 'no_money_before_work'
  | 'money_before_work'
  | 'ambiguous'
  | 'unclassified'

/**
 * ⭐ THE CLASSIFIER VERSION. Bump it whenever the rules below change their
 * verdict on any input — the terms text can stay byte-identical while our
 * reading of it improves, and a fingerprint alone cannot see that. A stored
 * classification carrying an older version is treated as `unclassified` and
 * fails closed at acceptance until it is recomputed.
 *
 * ⛔ The database hard-codes the version it expects; `verify:payment-timing-copy`
 * fails if the two drift. Deliberately one small integer — not a framework.
 *
 * v1 — Session 122. The rule set measured against production: `unless` is not a
 *      hedge, and a bare "payment due on completion" carries the claim without
 *      any totality word.
 */
export const TERMS_CLASSIFIER_VERSION = 1

/** The subset a send-time conflict can be reported as. */
export type TermsClaim = Extract<TermsPaymentClaim, 'no_money_before_work' | 'money_before_work'>

export interface TermsTimingConflict {
  /** What the terms assert. */
  claim: TermsClaim
  /** The offending sentence, VERBATIM — quoted back to the owner, never edited. */
  sentence: string
  /** What the quote is actually configured to do. */
  configured: PaymentTiming['mode']
}

// A hedge is language that tells the customer a deposit MIGHT be wanted — it
// leaves them informed, so it is not a contradiction.
//
// ⚠️ "unless" was here and has been REMOVED, because it does the opposite. The
// live production terms read "Payment due upon completion **unless otherwise
// agreed**" on a tenant with four deposit-gated quotes — and that clause tells
// the customer nothing at all. It protects the owner while leaving the reader
// with "payment on completion", which is precisely the belief the deposit
// request then contradicts. A hedge has to hedge TOWARD disclosure to count.
const HEDGE = /\b(may|might|could|can be|possibly|sometimes|often|typically|usually|generally|optional|at our discretion|some (jobs|projects|work)|certain (jobs|projects)|larger (jobs|projects)|depending on|if required|where required)\b/i

/**
 * "The balance is due on completion" is the TRUE second half of a deposit
 * quote's terms. Only a claim about the whole amount can contradict it, so a
 * sentence scoped to the remainder is never a conflict.
 */
const REMAINDER = /\b(balance|remainder|remaining|the rest|outstanding amount|final payment)\b/i

/** An explicit claim that the WHOLE amount arrives only after the work. */
const TOTAL_AFTER_WORK = new RegExp(
  // ⚠️ The closing boundary is a NOT-A-LETTER lookahead, not `\b`. `\b` after
  // "100%" can never match: `%` and the following space are both non-word
  // characters, so there is no boundary between them and the whole alternation
  // silently failed on the commonest phrasing of all ("100% is due on
  // completion"). Only the guard's conflict corpus caught it.
  '\\b(payment in full|paid in full|due in full|full payment|the full amount|the total amount|the entire amount|100\\s*%|total (?:is |amount )?due)(?=[^A-Za-z]|$)'
  + '[^.!?]{0,60}?'
  + '\\b(upon|on|after|following|once)\\b[^.!?]{0,30}?'
  + '\\b(completion|complete|completed|the work is done|work is finished|the job is done|finish)\\b', 'i')

/**
 * Bare "payment is due on completion" — no totality word, no mention of a
 * deposit, no scope to the balance.
 *
 * ⚠️ This pattern exists because the LIVE production terms are exactly this
 * sentence, and the first version of this detector walked straight past them:
 * TOTAL_AFTER_WORK demanded a totality word ("in full", "100%"), and real owners
 * do not write like that. Measuring against the real rows is what found it — the
 * hand-written corpus had agreed with itself perfectly.
 *
 * Safe against the honest readings because it runs AFTER the two guards that
 * matter: a sentence scoped to the balance is skipped by REMAINDER, and terms
 * that document the deposit properly return before we get here.
 */
const BARE_PAYMENT_AFTER_WORK =
  /\bpayments?\b[^.!?]{0,25}?\b(due|payable|owing|collected)\b[^.!?]{0,25}?\b(upon|on|after|following|once)\b[^.!?]{0,25}?\b(completion|complete|completed|the work is done|the job is done|finish)/i

/** An explicit denial that any money is wanted before the work. */
const NO_MONEY_UPFRONT = [
  /\bno\s+deposits?\b[^.!?]{0,40}?\b(required|needed|necessary|taken|requested|due)\b/i,
  /\b(we\s+)?(do\s+not|don.t|never)\s+(require|take|request|ask for)\s+(a\s+)?deposits?\b/i,
  /\b(a\s+)?deposits?\s+(is|are)\s+(not\s+required|never\s+required|not\s+needed)\b/i,
  /\bno\s+(payment|money|amount)\b[^.!?]{0,30}?\b(is\s+)?(required|due|needed|payable)\b[^.!?]{0,20}?\b(until|before|prior to|in advance|up\s?front)\b/i,
  /\bno\s+(upfront|up-front|up front|advance)\s+(payment|deposit|fee)\b/i,
  /\bnothing\s+(is\s+)?(due|charged|payable|required)\b[^.!?]{0,30}?\b(until|before|up\s?front|in advance)\b/i,
]

/** An explicit claim that money IS wanted before the work begins. */
const MONEY_UPFRONT = [
  /\b(a\s+)?\d{1,3}\s*%\s+deposit\b[^.!?]{0,40}?\b(is\s+)?(required|due|needed|payable|must)\b/i,
  /\b(a\s+)?deposits?\b[^.!?]{0,40}?\b(is|are)\s+(required|due|payable|needed)\b[^.!?]{0,40}?\b(before|prior to|in advance|up\s?front|to (book|schedule|secure|reserve)|to confirm)\b/i,
  /\b(we\s+)?(require|request|take)\s+(a\s+)?(\d{1,3}\s*%\s+)?deposits?\b[^.!?]{0,40}?\b(before|prior to|up\s?front|in advance|to (book|schedule|secure|reserve))\b/i,
  /\b(payment|paid)\s+in\s+full\b[^.!?]{0,30}?\b(before|prior to|in advance|up\s?front)\b[^.!?]{0,30}?\b(work|start|commenc|begin|schedul)/i,
]

/**
 * Do the terms themselves already say a deposit is required? If so they AGREE
 * with a deposit-gated quote, and a later "due on completion" sentence is about
 * the balance. This is the single most important false-positive guard: an owner
 * who documented their deposit correctly must never be blocked.
 */
function termsAcknowledgeDeposit(sentences: string[]): boolean {
  return sentences.some(s => !HEDGE.test(s) && MONEY_UPFRONT.some(re => re.test(s)))
}

/**
 * Split into sentences so a hedge in one clause cannot excuse an unhedged claim
 * in another — and so the sentence we quote back to the owner is the one they
 * actually need to look at. Newlines and list bullets end a sentence too:
 * terms are usually written as a bulleted list, where a "." is often missing.
 */
export function termsSentences(termsText: string | null | undefined): string[] {
  if (!termsText) return []
  return termsText
    .replace(/\r\n/g, '\n')
    .split(/(?<=[.!?])\s+|\n+|(?:^|\s)[-•*]\s+/g)
    .map(s => s.trim())
    .filter(s => s.length > 0)
}

/**
 * ⭐ THE CLASSIFIER — the ONE place the rules live.
 *
 * Answers a question about the TERMS ALONE: what do they claim about when money
 * is due? The answer is deliberately quote-independent, because it is stored on
 * the tenant and reused for every quote. "Compatible" is NOT a claim — that is a
 * comparison, and it belongs in `termsClaimConflicts` below.
 *
 * Precedence, and why:
 *  • An explicit deposit REQUIREMENT and an explicit deposit DENIAL in the same
 *    document is the owner contradicting themselves → `ambiguous`. Neither
 *    reading can be trusted to describe what the customer is agreeing to.
 *  • Otherwise an explicit requirement wins over a bare "due on completion":
 *    terms that document a deposit and then say the total is settled by
 *    completion are ordinary and correct, and the second sentence is about the
 *    remainder. This is the single most important false-positive guard.
 */
export function classifyTermsPaymentClaim(termsText: string | null | undefined): TermsPaymentClaim {
  const sentences = termsSentences(termsText)
  if (sentences.length === 0) return 'no_claim'
  let upfront = false
  let noUpfront = false
  let afterWork = false
  for (const s of sentences) {
    // A hedge leaves the customer informed that a deposit MIGHT be wanted, so it
    // asserts nothing this gate should act on.
    if (HEDGE.test(s)) continue
    if (MONEY_UPFRONT.some(re => re.test(s))) { upfront = true; continue }
    // Explicit denial of any up-front money.
    if (NO_MONEY_UPFRONT.some(re => re.test(s))) { noUpfront = true; continue }
    // A sentence scoped to the REMAINDER is the truthful second half of a
    // deposit quote and never a claim that nothing precedes the work.
    if (REMAINDER.test(s)) continue
    if (TOTAL_AFTER_WORK.test(s) || BARE_PAYMENT_AFTER_WORK.test(s)) afterWork = true
  }
  if (upfront && noUpfront) return 'ambiguous'
  if (upfront) return 'money_before_work'
  if (noUpfront || afterWork) return 'no_money_before_work'
  return 'no_claim'
}

/**
 * The FIRST sentence that carries the claim — quoted back to the owner verbatim
 * so they can find the words themselves. Never edited, never normalised.
 */
export function termsClaimSentence(
  termsText: string | null | undefined, claim: TermsPaymentClaim,
): string | null {
  for (const s of termsSentences(termsText)) {
    if (HEDGE.test(s)) continue
    if (claim === 'money_before_work' && MONEY_UPFRONT.some(re => re.test(s))) return s
    if (claim === 'no_money_before_work') {
      if (NO_MONEY_UPFRONT.some(re => re.test(s))) return s
      if (!REMAINDER.test(s) && (TOTAL_AFTER_WORK.test(s) || BARE_PAYMENT_AFTER_WORK.test(s))) return s
    }
    if (claim === 'ambiguous'
      && (MONEY_UPFRONT.some(re => re.test(s)) || NO_MONEY_UPFRONT.some(re => re.test(s)))) return s
  }
  return null
}

/**
 * Does a stored CLAIM contradict a quote's configured timing? Pure comparison —
 * no text, no regex. This is the rule the database re-states as a scalar
 * comparison, which is why it is expressed here as a total function over the
 * claim rather than as a search through prose.
 *
 * ⛔ `ambiguous` and `unclassified` are NOT contradictions — they are absences
 * of a trustworthy answer. They fail closed at ACCEPTANCE (where durable consent
 * is recorded) and are deliberately not treated as send-time contradictions,
 * because refusing to send over terms we merely cannot read would be a different
 * and much broader product decision than the one that was approved.
 */
export function termsClaimConflicts(
  timing: PaymentTiming, claim: TermsPaymentClaim,
): boolean {
  if (timing.requiresDepositBeforeScheduling) return claim === 'no_money_before_work'
  return claim === 'money_before_work'
}

/**
 * THE send-time detector. Returns the conflict, or null when the terms and the
 * quote's configuration can both be true at once.
 *
 * Now a thin comparison over `classifyTermsPaymentClaim` — the rules moved into
 * the classifier so the SAME verdict is what the Settings save persists and what
 * the database later enforces. Two readers of one classification, never two
 * classifications.
 */
export function detectTermsTimingConflict(
  quote: GateQuote, termsText: string | null | undefined,
): TermsTimingConflict | null {
  const claim = classifyTermsPaymentClaim(termsText)
  const timing = paymentTiming(quote)
  if (!termsClaimConflicts(timing, claim)) return null
  const sentence = termsClaimSentence(termsText, claim)
  if (!sentence) return null
  return { claim: claim as TermsClaim, sentence, configured: timing.mode }
}

/**
 * What the owner is told. Names BOTH sides and the two ways out — edit the
 * quote's deposit rule, or edit the terms in Settings. It never proposes
 * wording: we do not know which of the two the owner meant, and guessing puts
 * our sentence in their contract.
 */
export function termsConflictExplanation(c: TermsTimingConflict): string {
  return c.claim === 'no_money_before_work'
    ? 'This quote requires a deposit before the visit is scheduled, but your Terms & Conditions tell the customer no money is due until the work is done. They would be asked to agree to that, then asked for a deposit. Change the quote’s deposit rule, or edit your terms in Settings.'
    : 'This quote asks for no deposit, but your Terms & Conditions tell the customer a deposit is required before the work starts. Change the quote’s deposit rule, or edit your terms in Settings.'
}

/**
 * THE terms→columns mapping, shared by the Settings save and the backfill so
 * the two can never write a different shape.
 *
 * The fingerprint mirrors the database's own `quote_terms_fingerprint()`:
 * md5 of the TRIMMED terms, empty string when there are none. That equality is
 * the whole trust model — the stored verdict is believed only while it matches
 * the live terms — so it is asserted by verify:payment-timing-copy against the
 * SQL definition rather than left to memory.
 *
 * ⛔ Returns the classification only. It never returns terms_text: this function
 * cannot rewrite the owner's words even by accident.
 */
export function termsClaimPatch(termsText: string | null | undefined): {
  terms_payment_claim: TermsPaymentClaim
  terms_payment_claim_fingerprint: string
  terms_payment_claim_version: number
} {
  return {
    terms_payment_claim: classifyTermsPaymentClaim(termsText),
    terms_payment_claim_fingerprint: termsFingerprint(termsText),
    terms_payment_claim_version: TERMS_CLASSIFIER_VERSION,
  }
}

/**
 * md5(btrim(terms)) — byte-for-byte what `quote_terms_fingerprint(user_id)`
 * computes in SQL. ⚠️ If that function's definition ever changes, this must
 * change with it or every acceptance fails closed; the guard compares the two.
 */
export function termsFingerprint(termsText: string | null | undefined): string {
  return md5(String(termsText ?? '').trim())
}
