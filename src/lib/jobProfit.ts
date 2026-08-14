// ── Job profit — did this work make money? ────────────────────────────────────
// The last question in the chain. Session 22 asked "what did we leave behind",
// Session 31 asked "what did it cost", Session 47 asked "how many days did it
// take", Session 48 asked "how long should it have taken". This module asks the
// one an owner actually loses sleep over — and refuses to answer it when the
// data cannot.
//
// Pure arithmetic over rows that already exist. No I/O, no React, no supabase —
// lib/jobProfitData is the only place that knows which tables these come from.
//
// ══ SIX FIGURES, SIX DIFFERENT FACTS ═════════════════════════════════════════
// The single largest way a job-profit screen lies is by blurring these into "the
// money". They are kept apart here, named apart, and no arithmetic crosses
// between them except the one crossing that is defined below (margin):
//
//   ACCEPTED QUOTE    what the customer originally said yes to, from the quote
//                     this visit came from. Never rewritten. Absent for a job
//                     someone booked directly, which is a FACT about the job and
//                     not a zero.
//   AUTHORIZED VALUE  what may be billed for this visit NOW: the base visit price
//                     plus approved change money plus owner-added extras plus a
//                     separately-billed travel charge. A PROMISE. It diverges from
//                     the accepted quote when scope grew or the price was reset,
//                     and that divergence is reported rather than smoothed away.
//   INVOICED VALUE    what an invoice actually bills, net of any discount and
//                     excluding sales tax. A BILL. It can be lower than
//                     authorized (a discount), and it does not exist at all
//                     until somebody invoices the visit.
//   COLLECTED CASH    what arrived, minus refunds. Not revenue: for a registrant
//                     it contains tax held for the CRA, and an invoice settled
//                     from a customer's earlier credit collects no new cash.
//   RECORDED COST     lib/jobCost's answer, with its completeness contract
//                     intact. Never recomputed here.
//   KNOWN MARGIN      authorized − recorded cost, and ONLY when the cost is
//                     complete enough for that subtraction to mean anything.
//
// ⛔ CASH IS NEVER REVENUE AND NEVER TOUCHES MARGIN. A visit invoiced for $2,400
// with $600 collected has not earned $600 — it has earned $2,400 and been paid a
// quarter of it. Deriving margin from cash would make every unpaid job look like
// a catastrophe and every deposit-heavy job look like a windfall, and it would
// re-state the same job's margin every time a cheque cleared.
//
// ══ CHANGE ORDERS: APPROVED MONEY ONLY, AND COUNTED ONCE ═════════════════════
// Session 51 (`lib/changeOrders`) is THE change-order engine and owns the
// breakdown an owner and a customer read. This module does not re-implement it —
// it consumes the same rows, under two rules:
//
// 1. APPROVAL IS WHAT MINTS THE MONEY. An approved change order writes a
//    `job_line_items` row carrying `change_order_id`; a pending or declined one
//    has NO row at all. So authorized value counts line items, and a change
//    nobody said yes to cannot reach it — not because a predicate excludes it,
//    but because there is nothing there to add. That is the structural version of
//    the rule and it cannot be got wrong by a later edit.
// 2. PENDING AND DECLINED ARE CONTEXT, NEVER ADDENDS. When change-order rows are
//    handed in, their pending and declined amounts are REPORTED (an owner should
//    see that $800 is sitting unanswered) and never summed into anything. The
//    guard mutation-tests exactly this: adding pending or declined money to the
//    authorized figure must fail the suite.
//
// ⚠️ `change_orders` and `job_line_items.change_order_id` exist in PRODUCTION but
// not in this repository's baseline (Session 51 is pushed, not merged). So the
// loader selects `job_line_items.*` rather than naming the column — present, it is
// read; absent, it is `undefined` and every visit reads as having no change money.
// It must NOT query the `change_orders` table until that migration is on main: a
// database rebuilt from the baseline would 404 and blank every figure on this
// screen. See [prod-schema-exceeds-main].
//
// ══ WHY MARGIN IS MEASURED AGAINST THE AUTHORIZED PRICE ══════════════════════
// One basis, named on screen, so the number cannot quietly change meaning:
// `KnownMargin.basis` is 'authorized' and the surface says so. The authorized
// price is what the business was told the work is worth, it exists for every
// priced visit (invoiced or not), and it is the figure the owner set out to earn.
// The invoiced and collected figures are reported ALONGSIDE, with their variance
// from authorized stated as a fact — so a discounted invoice or an unpaid bill is
// visible rather than silently folded into a margin.
//
// ══ THE HONESTY RULES ════════════════════════════════════════════════════════
// 1. UNKNOWN LABOUR IS NOT $0 OF LABOUR. Inherited whole from lib/jobCost and
//    re-asserted at the margin gate: a margin is produced only when
//    `cost.comparableToRevenue` — completed AND all three cost categories known.
//    Anything less says "Margin incomplete — labour cost not recorded", which is
//    the true sentence. Both technicians in production have no wage recorded, so
//    on the day this shipped that sentence was the answer for the entire book.
// 2. AN UNPRICED VISIT HAS NO REVENUE, NOT $0 OF REVENUE. jobVisitValue returns
//    a bare 0 for a visit with no price and no quote — correct for summing a
//    day's booked value, a lie here, because 0 revenue against a real cost
//    reports a −100% margin on a visit nobody has priced yet. A non-positive
//    authorized value is `unknown`, and that is also exactly where lib/margin
//    already refuses to divide.
// 3. A FAILED READ IS NOT A ZERO. `readFailed` makes every figure unknown, so an
//    outage cannot render as "this job made no money" or "nothing was collected".
// 4. WORK STILL RUNNING IS NOT A FINISHED JOB. A running clock means the visit is
//    still consuming labour and materials, so no margin is offered, and `final`
//    is false whenever anything about the record can still move.
// 5. NOTHING HERE INVENTS A COST. No estimate, no crew_cost_per_hour, no quote
//    material line, no template. If a cost was not recorded, it is missing —
//    which is a fact worth showing, and the only signal that gets an owner to
//    record it.
//
// ══ WHAT THIS IS NOT ═════════════════════════════════════════════════════════
// Not bookkeeping, not a P&L, not tax. It allocates no overhead, no equipment
// depreciation, no drive time and no owner's wage, and it says so on screen —
// `KnownMargin` is a GROSS margin on direct recorded cost. lib/accounting owns
// the business-wide picture and keeps its cash-basis rules; this reports one
// visit. Also not lib/profitability, which grades ROUTES from an estimated,
// LOADED crew rate: that answers "is this drive worth doing" for every job,
// this answers "did this one prove out". The two are never summed — the loaded
// rate already contains fuel, so adding a receipted fuel bill double-counts it.

