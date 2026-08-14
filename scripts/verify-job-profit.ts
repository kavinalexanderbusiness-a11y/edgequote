// ── Verify: a job's margin is never invented ──────────────────────────────────
//   npm run verify:job-profit
//
// WHY THIS SCRIPT EXISTS
// A job-profit screen has exactly one job — to say whether the work paid — and
// every way it can fail produces a number that is arithmetically valid, quietly
// false, and FLATTERING:
//
//   * an unrecorded labour cost treated as $0 → "52% margin" on a job whose
//     wages nobody entered. This is the live shape: BOTH technicians in
//     production have no wage recorded, so unknown labour is the normal case,
//     not the edge case.
//   * a PARTIAL cost against a FULL price → profit overstated by exactly the
//     categories nobody wrote down
//   * an unpriced visit valued at $0 → a −100% margin on work nobody has priced
//   * COLLECTED CASH used as revenue → every unpaid job reads as a disaster, and
//     the same job's margin changes every time a cheque clears
//   * the GST-INCLUSIVE invoice total used as revenue → tax held for the CRA
//     counted as the business's money (identical to `amount` at today's 0%,
//     which is exactly why it would go unnoticed until registration)
//   * another invoice's payments, or another job's work sessions, landing on this
//     visit — the same cross-pointer class as the expense leak that was LIVE in
//     production until the composite (job_id, user_id) foreign keys shipped
//   * a failed read rendering as "this visit made nothing"
//   * a still-running visit reviewed as though it were finished
//   * an aggregate margin that quietly includes visits with revenue and no cost,
//     lifting the blended figure toward 100% — the rollup version of the same lie
//
// Runs the REAL modules against hand-derived fixtures. Deterministic, no network.
// The last section MUTATES the engine's own source and re-runs the suite, so a
// guard that would pass against a broken predicate fails loudly here instead.

import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import type { ExpenseWithRelations, Payment, TimeEntry, WorkSession } from '../src/types'
import { readJobActualCost, type JobActualCost } from '../src/lib/jobCost'
import {
  reviewJobProfit, rollupProfit, judgeableShare, marginSentence,
  describeProfit, describeBilling, describeInvoiced, describeSettlement, formatMargin,
  type InvoiceFacts, type JobProfitInput, type JobProfitReview,
} from '../src/lib/jobProfit'

let failures = 0
const ok = (name: string) => console.log(`  ✓ ${name}`)
const fail = (name: string, detail: string) => { failures++; console.log(`  ✗ ${name}\n      ${detail}`) }
const check = (name: string, cond: boolean, detail = '') => (cond ? ok(name) : fail(name, detail))
const eq = (name: string, actual: unknown, expected: unknown) =>
  check(name, Object.is(actual, expected), `expected ${String(expected)}, got ${String(actual)}`)

const JOB = 'job-1'
const OTHER_JOB = 'job-2'
const INV = 'inv-1'
const OTHER_INV = 'inv-2'
const USER = 'user-1'
const OTHER_USER = 'user-2'

// ── Fixtures ─────────────────────────────────────────────────────────────────

const expense = (o: Partial<ExpenseWithRelations> & { amount: number }): ExpenseWithRelations => ({
  id: `e${Math.random().toString(36).slice(2, 9)}`,
  created_at: '2026-08-01T00:00:00Z', updated_at: '2026-08-01T00:00:00Z',
  user_id: USER, vendor_id: null, category_id: null, job_id: JOB,
  tax_amount: 0, spent_at: '2026-08-01', description: null, payment_method: null,
  reference: null, receipt_path: null, notes: null, archived_at: null,
  bill_date: '2026-08-01', is_capital: false,
  ...o,
} as ExpenseWithRelations)

const categorised = (e: ExpenseWithRelations, name: string): ExpenseWithRelations => ({
  ...e,
  expense_categories: { id: 'c1', name, tax_deductible: true, kind: 'operating', external_account: null },
})

const shift = (o: Partial<TimeEntry> = {}): TimeEntry => ({
  id: `t${Math.random().toString(36).slice(2, 9)}`,
  created_at: '2026-08-01T00:00:00Z', updated_at: '2026-08-01T00:00:00Z',
  user_id: USER, technician_id: 'tech-1', job_id: JOB,
  clock_in: '2026-08-01T13:00:00Z', clock_out: '2026-08-01T15:00:00Z',
  break_minutes: 0, hourly_rate: 30, notes: null, minutes_worked: 120,
  ...o,
} as TimeEntry)

const payment = (o: Partial<Payment> & { amount: number }): Payment => ({
  id: `p${Math.random().toString(36).slice(2, 9)}`,
  created_at: '2026-08-05T00:00:00Z', user_id: USER, customer_id: 'cust-1',
  invoice_id: INV, currency: 'cad', provider: 'etransfer', kind: 'payment',
  method: 'etransfer', notes: null, status: 'paid', paid_at: '2026-08-05T00:00:00Z',
  ...o,
} as Payment)

const session = (o: Partial<WorkSession> & { minutes: number }): WorkSession => ({
  id: `s${Math.random().toString(36).slice(2, 9)}`,
  user_id: USER, job_id: JOB, worked_on: '2026-08-01',
  started_at: null, ended_at: null, workers: 1,
  labour_minutes: o.minutes * (o.workers ?? 1), note: null, source: 'manual',
  created_at: '2026-08-01T00:00:00Z', updated_at: '2026-08-01T00:00:00Z',
  ...o,
} as WorkSession)

const invoice = (o: Partial<InvoiceFacts> = {}): InvoiceFacts => ({
  id: INV, invoice_number: 'INV-0007', amount: 2400, amount_paid: 0,
  status: 'sent', discount_type: null, discount_value: null,
  ...o,
} as InvoiceFacts)

/** A cost with every category answered — the ONLY state that may carry a margin.
 *  $900 labour (30h at $30) + $200 materials + $50 other = $1,150. */
const completeCost = (o?: { labourMinutes?: number; rate?: number; materials?: number; other?: number }): JobActualCost =>
  readJobActualCost({
    job: { id: JOB, status: 'completed', actual_minutes: 1800, crew_size: 1 },
    expenses: [
      categorised(expense({ amount: o?.materials ?? 200 }), 'Materials'),
      categorised(expense({ amount: o?.other ?? 50 }), 'Fuel'),
    ],
    timeEntries: [shift({ minutes_worked: o?.labourMinutes ?? 1800, hourly_rate: o?.rate ?? 30 })],
    registrant: false,
  })

/** A cost with materials and fuel recorded and NO wage on the hours — the exact
 *  production shape, and the one the headline sentence is about. */
const labourUnknownCost = (): JobActualCost =>
  readJobActualCost({
    job: { id: JOB, status: 'completed', actual_minutes: 120, crew_size: 2 },
    expenses: [
      categorised(expense({ amount: 200 }), 'Materials'),
      categorised(expense({ amount: 50 }), 'Fuel'),
    ],
    timeEntries: [shift({ hourly_rate: null })],
    registrant: false,
  })

/** Nothing recorded at all — 223 jobs and 79 completions of production. */
const nothingRecorded = (status = 'completed'): JobActualCost =>
  readJobActualCost({
    job: { id: JOB, status, actual_minutes: 120, crew_size: 2 },
    expenses: [], timeEntries: [], registrant: false,
  })

const QUOTE = { id: 'q1', total: 2400, initial_price: 2400, weekly_price: null, biweekly_price: null, monthly_price: null }

const review = (o: Partial<JobProfitInput> = {}): JobProfitReview => reviewJobProfit({
  job: { id: JOB, status: 'completed', price: 2400 },
  cost: nothingRecorded(),
  ...o,
});

// ── 1. THE SENTENCE THE WHOLE FEATURE REDUCES TO ─────────────────────────────
console.log('\nUnknown labour is not $0 of labour:')
{
  const r = review({ cost: labourUnknownCost() })
  eq('margin is BLOCKED, not computed', r.margin.state, 'blocked')
  eq('…and blocked BECAUSE the cost is incomplete', r.margin.block, 'cost_incomplete')
  eq('…profit carries no figure', r.margin.profit, null)
  eq('…nor does the percentage', r.margin.percent, null)
  eq('…and the tone is neutral, never a healthy green',
    r.margin.tone, 'neutral')
  // ⭐ The owner-specified wording, byte for byte.
  eq('…the sentence is the owner\'s own',
    r.margin.sentence, 'Margin incomplete — labour cost not recorded.')
  eq('…describeProfit says exactly that and nothing numeric',
    describeProfit(r), 'Margin incomplete — labour cost not recorded.')
  eq('…the revenue side is still known (it is not the thing missing)',
    r.authorized.amount, 2400)
  eq('…and the cost floor is reported as a floor', r.margin.costFloor, 250)
  check('…missing names the one category', r.margin.missing.join(',') === 'labour',
    `got ${r.margin.missing.join(',')}`)
}

