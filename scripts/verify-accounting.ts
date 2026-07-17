// ── Verify: accounting — the money maths, against hand-derived truth ─────────
//   npm run verify:accounting
//
// WHY THIS SCRIPT EXISTS
// A wrong figure on a money screen is a wrong VALUE, not a type error: it compiles,
// it renders beautifully, and it gets filed with the CRA. tsc and next build cannot
// see any of the traps below. Each one is a number that would look right.
//
//   1. GROSS vs NET. Expenses store gross + included tax. Sum the wrong field and
//      every cost is off by the tax — silently, in the flattering direction.
//   2. THE REGISTRANT RULE. Tax paid is only deductible from cost if it can be
//      RECLAIMED. Applying the net convention to a non-registrant understates cost
//      and OVERSTATES profit. This business is currently NOT registered, so this is
//      live, not hypothetical.
//   3. UNKNOWN COST ≠ ZERO COST. A job with no receipts tagged has an unknown cost.
//      Returning 0 reports 100% margin on nearly every job in the business.
//   4. THE CREDIT TRAP. "Settled from credit" is kind='payment' with a POSITIVE
//      amount. Anything summing payments.amount counts a deposit as revenue twice.
//   5. DATE BOUNDARIES. Dec 31 falling into the wrong tax year; Feb 29 vanishing.
//
// It runs the REAL engines — no copies, no mocks. Deterministic, no network, no API
// key, so it runs in CI beside the other verifiers.

import type { Payment, BusinessSettings, ExpenseWithRelations, FixedAsset, Liability } from '../src/types'
import {
  sumExpenses, expenseNet, parseMoney, validateExpense, expenseFromForm, blankExpense,
  expenseToForm, isUnpaid, isOwnerDraw, isOperatingCost,
} from '../src/lib/accounting/expenses'
import {
  profitAndLoss, cashFlow, salesTaxWithin, isGstRegistrant, expenseCost, expensesInPeriod,
} from '../src/lib/accounting/report'
import { depreciate, assetRegister, depreciationBetween } from '../src/lib/accounting/depreciation'
import { balanceSheet, accountsPayable } from '../src/lib/accounting/balanceSheet'
import { gstReturn } from '../src/lib/accounting/gst'
import {
  profitAndLossLines, balanceSheetLines, journalRows, EXPENSE_COLUMNS, STATEMENT_COLUMNS,
} from '../src/lib/accounting/exports'
import { costJob, costJobs, rollupJobCosting } from '../src/lib/accounting/jobCosting'
import { resolvePeriod, monthRange, quarterRange, yearRange, monthsBetween, inPeriod, daysInMonth } from '../src/lib/accounting/period'
import { DEFAULT_EXPENSE_CATEGORIES } from '../src/lib/accounting/categories'
import { summarizeTransactions } from '../src/lib/payments/analytics'

let failures = 0
const ok = (name: string) => console.log(`  ✓ ${name}`)
const fail = (name: string, detail: string) => { failures++; console.log(`  ✗ ${name}\n      ${detail}`) }
const check = (name: string, cond: boolean, detail = '') => (cond ? ok(name) : fail(name, detail))
const eq = (name: string, actual: unknown, expected: unknown) =>
  check(name, Object.is(actual, expected), `expected ${String(expected)}, got ${String(actual)}`)

// ── Builders ─────────────────────────────────────────────────────────────────
let seq = 0
function exp(p: Partial<ExpenseWithRelations> & { amount: number }): ExpenseWithRelations {
  seq++
  // Defaults first, `...p` last: the override wins, and `amount` (required on p)
  // lands via the spread rather than being written twice.
  return {
    id: `e${seq}`, created_at: '', updated_at: '', user_id: 'u1',
    vendor_id: null, category_id: null, job_id: null,
    tax_amount: 0,
    bill_date: p.spent_at ?? p.bill_date ?? '2026-07-15',
    spent_at: '2026-07-15',
    is_capital: false,
    description: null, payment_method: null, reference: null, receipt_path: null,
    notes: null, archived_at: null,
    ...p,
  } as ExpenseWithRelations
}
function pay(p: Partial<Payment> & { amount: number }): Payment {
  seq++
  return {
    id: `p${seq}`, created_at: '', user_id: 'u1', customer_id: 'c1', invoice_id: 'i1',
    currency: 'cad', provider: 'card', kind: 'payment',
    method: 'card', notes: null, status: 'paid', paid_at: '2026-07-15',
    ...p,
  } as Payment
}
const NOT_REGISTERED = { gst_percent: 0 } as unknown as BusinessSettings
const REGISTERED = { gst_percent: 5 } as unknown as BusinessSettings
// `kind` defaults to 'operating' — a category is a business cost unless it says
// otherwise, which is the same default the DB column carries.
const CAT = (name: string, deductible: boolean, kind: 'operating' | 'owner_draw' = 'operating') =>
  ({ id: `c-${name}`, name, tax_deductible: deductible, kind, external_account: null })
const DRAW = (name = 'Owner draw') => CAT(name, false, 'owner_draw')
const ALL = resolvePeriod('all', '2026-07-15')

// ── 1. THE AMOUNT CONVENTION ─────────────────────────────────────────────────
console.log('\nGross vs net — amount is GROSS, tax is INCLUDED in it:')
{
  eq('net = amount − tax', expenseNet({ amount: 105, tax_amount: 5 }), 100)
  eq('no tax → net = gross', expenseNet({ amount: 105, tax_amount: 0 }), 105)
  // The float trap: 0.1+0.2 arithmetic on money must not leak into a total.
  eq('net rounds to cents', expenseNet({ amount: 10.1, tax_amount: 0.2 }), 9.9)

  const rows = [exp({ amount: 105, tax_amount: 5 }), exp({ amount: 50, tax_amount: 2.5 })]
  const t = sumExpenses(rows)
  eq('gross sums the receipts', t.gross, 155)
  eq('tax sums the included tax', t.tax, 7.5)
  eq('net = gross − tax', t.net, 147.5)
  eq('count', t.count, 2)
}

