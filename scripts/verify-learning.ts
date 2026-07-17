// ── Verify: confidence measures agreement, and a gagged model says so ────────
//   npm run verify:learning
//
// WHY THIS SCRIPT EXISTS
// Confidence is the number that decides whether an owner clicks "Use $X". It was a
// pure function of the sample COUNT — never of whether the evidence agreed, and
// never of whether the model was even able to act on it. So the worst-calibrated
// state the product can be in reported the highest confidence it has.
//
// The live case, measured: 22 mowing ratios spanning 0.56–1.08, median 0.769, with
// 15 of the 22 sitting BELOW RATIO_MIN (0.9). The owner closes ~23% under their own
// engine at every size. The learner is clamped to [0.9, 1.25], so it pinned to 0.9,
// landed on its floor at every size, and announced "95% · High confidence".
//
// Three properties pinned here:
//  1. A PINNED median is the least confident state, not the most. The clamp stops
//     being a guard rail and becomes a gag: the model has a clear signal and no way
//     to say it.
//  2. Disagreeing evidence caps confidence no matter how much of it there is.
//  3. sampleSize counts RATIO-BEARING quotes. aggN counted every decided quote,
//     including those with no measurement — which produce no ratio and taught the
//     model nothing, while inflating the count the UI presents as evidence.
//
// None of this is a type error: every number involved is a valid number. Only
// executing the real engine against a realistic distribution catches it.
//
// Runs the REAL engine against hand-built models. Deterministic, no network.

import {
  recommendQuotePrice, type QuotePricingModel, type ServiceWinStats,
} from '../src/lib/quoteLearning'
import { DEFAULT_PRICING } from '../src/lib/pricing'

let failures = 0
const ok = (name: string) => console.log(`  ✓ ${name}`)
const fail = (name: string, detail: string) => { failures++; console.log(`  ✗ ${name}\n      ${detail}`) }
const check = (name: string, cond: boolean, detail = '') => (cond ? ok(name) : fail(name, detail))
const eq = (name: string, actual: unknown, expected: unknown) =>
  check(name, Object.is(actual, expected), `expected ${String(expected)}, got ${String(actual)}`)

const median = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b)
  const m = Math.floor(s.length / 2)
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2
}

function modelFor(ratios: number[], opts?: { won?: boolean[] }): QuotePricingModel {
  const won = opts?.won ?? ratios.map(() => true)
  const stats: ServiceWinStats = {
    won: won.filter(Boolean).length,
    lost: won.filter(w => !w).length,
    acceptance: won.filter(Boolean).length / won.length,
    priceLossShare: 0,
    medianWinRatio: median(ratios.filter((_, i) => won[i])),
    ratios: ratios.map((ratio, i) => ({ ratio, won: won[i] })),
    n: ratios.length,
  }
  return { byService: { mowing: stats }, wonByPropertyService: {}, wonByCustomerService: {}, decidedQuotes: ratios.length }
}

const base = {
  sqft: 3000, serviceType: 'Lawn Mowing', cadence: 'weekly' as const,
  crewCost: 40, overgrowth: 1,
  propertyId: null, customerId: null,
}

// The REAL live distribution, from the audit's query of production.
const LIVE_MOWING = [
  0.56, 0.62, 0.68, 0.68, 0.70, 0.72, 0.75, 0.75, 0.77, 0.77, 0.82,
  0.86, 0.86, 0.86, 0.91, 1.00, 1.00, 1.00, 1.00, 1.03, 1.08,
]

// ── 1. THE GAGGED MODEL SAYS SO ──────────────────────────────────────────────
console.log('\nA model pinned against its clamp reports low confidence, not high:')
{
  const rec = recommendQuotePrice({ ...base }, modelFor(LIVE_MOWING), DEFAULT_PRICING)!
  check('the live distribution produces a recommendation', rec != null, 'got null')
  check('…and it is flagged as a calibration problem', rec.calibration != null,
        'calibration is null — the pinned median went unreported')
  eq('…pinned BELOW the floor of the band', rec.calibration?.pinned, 'below')
  check('…reporting the real median (~0.77), not the clamped 0.9',
        (rec.calibration?.medianWinRatio ?? 0) < 0.9,
        `reported ${rec.calibration?.medianWinRatio}`)
  // THE headline: this state used to report 95% High.
  eq('confidence is LOW — the number is the clamp, not the evidence', rec.confidence, 'low')
  check('…and the percentage is honest about it', rec.confidencePct <= 40,
        `still claiming ${rec.confidencePct}%`)
}

