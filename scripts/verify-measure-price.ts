// ── Verify: measure it, price it, and never guess ────────────────────────────
//   npm run verify:measure-price
//
// WHY THIS SCRIPT EXISTS
// Measure & Price V2 made two promises that are easy to state and easy to break
// silently:
//
//   1. THE PRICE BOOK DECIDES, NOT THE SERVICE'S NAME. A snow contractor, a
//      pressure washer and a floor cleaner reach the same code and get their own
//      numbers, because how a service is measured and the ways it is sold are
//      rows the owner configured. The moment a `/snow/i` or `/lawn/i` appears in
//      a pricing path, the product has quietly become a landscaping app again.
//
//   2. AN UNKNOWN PRICE IS NOT $0. A plan with no rate, or a per-unit plan with
//      nothing measured, has NO price. Rendering zero would put "$0.00 / visit"
//      in front of a customer — not a cheap quote, a wrong one.
//
// Neither promise is expressible in the type system: `null` and `0` are both
// numbers to a reader, and a regex on a service name type-checks perfectly.
//
// It also pins the two things this session got wrong and had to fix, so neither
// can come back:
//   • the Google loader contract (ONE library, and an auth refusal that surfaces)
//   • per-unit rate PRECISION — numeric(10,2) silently made $0.035/ft² into
//     $0.04, a 14% overcharge produced by a column type
//
// This executes the real engine and parses the real migration. It never mocks the
// thing under test.

import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

import {
  PRICING_TERMS, termDef, isPricingTerm, measurementTypeFor, isMeasured,
  unitForMeasurementType, unitLabel, formatMeasured, unitRatePrice,
  pricePlan, pricePlans, defaultPlan, pricedOnly, formatPlanPrice,
  unpricedReason, UNPRICED_COPY, buildMeasurementSnapshot,
  type ServicePricingPlan, type MeasurementType, type PricedPlan,
} from '../src/lib/measurePricing'

let failures = 0
const ok = (name: string) => console.log(`  ✓ ${name}`)
const fail = (name: string, detail: string) => { failures++; console.log(`  ✗ ${name}\n      ${detail}`) }
const check = (name: string, cond: boolean, detail = '') => (cond ? ok(name) : fail(name, detail))
const eq = (name: string, actual: unknown, expected: unknown) =>
  check(name, JSON.stringify(actual) === JSON.stringify(expected),
    `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`)

const ROOT = process.cwd()
const read = (p: string) => readFileSync(join(ROOT, p), 'utf8')

/**
 * Source with comments removed.
 *
 * ⚠️ Load-bearing, and it caught this guard out on its first run. The rules below
 * are about what the CODE does, and the code is surrounded by comments that
 * necessarily NAME the things it must not touch — measurePricing's own header
 * explains at length that a commercial term must never reach job_recurrences.
 * Grepping raw source flags the explanation of a rule as a violation of it, which
 * would train the next person to delete the explanation.
 */
