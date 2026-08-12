// ── Verify: actual job cost never invents a figure ───────────────────────────
//   npm run verify:job-cost
//
// WHY THIS SCRIPT EXISTS
// Every failure mode of a job-costing feature is a number that is arithmetically
// valid and quietly false, and every one of them is FLATTERING:
//
//   * a visit with no receipts costing $0 → 100% margin on the whole book
//   * a category nobody recorded collapsing into 0 inside an otherwise real total
//   * a partial cost printed as "Total", so profit is overstated by exactly the
//     categories nobody wrote down
//   * a failed query rendering as "this visit cost nothing"
//   * clocked hours with no pay rate summing to 0 instead of "unknown" — the live
//     shape here, since BOTH technicians in production have hourly_wage NULL
//   * a historical visit repriced by today's wage the moment someone gets a raise
//   * an estimate (quote line, template material_cost, crew_cost_per_hour ×
//     minutes) quietly becoming an ACTUAL, which would make every job look
//     perfectly predicted and destroy the only signal this lane creates
//   * a capital purchase or an owner draw tagged to a visit and counted as that
//     visit's cost
//   * an expense attached to ANOTHER BUSINESS's job — accepted by the database
//     until 2026-08-11, because RLS proved who owned the expense and the foreign
//     key proved the job existed, and nothing proved they were the same tenant
//
// Runs the REAL modules against hand-derived fixtures. Deterministic, no network.
// The final section MUTATES the engine's own source and re-runs the suite, so a
// guard that would pass against a broken predicate fails loudly here instead.

import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import type { ExpenseWithRelations, TimeEntry } from '../src/types'
import {
  readJobActualCost, costCoverage, toActualCostFacts, describeCost, formatCost,
  isMaterialsExpense, countsAsJobCost, MATERIALS_CATEGORY_NAME,
  costCapturePrompt,
  type JobCostInput,
} from '../src/lib/jobCost'

let failures = 0
const ok = (name: string) => console.log(`  ✓ ${name}`)
const fail = (name: string, detail: string) => { failures++; console.log(`  ✗ ${name}\n      ${detail}`) }
const check = (name: string, cond: boolean, detail = '') => (cond ? ok(name) : fail(name, detail))
const eq = (name: string, actual: unknown, expected: unknown) =>
  check(name, Object.is(actual, expected), `expected ${String(expected)}, got ${String(actual)}`)

const JOB = 'job-1'

// ── Fixtures ─────────────────────────────────────────────────────────────────

const expense = (o: Partial<ExpenseWithRelations> & { amount: number }): ExpenseWithRelations => ({
  id: `e${Math.random().toString(36).slice(2, 9)}`,
  created_at: '2026-08-01T00:00:00Z', updated_at: '2026-08-01T00:00:00Z',
  user_id: 'u1', vendor_id: null, category_id: null, job_id: JOB,
  tax_amount: 0, spent_at: '2026-08-01', description: null, payment_method: null,
  reference: null, receipt_path: null, notes: null, archived_at: null,
  bill_date: '2026-08-01', is_capital: false,
  ...o,
} as ExpenseWithRelations)

const withCategory = (
  e: ExpenseWithRelations,
  name: string,
  kind: 'operating' | 'owner_draw' = 'operating',
): ExpenseWithRelations => ({
  ...e,
  expense_categories: { id: 'c1', name, tax_deductible: true, kind, external_account: null },
})

const shift = (o: Partial<TimeEntry> = {}): TimeEntry => ({
  id: `t${Math.random().toString(36).slice(2, 9)}`,
  created_at: '2026-08-01T00:00:00Z', updated_at: '2026-08-01T00:00:00Z',
  user_id: 'u1', technician_id: 'tech-1', job_id: JOB,
  clock_in: '2026-08-01T13:00:00Z', clock_out: '2026-08-01T15:00:00Z',
  break_minutes: 0, hourly_rate: 30, notes: null, minutes_worked: 120,
  ...o,
} as TimeEntry)

const read = (o: Partial<JobCostInput> = {}) => readJobActualCost({
  job: { id: JOB, status: 'completed', actual_minutes: 120, crew_size: 2 },
  expenses: [], timeEntries: [], registrant: false,
  ...o,
})