import type { Invoice, Payment, WorkSession } from '@/types'
import { marginPct, unitProfit, marginTone, type MarginTone } from '@/lib/margin'
import { joinWords, type CostCategory, type JobActualCost } from '@/lib/jobCost'
import { jobVisitValue, quoteVisitAmount, buildInvoiceLineItems } from '@/lib/visitValue'
import { invoiceTotals, type FeeSettings } from '@/lib/invoiceTotals'
import { invoiceBalance } from '@/lib/payments/ledger'
import { summarizeTransactions } from '@/lib/payments/analytics'
import { sessionTotals } from '@/lib/workSession'

const round2 = (n: number) => Math.round(n * 100) / 100

// ── Authorized value ─────────────────────────────────────────────────────────

/** Why there is no authorized figure. Never collapsed into a zero. */
export type RevenueUnknownReason =
  /** Nothing prices this visit: no job price, no quote price. */
  | 'no_price'
  /** The rows behind it could not be read. */
  | 'read_failed'

export interface AuthorizedValue {
  state: 'known' | 'unknown'
  /** Non-null EXACTLY when state is 'known'. Excludes sales tax. */
  amount: number | null
  /** Null EXACTLY when state is 'known'. */
  reason: RevenueUnknownReason | null
  /** The base service value inside `amount`. */
  base: number
  /** Every priced extra inside `amount` — approved changes AND owner-added. */
  extras: number
  extrasCount: number
  /**
   * The part of `extras` that came from an APPROVED change order (the line item
   * carries `change_order_id`). Session 51's `authorizedValue.authorized` is
   * `base + approvedChanges`; this module's `amount` is that plus `ownerExtras`
   * plus `travel` — S51 calls the same figure `billable`. One set of rows, two
   * names for two questions, and both derivable from these fields.
   */
  approvedChanges: number
  approvedChangeCount: number
  /** Priced add-ons the OWNER put on the visit without asking. Still billable. */
  ownerExtras: number
  /** A separately-billed travel charge inside `amount`. */
  travel: number
  /**
   * Where the base price came from. 'job' = the per-visit manual price, which
   * wins; 'quote' = the originating quote's cadence price; 'none' = neither.
   */
  basis: 'job' | 'quote' | 'none'
}

// ── The accepted quote ───────────────────────────────────────────────────────

export interface AcceptedQuoteValue {
  state: 'known' | 'unknown'
  /** What this visit was worth on the quote the customer accepted. Ex-tax. */
  amount: number | null
  /**
   * 'no_quote' — the visit was booked directly, so there is no accepted price
   * to compare against. A fact about the job, NEVER a $0 agreement.
   */
  reason: 'no_quote' | 'read_failed' | null
}

// ── Change orders: reported, never added ─────────────────────────────────────

export interface ChangeRecord {
  /** Approved change money, from the line items an approval minted. */
  approved: number
  approvedCount: number
  /** Asked for, not yet answered. ⛔ NEVER part of authorized value. */
  pending: number
  pendingCount: number
  /** Said no to. ⛔ NEVER part of anything. */
  declined: number
  declinedCount: number
  /** True when change-order rows were supplied at all (Session 51 on main). */
  read: boolean
}

