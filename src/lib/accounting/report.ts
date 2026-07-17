import type { Payment, BusinessSettings, ExpenseWithRelations } from '@/types'
import { summarizeTransactions, cashAmountOf } from '@/lib/payments/analytics'
import { isCashRow } from '@/lib/payments/ledger'
import { invoiceTotals } from '@/lib/invoiceTotals'
import { marginPct } from '@/lib/margin'
import {
  sumExpenses, expenseNet, isOperatingCost, isOwnerDraw, isCapital, isUnpaid,
} from '@/lib/accounting/expenses'
import { inPeriod, monthKey, monthsBetween, clampPeriodToData, type Period } from '@/lib/accounting/period'

// ── THE accounting report engine ─────────────────────────────────────────────
// ONE place combines money IN and money OUT. Both sides come from engines that
// already own their half, and nothing here re-derives either:
//
//   money IN  → summarizeTransactions() (lib/payments/analytics). It alone knows
//               that a credit settlement is not new cash and that a refund is a
//               negative row. Re-summing payments.amount here would let this
//               report disagree with the payments screen about revenue — and the
//               report would be believed.
//   money OUT → sumExpenses() (lib/accounting/expenses), which owns gross/net.
//   GST rate  → invoiceTotals() (lib/invoiceTotals), read through the engine
//               exactly as the reports page does, so gst_percent has one reader.
//
// ══ CASH BASIS, and why ══════════════════════════════════════════════════════
// Every figure here is CASH: money that actually moved, when it moved. Revenue is
// what was COLLECTED (not invoiced), cost is what was SPENT (not accrued).
//
// That is the basis a small operator files on, and the only one this data can
// honestly support: expenses have a `spent_at` and no bill/paid split, so there is
// no accrual to report. The existing Revenue & GST report is ACCRUAL (invoice
// based) and answers a different question — the two are SUPPOSED to differ, and
// `outstanding` below exists so the gap between them is visible rather than a
// discrepancy someone has to discover.
//
// ══ THE GST RULES — both directions, and both easy to get backwards ══════════
// 1. REVENUE (out): GST is charged ON TOP of invoice.amount at charge time
//    (invoiceTotals: total = net + net×gst%), so cash collected from a registrant's
//    customer CONTAINS GST the owner merely holds for the CRA. Revenue must exclude
//    it — GST collected is a liability, not income. We recover it by inverting the
//    ONE existing rule (÷ 1+gst%), never by inventing a second one.
// 2. COST (in): tax paid is only deductible from cost if the owner can RECLAIM it.
//    A GST REGISTRANT reclaims it as an input tax credit → cost is NET.
//    A NON-REGISTRANT cannot → the tax is simply part of what the thing cost →
//    cost is GROSS. Applying the net convention to a non-registrant understates
//    their costs and OVERSTATES their profit — a wrong number, in the flattering
//    direction, which is the kind that gets believed and filed.
//
// Today this business has gst_percent = 0, so both rules are identity and the P&L
// ties exactly to the ledger. They are here so that the day it registers, the
// report is already right instead of quietly wrong.
// ═════════════════════════════════════════════════════════════════════════════

const round2 = (n: number) => Math.round(n * 100) / 100

/**
 * Is this business GST-registered — i.e. can it reclaim the tax it pays?
 *
 * Read through invoiceTotals so gst_percent has ONE reader in the app (the idiom
 * the reports page already uses). Deliberately NOT gstRegistrationNumber(): that
 * gate also demands a gst_number because it decides what PRINTS on an invoice. A
 * registrant who hasn't typed their number in yet still reclaims ITCs, and their
 * P&L must not silently switch to gross costs because of a blank settings field.
 */
export function isGstRegistrant(settings: BusinessSettings | null | undefined): boolean {
  return invoiceTotals(0, settings).gstPercent > 0
}

export function gstPercentOf(settings: BusinessSettings | null | undefined): number {
  return invoiceTotals(0, settings).gstPercent
}

export interface CategorySlice {
  categoryId: string | null
  name: string
  /** Cost as the P&L counts it (net for a registrant, gross otherwise). */
  cost: number
  gross: number
  tax: number
  count: number
  tax_deductible: boolean
  /** Share of total cost, 0..1. */
  share: number
}

export interface VendorSlice {
  vendorId: string | null
  name: string
  cost: number
  gross: number
  count: number
}

export interface MonthSlice {
  key: string
  revenue: number
  cost: number
  profit: number
}