console.log('\nThe same sentence, pluralised by what is actually missing:')
{
  eq('nothing recorded at all',
    review().margin.sentence,
    'Margin incomplete — labour, material and other costs not recorded.')
  eq('two categories',
    marginSentence('cost_incomplete', ['labour', 'materials']),
    'Margin incomplete — labour and material costs not recorded.')
  eq('materials alone',
    marginSentence('cost_incomplete', ['materials']),
    'Margin incomplete — material cost not recorded.')
  eq('other alone',
    marginSentence('cost_incomplete', ['other']),
    'Margin incomplete — other cost not recorded.')
}

// ── 2. THE ANSWER, WHEN THE DATA EARNS IT ────────────────────────────────────
console.log('\nA complete cost on a finished, priced visit — the whole point:')
{
  const r = review({ cost: completeCost() })
  eq('margin is known', r.margin.state, 'known')
  eq('…authorized revenue', r.authorized.amount, 2400)
  eq('…recorded actual cost', r.cost.total.amount, 1150)
  eq('…known margin in dollars', r.margin.profit, 1250)
  eq('…and as a percentage of the price', r.margin.percent, 52.1)
  eq('…tone reflects a healthy margin', r.margin.tone, 'success')
  eq('…no block, and no sentence to print', r.margin.block, null)
  eq('…the basis is named, not implied', r.margin.basis, 'authorized')
  eq('…the headline states BOTH halves of the subtraction',
    describeProfit(r), 'Kept $1250.00 of $2400.00 — a 52.1% margin')
  eq('…and it is final', r.final, true)
}
{
  // A margin under cost is the single most important thing this can report, and
  // it is never clamped to zero.
  const r = review({ job: { id: JOB, status: 'completed', price: 900 }, cost: completeCost() })
  eq('a visit priced below cost reports a NEGATIVE margin', r.margin.profit, -250)
  eq('…as a negative percentage', r.margin.percent, -27.8)
  eq('…and reads as danger', r.margin.tone, 'danger')
}

// ── 3. AN UNPRICED VISIT HAS NO REVENUE, NOT $0 OF IT ────────────────────────
console.log('\nA visit nobody priced:')
{
  const r = review({ job: { id: JOB, status: 'completed', price: null }, cost: completeCost() })
  eq('authorized value is unknown', r.authorized.state, 'unknown')
  eq('…with a reason, not a zero', r.authorized.reason, 'no_price')
  eq('…and no amount', r.authorized.amount, null)
  eq('margin is blocked on the price, not on the cost', r.margin.block, 'no_price')
  eq('…so no −100% margin is manufactured', r.margin.percent, null)
  eq('…and it says which half is missing',
    r.margin.sentence, 'Margin incomplete — this visit has no price recorded.')
}
{
  // The quote is the fallback, exactly as lib/visitValue defines it.
  const r = review({ job: { id: JOB, status: 'completed', price: null }, quote: QUOTE, cost: completeCost() })
  eq('the originating quote prices the visit', r.authorized.amount, 2400)
  eq('…and the basis says where it came from', r.authorized.basis, 'quote')
  eq('a per-visit price wins over the quote',
    review({ job: { id: JOB, status: 'completed', price: 3000 }, quote: QUOTE, cost: completeCost() }).authorized.basis,
    'job')
}
{
  // A recurring visit derives its CADENCE price; the anchor visit derives the
  // initial one. Same rule the invoice draft uses.
  const rec = { id: 'q2', total: 999, initial_price: 150, weekly_price: 65, biweekly_price: null, monthly_price: null }
  eq('a weekly visit is worth the weekly price',
    review({ job: { id: JOB, status: 'completed', price: null }, quote: rec, freq: 'weekly', cost: completeCost() }).authorized.amount,
    65)
  eq('…and the first visit of the series is worth the initial price',
    review({ job: { id: JOB, status: 'completed', price: null, is_initial_visit: true }, quote: rec, freq: 'weekly', cost: completeCost() }).authorized.amount,
    150)
}

// ── 3b. THE ACCEPTED QUOTE IS ITS OWN FACT ───────────────────────────────────
console.log('\nWhat was originally agreed, kept apart from what is authorized now:')
{
  const r = review({ job: { id: JOB, status: 'completed', price: 2400 }, quote: QUOTE, cost: completeCost() })
  eq('the accepted quote is reported', r.accepted.amount, 2400)
  eq('…and matches the authorized value when nothing changed', r.scopeVariance, 0)
}
{
  // Scope grew: an approved change minted a line item, and the per-visit price
  // was left alone. The accepted figure must NOT move.
  const r = review({
    job: { id: JOB, status: 'completed', price: null }, quote: QUOTE,
    extras: [{ description: 'Extra bay', amount: 600, changeOrderId: 'co-1' }],
    cost: completeCost(),
  })
  eq('the accepted quote is never rewritten', r.accepted.amount, 2400)
  eq('…while authorized value grows with the approved change', r.authorized.amount, 3000)
  eq('…and the movement is stated', r.scopeVariance, 600)
}
{
  // Re-pricing the visit moves authorized value, never the original agreement.
  const r = review({ job: { id: JOB, status: 'completed', price: 2000 }, quote: QUOTE, cost: completeCost() })
  eq('a re-priced visit still shows what was accepted', r.accepted.amount, 2400)
  eq('…and that it is now lower', r.scopeVariance, -400)
}
{
  const r = review({ job: { id: JOB, status: 'completed', price: 2400 }, cost: completeCost() })
  eq('a job booked with no quote has NO accepted price', r.accepted.state, 'unknown')
  eq('…for that reason', r.accepted.reason, 'no_quote')
  eq('…and no figure', r.accepted.amount, null)
  // The trap: reporting the whole value as "scope growth" on a job that never
  // had a quote to grow from.
  eq('…so no scope movement is claimed', r.scopeVariance, null)
}

// ── 3c. CHANGE ORDERS: APPROVED ONLY, COUNTED ONCE ───────────────────────────
console.log('\nChange orders:')
{
  const r = review({
    job: { id: JOB, status: 'completed', price: 2200 },
    extras: [{ description: 'Approved: extra coat', amount: 200, changeOrderId: 'co-1' }],
    changeOrders: [
      { status: 'approved', amount: 200 },
      { status: 'pending', amount: 800 },
      { status: 'declined', amount: 1500 },
      { status: 'draft', amount: 50 },
    ],
    cost: completeCost(),
  })
  // ⭐ Counted ONCE: from the line item the approval minted, never twice by also
  // adding the change order's own amount.
  eq('an approved change is in authorized value exactly once', r.authorized.amount, 2400)
  eq('…and is attributed to the change, not to an owner extra', r.authorized.approvedChanges, 200)
  eq('…with a count', r.authorized.approvedChangeCount, 1)
  eq('…leaving no owner-added extras', r.authorized.ownerExtras, 0)
  // ⛔ The rule the owner named: unanswered and refused money is NOT authorized.
  eq('a PENDING change is not in authorized value', r.changes.pending, 800)
  eq('…and its money is nowhere in the total', r.authorized.amount, 2400)
  eq('a DECLINED change is not in authorized value', r.changes.declined, 1500)
  eq('…nor is a draft counted anywhere', r.changes.pendingCount, 1)
  eq('…and the margin is measured on the authorized figure alone', r.margin.profit, 1250)
  eq('…which is 2400, not 2400+800+1500', r.authorized.amount, 2400)
}
{
  // The split reconciles: approved + owner-added === extras, always.
  const r = review({
    job: { id: JOB, status: 'completed', price: 2000 },
    extras: [
      { description: 'Approved: gutter', amount: 200, changeOrderId: 'co-1' },
      { description: 'Owner added: haul-away', amount: 200 },
    ],
    cost: completeCost(),
  })
  eq('extras total both kinds', r.authorized.extras, 400)
  eq('…split into approved change money', r.authorized.approvedChanges, 200)
  eq('…and money the owner added without asking', r.authorized.ownerExtras, 200)
  check('…and the split reconciles exactly',
    r.authorized.approvedChanges + r.authorized.ownerExtras === r.authorized.extras,
    `${r.authorized.approvedChanges} + ${r.authorized.ownerExtras} ≠ ${r.authorized.extras}`)
  eq('…all of it billable', r.authorized.amount, 2400)
}
{
  const r = review({ cost: completeCost() })
  eq('with no change orders read, nothing is claimed about them', r.changes.read, false)
  eq('…and no pending money is invented', r.changes.pending, 0)
}