// ── 2. AGREEING EVIDENCE INSIDE THE BAND IS STILL CONFIDENT ──────────────────
// The fix must not make the model timid — a healthy signal must still speak.
console.log('\nAgreeing evidence inside the band keeps its confidence:')
{
  // 14 tightly-clustered ratios, comfortably inside [0.9, 1.25].
  const tight = Array.from({ length: 14 }, (_, i) => 1.10 + (i % 3) * 0.01)
  const rec = recommendQuotePrice({ ...base }, modelFor(tight), DEFAULT_PRICING)!
  eq('no calibration problem to report', rec.calibration, null)
  eq('…confidence is high', rec.confidence, 'high')
  check('…and says so strongly', rec.confidencePct >= 70, `only ${rec.confidencePct}%`)
}

// ── 3. DISAGREEING EVIDENCE CANNOT BE HIGH CONFIDENCE ────────────────────────
// The spread threshold (0.12) must actually DISCRIMINATE. The first draft used
// 0.25, which fired on nothing — not even live production data — making the whole
// check dead code. These two fixtures sit either side of the threshold and are
// asserted in opposite directions, so a future edit that widens it back into
// uselessness breaks this file.
console.log('\nEvidence that disagrees with itself caps the claim:')
{
  // 14 ratios inside the band but spanning its whole width (cv ≈ 0.144). The owner
  // closes at 0.9 OR 1.25 and essentially never at the ~1.07 median — so the
  // recommendation is a price they have never actually charged. Count says "lots";
  // agreement says "no idea".
  const spread = [0.90, 1.25, 0.92, 1.24, 0.95, 1.20, 0.91, 1.23, 0.93, 1.22, 0.90, 1.25, 0.94, 1.21]
  const rec = recommendQuotePrice({ ...base }, modelFor(spread), DEFAULT_PRICING)!
  eq('the median still fits the band, so this is not a calibration alert', rec.calibration, null)
  check('…but 14 disagreeing quotes are not high confidence', rec.confidence !== 'high',
        `claimed ${rec.confidence} at ${rec.confidencePct}%`)
  check('…and the percentage is capped', rec.confidencePct <= 62, `claimed ${rec.confidencePct}%`)
}

// ── 4. sampleSize COUNTS EVIDENCE, NOT ROWS ──────────────────────────────────
console.log('\n"N similar quotes" counts quotes that taught the model something:')
{
  const ratios = [1.0, 1.02, 1.01, 1.03, 0.99, 1.0]
  const m = modelFor(ratios)
  // Simulate the live shape: decided quotes that carry NO ratio (no measurement).
  // They inflate `n` but contribute nothing to `ratios`.
  m.byService.mowing.n = 34
  const rec = recommendQuotePrice({ ...base }, m, DEFAULT_PRICING)!
  eq('6 ratio-bearing quotes are reported as 6, not 34', rec.sampleSize, 6)
  check('…and the count never exceeds the evidence', rec.sampleSize <= ratios.length,
        `claimed ${rec.sampleSize} from ${ratios.length} ratios`)
}

// ── 5. NO HISTORY STILL REFUSES TO GUESS ─────────────────────────────────────
// The behaviour that was already right and must not regress.
console.log('\nWith no history it still declines to pretend:')
{
  const empty: QuotePricingModel = { byService: {}, wonByPropertyService: {}, wonByCustomerService: {}, decidedQuotes: 0 }
  const rec = recommendQuotePrice({ ...base }, empty, DEFAULT_PRICING)!
  eq('enoughData is false', rec.enoughData, false)
  eq('…confidence is low', rec.confidence, 'low')
  eq('…no calibration claim without evidence', rec.calibration, null)
  check('…and it says it is using standard pricing',
        rec.reasons.some(r => /Not enough .* history yet/i.test(r)),
        `reasons: ${JSON.stringify(rec.reasons)}`)
}

// ── 6. A CALIBRATION CLAIM NEEDS ENOUGH EVIDENCE TO MAKE IT ──────────────────
console.log('\nA calibration alert is itself evidence-gated:')
{
  // Two wildly-low ratios are an anecdote, not a calibration finding.
  const rec = recommendQuotePrice({ ...base }, modelFor([0.5, 0.55]), DEFAULT_PRICING)!
  eq('two low quotes do not indict the base rate', rec.calibration, null)
}

console.log('')
if (failures) { console.log(`✗ ${failures} learning check(s) failed\n`); process.exit(1) }
console.log('✓ all learning checks passed — confidence measures agreement, and a clamped model says so\n')