// ── 1. THE PRODUCTION STATE: EVERYTHING UNKNOWN, NOTHING ZERO ────────────────
// 223 jobs, 79 completed, 0 expenses, 0 time entries. This is what the engine
// had to say about every visit in the book on the day it shipped.
console.log('\nA visit with nothing recorded — the state of the entire production book:')
{
  const c = read()
  eq('total is unknown, not 0', c.total.state, 'unknown')
  eq('…and carries NO amount', c.total.amount, null)
  eq('…labour is unknown', c.labour.state, 'unknown')
  eq('…materials is unknown', c.materials.state, 'unknown')
  eq('…other is unknown', c.other.state, 'unknown')
  eq('…completeness is none', c.completeness, 'none')
  check('…every category amount is null, none of them 0',
    [c.labour, c.materials, c.other].every(l => l.amount === null),
    JSON.stringify([c.labour.amount, c.materials.amount, c.other.amount]))
  eq('…the sentence says so in words', describeCost(c), 'No costs recorded for this visit')
  check('…and no margin may be derived from it', c.comparableToRevenue === false)
}

// ── 2. NO RECEIPT IN A CATEGORY ≠ NOTHING SPENT IN IT ────────────────────────
// The owner's own example: $185 of mulch on a landscape renovation, nothing else
// recorded. The visit did NOT cost $185.
console.log('\n$185 of mulch and nothing else — the floor, never the total:')
{
  const c = read({ expenses: [withCategory(expense({ amount: 185, description: '6 yd mulch' }), 'Materials')] })
  eq('materials is known', c.materials.state, 'known')
  eq('…at $185', c.materials.amount, 185)
  eq('…labour stays unknown', c.labour.state, 'unknown')
  eq('…other stays unknown', c.other.state, 'unknown')
  eq('…so the TOTAL is incomplete', c.total.state, 'incomplete')
  eq('…and total.amount is null — there is no total to give', c.total.amount, null)
  eq('…the known subtotal is carried separately', c.total.knownAmount, 185)
  check('…and the sentence says "At least", naming what is missing',
    describeCost(c) === 'At least $185.00 — labour and other costs not recorded',
    describeCost(c))
  eq('…completeness is partial', c.completeness, 'partial')
  check('…no margin may be derived from a partial cost', c.comparableToRevenue === false)
}

// ── 3. A COMPLETE COST IS ALLOWED TO BE A TOTAL ──────────────────────────────
console.log('\nAll three categories answered — and only then is there a total:')
{
  const c = read({
    expenses: [
      withCategory(expense({ amount: 185 }), 'Materials'),
      withCategory(expense({ amount: 40 }), 'Fuel'),
    ],
    timeEntries: [shift({ hourly_rate: 30 })], // 2h × $30 = $60
  })
  eq('labour known', c.labour.amount, 60)
  eq('materials known', c.materials.amount, 185)
  eq('other known', c.other.amount, 40)
  eq('total state is known', c.total.state, 'known')
  eq('…and NOW amount is populated', c.total.amount, 285)
  eq('…completeness complete', c.completeness, 'complete')
  check('…and only now may a margin be derived', c.comparableToRevenue === true)
  eq('…the sentence names the total', describeCost(c), 'Cost $285.00')
}

// ── 4. A PARTLY-PRICED CLOCK IS NOT A CHEAP JOB ──────────────────────────────
// THE live shape: both production technicians have hourly_wage NULL, so every
// shift they ever clock will carry hourly_rate NULL. lib/timeTracking.entryCost
// returns 0 for those (correct for a timesheet). Inheriting that 0 here would
// report a labour cost short by exactly the hours nobody priced.
console.log('\nHours with no pay rate are UNKNOWN labour, never cheap labour:')
{
  const c = read({ timeEntries: [shift({ hourly_rate: null })] })
  eq('labour is unknown', c.labour.state, 'unknown')
  eq('…because no rate was stamped', c.labour.reason, 'no_rate')
  eq('…and it is NOT $0', c.labour.amount, null)
}
{
  // The nastier half: one priced shift and one not. Summing only the priced one
  // would produce a confident, wrong $60.
  const c = read({ timeEntries: [shift({ hourly_rate: 30 }), shift({ hourly_rate: null })] })
  eq('one priced shift + one unpriced = unknown', c.labour.state, 'unknown')
  eq('…reason is no_rate', c.labour.reason, 'no_rate')
  eq('…the priced half is NOT reported on its own', c.labour.amount, null)
}