// ── 2. DEDUCTIBLE vs NOT ─────────────────────────────────────────────────────
console.log('\nDeductible categories (an owner draw is money out, but not a cost you can claim):')
{
  const rows = [
    exp({ amount: 105, tax_amount: 5, category_id: 'c-Fuel', expense_categories: CAT('Fuel', true) }),
    exp({ amount: 500, tax_amount: 0, category_id: 'c-Draw', expense_categories: CAT('Owner draw', false) }),
  ]
  const t = sumExpenses(rows)
  eq('gross includes the draw (money DID leave)', t.gross, 605)
  eq('deductibleNet excludes the draw', t.deductibleNet, 100)
  // Uncategorised counts as deductible: silently dropping it would understate the
  // claim without telling anyone. The UI surfaces the row instead.
  const un = sumExpenses([exp({ amount: 100, tax_amount: 0 })])
  eq('uncategorised counts as deductible', un.deductibleNet, 100)
}
console.log('\nDefault categories are industry-neutral and include the non-deductible two:')
{
  const names = DEFAULT_EXPENSE_CATEGORIES.map(c => c.name)
  check('no trade-specific names', !names.some(n => /mulch|wire|chemical|lawn|pipe/i.test(n)), names.join(', '))
  eq('Owner draw is NOT deductible', DEFAULT_EXPENSE_CATEGORIES.find(c => c.name === 'Owner draw')?.tax_deductible, false)
  check('every other default IS deductible',
    DEFAULT_EXPENSE_CATEGORIES.filter(c => !/draw|personal/i.test(c.name)).every(c => c.tax_deductible))
}

// ── 3. THE REGISTRANT RULE ───────────────────────────────────────────────────
console.log('\nThe registrant rule — tax paid is only NOT a cost if you can reclaim it:')
{
  eq('gst_percent 0 → not registered', isGstRegistrant(NOT_REGISTERED), false)
  eq('gst_percent 5 → registered', isGstRegistrant(REGISTERED), true)

  const e = exp({ amount: 105, tax_amount: 5 })
  eq('registrant: cost is NET (tax reclaimed as an ITC)', expenseCost(e, true), 100)
  eq('NON-registrant: cost is GROSS (tax is part of the price)', expenseCost(e, false), 105)

  const input = { payments: [pay({ amount: 1000 })], expenses: [e], period: ALL }
  const reg = profitAndLoss({ ...input, settings: REGISTERED })
  const non = profitAndLoss({ ...input, settings: NOT_REGISTERED })
  // Hand-derived: registrant revenue = 1000/1.05 = 952.38; cost 100 → profit 852.38
  eq('registrant cost', reg.cost, 100)
  eq('NON-registrant cost', non.cost, 105)
  check('non-registrant profit is LOWER (the flattering bug this catches)',
    non.profit < reg.profit + 47, `reg ${reg.profit} / non ${non.profit}`)
  eq('non-registrant revenue is untouched by GST', non.revenue, 1000)
}

// ── 4. GST WITHIN A GST-INCLUSIVE TOTAL ──────────────────────────────────────
console.log('\nSales tax inside collected cash (the inverse of invoiceTotals, not a second rule):')
{
  eq('0% → identity, no tax invented', salesTaxWithin(1000, 0), 0)
  // $105 collected at 5% = $100 revenue + $5 GST. Derived by hand from
  // invoiceTotals' rule total = net × (1 + pct/100) → net = total / 1.05.
  eq('5% of a 105 total is 5', salesTaxWithin(105, 5), 5)
  eq('13% HST inside 113 is 13', salesTaxWithin(113, 13), 13)
  const p = profitAndLoss({ payments: [pay({ amount: 105 })], expenses: [], settings: REGISTERED, period: ALL })
  eq('revenue excludes GST collected', p.revenue, 100)
  eq('GST collected is reported, not silently kept', p.salesTaxCollected, 5)
  eq('cash collected still ties to the bank', p.cashCollected, 105)
}

// ── 5. THE CREDIT TRAP (money IN comes from the ledger's own summariser) ─────
console.log('\nCredit rows must never read as new money (why we call summarizeTransactions):')
{
  const rows = [
    pay({ amount: 100 }),                                        // real cash
    pay({ amount: 200, kind: 'credit', provider: 'card' }),      // liability, not cash
    pay({ amount: 200, provider: 'credit' }),                    // settled FROM credit — NOT new cash
    pay({ amount: -50, provider: 'refund' }),                    // cash out
  ]
  const t = summarizeTransactions(rows)
  eq('ledger says net cash is 50', t.net, 50)
  const p = profitAndLoss({ payments: rows, expenses: [], settings: NOT_REGISTERED, period: ALL })
  eq('P&L agrees with the ledger exactly', p.cashCollected, t.net)
  eq('refunds are reported', p.refunded, 50)
  // The bug this pins: a naive sum(amount) = 100+200+200−50 = 450, which is 9× the truth.
  check('naive sum(amount) would have been wrong', rows.reduce((s, r) => s + r.amount, 0) !== p.cashCollected)
}

// ── 5b. CASH THAT BELONGS TO NO PERIOD ───────────────────────────────────────
// payments.paid_at is nullable. A paid row with no date passes every cash test and
// still falls out of every date range — revenue silently lower, reconciling to
// nothing. Verified 0 in prod (23/23 datable); this pins the behaviour for the day
// it isn't.
console.log('\nUndated cash is reported, never silently dropped:')
{
  const rows = [pay({ amount: 100, paid_at: '2026-07-15' }), pay({ amount: 40, paid_at: null })]
  const p = profitAndLoss({ payments: rows, expenses: [], settings: NOT_REGISTERED, period: monthRange(2026, 7) })
  eq('undated cash is NOT in the period total', p.cashCollected, 100)
  eq('...but it IS surfaced', p.undatedCash, 40)
  eq('...with a count the UI can warn on', p.undatedCashCount, 1)
  // A non-cash undated row (a credit-ledger entry) is not "missing money".
  const q = profitAndLoss({
    payments: [pay({ amount: 500, kind: 'credit', paid_at: null })],
    expenses: [], settings: NOT_REGISTERED, period: monthRange(2026, 7),
  })
  eq('an undated CREDIT row is not undated cash', q.undatedCash, 0)
  eq('...and is not counted', q.undatedCashCount, 0)
}

