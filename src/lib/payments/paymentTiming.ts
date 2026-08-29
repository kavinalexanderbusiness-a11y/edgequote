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
}

export interface TimingOptions {
  /**
   * False while the price the deposit is taken of is still undecided — an
   * options quote with no option selected. Defaults to true, which is correct
   * for every plain quote and for any quote past acceptance (accepted_price is
   * the consent snapshot by then).
   */
  basisSettled?: boolean
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
    }
  }
  const settled = opts.basisSettled !== false
  const isPercentRule = q.deposit_type === 'percent'
  return {
    mode: 'deposit_before_scheduling',
    requiresDepositBeforeScheduling: true,
    // A FIXED rule states its dollars outright and needs no basis — $500 is $500
    // whichever option they pick. Only the percent rule has to wait.
    depositAmount: isPercentRule && !settled ? null : required,
    depositPercent: isPercentRule ? Number(q.deposit_value) : null,
    basis,
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
    return 'Nothing is charged when you approve — you’ll get an invoice once the work is done.'
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
    return 'Approving doesn’t charge you — we’ll confirm a date with you first, and you’ll only get an invoice after the work is done.'
  }
  const ask = t.depositAmount != null && t.depositAmount > 0
    ? `A ${formatCurrency(t.depositAmount)} deposit`
    : `A ${t.depositPercent}% deposit`
  return `Approving doesn’t charge you. ${ask} is asked for next to secure your booking — we’ll confirm your date once it’s received.`
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