// ── Invoiced value ───────────────────────────────────────────────────────────

export interface InvoicedValue {
  /**
   * 'issued'    — a live invoice bills this visit.
   * 'draft'     — an invoice exists but has not been sent. Real intent, not yet a bill.
   * 'cancelled' — voided. Bills nothing; the figure it carried is in `voided`.
   * 'none'      — nothing has been invoiced for this visit. A FACT, not an unknown.
   * 'unknown'   — the read failed.
   */
  state: 'issued' | 'draft' | 'cancelled' | 'none' | 'unknown'
  /**
   * `invoices.amount` — the NET subtotal, post-discount and EX-TAX. This is the
   * revenue an invoice bills. Non-null only for 'issued' and 'draft'.
   *
   * ⛔ Never `invoiceTotals().total`: that adds GST, which is a pass-through
   * liability collected for the CRA and is not the business's money. At today's
   * 0% the two are equal, which is exactly why the wrong one would go unnoticed
   * until the day this business registers.
   */
  amount: number | null
  /** What a cancelled invoice used to carry. Reported, never counted as revenue. */
  voided: number | null
  invoiceNumber: string | null
  /** Sales tax added on top of `amount`. 0 for a non-registrant. */
  tax: number
  /** What the customer owes in total: amount + tax. */
  total: number | null
  /** Still outstanding on it (tax-inclusive), from the ledger's own definition. */
  balance: number | null
}

// ── Collected cash ───────────────────────────────────────────────────────────

export interface CollectedCash {
  state: 'known' | 'unknown'
  /**
   * Cash in minus refunds, over this visit's invoice only. Non-null EXACTLY when
   * state is 'known' — and 0 is a real answer here, unlike a cost category: the
   * payment ledger IS the record of money received, so a successful read
   * returning nothing means nothing arrived.
   */
  amount: number | null
  refunded: number
  /** Money-IN events. A refund is not "a payment received". */
  payments: number
  /**
   * Settled from credit the customer handed over earlier (a deposit, an
   * overpayment). Real settlement, but NOT new cash — so it is excluded from
   * `amount` by the ledger's own isCashRow and reported here instead, otherwise
   * a fully-settled invoice would read as "collected $0" with no explanation.
   */
  fromCredit: number
  /** True when `amount` contains sales tax the business only holds. */
  includesTax: boolean
}

// ── Known margin ─────────────────────────────────────────────────────────────

/** Why no margin may be shown. Every one of these is a sentence, not a zero. */
export type MarginBlock =
  /** The rows behind it could not be read. */
  | 'read_failed'
  /** The visit never happened — there is no revenue to compare against. */
  | 'cancelled'
  /** Not finished. More cost is still to come. */
  | 'not_finished'
  /** Somebody is on the clock right now. */
  | 'clock_running'
  /** Nothing prices this visit. */
  | 'no_price'
  /** At least one cost category was never recorded — the production default. */
  | 'cost_incomplete'

export interface KnownMargin {
  state: 'known' | 'blocked'
  /** authorized − recorded cost. Non-null EXACTLY when state is 'known'. */
  profit: number | null
  /** Share of the authorized price kept, 0..100. Negative is a real answer. */
  percent: number | null
  tone: MarginTone
  /** Null EXACTLY when state is 'known'. */
  block: MarginBlock | null
  /** What to print when blocked. Empty string when known. */
  sentence: string
  /** Cost categories with nothing recorded — what would unblock this. */
  missing: CostCategory[]
  /** What we DO know was spent. A floor, never a total. */
  costFloor: number
  /**
   * The revenue this margin is measured against. One value today, and it is a
   * field rather than a comment so a surface can state it and a future basis
   * cannot be introduced silently.
   */
  basis: 'authorized'
}

// ── The work behind it ───────────────────────────────────────────────────────

export interface WorkRecord {
  sessions: number
  /** Distinct days worked. Two sessions in one day are not two days. */
  days: number
  /** Time on site from the sessions. Null when there are none. */
  elapsedMinutes: number | null
  /** Person-minutes: Σ(minutes × workers). Null when there are none. */
  labourMinutes: number | null
  /**
   * Σ session minutes disagrees with `jobs.actual_minutes`. The database enforces
   * equality once a job has sessions, so a mismatch means these are not all the
   * days — the labour picture is incomplete even though the cost may not be.
   */
  disagrees: boolean
  /** Somebody is on the clock right now. */
  clockRunning: boolean
  /** The session read failed. NOT "no sessions were recorded". */
  failed: boolean
}

// ── The review ───────────────────────────────────────────────────────────────