export interface ProfitAndLoss {
  period: Period
  /** Cash collected INCLUDING any GST charged — what hit the bank. */
  cashCollected: number
  /** Money handed back to customers (refunds), as a positive number. */
  refunded: number
  /** GST collected on that cash — a liability held for the CRA, never revenue. 0 when not registered. */
  salesTaxCollected: number
  /** cashCollected − salesTaxCollected. THE top line. */
  revenue: number
  /**
   * OPERATING cost as the P&L counts it: net of reclaimable tax for a registrant,
   * gross otherwise.
   *
   * Excludes three kinds of money that leave the bank but are not costs — unpaid
   * bills (no cash yet), capital purchases (cash became an asset), and owner draws
   * (a distribution of profit, not a cost of earning it). Each exclusion is why
   * this number and `spendGross` are allowed to differ.
   */
  cost: number
  /** ALL gross spend, every kind — what left the bank. Cash flow uses this. */
  spendGross: number
  /** Cash that bought assets. Real money out, never a cost. */
  capitalSpend: number
  /** Profit taken out by the owner. Real money out, never a cost. */
  ownerDraws: number
  /** Tax paid on spend. An input tax credit for a registrant; already inside `cost` otherwise. */
  taxPaid: number
  /** Cost in DEDUCTIBLE categories only — excludes owner draws and personal spend. */
  deductibleCost: number
  /** revenue − cost. */
  profit: number
  /**
   * Share of revenue kept, 0..100 — via marginPct(), the SAME calculator the quote
   * builder and templates editor use. Null when there is no revenue to take a share
   * OF. Percent, not a 0..1 fraction: one margin scale in the app, not two.
   */
  margin: number | null
  registrant: boolean
  gstPercent: number
  expenseCount: number
  paymentCount: number
  byCategory: CategorySlice[]
  byVendor: VendorSlice[]
  byMonth: MonthSlice[]
  /** Rows with no category — the reason a P&L has an "Uncategorised" line to fix. */
  uncategorisedCount: number
  /**
   * Cash that has no `paid_at` and therefore belongs to NO period — it cannot appear
   * in this or any other report.
   *
   * `payments.paid_at` is nullable, so a row can be cash and undatable. Filtering by
   * date would drop it silently: revenue would simply be lower, with nothing on
   * screen to say why, and it would reconcile against nothing. Reported instead of
   * dropped — this is 0 in production today, and the point is that if it ever isn't,
   * someone finds out from the report rather than from the bank.
   */
  undatedCash: number
  undatedCashCount: number
}

export interface CashFlow {
  period: Period
  /** Gross money in — ties to the bank, GST included. */
  inflow: number
  /** Gross money out — ties to the bank, tax included. */
  outflow: number
  /** inflow − outflow. The change in the bank balance over the period. */
  net: number
  byMonth: { key: string; inflow: number; outflow: number; net: number }[]
}

export interface AccountingInput {
  payments: Payment[]
  expenses: ExpenseWithRelations[]
  settings: BusinessSettings | null | undefined
  period: Period
}

/**
 * What a row of expense COSTS the P&L.
 *
 * The single branch the whole GST-in rule reduces to. Exported because job costing
 * asks the same question and must get the same answer.
 */
export function expenseCost(e: ExpenseWithRelations, registrant: boolean): number {
  return registrant ? expenseNet(e) : round2(Number(e.amount) || 0)
}

/**
 * Filter to the period FIRST, then sum — using each side's own date field.
 * Money in is dated by `paid_at` (when the cash arrived), money out by `spent_at`.
 * Using created_at for either would date a backfilled receipt to the day it was
 * typed, which silently moves cost between tax years.
 */
export function paymentsInPeriod(payments: Payment[], period: Period): Payment[] {
  return payments.filter(p => inPeriod(p.paid_at, period))
}

/**
 * Expenses whose CASH moved in the period.
 *
 * `inPeriod` is false for a null `spent_at`, so unpaid bills fall out here — which
 * is exactly right for a cash-basis report and is why A/P never leaks into cost.
 * (Do NOT hand-roll `e.spent_at >= from` instead: JS compares `null` numerically,
 * so both bounds go false and an unpaid bill silently lands in EVERY period.)
 */
export function expensesInPeriod(expenses: ExpenseWithRelations[], period: Period): ExpenseWithRelations[] {
  return expenses.filter(e => inPeriod(e.spent_at, period))
}

/** Bills INCURRED in the period, paid or not — the accrual view, for A/P surfaces. */
export function expensesBilledInPeriod(expenses: ExpenseWithRelations[], period: Period): ExpenseWithRelations[] {
  return expenses.filter(e => inPeriod(e.bill_date, period))
}

