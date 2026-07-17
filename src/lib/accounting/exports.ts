import type { ExpenseWithRelations, FixedAsset, Liability } from '@/types'
import type { CsvColumn } from '@/lib/csv'
import { expenseNet, isUnpaid, isCapital, isOwnerDraw } from '@/lib/accounting/expenses'
import { depreciate } from '@/lib/accounting/depreciation'
import type { ProfitAndLoss, CashFlow } from '@/lib/accounting/report'
import type { GstReturn } from '@/lib/accounting/gst'
import type { BalanceSheet } from '@/lib/accounting/balanceSheet'
import type { JobCosting } from '@/lib/accounting/jobCosting'
import { monthKeyLabel } from '@/lib/accounting/period'

// ── Export column sets ───────────────────────────────────────────────────────
// COLUMN DEFINITIONS ONLY. The CSV itself — escaping, the formula-injection guard,
// the Excel BOM, the download — is lib/csv.ts, which already existed and already
// solved all of that. A second writer here would be a second set of those bugs, and
// the injection guard in particular is not one to reimplement from memory.
//
// Every figure below is READ off an engine result. Nothing in this file adds,
// subtracts or re-derives anything: an export that computed its own totals could
// disagree with the screen it was exported from, and the CSV is the artifact that
// reaches the accountant.
//
// ══ WHY THE COLUMNS ARE SHAPED LIKE THIS ═════════════════════════════════════
// Money is emitted as a NUMBER, never a formatted string: "$1,234.50" doesn't sum
// in a spreadsheet, and a bookkeeper's first act is to sum the column. Dates go out
// as ISO 'YYYY-MM-DD' — unambiguous, sortable, and not subject to Excel's US/UK
// day-month guessing. Booleans go out as words, because TRUE/FALSE reads as a
// formula in some locales.

const yesNo = (b: boolean) => (b ? 'Yes' : 'No')

// ── Expenses ─────────────────────────────────────────────────────────────────
export const EXPENSE_COLUMNS: CsvColumn<ExpenseWithRelations>[] = [
  { label: 'Bill date', value: e => e.bill_date },
  // Empty, not the bill date: this column means "when the cash left", and an unpaid
  // bill has no answer. Filling it in would report money that never moved.
  { label: 'Paid date', value: e => e.spent_at ?? '' },
  { label: 'Status', value: e => (isUnpaid(e) ? 'Unpaid (owed)' : 'Paid') },
  { label: 'Vendor', value: e => e.vendors?.name ?? '' },
  { label: 'Category', value: e => e.expense_categories?.name ?? 'Uncategorised' },
  { label: 'Description', value: e => e.description ?? '' },
  { label: 'Reference', value: e => e.reference ?? '' },
  // Gross, tax and net as three columns so the reader never has to know our
  // convention to check our arithmetic.
  { label: 'Amount (gross)', value: e => Number(e.amount) || 0 },
  { label: 'Tax included', value: e => Number(e.tax_amount) || 0 },
  { label: 'Net of tax', value: e => expenseNet(e) },
  { label: 'Type', value: e => (isCapital(e) ? 'Capital purchase' : isOwnerDraw(e) ? 'Owner draw' : 'Operating cost') },
  { label: 'Tax deductible', value: e => yesNo(e.expense_categories?.tax_deductible !== false) },
  { label: 'Accounting code', value: e => e.expense_categories?.external_account ?? '' },
  { label: 'Job', value: e => e.jobs?.title ?? '' },
  { label: 'Has receipt', value: e => yesNo(Boolean(e.receipt_path)) },
  { label: 'Notes', value: e => e.notes ?? '' },
]

// ── The accountant export ────────────────────────────────────────────────────
// A general-journal-shaped file keyed on `expense_categories.external_account` —
// the seam that has been sitting in the schema since Phase 1 waiting for exactly
// this. The owner maps each category to their QBO/Xero account ONCE, and the export
// speaks their chart of accounts instead of ours.
//
// Deliberately NOT an .IIF or a QBO-native format: those are version-specific,
// undocumented in places, and silently reject a file for a bad header. A neutral
// CSV any accountant can import (or read) is the honest deliverable, and it can't
// fail in a way the owner won't see.
export interface JournalRow {
  date: string
  account: string
  accountCode: string
  description: string
  vendor: string
  /** What a bookkeeper posts to the expense account. */
  debit: number
  credit: number
  taxAmount: number
  reference: string
  unpaid: boolean
}

/**
 * Expenses as journal-ready rows.
 *
 * Dated by `bill_date`, the accrual date — an accountant's ledger is accrual, and
 * this file is for them, not for our cash-basis screens. Unpaid bills are INCLUDED
 * and flagged: they belong in an accrual ledger (that's what A/P is), and dropping
 * them would hand over an incomplete book.
 *
 * `debit` is gross-less-tax when there's a code for the tax to go to; the tax rides
 * its own column so the receiving system can post it to the ITC account. We do not
 * invent a tax account code — a wrong one posts real money to the wrong place.
 */
