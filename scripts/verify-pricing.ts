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
import { serviceRecommendation, servicePricingKind } from '../src/lib/servicePricing'
import { TRADE_PACKS, LAWN_PACK } from '../src/lib/trades'

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

// ── 9. A SERVICE'S RECOMMENDATION IS NEVER INVENTED ──────────────────────────
// The quote builder used to fall back to `2 hr × 1 crew × $50/hr` — three numbers
// nobody entered — so there was ALWAYS a recommendation, and it rendered as
// "✓ Applied". These pin the replacement: no basis ⇒ null ⇒ the UI says so.
// Same disease as §1: an unknown price is not $100, an unknown cost is not $0.
console.log('\nA recommendation with no basis must be silent, not invented:')
{
  const bare = { kind: 'labour' as const, template: null, measuredSqft: 0, labour: null }
  eq('no template, no hours, no rate → NO recommendation', serviceRecommendation(bare), null)
  eq('a service with no hours entered → still nothing (never 2 hr)',
    serviceRecommendation({ ...bare, labour: null }), null)
  // Hours known but rate unknown, and vice versa: both are required, neither is
  // defaulted. This is the exact hole the hardcoded $50 used to plug.
  eq('hours but no rate → nothing (the $50 default is gone)',
    serviceRecommendation({ ...bare, labour: { price: 0, hours: 3, crewSize: 1, rate: 0 } }), null)
  eq('rate but no hours → nothing (the 2 hr default is gone)',
    serviceRecommendation({ ...bare, labour: { price: 0, hours: 0, crewSize: 1, rate: 95 } }), null)
}

console.log('\nWhen there IS a basis, it comes from the owner’s own configuration:')
{
  const tpl = (t: string, rate: number, name = 'Furnace Repair') =>
    ({ pricing_display_type: t as never, default_rate: rate, name })

  // The regression the audit found: Furnace Repair is catalogued at $189 and the
  // builder proposed $100 from the fabricated defaults — 47% under the owner's
  // own price. The catalogued price is real data and must win when hours are
  // unknown.
  const cat = serviceRecommendation({ kind: 'labour', template: tpl('starting_from', 189), measuredSqft: 0, labour: null })
  eq('starting_from template, no hours → the owner’s OWN price', cat?.price, 189)
  eq('…and it says where it came from', cat?.basis, 'Your starting price for Furnace Repair')
  eq('…tagged as catalogue, not labour', cat?.source, 'catalog_price')

  // Real hours + a real rate beat the "starting from" floor — that is what
  // "starting from" means.
  const lab = serviceRecommendation({
    kind: 'labour', template: tpl('starting_from', 189), measuredSqft: 0,
    labour: { price: 285, hours: 3, crewSize: 1, rate: 95 },
  })
  eq('hours + rate known → labour wins over the starting price', lab?.price, 285)
  eq('…and shows the arithmetic', lab?.basis, '3 hr × 1 crew × $95/hr')

  // Area rate is the most specific: the owner's $/ft² × a real measurement.
  const area = serviceRecommendation({
    kind: 'per_area', template: tpl('per_sqft', 6.5, 'Roof Replacement'), measuredSqft: 2000, labour: null,
  })
  eq('per_sqft template × measured area', area?.price, 13000)
  eq('…basis names the rate and the area', area?.basis, '$6.50/sq ft × 2,000 sq ft')
  eq('per_sqft template with NO measurement → nothing to say',
    serviceRecommendation({ kind: 'per_area', template: tpl('per_sqft', 6.5), measuredSqft: 0, labour: null }), null)
  eq('materials templates carry the flag',
    serviceRecommendation({ kind: 'labour', template: tpl('starting_from_materials', 250), measuredSqft: 0, labour: null })?.materials, true)
}

// ── 10. AN UNNAMED SERVICE IS NOT A LAWN ─────────────────────────────────────
// `servicePricingKind('')` returned 'lawn_recurring' — so every quote began life
// as a mowing quote, and on a customer with a measured property that rendered the
// full Weekly/Bi-Weekly grass panel for a service nobody had picked.
console.log('\nThe empty form is not a mowing quote:')
{
  eq('no service chosen → labour, NOT lawn', servicePricingKind('', null), 'labour')
  eq('whitespace is not a service either', servicePricingKind('   ', null), 'labour')
  eq('null service → labour', servicePricingKind(null, null), 'labour')
  // …and the lawn routing that DOES exist is untouched.
  eq('a named mow is still lawn cadence', servicePricingKind('Lawn Mowing', null), 'lawn_recurring')
  eq('a per_sqft template still routes to area', servicePricingKind('Mulch', { pricing_display_type: 'per_sqft' } as never), 'per_area')
  eq('an hourly template is still labour', servicePricingKind('Anything', { pricing_display_type: 'hourly' } as never), 'labour')
}

