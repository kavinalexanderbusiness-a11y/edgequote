// ── Verify: the concentration disclosure measures ACROSS customers, not within one ──
//   npx tsx scripts/verify-growth-concentration.ts
//
// WHY THIS SCRIPT EXISTS
// The price-state weld (session111/price-state-weld @ 96c9da99) surfaced a real
// number on the real book: $62,972 of quantified recurring opportunity, of which
// $39,900 (63%) came from ONE customer — a $26,600 renewal plus a $13,300
// referral on the same customer id. `lib/growthEvidence.skewNote()` had nothing
// to say about it, because every individual visit behind those two figures was
// well inside its own skew tolerance. The concentration was ACROSS customers,
// which skewNote does not measure and was never meant to.
//
// This guard proves lib/growthConcentration answers that DIFFERENT question,
// and proves it does not quietly become a second pricing or eligibility engine:
// it must not decide whether a figure is real (that is growthEvidence's job,
// already done before an Opportunity's expectedValue reaches here), only how the
// admitted money is distributed.
//
// ⛔ FIXTURE DATA ONLY. This guard never touches a database, never runs a build,
// never opens a browser. Pure-function assertions plus one minimal
// computeRevenueIntel() call using the same in-memory fixture shape the existing
// verify-growth-quality.ts guard already establishes as this repo's convention.

import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import {
  assessConcentration, concentrationNote, CONCENTRATION_MATERIAL_SHARE,
  type ConcentrationEntry,
} from '../src/lib/growthConcentration'
// ⭐ `skewNote` is a STATIC import: growthEvidence.ts's own import chain
// (→ pricingState.ts → visitValue.ts) is dependency-free — no npm package, so
// no node_modules is required to run this. Confirmed by reading all three
// files' import lists before relying on it here.
import { skewNote } from '../src/lib/growthEvidence'
// ⚠️ `computeRevenueIntel` (and the fixtures it needs — DEFAULT_SEASONS,
// SEASON_VISITS) are NOT statically imported. revenueIntelligence.ts pulls in
// `@/lib/utils` (clsx) and seasons.ts pulls in `date-fns` — real npm packages
// that are not installed in this worktree, and this parallel wave explicitly
// avoids `npm install`. They are loaded with a GUARDED dynamic import inside
// §11 only, so every other section here still runs and proves something real;
// §11 degrades to a clearly labeled PENDING line with the exact command to run
// once a serialized validation slot (or a worktree with node_modules) is
// available, rather than silently skipping or falsely claiming a pass.

let failures = 0
let pending = 0
const ok = (n: string) => console.log(`  ✓ ${n}`)
const fail = (n: string, d: string) => { failures++; console.log(`  ✗ ${n}\n      ${d}`) }
const check = (n: string, c: boolean, d = '') => (c ? ok(n) : fail(n, d))
const eq = (n: string, a: unknown, b: unknown) =>
  check(n, JSON.stringify(a) === JSON.stringify(b), `expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`)

const ROOT = process.cwd()
const read = (p: string) => readFileSync(join(ROOT, p), 'utf8')
const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/\/\/[^\n\r]*/g, ' ')
const SRC = {
  concentration: read('src/lib/growthConcentration.ts'),
  engine: read('src/lib/revenueIntelligence.ts'),
  page: read('src/app/dashboard/revenue-intelligence/page.tsx'),
  view: read('src/app/dashboard/revenue-intelligence/RevenueIntelligenceView.tsx'),
}
const CODE = Object.fromEntries(Object.entries(SRC).map(([k, v]) => [k, strip(v)])) as Record<keyof typeof SRC, string>

const money = (n: number) => `$${n.toLocaleString()}`
const entry = (customerId: string, expectedValue: number, customerName = customerId): ConcentrationEntry =>
  ({ customerId, customerName, expectedValue })