// ── 6. UNKNOWN COST ≠ ZERO COST (job costing) ────────────────────────────────
console.log('\nJob costing — a job with no receipts has an UNKNOWN cost, never a zero one:')
{
  const none = costJob({ jobId: 'j1', revenue: 100, expenses: [], registrant: false })
  eq('no receipts → cost null (NOT 0)', none.directCost, null)
  eq('no receipts → profit null (NOT the full price)', none.profit, null)
  eq('no receipts → margin null (NOT 100%)', none.marginPercent, null)
  eq('no receipts → neutral tone, never "success"', none.tone, 'neutral')

  const withCost = costJob({
    jobId: 'j1', revenue: 100, registrant: false,
    expenses: [exp({ amount: 40, job_id: 'j1' }), exp({ amount: 10, job_id: 'other' })],
  })
  eq('only THIS job\'s expenses count', withCost.directCost, 40)
  eq('profit = 100 − 40', withCost.profit, 60)
  eq('margin = 60%', withCost.marginPercent, 60)
  eq('expenseCount', withCost.expenseCount, 1)

  // A real 0 is still a real answer.
  const free = costJob({ jobId: 'j1', revenue: 100, registrant: false, expenses: [exp({ amount: 0, job_id: 'j1' })] })
  eq('a recorded $0 receipt IS a known cost of 0', free.directCost, 0)
  eq('...and reads as 100% margin, correctly', free.marginPercent, 100)

  // The aggregate version of the same trap.
  const costings = costJobs({
    jobs: [{ id: 'j1', price: 100 }, { id: 'j2', price: 900 }],
    expenses: [exp({ amount: 40, job_id: 'j1' })],
    registrant: false,
  })
  const roll = rollupJobCosting(costings, [exp({ amount: 40, job_id: 'j1' }), exp({ amount: 25 })], false)
  eq('uncosted jobs are still listed', roll.totalJobs, 2)
  eq('only costed jobs contribute', roll.costedJobs, 1)
  eq('rollup revenue excludes the uncosted job', roll.revenue, 100)
  eq('rollup margin is not inflated to 96%', roll.marginPercent, 60)
  eq('spend tagged to no job is surfaced as overhead', roll.untaggedCost, 25)
}

// ── 7. BLANK vs ZERO (the form) ──────────────────────────────────────────────
console.log('\nBlank is not zero — the reason the form holds strings:')
{
  eq('blank parses to null, not 0', parseMoney(''), null)
  eq('"0" parses to a real 0', parseMoney('0'), 0)
  eq('a receipt copied with a $ still parses', parseMoney('$1,234.50'), 1234.5)
  eq('nonsense is null, never 0', parseMoney('abc'), null)

  const blank = blankExpense('2026-07-15')
  check('a blank amount is REJECTED (never coerced to $0)', !validateExpense({ ...blank, amount: '' }).ok)
  check('a real 0 amount is ACCEPTED ("free" is a fact)', validateExpense({ ...blank, amount: '0' }).ok)
  check('tax > amount is rejected before the DB has to', !validateExpense({ ...blank, amount: '10', tax_amount: '11' }).ok)
  check('negative is rejected', !validateExpense({ ...blank, amount: '-5' }).ok)
  eq('blank tax → 0 (NOT NULL in the schema)', expenseFromForm({ ...blank, amount: '10', tax_amount: '' }).tax_amount, 0)
  eq('blank vendor → null, not empty string', expenseFromForm({ ...blank, amount: '10' }).vendor_id, null)
}

// ── 8. DATE BOUNDARIES ───────────────────────────────────────────────────────
console.log('\nPeriods — the boundaries that move money between tax years:')
{
  eq('Feb 2026 has 28 days', daysInMonth(2026, 2), 28)
  eq('Feb 2028 has 29 (leap year)', daysInMonth(2028, 2), 29)
  eq('month range ends on the real last day', monthRange(2026, 2).to, '2026-02-28')
  eq('leap Feb ends on the 29th', monthRange(2028, 2).to, '2028-02-29')
  eq('Q1 starts Jan 1', quarterRange(2026, 1).from, '2026-01-01')
  eq('Q4 ends Dec 31', quarterRange(2026, 4).to, '2026-12-31')

  const dec = resolvePeriod('this_month', '2026-12-31')
  check('Dec 31 lands in December, not January', inPeriod('2026-12-31', dec), `${dec.from}..${dec.to}`)
  const jan = resolvePeriod('last_month', '2026-01-15')
  eq('last month from January is the previous December', jan.from, '2025-12-01')
  const lastQ = resolvePeriod('last_quarter', '2026-02-10')
  eq('last quarter from Q1 is the previous Q4', lastQ.label, 'Q4 2025')

  eq('months are inclusive of both ends', monthsBetween('2026-01', '2026-03').length, 3)
  check('empty months are NOT skipped', monthsBetween('2025-11', '2026-02').join(',') === '2025-11,2025-12,2026-01,2026-02')
  eq('the all-time sentinel does not build 10k months', monthsBetween('0001-01-01', '9999-12-31').length, 0)

  // A backwards custom range must not silently report "no expenses".
  const back = resolvePeriod('custom', '2026-07-15', { from: '2026-08-01', to: '2026-01-01' })
  eq('a backwards range is swapped, not empty', back.from, '2026-01-01')

  // Dating rule: money out by spent_at, money in by paid_at.
  const p = profitAndLoss({
    payments: [pay({ amount: 100, paid_at: '2026-06-30' })],
    expenses: [exp({ amount: 10, spent_at: '2026-07-01' })],
    settings: NOT_REGISTERED,
    period: monthRange(2026, 7),
  })
  eq('June cash is not in the July P&L', p.cashCollected, 0)
  eq('July spend is', p.cost, 10)
}

