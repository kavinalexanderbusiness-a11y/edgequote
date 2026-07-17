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
import { SYSTEM_UNITS, resolveUnit, formatQuantity, formatUnitRate, loadServiceUnits } from '../src/lib/units'
import type { PricingDisplayType } from '../src/types'

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

// ── 13. THE CADENCE ENGINE ONLY SPEAKS FOR SERVICES IT CAN PRICE ─────────────
// §10 established that an UNNAMED service is not a lawn. This is the other half:
// a service that IS named, and whose name mentions grass, still is not necessarily
// priced by lawn area. "String Trimming" and "Lawn Edging" are real catalogue
// services that routed to the cadence engine, so both were offered Weekly /
// Bi-Weekly / Monthly at `base + (lawn_sqft/1000 × mow_rate)` — a mowing price, on
// a mowing cadence, for trimming. The existing Lawn Edging quote is the tell: a
// one-time price with every cadence field null.
//
// The routing predicate is deliberately NOT serviceKey()'s 'mowing' bucket, which
// is wide on purpose (trim|string|edg|cut) so a trimming visit's minutes still
// teach the mowing crew's labour model. Right for LEARNING, wrong for PRICING.
console.log('\nThe cadence engine only speaks for services it can price:')
{
  const kind = (s: string | null | undefined, t?: PricingDisplayType) =>
    servicePricingKind(s, t ? { pricing_display_type: t } : null)

  // LAWN — byte-identical, including the ad-hoc names a free-text field collects.
  for (const s of ['Weekly Mowing', 'Bi-Weekly Mowing', 'Lawn Mowing', 'Lawn mowing',
                   'One-Time Mowing', 'mowing', 'mow', 'lawn mow', 'Grass Cut']) {
    eq(`lawn cadence still owns "${s}"`, kind(s), 'lawn_recurring')
  }
  eq('a trailing space does not unroute mowing', kind('Weekly Mowing '), 'lawn_recurring')

  // ORDERING IS LOAD-BEARING. SERVICE_DEFS is ordered, so a name carrying TWO
  // services resolves to the EARLIER def: "mow + prune" is 'hedge', not mowing.
  // Testing the cadence pattern BEFORE serviceKey() reads fine and would promote it
  // to a lawn cadence, silently repricing it. This pins the ordering.
  eq('"mow + prune" is still hedge/labour, not mowing', kind('mow + prune '), 'labour')

  // THE FIX — 'mowing' to serviceKey(), but not priced by lawn area.
  eq('String Trimming is one-time labour', kind('String Trimming'), 'labour')
  eq('Lawn Edging is one-time labour', kind('Lawn Edging'), 'labour')
  eq('Tree Trimming is one-time labour', kind('Tree Trimming'), 'labour')
  eq('a plumber\'s "Cut and cap" is one-time labour', kind('Cut and cap'), 'labour')
  eq('"String Lights" is one-time labour', kind('String Lights'), 'labour')

  // Already correct before the change — pinned so they stay that way.
  eq('Mulch Installation is area-priced', kind('Mulch Installation'), 'per_area')
  eq('Gravel Installation is area-priced', kind('Gravel Installation'), 'per_area')
  eq('Rock Installation is area-priced', kind('Rock Installation'), 'per_area')
  eq('Landscape Bed Cleanup is one-time labour', kind('Landscape Bed Cleanup'), 'labour')
  eq('Pressure Washing is one-time labour', kind('Pressure Washing'), 'labour')
  eq('Hedge Trimming is one-time labour', kind('Hedge Trimming'), 'labour')
  eq('Snow Removal is one-time labour', kind('Snow Removal'), 'labour')

  // The owner's CONFIGURED display type still wins over any name guess.
  eq('an hourly template beats the name', kind('Lawn Mowing', 'hourly'), 'labour')
  eq('a per_sqft template beats the name', kind('Lawn Mowing', 'per_sqft'), 'per_area')
  eq('per_linear_ft is labour', kind('Fence Staining', 'per_linear_ft'), 'labour')
}