// ── 4. AUTHORIZED INCLUDES WHAT WAS APPROVED, AND NOTHING ELSE ───────────────
console.log('\nApproved extras are authorized value:')
{
  const r = review({
    job: { id: JOB, status: 'completed', price: 2200 },
    extras: [{ description: 'Gutter clear', amount: 200 }],
    cost: completeCost(),
  })
  eq('the extra is inside the authorized figure', r.authorized.amount, 2400)
  eq('…and the split is reported', r.authorized.base, 2200)
  eq('…extras separately', r.authorized.extras, 200)
  eq('…with a count', r.authorized.extrasCount, 1)
  eq('…margin is measured on the whole authorized price', r.margin.profit, 1250)
}
{
  const withTravel = { ...QUOTE, show_travel_separately: true, travel_fee: 40 }
  eq('travel billed separately is authorized value',
    review({ job: { id: JOB, status: 'completed', price: null }, quote: withTravel, cost: completeCost() }).authorized.travel,
    40)
  eq('…and travel already inside the cadence price is NOT added again',
    review({ job: { id: JOB, status: 'completed', price: null }, quote: { ...QUOTE, travel_fee: 40 }, cost: completeCost() }).authorized.travel,
    0)
}

// ── 5. INVOICED IS A BILL, AND IT IS NOT THE TAX ─────────────────────────────
console.log('\nInvoiced value:')
{
  const r = review({ cost: completeCost(), invoice: invoice() })
  eq('an issued invoice is issued', r.invoiced.state, 'issued')
  eq('…and bills the NET subtotal', r.invoiced.amount, 2400)
  eq('…no tax for a non-registrant', r.invoiced.tax, 0)
  eq('…the customer owes the same', r.invoiced.total, 2400)
  eq('…all of it still outstanding', r.invoiced.balance, 2400)
  eq('…and there is no variance from what was authorized', r.invoicedVariance, 0)
}
{
  // ⭐ The trap that hides at 0%: GST is a pass-through liability, so the
  // business's revenue is `amount`, never the tax-inclusive total.
  const r = review({ cost: completeCost(), invoice: invoice(), settings: { gst_percent: 5 } })
  eq('a registrant\'s invoice still bills 2400 of REVENUE', r.invoiced.amount, 2400)
  eq('…with the tax reported apart from it', r.invoiced.tax, 120)
  eq('…the customer owing the tax-inclusive total', r.invoiced.total, 2520)
  eq('…and the margin unmoved by tax', r.margin.profit, 1250)
}
{
  const r = review({ cost: completeCost(), invoice: invoice({ amount: 2200 }) })
  eq('an invoice billed under the authorized price shows the shortfall',
    r.invoicedVariance, -200)
  eq('…and the margin still uses the authorized price', r.margin.profit, 1250)
}
{
  eq('no invoice is a FACT, not an unknown', review({ cost: completeCost() }).invoiced.state, 'none')
  eq('…and carries no figure', review({ cost: completeCost() }).invoiced.amount, null)
  eq('…while the variance stays unstated', review({ cost: completeCost() }).invoicedVariance, null)
  eq('…and the words say so', describeBilling(review({ cost: completeCost() })), 'Not invoiced yet.')
}
{
  const r = review({ cost: completeCost(), invoice: invoice({ status: 'cancelled' }) })
  eq('a cancelled invoice bills nothing', r.invoiced.amount, null)
  eq('…its figure is reported, never counted', r.invoiced.voided, 2400)
  eq('…it carries no collectable balance here', r.invoiced.balance, null)
  eq('…and it does not become a revenue variance', r.invoicedVariance, null)
  eq('…the words name the invoice',
    describeBilling(r), 'INV-0007 was cancelled — it bills nothing.')
  eq('…and the WORK can still be judged on the price it agreed', r.margin.state, 'known')
}
{
  const r = review({ cost: completeCost(), invoice: invoice({ status: 'draft' }) })
  eq('a draft is not yet a bill, and says so', r.invoiced.state, 'draft')
  check('…the words distinguish it', describeBilling(r).startsWith('Draft invoice $2400.00'),
    describeBilling(r))
}

// ── 6. CASH IS NOT REVENUE ───────────────────────────────────────────────────
console.log('\nCollected cash:')
{
  const paid = review({
    cost: completeCost(),
    invoice: invoice({ amount_paid: 2400 }),
    payments: [payment({ amount: 2400 })],
  })
  const unpaid = review({ cost: completeCost(), invoice: invoice(), payments: [] })
  eq('cash collected is reported', paid.collected.amount, 2400)
  eq('…as a payment event', paid.collected.payments, 1)
  eq('…and the balance is clear', paid.invoiced.balance, 0)
  eq('nothing collected is a known $0, not an unknown', unpaid.collected.state, 'known')
  eq('…because the ledger IS the record of money in', unpaid.collected.amount, 0)
  // ⭐⭐ THE rule: paying an invoice does not change what the job earned.
  eq('a paid job and an unpaid job have the SAME margin',
    paid.margin.profit, unpaid.margin.profit)
  eq('…and the same percentage', paid.margin.percent, unpaid.margin.percent)
  eq('…the unpaid one says what is owing',
    describeBilling(unpaid), 'Invoiced $2400.00 · $2400.00 still owing.')
  eq('…and the paid one says so', describeBilling(paid), 'Invoiced $2400.00 · paid in full.')
}
{
  // Settling from credit is real settlement but NOT new cash — the ledger's own
  // isCashRow excludes it, and this reports it rather than losing it.
  const r = review({
    cost: completeCost(),
    invoice: invoice({ amount_paid: 2400 }),
    payments: [payment({ amount: 2400, provider: 'credit', method: 'credit' })],
  })
  eq('credit settlement is not counted as cash arriving', r.collected.amount, 0)
  eq('…but it is reported', r.collected.fromCredit, 2400)
  eq('…and the words explain a settled invoice with no cash',
    describeBilling(r), 'Invoiced $2400.00 · settled from credit.')
}
{
  const r = review({
    cost: completeCost(),
    invoice: invoice({ amount_paid: 1900 }),
    payments: [payment({ amount: 2400 }), payment({ amount: -500, provider: 'refund', method: 'refund' })],
  })
  eq('a refund nets off the cash', r.collected.amount, 1900)
  eq('…and is reported separately', r.collected.refunded, 500)
  eq('…while the money-IN count excludes it', r.collected.payments, 1)
}
{
  // The credit LEDGER leg is the liability side of the same event. Counting both
  // counts the dollar twice.
  const r = review({
    cost: completeCost(), invoice: invoice({ amount_paid: 500 }),
    payments: [payment({ amount: 500 }), payment({ amount: 500, kind: 'credit', provider: 'credit' })],
  })
  eq('a credit-ledger row is not cash', r.collected.amount, 500)
}
{
  const r = review({ cost: completeCost(), invoice: invoice(), settings: { gst_percent: 5 } })
  eq('a registrant is told their cash contains tax', r.collected.includesTax, true)
  eq('…and a non-registrant is not',
    review({ cost: completeCost(), invoice: invoice() }).collected.includesTax, false)
}

// ── 6b. A PARTLY-PAID INVOICE ────────────────────────────────────────────────
console.log('\nA partial payment:')
{
  const r = review({
    cost: completeCost(),
    invoice: invoice({ amount_paid: 1000 }),
    payments: [payment({ amount: 1000 })],
  })
  eq('the cash received is reported', r.collected.amount, 1000)
  eq('…the invoice still bills its full value', r.invoiced.amount, 2400)
  eq('…the balance is what is left', r.invoiced.balance, 1400)
  eq('…and the margin is untouched by how much has arrived', r.margin.profit, 1250)
  eq('…with the words naming the shortfall',
    describeBilling(r), 'Invoiced $2400.00 · $1400.00 still owing.')
}

// ── 6c. MISSING MATERIALS, MISSING ANYTHING ──────────────────────────────────
console.log('\nEach category can be the one that is missing:')
{
  // Labour and fuel recorded; no materials receipt.
  const noMaterials = readJobActualCost({
    job: { id: JOB, status: 'completed', actual_minutes: 1800, crew_size: 1 },
    expenses: [categorised(expense({ amount: 50 }), 'Fuel')],
    timeEntries: [shift({ minutes_worked: 1800, hourly_rate: 30 })],
    registrant: false,
  })
  const r = review({ cost: noMaterials })
  eq('a missing materials receipt blocks the margin', r.margin.block, 'cost_incomplete')
  eq('…and says which category',
    r.margin.sentence, 'Margin incomplete — material cost not recorded.')
  eq('…while the floor reports what IS known', r.margin.costFloor, 950)
  eq('…and no margin is computed from that floor', r.margin.profit, null)
}
{
  // Only materials recorded — two categories missing.
  const onlyMaterials = readJobActualCost({
    job: { id: JOB, status: 'completed', actual_minutes: 1800, crew_size: 1 },
    expenses: [categorised(expense({ amount: 200 }), 'Materials')],
    timeEntries: [], registrant: false,
  })
  eq('two missing categories are both named',
    review({ cost: onlyMaterials }).margin.sentence,
    'Margin incomplete — labour and other costs not recorded.')
}