export function journalRows(expenses: ExpenseWithRelations[]): JournalRow[] {
  return expenses.map(e => ({
    date: e.bill_date,
    account: e.expense_categories?.name ?? 'Uncategorised',
    accountCode: e.expense_categories?.external_account ?? '',
    description: e.description ?? '',
    vendor: e.vendors?.name ?? '',
    debit: expenseNet(e),
    credit: 0,
    taxAmount: Number(e.tax_amount) || 0,
    reference: e.reference ?? '',
    unpaid: isUnpaid(e),
  }))
}

export const JOURNAL_COLUMNS: CsvColumn<JournalRow>[] = [
  { label: 'Date', value: r => r.date },
  { label: 'Account', value: r => r.account },
  { label: 'Account code', value: r => r.accountCode },
  { label: 'Description', value: r => r.description },
  { label: 'Name', value: r => r.vendor },
  { label: 'Debit', value: r => r.debit },
  { label: 'Credit', value: r => r.credit },
  { label: 'Tax', value: r => r.taxAmount },
  { label: 'Reference', value: r => r.reference },
  { label: 'Unpaid at export', value: r => yesNo(r.unpaid) },
]

// ── Fixed assets + depreciation schedule ─────────────────────────────────────
export function assetScheduleRows(assets: FixedAsset[], asOf: string) {
  return assets.map(a => {
    const d = depreciate(a, asOf)
    return {
      name: a.name,
      inService: a.in_service_date,
      method: a.method,
      cost: d.cost,
      salvage: Number(a.salvage_value) || 0,
      life: a.useful_life_years ?? '',
      rate: a.declining_rate ?? '',
      accumulated: d.accumulated,
      bookValue: d.bookValue,
      annual: d.annualAmount,
      disposed: a.disposed_at ?? '',
    }
  })
}

export const ASSET_COLUMNS: CsvColumn<ReturnType<typeof assetScheduleRows>[number]>[] = [
  { label: 'Asset', value: r => r.name },
  { label: 'In service', value: r => r.inService },
  { label: 'Method', value: r => r.method },
  { label: 'Cost', value: r => r.cost },
  { label: 'Salvage', value: r => r.salvage },
  { label: 'Life (years)', value: r => r.life },
  { label: 'Rate (%)', value: r => r.rate },
  { label: 'Accumulated depreciation', value: r => r.accumulated },
  { label: 'Book value', value: r => r.bookValue },
  { label: 'Annual charge', value: r => r.annual },
  { label: 'Disposed', value: r => r.disposed },
]

export const LIABILITY_COLUMNS: CsvColumn<Liability>[] = [
  { label: 'Name', value: l => l.name },
  { label: 'Kind', value: l => l.kind },
  { label: 'Balance', value: l => Number(l.current_balance) || 0 },
  { label: 'As at', value: l => l.as_of_date },
  { label: 'Interest rate (%)', value: l => l.interest_rate ?? '' },
  { label: 'Notes', value: l => l.notes ?? '' },
]

// ── Statements as CSV ────────────────────────────────────────────────────────
// A statement is label/value pairs, not a row set, so these emit a two-column shape
// that opens as a readable statement rather than a table with one row and 40
// columns. `null` prints as '—' exactly as on screen: the CSV must not turn an
// unknown into a confident 0 just because the format prefers numbers.

export interface StatementLine { item: string; amount: number | null; note?: string }

export const STATEMENT_COLUMNS: CsvColumn<StatementLine>[] = [
  { label: 'Item', value: r => r.item },
  // The one place a money value is allowed to be a string: '—' is the honest
  // rendering of an unknown, and a blank would read as zero.
  { label: 'Amount', value: r => (r.amount == null ? '—' : r.amount) },
  { label: 'Note', value: r => r.note ?? '' },
]

export function profitAndLossLines(pl: ProfitAndLoss): StatementLine[] {
  const lines: StatementLine[] = [
    { item: `Profit & Loss — ${pl.period.label}`, amount: null, note: 'Cash basis: money that actually moved' },
    { item: 'Cash collected', amount: pl.cashCollected, note: `${pl.paymentCount} payments` },
  ]
  if (pl.registrant) {
    lines.push({ item: 'Less GST collected', amount: -pl.salesTaxCollected, note: 'Held for the CRA — not revenue' })
  }
  lines.push(
    { item: 'REVENUE', amount: pl.revenue },
    { item: '', amount: null },
    ...pl.byCategory.map(c => ({
      item: `  ${c.name}`,
      amount: c.cost,
      note: c.tax_deductible ? '' : 'not deductible',
    })),
    { item: 'TOTAL OPERATING COST', amount: pl.cost, note: pl.registrant ? 'net of reclaimable tax' : 'gross — tax is not reclaimable' },
    { item: '', amount: null },
    { item: 'PROFIT', amount: pl.profit },
    { item: 'Margin %', amount: pl.margin },
  )
  if (pl.capitalSpend > 0 || pl.ownerDraws > 0) {
    lines.push(
      { item: '', amount: null },
      { item: 'Not costs (excluded above)', amount: null, note: 'real money out, but not costs of earning' },
      { item: '  Capital purchases', amount: pl.capitalSpend, note: 'cash became an asset' },
      { item: '  Owner draws', amount: pl.ownerDraws, note: 'profit taken out' },
    )
  }
  if (pl.undatedCash > 0) {
    lines.push({ item: 'Undated cash (in NO period)', amount: pl.undatedCash, note: 'payments with no date — revenue is short by this' })
  }
  return lines
}

