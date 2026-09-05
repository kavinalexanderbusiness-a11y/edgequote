import { formatCurrency } from '@/lib/utils'
import {
  type GateQuote, type SchedulingGate, requiredDeposit, depositBasis,
} from '@/lib/payments/depositGate'

// ── THE payment-timing interpretation of a quote ─────────────────────────────
//
// One quote, one answer to "when is my money due", and every customer-facing
// surface reads it from here.
//
// The defect this module exists to close: the portal's quote card asserted
// "Nothing is charged when you approve — you'll get an invoice once the work is
// done" on EVERY quote, including quotes carrying a scheduling-deposit rule. The
// customer read that sentence, approved, and the very next screen asked them for
// half the job up front. Both sentences were rendered by our own code, three
// files apart, and neither knew the other existed. The numbers were never the
// problem — lib/payments/depositGate has always been the one arithmetic — the
// WORDS were unowned, so each surface invented its own.
//
// ⛔ This module owns the words, never a second set of numbers. Every figure it
// prints comes from depositGate (requiredDeposit / schedulingGate). If you need
// a new payment-timing sentence, add it HERE and call it; a sentence about when
// money is due, written inline in a component, is the bug returning.
//
// ── The modes this product actually supports, and nothing more ───────────────
// The schema permits exactly two shapes (quotes.deposit_type is NULL, 'percent'
// or 'fixed', CHECK-pinned), so there are exactly two timings:
//
//   invoice_after_work         no deposit rule. Approving costs nothing; the
//                              single invoice follows the completed work.
//   deposit_before_scheduling  a percent or fixed deposit must reach the LEDGER
//                              before the booking is confirmed; the remainder is
//                              invoiced after the work.
//
// ⛔ Do NOT add modes here speculatively. Full-upfront, before-appointment,
// milestones, installments, Net terms and recurring billing are DOCUMENTED as
// future work in docs/PAYMENT-TIMING.md and are NOT supported: there is no
// column that could carry them, so a mode string for one would be a promise the
// database cannot keep. A surface that cannot describe its own configuration is
// exactly how this defect happened the first time.

/** The two supported timings. See the note above before adding a third. */
export type PaymentTimingMode = 'invoice_after_work' | 'deposit_before_scheduling'

export interface PaymentTiming {
  mode: PaymentTimingMode
  /** True only for 'deposit_before_scheduling' — the one branch every surface tests. */
  requiresDepositBeforeScheduling: boolean
  /**
   * The deposit in dollars, or null when a PERCENT rule has no settled basis yet.
   * Null is not "no deposit" — it is "a deposit, whose dollar figure depends on a
   * choice the customer has not made". Naming a figure there would quote the
   * recommended option's deposit to someone about to pick a different option.
   */
  depositAmount: number | null
  /** The rule as a percentage when it is one, else null. */
  depositPercent: number | null
  /** What the rule is taken OF — depositGate's basis, never a second figure. */
  basis: number
  /** Why `depositAmount` is null, when it is. Null when a figure is known. */
  basisUnsettledReason: BasisUnsettledReason | null
}

/**
 * ⭐⭐ WHY A BASIS CAN BE UNSETTLED. Two different facts, and they need different
 * words: one is a choice the customer has not made yet, the other is an agreement
 * this document no longer matches.
 */
export type BasisUnsettledReason =
  | 'unchosen_option'
  | 'superseded_acceptance'
  /**
   * The acceptance behind this document exists but its currentness cannot be
   * established. Distinct from `superseded_acceptance` because the two are
   * different facts and only one of them is known — see AcceptanceCurrentness.
   */
  | 'unverified_acceptance'

