// ── Verify: the guardrail never contradicts the engine it guards ─────────────
//   npm run verify:guardrails
//
// WHY THIS SCRIPT EXISTS
// A guardrail's only asset is trust. The moment it warns about a price the app
// itself recommended, the owner learns to ignore it — and then it cannot protect
// them from the real underpricing it exists to catch. That failure is invisible to
// tsc and to next build: both numbers are valid, they simply disagree.
//
// It had two ways to disagree, both shipped, both fixed here:
//
//  1. THE GRADE. pricingPackage() prices a customer with a strategic grade on the
//     VALUE curve (A+ weekly ×0.68). priceGuardrails.ts kept a private copy of the
//     NEUTRAL curve (weekly ×0.75) — commented "mirrors lib/pricing CADENCE_MULT",
//     under a header promising "no new pricing math". So for the owner's BEST
//     customers the app recommended a price and then warned that same price was
//     too low. Both numbers came from the same app, 20 lines apart.
//
//  2. THE OVERGROWTH. recommendedJobPrice() folds the condition multiplier into
//     the base; the guardrail never passed it. A ×2 overgrown cut priced correctly
//     by the engine was judged against the normal-condition price — so the
//     guardrail stayed silent at ~half the right number, on exactly the visits
//     where underpricing hurts most.
//
// The fix is a deletion: the multipliers now come from the engine's own
// cadenceMultipliers() seam, and pricingPackage() reads that same seam, so there
// is one curve and one place to change it. This file pins that they agree.
//
// Runs the REAL engines. Deterministic, no network, no API key.

import {
  DEFAULT_PRICING, pricingPackage, recommendedJobPrice, cadenceMultipliers,
} from '../src/lib/pricing'
import { recommendedForCadence, evaluatePrice, type Cadence } from '../src/lib/priceGuardrails'

let failures = 0
const ok = (name: string) => console.log(`  ✓ ${name}`)
const fail = (name: string, detail: string) => { failures++; console.log(`  ✗ ${name}\n      ${detail}`) }
const check = (name: string, cond: boolean, detail = '') => (cond ? ok(name) : fail(name, detail))
const eq = (name: string, actual: unknown, expected: unknown) =>
  check(name, Object.is(actual, expected), `expected ${String(expected)}, got ${String(actual)}`)

const cfg = DEFAULT_PRICING
const CADENCES: Exclude<Cadence, 'one_time'>[] = ['weekly', 'biweekly', 'monthly']

// ── 1. THE SEAM IS THE ENGINE'S, NOT A COPY ──────────────────────────────────
console.log('\nThe cadence curve has exactly one source:')
{
  // The neutral baseline — the values the guardrail used to hardcode.
  const neutral = cadenceMultipliers(null)
  eq('ungraded weekly is ×0.75', neutral.weekly, 0.75)
  eq('ungraded biweekly is ×0.85', neutral.biweekly, 0.85)
  eq('ungraded monthly is ×1.1', neutral.monthly, 1.1)

  // The value curve — what a graded customer is ACTUALLY priced on, and what the
  // old private copy could not express at all.
  const aPlus = cadenceMultipliers('A+')
  eq('an A+ customer\'s weekly is ×0.68, not ×0.75', aPlus.weekly, 0.68)
  check('…so the graded curve genuinely differs from the neutral one',
        aPlus.weekly !== neutral.weekly, 'the two curves collapsed — the fixture no longer proves anything')
}

// ── 2. THE GUARDRAIL AGREES WITH THE ENGINE, AT EVERY GRADE AND SIZE ─────────
// This is the whole point. For every grade the product can assign, and across the
// real size range, the price the engine RECOMMENDS must never trip the guardrail.
console.log('\nThe engine\'s own recommendation never trips the guardrail:')
{
  const GRADES = [null, 'A+', 'A', 'B', 'C', 'D', 'F']
  const SIZES = [500, 1000, 1500, 3000, 5500, 10000]
  let contradictions = 0
  let worst = ''
  for (const grade of GRADES) {
    for (const sqft of SIZES) {
      const pkg = pricingPackage(sqft, cfg, { overgrowth: 1, nearbyCount: 0, valueGrade: grade ?? undefined })
      for (const c of CADENCES) {
        const enginePrice = pkg.options.find(o => o.cadence === c)!.price
        const g = evaluatePrice({
          cadence: c, price: enginePrice, sqft, cfg, crewCost: 0, valueGrade: grade,
        })
        // crewCost 0 disables the rev/hr check, isolating the cadence comparison.
        const belowRec = g.reasons.some(r => /Below the recommended/i.test(r))
        if (belowRec) {
          contradictions++
          if (!worst) worst = `grade ${grade ?? 'none'} ${c} @ ${sqft}ft²: engine says $${enginePrice}, guardrail wants $${g.recommended}`
        }
      }
    }
  }
  eq('zero contradictions across 7 grades × 6 sizes × 3 cadences', contradictions, 0)
  if (worst) console.log(`      first: ${worst}`)
}