/** THE P&L. Pure over rows the caller already fetched — no queries, trivially checkable. */
export function profitAndLoss(input: AccountingInput): ProfitAndLoss {
  const { settings, period } = input
  const registrant = isGstRegistrant(settings)
  const gstPercent = gstPercentOf(settings)

  const pays = paymentsInPeriod(input.payments, period)
  const exps = expensesInPeriod(input.expenses, period)

  // Money IN — via the ledger's own summariser, never a hand-rolled sum.
  const txn = summarizeTransactions(pays)
  const cashCollected = txn.net
  const salesTaxCollected = salesTaxWithin(cashCollected, gstPercent)
  const revenue = round2(cashCollected - salesTaxCollected)

  // Money OUT — PARTITIONED before it's summed. Not every dollar that leaves the
  // bank is a cost, and the three that aren't each break a different statement:
  //   capital → cash became an asset (counting it fails the balance sheet by the
  //             purchase price and reports a fake loss the month you buy a mower)
  //   draw    → a distribution of profit (counting it hits equity twice)
  //   unpaid  → already excluded by expensesInPeriod (no cash date), but named here
  //             so the partition is exhaustive and provable rather than implied.
  const operating = exps.filter(isOperatingCost)
  const totals = sumExpenses(operating)
  const allTotals = sumExpenses(exps)          // every kind — cash flow's figure

  const cost = registrant ? totals.net : totals.gross
  // deductibleNet is net-based; a non-registrant's deductible cost is gross, so
  // recompute over the same rule rather than mixing bases. Over OPERATING rows only:
  // a draw is not a deduction, and neither is a mower (its depreciation is).
  const deductibleCost = registrant
    ? totals.deductibleNet
    : round2(operating.reduce((s, e) => s + (e.expense_categories?.tax_deductible !== false ? Number(e.amount) || 0 : 0), 0))

  const profit = round2(revenue - cost)

  return {
    period,
    cashCollected,
    refunded: txn.refunded,
    salesTaxCollected,
    revenue,
    cost,
    // Every kind of spend: what the bank actually saw.
    spendGross: allTotals.gross,
    capitalSpend: round2(exps.filter(isCapital).reduce((s, e) => s + (Number(e.amount) || 0), 0)),
    ownerDraws: round2(exps.filter(isOwnerDraw).reduce((s, e) => s + (Number(e.amount) || 0), 0)),
    // Tax paid on OPERATING spend — the input tax credit the P&L is net of. Tax
    // inside a capital purchase belongs to the asset's cost basis, not here.
    taxPaid: totals.tax,
    deductibleCost,
    profit,
    // Asked of margin.ts rather than written here. Margin is a SHARE OF REVENUE, so
    // with no revenue there is no share — marginPct returns null (not 0, not 100%),
    // which is the same honesty rule it enforces on a price. Spending before the
    // season opens is a real state and reads as "—", correctly.
    margin: marginPct(revenue, cost),
    registrant,
    gstPercent,
    expenseCount: exps.length,
    paymentCount: txn.count,
    // Slices are over OPERATING rows so a breakdown sums to the total it breaks
    // down. A "where the money goes" list that silently included draws would not
    // add up to `cost`, and a breakdown that doesn't reconcile to its own total is
    // worse than no breakdown — it looks checkable and isn't.
    byCategory: sliceByCategory(operating, registrant),
    byVendor: sliceByVendor(operating, registrant),
    byMonth: sliceByMonth(pays, operating, period, registrant, gstPercent),
    uncategorisedCount: operating.filter(e => !e.category_id).length,
    // Measured over ALL payments given, not the period-filtered ones — undated cash
    // is by definition outside every period, so period-filtering it first would
    // guarantee the answer is always 0 and hide the very thing this reports.
    undatedCash: round2(
      input.payments.filter(p => !p.paid_at).reduce((s, p) => s + cashAmountOf(p), 0),
    ),
    undatedCashCount: input.payments.filter(p => !p.paid_at && isCashRow(p)).length,
  }
}

/** Cash in vs cash out, both GROSS — the report that must reconcile to a bank statement. */
export function cashFlow(input: AccountingInput): CashFlow {
  const { period } = input
  const pays = paymentsInPeriod(input.payments, period)
  const exps = expensesInPeriod(input.expenses, period)

  const inflow = summarizeTransactions(pays).net
  const outflow = sumExpenses(exps).gross

  // `exps` came through expensesInPeriod, so every row here HAS a cash date — an
  // unpaid bill never reaches a cash-flow chart. The guards are belt-and-braces so a
  // future caller passing raw rows gets nothing rather than a NaN month.
  const months = chartMonths(period, [
    ...pays.map(p => (p.paid_at || '').slice(0, 10)),
    ...exps.map(e => e.spent_at || ''),
  ])

  const byMonth = months.map(key => {
    const i = summarizeTransactions(pays.filter(p => p.paid_at && monthKey(p.paid_at) === key)).net
    const o = sumExpenses(exps.filter(e => e.spent_at && monthKey(e.spent_at) === key)).gross
    return { key, inflow: i, outflow: o, net: round2(i - o) }
  })

  return { period, inflow, outflow, net: round2(inflow - outflow), byMonth }
}

