// ── THE tip / gratuity engine ────────────────────────────────────────────────
// One engine, so the portal's tip chips, the server that builds the Stripe
// session, the webhook that splits the settled charge, and the refund
// apportioner cannot disagree about a single cent.
//
// THE ACCOUNTING TRUTH this file protects, stated once:
//
//     invoice total          $500     ← untouched, forever
//     applied to invoice     $500     ← payments.amount, kind='payment'
//     tip                     $75     ← payments.amount, kind='tip'
//     gross Stripe charge    $575     ← applied + tip, ONE charge
//     invoice balance          $0
//
// A tip is NOT invoice revenue and NOT an overpayment. It never enters
// invoices.amount, invoices.amount_paid, invoices.status, invoiceTotals(),
// invoiceBalance(), GST, or any "collected" figure — not by discipline, but
// because recompute_invoice_paid_for() and isCashRow() both filter on
// kind='payment' and a tip is kind='tip'. See the migration for the mechanism.
//
// EVERYTHING HERE IS PURE. No queries, no I/O, no Stripe. That is what lets the
// guard exercise the money boundaries exhaustively without credentials.
//
// ── MINOR UNITS ──────────────────────────────────────────────────────────────
// The rest of the codebase carries money as `numeric` DOLLARS and converts to
// cents only at the Stripe boundary. A tip is the first customer-CHOSEN amount
// in the system, so it is the first amount an attacker controls: it is carried
// as INTEGER CENTS from the moment it leaves the browser until it is written to
// the ledger. Integers cannot accumulate a float error, cannot be 0.1+0.2, and
// make "is this a whole number of cents?" a validation rather than a hope.

import type { FeeSettings } from '@/lib/invoiceTotals'

const round2 = (n: number) => Math.round(n * 100) / 100

/**
 * The absolute ceiling on one tip, in cents. $1,000.
 *
 * Two different attacks meet here and one honest case has to survive them:
 *  • the integer-overflow / absurd-value attack (`tipCents: 9e18`), which the
 *    integer + finite checks already reject, but which must ALSO be bounded so a
 *    merely-large value (`50000000` = $500,000) cannot reach Stripe; and
 *  • the fat-finger — a customer typing 5000 meaning $50.00.
 *
 * A percentage cap alone is not enough (100% of a $40,000 commercial invoice is
 * still $40,000), and an absolute cap alone is not enough (a $1,000 tip on a $60
 * invoice is not a tip). Both apply — see resolveTipCents.
 */
export const TIP_MAX_CENTS = 100_000

/**
 * The proportional ceiling: a tip may not exceed the amount being charged.
 *
 * 100% is deliberately generous — this is an abuse bound, not a taste bound. It
 * exists so the tip can never be the majority of a charge the customer believes
 * is an invoice payment, which is the shape of both a mis-typed amount and a
 * social-engineering attempt against the business's Stripe account.
 */
export const TIP_MAX_PERCENT_OF_CHARGE = 100

/** At most three presets — more is a menu, and a menu is pressure. */
export const TIP_MAX_PRESETS = 3

/** What ships when an owner turns tips on without choosing percentages. */
export const TIP_DEFAULT_PRESETS: readonly number[] = Object.freeze([10, 15, 20])

// ── Owner configuration ──────────────────────────────────────────────────────

/** The three business_settings columns this engine reads. Nothing else. */
export interface TipSettings {
  tips_enabled?: boolean | null
  tip_presets?: number[] | null
  tip_custom_enabled?: boolean | null
}

export interface TipConfig {
  /** Offer a tip at all. False here means the customer never sees the section. */
  enabled: boolean
  /** Whole percentages, ascending, de-duplicated, at most TIP_MAX_PRESETS. */
  presets: number[]
  /** May the customer name their own amount. */
  customAllowed: boolean
}

export const TIPS_OFF: TipConfig = Object.freeze({ enabled: false, presets: [], customAllowed: false })