// ── 5. HISTORICAL RATES ONLY ─────────────────────────────────────────────────
// The rate lives on the SHIFT (snapshot at clock-in), never on the technician.
// A raise must not reprice work already done.
console.log('\nA raise cannot rewrite what past work cost:')
{
  const march = read({ timeEntries: [shift({ hourly_rate: 22 })] })
  eq('March shift priced at its OWN $22 rate', march.labour.amount, 44)
  const source = readFileSync(join(__dirname, '..', 'src', 'lib', 'jobCost.ts'), 'utf8')
  check('…and the engine never reads technicians.hourly_wage',
    !/hourly_wage/.test(source.replace(/^\s*\/\/.*$/gm, '')),
    'jobCost.ts references hourly_wage outside comments — the live wage must never price history')
  check('…the only rate it reads is the shift snapshot',
    /hourly_rate/.test(source), 'expected hourly_rate to be the rate source')
}

// ── 6. ESTIMATED MATERIALS DO NOT BECOME ACTUAL ONES ─────────────────────────
// The engine takes expenses and time entries. It has no way to see a quote, a
// template's material_cost, job_line_items or crew_cost_per_hour — and that is
// enforced here rather than trusted, because a single import would undo it.
console.log('\nNo estimate can leak into an actual:')
{
  const source = readFileSync(join(__dirname, '..', 'src', 'lib', 'jobCost.ts'), 'utf8')
  const code = source.replace(/^\s*\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '')
  for (const forbidden of [
    'crew_cost_per_hour', 'material_cost', 'unit_cost', 'job_line_items',
    'quote_items', 'economics', 'visitEconomics', 'duration_minutes',
  ]) {
    check(`…the engine never touches ${forbidden}`, !code.includes(forbidden),
      `jobCost.ts references ${forbidden} — an estimate is being read into an actual cost`)
  }
  const loader = readFileSync(join(__dirname, '..', 'src', 'lib', 'jobCostData.ts'), 'utf8')
    .replace(/^\s*\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '')
  check('…and the loader reads only expenses, time_entries, settings and jobs',
    !/service_templates|quote_items|job_line_items/.test(loader),
    'jobCostData.ts reads an estimate table')
}

// ── 7. A FAILED READ IS NOT A ZERO ───────────────────────────────────────────
console.log('\nA query that failed is not a visit that cost nothing:')
{
  const c = read({ readFailed: true, expenses: [withCategory(expense({ amount: 185 }), 'Materials')] })
  eq('total unknown', c.total.state, 'unknown')
  eq('…amount null', c.total.amount, null)
  eq('…knownAmount is 0 but no category claims to be known', c.total.knownAmount, 0)
  eq('…and every category says WHY', c.labour.reason, 'read_failed')
  check('…even though rows were handed in, none of them were counted',
    c.materials.state === 'unknown' && c.materials.amount === null,
    'a failed read counted the rows it was given')
}

// ── 8. WHAT IS NOT A COST OF THIS VISIT ──────────────────────────────────────
// A $4,000 mower bought on the way to a job is an asset, not what that hour of
// mowing cost. An owner draw is a distribution of profit, not a cost of earning
// it. Both are excluded — and REPORTED, never silently subtracted.
console.log('\nCapital and owner draws are not this visit’s cost:')
{
  const mower = withCategory(expense({ amount: 4000, is_capital: true }), 'Equipment')
  const draw = withCategory(expense({ amount: 500 }), 'Owner draw', 'owner_draw')
  const mulch = withCategory(expense({ amount: 185 }), 'Materials')
  check('a capital row does not count', !countsAsJobCost(mower))
  check('an owner draw does not count', !countsAsJobCost(draw))
  check('ordinary spend does count', countsAsJobCost(mulch))

  const c = read({ expenses: [mower, draw, mulch] })
  eq('…so the visit is not charged $4,685', c.total.knownAmount, 185)
  eq('…materials is the mulch alone', c.materials.amount, 185)
  eq('…other is unknown, NOT $4,500', c.other.state, 'unknown')
  eq('…and the excluded rows are reported, not hidden', c.excluded.count, 2)
  eq('…with their amount', c.excluded.amount, 4500)
}

// ── 9. THE MATERIALS SPLIT READS THE OWNER'S OWN CLASSIFICATION ──────────────
console.log('\nMaterials is the category the owner picked — never a guess:')
{
  check('the seeded "Materials" category is materials',
    isMaterialsExpense(withCategory(expense({ amount: 10 }), 'Materials')))
  check('…case and spacing do not matter',
    isMaterialsExpense(withCategory(expense({ amount: 10 }), '  materials ')))
  check('…"Fuel" is not materials',
    !isMaterialsExpense(withCategory(expense({ amount: 10 }), 'Fuel')))
  check('…an UNCATEGORISED row is not materials',
    !isMaterialsExpense(expense({ amount: 10 })),
    'an unclassified receipt was guessed into the materials bucket')
  eq('…and the constant is the seeded name', MATERIALS_CATEGORY_NAME, 'materials')

  // Renaming the category must move the row to `other` and leave the TOTAL alone.
  const renamed = read({
    expenses: [withCategory(expense({ amount: 185 }), 'Supplies & materials')],
    timeEntries: [shift()],
  })
  eq('a renamed category lands in other', renamed.other.amount, 185)
  eq('…materials becomes unknown', renamed.materials.state, 'unknown')
  eq('…and the KNOWN subtotal is unchanged', renamed.total.knownAmount, 245)
}