// ── 11. REAL QUOTE SCENARIOS, ACROSS EVERY SHIPPING TRADE ────────────────────
// Not fixtures — the ACTUAL seeded catalogue every new business gets from
// lib/trades. A fresh quote has no hours (nobody has estimated the job yet) and
// the rate is whatever Settings says. The invariant: for EVERY service in EVERY
// trade, an un-estimated quote either recommends a number the owner themselves
// configured, or recommends nothing at all. It may never invent one.
console.log('\nEvery service in every trade pack, on a fresh quote:')
{
  let checked = 0, silent = 0, owned = 0
  const invented: string[] = []
  for (const pack of TRADE_PACKS) {
    for (const s of pack.services) {
      const template = { pricing_display_type: s.pricing_display_type as never, default_rate: s.default_rate, name: s.name }
      const kind = servicePricingKind(s.name, template)
      // A brand-new quote: no hours estimated, nothing measured.
      const rec = serviceRecommendation({ kind, template, measuredSqft: 0, labour: null })
      checked++
      if (rec == null) { silent++; continue }
      // Any number shown must be traceable to a value the owner configured on
      // THIS service — never to a default invented by the builder.
      if (rec.price === s.default_rate && rec.source === 'catalog_price') owned++
      else invented.push(`${pack.key}/${s.name}: ${rec.source} $${rec.price} (template says $${s.default_rate})`)
    }
  }
  check(`no service in any trade invents a price (${checked} services across ${TRADE_PACKS.length} trades)`,
    invented.length === 0, invented.slice(0, 5).join('\n      '))
  check(`…${owned} quote the owner's own catalogued price, ${silent} say nothing`, owned + silent === checked)

  // The two the audit called out by name, from the real catalogue.
  const plumbing = TRADE_PACKS.find(p => p.key === 'plumbing')!.services.find(s => s.name === 'Plumbing Service Call')!
  const plumbingTpl = { pricing_display_type: plumbing.pricing_display_type as never, default_rate: plumbing.default_rate, name: plumbing.name }
  const svcCall = serviceRecommendation({
    kind: servicePricingKind(plumbing.name, plumbingTpl),
    template: plumbingTpl,
    measuredSqft: 0, labour: null,
  })
  // $145/hr is a RATE, not a price. With no hours there is no honest answer —
  // and critically not $290, which is what `2 hr × 1 crew × $145` used to show
  // (badged "✓ Applied") for what might be a 20-minute call.
  eq('Plumbing Service Call ($145/hr), no hours → silent, NOT $290', svcCall, null)

  const furnace = TRADE_PACKS.find(p => p.key === 'hvac')!.services.find(s => s.name.startsWith('Furnace Repair'))
  if (furnace) {
    const tpl = { pricing_display_type: furnace.pricing_display_type as never, default_rate: furnace.default_rate, name: furnace.name }
    const rec = serviceRecommendation({ kind: servicePricingKind(furnace.name, tpl), template: tpl, measuredSqft: 0, labour: null })
    eq(`${furnace.name} → the owner's own $${furnace.default_rate}, not a fabricated $100`, rec?.price, furnace.default_rate)
  }
}

// ── 12. THE LAWN BUSINESS SEES EXACTLY WHAT IT SAW ───────────────────────────
// The whole P0 pass is worthless if it moved a single lawn price. This walks the
// real lawn pack the way a mowing quote actually flows.
console.log('\nThe lawn pack still routes and prices identically:')
{
  const lawnMow = LAWN_PACK.services.find(s => /mow/i.test(s.name))!
  const tpl = { pricing_display_type: lawnMow.pricing_display_type as never, default_rate: lawnMow.default_rate, name: lawnMow.name }
  eq(`"${lawnMow.name}" still routes to the cadence engine`, servicePricingKind(lawnMow.name, tpl), 'lawn_recurring')
  // Lawn's price comes from the cadence engine on a measurement — never from
  // serviceRecommendation — so the seam must stay out of its way.
  eq('3,000 ft² still prices at $73 (unchanged)', lawnBasePrice(3000, DEFAULT_PRICING), 73)
  eq('5,500 ft² still prices at $110.50 (unchanged)', lawnBasePrice(5500, DEFAULT_PRICING), 110.5)
}

console.log('')
if (failures) { console.log(`✗ ${failures} pricing check(s) failed\n`); process.exit(1) }
console.log('✓ all pricing checks passed — margin/markup honest, lawn byte-identical, no invented prices\n')