// ── 6d. PLANNED CREW × ELAPSED TIME IS NEVER A WAGE ──────────────────────────
console.log('\nHours the system knows vs wages it does not:')
{
  // 120 minutes on site, a planned crew of 2, no clock and no wage anywhere.
  const r = review({ cost: nothingRecorded() })
  eq('the labour HOURS are known and reported', r.cost.labourTime.personMinutes, 240)
  eq('…derived from the visit, not from an attendance record', r.cost.labourTime.source, 'visit')
  // ⛔ The rule the owner named: planned crew × elapsed time is not a wage cost.
  eq('…labour COST stays unknown', r.cost.labour.state, 'unknown')
  eq('…so no margin is offered', r.margin.state, 'blocked')
  eq('…and nothing was priced from the plan', r.margin.costFloor, 0)
}
{
  // A clocked shift with no snapshot rate: hours are attendance, cost is still
  // unknown — and the priced shifts are NOT summed on their own.
  const mixed = readJobActualCost({
    job: { id: JOB, status: 'completed', actual_minutes: 240, crew_size: 1 },
    expenses: [categorised(expense({ amount: 200 }), 'Materials'), categorised(expense({ amount: 50 }), 'Fuel')],
    timeEntries: [shift({ minutes_worked: 120, hourly_rate: 30 }), shift({ minutes_worked: 120, hourly_rate: null })],
    registrant: false,
  })
  const r = review({ cost: mixed })
  eq('one rateless shift makes the whole labour cost unknown', r.cost.labour.reason, 'no_rate')
  eq('…the priced half is NOT counted on its own', r.margin.costFloor, 250)
  eq('…and the margin is blocked', r.margin.block, 'cost_incomplete')
}

// ── 6e. LABOUR IS NEVER COUNTED TWICE ────────────────────────────────────────
console.log('\nLabour, when the wage clock AND the day-by-day record both exist:')
{
  const r = review({
    job: { id: JOB, status: 'completed', price: 2400, actual_minutes: 1800 },
    cost: completeCost(),
    sessions: [session({ minutes: 1800, workers: 1 })],
  })
  eq('the wage clock is the only source of labour COST', r.cost.labour.amount, 900)
  eq('…the session minutes are reported as MINUTES', r.work.labourMinutes, 1800)
  // ⛔ 30 hours of session labour must not be priced and added on top of the $900
  // the clock already proved.
  eq('…and the total cost is not inflated by pricing them again', r.cost.total.amount, 1150)
  eq('…so the margin counts labour once', r.margin.profit, 1250)
}

// ── 7. ANOTHER RECORD'S MONEY IS NEVER THIS VISIT'S ──────────────────────────
console.log('\nCross-record leakage — the class that was live in production:')
{
  const r = review({
    cost: completeCost(),
    invoice: invoice(),
    payments: [payment({ amount: 5000, invoice_id: OTHER_INV })],
  })
  eq('another invoice\'s payment is not this visit\'s cash', r.collected.amount, 0)
}
{
  const r = review({
    cost: completeCost(), invoice: null,
    payments: [payment({ amount: 5000, invoice_id: null })],
  })
  eq('an unattached payment is not this visit\'s cash either', r.collected.amount, 0)
}
{
  const r = review({
    cost: completeCost(),
    sessions: [session({ minutes: 480, job_id: OTHER_JOB, user_id: OTHER_USER })],
  })
  eq('another job\'s work session is not this visit\'s work', r.work.sessions, 0)
  eq('…and contributes no minutes', r.work.elapsedMinutes, null)
}
{
  // lib/jobCost owns the expense/shift filter; assert it survives composition,
  // because this is the module a surface actually calls.
  const foreign = readJobActualCost({
    job: { id: JOB, status: 'completed', actual_minutes: 120, crew_size: 1 },
    expenses: [categorised(expense({ amount: 5000, job_id: OTHER_JOB }), 'Materials')],
    timeEntries: [shift({ job_id: OTHER_JOB })],
    registrant: false,
  })
  const r = review({ cost: foreign })
  eq('another job\'s receipts do not become this visit\'s cost', r.margin.costFloor, 0)
  eq('…and the margin stays blocked', r.margin.block, 'cost_incomplete')
}

// ── 8. A FAILED READ IS NOT A ZERO ───────────────────────────────────────────
console.log('\nAn outage:')
{
  const r = review({ cost: nothingRecorded(), readFailed: true, invoice: invoice({ amount_paid: 2400 }), payments: [payment({ amount: 2400 })] })
  eq('authorized value is unknown', r.authorized.amount, null)
  eq('…for the right reason', r.authorized.reason, 'read_failed')
  eq('invoiced is unknown', r.invoiced.state, 'unknown')
  eq('…with no figure', r.invoiced.amount, null)
  eq('collected is unknown', r.collected.state, 'unknown')
  eq('…and not $0', r.collected.amount, null)
  eq('the work record is unknown', r.work.failed, true)
  eq('…and reports no minutes', r.work.elapsedMinutes, null)
  eq('margin is blocked on the read', r.margin.block, 'read_failed')
  eq('…and says so in words',
    r.margin.sentence, 'Margin unavailable — this visit’s costs and billing could not be loaded.')
  eq('…nothing is final', r.final, false)
  eq('…and the billing words do not claim a state',
    describeBilling(r), 'Billing could not be loaded.')
}

// ── 9. WORK THAT IS NOT FINISHED IS NOT A MARGIN ─────────────────────────────
console.log('\nWork still in front of you:')
{
  eq('an unfinished visit is blocked',
    review({ job: { id: JOB, status: 'in_progress', price: 2400 }, cost: completeCost() }).margin.block,
    'not_finished')
  eq('…and says why',
    review({ job: { id: JOB, status: 'in_progress', price: 2400 }, cost: completeCost() }).margin.sentence,
    'Margin comes after the work — this visit is not finished yet.')
  // A running clock is still spending money. Belt and braces: completion clears
  // started_at, so this pair should not occur — and if it does, it is not final.
  const running = review({
    job: { id: JOB, status: 'completed', price: 2400, started_at: '2026-08-01T13:00:00Z' },
    cost: completeCost(),
  })
  eq('a running clock blocks the margin', running.margin.block, 'clock_running')
  eq('…and is reported as running', running.work.clockRunning, true)
  eq('…so nothing is final', running.final, false)
}
{
  const r = review({ job: { id: JOB, status: 'cancelled', price: 2400 }, cost: completeCost() })
  eq('a cancelled visit is blocked', r.margin.block, 'cancelled')
  eq('…with no manufactured loss', r.margin.profit, null)
  eq('…and the reason is the visit, not the paperwork',
    r.margin.sentence, 'This visit was cancelled, so there is no revenue to measure costs against.')
  eq('…yet the money spent on it is still reported', r.margin.costFloor, 1150)
}

// ── 10. MULTI-DAY PROJECTS ───────────────────────────────────────────────────
console.log('\nA project worked over several days:')
{
  const sessions = [
    session({ minutes: 200, workers: 1, worked_on: '2026-08-01' }),
    session({ minutes: 310, workers: 2, worked_on: '2026-08-02' }),
    session({ minutes: 90, workers: 2, worked_on: '2026-08-02' }),
  ]
  const r = review({
    job: { id: JOB, status: 'completed', price: 2400, actual_minutes: 600 },
    cost: completeCost(), sessions,
  })
  eq('every session is counted', r.work.sessions, 3)
  eq('…days are DISTINCT days, not sessions', r.work.days, 2)
  eq('…elapsed is the sum on site', r.work.elapsedMinutes, 600)
  eq('…labour is person-minutes', r.work.labourMinutes, 1000)
  eq('…and it agrees with the visit total the database keeps', r.work.disagrees, false)
  eq('…so the review is final', r.final, true)
  eq('…and the margin is unaffected by how many days it took', r.margin.profit, 1250)
}
{
  // The database enforces actual_minutes = Σ session minutes, so a mismatch means
  // these are not all the days.
  const r = review({
    job: { id: JOB, status: 'completed', price: 2400, actual_minutes: 900 },
    cost: completeCost(), sessions: [session({ minutes: 600 })],
  })
  eq('a total that disagrees with its parts is flagged', r.work.disagrees, true)
  eq('…the review is not final', r.final, false)
  eq('…but the margin is NOT withheld: cost does not come from sessions',
    r.margin.state, 'known')
}
{
  const r = review({
    job: { id: JOB, status: 'completed', price: 2400, actual_minutes: 600 },
    cost: completeCost(), sessions: [], sessionsFailed: true,
  })
  eq('a failed session read is not an empty history', r.work.failed, true)
  eq('…and reports no minutes rather than 0', r.work.elapsedMinutes, null)
  eq('…and the review is not final', r.final, false)
}
{
  const r = review({ job: { id: JOB, status: 'completed', price: 2400, actual_minutes: 120 }, cost: completeCost() })
  eq('a single-visit job with no sessions keeps its legacy total unflagged',
    r.work.disagrees, false)
  eq('…and is final', r.final, true)
}

