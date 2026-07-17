// ── Verify: the labour estimator never invents, and never contradicts itself ──
//   npm run verify:labor
//
// WHY THIS SCRIPT EXISTS
// The estimator's whole promise is that it speaks ONLY when it has learned
// something, and says "I won't guess" otherwise (SmartLaborField renders that
// refusal). That promise is a VALUE property — tsc and next build pass with it
// broken, because a fabricated 45 is the same type as a learned 26.
//
// Three things it pins, each a real defect found by audit and fixed here:
//
//  1. A hardcoded constant must never dilute real property history. When a
//     property had no sqft, the size model used to return a flat 45 — and that 45
//     was being blended into a property's OWN timed visits, so four real mows
//     averaging 26.5 min were reported as 33. The estimator was most wrong
//     exactly where it had the most evidence. The field lane then finished the
//     job at the source: estimateVisitMinutes now returns null for an unmeasured
//     property (no measurement → no estimate), so there is no constant left to
//     blend. The checks below pin BOTH halves: the refusal at the source, and
//     the blend protection that still matters for any future prior.
//
//  2. One estimate must not say both "high confidence, this property has a track
//     record" and "not enough history yet — rough size estimate". Both strings
//     rendered in the same "Why?" list.
//
//  3. "Based on N jobs" must count DISTINCT jobs. propN + comboN double-counts the
//     property's own visits, which are a subset of the combo pool.
//
// Runs the REAL engine against a hand-built model (no network, no DB, no API key).
// Deterministic — runs in CI beside the other verifiers.

import { estimateLabor, type LaborModel } from '../src/lib/labor'
import { estimateVisitMinutes } from '../src/lib/pricing'

let failures = 0
const ok = (name: string) => console.log(`  ✓ ${name}`)
const fail = (name: string, detail: string) => { failures++; console.log(`  ✗ ${name}\n      ${detail}`) }
const check = (name: string, cond: boolean, detail = '') => (cond ? ok(name) : fail(name, detail))
const eq = (name: string, actual: unknown, expected: unknown) =>
  check(name, Object.is(actual, expected), `expected ${String(expected)}, got ${String(actual)}`)

// Defect 1's fix, taken to its conclusion. An earlier version of this check
// pinned the flat 45 itself ("the size model returns 45 and says it's a guess");
// the field lane then removed the invented constant at the source — unmeasured
// now returns null, the type system forces every caller to face it, and the
// guardrail stops computing $/hr from minutes nobody measured. Pinning 45 after
// that would fail the exact change this file argues for (see the analytics
// verifier at 907c9a4 for the same lesson).
console.log('\nThe size model refuses to guess:')
{
  eq('an unmeasured lawn returns null — no measurement, no estimate', estimateVisitMinutes(0), null)
  check('…and a measured one returns real minutes', (estimateVisitMinutes(3000) ?? 0) > 0,
        'a measured 3,000 ft² lawn must produce an estimate')
}

// A property with FOUR real timed visits and NO sqft. This is not hypothetical:
// 27 of 62 live properties have no lawn_sqft, and 18 of 28 labour observations
// carry no sqft — this is the single most common shape in the real data.
// NOTE: built to the REAL LaborModel shape with no `as unknown as` cast — the cast
// is what let an earlier draft of this file pass a wrong-shaped model (season vs
// seasonFactor) and blow up at runtime. If the model shape changes, tsc must break
// this file rather than let it lie.
const PROP = 'prop-1'
const KEY = 'mowing'
const model: LaborModel = {
  combos: {},
  combosByCadence: {},
  lawnAll: { soloPer1000: 0, cv: 0, n: 0 },
  byProperty: { [`${PROP}::${KEY}`]: { soloMinutes: [25, 26, 27, 28], sqft: null } },
  crewEff: { 1: 1 },
  crewManMinPer1000: {},
  season: { spring: 1, summer: 1, fall: 1, winter: 1 },
  firstCutFactor: 1,
  totalSamples: 4,
}

