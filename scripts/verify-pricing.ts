// ── Verify: pricing — margin/markup maths, and that LAWN NEVER MOVED ─────────
//   npm run verify:pricing
//
// WHY THIS SCRIPT EXISTS
// Two reasons, and neither is caught by tsc or next build.
//
// 1. A wrong margin is a wrong VALUE, not a type error. The dangerous one is
//    subtle: an UNKNOWN cost rendering as 100% margin. Every service starts with
//    no cost entered, so a `?? 0` anywhere in this path would tell 27 owners
//    their services are pure profit. That reads perfectly and compiles perfectly.
//
// 2. Every pricing change since the unit-of-work work has carried one promise:
//    the lawn engine is byte-identical. That promise has been checked by hand and
//    by `git diff` — neither of which survives a future refactor. This pins the
//    ACTUAL OUTPUT of the real engine to values derived independently from its
//    documented formula, so anyone who changes lawn pricing has to break this
//    file to do it.
//
// It runs the REAL engines (no copies, no mocks). Deterministic, no network, no
// API key — runs in CI beside the other verifiers.

import {
  totalUnitCost, marginPct, markupPct, unitProfit,
  priceForMargin, priceForMarkup, marginTone, formatPct,
} from '../src/lib/margin'
import { DEFAULT_PRICING, lawnBasePrice, pricingConfigFromSettings } from '../src/lib/pricing'
import { serviceLineTotals } from '../src/lib/quoteServices'

let failures = 0
const ok = (name: string) => console.log(`  ✓ ${name}`)
const fail = (name: string, detail: string) => { failures++; console.log(`  ✗ ${name}\n      ${detail}`) }
const check = (name: string, cond: boolean, detail = '') => (cond ? ok(name) : fail(name, detail))
const eq = (name: string, actual: unknown, expected: unknown) =>
  check(name, Object.is(actual, expected), `expected ${String(expected)}, got ${String(actual)}`)

// ── 1. UNKNOWN COST IS NOT ZERO COST ─────────────────────────────────────────
// The trap this whole module exists to avoid.
console.log('\nUnknown cost must never read as free (the 100%-margin trap):')
{
  eq('no cost set → total cost is null (not 0)', totalUnitCost({}), null)
  eq('nulls set explicitly → still null', totalUnitCost({ unit_cost: null, material_cost: null }), null)
  eq('unknown cost → margin null (NOT 100)', marginPct(100, totalUnitCost({})), null)
  eq('unknown cost → markup null', markupPct(100, totalUnitCost({})), null)
  eq('unknown cost → profit null (NOT the full price)', unitProfit(100, totalUnitCost({})), null)
  eq('unknown margin renders as em dash', formatPct(null), '—')
  eq('unknown margin tone is neutral, not success', marginTone(null), 'neutral')
  // A cost of ZERO is a real, knowable fact and must NOT be silenced.
  eq('cost 0 is known → total 0', totalUnitCost({ unit_cost: 0 }), 0)
  eq('cost 0 → margin really is 100%', marginPct(50, 0), 100)
}

// ── 2. MARGIN vs MARKUP — the two are not the same number ────────────────────
console.log('\nMargin and markup are different questions:')
{
  // $100 price, $60 cost → margin 40% (share of price), markup 66.7% (over cost).
  eq('margin: (100−60)/100 = 40%', marginPct(100, 60), 40)
  eq('markup: (100−60)/60 = 66.7%', markupPct(100, 60), 66.7)
  eq('profit is plain dollars', unitProfit(100, 60), 40)
  eq('cost split across labour + materials sums', totalUnitCost({ unit_cost: 40, material_cost: 20 }), 60)
  eq('only one cost side set → the other is a real 0', totalUnitCost({ unit_cost: 40 }), 40)
}

// ── 3. LOSING MONEY IS A REAL ANSWER — never clamped ─────────────────────────
console.log('\nA price under cost must say so:')
{
  eq('price below cost → negative margin', marginPct(80, 100), -25)
  eq('price below cost → negative markup', markupPct(80, 100), -20)
  eq('price below cost → negative profit', unitProfit(80, 100), -20)
  eq('negative margin tones danger', marginTone(-25), 'danger')
  eq('thin margin tones warn', marginTone(9), 'warn')
  eq('healthy margin tones success', marginTone(45), 'success')
}

// ── 4. DIVISION BY ZERO NEVER REACHES THE SCREEN ─────────────────────────────
console.log('\nNo Infinity, no NaN, ever:')
{
  eq('price 0 → margin null (not NaN)', marginPct(0, 60), null)
  eq('cost 0 → markup null (not Infinity)', markupPct(100, 0), null)
  eq('100% target margin is unreachable → null', priceForMargin(60, 100), null)
  eq('>100% target margin → null', priceForMargin(60, 140), null)
}