// ── 14. EVERY SUPPORTED UNIT RESOLVES AND READS CORRECTLY ────────────────────
// The nine system units are the vocabulary a non-lawn trade quotes in. They are
// seeded in the DB (RUN-2026-07-15-service-units-vocabulary.sql) and mirrored by
// SYSTEM_UNITS for read failures. The mirror is the risk: a fallback that
// disagrees with the table is a second vocabulary, which is exactly what the old
// four-value SERVICE_UNITS list was.
console.log('\nEvery supported unit resolves and reads correctly:')
{
  eq('there are nine system units', SYSTEM_UNITS.length, 9)
  // The FULL fingerprint of the seeded rows, not just their codes — abbrev is the
  // wording on a line, step/decimals are the quantity input's behaviour. Verified
  // against live prod; re-check with:
  //   select code,label,abbrev,step,decimals,sort_order from service_units
  //   where user_id is null order by sort_order;
  const fingerprint = SYSTEM_UNITS
    .map(u => [u.code, u.label, u.abbrev, u.step, u.decimals, u.sort_order].join('|'))
    .join(' ;; ')
  eq('…and they mirror the seeded rows exactly', fingerprint,
    'each|Each|each|1|0|10 ;; hour|Hours|hr|0.25|2|20 ;; flat|Flat rate|flat|1|0|30 ;; ' +
    'sqft|Square feet|sq ft|1|0|40 ;; linear_ft|Linear feet|linear ft|1|0|50 ;; ' +
    'fixture|Fixtures|fixture|1|0|60 ;; room|Rooms|room|1|0|70 ;; zone|Zones|zone|1|0|80 ;; ' +
    'equipment|Equipment|unit|1|0|90')

  for (const u of SYSTEM_UNITS) {
    eq(`"${u.code}" resolves to itself`, resolveUnit(SYSTEM_UNITS, u.code).code, u.code)
  }

  // The line maths is qty × unit_price for EVERY unit — serviceLineTotals takes no
  // unit argument at all, which is the invariant this pins.
  for (const u of SYSTEM_UNITS) {
    eq(`"${u.code}" line: 6 × $25 is still $150`,
       serviceLineTotals({ quantity: 6, unit_price: 25, discount_type: null, discount_value: null }).gross, 150)
  }

  // Rate + quantity wording per unit — what the owner actually reads on a line.
  eq('hourly reads as a rate',        formatUnitRate(SYSTEM_UNITS, 'hour', 95), '$95/hr')
  eq('per sq ft keeps its cents',     formatUnitRate(SYSTEM_UNITS, 'sqft', 3.5), '$3.50/sq ft')
  eq('linear ft reads as a rate',     formatUnitRate(SYSTEM_UNITS, 'linear_ft', 8), '$8/linear ft')
  eq('per fixture reads as a rate',   formatUnitRate(SYSTEM_UNITS, 'fixture', 150), '$150/fixture')
  eq('per room reads as a rate',      formatUnitRate(SYSTEM_UNITS, 'room', 80), '$80/room')
  eq('per zone reads as a rate',      formatUnitRate(SYSTEM_UNITS, 'zone', 45), '$45/zone')
  eq('per equipment reads as a rate', formatUnitRate(SYSTEM_UNITS, 'equipment', 200), '$200/unit')
  eq('each reads as a rate',          formatUnitRate(SYSTEM_UNITS, 'each', 20), '$20/each')
  // 'flat' is a shape of deal, not a count — it must never read "1 flat".
  eq('flat is a deal, not a count',   formatUnitRate(SYSTEM_UNITS, 'flat', 65), '$65 flat')
  eq('…and its quantity says so too', formatQuantity(SYSTEM_UNITS, 'flat', 1), 'Flat rate')
  eq('6 fixtures',                    formatQuantity(SYSTEM_UNITS, 'fixture', 6), '6 fixture')
  eq('hours keep their decimals',     formatQuantity(SYSTEM_UNITS, 'hour', 2.5), '2.50 hr')
  eq('sq ft are whole and grouped',   formatQuantity(SYSTEM_UNITS, 'sqft', 1200), '1,200 sq ft')

  // A quote written before this vocabulary existed must never lose its word.
  eq('an unknown legacy code renders as itself', resolveUnit(SYSTEM_UNITS, 'bags').code, 'bags')
  eq('…and an empty code falls to the default', resolveUnit(SYSTEM_UNITS, '').code, 'each')
}