// ── 10. LABOUR HOURS: THE CLOCK IS A RECORD, CREW SIZE IS A PLAN ─────────────
// 36 production visits have actual_minutes and 0 have time entries, so the
// derived branch is the ONLY one with data today. It must never price itself.
console.log('\nHours are reported with their source, and only the clock may be priced:')
{
  const derived = read()
  eq('with no shifts, hours come from the visit', derived.labourTime.source, 'visit')
  eq('…120 minutes on site × 2 crew = 240 person-minutes', derived.labourTime.personMinutes, 240)
  eq('…and labour COST is still unknown', derived.labour.state, 'unknown')
  eq('…because nothing was recorded, not because it was free', derived.labour.reason, 'nothing_recorded')

  const clocked = read({ timeEntries: [shift(), shift({ technician_id: 'tech-2' })] })
  eq('with shifts, the clock wins', clocked.labourTime.source, 'clock')
  eq('…240 clocked person-minutes', clocked.labourTime.personMinutes, 240)
  eq('…and crewSize is not claimed', clocked.labourTime.crewSize, null)

  const open = read({ timeEntries: [shift({ clock_out: null, minutes_worked: null })] })
  eq('an OPEN shift has no duration yet, so it is not a clock source', open.labourTime.source, 'visit')
  eq('…and labour is unknown, not a running total', open.labour.state, 'unknown')

  const nothing = read({ job: { id: JOB, status: 'completed', actual_minutes: null, crew_size: 2 } })
  eq('no clock and no stopwatch = no hours', nothing.labourTime.personMinutes, null)
  eq('…and no source is claimed', nothing.labourTime.source, null)
}

// ── 11. A CANCELLED VISIT ────────────────────────────────────────────────────
// Money spent is money spent, but there is no revenue to compare it against.
console.log('\nA cancelled visit still cost money, and still has no margin:')
{
  const c = read({
    job: { id: JOB, status: 'cancelled', actual_minutes: 120, crew_size: 1 },
    expenses: [withCategory(expense({ amount: 185 }), 'Materials'), withCategory(expense({ amount: 20 }), 'Fuel')],
    timeEntries: [shift()],
  })
  eq('the spend is still reported', c.total.state, 'known')
  eq('…at the full amount', c.total.amount, 265)
  check('…but it is NOT comparable to revenue', c.comparableToRevenue === false,
    'a cancelled visit was made available for a margin calculation')
  eq('…and the prompt stays silent', costCapturePrompt({ cost: c, status: 'cancelled', pricedPeers: 9 }), null)
}

// ── 12. NOTHING BELONGING TO ANOTHER JOB IS COUNTED ──────────────────────────
console.log('\nOnly rows pointing at THIS visit are counted:')
{
  const c = read({
    expenses: [
      withCategory(expense({ amount: 185, job_id: 'other-job' }), 'Materials'),
      withCategory(expense({ amount: 40, job_id: null }), 'Fuel'),
    ],
    timeEntries: [shift({ job_id: 'other-job' }), shift({ job_id: null })],
  })
  eq('another visit’s receipt is not ours', c.materials.state, 'unknown')
  eq('…untagged overhead is not ours either', c.other.state, 'unknown')
  eq('…and another visit’s shift is not ours', c.labour.state, 'unknown')
  eq('…nor is untagged general time', c.labour.amount, null)
  eq('…so the whole visit stays unknown', c.total.state, 'unknown')
}

// ── 13. DUPLICATES CANNOT DOUBLE-COUNT A VISIT ───────────────────────────────
// Two identical receipts ARE two receipts (buying mulch twice is real), but one
// VISIT must never be counted twice in coverage.
console.log('\nOne visit votes once:')
{
  const c = read({ expenses: [withCategory(expense({ amount: 20 }), 'Fuel'), withCategory(expense({ amount: 20 }), 'Fuel')] })
  eq('two real receipts sum to $40 — not deduplicated', c.other.amount, 40)
  eq('…and both are counted as sources', c.other.sources, 2)

  const one = read({ expenses: [withCategory(expense({ amount: 20 }), 'Fuel')], timeEntries: [shift()] })
  const cov = costCoverage([
    { status: 'completed', cost: one },
    { status: 'completed', cost: one },   // the same visit, seen twice
  ])
  eq('the same visit twice counts once', cov.visits, 1)
  eq('…completed once', cov.completed, 1)
  eq('…and with-any-cost once', cov.withAnyCost, 1)
}