/**
 * Normalise the owner's stored configuration into what a surface may render.
 *
 * Defensive on every field rather than trusting the column, because these values
 * reach a customer-facing page and a Stripe charge. A row written before this
 * migration reads `undefined` and lands on tips-off — which is the correct
 * answer for every existing business, none of which asked for tips.
 *
 * A config with NO presets and NO custom field is not a tip UI, it is an empty
 * box: it collapses to disabled, so an owner cannot half-enable tips by clearing
 * the presets and never notice the section is still on the customer's invoice.
 */
export function tipConfig(settings: TipSettings | null | undefined): TipConfig {
  if (!settings?.tips_enabled) return TIPS_OFF
  const raw = Array.isArray(settings.tip_presets) ? settings.tip_presets : []
  const presets = [...new Set(
    raw.map(p => Math.round(Number(p)))
       .filter(p => Number.isFinite(p) && p > 0 && p <= 100),
  )].sort((a, b) => a - b).slice(0, TIP_MAX_PRESETS)
  const customAllowed = settings.tip_custom_enabled !== false
  if (presets.length === 0 && !customAllowed) return TIPS_OFF
  return { enabled: true, presets, customAllowed }
}

// ── Presets → money ──────────────────────────────────────────────────────────

export interface TipPreset {
  /** The stored percentage, for the label ("15%"). */
  percent: number
  /** What that percentage is of the amount being charged, in cents. */
  cents: number
}

/**
 * The dollar figure behind each preset chip, derived from the amount ACTUALLY
 * being charged — never from the invoice total, and never stored.
 *
 * Rounded to the cent ONCE, here, so the chip's label, the amount posted back,
 * and the amount the server re-derives are the same integer. A preset that
 * rounds to zero cents (a percentage of a near-zero charge) is dropped rather
 * than rendered as "10% — $0.00".
 */
export function tipPresetsFor(chargeCents: number, presets: readonly number[]): TipPreset[] {
  const base = Math.round(Number(chargeCents) || 0)
  if (!Number.isFinite(base) || base <= 0) return []
  return presets
    .map(percent => ({ percent, cents: Math.round(base * percent / 100) }))
    .filter(p => p.cents > 0)
}

// ── Server-side derivation ───────────────────────────────────────────────────

export type TipRejection =
  | 'not-an-integer'      // fractional cents, NaN, Infinity, a string that isn't a number
  | 'negative'            // a tip that takes money back is not a tip
  | 'tips-disabled'       // the owner has not enabled tips (or capability is off)
  | 'not-tippable'        // this charge is a deposit / part payment — see below
  | 'over-maximum'        // beyond the absolute or proportional ceiling

export interface TipResolution {
  /** The tip to actually charge, in cents. Always a non-negative integer. */
  cents: number
  /** Set when a REQUESTED tip was refused. `cents` is 0 whenever this is set. */
  rejected?: TipRejection
}

/**
 * THE server's answer to "how much tip is this charge carrying?".
 *
 * The browser may express INTENT — "15%", "$25" — and nothing more. This
 * function is the only thing that turns intent into money, and every door must
 * call it, because the browser is not trusted with:
 *   • whether this business takes tips at all,
 *   • whether this particular charge may carry one,
 *   • the ceiling,
 *   • or even that the number is a number.
 *
 * It deliberately REJECTS rather than silently clamping a requested tip down to
 * the ceiling. A customer who asked for a $5,000 tip and is charged $1,000
 * without being told has been overcharged by $1,000 from their point of view;
 * the door turns a rejection into a 400 and the portal re-renders.
 *
 * `tippable` is the caller's answer to "is this charge the kind that may carry a
 * tip?" — in v1 that is `!isDeposit` (see the note in /api/portal/pay). Passed
 * in rather than derived here so this file never needs to know about deposits.
 */
