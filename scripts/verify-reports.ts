// ── Verify: scheduled reports ────────────────────────────────────────────────
//   npm run verify:reports
//
// WHY THIS SCRIPT EXISTS
// A report is the artefact most likely to be forwarded to an accountant and least
// likely to be checked against the app. If it ever computed its own totals, a drift
// from the P&L page would be invisible until someone filed on it.
//
// So the central assertion here is not "the numbers are right" — verify:accounting
// already owns that, over the same engines. It is "the report did not do its own
// maths": every figure the report shows is === the engine's own output for the same
// period. That is a property the composer can be held to forever, and it is what
// makes "no duplicate math" checkable rather than aspirational.
//
// The other half is the PERIOD boundaries, which are the reports' own new surface:
// a week that starts on the wrong day silently moves a Sunday's money into the
// previous report, and both reports still add up. Nothing but a test catches that.
//
// Runs the REAL engines — no mocks. Deterministic, no network.

import type { Payment, BusinessSettings, ExpenseWithRelations } from '../src/types'

import { resolvePeriod, weekRange, dayRange, addDaysISO, weekdayOf, inPeriod } from '../src/lib/accounting/period'
import { profitAndLoss, cashFlow } from '../src/lib/accounting/report'
import { summarizeTransactions } from '../src/lib/payments/analytics'
import { composeReport, periodForReport, REPORT_KINDS, type ReportKind } from '../src/lib/reports/schedule'
import { summarize } from '../src/lib/reports/summary'
import { summaryRows, PAYMENT_COLUMNS, reportFilename } from '../src/lib/reports/exports'

let failures = 0
const ok = (n: string) => console.log(`  ✓ ${n}`)
const fail = (n: string, d: string) => { failures++; console.log(`  ✗ ${n}\n      ${d}`) }
const check = (n: string, c: boolean, d = '') => (c ? ok(n) : fail(n, d))
const eq = (n: string, a: unknown, b: unknown) =>
  check(n, Object.is(a, b), `expected ${String(b)}, got ${String(a)}`)

let seq = 0
function pay(p: Partial<Payment> & { amount: number }): Payment {
  seq++
  return {
    id: `p${seq}`, created_at: '', user_id: 'u1', customer_id: 'c1', invoice_id: 'i1',
    currency: 'cad', provider: 'card', kind: 'payment',
    method: 'card', notes: null, status: 'paid', paid_at: '2026-07-15',
    ...p,
  } as Payment
}
function exp(p: Partial<ExpenseWithRelations> & { amount: number }): ExpenseWithRelations {
  seq++
  return {
    id: `e${seq}`, created_at: '', updated_at: '', user_id: 'u1',
    vendor_id: null, category_id: null, job_id: null, tax_amount: 0,
    bill_date: p.spent_at ?? '2026-07-15', spent_at: '2026-07-15', is_capital: false,
    description: null, payment_method: null, reference: null, receipt_path: null,
    notes: null, archived_at: null,
    ...p,
  } as ExpenseWithRelations
}
const NOT_REGISTERED = { gst_percent: 0 } as unknown as BusinessSettings

// 2026-07-16 is a THURSDAY. Its week is Sun 2026-07-12 .. Sat 2026-07-18.
const TODAY = '2026-07-16'

// ── 1. PERIOD BOUNDARIES ─────────────────────────────────────────────────────
console.log('\nWeek boundaries — Sunday-start, matching BIReport.weekday and startOfWeek:')
{
  eq('Thu 2026-07-16 is weekday 4', weekdayOf(TODAY), 4)
  eq('week starts Sunday', weekRange(TODAY).from, '2026-07-12')
  eq('week ends Saturday', weekRange(TODAY).to, '2026-07-18')
  // A Sunday belongs to the week it STARTS, not the one it follows. Off-by-one here
  // moves every Sunday's money into the previous week's report, and both reports
  // still total correctly — which is why only a test finds it.
  eq('Sunday starts its own week', weekRange('2026-07-12').from, '2026-07-12')
  eq('Saturday ends its own week', weekRange('2026-07-18').to, '2026-07-18')
  eq('a week may span a month end', weekRange('2026-07-01').from, '2026-06-28')
  eq('a week may span a year end', weekRange('2027-01-01').from, '2026-12-27')
  eq('every week is 7 days', addDaysISO(weekRange(TODAY).from, 6), weekRange(TODAY).to)
}

console.log('\nDay boundaries:')
{
  eq('a day is a period of one', dayRange(TODAY).from, dayRange(TODAY).to)
  eq('addDays crosses Feb 29 in a leap year', addDaysISO('2028-02-28', 1), '2028-02-29')
  eq('addDays crosses Feb 28 in a common year', addDaysISO('2027-02-28', 1), '2027-03-01')
  eq('addDays goes backwards over a year end', addDaysISO('2026-01-01', -1), '2025-12-31')
}