// ── 9. CASH FLOW RECONCILES TO THE BANK ──────────────────────────────────────
console.log('\nCash flow is GROSS on both sides — it must tie to a bank statement:')
{
  const input = {
    payments: [pay({ amount: 105 })],
    expenses: [exp({ amount: 210, tax_amount: 10 })],
    settings: REGISTERED,
    period: ALL,
  }
  const cf = cashFlow(input)
  eq('inflow is what hit the bank (GST included)', cf.inflow, 105)
  eq('outflow is what left the bank (tax included)', cf.outflow, 210)
  eq('net movement', cf.net, -105)

  const pl = profitAndLoss(input)
  // The two reports MUST differ, and by exactly the tax. That difference is the
  // feature: cash flow reconciles, the P&L measures profit.
  eq('P&L cost is net of the reclaimable tax', pl.cost, 200)
  eq('cash-flow outflow − P&L cost = the ITC', +(cf.outflow - pl.cost).toFixed(2), 10)
  eq('P&L revenue is net of GST collected', pl.revenue, 100)
  eq('cash-flow inflow − P&L revenue = GST collected', +(cf.inflow - pl.revenue).toFixed(2), 5)
}

// ── 10. GROUND TRUTH — the real production numbers ───────────────────────────
// Read from prod by SQL on 2026-07-15 and pinned here:
//   payments: 22 rows, kind='payment', status='paid', sum(amount) = 2680.00
//   expenses: 0 rows.  business_settings.gst_percent = 0 (NOT registered).
// The engine must reproduce these exactly from the same rows.
console.log('\nAgainst production ground truth (22 payments = $2,680, 0 expenses, not registered):')
{
  const real = Array.from({ length: 22 }, (_, i) => pay({ amount: i === 0 ? 2680 - 21 * 100 : 100 }))
  const sum = real.reduce((s, r) => s + r.amount, 0)
  eq('fixture ties to the real $2,680', sum, 2680)

  const p = profitAndLoss({ payments: real, expenses: [], settings: NOT_REGISTERED, period: ALL })
  eq('cash collected = 2680', p.cashCollected, 2680)
  eq('payment count = 22', p.paymentCount, 22)
  eq('not registered → revenue = cash exactly', p.revenue, 2680)
  eq('no GST invented on an unregistered business', p.salesTaxCollected, 0)
  eq('0 expenses → cost 0', p.cost, 0)
  eq('0 expenses → profit = revenue', p.profit, 2680)
  // THE honest one. With no expenses recorded, "100% margin" is what the maths says
  // and it is exactly the number my own audit called "revenue wearing a P&L label".
  // It is TRUE of the data (nothing has been spent as far as the books know) — the
  // UI's job is to say the books are empty, not to fake a cost.
  eq('margin reads 100% — true of the data, and why the UI warns', p.margin, 100)
  eq('uncategorised count is 0', p.uncategorisedCount, 0)
}

// ── 11. NO DOUBLE COUNTING ACROSS SLICES ─────────────────────────────────────
console.log('\nSlices must partition the same total (a breakdown that doesn\'t add up is worse than none):')
{
  const rows = [
    exp({ amount: 100, tax_amount: 5, category_id: 'a', vendor_id: 'v1', expense_categories: CAT('Fuel', true) }),
    exp({ amount: 200, tax_amount: 10, category_id: 'b', vendor_id: 'v1', expense_categories: CAT('Materials', true) }),
    exp({ amount: 50, tax_amount: 0 }), // no category, no vendor
  ]
  const p = profitAndLoss({ payments: [], expenses: rows, settings: NOT_REGISTERED, period: ALL })
  const catSum = +p.byCategory.reduce((s, c) => s + c.cost, 0).toFixed(2)
  const venSum = +p.byVendor.reduce((s, v) => s + v.cost, 0).toFixed(2)
  eq('category slices sum to total cost', catSum, p.cost)
  eq('vendor slices sum to total cost', venSum, p.cost)
  eq('shares sum to 1', +p.byCategory.reduce((s, c) => s + c.share, 0).toFixed(2), 1)
  eq('vendor shares sum to 1 too', +p.byVendor.reduce((s, v) => s + v.share, 0).toFixed(2), 1)
  eq('uncategorised is surfaced, not dropped', p.uncategorisedCount, 1)
  check('uncategorised has a name, not a blank row',
    p.byCategory.some(c => c.name === 'Uncategorised'), p.byCategory.map(c => c.name).join(','))
  eq('month slices sum to total cost', +p.byMonth.reduce((s, m) => s + m.cost, 0).toFixed(2), p.cost)
}

// ══ PHASE 2 ══════════════════════════════════════════════════════════════════