// ── 14. COVERAGE NEVER FLATTERS AN EMPTY BOOK ────────────────────────────────
console.log('\nCoverage: 0/0 is unknown, not 0%:')
{
  const empty = costCoverage([])
  eq('no visits → percentage is null', empty.completePctOfCompleted, null)
  eq('…and counts are 0', empty.completed, 0)

  const c = costCoverage([
    { status: 'completed', cost: read({ expenses: [withCategory(expense({ amount: 5 }), 'Fuel')] }) },
    { status: 'completed', cost: read({ job: { id: 'j2', status: 'completed' } }) },
    { status: 'scheduled', cost: read({ job: { id: 'j3', status: 'scheduled' } }) },
  ])
  eq('3 visits', c.visits, 3)
  eq('…2 completed', c.completed, 2)
  eq('…1 with any cost', c.withAnyCost, 1)
  eq('…0 complete, because none has all three', c.withCompleteCost, 0)
  eq('…so 0% of completed visits can carry a margin', c.completePctOfCompleted, 0)
}

// ── 15. THE PROMPT IS LEARNED, NOT ASSUMED ───────────────────────────────────
// A weekly mow has no materials and no receipt. Asking after every cut trains the
// owner to dismiss the prompt, after which it cannot warn about anything.
console.log('\nThe "costs not recorded" prompt only fires where their own history earns it:')
{
  const bare = read()
  eq('a brand-new account is never nagged', costCapturePrompt({ cost: bare, status: 'completed', pricedPeers: 0 }), null)
  check('…but a service that normally has costs is flagged',
    costCapturePrompt({ cost: bare, status: 'completed', pricedPeers: 4 })
      === 'Actual costs not recorded — similar visits usually have some.')
  eq('…an unfinished visit is never nagged',
    costCapturePrompt({ cost: bare, status: 'scheduled', pricedPeers: 9 }), null)

  const full = read({
    expenses: [withCategory(expense({ amount: 185 }), 'Materials'), withCategory(expense({ amount: 5 }), 'Fuel')],
    timeEntries: [shift()],
  })
  eq('…and a complete cost is never nagged',
    costCapturePrompt({ cost: full, status: 'completed', pricedPeers: 9 }), null)
}

// ── 16. THE SESSION 15 SEAM ──────────────────────────────────────────────────
// The learning engine's rule is "unknown stays unknown". The projection must hand
// it nulls, never zeroes.
console.log('\nThe facts handed to profit intelligence keep unknown as unknown:')
{
  const f = toActualCostFacts(read({ expenses: [withCategory(expense({ amount: 185 }), 'Materials')] }))
  eq('labour cost is null', f.actualLabourCost, null)
  eq('…and flagged not-known', f.actualLabourCostKnown, false)
  eq('material cost is 185', f.actualMaterialCost, 185)
  eq('…and flagged known', f.actualMaterialCostKnown, true)
  eq('other cost is null', f.actualOtherCost, null)
  eq('total is null', f.actualTotalCost, null)
  eq('…and flagged not-known', f.actualTotalCostKnown, false)
  eq('hours carry their provenance', f.actualLabourMinutesSource, 'visit')
  check('every *Cost field is a number or null — never undefined, never 0-for-unknown',
    ([f.actualLabourCost, f.actualMaterialCost, f.actualOtherCost, f.actualTotalCost] as unknown[])
      .every(v => v === null || typeof v === 'number'))
}

// ── 17. FORMATTING CANNOT MANUFACTURE A FIGURE ───────────────────────────────
console.log('\nUnknown cannot be formatted into a number:')
{
  eq('null formats as a dash', formatCost(null), '—')
  eq('NaN formats as a dash', formatCost(NaN), '—')
  eq('a real 0 formats as $0.00 — a recorded free job is a fact', formatCost(0), '$0.00')
  eq('and money formats to 2dp', formatCost(185.5), '$185.50')
}