const stripComments = (s: string) =>
  s.replace(/\/\*[\s\S]*?\*\//g, '').split('\n').filter(l => !l.trim().startsWith('//')).join('\n')

const plan = (o: Partial<ServicePricingPlan>): ServicePricingPlan => ({
  service_template_id: 't1', term: 'one_time', basis: 'per_unit', rate: 0.05, ...o,
})

// ── 1. Measurement type comes from configuration, never from a name ─────────
console.log('\nWhat is measured is the owner\'s answer')

eq('explicit measured_by wins', measurementTypeFor({ measured_by: 'area' }), 'area')
eq('length is a first-class type', measurementTypeFor({ measured_by: 'length' }), 'length')
eq('count is a first-class type', measurementTypeFor({ measured_by: 'count' }), 'count')
eq('unset means not measured', measurementTypeFor({}), 'none')
eq('null template is not measured', measurementTypeFor(null), 'none')

// The legacy bridge: two display types have ALWAYS implied a measurement.
eq('per_sqft implies area', measurementTypeFor({ pricing_display_type: 'per_sqft' }), 'area')
eq('per_linear_ft implies length', measurementTypeFor({ pricing_display_type: 'per_linear_ft' }), 'length')
eq('hourly implies nothing', measurementTypeFor({ pricing_display_type: 'hourly' }), 'none')
eq('explicit beats the bridge', measurementTypeFor({ measured_by: 'none', pricing_display_type: 'per_sqft' }), 'none')

check('a not-measured service is not offered measurement', isMeasured({}) === false)
check('a measured service is', isMeasured({ measured_by: 'area' }) === true)

// ⭐ THE UNIVERSALITY CLAIM, stated as an executable fact: the SAME configuration
// produces the SAME answer whatever the service is called. If any name ever
// enters this path, one of these diverges.
const NAMES = ['Snow Removal', 'Lawn Mowing', 'Pressure Washing', 'Floor Cleaning',
  'Painting', 'Sod Installation', 'Fertilizer', 'Ostrich Grooming']
const sameConfig = { measured_by: 'area' as const }
check('measurement type ignores the service name',
  NAMES.every(() => measurementTypeFor(sameConfig) === 'area'),
  'measurementTypeFor takes no name and must never be given one')

// ── 2. Units and formatting ─────────────────────────────────────────────────
console.log('\nUnits')

eq('area is square feet', unitForMeasurementType('area'), 'sqft')
eq('length is linear feet', unitForMeasurementType('length'), 'linear_ft')
eq('count is a count', unitForMeasurementType('count'), 'count')
eq('not-measured has no unit', unitForMeasurementType('none'), null)
eq('an area reads in sq ft', formatMeasured(1392, 'area'), '1,392 sq ft')
eq('a length reads in linear ft', formatMeasured(86, 'length'), '86 linear ft')
eq('a count carries no unit word', formatMeasured(3, 'count'), '3')
eq('count has no unit label', unitLabel('count'), '')

// ── 3. The one multiplication ───────────────────────────────────────────────
console.log('\nThe measurement → money step')

eq('rate × measurement, to the dollar', unitRatePrice(0.05, 1392), 70)   // 69.6
eq('rounds half up', unitRatePrice(0.5, 1), 1)                            // 0.5
eq('a zero measurement is zero money', unitRatePrice(0.05, 0), 0)
// ⚠️ Sub-cent rates are REAL. $0.035/ft² is an ordinary area price, and the
// migration that stored it in numeric(10,2) turned it into $0.04 — this asserts
// the arithmetic keeps the precision the column now preserves.
eq('a sub-cent rate is not rounded away', unitRatePrice(0.035, 1392), 49) // 48.72

// ── 4. Unknown is unknown — the honesty rule ────────────────────────────────
console.log('\nAn unknown price is never zero')

const noRate = pricePlan(plan({ rate: 0 }), 1392, 'area')
eq('no rate configured → null price', noRate.price, null)
check('and says so', /no rate configured/i.test(noRate.basisText), noRate.basisText)

const negative = pricePlan(plan({ rate: -5 }), 1392, 'area')
eq('a negative rate is not a price', negative.price, null)

const unmeasured = pricePlan(plan({ rate: 0.05 }), null, 'area')
eq('per-unit with nothing measured → null price', unmeasured.price, null)
check('and asks for a measurement', /measure to price/i.test(unmeasured.basisText), unmeasured.basisText)

const zeroArea = pricePlan(plan({ rate: 0.05 }), 0, 'area')
eq('a zero-area polygon prices nothing', zeroArea.price, null)

// A FLAT plan needs no measurement — that is the whole point of flat.
const flat = pricePlan(plan({ term: 'monthly', basis: 'flat', rate: 240 }), null, 'area')
eq('a flat plan prices without a measurement', flat.price, 240)

// ⭐ THE MUTATION THIS GUARD EXISTS FOR. If anyone ever "tidies" a null price to
// 0, every one of these turns into a real dollar figure on a customer's quote.
const unknowns = [noRate, negative, unmeasured, zeroArea]
check('no unknown price is expressible as a number',
  unknowns.every(p => p.price === null && typeof p.price !== 'number'),
  'changing `null` to `0` in pricePlan must fail this line')
check('an unknown price has no display string',
  unknowns.every(p => formatPlanPrice(p) === null))
check('unknown plans are excluded from what may reach a customer',
  pricedOnly(unknowns).length === 0)

// ── 5. Priced plans, in the owner's order ───────────────────────────────────
console.log('\nThe ways a service is sold')

const snowLike: ServicePricingPlan[] = [
  plan({ term: 'one_time', basis: 'per_unit', rate: 0.05, sort_order: 0 }),
  plan({ term: 'monthly', basis: 'flat', rate: 240, is_recommended: true, sort_order: 1 }),
  plan({ term: 'seasonal', basis: 'flat', rate: 900, sort_order: 2 }),
]
const snowPriced = pricePlans(snowLike, 1392, 'area')
eq('three offerings priced', snowPriced.map(p => p.price), [70, 240, 900])
eq('each carries its own unit', snowPriced.map(p => p.priceSuffix), ['/visit', '/month', '/season'])
eq('one-time shows its working', snowPriced[0].basisText, '$0.05/sq ft × 1,392 sq ft')
eq('the display string is whole', formatPlanPrice(snowPriced[0]), '$70 /visit')
eq('the recommended plan is the default', defaultPlan(snowPriced)?.term, 'monthly')

const mowLike: ServicePricingPlan[] = [
  plan({ term: 'one_time', basis: 'per_unit', rate: 0.04, sort_order: 0 }),
  plan({ term: 'weekly', basis: 'per_unit', rate: 0.03, is_recommended: true, sort_order: 1 }),
  plan({ term: 'biweekly', basis: 'per_unit', rate: 0.05, sort_order: 2 }),
  plan({ term: 'monthly', basis: 'flat', rate: 180, sort_order: 3 }),
]
const mowPriced = pricePlans(mowLike, 1392, 'area')
eq('a different shape, same engine', mowPriced.map(p => p.price), [56, 42, 70, 180])
eq('weekly and bi-weekly are per VISIT, not per week',
  [termDef('weekly').priceSuffix, termDef('biweekly').priceSuffix], ['/visit', '/visit'])

// ⭐⭐ THE POINT OF THE WHOLE FEATURE, as one assertion: the shape of the offer
// belongs to the owner, not to the trade. Two different plan sets, one engine,
// no branch anywhere on which service this is.
check('the plan set is data, not a code path',
  snowPriced.length === 3 && mowPriced.length === 4,
  'both came out of pricePlans() with no service identity involved')

eq('the owner\'s order is preserved', pricePlans([
  plan({ term: 'seasonal', basis: 'flat', rate: 900, sort_order: 0 }),
  plan({ term: 'one_time', basis: 'per_unit', rate: 0.05, sort_order: 1 }),
], 1392, 'area').map(p => p.term), ['seasonal', 'one_time'])

eq('no plans configured is a real answer', pricePlans([], 1392, 'area'), [])
eq('no plans means no default', defaultPlan([]), null)

// ── 6. Why there is no price, in the owner's language ───────────────────────
console.log('\nSaying why, rather than showing zero')

eq('a service that is not measured', unpricedReason({}, snowLike, 1392), 'not_measured')
eq('a measured service with no plans', unpricedReason(sameConfig, [], 1392), 'no_plans')
eq('plans that need a measurement', unpricedReason(sameConfig, snowLike.slice(0, 1), null), 'no_measurement')
eq('plans with no rates set', unpricedReason(sameConfig, [plan({ rate: 0 })], 1392), 'no_rates')
eq('a priced service has no complaint', unpricedReason(sameConfig, snowLike, 1392), null)
check('every reason has a sentence',
  (['not_measured', 'no_plans', 'no_measurement', 'no_rates'] as const)
    .every(r => typeof UNPRICED_COPY[r] === 'string' && UNPRICED_COPY[r].length > 10))
check('no reason sentence claims a price',
  Object.values(UNPRICED_COPY).every(s => !/\$/.test(s)),
  'an explanation of a missing price must not contain a dollar figure')

// ── 7. Commercial term ≠ operational recurrence ─────────────────────────────
console.log('\nA term is how it is BOUGHT, not when it is VISITED')

const TERM_KEYS = PRICING_TERMS.map(t => t.key)
eq('the five commercial terms', TERM_KEYS, ['one_time', 'weekly', 'biweekly', 'monthly', 'seasonal'])
check('every term is recognised', TERM_KEYS.every(isPricingTerm))
check('an unknown term is refused', !isPricingTerm('fortnightly'))
check('an unknown term throws rather than defaulting', (() => {
  try { termDef('fortnightly' as never); return false } catch { return true }
})(), 'defaulting to One-time would put the wrong word on a customer quote')

// ⛔⛔ THE SEPARATION, ENFORCED AT THE SOURCE. If lib/measurePricing ever imports
// a scheduling engine, or grows a visits-per-term table, "monthly" starts
// meaning "four visits" — inventing work nobody scheduled.
const PRICING_SRC = stripComments(read('src/lib/measurePricing.ts'))
for (const forbidden of ['job_recurrences', 'lib/recurrence', 'serviceRecurrence', 'dayPlan', 'scheduleItems']) {
  check(`measurePricing does not reach into ${forbidden}`, !PRICING_SRC.includes(forbidden),
    'a commercial term must never be able to create a visit')
}
check('measurePricing derives no visit count',
  !/visitsPer|visitCount|timesPerMonth|perMonthVisits/i.test(PRICING_SRC),
  'a seasonal contract might be eight visits or twenty-two; only dispatch knows')

// ── 8. No trade words in the pricing path ───────────────────────────────────
console.log('\nNo service-name logic anywhere in pricing')

// Deliberately over-broad: these words are allowed in COMMENTS (they explain the
// history) but never in code — so this uses the shared stripComments above.
const TRADE_WORDS = /\b(snow|lawn|mow|grass|plow|shovel|salt|ice|mulch|driveway)\b/i
for (const f of ['src/lib/measurePricing.ts', 'src/lib/servicePlans.ts']) {
  const code = stripComments(read(f))
  const hit = code.match(TRADE_WORDS)
  check(`${f} contains no trade word in code`, !hit,
    hit ? `found "${hit[0]}" — the Price Book decides, not the name` : '')
}

// ── 9. The frozen quote record ──────────────────────────────────────────────
console.log('\nWhat the quote remembers')

const snap = buildMeasurementSnapshot({
  type: 'area', value: 1392,
  parts: [
    { label: 'Driveway', value: 1180, ring: [{ lat: 51, lng: -114 }] },
    { label: 'Front walkway', value: 212 },
  ],
  measuredAt: '2026-08-24T00:00:00.000Z',
  serviceTemplateId: 't1', serviceName: 'Anything At All',
  plan: snowPriced[1],
})
eq('the snapshot is versioned', snap.v, 2)
eq('the total is recorded', snap.value, 1392)
eq('the unit is recorded', snap.unit, 'sqft')
eq('each traced piece survives', snap.parts.length, 2)
eq('the term is frozen', snap.term, 'monthly')
eq('the basis is frozen', snap.basis, 'flat')
eq('the RATE is frozen, not looked up later', snap.rate, 240)
eq('the resulting price is frozen', snap.price, 240)

// ⭐ THE FREEZE, PROVED. Change the Price Book afterwards; the snapshot must not
// move. This is what stops a rate rise silently rewriting an accepted quote.
const laterPlans = pricePlans([plan({ term: 'monthly', basis: 'flat', rate: 999 })], 1392, 'area')
eq('the live plan has changed', laterPlans[0].price, 999)
eq('the snapshot has not', snap.rate, 240)
check('a snapshot is a copy, not a reference',
  snap.price === 240 && laterPlans[0].price === 999)

// A measurement applied with no plan behind it records the measurement honestly
// and claims no price.
const bare = buildMeasurementSnapshot({
  type: 'area', value: 800, parts: [], measuredAt: '2026-08-24T00:00:00.000Z',
  serviceTemplateId: null, serviceName: null, plan: null,
})
eq('a bare measurement records no term', bare.term, null)
eq('a bare measurement records no price', bare.price, null)
check('a bare measurement still records the amount', bare.value === 800)

// ── 10. Tenancy is the database's job, and is actually declared ─────────────
console.log('\nTenant boundary')

// ⚠️ READ THE APPLY PATH, NOT A FILENAME. A migration has two lives: its own file
// while in flight, and the generated baseline once production has run it and the
// baseline absorbs it (the file then moves to archive/ledger/, which is never
// applied). Pinning the filename made this guard CRASH — ENOENT — the moment the
// schema converged, which stops every check below it from running at all.
// The invariants are about the STATE the apply path produces, so read all of it,
// and match both spellings: a hand-written `in ('a','b')` and the generated
// `= ANY (ARRAY['a'::text,…])` are one constraint written two ways.
const MIGRATION = readdirSync(join(ROOT, 'supabase', 'migrations'))
  .filter(f => f.endsWith('.sql')).sort()
  .map(f => readFileSync(join(ROOT, 'supabase', 'migrations', f), 'utf8'))
  .join('\n')
check('plans carry a user_id', /"user_id"\s+uuid\s+not null/.test(MIGRATION))
check('RLS is enabled on the plans table',
  /alter table[^;]*"service_pricing_plans"[^;]*enable row level security/i.test(MIGRATION))
// ⭐ THE COMPOSITE FK IS THE REAL GUARANTEE: it makes attaching a plan to another
// tenant's service impossible at the constraint, not at a check someone can forget.
// ⚠️ SCOPE THE SEARCH TO THIS TABLE. `service_bundle_items` carries a
// byte-identical composite FK onto service_templates, so an unscoped search for
// the shape is satisfied by the OTHER table's weld — the check would go green with
// this one deleted. Found by mutation: weakening the FK left the guard passing,
// because replace() had rewritten service_bundle_items instead.
// Take only the lines that name service_pricing_plans, then ask about those.
const PLAN_FKS = MIGRATION.split('\n').filter(l =>
  /service_pricing_plans/.test(l) && /foreign key/i.test(l) && /service_template_id/i.test(l)).join('\n')
check('a plan cannot be attached to a foreign service',
  PLAN_FKS.length > 0 &&
  /foreign key\s*\(\s*"?service_template_id"?\s*,\s*"?user_id"?\s*\)\s*references\s+(public\.)?"?service_templates"?\s*\(\s*"?id"?\s*,\s*"?user_id"?\s*\)/i.test(PLAN_FKS),
  PLAN_FKS.length === 0
    ? 'no service_pricing_plans → service_templates foreign key found at all'
    : `the (service_template_id, user_id) composite FK must reference service_templates(id, user_id); found: ${PLAN_FKS.slice(0, 160)}`)
check('one plan per term per service',
  /unique\s*\(\s*"?service_template_id"?\s*,\s*"?term"?\s*\)/i.test(MIGRATION),
  'two "Monthly" rows would be a choice between identical offers')
check('the term vocabulary is pinned in the database',
  TERM_KEYS.every(t => MIGRATION.includes(`'${t}'`)),
  'the TS union and the CHECK must agree, or a valid term is rejected at runtime')
check('the basis vocabulary is pinned in the database',
  /'per_unit'/.test(MIGRATION) && /'flat'/.test(MIGRATION))

// ⚠️ THE PRECISION BUG, PINNED. numeric(10,2) silently made $0.035/ft² into
// $0.04. Read the CURRENT declared type across both migrations — the corrective
// one widens it, and this must fail if anyone narrows it back.
// ⚠️ SCOPE IT TO THE TABLE. `"rate" numeric(8,2)` also appears in the apply path —
// it is quotes.rate, a different column entirely — so a whole-file search for a
// numeric precision answers about whichever table happened to match first. Cut the
// service_pricing_plans block out and ask inside it, and accept EITHER spelling:
// the corrective `alter column … type numeric(12,4)` while the migration is its own
// file, or the plain `"rate" numeric(12,4)` the generated baseline declares once it
// has been absorbed.
const PLANS_TABLE = (MIGRATION.match(
  /create table[^;]*?"service_pricing_plans"\s*\([\s\S]*?\n\);/i) || [''])[0]
check('the apply path actually declares service_pricing_plans', PLANS_TABLE.length > 0,
  'without the table block the precision check below would pass or fail for the wrong reason')
check('the rate column keeps sub-cent precision',
  /"?rate"?\s+numeric\(\s*12\s*,\s*4\s*\)/i.test(PLANS_TABLE)
  || /alter column\s+"?rate"?\s+type\s+numeric\(\s*12\s*,\s*4\s*\)/i.test(MIGRATION),
  'a per-unit rate finer than a cent is ordinary; numeric(10,2) overcharges by rounding it up')
// The other half of the same promise: the FORM must not refuse what the column
// keeps. step="0.01" made 0.035 :invalid, which blocked submit and silently saved
// nothing at all — the column was widened and the input still rounded to cents.
const EDITOR = read('src/components/pricing/MeasurePricingEditor.tsx')
check('the rate input admits four decimals, like the column',
  /step=\{[^}]*'0\.0001'/.test(EDITOR),
  'step="0.01" refuses 0.035: the field goes :invalid and the whole service fails to save')

// ── 11. The Google Maps loader contract ─────────────────────────────────────
console.log('\nThe map loads, or says why')

const LOADER = read('src/lib/googleMaps.ts')
check('exactly one Maps library is requested',
  /libraries=geometry(&|`)/.test(LOADER) && !/libraries=[^&`]*places/.test(LOADER),
  'places moved to the server key in lib/places.ts; asking for it here widens what the browser key must be allowed to do')
check('geometry IS requested', /libraries=geometry/.test(LOADER),
  'spherical.computeArea is the area engine behind every measurement')
// ⭐ THE FAULT THAT SHIPPED: an auth refusal resolves successfully, so awaiting
// the loader can never detect it. The hook must exist and must be installed
// BEFORE the script tag, or the only notice Google gives is missed.
check('gm_authFailure is hooked', /gm_authFailure\s*=/.test(LOADER))
check('the hook is installed before the script is injected',
  LOADER.indexOf('installAuthFailureHook()') < LOADER.indexOf('script.src'),
  'Google can refuse the key the moment it evaluates')
check('a refusal is remembered for surfaces that mount later',
  /export function onMapsUnavailable/.test(LOADER) && /if \(unavailable\)/.test(LOADER),
  'a map opened second must be as honest as the one opened first')
check('the owner-facing sentence names no key or origin',
  /MAPS_UNAVAILABLE_MESSAGE\s*=\s*'[^']*'/.test(LOADER) &&
  !/MAPS_UNAVAILABLE_MESSAGE\s*=\s*'[^']*(AIza|http)/.test(LOADER))

// ⛔ THE CUSTOMER MUST NEVER READ THE DIAGNOSTIC. It names the origin and the
// key's project; a stranger on the public booking funnel has no business seeing
// that this tenant's Maps key is misconfigured.
const PANEL = read('src/components/maps/MapUnavailable.tsx')
check('the no-map panel takes an audience', /audience/.test(PANEL))
const customerBranch = PANEL.slice(PANEL.indexOf(') : ('))
check('the customer branch never renders the diagnostic',
  !customerBranch.includes('unavailable.detail'),
  'detail is owner-only; verify:measure-price is the thing that keeps it that way')

console.log(failures === 0
  ? '\n✅ measure & price is honest: the Price Book decides, and an unknown price stays unknown\n'
  : `\n❌ ${failures} check${failures === 1 ? '' : 's'} failed\n`)
process.exit(failures === 0 ? 0 : 1)