export function resolveTipCents(
  requested: unknown,
  opts: { chargeCents: number; config: TipConfig; tippable: boolean },
): TipResolution {
  // Absent / null / '' is "no tip", not an error — the overwhelming majority of
  // payments, and the shape every existing caller already sends.
  if (requested === undefined || requested === null || requested === '') return { cents: 0 }

  // Accept only a number or a numeric string; reject everything else BEFORE
  // looking at the value, so `true`, `[]`, `{}` and `'15%'` cannot coerce.
  const n = typeof requested === 'number' ? requested
    : typeof requested === 'string' && /^-?\d+$/.test(requested.trim()) ? Number(requested.trim())
    : NaN
  // Integer cents only. This is where 0.1+0.2, 57500.000000001, 1e21, NaN and
  // Infinity all die — a fractional cent cannot be charged, so it is not a
  // rounding question, it is a malformed request.
  if (!Number.isFinite(n) || !Number.isSafeInteger(n)) return { cents: 0, rejected: 'not-an-integer' }
  if (n < 0) return { cents: 0, rejected: 'negative' }
  if (n === 0) return { cents: 0 }

  // Order matters: a business that does not take tips must not be told what its
  // ceiling would have been.
  if (!opts.config.enabled) return { cents: 0, rejected: 'tips-disabled' }
  if (!opts.tippable) return { cents: 0, rejected: 'not-tippable' }

  const base = Math.round(Number(opts.chargeCents) || 0)
  if (!Number.isFinite(base) || base <= 0) return { cents: 0, rejected: 'not-tippable' }
  const ceiling = Math.min(TIP_MAX_CENTS, Math.round(base * TIP_MAX_PERCENT_OF_CHARGE / 100))
  if (n > ceiling) return { cents: 0, rejected: 'over-maximum' }

  return { cents: n }
}

/** The one honest sentence per rejection. Fixed copy — never a server string echoed to the portal. */
export function tipRejectionMessage(r: TipRejection, chargeCents: number): string {
  switch (r) {
    case 'over-maximum': {
      const ceiling = Math.min(TIP_MAX_CENTS, Math.max(0, Math.round(chargeCents)))
      return `A tip can’t be more than ${formatCents(ceiling)} on this payment. Please enter a smaller amount.`
    }
    case 'negative':
    case 'not-an-integer':
      return 'That tip amount isn’t valid. Please enter a whole dollar-and-cents amount.'
    case 'tips-disabled':
    case 'not-tippable':
      return 'Tips aren’t available on this payment.'
  }
}

// ── The settled charge ───────────────────────────────────────────────────────

export interface GrossSplit {
  /** Applied to the invoice. The ONLY half the recompute trigger will ever see. */
  invoiceCents: number
  /** The gratuity. Recorded as its own kind='tip' ledger row. */
  tipCents: number
}

/**
 * Split a settled Stripe charge back into its two halves.
 *
 * The webhook knows the GROSS (Stripe's amount_total) and the tip we DECLARED
 * when we built the session (session metadata we wrote server-side). This is the
 * arithmetic that turns those into ledger rows.
 *
 * Clamped in the safe direction on purpose. If the declared tip were ever larger
 * than the gross — a truncated metadata value, a session mutated out from under
 * us, a bug — an unclamped subtraction would record a NEGATIVE invoice payment,
 * which the recompute trigger would faithfully turn into a re-opened balance and
 * the dunning chaser would start texting a customer who just paid. Clamping
 * makes the worst case "the whole charge was recorded as a tip", which is
 * visible, reversible, and chases nobody.
 *
 * The invoice half is therefore always ≥ 0 and the two halves always sum to the
 * gross exactly — no cent is created and none is lost.
 */
export function splitGrossCents(grossCents: number, declaredTipCents: unknown): GrossSplit {
  const gross = Math.max(0, Math.round(Number(grossCents) || 0))
  const raw = Math.round(Number(declaredTipCents) || 0)
  const tip = Number.isFinite(raw) && raw > 0 ? Math.min(raw, gross) : 0
  return { invoiceCents: gross - tip, tipCents: tip }
}

// ── Refunds ──────────────────────────────────────────────────────────────────

export interface RefundApportionment {
  /** Additional dollars to reverse against the INVOICE, this delivery. */
  invoiceDelta: number
  /** Additional dollars to reverse against the TIP, this delivery. */
  tipDelta: number
}