/**
 * ⭐⭐ WHAT THE CALLER KNOWS ABOUT THE ACCEPTANCE BEHIND THIS DOCUMENT.
 *
 * ⛔ THREE STATES, because there are three facts and collapsing two of them puts
 * a claim on paper that nobody established. An earlier version had a boolean, and
 * an independent review caught what that cost: an old-C payload — one carrying
 * `acceptance_kind` without `acceptance_is_current` — took the superseded branch
 * and printed *"This quote has been revised since it was accepted"* on a quote
 * whose acceptance may in fact be perfectly current. Withholding the figure there
 * was right. Asserting a revision to justify it was not.
 *
 *   current      the acceptance matches this document — print the figure.
 *   superseded   it is KNOWN not to: `quote_acceptance_is_current` said false, or
 *                the owner's state says needs_reapproval. The document may say so.
 *   unverified   there IS a usable acceptance and we cannot check it. Withhold the
 *                figure exactly as for `superseded`, and say only what is true:
 *                the acceptance is being confirmed.
 *
 * ⚠️ The CALLER decides. The document must not derive this for itself — that would
 * be another independent derivation of the question this lane has spent its length
 * consolidating — and there is deliberately no price heuristic behind it.
 */
export type AcceptanceCurrentness = 'current' | 'superseded' | 'unverified'

export interface TimingOptions {
  /**
   * False while the price the deposit is taken of is still undecided — an
   * options quote with no option selected. Defaults to true, which is correct
   * for every plain quote and for any quote past acceptance (accepted_price is
   * the consent snapshot by then).
   */
  basisSettled?: boolean
  /**
   * ⛔⛔ THE ACCEPTANCE THIS DOCUMENT'S DEPOSIT WOULD BE TAKEN OF NO LONGER
   * MATCHES THIS DOCUMENT.
   *
   * THE DEFECT THIS CLOSES, seen on a genuinely generated PDF: a quote with valid
   * named evidence at $1,400 whose document has since been revised to $500 printed
   *
   *     Quote Total                     $500.00
   *     A 50% deposit ($700.00) is required before we schedule your visit …
   *
   * Both halves are individually defensible — the total is the live document, the
   * deposit derives from a proven consent snapshot — and together they are
   * arithmetic no customer can reconcile.
   *
   * ⭐ THE RULE: an amount and its authority travel together. When the acceptance
   * is not current, no surface may present a figure derived from the superseded
   * snapshot as a live ask. The percentage still stands — that is this quote's own
   * configuration, not a consent artifact — so the sentence keeps the rule and
   * drops the figure, exactly as it already does for an unchosen option.
   *
   * ⛔ It does NOT re-derive the deposit from the current total. That would put a
   * dollar demand on paper that nobody has agreed to, which is the same
   * substitution in the opposite direction. And it changes no gate: the charge
   * route already refuses a non-current acceptance, and still does.
   *
   * ⚠️ The CALLER supplies this. The document must not decide currentness for
   * itself — that would be a fourth independent derivation of the question this
   * lane has spent its whole length consolidating.
   */
  acceptanceCurrentness?: AcceptanceCurrentness
}

/**
 * THE reader. Give it the quote; it tells you when money is due.
 *
 * Deliberately takes the same structural `GateQuote` the deposit gate takes, so
 * a `Quote`, a `PortalQuote` and the builder's live form values all satisfy it
 * and none of them can be described differently from how they are charged.
 */