export function cashFlowLines(cf: CashFlow): StatementLine[] {
  return [
    { item: `Cash Flow — ${cf.period.label}`, amount: null, note: 'Gross both sides — reconciles to the bank' },
    { item: 'Cash in', amount: cf.inflow },
    { item: 'Cash out', amount: -cf.outflow },
    { item: 'NET MOVEMENT', amount: cf.net },
    { item: '', amount: null },
    ...cf.byMonth.map(m => ({ item: `  ${monthKeyLabel(m.key)}`, amount: m.net, note: `${m.inflow} in / ${m.outflow} out` })),
  ]
}

export function balanceSheetLines(bs: BalanceSheet): StatementLine[] {
  const lines: StatementLine[] = [
    { item: `Balance Sheet — as at ${bs.asOf}`, amount: null },
    { item: 'ASSETS', amount: null },
    ...bs.assets.map(a => ({ item: `  ${a.label}`, amount: a.value, note: a.missing ?? a.source })),
    { item: 'TOTAL ASSETS', amount: bs.totalAssets },
    { item: '', amount: null },
    { item: 'LIABILITIES', amount: null },
    ...bs.liabilities.map(l => ({ item: `  ${l.label}`, amount: l.value, note: l.source })),
    { item: 'TOTAL LIABILITIES', amount: bs.totalLiabilities },
    { item: '', amount: null },
    { item: 'EQUITY', amount: null },
    ...bs.equity.map(e => ({ item: `  ${e.label}`, amount: e.value, note: e.missing ?? e.source })),
    { item: 'TOTAL EQUITY', amount: bs.totalEquity },
    { item: '', amount: null },
    { item: 'Net worth (assets − liabilities)', amount: bs.netWorth },
    {
      item: 'Unexplained difference',
      amount: bs.difference,
      // The most important cell in the file: it says whether the rest can be trusted.
      note: bs.balances
        ? 'Balances — assets = liabilities + equity'
        : bs.difference == null
          ? 'Cannot be checked — see gaps below'
          : 'DOES NOT BALANCE — something real is unrecorded',
    },
  ]
  if (bs.gaps.length) {
    lines.push({ item: '', amount: null }, { item: "What's missing", amount: null })
    bs.gaps.forEach(g => lines.push({ item: '  •', amount: null, note: g }))
  }
  return lines
}

export function gstReturnLines(r: GstReturn): StatementLine[] {
  if (!r.registrant) {
    return [
      { item: `GST — ${r.period.label}`, amount: null, note: 'Not GST registered: nothing to file' },
      { item: 'Sales', amount: r.sales, note: 'What would be taxable if you registered' },
    ]
  }
  return [
    { item: `GST/HST Return — ${r.period.label}`, amount: null, note: 'ACCRUAL: GST is owed when you invoice, not when you are paid' },
    { item: 'GST number', amount: null, note: r.gstNumber ?? 'NOT SET — required on invoices of $30+' },
    { item: 'Line 101 — Sales and other revenue', amount: r.sales },
    { item: 'Line 105 — GST/HST collected', amount: r.taxCollected },
    { item: 'Line 108 — Input tax credits', amount: r.inputTaxCredits, note: r.capitalItcs > 0 ? `includes ${r.capitalItcs} on capital purchases` : '' },
    {
      item: 'Line 109 — NET TAX',
      amount: r.netTax,
      note: r.netTax >= 0 ? 'You remit this' : 'The CRA owes you this',
    },
    { item: '', amount: null },
    { item: 'Invoices counted', amount: r.invoiceCount },
    { item: 'Drafts excluded', amount: r.excludedDrafts.count, note: 'unsent paper — you do not remit GST on it' },
  ]
}

export const JOB_COSTING_COLUMNS: CsvColumn<JobCosting & { jobName: string }>[] = [
  { label: 'Job', value: r => r.jobName },
  { label: 'Revenue', value: r => r.revenue ?? '' },
  // '—' not 0: a job with no receipts has an UNKNOWN cost. A 0 here would report
  // 100% margin on it, which is the exact lie the engine refuses to tell.
  { label: 'Receipted cost', value: r => (r.directCost == null ? '—' : r.directCost) },
  { label: 'Profit', value: r => (r.profit == null ? '—' : r.profit) },
  { label: 'Margin %', value: r => (r.marginPercent == null ? '—' : r.marginPercent) },
  { label: 'Receipts', value: r => r.expenseCount },
]