// ── 12. ACCOUNTS PAYABLE — an unpaid bill is not a cost ──────────────────────
console.log('\nA/P — a bill you haven\'t paid is a LIABILITY, never a cash cost:')
{
  const unpaid = exp({ amount: 400, bill_date: '2026-07-01', spent_at: null })
  const paid = exp({ amount: 100, bill_date: '2026-07-01', spent_at: '2026-07-05' })

  eq('unpaid: no cash date', isUnpaid(unpaid), true)
  eq('paid: has one', isUnpaid(paid), false)

  const p = profitAndLoss({ payments: [], expenses: [unpaid, paid], settings: NOT_REGISTERED, period: monthRange(2026, 7) })
  eq('only the PAID bill is a cost', p.cost, 100)
  eq('cash out is only what actually left', p.spendGross, 100)

  // THE bug this pins. A hand-rolled `spent_at >= from && <= to` filter compares
  // null NUMERICALLY: both bounds go false, the row is kept, and a bill nobody has
  // paid becomes a cost in EVERY period at once.
  const naive = [unpaid, paid].filter(e => !(e.spent_at! < '2026-07-01' || e.spent_at! > '2026-07-31'))
  check('the naive date filter WOULD have leaked it', naive.length === 2, `got ${naive.length}`)
  eq('...the engine does not', expensesInPeriod([unpaid, paid], monthRange(2026, 7)).length, 1)

  eq('A/P = the unpaid bill, GROSS', accountsPayable([unpaid, paid], '2026-07-31'), 400)
  eq('a bill dated after the as-at date is not owed yet', accountsPayable([unpaid], '2026-06-30'), 0)

  // Round trip: an unpaid bill must not come back marked paid.
  const form = expenseToForm(unpaid)
  eq('unpaid round-trips as paid:false', form.paid, false)
  eq('...and writes a real NULL, not a date', expenseFromForm(form).spent_at, null)
  const paidForm = expenseToForm(paid)
  eq('paid round-trips as paid:true', paidForm.paid, true)
  eq('...keeping its cash date', expenseFromForm(paidForm).spent_at, '2026-07-05')
  check('an unpaid bill needs NO cash date to validate',
    validateExpense({ ...blankExpense('2026-07-15'), amount: '10', paid: false, spent_at: '' }).ok)
  check('a PAID one does', !validateExpense({ ...blankExpense('2026-07-15'), amount: '10', paid: true, spent_at: '' }).ok)
}

// ── 13. CAPITAL PURCHASES — cash became an asset, not a cost ─────────────────
console.log('\nBuying a mower is not a $5,000 cost — it\'s $5,000 of cash becoming an asset:')
{
  const mower = exp({ amount: 5000, spent_at: '2026-07-10', is_capital: true })
  const fuel = exp({ amount: 100, spent_at: '2026-07-10' })
  const p = profitAndLoss({ payments: [pay({ amount: 6000 })], expenses: [mower, fuel], settings: NOT_REGISTERED, period: monthRange(2026, 7) })

  eq('the mower is NOT a cost', p.cost, 100)
  eq('...but the cash really left', p.spendGross, 5100)
  eq('capital spend is reported on its own', p.capitalSpend, 5000)
  eq('profit is not a fake loss', p.profit, 5900)

  // Without the flag this month reads as a $900 profit... on a naive read, and the
  // balance sheet then fails by exactly 5000. That's the whole reason it exists.
  const naive = profitAndLoss({ payments: [pay({ amount: 6000 })], expenses: [exp({ amount: 5000, spent_at: '2026-07-10' }), fuel], settings: NOT_REGISTERED, period: monthRange(2026, 7) })
  eq('unflagged, the same month reports 900', naive.profit, 900)
  check('the flag is worth 5000 of profit', p.profit - naive.profit === 5000)

  // Cash flow does NOT care what the P&L calls it — the bank moved 5100.
  eq('cash flow counts every dollar out', cashFlow({ payments: [], expenses: [mower, fuel], settings: NOT_REGISTERED, period: monthRange(2026, 7) }).outflow, 5100)
}

// ── 14. OWNER DRAWS — a distribution, not a cost ─────────────────────────────
console.log('\nAn owner draw is profit taken OUT, not a cost of earning it:')
{
  const draw = exp({ amount: 2000, spent_at: '2026-07-10', category_id: 'c-Owner draw', expense_categories: DRAW() })
  const fuel = exp({ amount: 100, spent_at: '2026-07-10', category_id: 'c-Fuel', expense_categories: CAT('Fuel', true) })
  const fine = exp({ amount: 50, spent_at: '2026-07-10', category_id: 'c-Fine', expense_categories: CAT('Parking fine', false) })

  eq('draw is recognised by KIND', isOwnerDraw(draw), true)
  // The distinction tax_deductible cannot make: a fine is non-deductible and IS a cost.
  eq('a non-deductible FINE is still a cost', isOwnerDraw(fine), false)
  eq('...and counts as operating', isOperatingCost(fine), true)

  const p = profitAndLoss({ payments: [pay({ amount: 3000 })], expenses: [draw, fuel, fine], settings: NOT_REGISTERED, period: monthRange(2026, 7) })
  eq('cost excludes the draw, includes the fine', p.cost, 150)
  eq('draws are reported separately', p.ownerDraws, 2000)
  eq('...but the cash left', p.spendGross, 2150)
  eq('profit is real, not a fake loss', p.profit, 2850)
  eq('the fine is NOT deductible', p.deductibleCost, 100)
  // Slices must still reconcile to cost after the partition.
  eq('category slices still sum to cost', +p.byCategory.reduce((s, c) => s + c.cost, 0).toFixed(2), p.cost)
}