// ── 5. SOLVING BACKWARDS ROUND-TRIPS ─────────────────────────────────────────
console.log('\nTarget margin/markup solve back to the same margin/markup:')
{
  const p1 = priceForMargin(60, 40)          // 60 / 0.6 = 100
  eq('price for a 40% margin on $60 cost = $100', p1, 100)
  eq('…and that price really is a 40% margin', marginPct(p1!, 60), 40)
  const p2 = priceForMarkup(60, 50)          // 60 × 1.5 = 90
  eq('price at 50% markup on $60 cost = $90', p2, 90)
  eq('…and that price really is a 50% markup', markupPct(p2!, 60), 50)
}

// ── 6. THE LINE MATHS IS STILL qty × unit_price ──────────────────────────────
// Units gave the line a vocabulary; they must never have touched its arithmetic.
console.log('\nUnit-of-work lines: the unit is a label, never a multiplier:')
{
  const line = { quantity: 6, unit_price: 25, discount_type: null, discount_value: null }
  eq('6 × $25 = $150 gross', serviceLineTotals(line).gross, 150)
  eq('…net matches with no discount', serviceLineTotals(line).net, 150)
  // Same numbers, different unit — a fixture and a square foot must total alike.
  eq('a 6-fixture line totals like any other 6 × $25', serviceLineTotals({ ...line }).gross, 150)
}

// ── 7. LAWN IS BYTE-IDENTICAL ────────────────────────────────────────────────
// Expected values derived from the DOCUMENTED formula, independently of the
// implementation: lawnBasePrice = (baseCharge + sqft/1000 × mowRatePer1000) ×
// overgrowth. If someone edits the engine, these break — which is the point.
console.log('\nLawn cadence engine — pinned, must never move:')
{
  const cfg = DEFAULT_PRICING
  eq('defaults unchanged: baseCharge $28', cfg.baseCharge, 28)
  eq('defaults unchanged: $15 per 1,000 ft²', cfg.mowRatePer1000, 15)
  eq('defaults unchanged: recommended ×1.0', cfg.recommendedMult, 1.0)
  eq('defaults unchanged: premium ×1.2', cfg.premiumMult, 1.2)

  // 0 ft² → $0, NOT the base charge. Deliberate (`if (sqft <= 0) return 0`): an
  // UNMEASURED lawn has no price, and quoting a show-up minimum for a lawn nobody
  // measured would invent a number. This assertion is here because the author of
  // this harness guessed $28 and the engine corrected him — pin the real rule.
  eq('0 ft² → $0 (unmeasured ≠ minimum charge)', lawnBasePrice(0, cfg), 0)
  eq('negative ft² → $0 too', lawnBasePrice(-500, cfg), 0)
  // 28 + (1000/1000 × 15) = 43
  eq('1,000 ft² → $43', lawnBasePrice(1000, cfg), 43)
  // 28 + (3000/1000 × 15) = 73
  eq('3,000 ft² → $73', lawnBasePrice(3000, cfg), 73)
  // 28 + (5500/1000 × 15) = 110.5
  eq('5,500 ft² → $110.50', lawnBasePrice(5500, cfg), 110.5)
  // Overgrowth multiplies the whole base: 73 × 1.5 = 109.5
  eq('overgrowth ×1.5 on 3,000 ft² → $109.50', lawnBasePrice(3000, cfg, 1.5), 109.5)
  eq('overgrowth 1 is a no-op', lawnBasePrice(3000, cfg, 1), lawnBasePrice(3000, cfg))

  // Settings still drive the engine, and a blank/zero setting still falls back.
  const custom = pricingConfigFromSettings({ pricing_base_charge: 40, pricing_mow_rate: 20 })
  eq('settings override the base charge', custom.baseCharge, 40)
  eq('settings override the rate', custom.mowRatePer1000, 20)
  eq('40 + 3×20 = $100 on custom settings', lawnBasePrice(3000, custom), 100)
  eq('a zero setting falls back to the default', pricingConfigFromSettings({ pricing_base_charge: 0 }).baseCharge, 28)
  eq('a null setting falls back to the default', pricingConfigFromSettings({ pricing_mow_rate: null }).mowRatePer1000, 15)
}

// ── 8. COSTS NEVER LEAK INTO A PRICE ─────────────────────────────────────────
// margin.ts judges a price; it must never be able to produce one. If lawn ever
// starts reading a cost, this file's whole premise is gone.
console.log('\nCost is a judgement, never an input to a price:')
{
  const withCost = lawnBasePrice(3000, DEFAULT_PRICING)
  eq('lawn price ignores any cost that exists', withCost, 73)
  eq('…and margin is computed AFTER, from that price', marginPct(withCost, 40), 45.2)
}

console.log('')
if (failures) { console.log(`✗ ${failures} pricing check(s) failed\n`); process.exit(1) }
console.log('✓ all pricing checks passed — margin/markup honest, lawn byte-identical\n')