// ── 11. MANY VISITS ──────────────────────────────────────────────────────────
console.log('\nRolling many finished visits into one line:')
{
  const judged = review({ cost: completeCost() })
  const starved = reviewJobProfit({
    job: { id: 'job-9', status: 'completed', price: 5000 },
    cost: readJobActualCost({
      job: { id: 'job-9', status: 'completed' }, expenses: [], timeEntries: [], registrant: false,
    }),
  })
  const roll = rollupProfit([judged, starved])
  eq('both visits are counted', roll.visits, 2)
  eq('…only one can be judged', roll.judgeable, 1)
  // ⭐⭐ The aggregate version of the whole rule: a $5,000 visit with no recorded
  // cost must not add revenue and no cost.
  eq('…the judged visit\'s revenue alone is in the figures', roll.authorized, 2400)
  eq('…its cost alone too', roll.cost, 1150)
  eq('…so the blended margin is not inflated toward 100%', roll.percent, 52.1)
  eq('…and the share that can be judged is stated', judgeableShare(roll), 50)
  check('…with the reason the rest cannot',
    roll.blockedBy.length === 1 && roll.blockedBy[0].block === 'cost_incomplete' && roll.blockedBy[0].count === 1,
    JSON.stringify(roll.blockedBy))
}
{
  const one = review({ cost: completeCost() })
  eq('the same visit twice is one visit', rollupProfit([one, one]).visits, 1)
  eq('…and its revenue is not doubled', rollupProfit([one, one]).authorized, 2400)
}
{
  const roll = rollupProfit([])
  eq('an empty book judges nothing', roll.judgeable, 0)
  eq('…reports no margin rather than 0%', roll.percent, null)
  eq('…and has no share to state', judgeableShare(roll), null)
}
{
  const cashy = review({
    cost: labourUnknownCost(), invoice: invoice({ amount_paid: 2400 }),
    payments: [payment({ amount: 2400 })],
  })
  const roll = rollupProfit([cashy])
  eq('cash is reported across every visit read', roll.collected, 2400)
  eq('…while the margin stays unjudgeable', roll.judgeable, 0)
  eq('…and the margin figure is not derived from that cash', roll.percent, null)
}
{
  const unreadable = review({ cost: nothingRecorded(), readFailed: true })
  eq('a visit whose cash could not be read makes the total a floor',
    rollupProfit([unreadable]).collectedPartial, true)
}

// ── 12. FORMATTING NEVER INVENTS ─────────────────────────────────────────────
console.log('\nPresentation:')
{
  eq('an unknown percentage renders as a dash', formatMargin(null), '—')
  eq('…a known one as a percentage', formatMargin(52.1), '52.1%')
  eq('…and a negative one is shown, not hidden', formatMargin(-27.8), '-27.8%')
}
{
  // The invoiced LINE. "Not invoiced yet" and "$0.00" are different facts, and
  // this is the function that keeps them apart on the one row an owner reads.
  eq('an uninvoiced visit says so', describeInvoiced(review({ cost: completeCost() })), 'Not invoiced yet')
  eq('…a draft says it is a draft',
    describeInvoiced(review({ cost: completeCost(), invoice: invoice({ status: 'draft' }) })),
    '$2400.00 (draft)')
  eq('…a cancelled one says that',
    describeInvoiced(review({ cost: completeCost(), invoice: invoice({ status: 'cancelled' }) })), 'Cancelled')
  eq('…and an unread one never reads as zero',
    describeInvoiced(review({ cost: nothingRecorded(), readFailed: true })), 'Could not be loaded')
}
{
  // The settlement line carries the state and NOT the figures, so it can sit
  // under the rows without restating them.
  eq('an unpaid invoice states the balance',
    describeSettlement(review({ cost: completeCost(), invoice: invoice() })), '$2400.00 still owing.')
  eq('…a partly paid one states what is left',
    describeSettlement(review({
      cost: completeCost(), invoice: invoice({ amount_paid: 1000 }), payments: [payment({ amount: 1000 })],
    })), '$1400.00 still owing.')
  eq('…a settled one says so',
    describeSettlement(review({
      cost: completeCost(), invoice: invoice({ amount_paid: 2400 }), payments: [payment({ amount: 2400 })],
    })), 'Paid in full.')
  eq('…an uninvoiced visit has nothing to say rather than "$0 owing"',
    describeSettlement(review({ cost: completeCost() })), '')
  eq('…and an unread one refuses to claim a state',
    describeSettlement(review({ cost: nothingRecorded(), readFailed: true })),
    'Billing could not be loaded.')
}