export interface JobProfitReview {
  jobId: string
  /** What the customer originally said yes to. */
  accepted: AcceptedQuoteValue
  authorized: AuthorizedValue
  /** Change money asked for and answered. Context — never an addend. */
  changes: ChangeRecord
  invoiced: InvoicedValue
  collected: CollectedCash
  /** lib/jobCost's answer, unchanged and un-recomputed. */
  cost: JobActualCost
  margin: KnownMargin
  work: WorkRecord
  /**
   * Invoiced minus authorized. Negative = billed less than agreed (a discount);
   * positive = billed more (a hand-edited invoice). Null when either is unknown,
   * because "no variance" and "we cannot tell" are different findings.
   */
  invoicedVariance: number | null
  /**
   * Authorized minus accepted — how far this visit has moved from what the
   * customer originally agreed. Positive = scope grew (approved changes, extras,
   * a higher per-visit price); negative = it was cut or re-priced down. Null when
   * either side is unknown, because a job with no quote has not "grown by its
   * whole value".
   */
  scopeVariance: number | null
  /**
   * Is this the last word? False while the work, the clock, or the session record
   * can still move the answer. A surface must not present a provisional margin as
   * a settled one.
   */
  final: boolean
}

export interface JobProfitInput {
  job: {
    id: string
    status?: string | null
    /** Per-visit manual price. Wins over the quote when positive. */
    price?: number | null
    service_type?: string | null
    /** The anchor visit of a recurring series derives the INITIAL price. */
    is_initial_visit?: boolean | null
    /** Set = a clock is running. Cleared when the clock is banked. */
    started_at?: string | null
    /** THE elapsed total the database keeps equal to Σ session minutes. */
    actual_minutes?: number | null
  }
  /** The cost answer. Passed in, never derived here — one costing engine. */
  cost: JobActualCost
  /** The originating quote: cadence prices + a separately-billed travel fee. */
  quote?: Record<string, unknown> | null
  /** The resolved cadence (lib/visitValue effectiveFreq). Null for one-off work. */
  freq?: string | null
  /**
   * Priced extras on this visit — `job_line_items` rows. `changeOrderId` is set
   * on a row an APPROVED change order minted (Session 51); absent means the owner
   * added it directly. Both bill; only the split differs.
   */
  extras?: { description: string; amount: number; changeOrderId?: string | null }[] | null
  /**
   * Change orders on this visit, when the caller can read them. Their approved
   * money is ALREADY in `extras` (approval mints the line item), so this exists to
   * report what is pending or declined — and those are never added to anything.
   */
  changeOrders?: { status: string; amount: number }[] | null
  /** The invoice for this visit. At most one exists (unique index on job_id). */
  invoice?: InvoiceFacts | null
  /** Ledger rows. Filtered to this invoice below — see TENANCY. */
  payments?: Payment[]
  /** Work sessions for this job. */
  sessions?: WorkSession[]
  /** True when the session read failed, so an outage is not an empty history. */
  sessionsFailed?: boolean
  /** Decides the tax split. Guessing it would move every figure by the tax. */
  settings?: FeeSettings | null
  /** True when ANY query behind these rows errored — honesty rule 3. */
  readFailed?: boolean
}

export type InvoiceFacts = Pick<
  Invoice, 'id' | 'invoice_number' | 'amount' | 'status' | 'discount_type' | 'discount_value'
> & { amount_paid?: number | null }

/**
 * ⭐ THE READ. One visit in, five figures and a margin-or-a-reason out.
 *
 * ══ TENANCY ══════════════════════════════════════════════════════════════════
 * Pure, and holds no idea of who the owner is: it reviews exactly the rows it is
 * handed, so the CALLER must scope every read server-side (lib/jobProfitData
 * does, on every query). Two defences survive a caller that does not:
 *   • payments are filtered to THIS invoice's id, so another invoice's cash can
 *     never land on this visit;
 *   • sessions are filtered to THIS job's id, and lib/jobCost independently
 *     filters expenses and shifts to it.
 * Underneath, `expenses`/`time_entries`/`job_line_items` carry a composite
 * `(job_id, user_id) → jobs(id, user_id)` foreign key (2026-08-11), so a cost
 * row from another business cannot even name this job.
 */
export function reviewJobProfit(input: JobProfitInput): JobProfitReview {
  const { job, cost } = input
  const failed = input.readFailed === true

  const accepted = readAccepted(input, failed)
  const authorized = readAuthorized(input, failed)
  const changes = readChanges(input, failed)
  const invoiced = readInvoiced(input, failed)
  const collected = readCollected(input, failed)
  const work = readWork(input, failed)
  const margin = readMargin({ job, cost, authorized, failed })

  return {
    jobId: job.id,
    accepted,
    authorized,
    changes,
    invoiced,
    collected,
    cost,
    margin,
    work,
    // Stated only when BOTH sides are known: an unknown authorized value and an
    // uninvoiced visit are not "a $0 variance", they are two absences.
    invoicedVariance:
      authorized.amount != null && invoiced.amount != null
        ? round2(invoiced.amount - authorized.amount)
        : null,
    scopeVariance:
      authorized.amount != null && accepted.amount != null
        ? round2(authorized.amount - accepted.amount)
        : null,
    final:
      !failed
      && job.status === 'completed'
      && !job.started_at
      && !work.failed
      && !work.disagrees,
  }
}