console.log('\nClosed vs open periods — a schedule must report a FINISHED period:')
{
  for (const k of REPORT_KINDS.map(r => r.value)) {
    const closed = periodForReport(k, TODAY, true)
    check(`${k}: a closed period ends before today`, closed.to < TODAY,
      `${k} closed period ends ${closed.to}, today is ${TODAY} — a report emailed at 5am would cover an empty period`)
  }
  const open = periodForReport('daily', TODAY, false)
  eq('daily OPEN is today (what the page shows)', open.from, TODAY)
  eq('daily CLOSED is yesterday (what the email sends)', periodForReport('daily', TODAY, true).from, '2026-07-15')
}

console.log('\nConsecutive periods tile exactly — no day counted twice, none missed:')
{
  const lastW = resolvePeriod('last_week', TODAY)
  const thisW = resolvePeriod('this_week', TODAY)
  check('last_week ends before this_week starts', lastW.to < thisW.from, `${lastW.to} vs ${thisW.from}`)
  eq('...and they are contiguous', addDaysISO(lastW.to, 1), thisW.from)
  // The real-money version of the same rule: a payment on the boundary lands in
  // exactly ONE of the two periods.
  const boundary = thisW.from
  const inThis = inPeriod(boundary, thisW), inLast = inPeriod(boundary, lastW)
  check('a payment on the boundary is in exactly one period', inThis !== inLast && inThis)
}

// ── 2. THE CORE PROPERTY: the report does NOT do its own maths ───────────────
console.log('\nEvery report figure is IDENTICAL to the engine’s own output:')
{
  // A deliberately awkward ledger: cash in, a refund, and the credit trap (a
  // settlement from credit is kind='payment' with a POSITIVE amount — anything
  // summing `amount` would count it as new money).
  const payments = [
    pay({ amount: 200, paid_at: '2026-07-13' }),                              // in, this week
    pay({ amount: 140, paid_at: '2026-07-15' }),                              // in, this week
    pay({ amount: -40, provider: 'refund', paid_at: '2026-07-15' }),          // refund
    pay({ amount: 100, provider: 'credit', paid_at: '2026-07-15' }),          // NOT cash
    pay({ amount: 999, paid_at: '2026-07-08' }),                              // LAST week
    pay({ amount: 500, paid_at: null }),                                      // undated
  ]
  const expenses = [
    exp({ amount: 60, spent_at: '2026-07-14' }),
    exp({ amount: 5000, spent_at: '2026-07-14', is_capital: true }),          // capital, not a cost
  ]
  const input = { payments, expenses, settings: NOT_REGISTERED }

  const r = composeReport('weekly', TODAY, input, { closed: false })   // this week
  const enginePnl = profitAndLoss({ ...input, period: weekRange(TODAY) })
  const engineFlow = cashFlow({ ...input, period: weekRange(TODAY) })

  // Field-by-field identity. Not "close to" — identical. If the composer ever
  // rounds, re-derives or "adjusts" anything, one of these breaks immediately.
  eq('period.from is the engine’s', r.pnl.period.from, enginePnl.period.from)
  eq('period.to is the engine’s', r.pnl.period.to, enginePnl.period.to)
  eq('cashCollected === engine', r.pnl.cashCollected, enginePnl.cashCollected)
  eq('refunded === engine', r.pnl.refunded, enginePnl.refunded)
  eq('revenue === engine', r.pnl.revenue, enginePnl.revenue)
  eq('cost === engine', r.pnl.cost, enginePnl.cost)
  eq('profit === engine', r.pnl.profit, enginePnl.profit)
  eq('margin === engine', r.pnl.margin, enginePnl.margin)
  eq('capitalSpend === engine', r.pnl.capitalSpend, enginePnl.capitalSpend)
  eq('undatedCash === engine', r.pnl.undatedCash, enginePnl.undatedCash)
  eq('paymentCount === engine', r.pnl.paymentCount, enginePnl.paymentCount)
  eq('flow.inflow === engine', r.flow.inflow, engineFlow.inflow)
  eq('flow.outflow === engine', r.flow.outflow, engineFlow.outflow)
  eq('flow.net === engine', r.flow.net, engineFlow.net)

  // And the money-in figure ties to the LEDGER's own summariser, over the same
  // rows — the one engine that decides what counts as cash.
  const weekPays = payments.filter(p => inPeriod(p.paid_at, weekRange(TODAY)))
  eq('cashCollected === summarizeTransactions(rows).net', r.pnl.cashCollected, summarizeTransactions(weekPays).net)

  // The credit trap, stated as a value: naive sum(amount) would say 400.
  eq('the credit settlement is NOT counted as new money', r.pnl.cashCollected, 300)
  check('a naive sum(amount) would have been wrong',
    weekPays.reduce((s, p) => s + Number(p.amount), 0) !== r.pnl.cashCollected)

  // Last week's payment must NOT leak into this week's report.
  check('a payment from last week is excluded', r.pnl.cashCollected !== 1299)
  // Capital is cash out of the bank but NOT a cost.
  eq('capital is excluded from cost', r.pnl.cost, 60)
  eq('...but capital IS in the bank movement', r.flow.outflow, 5060)
}