console.log('\nA constant must never dilute a property\'s own history:')
{
  const est = estimateLabor(
    { serviceType: 'Lawn Mowing', sqft: 0, crewSize: 1, propertyId: PROP, overgrowth: 1 },
    model,
  )
  // The property's own median is 26.5. Blending the invented 45 at (1 - 4/6) = 33%
  // produced 33 — a 25% overstatement on the property we know MOST about.
  check('the estimate stays near the property\'s real median (26-27), not inflated toward 45',
        est.minutes >= 25 && est.minutes <= 28,
        `got ${est.minutes} min — the 45-min constant is still being blended in`)

  // The reasons must not contradict each other.
  const saysNoHistory = est.reasons.some(r => /not enough|rough size estimate/i.test(r))
  const saysHasHistory = est.reasons.some(r => /past .* visit|track record/i.test(r))
  check('it does not claim a track record AND no history in the same breath',
        !(saysNoHistory && saysHasHistory),
        `contradictory reasons: ${JSON.stringify(est.reasons)}`)
  check('it does cite the property\'s real visits', saysHasHistory,
        `the strongest signal went unmentioned: ${JSON.stringify(est.reasons)}`)

}

// The double-count only happens when BOTH pools are populated — the property's
// visits ARE members of the combo pool, so adding the two counts the same jobs
// twice. This mirrors the real shape found in the data: a property with 3 timed
// visits inside a learned pool of 4.
console.log('\n"Based on N jobs" counts jobs, not pools:')
{
  const P2 = 'prop-2'
  const overlapping: LaborModel = {
    combos: { [KEY]: { soloPer1000: 12, cv: 0.1, n: 4 } },
    combosByCadence: {},
    lawnAll: { soloPer1000: 12, cv: 0.1, n: 4 },
    // 3 of the combo pool's 4 jobs are this property's.
    byProperty: { [`${P2}::${KEY}`]: { soloMinutes: [30, 31, 32], sqft: 2500 } },
    crewEff: { 1: 1 },
    crewManMinPer1000: {},
    season: { spring: 1, summer: 1, fall: 1, winter: 1 },
    firstCutFactor: 1,
    totalSamples: 4,
  }
  const est = estimateLabor(
    { serviceType: 'Lawn Mowing', sqft: 2500, crewSize: 1, propertyId: P2, overgrowth: 1 },
    overlapping,
  )
  // propN=3, comboN=4. The old code reported 3+4=7 "jobs" from a pool of 4.
  eq('3 property visits inside a 4-job pool is 4 jobs, not 7', est.sampleSize, 4)
  check('…and never exceeds the jobs that exist', est.sampleSize <= 4,
        `claimed ${est.sampleSize} jobs when only 4 exist`)
}

// With NO history at all, it must still refuse to guess — the behaviour that was
// already correct and must not regress.
console.log('\nWith nothing learned, it still refuses to guess:')
{
  const emptyModel: LaborModel = {
    combos: {},
    combosByCadence: {},
    lawnAll: { soloPer1000: 0, cv: 0, n: 0 },
    byProperty: {},
    crewEff: {},
    crewManMinPer1000: {},
    season: { spring: 1, summer: 1, fall: 1, winter: 1 },
    firstCutFactor: 1,
    totalSamples: 0,
  }
  const est = estimateLabor(
    { serviceType: 'Gutter Cleaning', sqft: 0, crewSize: 1, propertyId: null, overgrowth: 1 },
    emptyModel,
  )
  eq('enoughData is false', est.enoughData, false)
  eq('…and confidence is low', est.confidence, 'low')
  check('…and it says it is guessing', est.reasons.some(r => /not enough|rough size/i.test(r)),
        `expected an explicit "won't guess" reason, got ${JSON.stringify(est.reasons)}`)
}

console.log('')
if (failures) { console.log(`✗ ${failures} labour check(s) failed\n`); process.exit(1) }
console.log('✓ all labour checks passed — no invented constant in a learned estimate, no contradictory reasons\n')