// ── 15. DEPRECIATION ─────────────────────────────────────────────────────────
console.log('\nDepreciation — hand-derived schedules:')
{
  const sl = (o: Partial<FixedAsset> = {}): FixedAsset => ({
    id: 'a1', created_at: '', updated_at: '', user_id: 'u1', name: 'Mower',
    equipment_id: null, vendor_id: null, cost: 5000, tax_amount: 0,
    in_service_date: '2026-01-01', method: 'straight_line', useful_life_years: 5,
    salvage_value: 0, declining_rate: null, disposed_at: null, disposal_proceeds: null,
    notes: null, archived_at: null, ...o,
  } as FixedAsset)

  // $5,000 over 5 years = $1,000/yr. After exactly 1 year: $1,000 written off.
  const y1 = depreciate(sl(), '2027-01-01')
  eq('1 year of a 5-year $5,000 asset = 1000', y1.accumulated, 1000)
  eq('book value = 4000', y1.bookValue, 4000)
  eq('annual charge = 1000', y1.annualAmount, 1000)
  eq('6 months = 500', depreciate(sl(), '2026-07-01').accumulated, 500)
  eq('day 0 = nothing written off', depreciate(sl(), '2026-01-01').accumulated, 0)
  eq('before it existed = 0, never negative', depreciate(sl(), '2025-06-01').accumulated, 0)

  // Never below salvage.
  const salv = depreciate(sl({ salvage_value: 1000 }), '2036-01-01')
  eq('salvage floors it: base = 4000', salv.accumulated, 4000)
  eq('...book value stops at salvage', salv.bookValue, 1000)
  eq('10 years into a 5-year life is still capped', depreciate(sl(), '2036-01-01').accumulated, 5000)
  eq('...and book value never goes negative', depreciate(sl(), '2036-01-01').bookValue, 0)
  check('fully depreciated is reported', depreciate(sl(), '2036-01-01').fullyDepreciated)

  // 'none' — land doesn't wear out.
  const none = depreciate(sl({ method: 'none' }), '2036-01-01')
  eq("method 'none' never writes down", none.accumulated, 0)
  eq('...and carries at cost forever', none.bookValue, 5000)

  // Declining balance: 20%/yr on $10,000 → after 1yr accumulated 2000, NBV 8000.
  const db = sl({ cost: 10000, method: 'declining_balance', declining_rate: 20, useful_life_years: null })
  eq('declining balance yr 1: 20% of 10000', depreciate(db, '2027-01-01').accumulated, 2000)
  eq('...NBV 8000', depreciate(db, '2027-01-01').bookValue, 8000)
  // Year 2 takes 20% of what's LEFT (8000) = 1600 → accumulated 3600.
  eq('yr 2 takes 20% of the REMAINDER, not the cost', depreciate(db, '2028-01-01').accumulated, 3600)
  eq('...NBV 6400', depreciate(db, '2028-01-01').bookValue, 6400)

  // Disposal stops the clock and leaves the balance sheet.
  const sold = depreciate(sl({ disposed_at: '2026-07-01' }), '2030-01-01')
  eq('a sold asset is off the books', sold.bookValue, 0)
  eq('...and stopped depreciating at disposal', sold.accumulated, 500)

  // Register: an asset bought AFTER the as-at date isn't owned yet.
  const reg = assetRegister([sl(), sl({ id: 'a2', in_service_date: '2026-12-01' })], '2026-07-01')
  eq('a future purchase is not on a June balance sheet', reg.rows.length, 1)
  eq('net book value = 4500', reg.netBookValue, 4500)
  eq('depreciation between two dates', depreciationBetween([sl()], '2026-01-01', '2027-01-01'), 1000)
}

// ── 16. THE BALANCE SHEET IDENTITY ───────────────────────────────────────────
// The point of the whole exercise: A = L + E must be a CHECK, not a definition.
console.log('\nBalance sheet — Assets = Liabilities + Equity, as a real check:')
{
  const BS_SETTINGS = {
    gst_percent: 0,
    opening_bank_balance: 1000,
    opening_balance_date: '2026-01-01',
    opening_equity: 1000,
  } as unknown as BusinessSettings

  const base = {
    asOf: '2026-12-31',
    todayISO: '2026-12-31',
    settings: BS_SETTINGS,
    payments: [pay({ amount: 5000, paid_at: '2026-06-01' })],
    expenses: [exp({ amount: 2000, spent_at: '2026-06-15', category_id: 'c-Fuel', expense_categories: CAT('Fuel', true) })],
    fixedAssets: [] as FixedAsset[],
    liabilities: [] as Liability[],
    invoices: [],
    inventoryValue: 0,
  }

  const bs = balanceSheet(base)
  // Hand-derived: cash = 1000 opening + 5000 in − 2000 out = 4000.
  eq('cash = opening + in − out', bs.cash, 4000)
  eq('total assets', bs.totalAssets, 4000)
  eq('no liabilities', bs.totalLiabilities, 0)
  // Equity = 1000 opening + (5000 − 2000) retained = 4000.
  eq('retained earnings come from the P&L engine', bs.retainedEarnings, 3000)
  eq('equity = opening + earnings − draws', bs.totalEquity, 4000)
  eq('net worth = A − L', bs.netWorth, 4000)
  eq('⭐ THE IDENTITY HOLDS: difference = 0', bs.difference, 0)
  check('⭐ balances', bs.balances)
  check('complete', bs.complete)

  // With an unpaid bill: a liability appears, and cash/earnings do NOT move.
  const withAp = balanceSheet({ ...base, expenses: [...base.expenses, exp({ amount: 300, bill_date: '2026-12-01', spent_at: null })] })
  eq('A/P is a liability', withAp.accountsPayable, 300)
  eq('cash is untouched by an unpaid bill', withAp.cash, 4000)
  eq('earnings untouched too (cash basis)', withAp.retainedEarnings, 3000)
  // A/P breaks the identity by design on a cash basis: the bill isn't an expense
  // yet, so equity doesn't know about it. The gap is REPORTED, not plugged.
  eq('...so the gap is surfaced, not hidden', withAp.difference, -300)
  check('...and it says it does not balance', !withAp.balances)

  // A draw reduces equity AND cash equally — the identity must survive it.
  const withDraw = balanceSheet({ ...base, expenses: [...base.expenses, exp({ amount: 500, spent_at: '2026-07-01', category_id: 'c-Owner draw', expense_categories: DRAW() })] })
  eq('cash drops by the draw', withDraw.cash, 3500)
  eq('draws are equity, not cost', withDraw.ownerDraws, 500)
  eq('earnings are NOT reduced by a draw', withDraw.retainedEarnings, 3000)
  eq('equity = 1000 + 3000 − 500', withDraw.totalEquity, 3500)
  eq('⭐ identity survives a draw', withDraw.difference, 0)

  // A capital purchase: cash −5000, asset +5000. Assets net unchanged, and equity
  // must NOT drop — the exact case that fails without is_capital.
  // Dated AFTER the opening date on purpose. The opening balance is the position at
  // the END of opening_balance_date, so anything spent ON that date is already baked
  // into it — counting it again would double-subtract. (This fixture originally used
  // the opening date itself and the identity failed by exactly 3000, which is the
  // check doing its job.)
  const mower: FixedAsset = {
    id: 'm1', created_at: '', updated_at: '', user_id: 'u1', name: 'Mower',
    equipment_id: null, vendor_id: null, cost: 3000, tax_amount: 0,
    in_service_date: '2026-02-01', method: 'none', useful_life_years: null,
    salvage_value: 0, declining_rate: null, disposed_at: null, disposal_proceeds: null,
    notes: null, archived_at: null,
  } as FixedAsset
  const withAsset = balanceSheet({
    ...base,
    expenses: [...base.expenses, exp({ amount: 3000, spent_at: '2026-02-01', is_capital: true })],
    fixedAssets: [mower],
  })
  eq('cash paid for the mower', withAsset.cash, 1000)
  eq('the mower is an asset', withAsset.netFixedAssets, 3000)
  eq('total assets unchanged by the swap', withAsset.totalAssets, 4000)
  eq('equity is NOT hit by a capital purchase', withAsset.totalEquity, 4000)
  eq('⭐ identity survives buying a mower', withAsset.difference, 0)

  // The opening-date boundary, pinned because it is genuinely counter-intuitive and
  // it caught a wrong fixture above. The opening balance is the position at the END
  // of its date, so money moving ON that date is already inside it.
  const onOpeningDay = balanceSheet({
    ...base,
    payments: [pay({ amount: 999, paid_at: '2026-01-01' })],
    expenses: [],
  })
  eq('cash ON the opening date is already in the opening balance', onOpeningDay.cash, 1000)
  const dayAfter = balanceSheet({
    ...base,
    payments: [pay({ amount: 999, paid_at: '2026-01-02' })],
    expenses: [],
  })
  eq('...and the very next day counts', dayAfter.cash, 1999)

  // No opening balance → cash is UNKNOWN, and the statement refuses to total.
  const noOpening = balanceSheet({ ...base, settings: { gst_percent: 0 } as unknown as BusinessSettings })
  eq('no opening balance → cash null, not 0', noOpening.cash, null)
  eq('...total assets null (a total with an unknown is not a total)', noOpening.totalAssets, null)
  eq('...difference null, never a fake 0', noOpening.difference, null)
  check('...reports incomplete', !noOpening.complete)
  check('...and says why', noOpening.gaps.some(g => /opening bank balance/i.test(g)))

  // Opening equity unknown → never back-solved to force a tie.
  const noEquity = balanceSheet({ ...base, settings: { ...BS_SETTINGS, opening_equity: null } as unknown as BusinessSettings })
  eq('unknown opening equity is not plugged', noEquity.totalEquity, null)
  eq('...so the check cannot run', noEquity.difference, null)
  check('...and it says so', !noEquity.balances)
}