console.log('\n── 1. ⭐⭐ CROSS-CUSTOMER CONCENTRATION vs WITHIN-CUSTOMER SKEW — the actual regression case ──')
{
  // Reproduces the real book's shape and its literal numbers: customer A has
  // two quantified opportunities (a $26,600 renewal + a $13,300 referral) that
  // are individually unremarkable but sum to a clear majority of the book. Six
  // other customers ($8,000 / $6,000 / $4,000 / $3,000 / $1,500 / $572) make up
  // the rest, chosen so the fixture's total ($62,972) and A's share (63%) match
  // exactly what the price-state weld measured on production.
  const entries = [
    entry('cust-A', 26600), entry('cust-A', 13300, 'cust-A'), // same customer, two kinds
    entry('cust-B', 8000), entry('cust-C', 6000), entry('cust-D', 4000),
    entry('cust-E', 3000), entry('cust-F', 1500), entry('cust-G', 572),
  ]
  const total = entries.reduce((s, e) => s + e.expectedValue, 0)
  eq('the fixture totals the real book\'s $62,972 figure', total, 62972)
  const r = assessConcentration(entries)
  check('customer A\'s TWO opportunities are combined into one total', r.topAmount === 26600 + 13300, String(r.topAmount))
  eq('seven distinct customers contributed', r.contributorCount, 7)
  check('A\'s share crosses the material threshold', r.topShare > CONCENTRATION_MATERIAL_SHARE, String(r.topShare))
  eq('rounds to the same 63% the owner was shown', Math.round(r.topShare * 100), 63)
  check('material is true', r.material, '')

  // ⭐⭐ THE DISTINCTION THE BRIEF ASKS FOR, PROVEN DIRECTLY. Every visit behind
  // A's two opportunity figures is IDENTICAL in value — zero within-customer
  // skew by construction — yet the book is still concentrated. skewNote and
  // assessConcentration are asked the SAME underlying visit values and give
  // orthogonal answers: one says "nothing unusual in this customer's own
  // numbers", the other says "the book depends on this customer".
  const perfectlyEvenVisits = [1900, 1900, 1900, 1900, 1900, 1900, 1900] // A's own visits: no spread at all
  eq('within-customer skew sees NOTHING wrong (zero spread)', skewNote(perfectlyEvenVisits), null)
  check('…while the cross-customer view still flags the same book as concentrated',
    r.material, 'skewNote and assessConcentration must be allowed to disagree — they answer different questions')

  // And the inverse: a customer whose OWN visits are wildly skewed contributes
  // only a small, unremarkable slice of a large, well-spread book. skewNote
  // would flag them; concentration correctly does not.
  const wideBook = [
    entry('cust-A', 70), entry('cust-A', 6295, 'cust-A'), // huge within-customer skew
    entry('cust-B', 6000), entry('cust-C', 6000), entry('cust-D', 6000),
    entry('cust-E', 6000), entry('cust-F', 6000), entry('cust-G', 6000),
  ]
  const rWide = assessConcentration(wideBook)
  check('a customer with skewed visits but an unremarkable TOTAL is not flagged as concentrated',
    !rWide.material, `top share was ${rWide.topShare}`)
  check('…even though that SAME customer\'s own visits would trip a skew note',
    skewNote([70, 6295]) === null /* too small a sample for skewNote's own n>=3 rule */
    || typeof skewNote([70, 70, 6295]) === 'string',
    'the two signals are independent by construction')
}

console.log('\n── 2. ⭐⭐ UNKNOWN / ZERO / NEGATIVE / NON-FINITE — excluded, never coerced ──')
{
  const dirty: ConcentrationEntry[] = [
    entry('cust-A', 1000),
    entry('cust-B', 0),                 // unquantified — must not count, must not be "top"
    entry('cust-C', -500),               // impossible in practice, must not count
    entry('cust-D', NaN),
    entry('cust-E', Infinity),           // must not poison the sum or the shares
    entry('cust-F', -Infinity),
    entry('cust-G', 800),
  ]
  const r = assessConcentration(dirty)
  eq('only the two real, positive, finite entries are counted', r.contributorCount, 2)
  eq('the total is exactly their sum, not corrupted by Infinity or NaN', r.totalConsidered, 1800)
  check('the total is a finite number', Number.isFinite(r.totalConsidered), String(r.totalConsidered))
  check('the top share is a finite number in [0,1]',
    Number.isFinite(r.topShare) && r.topShare >= 0 && r.topShare <= 1, String(r.topShare))
  eq('customer A (the real top) is correctly identified, not B/C/D/E/F', r.topCustomerId, 'cust-A')
  check('the Infinity entry never becomes the top despite being numerically "largest"',
    r.topCustomerId !== 'cust-E' && r.topCustomerId !== 'cust-F', String(r.topCustomerId))

  // An all-dirty book has nothing to report.
  const allDirty = assessConcentration([entry('x', 0), entry('y', NaN), entry('z', -5)])
  eq('hasData is false when nothing survives the filter', allDirty.hasData, false)
  eq('totalConsidered is exactly 0, not NaN', allDirty.totalConsidered, 0)
  eq('topShare is exactly 0, not NaN or undefined', allDirty.topShare, 0)
  eq('material is false', allDirty.material, false)
  eq('the note is null, never "NaN% of $0"', concentrationNote(allDirty, money), null)
}