// ── The accepted quote ───────────────────────────────────────────────────────

/**
 * What the customer originally said yes to, for THIS visit.
 *
 * Read off the originating quote with the same cadence rule the invoice uses
 * (lib/visitValue), and deliberately IGNORING `jobs.price`: the per-visit price is
 * a later decision by the owner, and folding it in here would make the "original"
 * figure change whenever somebody re-priced the visit — which is the one thing an
 * original is for.
 *
 * A job with no quote has NO accepted price. That is a fact about how the job was
 * booked, not a $0 agreement, and it is the reason `scopeVariance` stays null
 * rather than reporting that scope grew by the entire value of the work.
 */
function readAccepted(input: JobProfitInput, failed: boolean): AcceptedQuoteValue {
  if (failed) return { state: 'unknown', amount: null, reason: 'read_failed' }
  if (!input.quote) return { state: 'unknown', amount: null, reason: 'no_quote' }
  const amount = quoteVisitAmount(
    input.quote,
    input.job.is_initial_visit === true ? null : (input.freq ?? null),
  )
  if (!(amount > 0)) return { state: 'unknown', amount: null, reason: 'no_quote' }
  return { state: 'known', amount: round2(amount), reason: null }
}

// ── Change orders ────────────────────────────────────────────────────────────

/**
 * What was asked for and answered. Approved money is NOT summed here — it is
 * already inside `authorized` via the line item the approval minted, and adding it
 * again is the double count this split exists to make impossible.
 */
function readChanges(input: JobProfitInput, failed: boolean): ChangeRecord {
  const authorizedExtras = (input.extras ?? []).filter(e => e.changeOrderId)
  const empty = {
    approved: round2(authorizedExtras.reduce((s, e) => s + (Number(e.amount) || 0), 0)),
    approvedCount: authorizedExtras.length,
    pending: 0, pendingCount: 0, declined: 0, declinedCount: 0,
  }
  if (failed) return { ...empty, approved: 0, approvedCount: 0, read: false }
  const rows = input.changeOrders
  if (!rows) return { ...empty, read: false }
  const of = (status: string) => rows.filter(r => r.status === status)
  const sum = (list: { amount: number }[]) => round2(list.reduce((s, r) => s + (Number(r.amount) || 0), 0))
  return {
    ...empty,
    // ⛔ Reported. Never added — not to `authorized`, not to `amount`, not to the
    // margin. A customer who has not answered has not agreed to pay.
    pending: sum(of('pending')),
    pendingCount: of('pending').length,
    declined: sum(of('declined')),
    declinedCount: of('declined').length,
    read: true,
  }
}

// ── Authorized ───────────────────────────────────────────────────────────────

/**
 * What the customer agreed we may bill.
 *
 * Deliberately the SAME function the invoice draft is built from
 * (buildInvoiceLineItems), so authorized and invoiced can only diverge for a
 * recorded reason. The split is read back off the line kinds rather than
 * re-summed, for the same reason.
 */
function readAuthorized(input: JobProfitInput, failed: boolean): AuthorizedValue {
  const empty = {
    base: 0, extras: 0, extrasCount: 0, travel: 0,
    approvedChanges: 0, approvedChangeCount: 0, ownerExtras: 0,
  }
  if (failed) {
    return { state: 'unknown', amount: null, reason: 'read_failed', ...empty, basis: 'none' }
  }

  const { job } = input
  const freq = input.freq ?? null
  const base = jobVisitValue(job.price, input.quote, freq, job.is_initial_visit === true)
  const { lineItems, total } = buildInvoiceLineItems({
    serviceType: job.service_type ?? null,
    baseAmount: base,
    freq,
    isInitial: job.is_initial_visit === true,
    addons: input.extras ?? null,
    quote: input.quote ?? null,
  })

  const sumOf = (kind: string) =>
    lineItems.filter(l => l.kind === kind).reduce((s, l) => s + (Number(l.amount) || 0), 0)
  // Which extras came from an approved change order. Rounded the same way
  // buildInvoiceLineItems rounds them, so `approvedChanges + ownerExtras` is
  // exactly `extras` and the split can never fail to reconcile.
  const fromChange = (input.extras ?? []).filter(e => e.changeOrderId)
  const approvedChanges = fromChange.reduce((s, e) => s + Math.round(Number(e.amount) || 0), 0)
  const extras = sumOf('addon')
  const split = {
    base: sumOf('service'),
    extras,
    extrasCount: lineItems.filter(l => l.kind === 'addon').length,
    approvedChanges,
    approvedChangeCount: fromChange.length,
    ownerExtras: round2(extras - approvedChanges),
    travel: sumOf('travel'),
  }

  const jobPriced = Number(job.price) > 0
  // Honesty rule 2: a non-positive total is nothing priced, not $0 authorized —
  // and it is precisely where lib/margin already refuses to divide.
  if (!(total > 0)) {
    return { state: 'unknown', amount: null, reason: 'no_price', ...split, basis: 'none' }
  }
  return {
    state: 'known',
    amount: round2(total),
    reason: null,
    ...split,
    basis: jobPriced ? 'job' : split.base > 0 ? 'quote' : 'none',
  }
}