export function paymentTiming(q: GateQuote, opts: TimingOptions = {}): PaymentTiming {
  const basis = depositBasis(q)
  const required = requiredDeposit(q)
  if (required <= 0) {
    return {
      mode: 'invoice_after_work',
      requiresDepositBeforeScheduling: false,
      depositAmount: 0,
      depositPercent: null,
      basis,
      basisUnsettledReason: null,
    }
  }
  // ⭐ TWO reasons a basis can be unsettled, and the superseded one is checked
  // FIRST because it is the stronger fact: an unchosen option is a decision still
  // to come, a superseded acceptance is an agreement already broken.
  // ⭐ Both non-current states withhold the figure — the difference is only in
  // what the document is then allowed to SAY about why.
  const currentness = opts.acceptanceCurrentness ?? 'current'
  const superseded = currentness !== 'current'
  const settled = !superseded && opts.basisSettled !== false
  const reason: BasisUnsettledReason | null = currentness === 'superseded'
    ? 'superseded_acceptance'
    : currentness === 'unverified'
      ? 'unverified_acceptance'
      : (opts.basisSettled === false ? 'unchosen_option' : null)
  const isPercentRule = q.deposit_type === 'percent'
  // ⚠️ An unchosen option cannot unsettle a FIXED rule — $500 is $500 whichever
  // option they pick, so only the percent rule waits on a choice.
  //
  // ⛔⛔ A SUPERSEDED ACCEPTANCE UNSETTLES BOTH, and an earlier version of this
  // line got that wrong. The reasoning then was about PROVENANCE — a fixed figure
  // is the quote's own configuration, not a consent artifact — and that is true
  // and beside the point. The failure this rule exists to stop is RECONCILIATION:
  // a dollar ask the customer cannot square with the document in front of them.
  // `requiredDeposit` clamps a fixed rule to the basis (`min(value, basis)`), so
  // with named evidence at $1,400 against a $500 document a fixed $700 still
  // prints on a $500 page — the exact sentence that started this — under an
  // acceptance the charge route will refuse. Provenance did not save it.
  const unsettled = superseded || (isPercentRule && !settled)
  return {
    mode: 'deposit_before_scheduling',
    requiresDepositBeforeScheduling: true,
    depositAmount: unsettled ? null : required,
    depositPercent: isPercentRule ? Number(q.deposit_value) : null,
    basis,
    basisUnsettledReason: unsettled ? reason : null,
  }
}

/** "50% deposit ($500)" / "50% deposit" / "$500 deposit" — as precise as it is known. */
function askPhrase(t: PaymentTiming): string {
  const dollars = t.depositAmount != null && t.depositAmount > 0 ? formatCurrency(t.depositAmount) : null
  if (t.depositPercent != null) {
    return dollars ? `${t.depositPercent}% deposit (${dollars})` : `${t.depositPercent}% deposit`
  }
  return dollars ? `${dollars} deposit` : 'deposit'
}

/**
 * The quote's own payment-timing sentence — the one the customer reads BEFORE
 * they approve, on the portal card and on the PDF they keep.
 *
 * This is the sentence whose absence caused the defect. A deposit-gated quote
 * that says nothing about the deposit is not neutral: the customer fills the
 * silence with the ordinary case, and we then contradict them at the moment they
 * commit.
 */
export function quoteTimingLine(t: PaymentTiming): string {
  if (!t.requiresDepositBeforeScheduling) {
    return 'Nothing is charged when you accept — you’ll get an invoice once the work is done.'
  }
  // ⛔ The superseded case gets its OWN sentence, and it is the only one that
  // says why. Reusing "of the option you choose" would tell a customer their
  // figure depends on a choice when it actually depends on a revision they have
  // not seen yet — a true-sounding sentence about the wrong thing.
  // ⚠️ A percent rule can still state its RULE, because a percentage is the
  // quote's configuration and survives whatever happened to the acceptance. A
  // fixed rule's rule IS its dollars, so there is nothing left to state but the
  // requirement itself — inventing a percentage for it would be arithmetic
  // nobody wrote.
  const rule = t.depositPercent != null ? `A ${t.depositPercent}% deposit` : 'A deposit'
  // ⭐ Three parts, and no fourth: the RULE, the one fact that is known, and ONE
  // next step. "…so the amount previously agreed no longer applies" was a third
  // clause restating the second, and a customer reading a deposit notice is
  // owed brevity as much as accuracy.
  if (t.basisUnsettledReason === 'superseded_acceptance') {
    return `${rule} is required before we schedule your visit. `
      + 'This quote has been revised since you accepted it, so we’ll agree the amount with you before anything is due.'
  }
  // ⛔⛔ SAY ONLY WHAT IS KNOWN. Both states withhold the figure, and it would be
  // easy to reuse the sentence above — an independent review caught exactly that:
  // an old-C payload printed "This quote has been revised since it was accepted"
  // about a quote whose acceptance may be perfectly current. Withholding was the
  // safe direction; the revision claim was not established by anything.
  //
  // So this sentence asserts no revision, promises no change, and does not
  // reassure either. It says the one true thing — the acceptance on file is being
  // confirmed — and that nothing is due until it has been.
  if (t.basisUnsettledReason === 'unverified_acceptance') {
    return `${rule} is required before we schedule your visit. `
      + 'The acceptance on file for this quote is still being confirmed, so we’ll agree the amount with you before anything is due.'
  }
  const ask = t.depositAmount == null
    ? `A ${t.depositPercent}% deposit of the option you choose`
    : `A ${askPhrase(t)}`
  return `${ask} is required before we schedule your visit — the rest is invoiced once the work is done.`
}