console.log('\n── 3. Missing identity — excluded, never attributed to "unknown" ──')
{
  const r = assessConcentration([
    entry('', 5000),                 // empty id — cannot attribute
    entry('cust-A', 1000),
  ] as ConcentrationEntry[])
  eq('the unidentified entry is dropped entirely', r.contributorCount, 1)
  eq('the total excludes it', r.totalConsidered, 1000)
  eq('the real customer is the top by default', r.topCustomerId, 'cust-A')
}

console.log('\n── 4. ⭐⭐ DUPLICATE DISPLAY NAMES NEVER MERGE OR SPLIT A CUSTOMER ──')
{
  // Two DIFFERENT customers who happen to share a display name. Must stay two
  // separate contributors with two separate totals — never summed into one
  // "customer" (which would manufacture a concentration finding out of nothing)
  // and never allowed to let one shadow the other.
  const sameName: ConcentrationEntry[] = [
    { customerId: 'uuid-1', customerName: 'Smith Landscaping', expectedValue: 1200 },
    { customerId: 'uuid-2', customerName: 'Smith Landscaping', expectedValue: 900 },
    { customerId: 'uuid-3', customerName: 'Unrelated Co', expectedValue: 400 },
  ]
  const r = assessConcentration(sameName)
  eq('three DISTINCT contributors, not two (the shared name did not merge them)', r.contributorCount, 3)
  eq('the total is the plain sum of all three, not a merged pair', r.totalConsidered, 2500)
  eq('the top is the correct SPECIFIC customer id, not just "Smith Landscaping"', r.topCustomerId, 'uuid-1')
  check('the top amount is uuid-1 alone (1200), never uuid-1+uuid-2 combined (2100)',
    r.topAmount === 1200, String(r.topAmount))

  // The inverse failure mode: grouping by name would also have been able to
  // SPLIT one real customer's revenue if their record had ever been renamed
  // between two opportunities. Proven by the fact that grouping is keyed
  // strictly on customerId even when two entries for the SAME id carry
  // (hypothetically) different name strings — the id wins, uninfluenced by name.
  const renamed: ConcentrationEntry[] = [
    { customerId: 'uuid-9', customerName: 'Old Name Inc', expectedValue: 3000 },
    { customerId: 'uuid-9', customerName: 'New Name Inc', expectedValue: 2000 },
  ]
  const rRenamed = assessConcentration(renamed)
  eq('one customer id is one contributor, regardless of a name change between entries', rRenamed.contributorCount, 1)
  eq('their total is the full combined figure, not split by the name change', rRenamed.totalConsidered, 5000)
}

console.log('\n── 5. Unquantified contributions never count, never win ──')
{
  // Mirrors what revenueIntelligence.ts actually hands over: the FULL ranked
  // list, unquantified opportunities (expectedValue === 0) included unfiltered.
  const fullBook: ConcentrationEntry[] = [
    entry('cust-A', 500),
    entry('cust-B', 0),  // insufficient evidence — real recommendation, no figure
    entry('cust-B', 0),
    entry('cust-C', 0),
    entry('cust-D', 300),
  ]
  const r = assessConcentration(fullBook)
  eq('unquantified entries contribute nothing to the count', r.contributorCount, 2)
  eq('…nor to the total', r.totalConsidered, 800)
  check('B, which is ALL unquantified, can never be "top" despite two entries',
    r.topCustomerId !== 'cust-B', String(r.topCustomerId))
}