// ── Invoiced ─────────────────────────────────────────────────────────────────

function readInvoiced(input: JobProfitInput, failed: boolean): InvoicedValue {
  const none = (state: InvoicedValue['state']): InvoicedValue => ({
    state, amount: null, voided: null, invoiceNumber: null, tax: 0, total: null, balance: null,
  })
  if (failed) return none('unknown')
  const inv = input.invoice
  if (!inv) return none('none')

  const totals = invoiceTotals(inv.amount, input.settings, {
    type: inv.discount_type, value: inv.discount_value,
  })

  // A cancelled invoice bills nothing. Its figure is REPORTED (an owner looking
  // at INV-0007 in the invoice list must be able to see why it is not here)
  // but it is never revenue, and it carries no balance worth collecting — the
  // invoices lane owns that question, and it is not this one.
  if (inv.status === 'cancelled') {
    return {
      ...none('cancelled'),
      voided: totals.discountedSubtotal,
      invoiceNumber: inv.invoice_number ?? null,
    }
  }

  const balance = invoiceBalance(
    { amount: inv.amount, amount_paid: inv.amount_paid ?? 0, discount_type: inv.discount_type, discount_value: inv.discount_value },
    input.settings,
  ).balance

  return {
    state: inv.status === 'draft' ? 'draft' : 'issued',
    // The NET subtotal. Never `.total` — see the field's own note.
    amount: totals.discountedSubtotal,
    voided: null,
    invoiceNumber: inv.invoice_number ?? null,
    tax: totals.gstAmount,
    total: totals.total,
    balance,
  }
}

// ── Collected ────────────────────────────────────────────────────────────────

function readCollected(input: JobProfitInput, failed: boolean): CollectedCash {
  const gstPercent = Number(input.settings?.gst_percent) || 0
  if (failed) {
    return { state: 'unknown', amount: null, refunded: 0, payments: 0, fromCredit: 0, includesTax: gstPercent > 0 }
  }

  const invoiceId = input.invoice?.id ?? null
  // Only this visit's invoice. A caller handing over a customer's whole ledger
  // must not be able to book their other invoices' cash against this job — the
  // same rule lib/jobCost applies to expenses by job_id.
  const rows = (input.payments ?? []).filter(p => invoiceId != null && p.invoice_id === invoiceId)
  // THE money-in engine, asked rather than re-spelled: credit-ledger rows and
  // credit settlements are excluded by isCashRow, so applying a $200 deposit
  // never reads as $200 of new money arriving today.
  const summary = summarizeTransactions(rows)
  const fromCredit = rows
    .filter(p => p.kind === 'payment' && p.status === 'paid' && p.provider === 'credit')
    .reduce((s, p) => s + Math.max(0, Number(p.amount) || 0), 0)

  return {
    state: 'known',
    amount: summary.net,
    refunded: summary.refunded,
    payments: summary.count,
    fromCredit: round2(fromCredit),
    // For a registrant, collected cash contains tax held for the CRA. Stated so
    // a surface cannot present it as though it were all the business's money.
    includesTax: gstPercent > 0,
  }
}

// ── The work ─────────────────────────────────────────────────────────────────

function readWork(input: JobProfitInput, failed: boolean): WorkRecord {
  const clockRunning = !!input.job.started_at
  if (failed || input.sessionsFailed) {
    return {
      sessions: 0, days: 0, elapsedMinutes: null, labourMinutes: null,
      disagrees: false, clockRunning, failed: true,
    }
  }
  // This job's sessions only — the service-role backstop, exactly as Session 48's
  // loader applies it.
  const rows = (input.sessions ?? []).filter(s => s.job_id === input.job.id)
  const totals = sessionTotals(rows)
  const actual = Number(input.job.actual_minutes)
  const hasActual = Number.isFinite(actual) && actual > 0

  return {
    sessions: totals.count,
    days: totals.days,
    elapsedMinutes: totals.count ? totals.elapsedMinutes : null,
    labourMinutes: totals.count ? totals.labourMinutes : null,
    // Only meaningful once sessions exist: a job with none legitimately keeps a
    // legacy total, which the database does not clamp and which is not a
    // disagreement.
    disagrees: totals.count > 0 && hasActual && totals.elapsedMinutes !== actual,
    clockRunning,
    failed: false,
  }
}