// (async: §15 exercises the loader itself. Top-level await is unavailable here —
// tsx transforms these scripts to CJS — so the tail runs in an IIFE and reports
// from inside it.)
void (async () => {
  // ── 15. A FAILED READ MUST NOT SHRINK THE VOCABULARY ───────────────────────
  // loadServiceUnits() returned [] on error and the picker then fell back to four
  // hardcoded units — so one failed read (offline, RLS hiccup, cold start) quietly
  // took fixture/room/zone/equipment/flat off a plumber's quote form, with nothing
  // on screen to say why. It degrades to "no custom units" now, never to a
  // different vocabulary.
  console.log('\nA failed read degrades to the system nine, never to fewer:')
  const clientReturning = (res: { data: unknown; error: unknown }) => ({
    from: () => ({ select: () => ({ eq: () => ({ order: async () => res }) }) }),
  }) as unknown as Parameters<typeof loadServiceUnits>[0]

  const onError = await loadServiceUnits(clientReturning({ data: null, error: { message: 'offline' } }))
  eq('an errored read still yields nine units', onError.length, 9)
  check('…and fixture survives it', onError.some(u => u.code === 'fixture'),
        'fixture was dropped — the picker just lost a plumber their unit')

  const onEmpty = await loadServiceUnits(clientReturning({ data: [], error: null }))
  eq('an empty table also yields nine', onEmpty.length, 9)

  // A successful read is still authoritative — the fallback must not mask real rows.
  const custom = [{ id: 'x', user_id: 'u1', code: 'pallet', label: 'Pallets', abbrev: 'pallet', step: 1, decimals: 0, sort_order: 5, active: true }]
  const onOk = await loadServiceUnits(clientReturning({ data: custom, error: null }))
  eq('a real read wins over the fallback', onOk.length, 1)
  eq('…and it is the owner\'s own unit', onOk[0].code, 'pallet')

  // ── 16. ONLY LAWN MAY BE HANDED A SAVED LAWN RECOMMENDATION ────────────────
  // §13 pins which services the cadence engine may PRICE. This is the next
  // question: which services may READ a price it already produced.
  // buildSavedRecommendation() wraps pricingPackage(), so a SavedRecommendation is
  // a Weekly/Bi-Weekly GRASS price list — and it carries NO record of the service
  // it was built for. latestSavedRecommendation() just returns the newest snapshot
  // that has one, so every consumer must ask §13's question first, through the same
  // seam.
  //
  // Four surfaces now depend on this gate: the quote builder's "Use measured
  // prices", the MeasureTool→quote handoff, JobForm's cadence auto-fill, and the
  // property card. A regression puts mowing prices on a furnace quote, and neither
  // tsc nor next build can see a wrong VALUE.
  console.log('\nOnly a lawn-cadence service may be handed a saved lawn recommendation:')
  const mayReadLawnRec = (serviceName: string, tpl: { pricing_display_type: PricingDisplayType; default_rate: number; name: string } | null) =>
    servicePricingKind(serviceName, tpl) === 'lawn_recurring'

  for (const pack of TRADE_PACKS) {
    const primary = pack.services[0]
    const tpl = { pricing_display_type: primary.pricing_display_type as PricingDisplayType, default_rate: primary.default_rate, name: primary.name }
    const allowed = mayReadLawnRec(primary.name, tpl)
    // The MeasureTool→quote handoff defaults service_type to the owner's FIRST
    // active template and used to seed the lawn engine's prices alongside it.
    if (pack.key === 'lawn_landscaping') {
      check(`${pack.key}: primary "${primary.name}" DOES take lawn prices (unchanged)`, allowed)
    } else {
      check(`${pack.key}: primary "${primary.name}" is refused lawn prices`, !allowed,
        `${primary.name} routed to lawn_recurring — a ${pack.key} handoff would seed mowing prices`)
    }
  }

  // JobForm has no template at all (service_type is free text), so the gate must
  // hold on the name alone.
  eq('JobForm (name only): "Snow Removal" is refused lawn prices', mayReadLawnRec('Snow Removal', null), false)
  eq('JobForm (name only): "Furnace Tune-Up" is refused', mayReadLawnRec('Furnace Tune-Up', null), false)
  eq('JobForm (name only): "Lawn Mowing" still allowed', mayReadLawnRec('Lawn Mowing', null), true)
  // §13 narrowed the cadence engine; a saved lawn rec must follow it exactly —
  // "String Trimming" is in serviceKey's mowing bucket but is NOT lawn-priced, so
  // it must not inherit a mowing price list either.
  eq('String Trimming is refused too (agrees with §13)', mayReadLawnRec('String Trimming', null), false)
  // The empty form must never be treated as lawn — it is how every quote starts.
  eq('no service yet → refused (not lawn)', mayReadLawnRec('', null), false)

  console.log('')
  if (failures) { console.log(`✗ ${failures} pricing check(s) failed\n`); process.exit(1) }
  console.log('✓ all pricing checks passed — margin/markup honest, lawn byte-identical, no invented prices, one unit vocabulary, no borrowed lawn recs\n')
})()