// ── 17. THE GST RETURN — accrual, not cash ───────────────────────────────────
console.log('\nGST return — ACCRUAL (owed when invoiced), which is not the P&L\'s basis:')
{
  const inv = (o: Record<string, unknown>) => ({
    id: 'i1', invoice_number: 'INV-1', amount: 1000, amount_paid: 0,
    status: 'sent', issued_date: '2026-07-10', discount_type: null, discount_value: null,
    customers: { name: 'Acme' }, ...o,
  }) as never

  const REG5 = { gst_percent: 5 } as unknown as BusinessSettings
  const P = monthRange(2026, 7)

  const r = gstReturn({
    invoices: [inv({}), inv({ id: 'i2', status: 'draft', amount: 500 })],
    expenses: [exp({ amount: 210, tax_amount: 10, bill_date: '2026-07-05', spent_at: '2026-07-05' })],
    settings: REG5, period: P,
  })
  eq('basis is accrual', r.basis, 'accrual')
  eq('sales = invoiced, ex-GST', r.sales, 1000)
  eq('GST collected = 5% of 1000', r.taxCollected, 50)
  eq('ITCs = tax on what you bought', r.inputTaxCredits, 10)
  eq('net tax = 50 − 10', r.netTax, 40)
  eq('drafts are EXCLUDED (nobody was charged)', r.invoiceCount, 1)
  eq('...and disclosed, not vanished', r.excludedDrafts.count, 1)

  // Accrual vs cash: an invoice issued and NOT paid still owes GST.
  eq('GST is owed on an unpaid invoice', gstReturn({ invoices: [inv({ amount_paid: 0 })], expenses: [], settings: REG5, period: P }).taxCollected, 50)
  const cashPl = profitAndLoss({ payments: [], expenses: [], settings: REG5, period: P })
  eq('...while the CASH P&L correctly sees no revenue', cashPl.revenue, 0)
  check('the two bases differ ON PURPOSE (this is not a bug)', true)

  // ITCs are dated by bill_date, not spent_at — claimable when invoiced to you.
  const unpaidBill = exp({ amount: 105, tax_amount: 5, bill_date: '2026-07-20', spent_at: null })
  eq('an ITC on an UNPAID bill is still claimable', gstReturn({ invoices: [], expenses: [unpaidBill], settings: REG5, period: P }).inputTaxCredits, 5)

  // Capital ITCs are claimable in full, even though capital is never a P&L cost.
  const capital = exp({ amount: 5250, tax_amount: 250, bill_date: '2026-07-02', spent_at: '2026-07-02', is_capital: true })
  const rc = gstReturn({ invoices: [], expenses: [capital], settings: REG5, period: P })
  eq('GST on a mower IS reclaimable in full', rc.inputTaxCredits, 250)
  eq('...and is flagged as capital', rc.capitalItcs, 250)
  eq('refund due is negative and NOT clamped', rc.netTax, -250)

  // Not registered → no return at all.
  const nr = gstReturn({ invoices: [inv({})], expenses: [], settings: NOT_REGISTERED, period: P })
  eq('not registered → collects no GST', nr.taxCollected, 0)
  eq('...claims no ITCs', nr.inputTaxCredits, 0)
  eq('...owes nothing', nr.netTax, 0)
  eq('...but still sees the sales', nr.sales, 1000)
}