// ── The margin gate ──────────────────────────────────────────────────────────

/**
 * The one crossing between revenue and cost, and every guard on it.
 *
 * Order matters: the sentence an owner reads should name the FIRST thing in the
 * way, and "this visit was cancelled" is a better answer than "labour cost not
 * recorded" for a visit that never happened.
 */
function readMargin(p: {
  job: JobProfitInput['job']
  cost: JobActualCost
  authorized: AuthorizedValue
  failed: boolean
}): KnownMargin {
  const missing = p.cost.total.unknownCategories
  const costFloor = p.cost.total.knownAmount

  const block: MarginBlock | null =
    p.failed ? 'read_failed'
    : p.job.status === 'cancelled' ? 'cancelled'
    : p.job.status !== 'completed' ? 'not_finished'
    : p.job.started_at ? 'clock_running'
    : p.authorized.state !== 'known' ? 'no_price'
    // The completeness contract itself: completed AND all three categories known.
    // ⛔ Never "some categories known" — a partial cost against a full price
    // overstates profit by exactly what nobody wrote down.
    : !p.cost.comparableToRevenue ? 'cost_incomplete'
    : null

  if (block) {
    return {
      state: 'blocked', profit: null, percent: null, tone: 'neutral',
      block, sentence: marginSentence(block, missing), missing, costFloor,
      basis: 'authorized',
    }
  }

  // Both non-null by the gate above; margin.ts owns the arithmetic.
  const percent = marginPct(p.authorized.amount, p.cost.total.amount)
  return {
    state: 'known',
    profit: unitProfit(p.authorized.amount, p.cost.total.amount),
    percent,
    tone: marginTone(percent),
    block: null,
    sentence: '',
    missing,
    costFloor,
    basis: 'authorized',
  }
}

// ── Presentation ─────────────────────────────────────────────────────────────
// Shared so every surface words the same absence the same way, and so no
// "unknown" can be formatted into a number.

/**
 * The word for a missing cost category inside a sentence.
 *
 * Deliberately the bare modifier — "labour", not lib/jobCost's CATEGORY_LABEL
 * ("Other costs") — so the noun can be pluralised once at the end:
 * "labour cost not recorded" · "labour and material costs not recorded".
 */
const MISSING_WORD: Record<CostCategory, string> = {
  labour: 'labour',
  materials: 'material',
  other: 'other',
}

export const MARGIN_BLOCK_SENTENCE: Record<Exclude<MarginBlock, 'cost_incomplete'>, string> = {
  read_failed: 'Margin unavailable — this visit’s costs and billing could not be loaded.',
  cancelled: 'This visit was cancelled, so there is no revenue to measure costs against.',
  not_finished: 'Margin comes after the work — this visit is not finished yet.',
  clock_running: 'Somebody is still on the clock, so this visit is still running up cost.',
  no_price: 'Margin incomplete — this visit has no price recorded.',
}

/**
 * ⭐ THE sentence. "Margin incomplete — labour cost not recorded."
 *
 * The whole feature reduces to whether this is said instead of a number being
 * shown. A missing category is not $0 spent in it, so the margin does not exist
 * — and the sentence names what would create it, which is the only way a cost
 * ever gets recorded.
 */
export function marginSentence(block: MarginBlock, missing: CostCategory[]): string {
  if (block !== 'cost_incomplete') return MARGIN_BLOCK_SENTENCE[block]
  const words = missing.map(k => MISSING_WORD[k])
  const noun = words.length === 1 ? 'cost' : 'costs'
  return `Margin incomplete — ${joinWords(words)} ${noun} not recorded.`
}

/** "52% margin" · "—". Never invents a figure. */
export function formatMargin(percent: number | null): string {
  return percent == null ? '—' : `${percent}%`
}

/**
 * The headline. A known margin states both halves of the subtraction, because
 * "52%" alone hides whether it is 52% of $200 or of $20,000.
 */
export function describeProfit(r: JobProfitReview): string {
  if (r.margin.state !== 'known') return r.margin.sentence
  const kept = r.margin.profit ?? 0
  return `Kept $${kept.toFixed(2)} of $${(r.authorized.amount ?? 0).toFixed(2)} — a ${r.margin.percent}% margin`
}

/** The invoiced figure as words, so "nothing billed" can never read as "$0.00". */
export function describeInvoiced(r: JobProfitReview): string {
  switch (r.invoiced.state) {
    case 'unknown': return 'Could not be loaded'
    case 'none': return 'Not invoiced yet'
    case 'cancelled': return 'Cancelled'
    case 'draft': return `${formatMoney(r.invoiced.amount)} (draft)`
    default: return formatMoney(r.invoiced.amount)
  }
}

/**
 * Where the settlement stands, and nothing else — the figures have their own
 * rows. Empty string when there is nothing true to say, never "0 owing".
 */