// ── 13. THE LOADER SCOPES EVERY READ TO THE OWNER ────────────────────────────
console.log('\nTenancy, in the loader\'s own source:')
{
  const src = readFileSync(join(__dirname, '..', 'src', 'lib', 'jobProfitData.ts'), 'utf8')
  // ⚠️ Assert the block COUNT first. A split that matches nothing yields zero
  // blocks and every assertion below it passes vacuously — the shape of a guard
  // that asserted nothing at all (Session 48 shipped one).
  const blocks = src.split(".from('").slice(1)
  check(`every table read is found (${blocks.length} of them)`, blocks.length >= 12,
    `only ${blocks.length} table reads found — the split no longer matches this loader`)
  const unscoped = blocks
    .map(b => b.slice(0, 400))
    .filter(b => !b.includes(".eq('user_id', userId)"))
  check('…and every one is scoped to the signed-in owner', unscoped.length === 0,
    `${unscoped.length} unscoped read(s):\n      ${unscoped.map(b => b.split('\n')[0]).join('\n      ')}`)
  check('the work-session read is filtered by user_id in JS (the service-role backstop)',
    src.includes('s.user_id !== userId') && src.includes('s.user_id === userId'),
    'neither session filter found')
  check('payments are read by invoice id, never by customer',
    src.includes(".eq('invoice_id', invoice.id)") && src.includes(".in('invoice_id', invoiceIds)"),
    'the payment reads are not keyed on the invoice')
  check('a failed read returns `unavailable` rather than empty rows',
    (src.match(/return failed\(/g) || []).length >= 15,
    'too few failure branches — some read is falling through to an empty result')
}

// ── 14. NO ESTIMATE EVER BECOMES AN ACTUAL ───────────────────────────────────
console.log('\nThe engine cannot see an estimate:')
{
  const src = readFileSync(join(__dirname, '..', 'src', 'lib', 'jobProfit.ts'), 'utf8')
  const code = src.split('\n').filter(l => !l.trim().startsWith('//') && !l.trim().startsWith('*')).join('\n')
  for (const forbidden of [
    'economics', 'crew_cost_per_hour', 'material_cost', 'unit_cost',
    'lib/labor', 'lib/pricing', 'visitEconomics', 'estimateLabor',
  ]) {
    check(`no reference to ${forbidden}`, !code.includes(forbidden),
      `jobProfit.ts references ${forbidden} — an estimated cost must never reach an actual margin`)
  }
  check('the cost answer is taken from lib/jobCost, never re-derived',
    code.includes('input.cost') || code.includes('{ job, cost }'),
    'the engine appears to compute its own cost')
  check('margin arithmetic comes from lib/margin',
    code.includes("from '@/lib/margin'") && !/\(\s*price\s*-\s*cost\s*\)\s*\/\s*price/.test(code),
    'a second margin formula appears to live here')
}

// ── 15. THE REAL LOADER, DRIVEN AGAINST A STUB DATABASE ──────────────────────
// The static scan above proves the SOURCE says `.eq('user_id', userId)`. This
// proves the loader BEHAVES: it is handed a database holding another business's
// receipts, shifts, sessions and payments pointed straight at this visit, and
// must come back with none of them. (Underneath, the composite (job_id, user_id)
// foreign keys make most of these rows impossible — this is the layer that has to
// hold when a future caller passes a service-role client, which bypasses RLS.)
//
// Same shape as verify:smart-estimate §22: a swapped column inside a loader
// passes every pure-engine assertion ever written, because the engine never sees
// the query.
// ⚠️ Declared as a function and awaited at the very END of this file, with the
// result line INSIDE the same async block. tsx compiles to CJS, where a
// top-level await is a transform error — and a trailing `process.exit()` after
// an async section fires the moment it awaits, so the section never runs and the
// script exits 0 reporting nothing.
async function loaderSection() {
  console.log('\nThe real loader against a stub database — cross-tenant leakage:')
  type Row = Record<string, unknown>
  interface QueryLog { table: string; filters: [string, unknown][] }

  const stub = (tables: Record<string, Row[]>, errorOn: string[] = []) => {
    const log: QueryLog[] = []
    const from = (table: string) => {
      const filters: [string, unknown][] = []
      log.push({ table, filters })
      const rows = (): Row[] => {
        let out = tables[table] ?? []
        for (const [col, val] of filters) {
          if (col === '__in') {
            const [c, list] = val as [string, unknown[]]
            out = out.filter(r => list.includes(r[c]))
          } else out = out.filter(r => r[col] === val)
        }
        return out
      }
      const errored = errorOn.includes(table)
      const b = {
        select: () => b,
        eq: (c: string, v: unknown) => { filters.push([c, v]); return b },
        in: (c: string, v: unknown[]) => { filters.push(['__in', [c, v]]); return b },
        is: (c: string, v: unknown) => { filters.push([c, v]); return b },
        not: () => b,
        order: () => b,
        limit: () => b,
        maybeSingle: () => Promise.resolve(
          errored ? { data: null, error: { message: `${table} failed` } } : { data: rows()[0] ?? null, error: null }),
        then: <T>(resolve: (v: unknown) => T) => Promise.resolve(
          errored
            ? { data: null, error: { message: `${table} failed` }, count: null }
            : { data: rows(), error: null, count: rows().length },
        ).then(resolve),
      }
      return b
    }
    return { client: { from } as unknown as import('@supabase/supabase-js').SupabaseClient, log }
  }

  const ownerJob: Row = {
    id: JOB, user_id: USER, title: 'Deck rebuild', status: 'completed', price: 2400,
    service_type: 'Carpentry', is_initial_visit: false, started_at: null,
    actual_minutes: 1800, crew_size: 1, quote_id: null, recurrence_id: null,
    scheduled_date: '2026-08-02', customer_id: 'cust-1',
  }
  const poisoned = (): Record<string, Row[]> => ({
    jobs: [ownerJob],
    expenses: [
      categorised(expense({ amount: 200 }), 'Materials') as unknown as Row,
      categorised(expense({ amount: 50 }), 'Fuel') as unknown as Row,
      // Another business's receipt, pointed at THIS visit.
      categorised(expense({ amount: 5000, user_id: OTHER_USER }), 'Materials') as unknown as Row,
    ],
    time_entries: [
      shift({ minutes_worked: 1800, hourly_rate: 30 }) as unknown as Row,
      shift({ minutes_worked: 600, hourly_rate: 100, user_id: OTHER_USER }) as unknown as Row,
    ],
    business_settings: [{ user_id: USER, gst_percent: 0 }],
    job_line_items: [],
    invoices: [{
      id: INV, user_id: USER, job_id: JOB, invoice_number: 'INV-0007', amount: 2400,
      amount_paid: 0, status: 'sent', discount_type: null, discount_value: null,
    }],
    // Another business's payment against this invoice id.
    payments: [payment({ amount: 5000, user_id: OTHER_USER }) as unknown as Row],
    job_work_sessions: [
      session({ minutes: 1800, worked_on: '2026-08-01' }) as unknown as Row,
      session({ minutes: 480, user_id: OTHER_USER, worked_on: '2026-08-02' }) as unknown as Row,
    ],
  })

  const { loadJobProfit, loadProfitBook } = await import('../src/lib/jobProfitData')

  {
    const { client, log } = stub(poisoned())
    const load = await loadJobProfit(client, USER, JOB)
    eq('the read succeeds', load.outcome, 'ok')
    const r = load.review
    eq('only the owner’s receipts and shifts are costed', r.cost.total.amount, 1150)
    eq('…so the margin is the owner’s, not one inflated by a stranger’s $5,000',
      r.margin.profit, 1250)
    eq('…and the authorized price came off the visit', r.authorized.amount, 2400)
    eq('another business’s payment is not this visit’s cash', r.collected.amount, 0)
    eq('another business’s work session is not this visit’s work', r.work.sessions, 1)
    eq('…so the day-by-day record still agrees with the visit total', r.work.disagrees, false)
    eq('…and the review is final', r.final, true)

    // ⚠️ Assert the log is non-empty FIRST: a recorder that captured nothing makes
    // every claim below it vacuously true.
    check(`every query was recorded (${log.length})`, log.length >= 7,
      `only ${log.length} queries recorded — the stub is not seeing the loader's reads`)
    const unscoped = log.filter(q =>
      q.table !== 'job_work_sessions' && !q.filters.some(([c, v]) => c === 'user_id' && v === USER))
    check('…and every one but the session read filtered on user_id',
      unscoped.length === 0, `unscoped: ${unscoped.map(q => q.table).join(', ')}`)
    check('…the session read is the documented exception, and it happened',
      log.some(q => q.table === 'job_work_sessions'), 'no session read was issued at all')
    check('…payments were read by invoice id',
      log.some(q => q.table === 'payments' && q.filters.some(([c, v]) => c === 'invoice_id' && v === INV)),
      'the payment read was not keyed on the invoice')
  }

  for (const table of ['jobs', 'expenses', 'invoices', 'payments', 'job_line_items']) {
    const { client } = stub(poisoned(), [table])
    const load = await loadJobProfit(client, USER, JOB)
    eq(`a failed ${table} read is 'unavailable', never an empty answer`, load.outcome, 'unavailable')
    eq(`…and every figure is unknown (${table})`, load.review.authorized.amount, null)
    eq(`…including the cash (${table})`, load.review.collected.amount, null)
    eq(`…with the margin blocked on the read (${table})`, load.review.margin.block, 'read_failed')
  }
  {
    const { client } = stub(poisoned())
    eq('an unsigned-in caller is refused rather than served everything',
      (await loadJobProfit(client, '', JOB)).outcome, 'unavailable')
  }

  // ── The tenancy filters, mutated ───────────────────────────────────────────
  // The section above proves the loader keeps another business's rows out. This
  // proves that section is load-bearing: with the filter removed, the stranger's
  // $5,000 must walk straight in. Two mutations, on the two loaders a cost and a
  // payment actually travel through.
  console.log('\n…and those filters are load-bearing:')
  {
    const srcDir = join(__dirname, '..', 'src').replace(/\\/g, '/')
    const req = createRequire(__filename)
    const rewrite = (code: string) => code.replace(/from '@\/([^']+)'/g, (_x, p) => `from '${srcDir}/${p}'`)

    const runMutant = async (
      name: string, file: string, mutate: (s: string) => string, probe: (mod: unknown) => Promise<boolean>,
    ) => {
      const path = join(__dirname, '..', 'src', 'lib', file)
      const original = readFileSync(path, 'utf8')
      const mutated = mutate(original)
      if (mutated === original) {
        // ⚠️ An anchor that no longer matches tests NOTHING and would otherwise
        // pass, because the "mutant" IS the real loader. jobCostData.ts is CRLF
        // on disk (it came from git) while the new files are LF — hence the
        // \r?\n in these patterns.
        fail(`mutation "${name}" could not be applied`, `the anchor no longer matches ${file}`)
        return
      }
      const dir = mkdtempSync(join(tmpdir(), 'jobprofit-loader-mutant-'))
      const out = join(dir, file)
      writeFileSync(out, rewrite(mutated), 'utf8')
      let observed: boolean
      try {
        observed = await probe(req(out))
      } catch {
        observed = true   // a mutant that throws is a mutant that visibly broke
      } finally {
        rmSync(dir, { recursive: true, force: true })
      }
      check(`caught: ${name}`, observed,
        'the mutant produced the SAME answer as the real loader — the filter it targets is not load-bearing')
    }

    await runMutant(
      'a COST ROW FROM ANOTHER TENANT is costed against this visit',
      'jobCostData.ts',
      s => s.replace(/(\.select\(EXPENSE_SELECT\)\r?\n\s*)\.eq\('user_id', userId\)\r?\n\s*/, '$1'),
      async mod => {
        const { client } = stub(poisoned())
        const load = await (mod as typeof import('../src/lib/jobCostData'))
          .loadJobCost(client, USER, { id: JOB, status: 'completed', actual_minutes: 1800, crew_size: 1 })
        // The stranger's $5,000 receipt lands in materials: 1150 becomes 6150.
        return load.cost.total.amount !== 1150
      },
    )

    await runMutant(
      'a PAYMENT ROW FROM ANOTHER TENANT is collected against this visit',
      'jobProfitData.ts',
      s => s.replace("      .eq('user_id', userId).eq('invoice_id', invoice.id)", "      .eq('invoice_id', invoice.id)"),
      async mod => {
        const { client } = stub(poisoned())
        const load = await (mod as typeof import('../src/lib/jobProfitData')).loadJobProfit(client, USER, JOB)
        return load.review.collected.amount !== 0
      },
    )
  }

  console.log('\n…and the finished-work book:')
  {
    const starved: Row = { ...ownerJob, id: OTHER_JOB, title: 'Fence repair', price: 5000, actual_minutes: null }
    const tables = poisoned()
    tables.jobs = [ownerJob, starved]
    const { client } = stub(tables)
    const load = await loadProfitBook(client, USER)
    if (load.outcome !== 'ok') { fail('the book loads', load.reason); }
    else {
      eq('both finished visits are listed', load.rows.length, 2)
      const judged = load.rows.find(r => r.jobId === JOB)
      const blocked = load.rows.find(r => r.jobId === OTHER_JOB)
      eq('the costed visit is judged', judged?.review.margin.state, 'known')
      eq('…with its own margin', judged?.review.margin.profit, 1250)
      eq('…and its own invoice', judged?.invoiceNumber, 'INV-0007')
      eq('the starved visit is not judged', blocked?.review.margin.block, 'cost_incomplete')
      // The mapping test: one visit's invoice and cash must not attach to another.
      eq('…and no invoice attaches to it', blocked?.review.invoiced.state, 'none')
      eq('…nor any cash', blocked?.review.collected.amount, 0)
      eq('the rollup judges only the one it can', load.rollup.judgeable, 1)
      eq('…over both visits read', load.rollup.visits, 2)
      eq('…and the starved visit’s $5,000 is NOT in the authorized figure',
        load.rollup.authorized, 2400)
      eq('…so the blended margin is honest', load.rollup.percent, 52.1)
      eq('…and the cap did not bite', load.truncated, false)
    }
  }
}