// ── 18. TENANCY IS ENFORCED BY THE DATABASE, NOT BY THIS CODE ────────────────
// The engine is pure and cannot check ownership; the constraint has to exist in
// the schema. Before 2026-08-11 a signed-in Business A could insert an expense
// with its own user_id and Business B's job_id: RLS proved who owned the expense,
// the single-column foreign key proved the job existed, and NOTHING proved they
// were the same tenant. Probed against production — the insert was accepted.
console.log('\nThe migration that makes a cross-tenant cost impossible is present:')
{
  const sql = readFileSync(
    join(__dirname, '..', 'supabase', 'RUN-2026-08-11c-job-cost-tenancy.sql'), 'utf8')
  const code = sql.replace(/^\s*--.*$/gm, '')
  check('jobs carries the referenceable (id, user_id) key',
    /add constraint jobs_id_user_key unique \(id, user_id\)/i.test(code))
  for (const table of ['expenses', 'time_entries', 'job_line_items']) {
    check(`${table}.job_id references jobs(id, user_id) — both columns`,
      new RegExp(`alter table public\\.${table}[\\s\\S]{0,400}?foreign key \\(job_id, user_id\\) references public\\.jobs\\(id, user_id\\)`, 'i').test(code),
      `${table} still has a single-column job foreign key — another tenant's job can be named`)
    check(`…and the old single-column ${table} constraint is dropped`,
      new RegExp(`drop constraint if exists ${table}_job_id_fkey`, 'i').test(code),
      'the weak constraint would survive alongside the strong one')
  }
  check('every new constraint is VALIDATEd, not left NOT VALID',
    (code.match(/validate constraint \w+_job_same_owner/gi) || []).length === 3,
    'a NOT VALID constraint checks new rows only — existing rows stay unchecked')
  check('the deletion rules are preserved per table',
    /expenses[\s\S]{0,400}?on delete set null \(job_id\)/i.test(code)
      && /job_line_items[\s\S]{0,400}?on delete cascade/i.test(code),
    'a deletion rule changed — an expense must survive its job, an extra must not')
}

