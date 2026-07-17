import type {
  Payment, BusinessSettings, ExpenseWithRelations, FixedAsset, Liability, Invoice,
} from '@/types'
import { summarizeTransactions } from '@/lib/payments/analytics'
import { isUnpaid, isOwnerDraw } from '@/lib/accounting/expenses'
import { profitAndLoss, isGstRegistrant, expenseCost } from '@/lib/accounting/report'
import { gstReturn, type GstInput } from '@/lib/accounting/gst'
import { assetRegister, type AssetRegister } from '@/lib/accounting/depreciation'
import type { Period } from '@/lib/accounting/period'

// ── THE balance sheet — what the business owns, owes, and is worth ───────────
// A position AT A DATE, not a flow over a period. Everything else in this module
// answers "what happened between X and Y"; this answers "what is true right now".
//
// ══ WHY THIS NEEDED SCHEMA, and what would have happened without it ══════════
// A balance sheet is only worth printing if `Assets = Liabilities + Equity` is a
// CHECK. Derived from Phase 1's data it would have been a definition: cash on hand,
// money owed to suppliers, what the gear is worth and what's owed on loans were all
// absent, so equity could only be computed as Assets − Liabilities — which makes the
// identity true by construction and therefore worth nothing. It would balance
// perfectly and prove nothing, which is the most dangerous kind of financial report.
//
// So the inputs are real inputs now, and equity is computed INDEPENDENTLY:
//
//   Assets      = cash + A/R + inventory + net book value of the gear
//   Liabilities = A/P + GST owing + loans
//   Equity      = opening capital + retained earnings − owner draws
//
// Those two sides are derived from different data by different paths. When they
// agree, that agreement means something. When they don't, `difference` is the
// unreconciled gap and it is REPORTED, never plugged. A real bookkeeper calls that
// a suspense account; hiding it would be the whole point of the statement, lost.
//
// ══ CASH IS NOT DERIVABLE WITHOUT AN OPENING BALANCE ═════════════════════════
// The payment ledger knows every movement since it started, but not what was in the
// bank the day before. Without `opening_bank_balance` + `opening_balance_date`, cash
// is a MOVEMENT, not a POSITION — so `cash` is null and `complete` is false. The
// statement refuses to total rather than presenting a movement as a balance.

const round2 = (n: number) => Math.round(n * 100) / 100

/** A line on the statement. `value: null` = genuinely unknown, and prints as "—". */
export interface BalanceLine {
  label: string
  value: number | null
  /** Where the figure came from — every line on a money statement should be traceable. */
  source: string
  /** Why it's unknown, when it is. */
  missing?: string
}

export interface BalanceSheet {
  asOf: string

  // ── Assets ──
  /** opening balance + every cash movement since. NULL without an opening balance. */
  cash: number | null
  /** Invoiced and not yet collected. */
  accountsReceivable: number
  /** Parts on hand at cost. */
  inventory: number
  /** Gear at cost less accumulated depreciation. */
  netFixedAssets: number
  /** NULL when cash is unknown — a total containing an unknown is not a total. */
  totalAssets: number | null

  // ── Liabilities ──
  /** Bills incurred and not yet paid. */
  accountsPayable: number
  /** GST collected less input tax credits. 0 when not registered. Negative = refund due. */
  salesTaxOwing: number
  /** Loans and cards, as the owner last stated them. */
  loans: number
  totalLiabilities: number

  // ── Equity ──
  /** What the owner had in at the opening date. NULL = unknown, never plugged. */
  openingEquity: number | null
  /** Cumulative cash-basis profit from the opening date to as-at. */
  retainedEarnings: number
  /** Profit taken out — reduces equity, and is NOT a cost. */
  ownerDraws: number
  /** openingEquity + retainedEarnings − ownerDraws. NULL when openingEquity is. */
  totalEquity: number | null