// ── 16. MUTATION TESTS ───────────────────────────────────────────────────────
// Each mutation is applied to a COPY of the engine and required to CHANGE
// behaviour. `wrong` states the false answer the mutant produces; if the mutant
// still behaves correctly, the predicate it targets is not load-bearing and the
// section above it is decoration.
//
// ⚠️ A mutation that "isn't caught" is usually a mutation that DIDN'T APPLY — a
// drifted anchor matches nothing and `replace` silently returns the original,
// which then passes every assertion because it IS the real engine. Both failure
// modes are reported explicitly.
console.log('\nMutating the engine — every honesty rule must be load-bearing:')
{
  const enginePath = join(__dirname, '..', 'src', 'lib', 'jobProfit.ts')
  const original = readFileSync(enginePath, 'utf8')
  const srcDir = join(__dirname, '..', 'src').replace(/\\/g, '/')
  const req = createRequire(__filename)

  type Engine = typeof import('../src/lib/jobProfit')
  const reviewWith = (m: Engine, o: Partial<JobProfitInput> = {}) => m.reviewJobProfit({
    job: { id: JOB, status: 'completed', price: 2400 },
    cost: nothingRecorded(),
    ...o,
  })

  const mutations: { name: string; from: string; to: string; wrong: (m: Engine) => boolean }[] = [
    {
      name: 'an incomplete cost is offered up for a margin (unknown labour → $0)',
      from: '    : !p.cost.comparableToRevenue ? \'cost_incomplete\'',
      to: '    : false ? \'cost_incomplete\'',
      wrong: m => reviewWith(m, { cost: labourUnknownCost() }).margin.state === 'known',
    },
    {
      // The realistic regression: not deleting the gate, but WEAKENING it to
      // "we have some cost, that will do". The floor then becomes the total and
      // the margin is overstated by exactly what nobody recorded — $2,150 of
      // "profit" on a visit whose wages are unknown.
      name: 'the completeness gate is weakened to “some cost recorded”',
      from: "    : !p.cost.comparableToRevenue ? 'cost_incomplete'",
      to: '    : p.cost.total.knownAmount <= 0 ? \'cost_incomplete\'',
      wrong: m => {
        const r = m.reviewJobProfit({
          job: { id: JOB, status: 'completed', price: 2400 },
          cost: labourUnknownCost(),
        })
        return r.margin.state === 'known' || r.margin.profit != null
      },
    },
    {
      name: 'an unpriced visit is valued at $0 instead of unknown',
      from: '  if (!(total > 0)) {',
      to: '  if (false) {',
      wrong: m => {
        const r = reviewWith(m, { job: { id: JOB, status: 'completed', price: null }, cost: completeCost() })
        return r.authorized.state === 'known' || r.margin.block !== 'no_price'
      },
    },
    {
      name: 'COLLECTED CASH becomes the margin basis',
      from: '    percent = marginPct(p.authorized.amount, p.cost.total.amount)',
      to: '    percent = marginPct(p.authorized.amount, p.cost.total.amount)',
      // Applied below as a whole-expression swap instead — see the next entry.
      wrong: () => true,
    },
    {
      name: 'the GST-INCLUSIVE total is billed as revenue',
      from: '    amount: totals.discountedSubtotal,',
      to: '    amount: totals.total,',
      wrong: m => reviewWith(m, {
        cost: completeCost(), invoice: invoice(), settings: { gst_percent: 5 },
      }).invoiced.amount === 2520,
    },
    {
      name: 'another invoice’s payments are counted as this visit’s cash',
      from: '  const rows = (input.payments ?? []).filter(p => invoiceId != null && p.invoice_id === invoiceId)',
      to: '  const rows = (input.payments ?? [])',
      wrong: m => reviewWith(m, {
        cost: completeCost(), invoice: invoice(),
        payments: [payment({ amount: 5000, invoice_id: OTHER_INV })],
      }).collected.amount === 5000,
    },
    {
      name: 'another job’s work sessions are counted as this visit’s work',
      from: '  const rows = (input.sessions ?? []).filter(s => s.job_id === input.job.id)',
      to: '  const rows = (input.sessions ?? [])',
      wrong: m => reviewWith(m, {
        cost: completeCost(),
        sessions: [session({ minutes: 480, job_id: OTHER_JOB, user_id: OTHER_USER })],
      }).work.sessions === 1,
    },
    {
      name: 'a credit settlement is counted as cash arriving',
      from: "  const summary = summarizeTransactions(rows)",
      to: "  const summary = { ...summarizeTransactions(rows), net: rows.reduce((s, p) => s + (Number(p.amount) || 0), 0) }",
      wrong: m => reviewWith(m, {
        cost: completeCost(), invoice: invoice({ amount_paid: 2400 }),
        payments: [payment({ amount: 2400, provider: 'credit', method: 'credit' })],
      }).collected.amount === 2400,
    },
    {
      name: 'a failed read falls through to real figures',
      from: '  const failed = input.readFailed === true',
      to: '  const failed = false',
      wrong: m => {
        const r = reviewWith(m, {
          cost: nothingRecorded(), readFailed: true,
          invoice: invoice({ amount_paid: 2400 }), payments: [payment({ amount: 2400 })],
        })
        return r.collected.amount === 2400 || r.invoiced.amount === 2400
      },
    },
    {
      name: 'a cancelled visit is offered up for a margin',
      from: "    : p.job.status === 'cancelled' ? 'cancelled'",
      to: "    : false ? 'cancelled'",
      wrong: m => reviewWith(m, {
        job: { id: JOB, status: 'cancelled', price: 2400 }, cost: completeCost(),
      }).margin.block !== 'cancelled',
    },
    {
      name: 'an unfinished visit is reviewed as a finished one',
      from: "    : p.job.status !== 'completed' ? 'not_finished'",
      to: '    : false ? \'not_finished\'',
      wrong: m => reviewWith(m, {
        job: { id: JOB, status: 'in_progress', price: 2400 }, cost: completeCost(),
      }).margin.state === 'known',
    },
    {
      name: 'a running clock is treated as a finished visit',
      from: "    : p.job.started_at ? 'clock_running'",
      to: '    : false ? \'clock_running\'',
      wrong: m => reviewWith(m, {
        job: { id: JOB, status: 'completed', price: 2400, started_at: '2026-08-01T13:00:00Z' },
        cost: completeCost(),
      }).margin.block !== 'clock_running',
    },
    {
      name: 'a cancelled invoice’s figure is counted as revenue',
      from: "  if (inv.status === 'cancelled') {",
      to: '  if (false) {',
      wrong: m => reviewWith(m, {
        cost: completeCost(), invoice: invoice({ status: 'cancelled' }),
      }).invoiced.amount === 2400,
    },
    {
      name: 'the rollup includes visits with revenue and no cost',
      from: "  const judgeable = unique.filter(r => r.margin.state === 'known')",
      to: '  const judgeable = unique',
      wrong: m => {
        const judged = reviewWith(m, { cost: completeCost() })
        const starved = m.reviewJobProfit({
          job: { id: 'job-9', status: 'completed', price: 5000 },
          cost: readJobActualCost({
            job: { id: 'job-9', status: 'completed' }, expenses: [], timeEntries: [], registrant: false,
          }),
        })
        return m.rollupProfit([judged, starved]).authorized !== 2400
      },
    },
    {
      name: 'the rollup counts one visit twice',
      from: '    if (!r?.jobId || seen.has(r.jobId)) return false',
      to: '    if (!r?.jobId) return false',
      wrong: m => {
        const one = reviewWith(m, { cost: completeCost() })
        return m.rollupProfit([one, one]).authorized === 4800
      },
    },
    {
      name: 'a session total that disagrees with the visit total is called final',
      from: '    disagrees: totals.count > 0 && hasActual && totals.elapsedMinutes !== actual,',
      to: '    disagrees: false,',
      wrong: m => reviewWith(m, {
        job: { id: JOB, status: 'completed', price: 2400, actual_minutes: 900 },
        cost: completeCost(), sessions: [session({ minutes: 600 })],
      }).final === true,
    },
    {
      name: 'a failed session read reports 0 minutes worked',
      from: '  if (failed || input.sessionsFailed) {',
      to: '  if (false) {',
      wrong: m => {
        const r = reviewWith(m, { cost: completeCost(), sessions: [], sessionsFailed: true })
        return r.work.failed === false || r.work.elapsedMinutes === 0
      },
    },
    {
      name: 'the sentence stops naming what is missing',
      from: '  const words = missing.map(k => MISSING_WORD[k])',
      to: '  const words: string[] = []',
      wrong: m => m.marginSentence('cost_incomplete', ['labour'])
        !== 'Margin incomplete — labour cost not recorded.',
    },
    {
      name: 'an invoiced variance is stated as zero when a side is unknown',
      from: '      authorized.amount != null && invoiced.amount != null',
      to: '      true',
      wrong: m => reviewWith(m, { cost: completeCost() }).invoicedVariance !== null,
    },
  ]

  // ⭐⭐ The four the owner named by name. Expressed here rather than in the table
  // above only because each needs a substitution that reads clearly on its own.
  mutations[3] = {
    // Collected cash standing in for authorized revenue. The whole point of
    // keeping the six figures apart, in one mutation.
    name: 'COLLECTED CASH is treated as authorized revenue',
    from: '  const margin = readMargin({ job, cost, authorized, failed })',
    to: '  const margin = readMargin({ job, cost, authorized: { ...authorized, amount: collected.amount }, failed })',
    wrong: m => {
      const paid = reviewWith(m, {
        cost: completeCost(), invoice: invoice({ amount_paid: 2400 }), payments: [payment({ amount: 2400 })],
      })
      const unpaid = reviewWith(m, { cost: completeCost(), invoice: invoice(), payments: [] })
      // Under the mutant, an unpaid visit "loses" its whole cost and a paid one
      // looks normal — the same job, two margins, decided by a cheque.
      return paid.margin.profit !== unpaid.margin.profit
    },
  }
  mutations.push(
    {
      name: 'a DECLINED change order is counted as authorized value',
      from: '  const approvedChanges = fromChange.reduce((s, e) => s + Math.round(Number(e.amount) || 0), 0)',
      to: '  const approvedChanges = fromChange.reduce((s, e) => s + Math.round(Number(e.amount) || 0), 0)'
        + '\n    + (input.changeOrders ?? []).filter(c => c.status === \'declined\').reduce((s, c) => s + (Number(c.amount) || 0), 0)',
      wrong: m => reviewWith(m, {
        job: { id: JOB, status: 'completed', price: 2200 },
        extras: [{ description: 'Approved', amount: 200, changeOrderId: 'co-1' }],
        changeOrders: [{ status: 'approved', amount: 200 }, { status: 'declined', amount: 1500 }],
        cost: completeCost(),
      }).authorized.approvedChanges !== 200,
    },
    {
      name: 'a PENDING change order is added to the authorized total',
      from: '  if (!(total > 0)) {',
      to: '  const total2 = total + (input.changeOrders ?? []).filter(c => c.status === \'pending\')'
        + '.reduce((s, c) => s + (Number(c.amount) || 0), 0)\n  if (!(total2 > 0)) {',
      wrong: m => {
        // The mutant computes an unapproved total; whether it lands in `amount` or
        // merely in the gate, ANY difference from 2400 is the defect.
        const r = reviewWith(m, {
          job: { id: JOB, status: 'completed', price: 2400 },
          changeOrders: [{ status: 'pending', amount: 800 }],
          cost: completeCost(),
        })
        const clean = reviewWith(m, { job: { id: JOB, status: 'completed', price: 2400 }, cost: completeCost() })
        return r.authorized.amount !== 2400 || r.margin.profit !== clean.margin.profit
          // A mutant that changed nothing observable here is still wrong in the
          // one case the gate decides: an unpriced visit made "priced" by money
          // nobody approved.
          || reviewWith(m, {
            job: { id: JOB, status: 'completed', price: null },
            changeOrders: [{ status: 'pending', amount: 800 }],
            cost: completeCost(),
          }).authorized.state === 'known'
      },
    },
    {
      name: 'LABOUR IS PRICED TWICE — once from the wage clock, once from session minutes',
      from: '  const margin = readMargin({ job, cost, authorized, failed })',
      to: '  const margin = readMargin({ job, cost: { ...cost, total: { ...cost.total,'
        + ' amount: (cost.total.amount ?? 0) + (work.labourMinutes ?? 0) / 60 * 30 } }, authorized, failed })',
      wrong: m => reviewWith(m, {
        job: { id: JOB, status: 'completed', price: 2400, actual_minutes: 1800 },
        cost: completeCost(), sessions: [session({ minutes: 1800, workers: 1 })],
      }).margin.profit !== 1250,
    },
  )

  for (const m of mutations) {
    if (!original.includes(m.from)) {
      fail(`mutation "${m.name}" could not be applied`,
        `the anchor text is no longer in src/lib/jobProfit.ts, so this mutation tests nothing:\n      ${m.from}`)
      continue
    }
    const mutated = original.replace(m.from, m.to)
    if (mutated === original) {
      fail(`mutation "${m.name}" changed nothing`, 'the replacement is identical to the original')
      continue
    }

    // The engine is pure, so the mutant is written to a throwaway file and
    // imported fresh. Nothing under src/ is touched. `@/…` specifiers are
    // rewritten to absolute paths because tsconfig's alias does not apply
    // outside the project root; the modules they resolve to are the REAL ones,
    // so only jobProfit.ts is mutated.
    const dir = mkdtempSync(join(tmpdir(), 'jobprofit-mutant-'))
    const file = join(dir, 'jobProfit.ts')
    writeFileSync(file, mutated.replace(/from '@\/([^']+)'/g, (_x, p) => `from '${srcDir}/${p}'`), 'utf8')

    let observed: boolean
    try {
      observed = m.wrong(req(file) as Engine)
    } catch {
      // A mutant that throws (or fails to compile) is a mutant that visibly
      // broke — which is what a load-bearing predicate should do.
      observed = true
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }

    check(`caught: ${m.name}`, observed,
      'the mutant produced the SAME answer as the real engine — the predicate it targets is not load-bearing')
  }
}

// ── Result ───────────────────────────────────────────────────────────────────
// The async loader section runs LAST and the verdict is printed inside the same
// block, so the exit code always covers every check — see loaderSection's note.
void (async () => {
  await loaderSection()
  console.log(`\n${failures === 0 ? '✓ job profit refuses every margin the data cannot support' : `✗ ${failures} check(s) failed`}\n`)
  if (failures > 0) process.exit(1)
})()