/**
 * The GST inside a GST-inclusive total, at `pct`.
 *
 * The inverse of invoiceTotals' rule (total = net × (1 + pct/100)) — the same rule
 * read backwards, so the P&L and the invoice can never disagree about what the tax
 * on a dollar is. Identity at pct = 0.
 *
 * ASSUMPTION, stated because it is invisible in the output: this treats all cash as
 * having borne GST at the CURRENT rate. Cash that never carried GST (a deposit taken
 * before registering, a rate change mid-year) would be over-divided. It is exact for
 * a non-registrant (0) and for a registrant at a steady rate — the two real cases —
 * and the alternative, a per-payment tax column, is a change to the frozen payments
 * ledger that this pass is explicitly not making.
 */
export function salesTaxWithin(cashInclusive: number, gstPercent: number): number {
  if (!(gstPercent > 0)) return 0
  const net = cashInclusive / (1 + gstPercent / 100)
  return round2(cashInclusive - net)
}

function sliceByCategory(rows: ExpenseWithRelations[], registrant: boolean): CategorySlice[] {
  const map = new Map<string, CategorySlice>()
  for (const r of rows) {
    const id = r.category_id
    const key = id ?? '__none__'
    const slice = map.get(key) || {
      categoryId: id,
      // An expense with no category is not a bug to hide — it's a row the owner
      // hasn't filed yet, and naming it is how it gets fixed.
      name: r.expense_categories?.name ?? 'Uncategorised',
      cost: 0, gross: 0, tax: 0, count: 0,
      tax_deductible: r.expense_categories?.tax_deductible !== false,
      share: 0,
    }
    slice.cost = round2(slice.cost + expenseCost(r, registrant))
    slice.gross = round2(slice.gross + (Number(r.amount) || 0))
    slice.tax = round2(slice.tax + (Number(r.tax_amount) || 0))
    slice.count++
    map.set(key, slice)
  }
  const all = [...map.values()]
  const total = all.reduce((s, c) => s + c.cost, 0)
  return all
    .map(c => ({ ...c, share: total > 0 ? round2(c.cost / total) : 0 }))
    .sort((a, b) => b.cost - a.cost)
}

function sliceByVendor(rows: ExpenseWithRelations[], registrant: boolean): VendorSlice[] {
  const map = new Map<string, VendorSlice>()
  for (const r of rows) {
    const id = r.vendor_id
    const key = id ?? '__none__'
    const slice = map.get(key) || {
      vendorId: id,
      name: r.vendors?.name ?? 'No vendor',
      cost: 0, gross: 0, count: 0,
    }
    slice.cost = round2(slice.cost + expenseCost(r, registrant))
    slice.gross = round2(slice.gross + (Number(r.amount) || 0))
    slice.count++
    map.set(key, slice)
  }
  return [...map.values()].sort((a, b) => b.cost - a.cost)
}

function sliceByMonth(
  pays: Payment[],
  exps: ExpenseWithRelations[],
  period: Period,
  registrant: boolean,
  gstPercent: number,
): MonthSlice[] {
  return chartMonths(period, [
    ...pays.map(p => (p.paid_at || '').slice(0, 10)),
    ...exps.map(e => e.spent_at || ''),
  ]).map(key => {
    const cash = summarizeTransactions(pays.filter(p => p.paid_at && monthKey(p.paid_at) === key)).net
    const revenue = round2(cash - salesTaxWithin(cash, gstPercent))
    const monthExps = exps.filter(e => e.spent_at && monthKey(e.spent_at) === key)
    const t = sumExpenses(monthExps)
    const cost = registrant ? t.net : t.gross
    return { key, revenue, cost, profit: round2(revenue - cost) }
  })
}

// Months to draw: the period, narrowed to where data actually is. 'All time' must
// not try to render 9,998 years of empty bars.
function chartMonths(period: Period, dates: string[]): string[] {
  const present = dates.filter(Boolean)
  const { from, to } = clampPeriodToData(period, present)
  return monthsBetween(from, to)
}