/**
 * Split a Stripe refund between the invoice payment and the tip.
 *
 * ── WHY THIS IS NOT OPTIONAL ────────────────────────────────────────────────
 * Stripe refunds a CHARGE, and the charge is the gross. Without this, a full
 * refund of a $575 charge books −$575 against an invoice that only ever received
 * +$500: amount_paid goes to −$75, the trigger re-derives the status to 'unpaid',
 * the balance reads $575 on a $500 invoice, and — because the due date is long
 * past — the payment chaser starts texting the customer for money they were just
 * given back. That is a live money bug, not a reporting nit.
 *
 * ── WHY TIP-FIRST ──────────────────────────────────────────────────────────
 * EdgeHQ never calls Stripe's refund API (owners refund in the Stripe dashboard),
 * so no refund object we could attach intent to exists, and Stripe tells us only
 * a cumulative amount. On a FULL refund every ordering gives the same answer.
 * They differ only on a PARTIAL, and the failure modes are asymmetric:
 *
 *   tip-first guesses wrong  → a tip is reversed that the owner meant to keep.
 *                              Visible in the ledger, nobody is chased.
 *   invoice-first guesses wrong → the invoice balance re-opens past its due date,
 *                              dueForAutoReminder goes true, and the chaser texts
 *                              a customer who is square. This is precisely the
 *                              outcome the dispute branch refuses to risk.
 *
 * So the cheap wrong answer is preferred to the expensive one, and the owner's
 * refund notification NAMES the split so a wrong guess is correctable.
 *
 * ── IDEMPOTENCY ────────────────────────────────────────────────────────────
 * Stripe re-delivers. `refundedTotal` is Stripe's CUMULATIVE figure for the
 * charge, and both `alreadyInvoice` and `alreadyTip` are what our own ledger has
 * already reversed. A replay computes deltas of zero and writes nothing.
 *
 * All figures are DOLLARS here (the ledger's unit), unlike the cents used at the
 * Stripe session boundary — this function reads rows, not Stripe payloads.
 */
export function apportionRefund(p: {
  /** Stripe's cumulative amount_refunded for this charge, in dollars. */
  refundedTotal: number
  /** Dollars already reversed against the invoice by earlier deliveries. */
  alreadyInvoice: number
  /** Dollars already reversed against the tip by earlier deliveries. */
  alreadyTip: number
  /** The tip originally recorded for this charge, in dollars. */
  tipRecorded: number
}): RefundApportionment {
  const refunded = Math.max(0, round2(Number(p.refundedTotal) || 0))
  const doneInvoice = Math.max(0, round2(Number(p.alreadyInvoice) || 0))
  const doneTip = Math.max(0, round2(Number(p.alreadyTip) || 0))
  const tipRecorded = Math.max(0, round2(Number(p.tipRecorded) || 0))

  // What this delivery newly has to place, across both legs.
  const outstanding = round2(refunded - doneInvoice - doneTip)
  if (outstanding <= 0.005) return { invoiceDelta: 0, tipDelta: 0 }

  // Tip first, but never more tip than was actually collected.
  const tipRemaining = Math.max(0, round2(tipRecorded - doneTip))
  const tipDelta = round2(Math.min(outstanding, tipRemaining))
  const invoiceDelta = round2(outstanding - tipDelta)
  return { invoiceDelta, tipDelta }
}

// ── Row identity ─────────────────────────────────────────────────────────────

/**
 * Is this ledger row a gratuity?
 *
 * The mirror of isCashRow (lib/payments/ledger): that one answers "did cash
 * arrive against an invoice", this one answers "is this a tip". Every tip figure
 * asks THIS, so a report and a tile cannot mean different things by "tips", and
 * neither one can accidentally sweep in a payment.
 *
 * Signed on purpose — a reversed tip is a negative row of the same kind, so
 * summing what this accepts nets refunds out with no special handling, exactly
 * as collectedBetween does for payments.
 */
export function isTipRow(r: { kind?: string | null; status?: string | null }): boolean {
  return r.kind === 'tip' && r.status === 'paid'
}

/** Signed tip dollars this row moved; 0 for everything that is not a tip. */
export function tipAmountOf(r: { kind?: string | null; status?: string | null; amount?: number | null }): number {
  return isTipRow(r) ? round2(Number(r.amount) || 0) : 0
}