  // ── The check ──
  /** totalAssets − totalLiabilities. What the business is worth on these numbers. */
  netWorth: number | null
  /**
   * netWorth − totalEquity. The gap between what the books SHOW and what the tracked
   * activity EXPLAINS.
   *
   * NULL when either side is unknown. 0 (within a cent) = the identity holds and the
   * statement is self-consistent. Non-zero = something real is unrecorded — an
   * untracked capital contribution, an asset bought before tracking, a bad opening
   * balance. It is surfaced, not absorbed.
   */
  difference: number | null
  /** Does Assets = Liabilities + Equity hold, within rounding? */
  balances: boolean
  /** Every input present. False → this is a partial picture and says so. */
  complete: boolean
  /** What's stopping it from being complete, in the owner's words. */
  gaps: string[]

  assets: BalanceLine[]
  liabilities: BalanceLine[]
  equity: BalanceLine[]
  register: AssetRegister
}

export interface BalanceSheetInput {
  asOf: string
  /**
   * The owner's local today. Passed in, never `new Date()` here — this module stays
   * pure so a balance sheet "as at 31 Dec" means that date on every machine. Used
   * only to notice that a BACKDATED statement is being valued with today's inventory.
   */
  todayISO: string
  settings: BusinessSettings | null | undefined
  payments: Payment[]
  expenses: ExpenseWithRelations[]
  fixedAssets: FixedAsset[]
  liabilities: Liability[]
  /**
   * For A/R and the GST liability. Same row shape the GST engine needs, so the
   * balance sheet and the return read one set of invoices, not two.
   */
  invoices: GstInput['invoices']
  /**
   * Parts on hand, valued at cost.
   *
   * ⚠️ A CURRENT snapshot: `parts.qty_on_hand` is today's quantity, not the quantity
   * as at `asOf`. Correct for a balance sheet dated today (the normal case) and
   * overstated/understated for a backdated one by whatever moved since. Reconstructing
   * historical quantities from part_movements is the honest fix; it's noted in `gaps`
   * rather than silently wrong.
   */
  inventoryValue: number
}

/**
 * Accounts receivable as at a date: invoiced, not yet collected.
 *
 * Drafts are excluded — you cannot be owed money on paper that never left the
 * building. Cancelled likewise. Negative balances (overpayment) are floored at 0
 * per invoice: an overpaid invoice is a liability to the customer, not a negative
 * asset, and letting it net off would hide a real receivable behind someone else's
 * credit.
 */
export function accountsReceivable(
  invoices: BalanceSheetInput['invoices'],
  asOf: string,
): number {
  return round2(
    invoices
      .filter(i => i.status !== 'draft' && i.status !== 'cancelled')
      .filter(i => !i.issued_date || i.issued_date <= asOf)
      .reduce((s, i) => s + Math.max(0, (Number(i.amount) || 0) - (Number(i.amount_paid) || 0)), 0),
  )
}

/** Bills incurred on or before the date and still unpaid. THE A/P figure. */
export function accountsPayable(expenses: ExpenseWithRelations[], asOf: string): number {
  return round2(
    expenses
      .filter(e => isUnpaid(e) && e.bill_date <= asOf)
      // GROSS: you owe the vendor the whole invoice, tax included. Whether you can
      // reclaim that tax is a separate question, and it's already answered on the
      // asset side as a receivable from the CRA, not by shrinking the debt.
      .reduce((s, e) => s + (Number(e.amount) || 0), 0),
  )
}

/**
 * Cash as at a date = opening balance + every movement since the opening date.
 *
 * NULL without an opening balance + date. The ledger knows every movement it has
 * seen but not what was in the bank before it started, and presenting movement as
 * position is the single easiest way to make a balance sheet lie.
 *
 * Movements strictly AFTER the opening date are counted: the opening balance is the
 * position at the END of that day, so re-adding that day's payments double-counts.
 */