/**
 * The sentence in the approval dialog, at the instant of commitment.
 *
 * By this point an options quote HAS a chosen option, so the figure is known and
 * the copy names it. "Approving doesn't charge you" is true either way and stays
 * — but it must never stand unqualified when a deposit request is the very next
 * screen. That qualification is the whole point.
 */
export function approvalTimingLine(t: PaymentTiming): string {
  if (!t.requiresDepositBeforeScheduling) {
    return 'Accepting doesn’t charge you — we’ll confirm a date with you first, and you’ll only get an invoice after the work is done.'
  }
  const ask = t.depositAmount != null && t.depositAmount > 0
    ? `A ${formatCurrency(t.depositAmount)} deposit`
    : `A ${t.depositPercent}% deposit`
  return `Accepting doesn’t charge you. ${ask} is asked for next to secure your booking — we’ll confirm your date once it’s received.`
}

/**
 * What to say once the quote is approved — the banner, the Home card, the
 * Billing panel. Reads the LEDGER's answer (the gate), never the rule alone, so
 * a refund that un-satisfies the gate un-says the sentence too.
 *
 * `scheduled` distinguishes the override case: the owner booked the visit anyway
 * and the money is still owed. Telling that customer a deposit is needed "to
 * secure scheduling" would be false — their visit is already on the schedule —
 * so the sentence names the debt without inventing a gate that was waived.
 */
export function approvedTimingLine(
  t: PaymentTiming, gate: Pick<SchedulingGate, 'outstanding' | 'status'>, scheduled = false,
): string {
  if (!t.requiresDepositBeforeScheduling) {
    return 'Nothing is due yet — you’ll get an invoice once the work is done.'
  }
  if (gate.status === 'satisfied') return depositCreditLine()
  const owed = formatCurrency(gate.outstanding)
  if (scheduled) {
    return `Your visit is booked. The ${owed} deposit is still outstanding — the rest is invoiced once the work is done.`
  }
  return `${owed} deposit secures your booking — the rest is invoiced once the work is done.`
}

/**
 * What a paid scheduling deposit actually becomes.
 *
 * ledger.recordDeposit writes two legs — the cash received AND a matching
 * `kind='credit'` row — so the money sits on the customer's account and comes
 * off a later invoice through applyCreditToInvoice. Saying only "Deposit
 * received" left the customer to wonder whether they had just paid an extra
 * $500 on top of the quoted price. They had not, and we can say so.
 */
export function depositCreditLine(): string {
  return 'Deposit received — it’s held on your account and comes off your final invoice.'
}

/**
 * The PDF's payment-terms line. Same interpretation, printed on the document the
 * customer keeps and forwards; the owner's free-text Terms & Conditions sits
 * BELOW it and can add to it, but this line is ours and always tells the truth
 * about the configuration.
 */
export function pdfTimingLine(t: PaymentTiming): string {
  return quoteTimingLine(t)
}