// ── 19. THE LOADER TREATS FAILURE AS FAILURE ─────────────────────────────────
console.log('\nThe loader distinguishes "no costs" from "could not look":')
{
  const src = readFileSync(join(__dirname, '..', 'src', 'lib', 'jobCostData.ts'), 'utf8')
  const code = src.replace(/^\s*\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '')
  check('an empty user id is a failure, not an empty result',
    /if \(!userId\) return failed\(/.test(code))
  check('…a PostgREST error is a failure', /if \(\w+Res\.error\) return failed\(/.test(code))
  check('…a null payload with no error is ALSO a failure',
    /!Array\.isArray\([\s\S]{0,40}?\) *\) return failed\(/.test(code),
    'a null data payload would fall through as "no receipts"')
  check('…a failed settings read fails the whole cost read',
    /settingsRes\.error\) return failed/.test(code),
    'guessing GST registration would move every figure by the tax')
  check('…and the failure path still feeds readFailed into the engine',
    /readFailed: true/.test(code),
    'a caller that ignores the outcome must still get unknowns, not zeroes')
  check('every query is scoped by user_id',
    (code.match(/\.eq\('user_id', userId\)/g) || []).length >= 4,
    'an unscoped read is the tenancy bug itself')
}

// ── 20. THE PANEL NEVER PRINTS A PARTIAL COST AS A TOTAL ─────────────────────
console.log('\nThe surface reads the contract rather than re-deriving it:')
{
  const ui = readFileSync(join(__dirname, '..', 'src', 'components', 'jobs', 'JobCostPanel.tsx'), 'utf8')
  const code = ui.replace(/^\s*\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '').replace(/\{\/\*[\s\S]*?\*\/\}/g, '')
  check('the headline comes from describeCost, not from local arithmetic',
    /describeCost\(cost\)/.test(code))
  check('…the panel never reads total.knownAmount as if it were the total',
    !/total\.knownAmount/.test(code),
    'the floor is being rendered directly — it will be read as a total')
  check('…an unknown category renders its REASON',
    /UNKNOWN_REASON_LABEL\[line\.reason/.test(code))
  check('…the undo branches on its write’s error',
    /undoError\) \{ toast\.error/.test(code),
    'a silent failed undo is the UI lying about the outcome')
  check('…and nothing here reads an estimate',
    !/(crew_cost_per_hour|material_cost|job_line_items|duration_minutes)/.test(code),
    'an estimate is being shown as an actual cost')
}

// ── 21. MUTATION TESTS ───────────────────────────────────────────────────────
// Every check above passes against the real engine. These prove the checks would
// FAIL against a broken one — a guard that cannot fail is not a guard. Each
// mutation is the specific way a costing engine goes wrong in production.
console.log('\nMutation tests — breaking each predicate must break the suite:')
{
  const enginePath = join(__dirname, '..', 'src', 'lib', 'jobCost.ts')
  // ⚠️ Normalised to \n before anything is matched against it. Git hands this
  // file to a Windows checkout as CRLF, and every `from:` anchor below is
  // written with \n — so `includes()` finds NOTHING and all six mutations
  // report "could not be applied". That is red on Windows and green in CI, for
  // reasons that have nothing to do with the code under test. Writing the
  // mutant back with \n is harmless: it is a temp copy that tsx parses and
  // deletes. Same fix, same reason, as verify-attribution's `read()`.
  const original = readFileSync(enginePath, 'utf8').replace(/\r\n?/g, '\n')

  // The assertion is handed the MUTANT's own exports. Closing over the real
  // module's functions instead would test the real engine, and every mutation
  // would "survive" — a mutation suite that always passes is worse than none,
  // because it certifies the guards above as load-bearing when they are not.
  type Engine = typeof import('../src/lib/jobCost')
  const readWith = (m: Engine, o: Partial<JobCostInput> = {}) => m.readJobActualCost({
    job: { id: JOB, status: 'completed', actual_minutes: 120, crew_size: 2 },
    expenses: [], timeEntries: [], registrant: false,
    ...o,
  })

  const mutations: { name: string; from: string; to: string; wrong: (m: Engine) => boolean }[] = [
    {
      name: 'unknown collapses to 0 — an empty category sums as zero',
      from: "  const materials = materialRows.length\n    ? knownLine('materials', sumCost(materialRows, registrant), materialRows.length)\n    : unknownLine('materials', 'nothing_recorded')",
      to: "  const materials = knownLine('materials', sumCost(materialRows, registrant), materialRows.length)",
      wrong: m => {
        const c = readWith(m)
        return c.materials.state === 'known' && c.materials.amount === 0
      },
    },
    {
      name: 'the floor becomes the total — a partial cost gets an amount',
      from: "      amount: state === 'known' ? knownAmount : null,",
      to: '      amount: knownAmount,',
      wrong: m => readWith(m, { expenses: [withCategory(expense({ amount: 185 }), 'Materials')] }).total.amount === 185,
    },
    {
      name: 'a rateless shift is priced at 0 instead of unknown',
      from: "  if (shifts.some(e => e.hourly_rate == null)) return unknownLine('labour', 'no_rate')",
      to: '',
      wrong: m => readWith(m, { timeEntries: [shift({ hourly_rate: null })] }).labour.amount === 0,
    },
    {
      name: 'a failed read counts the rows it was handed',
      from: '  if (input.readFailed) {',
      to: '  if (false) {',
      wrong: m => readWith(m, { readFailed: true, expenses: [withCategory(expense({ amount: 185 }), 'Materials')] })
        .materials.amount === 185,
    },
    {
      name: 'capital and owner draws are charged to the visit',
      from: '  return !isCapital(e) && !isOwnerDraw(e)',
      to: '  return true',
      wrong: m => readWith(m, {
        expenses: [withCategory(expense({ amount: 4000, is_capital: true }), 'Equipment')],
      }).other.amount === 4000,
    },
    {
      name: 'another job’s receipts are counted as this visit’s',
      from: '  const tagged = input.expenses.filter(e => e.job_id === jobId)',
      to: '  const tagged = input.expenses',
      wrong: m => readWith(m, {
        expenses: [withCategory(expense({ amount: 185, job_id: 'other-job' }), 'Materials')],
      }).materials.amount === 185,
    },
    {
      name: 'derived visit-minutes are presented as clocked ones',
      from: "    return { personMinutes: visitMinutes * crewSize, source: 'visit', visitMinutes, crewSize, shifts: 0 }",
      to: "    return { personMinutes: visitMinutes * crewSize, source: 'clock', visitMinutes, crewSize, shifts: 0 }",
      wrong: m => readWith(m).labourTime.source === 'clock',
    },
    {
      name: 'an uncategorised receipt is guessed into materials',
      from: "  return typeof name === 'string' && name.trim().toLowerCase() === MATERIALS_CATEGORY_NAME",
      to: '  return name == null || name.trim().toLowerCase() === MATERIALS_CATEGORY_NAME',
      wrong: m => m.isMaterialsExpense(expense({ amount: 10 })),
    },
    {
      name: 'a cancelled visit is offered up for a margin',
      from: "    comparableToRevenue: p.status === 'completed' && state === 'known',",
      to: "    comparableToRevenue: state === 'known',",
      wrong: m => readWith(m, {
        job: { id: JOB, status: 'cancelled' },
        expenses: [withCategory(expense({ amount: 185 }), 'Materials'), withCategory(expense({ amount: 5 }), 'Fuel')],
        timeEntries: [shift()],
      }).comparableToRevenue === true,
    },
    {
      name: 'a partial cost is offered up for a margin',
      from: "    comparableToRevenue: p.status === 'completed' && state === 'known',",
      to: "    comparableToRevenue: p.status === 'completed',",
      wrong: m => readWith(m, { expenses: [withCategory(expense({ amount: 185 }), 'Materials')] }).comparableToRevenue === true,
    },
    {
      name: 'coverage counts one visit twice',
      from: '    if (!id || seen.has(id)) return false',
      to: '    if (!id) return false',
      wrong: m => {
        const one = readWith(m, { expenses: [withCategory(expense({ amount: 5 }), 'Fuel')] })
        return m.costCoverage([{ status: 'completed', cost: one }, { status: 'completed', cost: one }]).visits === 2
      },
    },
    {
      name: 'an empty book reports 0% instead of unknown',
      from: '    completePctOfCompleted: completed.length',
      to: '    completePctOfCompleted: true',
      // The mutant divides 0 by 0 and reports NaN — not 0. Asserting `=== 0`
      // would let it survive, so the claim is the one that actually matters:
      // an empty book must yield NULL, and anything else is a figure invented
      // about a business with no completed work.
      wrong: m => m.costCoverage([]).completePctOfCompleted !== null,
    },
    {
      name: 'the prompt nags every visit regardless of history',
      from: '  if (p.pricedPeers < 1) return null',
      to: '',
      wrong: m => m.costCapturePrompt({ cost: readWith(m), status: 'completed', pricedPeers: 0 }) !== null,
    },
    {
      name: 'the Session 15 projection emits 0 for an unknown cost',
      from: '    actualLabourCost: c.labour.amount,',
      to: '    actualLabourCost: c.labour.amount ?? 0,',
      wrong: m => m.toActualCostFacts(readWith(m)).actualLabourCost === 0,
    },
    {
      name: 'an open shift is treated as a closed one',
      from: '  const shifts = input.timeEntries.filter(e => e.job_id === jobId && !isOpen(e))',
      to: '  const shifts = input.timeEntries.filter(e => e.job_id === jobId)',
      wrong: m => readWith(m, { timeEntries: [shift({ clock_out: null, minutes_worked: null })] })
        .labourTime.source === 'clock',
    },
  ]

  // Each mutation is applied to a COPY of the source and required to CHANGE
  // behaviour. `wrong` states the false answer the mutant produces; if the mutant
  // still behaves correctly, the predicate it targets is not load-bearing and the
  // check above it is decoration.
  //
  // ⚠️ A mutation that "isn't caught" is usually a mutation that DIDN'T APPLY —
  // an anchor string that drifted matches nothing and `replace` silently returns
  // the original, which then passes every assertion because it IS the real
  // engine. Both failure modes are reported explicitly below rather than being
  // allowed to look like a pass.
  const srcDir = join(__dirname, '..', 'src').replace(/\\/g, '/')
  const req = createRequire(__filename)

  for (const m of mutations) {
    if (!original.includes(m.from)) {
      fail(`mutation "${m.name}" could not be applied`,
        `the anchor text is no longer in src/lib/jobCost.ts, so this mutation tests nothing:\n      ${m.from}`)
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
    // so only jobCost.ts is mutated.
    const dir = mkdtempSync(join(tmpdir(), 'jobcost-mutant-'))
    const file = join(dir, 'jobCost.ts')
    writeFileSync(file, mutated.replace(/from '@\/([^']+)'/g, (_x, p) => `from '${srcDir}/${p}'`), 'utf8')

    let observed: boolean
    try {
      observed = m.wrong(req(file) as typeof import('../src/lib/jobCost'))
    } catch {
      // A mutant that throws (or fails to compile) is a mutant that visibly
      // broke — which is exactly what a load-bearing predicate should do.
      observed = true
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }

    check(`caught: ${m.name}`, observed,
      'the mutant produced the SAME answer as the real engine — the predicate it targets is not load-bearing')
  }
}

// ── Result ───────────────────────────────────────────────────────────────────
console.log(`\n${failures === 0 ? '✓ job cost is honest about what it does not know' : `✗ ${failures} check(s) failed`}\n`)
if (failures > 0) process.exit(1)