export function cashAsAt(input: BalanceSheetInput): number | null {
  const opening = input.settings?.opening_bank_balance
  const openingDate = input.settings?.opening_balance_date
  if (opening == null || !openingDate) return null

  const cashIn = summarizeTransactions(
    input.payments.filter(p => p.paid_at && p.paid_at.slice(0, 10) > openingDate && p.paid_at.slice(0, 10) <= input.asOf),
  ).net

  // ALL spend, every kind. Capital purchases and owner draws are not costs, but the
  // money absolutely left the bank — cash doesn't care what the P&L calls it.
  const cashOut = input.expenses
    .filter(e => e.spent_at && e.spent_at > openingDate && e.spent_at <= input.asOf)
    .reduce((s, e) => s + (Number(e.amount) || 0), 0)

  return round2((Number(opening) || 0) + cashIn - cashOut)
}

/**
 * THE balance sheet. Pure over rows the caller already fetched.
 *
 * Reuses profitAndLoss() for retained earnings rather than re-summing: the balance
 * sheet's equity and the P&L's profit MUST be the same number arrived at once, or
 * the two statements disagree and both become unusable.
 */
export function balanceSheet(input: BalanceSheetInput): BalanceSheet {
  const { asOf, settings } = input
  const registrant = isGstRegistrant(settings)
  const gaps: string[] = []

  // ── Assets ──
  const cash = cashAsAt(input)
  if (cash == null) {
    gaps.push('No opening bank balance recorded, so cash on hand can\'t be worked out — the ledger knows every movement since it started, but not what was in the bank before that.')
  }
  const ar = accountsReceivable(input.invoices, asOf)
  const register = assetRegister(input.fixedAssets, asOf)
  const inventory = round2(input.inventoryValue || 0)

  const totalAssets = cash == null ? null : round2(cash + ar + inventory + register.netBookValue)

  // ── Liabilities ──
  const ap = accountsPayable(input.expenses, asOf)
  const salesTaxOwing = salesTaxOwingAsAt(input, registrant)
  // Owner-stated snapshots. Only those already stated as at this date count — a
  // balance dated next month is not a liability today.
  const loans = round2(
    input.liabilities
      .filter(l => !l.archived_at && l.as_of_date <= asOf)
      .reduce((s, l) => s + (Number(l.current_balance) || 0), 0),
  )
  const totalLiabilities = round2(ap + salesTaxOwing + loans)

  // ── Equity, derived INDEPENDENTLY of assets/liabilities ──
  const openingEquity = settings?.opening_equity == null ? null : round2(Number(settings.opening_equity))
  if (openingEquity == null) {
    gaps.push('Opening equity isn\'t recorded, so what the business is worth can\'t be checked against what it earned. Left unknown on purpose rather than back-solved to force a balance.')
  }

  // Retained earnings = cumulative cash-basis profit from the opening date to as-at,
  // straight from the P&L engine. Not re-summed here: if these two ever disagreed,
  // both statements would be worthless.
  const earningsPeriod: Period = {
    from: settings?.opening_balance_date || '0001-01-01',
    to: asOf,
    label: 'since opening',
  }
  const pl = profitAndLoss({
    payments: input.payments,
    expenses: input.expenses,
    settings,
    period: earningsPeriod,
  })
  const retainedEarnings = pl.profit
  const ownerDraws = round2(
    input.expenses
      .filter(e => isOwnerDraw(e) && e.spent_at && e.spent_at <= asOf
        && (!settings?.opening_balance_date || e.spent_at > settings.opening_balance_date))
      .reduce((s, e) => s + (Number(e.amount) || 0), 0),
  )

  const totalEquity = openingEquity == null
    ? null
    : round2(openingEquity + retainedEarnings - ownerDraws)

  // ── The check ──
  const netWorth = totalAssets == null ? null : round2(totalAssets - totalLiabilities)
  const difference = netWorth == null || totalEquity == null ? null : round2(netWorth - totalEquity)
  // A cent of float slop is not a discrepancy; a dollar is.
  const balances = difference != null && Math.abs(difference) < 0.01

  if (input.fixedAssets.length === 0) {
    gaps.push('No assets recorded. If the business owns tools, a mower or a trailer, they\'re worth something and this says it owns nothing.')
  }
  // Inventory is today's quantity × cost. On a backdated statement that's the wrong
  // quantity — say so rather than let a stale figure pass as an "as at" one.
  if (inventory > 0 && asOf < input.todayISO) {
    gaps.push('Inventory is valued at what\'s on the shelf today, not what was there on this date — anything bought or used since is counted wrong.')
  }

  return {
    asOf,
    cash,
    accountsReceivable: ar,
    inventory,
    netFixedAssets: register.netBookValue,
    totalAssets,
    accountsPayable: ap,
    salesTaxOwing,
    loans,
    totalLiabilities,
    openingEquity,
    retainedEarnings,
    ownerDraws,
    totalEquity,
    netWorth,
    difference,
    balances,
    complete: cash != null && openingEquity != null,
    gaps,
    assets: [
      { label: 'Cash', value: cash, source: 'Opening balance + every payment and expense since',
        missing: cash == null ? 'Set an opening bank balance' : undefined },
      { label: 'Accounts receivable', value: ar, source: 'Invoices sent and not yet paid' },
      { label: 'Inventory', value: inventory, source: 'Parts on hand, at cost' },
      { label: 'Equipment (net)', value: register.netBookValue,
        source: `${register.rows.length} asset${register.rows.length === 1 ? '' : 's'} at cost less depreciation` },
    ],
    liabilities: [
      { label: 'Accounts payable', value: ap, source: 'Bills received and not yet paid' },
      { label: registrant ? 'GST owing' : 'GST owing (not registered)', value: salesTaxOwing,
        source: 'GST collected less input tax credits' },
      { label: 'Loans and cards', value: loans, source: 'What you last told us you owe' },
    ],
    equity: [
      { label: 'Opening capital', value: openingEquity, source: 'What you had in the business at the opening date',
        missing: openingEquity == null ? 'Set opening equity' : undefined },
      { label: 'Retained earnings', value: retainedEarnings, source: 'Profit since the opening date (from the P&L)' },
      { label: 'Owner draws', value: -ownerDraws, source: 'Profit taken out — never a business cost' },
    ],
    register,
  }
}