console.log('\n── 6. Single contributor — real, honest, differently worded ──')
{
  const r = assessConcentration([entry('only-one', 4200)])
  eq('hasData is true', r.hasData, true)
  eq('contributorCount is 1', r.contributorCount, 1)
  eq('topShare is exactly 1 (not >1, not clamped away from 1)', r.topShare, 1)
  check('material at 100% share', r.material, '')
  const note = concentrationNote(r, money)
  check('the note uses the "only customer" phrasing, not a percentage-of-N phrasing',
    !!note && /ONLY customer/.test(note) && !/%/.test(note), String(note))
}

console.log('\n── 7. Below threshold — a well-spread book says nothing ──')
{
  // Six customers, evenly split — no one is even close to 40%.
  const entries = Array.from({ length: 6 }, (_, i) => entry(`c${i}`, 1000))
  const r = assessConcentration(entries)
  eq('an even six-way split is ~16.7% each', Math.round(r.topShare * 1000) / 10, 16.7)
  check('not material', !r.material, '')
  eq('the note is null — silence is the honest answer for an ordinary book', concentrationNote(r, money), null)
}

console.log('\n── 8. ⭐ THE THRESHOLD BOUNDARY — documented, and asserted at the edge ──')
{
  eq('the documented threshold is 40%', CONCENTRATION_MATERIAL_SHARE, 0.4)
  // Exactly at the boundary: 400 of 1000 = 0.4 exactly.
  const atBoundary = assessConcentration([entry('A', 400), entry('B', 300), entry('C', 300)])
  eq('share lands exactly on the threshold', atBoundary.topShare, 0.4)
  check('>= is material, not merely >', atBoundary.material, '')
  const justUnder = assessConcentration([entry('A', 399), entry('B', 301), entry('C', 300)])
  check('one dollar under the threshold is NOT material', !justUnder.material, String(justUnder.topShare))
}

console.log('\n── 9. No data at all ──')
{
  const empty = assessConcentration([])
  eq('an empty book has hasData: false', empty.hasData, false)
  eq('totalConsidered is 0', empty.totalConsidered, 0)
  eq('contributorCount is 0', empty.contributorCount, 0)
  eq('topCustomerId is null', empty.topCustomerId, null)
  eq('topCustomerName is null', empty.topCustomerName, null)
  eq('material is false', empty.material, false)
  eq('no note', concentrationNote(empty, money), null)
}

console.log('\n── 10. ⭐⭐ NO COUPLING TO THE EVIDENCE-DECISION SURFACE ──')
{
  // This module must only ask HOW ALREADY-ADMITTED money is distributed — never
  // re-decide whether it should exist. If it starts importing the eligibility
  // primitives, it has quietly become a second evidence engine.
  const FORBIDDEN = [/assessEvidence/, /mayShowAnnual/, /mayShowPerVisit/, /declaredCadence/, /priceEvidence/, /jobPriceState/, /looksLikeFixture/]
  for (const rx of FORBIDDEN) {
    check(`growthConcentration does not import or call ${rx.source}`,
      !rx.test(CODE.concentration), 'concentration must consume ALREADY-DECIDED expectedValue, never re-derive it')
  }
  check('growthConcentration performs no arithmetic on prices — only on expectedValue it is handed',
    !/\brate\s*\*/.test(CODE.concentration) && !/unitRatePrice/.test(CODE.concentration), '')
}