export function describeSettlement(r: JobProfitReview): string {
  const i = r.invoiced
  if (i.state === 'unknown') return 'Billing could not be loaded.'
  if (i.state === 'none' || i.state === 'cancelled') return ''
  if (r.collected.state === 'unknown') return 'Whether it was paid could not be read.'
  if ((i.balance ?? 0) > 0.005) return `${formatMoney(i.balance)} still owing.`
  if (r.collected.fromCredit > 0.005 && (r.collected.amount ?? 0) <= 0.005) return 'Settled from credit.'
  return 'Paid in full.'
}

const formatMoney = (n: number | null): string => (n == null ? '—' : `$${n.toFixed(2)}`)

/**
 * What the money did after the work, in one line — or nothing, when there is
 * nothing true to say. Never claims a state it has not read. Used where a single
 * cell has to carry the whole billing story (the finished-work table).
 */
export function describeBilling(r: JobProfitReview): string {
  const i = r.invoiced
  if (i.state === 'unknown') return 'Billing could not be loaded.'
  if (i.state === 'none') return 'Not invoiced yet.'
  if (i.state === 'cancelled') {
    return `${i.invoiceNumber ?? 'That invoice'} was cancelled — it bills nothing.`
  }
  const label = i.state === 'draft' ? 'Draft invoice' : 'Invoiced'
  const parts = [`${label} $${(i.amount ?? 0).toFixed(2)}`]
  if (r.collected.state === 'unknown') parts.push('cash unknown')
  else if ((i.balance ?? 0) > 0.005) parts.push(`$${(i.balance as number).toFixed(2)} still owing`)
  else if (r.collected.fromCredit > 0.005 && (r.collected.amount ?? 0) <= 0.005) parts.push('settled from credit')
  else parts.push('paid in full')
  return `${parts.join(' · ')}.`
}

// ── Many visits ──────────────────────────────────────────────────────────────

export interface ProfitRollup {
  /** Visits considered. */
  visits: number
  /** Visits with a real margin — the only ones in the figures below. */
  judgeable: number
  /** Authorized value of the JUDGEABLE visits only. */
  authorized: number
  cost: number
  profit: number
  /** Share of that authorized value kept, 0..100. Null when it billed nothing. */
  percent: number | null
  /** Why the rest could not be judged, commonest first. */
  blockedBy: { block: MarginBlock; count: number }[]
  /** Cash collected across EVERY visit read — reported, never in the margin. */
  collected: number
  /** True when at least one visit's cash could not be read, so `collected` is a floor. */
  collectedPartial: boolean
}

const BLOCK_ORDER: MarginBlock[] =
  ['cost_incomplete', 'no_price', 'not_finished', 'clock_running', 'cancelled', 'read_failed']

/**
 * Roll many reviews into one line.
 *
 * ⭐ ONLY judgeable visits contribute to the aggregate margin — the same rule
 * lib/accounting/jobCosting applies per row, for the same reason. Including a
 * visit with a full price and an unrecorded cost would add revenue and no cost,
 * lifting the blended margin toward 100%: the aggregate version of the exact lie
 * the per-visit gate exists to prevent.
 *
 * `visits` and `judgeable` travel together so a reader always knows the
 * denominator. A 61% margin over 2 of 79 finished visits is arithmetically fine
 * and worthless, and the count is the only thing that says so.
 */
export function rollupProfit(reviews: JobProfitReview[]): ProfitRollup {
  const seen = new Set<string>()
  const unique = reviews.filter(r => {
    if (!r?.jobId || seen.has(r.jobId)) return false
    seen.add(r.jobId)
    return true
  })

  const judgeable = unique.filter(r => r.margin.state === 'known')
  const authorized = round2(judgeable.reduce((s, r) => s + (r.authorized.amount ?? 0), 0))
  const cost = round2(judgeable.reduce((s, r) => s + (r.cost.total.amount ?? 0), 0))

  const counts = new Map<MarginBlock, number>()
  for (const r of unique) {
    if (r.margin.block) counts.set(r.margin.block, (counts.get(r.margin.block) ?? 0) + 1)
  }

  return {
    visits: unique.length,
    judgeable: judgeable.length,
    authorized,
    cost,
    profit: round2(authorized - cost),
    percent: marginPct(authorized, cost),
    blockedBy: BLOCK_ORDER
      .filter(b => (counts.get(b) ?? 0) > 0)
      .map(b => ({ block: b, count: counts.get(b) as number }))
      .sort((a, b) => b.count - a.count),
    collected: round2(unique.reduce((s, r) => s + (r.collected.amount ?? 0), 0)),
    collectedPartial: unique.some(r => r.collected.state === 'unknown'),
  }
}

/** How many finished visits can be judged at all — the number that says whether
 *  any aggregate above is worth reading. Null when nothing is finished. */
export function judgeableShare(rollup: ProfitRollup): number | null {
  if (rollup.visits === 0) return null
  return Math.round((rollup.judgeable / rollup.visits) * 1000) / 10
}