/**
 * GST owing as at a date: collected on sales, less input tax credits on spend.
 *
 * ACCRUAL, via the GST engine — NOT the P&L's cash-basis `salesTaxCollected`. What
 * you owe the CRA is fixed when you INVOICE, not when the customer pays, so the
 * liability on the balance sheet has to be the same number the return will be. The
 * P&L's cash tax figure exists only to net collected cash down to revenue; using it
 * here would put a different GST liability on the balance sheet than on the return,
 * and both would be wrong.
 *
 * Zero for a non-registrant — they charge no GST and reclaim none. Negative is a
 * REAL and unclamped answer: spend more tax than you collect (a big equipment year)
 * and the CRA owes you a refund. Clamping it would hide a receivable.
 */
export function salesTaxOwingAsAt(input: BalanceSheetInput, registrant: boolean): number {
  if (!registrant) return 0

  const openingDate = input.settings?.opening_balance_date || '0001-01-01'
  const ret = gstReturn({
    invoices: input.invoices as GstInput['invoices'],
    expenses: input.expenses,
    settings: input.settings,
    period: { from: openingDate, to: input.asOf, label: 'since opening' },
  })
  return ret.netTax
}

/** Every asset line the register carries, for the schedule + the accountant export. */
export function depreciationSchedule(assets: FixedAsset[], asOf: string) {
  return assetRegister(assets, asOf).rows.map(({ asset, depreciation }) => ({
    id: asset.id,
    name: asset.name,
    inServiceDate: asset.in_service_date,
    method: asset.method,
    cost: depreciation.cost,
    salvage: Number(asset.salvage_value) || 0,
    accumulated: depreciation.accumulated,
    bookValue: depreciation.bookValue,
    annual: depreciation.annualAmount,
    yearsElapsed: depreciation.yearsElapsed,
    fullyDepreciated: depreciation.fullyDepreciated,
  }))
}

export { expenseCost }