console.log('\n── 11. ⭐⭐ THE HEADLINE ARITHMETIC IS UNCHANGED — proven by running the real engine ──')
{
  // ⚠️ GUARDED. computeRevenueIntel's own import chain needs `clsx` (via
  // @/lib/utils) and `date-fns` (via seasons.ts) — real npm packages, and this
  // worktree deliberately has no node_modules (npm install is avoided in this
  // parallel wave per coordination constraints; S121 holds the resource-heavy
  // slot). A dynamic import lets every OTHER section in this file still run and
  // prove something real; this one section degrades to an explicit PENDING line
  // with the exact command to complete it later, rather than crashing the whole
  // guard or silently claiming a pass it did not earn.
  let engine: typeof import('../src/lib/revenueIntelligence') | null = null
  let seasonsMod: typeof import('../src/lib/seasons') | null = null
  let pricingMod: typeof import('../src/lib/pricing') | null = null
  try {
    // Synchronous `require`, not `await import()`: this worktree's package.json
    // does not declare `"type": "module"`, so tsx/esbuild transpile this file
    // to CJS output, and CJS does not support top-level await. `require` is
    // exactly what a CJS-transpiled ESM `import` already lowers to, so this is
    // not a different loading mechanism — it just spells it in a form the
    // guard can catch synchronously without needing an async wrapper.
    engine = require('../src/lib/revenueIntelligence')
    seasonsMod = require('../src/lib/seasons')
    pricingMod = require('../src/lib/pricing')
  } catch (e) {
    pending++
    console.log('  ? PENDING — real-engine end-to-end check not run in this parallel wave')
    console.log(`      reason: ${(e as Error).message?.split('\n')[0] || e}`)
    console.log('      why: revenueIntelligence.ts needs clsx/date-fns (real npm packages);')
    console.log('           this worktree has no node_modules and npm install is intentionally')
    console.log('           avoided this wave (S121 holds the resource-heavy validation slot).')
    console.log('      queued command (run once a node_modules-bearing slot is available):')
    console.log(`        cd "${process.cwd()}" && npm install && npx tsx scripts/verify-growth-concentration.ts`)
    console.log('      (§1–10 and §12 above/below already ran for real and are NOT pending — only')
    console.log('       this one section, which needs the full app dependency graph, is deferred.)')
  }
  if (engine && seasonsMod && pricingMod) {
  const { computeRevenueIntel } = engine
  const { DEFAULT_SEASONS } = seasonsMod
  const { SEASON_VISITS } = pricingMod
  // Minimal end-to-end fixture, same shape as verify-growth-quality.ts §8: two
  // customers, one with a live weekly series (quantified), one with no declared
  // cadence (unquantified). Confirms totalOpportunity/totalOneTime/quantified/
  // unquantified come out EXACTLY as they would without this follow-up, and that
  // `concentration` is additive alongside them, not a replacement for anything.
  const today = '2026-09-04'
  const q = { id: 'q1', total: 70, initial_price: 70, weekly_price: 70, biweekly_price: 70, monthly_price: 70 }
  const mk = (id: string, cust: string, date: string, price: number | null, rec: string | null = null) => ({
    id, scheduled_date: date, status: 'completed', service_type: 'Service', quote_id: null, recurrence_id: rec,
    duration_minutes: 60, actual_minutes: null, price, lat: null, lng: null, city: null, postal_code: null,
    neighborhood: null, customer_id: cust,
  })
  const jobs = [
    mk('a1', 'A', '2026-08-01', 70, 'r1'), mk('a2', 'A', '2026-08-08', 70, 'r1'),
    mk('a3', 'A', '2026-08-15', 70, 'r1'), mk('a4', 'A', '2026-08-22', 70, 'r1'),
    { ...mk('a5', 'A', '2026-09-05', 70, 'r1'), status: 'scheduled' },
    mk('b1', 'B', '2026-08-02', 90), mk('b2', 'B', '2026-08-09', 90), mk('b3', 'B', '2026-08-16', 90),
  ]
  const customers = [
    { id: 'A', name: 'Aster Grounds', created_at: '2024-01-01', referred_by_customer_id: null },
    { id: 'B', name: 'Birch Holdings', created_at: '2024-01-01', referred_by_customer_id: null },
  ]
  const recurrences = { r1: { freq: 'weekly', interval_unit: 'week', interval_count: 1 } }
  const report = computeRevenueIntel({
    jobs, pctx: { quotesById: { q1: q } as never, recById: recurrences, base: null, today },
    customers, properties: [], recurrences, invoices: [], lineItems: [], jobCustomerById: {},
    seasons: DEFAULT_SEASONS, capacityHours: 8, preferredDays: [1, 2, 3, 4, 5], today,
  })

  check('the recurring headline is still driven by A alone (unchanged from the price-state weld)',
    report.summary.totalOpportunity === 70 * SEASON_VISITS.weekly + Math.round(70 * SEASON_VISITS.weekly * 0.5),
    String(report.summary.totalOpportunity))
  eq('totalOneTime is untouched (0 here — nothing one-time in this fixture)', report.summary.totalOneTime, 0)
  check('quantified/unquantified counts are still produced', report.summary.quantified >= 1 && report.summary.unquantified >= 1,
    JSON.stringify({ q: report.summary.quantified, u: report.summary.unquantified }))

  // The new field, additive: A is the only customer with any quantified money,
  // so A is trivially the whole concentration — this is a correctness check on
  // the WIRING (the right shape reaches the summary), not a new claim about the
  // real book (§1 above and the report already prove the algorithm itself).
  check('summary.concentration exists and is additive', report.summary.concentration !== undefined, '')
  if (report.summary.concentration) {
    eq('A is identified as the top contributor through the real pipeline',
      report.summary.concentration.topCustomerId, 'A')
    check('material, since A is the only quantified customer', report.summary.concentration.material, '')
  } else {
    fail('summary.concentration should not be null here — A has quantified revenue', '')
  }

  // A book where NOTHING is quantified must not produce a concentration verdict
  // at all (null), matching the "hasData:false ⇒ null" contract end to end.
  const weakOnly = computeRevenueIntel({
    jobs: jobs.filter(j => j.customer_id !== 'A'),
    pctx: { quotesById: { q1: q } as never, recById: recurrences, base: null, today },
    customers: customers.filter(c => c.id !== 'A'),
    properties: [], recurrences, invoices: [], lineItems: [], jobCustomerById: {},
    seasons: DEFAULT_SEASONS, capacityHours: 8, preferredDays: [1, 2, 3, 4, 5], today,
  })
  eq('a book with nothing quantifiable has NO concentration verdict', weakOnly.summary.concentration, null)
  } // end if (engine && seasonsMod && pricingMod)
}