// ── 3. THE A+ REPRODUCTION ───────────────────────────────────────────────────
// The exact case from the audit, pinned by name so a regression is unmistakable.
console.log('\nThe owner\'s best customer is not warned about their own price:')
{
  const sqft = 1000
  const pkg = pricingPackage(sqft, cfg, { overgrowth: 1, nearbyCount: 0, valueGrade: 'A+' })
  const weekly = pkg.options.find(o => o.cadence === 'weekly')!.price
  const g = evaluatePrice({ cadence: 'weekly', price: weekly, sqft, cfg, crewCost: 0, valueGrade: 'A+' })
  eq('the guardrail recommends exactly what the engine priced', g.recommended, weekly)
  eq('…so the level is ok, not warn', g.level, 'ok')
  check('…and it does not claim the engine\'s price is below recommended',
        !g.reasons.some(r => /Below the recommended/i.test(r)),
        `reasons: ${JSON.stringify(g.reasons)}`)
}

// ── 4. OVERGROWTH IS JUDGED AT THE PRICE IT WAS BUILT WITH ───────────────────
console.log('\nAn overgrown job is judged against the overgrown price:')
{
  const sqft = 3000
  const og = 2
  const engineOneTime = recommendedJobPrice(sqft, cfg, og)
  const normalOneTime = recommendedJobPrice(sqft, cfg, 1)
  check('the ×2 job really is priced above the normal one', engineOneTime > normalOneTime,
        `og=2 → $${engineOneTime}, og=1 → $${normalOneTime}`)

  // The engine's own one-time price for the overgrown job must not warn.
  const good = evaluatePrice({ cadence: 'one_time', price: engineOneTime, sqft, cfg, crewCost: 0, overgrowth: og })
  eq('the engine\'s overgrown price passes', good.level, 'ok')
  eq('…and the guardrail recommends the overgrown number', good.recommended, engineOneTime)

  // The normal-condition price on an overgrown job is a REAL underprice, and the
  // guardrail must now catch it — this is what the blindness was hiding.
  const bad = evaluatePrice({ cadence: 'one_time', price: normalOneTime, sqft, cfg, crewCost: 0, overgrowth: og })
  eq('quoting the normal price for a ×2 overgrown job now warns', bad.level, 'warn')
  check('…and says why', bad.reasons.some(r => /Below the recommended/i.test(r)),
        `reasons: ${JSON.stringify(bad.reasons)}`)
}

// ── 5. THE UNGRADED PATH IS BYTE-IDENTICAL ───────────────────────────────────
// Every existing caller omits valueGrade/overgrowth. Their behaviour must not move.
console.log('\nCallers that pass no grade and no overgrowth see exactly what they saw:')
{
  // Derived from the documented formula, independently of the implementation:
  // recommendedJobPrice(3000) = roundToStep((28 + 3×15) × 1.0) = 75; weekly ×0.75
  // = 56.25 → roundToStep → 55.
  eq('3,000 ft² one-time is still $75', recommendedForCadence(3000, 'one_time', cfg), 75)
  eq('3,000 ft² weekly is still $55', recommendedForCadence(3000, 'weekly', cfg), 55)
  eq('3,000 ft² biweekly is still $65', recommendedForCadence(3000, 'biweekly', cfg), 65)
  eq('3,000 ft² monthly is still $85', recommendedForCadence(3000, 'monthly', cfg), 85)
  eq('an unmeasured lawn still recommends nothing', recommendedForCadence(0, 'weekly', cfg), 0)
  // Explicit nulls must behave exactly like omission.
  eq('an explicit null grade matches omission',
     recommendedForCadence(3000, 'weekly', cfg, { valueGrade: null }),
     recommendedForCadence(3000, 'weekly', cfg))
  eq('an explicit ×1 overgrowth matches omission',
     recommendedForCadence(3000, 'weekly', cfg, { overgrowth: 1 }),
     recommendedForCadence(3000, 'weekly', cfg))
}

// ── 6. THE REAL UNDERPRICE IS STILL CAUGHT ───────────────────────────────────
// Loosening the comparison must not make the guardrail toothless.
console.log('\nA genuine underprice still warns:')
{
  const g = evaluatePrice({ cadence: 'weekly', price: 20, sqft: 3000, cfg, crewCost: 0 })
  eq('$20 weekly on a 3,000 ft² lawn warns', g.level, 'warn')
  check('…and quantifies the loss', g.reasons.some(r => /left on the table/i.test(r)),
        `reasons: ${JSON.stringify(g.reasons)}`)

  // The crew-cost floor is independent of all of this and must still fire.
  const thin = evaluatePrice({ cadence: 'weekly', price: 30, sqft: 3000, cfg, crewCost: 65 })
  check('a price thin against crew cost still warns', thin.level === 'warn',
        `reasons: ${JSON.stringify(thin.reasons)}`)
}

console.log('')
if (failures) { console.log(`✗ ${failures} guardrail check(s) failed\n`); process.exit(1) }
console.log('✓ all guardrail checks passed — one cadence curve, and the guardrail agrees with the engine\n')