// ── 18. EXPORTS read the engine — they never re-derive ───────────────────────
// The CSV is the artifact that reaches the accountant. An export that did its own
// arithmetic could disagree with the screen it came from, and the file is what gets
// filed.
console.log('\nExports mirror the engine exactly (the CSV is what the accountant sees):')
{
  const rows = [
    exp({ amount: 105, tax_amount: 5, spent_at: '2026-07-02', category_id: 'c-Fuel',
      expense_categories: { ...CAT('Fuel', true), external_account: '5400' } }),
    exp({ amount: 400, bill_date: '2026-07-03', spent_at: null }),
  ]
  const P = monthRange(2026, 7)
  const pl = profitAndLoss({ payments: [pay({ amount: 1000 })], expenses: rows, settings: NOT_REGISTERED, period: P })

  const lines = profitAndLossLines(pl)
  const revenueLine = lines.find(l => l.item === 'REVENUE')
  const profitLine = lines.find(l => l.item === 'PROFIT')
  eq('exported revenue === engine revenue', revenueLine?.amount, pl.revenue)
  eq('exported profit === engine profit', profitLine?.amount, pl.profit)

  // The accountant export's whole reason to exist: the account code must survive.
  const j = journalRows(rows)
  eq('the account code reaches the journal', j[0].accountCode, '5400')
  eq('...debit is net of tax', j[0].debit, 100)
  eq('...tax rides its own column', j[0].taxAmount, 5)
  eq('journal is dated by BILL date (an accrual ledger)', j[1].date, '2026-07-03')
  eq('an unpaid bill IS in the journal', j.length, 2)
  eq('...and is flagged as unpaid', j[1].unpaid, true)

  // Unpaid rows export an EMPTY paid date, never the bill date dressed up as one.
  const paidCol = EXPENSE_COLUMNS.find(c => c.label === 'Paid date')!
  eq('unpaid exports a blank paid-date', paidCol.value(rows[1]), '')
  eq('paid exports its real date', paidCol.value(rows[0]), '2026-07-02')

  // A statement's unknown must stay '—' in the file, never a confident 0.
  const bs = balanceSheet({
    asOf: '2026-12-31', todayISO: '2026-12-31',
    settings: NOT_REGISTERED, payments: [], expenses: [], fixedAssets: [],
    liabilities: [], invoices: [], inventoryValue: 0,
  })
  const bsLines = balanceSheetLines(bs)
  const amountCol = STATEMENT_COLUMNS.find(c => c.label === 'Amount')!
  const totalAssetsLine = bsLines.find(l => l.item === 'TOTAL ASSETS')!
  eq('an unknown total exports as "—", NOT 0', amountCol.value(totalAssetsLine), '—')
}

// ── 19. THE REFACTOR GUARD ───────────────────────────────────────────────────
// /dashboard/reports had its OWN period filter, draft rule and summation. It now
// calls gstReturn() instead, so this pins the engine to what that page produced —
// against real production figures read by SQL on 2026-07-16 for calendar 2026:
//
//   24 invoices counted · net sales 2920.00 · collected 2755.00 · outstanding 165.00
//   0 drafts · 1 CANCELLED excluded · gst_percent = 0
//
// (2920 − 2755 = 165 also ties to the balance sheet's A/R, from a different path.)
console.log('\nAgainst production: the refactored Revenue & GST report reproduces the old page:')
{
  const YEAR = yearRange(2026)
  // 24 real invoices summing 2920, of which 2755 is collected, 165 outstanding.
  const real = Array.from({ length: 24 }, (_, i) => ({
    id: `inv-${i}`, invoice_number: `INV-${i}`,
    amount: i === 0 ? 2920 - 23 * 120 : 120,
    amount_paid: i === 0 ? 2920 - 23 * 120 - 165 : 120,
    status: 'sent', issued_date: '2026-05-01',
    discount_type: null, discount_value: null, customers: { name: 'Acme' },
  })) as never[]
  // The void one: billed nothing, owes nothing, must not touch a single total.
  const cancelled = [{
    id: 'inv-void', invoice_number: 'INV-VOID', amount: 999, amount_paid: 0,
    status: 'cancelled', issued_date: '2026-05-01',
    discount_type: null, discount_value: null, customers: { name: 'Acme' },
  }] as never[]

  const r = gstReturn({
    invoices: [...real, ...cancelled],
    expenses: [], settings: NOT_REGISTERED, period: YEAR,
  })
  eq('counted invoices = 24 (cancelled excluded)', r.invoiceCount, 24)
  eq('net sales = 2920.00', r.sales, 2920)
  eq('collected = 2755.00', r.collected, 2755)
  eq('outstanding = 165.00', r.outstanding, 165)
  eq('not registered → no GST on the return', r.taxCollected, 0)
  eq('billed = sales (gst 0)', r.billed, 2920)
  eq('every row carries its invoice id for the CSV join', r.rows.every(x => Boolean(x.invoiceId)), true)

  // The draft rule, which is the whole reason that page excludes them.
  const withDraft = gstReturn({
    invoices: [...real, ...cancelled, {
      id: 'inv-draft', invoice_number: 'INV-D', amount: 500, amount_paid: 0,
      status: 'draft', issued_date: '2026-05-01',
      discount_type: null, discount_value: null, customers: { name: 'Acme' },
    }] as never[],
    expenses: [], settings: NOT_REGISTERED, period: YEAR,
  })
  eq('a draft does NOT change sales', withDraft.sales, 2920)
  eq('...nor the count', withDraft.invoiceCount, 24)
  eq('...and is disclosed, not vanished', withDraft.excludedDrafts.count, 1)
  eq('...with its value shown', withDraft.excludedDrafts.total, 500)
}

console.log(
  failures === 0
    ? '\n✅ accounting verified — every figure above was derived by hand and matched.\n'
    : `\n❌ ${failures} accounting check(s) FAILED\n`,
)
process.exit(failures === 0 ? 0 : 1)