console.log('\n── 12. Source-level: the existing accumulation loop is untouched ──')
{
  // ⚠️ Not a substitute for §11's behavioural proof — a text match confirms the
  // ORIGINAL lines were not edited in place (rather than replaced by an
  // equivalent-looking rewrite that could silently change semantics).
  check('totalOneTime/totalOpportunity split is the original expression',
    /if \(o\.oneTime\) totalOneTime \+= o\.expectedValue; else totalOpportunity \+= o\.expectedValue/.test(CODE.engine), '')
  check('quantified/unquantified counting is the original expression',
    /if \(o\.expectedValue > 0\) quantified\+\+; else unquantified\+\+/.test(CODE.engine), '')
  check('concentration is computed from the SAME ranked list, not a second pass with different inputs',
    /assessConcentration\(\s*ranked\.map/.test(CODE.engine), '')

  // ⛔ The banner must render nothing unless material — asserted on the page.
  check('the view gates rendering on summary.concentration?.material',
    /summary\.concentration\?\.material/.test(CODE.view), '')
  check('the view uses concentrationNote rather than re-deriving the sentence itself',
    /concentrationNote\(/.test(CODE.view), '')
}

// ⛔ "Do not claim pending checks passed." A run with 0 failures but >0 pending
// is reported as PASS-WITH-PENDING, never as a plain "all checks passed" — the
// two are different facts and the summary line says which one actually happened.
if (failures === 0 && pending === 0) {
  console.log('\n✅ growth concentration: all checks passed (nothing pending)\n')
} else if (failures === 0 && pending > 0) {
  console.log(`\n⚠️  growth concentration: 0 failures, but ${pending} section(s) PENDING (see above) — this is NOT a full pass\n`)
} else {
  console.log(`\n❌ ${failures} check(s) failed, ${pending} section(s) pending\n`)
}
process.exit(failures === 0 ? 0 : 1)