export interface TipSummary {
  /** Tips received (positive rows). */
  received: number
  /** Tips handed back (negative rows), as a positive number. */
  refunded: number
  /** received − refunded. Ties to a signed sum over the same rows. */
  net: number
  /** Count of tip-IN events. A reversal is not "a tip received". */
  count: number
}

/**
 * Tips over any slice of the ledger. Deliberately NOT folded into
 * summarizeTransactions: that function answers "how much cash came in", and the
 * whole point of this feature is that a tip is reported BESIDE that figure, never
 * inside it. Two functions, two questions, no figure that means both.
 */
export function summarizeTips(rows: { kind?: string | null; status?: string | null; amount?: number | null }[]): TipSummary {
  let received = 0, refunded = 0, count = 0
  for (const r of rows) {
    if (!isTipRow(r)) continue
    const amt = Number(r.amount) || 0
    if (amt >= 0) { received += amt; count++ } else { refunded += Math.abs(amt) }
  }
  return { received: round2(received), refunded: round2(refunded), net: round2(received - refunded), count }
}

// ── Stripe-boundary identifiers ──────────────────────────────────────────────
// The `payments.stripe_session_id` UNIQUE constraint is the ONLY durable
// idempotency guarantee in the payment path — there is no event-id table, and
// Stripe's event.id is never read. A second ledger row from ONE Stripe object
// therefore needs its own key in that namespace. The established convention is a
// prefix: `credit:<session>`, `autopay:<invoice>`, `refund:<charge>:<cents>`.
// These two extend it and provably cannot collide with any of them.

/** The tip leg of a Checkout session. */
export const tipSessionKey = (stripeSessionId: string) => `tip:${stripeSessionId}`

/**
 * The tip leg of a refund, keyed on the CUMULATIVE refunded cents exactly as the
 * invoice leg is — so a re-delivery of the same cumulative figure conflicts and
 * no-ops, while a genuinely larger refund gets a new key and lands.
 */
export const tipRefundKey = (chargeId: string, cumulativeRefundedCents: number) =>
  `refund-tip:${chargeId}:${Math.round(cumulativeRefundedCents)}`

// ── Display ──────────────────────────────────────────────────────────────────

/** Cents → the app's money string. Matches the en-CA/CAD formatting used throughout. */
export function formatCents(cents: number): string {
  return new Intl.NumberFormat('en-CA', { style: 'currency', currency: 'CAD' })
    .format((Math.round(Number(cents) || 0)) / 100)
}

/**
 * Parse a customer-typed tip ("25", "25.5", "$25.50", " 25 ") into integer cents.
 *
 * Returns null for anything that is not a plain non-negative money amount — no
 * exponents, no negatives, no more than two decimal places, no thousands
 * separators. The server re-validates regardless; this exists so the portal can
 * disable Continue on a bad value instead of round-tripping to a 400.
 */
export function parseTipInputToCents(raw: string): number | null {
  const s = String(raw ?? '').trim().replace(/^\$/, '').trim()
  if (!s) return null
  if (!/^\d+(\.\d{1,2})?$/.test(s)) return null
  const cents = Math.round(Number(s) * 100)
  if (!Number.isSafeInteger(cents) || cents < 0) return null
  return cents
}

// ── The invoice is untouched, and here is the proof ──────────────────────────

/**
 * The customer-facing breakdown of what is about to be charged.
 *
 * Exists so exactly one expression produces the figures on the portal, in the
 * receipt, and in the guard — and so the invariant is stated in code rather than
 * asserted in prose: `invoiceCents` is the charge the payment engine derived, and
 * adding a tip changes only `totalCents`.
 *
 * `settings` is accepted and ignored on the invoice half deliberately: the ask
 * has already been derived by depositChargeAmount from invoiceBalance, and
 * re-deriving it here would be a second definition of what is owed.
 */
export function tipCheckoutBreakdown(
  invoiceCents: number,
  tipCents: number,
  _settings?: FeeSettings | null,
): { invoiceCents: number; tipCents: number; totalCents: number } {
  const inv = Math.max(0, Math.round(Number(invoiceCents) || 0))
  const tip = Math.max(0, Math.round(Number(tipCents) || 0))
  return { invoiceCents: inv, tipCents: tip, totalCents: inv + tip }
}