// ── 3. THE SUMMARY READS, IT DOES NOT COMPUTE ────────────────────────────────
console.log('\nThe summary/email/PDF/CSV all read the same engine values:')
{
  const payments = [pay({ amount: 200, paid_at: '2026-07-15' })]
  const r = composeReport('daily', TODAY, { payments, expenses: [], settings: NOT_REGISTERED }, { closed: true })
  const s = summarize(r)

  eq('the period sent is yesterday', r.period.from, '2026-07-15')
  check('subject names the period', s.subject.includes(r.period.label))
  check('“Money in” renders cashCollected', s.lines.some(l => l.label === 'Money in' && l.value.includes('200')))
  // CSV rows are the SAME lines as the email — one summary, three renderings.
  eq('CSV summary rows === email lines', summaryRows(r).length, s.lines.length)
  eq('CSV row labels match', summaryRows(r)[0].label, s.lines[0].label)
  check('filename carries kind + period start', reportFilename(r, 'csv') === 'report-daily-2026-07-15.csv',
    reportFilename(r, 'csv'))

  // A non-registrant holds no sales tax, so the tax lines must not appear — showing
  // "Sales tax: $0.00" invites the owner to think they're collecting it.
  check('no sales-tax line for a non-registrant', !s.lines.some(l => l.label.includes('Sales tax')))
}

console.log('\nEmpty periods are honest, not blank:')
{
  const r = composeReport('daily', TODAY, { payments: [], expenses: [], settings: NOT_REGISTERED }, { closed: true })
  const s = summarize(r)
  eq('no cash', r.pnl.cashCollected, 0)
  // Margin on no revenue is NOT 0% and NOT 100% — there is no share of nothing.
  eq('margin is null, not 0', r.pnl.margin, null)
  check('margin renders as —', s.lines.some(l => l.note === 'margin —'))
  check('the text says no money moved', s.text.includes('No money moved'))
}

console.log('\nIncomplete data is declared, never presented as a total:')
{
  const r = composeReport('daily', TODAY, {
    payments: [pay({ amount: 10, paid_at: '2026-07-15' })], expenses: [], settings: NOT_REGISTERED,
    errors: ['payments query failed'],
  }, { closed: true })
  check('complete=false when a source failed', r.complete === false)
  check('the summary warns', summarize(r).warning !== null)
  check('the warning is in the email text', summarize(r).text.includes('⚠️'))
}

console.log('\nUndated cash is surfaced, not silently dropped:')
{
  const r = composeReport('daily', TODAY, {
    payments: [pay({ amount: 10, paid_at: '2026-07-15' }), pay({ amount: 777, paid_at: null })],
    expenses: [], settings: NOT_REGISTERED,
  }, { closed: true })
  check('undated cash is reported', summarize(r).lines.some(l => l.label === 'Undated payments' && l.value.includes('777')),
    'a paid row with no date belongs to no period — silence makes the report quietly lower than the bank')
}

// ── 4. THE CSV TIES TO THE REPORT BY CONSTRUCTION ────────────────────────────
console.log('\nSumming the CSV’s Cash column reproduces “Money in” exactly:')
{
  const payments = [
    pay({ amount: 200, paid_at: '2026-07-15' }),
    pay({ amount: -40, provider: 'refund', paid_at: '2026-07-15' }),
    pay({ amount: 100, provider: 'credit', paid_at: '2026-07-15' }),   // not cash
  ]
  const r = composeReport('daily', TODAY, { payments, expenses: [], settings: NOT_REGISTERED }, { closed: true })
  const cashCol = PAYMENT_COLUMNS.find(c => c.label === 'Cash')!
  const summed = payments.reduce((s, p) => s + Number(cashCol.value(p) || 0), 0)
  eq('sum(CSV Cash) === report Money in', summed, r.pnl.cashCollected)
  // The same sum over a raw `Amount` column would NOT tie — which is exactly why
  // the export carries a Cash column at all.
  const amtCol = PAYMENT_COLUMNS.find(c => c.label === 'Amount')!
  check('sum(CSV Amount) does NOT tie (so the Cash column earns its place)',
    payments.reduce((s, p) => s + Number(amtCol.value(p) || 0), 0) !== r.pnl.cashCollected)
}

// ── 5. THE CADENCE REGISTRY ──────────────────────────────────────────────────
console.log('\nThe four cadences the DB constraint allows:')
{
  const kinds = REPORT_KINDS.map(r => r.value)
  eq('four cadences', kinds.length, 4)
  check('they are exactly the check-constraint values',
    (['daily', 'weekly', 'monthly', 'yearly'] as ReportKind[]).every(k => kinds.includes(k)),
    'report_schedules.kind CHECK must match this registry or a row the UI writes is refused')
  for (const k of kinds) {
    const p = periodForReport(k, TODAY, true)
    check(`${k} resolves to a real range`, p.from <= p.to && !!p.label)
  }
}

console.log(failures === 0
  ? '\n✅ scheduled reports verified — every figure is the engine’s own\n'
  : `\n❌ ${failures} check(s) failed\n`)
process.exit(failures === 0 ? 0 : 1)
