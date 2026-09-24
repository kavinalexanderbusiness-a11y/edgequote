import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import {
  decideAutomaticServicePrice,
  decideAutomaticServiceBundle,
  OWNER_APPROVED_MOWING_BASES_2026_09_23,
  type AutomaticServicePricingInput,
  type AutomaticServicePricingVersion,
  type AutomaticBundlePricingVersion,
} from '../src/lib/automaticServicePricing'
import { publicAutomaticServiceBundleEstimate, publicAutomaticServiceEstimate } from '../src/lib/automaticServicePricingServer'

const now = Date.parse('2026-09-23T18:00:00.000Z')
const rules: AutomaticServicePricingVersion = {
  id: '10000000-0000-4000-8000-000000000001',
  userId: '20000000-0000-4000-8000-000000000002',
  version: 1,
  serviceKey: 'mowing',
  enabled: true,
  permittedCadences: ['weekly', 'biweekly', 'one_time'],
  acceptedMeasurementConfidences: ['high'],
  acceptedMeasurementSources: ['city_open_data'],
  maximumMeasurementAgeMinutes: 30,
  basePrices: OWNER_APPROVED_MOWING_BASES_2026_09_23,
  baseLawnSqft: 2000,
  additionalPricePer1000Sqft: 10,
  additionalAreaPrice: 5,
  durationCrewBands: [{ maximumSqft: null, minutes: 60, crewSize: 1 }],
  loadedLabourCostPerHour: 30,
  materials: [],
  materialsCostBasisConfirmed: true,
  equipmentCostPerVisit: 5,
  deliveryCostPerVisit: 0,
  disposalCostPerVisit: 0,
  overheadCostPerVisit: 6,
  contingencyPercent: 10,
  vehicleCostPerKm: 1,
  includedRouteKm: 3,
  routePricePerAdditionalKm: 3,
  minimumNearbyJobsForBase: 2,
  isolatedStopPremium: 8,
  maximumAutomaticDistanceKm: 20,
  maximumRoutePremium: 30,
  maximumAutomaticPrice: 250,
  paymentFeePercent: 3,
  paymentFeeFixed: 0.3,
  minimumMarginPercent: 30,
  priceRoundingIncrement: 5,
  fullCostBasisConfirmed: true,
  routeRuleVersion: 'route-v1',
  pricingEngineVersion: 'automatic-service-v1',
}

function fixture(overrides: Partial<AutomaticServicePricingInput> = {}): AutomaticServicePricingInput {
  return {
    tenantId: rules.userId,
    serviceKey: 'mowing',
    cadence: 'weekly',
    rules,
    measurement: {
      verifiedByServer: true,
      sqft: 2500,
      areaCount: 2,
      confidence: 'high',
      source: 'city_open_data',
      measuredAt: '2026-09-23T17:50:00.000Z',
    },
    route: {
      verifiedByServer: true,
      provider: 'google_places',
      placeId: 'ChIJ-test',
      checkedAt: '2026-09-23T17:55:00.000Z',
      city: 'Calgary', province: 'AB', country: 'CA', quadrant: 'SE',
      lat: 51.05, lng: -114.08,
      baseDistanceKm: 8,
      routeTravelKm: 4,
      nearbyJobs: 3,
      eligibleRouteDays: 2,
      routeRuleVersion: 'route-v1',
    },
    nowMs: now,
    ...overrides,
  }
}

const noRules = decideAutomaticServicePrice(fixture({ rules: null }))
assert.equal(noRules.state, 'review_required')
assert.ok(noRules.state === 'review_required' && noRules.missing.some(item => item.code === 'pricing_version_missing'))

const weekly = decideAutomaticServicePrice(fixture())
assert.equal(weekly.state, 'priced')
assert.ok(weekly.state === 'priced')
assert.equal(weekly.basePrice, 45)
assert.equal(weekly.price, 75)
assert.equal(weekly.economics.marginPercent, 30.6)
assert.equal(weekly.estimateStatus, 'written_estimate')

const biweekly = decideAutomaticServicePrice(fixture({ cadence: 'biweekly' }))
assert.ok(biweekly.state === 'priced')
assert.equal(biweekly.basePrice, 55)
assert.equal(biweekly.price, 75)

const oneTime = decideAutomaticServicePrice(fixture({ cadence: 'one_time' }))
assert.ok(oneTime.state === 'priced')
assert.equal(oneTime.basePrice, 65)
assert.equal(oneTime.price, 85)

// Recurring mowing has no Northwest route. The same verified quadrant remains
// available to one-time work and every other service for owner review.
const northwestRecurring = decideAutomaticServicePrice(fixture({
  route: { ...fixture().route!, quadrant: 'NW' },
}))
assert.equal(northwestRecurring.state, 'out_of_route')
assert.ok(northwestRecurring.state === 'out_of_route'
  && northwestRecurring.code === 'northwest_recurring_mowing_unavailable')
const northwestOneTime = decideAutomaticServicePrice(fixture({
  cadence: 'one_time', route: { ...fixture().route!, quadrant: 'NW' },
}))
assert.equal(northwestOneTime.state, 'priced')
const far = decideAutomaticServicePrice(fixture({
  route: { ...fixture().route!, baseDistanceKm: 30 },
}))
assert.equal(far.state, 'out_of_route')
assert.ok(far.state === 'out_of_route' && far.code === 'route_economics_outside_owner_limits')

const noDay = decideAutomaticServicePrice(fixture({
  route: { ...fixture().route!, eligibleRouteDays: 0 },
}))
assert.ok(noDay.state === 'review_required' && noDay.missing.some(item => item.code === 'no_eligible_route_day'))

const stale = decideAutomaticServicePrice(fixture({
  measurement: { ...fixture().measurement!, measuredAt: '2026-09-23T16:00:00.000Z' },
}))
assert.ok(stale.state === 'review_required' && stale.missing.some(item => item.code === 'measurement_stale'))

const rawDifficulty = decideAutomaticServicePrice(fixture({ difficultyMultiplier: 1.25 }))
assert.ok(rawDifficulty.state === 'review_required'
  && rawDifficulty.missing.some(item => item.code === 'difficulty_not_server_verified'))

const materialRules: AutomaticServicePricingVersion = {
  ...rules,
  id: '10000000-0000-4000-8000-000000000003',
  serviceKey: 'fertilization',
  permittedCadences: ['one_time'],
  basePrices: { one_time: 95 },
  materials: [],
  materialsCostBasisConfirmed: false,
}
const materialsMissing = decideAutomaticServicePrice(fixture({
  serviceKey: 'fertilization', cadence: 'one_time', rules: materialRules,
}))
assert.ok(materialsMissing.state === 'review_required')
assert.ok(materialsMissing.state === 'review_required'
  && materialsMissing.missing.some(item => item.code === 'materials_missing')
  && materialsMissing.missing.some(item => item.code === 'materials_cost_basis_not_confirmed'))

const publicResponse = publicAutomaticServiceEstimate(weekly)
assert.equal(publicResponse.state, 'priced')
assert.equal(publicResponse.booking_status, 'not_booked')
assert.equal('economics' in publicResponse, false)
assert.equal('payment' in publicResponse, false)

const fertilizationPriced = decideAutomaticServicePrice(fixture({
  serviceKey: 'fertilization',
  cadence: 'one_time',
  rules: {
    ...rules,
    id: '10000000-0000-4000-8000-000000000004',
    serviceKey: 'fertilization',
    permittedCadences: ['one_time'],
    basePrices: { one_time: 95 },
    materialsCostBasisConfirmed: true,
    materials: [{
      key: 'fertilizer', packageCost: 35, packageQuantity: 10,
      applicationQuantityPer1000Sqft: 2, wastePercent: 5, minimumPackages: 1,
    }],
  },
}))
assert.equal(fertilizationPriced.state, 'priced')
const bundleRules: AutomaticBundlePricingVersion = {
  id: '10000000-0000-4000-8000-000000000009',
  userId: rules.userId,
  version: 1,
  enabled: true,
  minimumServices: 2,
  discountKind: 'percentage',
  discountValue: 10,
  maximumDiscount: 25,
  minimumMarginPercent: 15,
  pricingEngineVersion: 'automatic-bundle-v1',
}
const bundle = decideAutomaticServiceBundle([
  { serviceKey: 'mowing', label: 'Lawn mowing', cadence: 'weekly', decision: weekly },
  { serviceKey: 'fertilization', label: 'Lawn fertilization', cadence: 'one_time', decision: fertilizationPriced },
], bundleRules)
assert.equal(bundle.state, 'priced')
assert.ok(bundle.state === 'priced')
assert.equal(bundle.lines.length, 2)
assert.equal(bundle.subtotal, bundle.lines.reduce((sum, line) => sum + Number(line.price), 0))
assert.equal(bundle.discount, 21)
assert.equal(bundle.bundlePrice, 189)
const publicBundle = publicAutomaticServiceBundleEstimate(bundle)
assert.equal(publicBundle.state, 'priced')
assert.equal(publicBundle.bundle_price, bundle.bundlePrice)
assert.equal(publicBundle.bundle_discount, bundle.discount)
assert.equal(JSON.stringify(publicBundle).includes('economics'), false)

const noBundleConfig = decideAutomaticServiceBundle([
  { serviceKey: 'mowing', label: 'Lawn mowing', cadence: 'weekly', decision: weekly },
  { serviceKey: 'fertilization', label: 'Lawn fertilization', cadence: 'one_time', decision: fertilizationPriced },
])
assert.equal(noBundleConfig.state, 'written_quote_handoff')
assert.ok(noBundleConfig.state === 'written_quote_handoff')
assert.equal(noBundleConfig.reason, 'bundle_pricing_not_configured')
assert.equal(noBundleConfig.bundlePrice, null)

const customHandoff = decideAutomaticServiceBundle([
  { serviceKey: 'mowing', label: 'Lawn mowing', cadence: 'weekly', decision: weekly },
  { serviceKey: 'tree_pruning', label: 'Tree pruning', cadence: null, decision: null },
])
assert.equal(customHandoff.state, 'written_quote_handoff')
assert.ok(customHandoff.state === 'written_quote_handoff')
assert.equal(customHandoff.bundlePrice, null)
assert.equal(customHandoff.pricedSubtotal, weekly.state === 'priced' ? weekly.price : 0)
assert.equal(customHandoff.lines[1].price, null)
const publicHandoff = publicAutomaticServiceBundleEstimate(customHandoff)
assert.equal(publicHandoff.state, 'written_quote_handoff')
assert.equal(publicHandoff.bundle_price, null)
assert.equal(decideAutomaticServiceBundle([]).state, 'written_quote_handoff')

// Route premiums are server decisions within each line. The bundle calculator
// sums those final line prices and has no input for a browser-supplied price.
assert.ok(weekly.state === 'priced' && weekly.components.routePremium > 0)
const serverSource = fs.readFileSync(path.join(process.cwd(), 'src/lib/automaticServicePricingServer.ts'), 'utf8')
const bundleSignature = serverSource.slice(
  serverSource.indexOf('export async function attemptAutomaticServiceBundleEstimate'),
  serverSource.indexOf('/** Public response contains', serverSource.indexOf('export async function attemptAutomaticServiceBundleEstimate')),
)
assert.doesNotMatch(bundleSignature, /clientPrice|estimated_quote|price:\s*input/i)

const migration = fs.readFileSync(path.join(process.cwd(),
  'supabase/migrations/20260923083454_automatic_service_pricing_and_day_holds.sql'), 'utf8')
assert.match(migration, /automatic service pricing versions are immutable/)
assert.match(migration, /create table if not exists public\.automatic_bundle_pricing_versions/)
assert.match(migration, /create or replace function public\.save_automatic_bundle_pricing_version/)
assert.match(migration, /automatic bundle pricing: select own/)
assert.doesNotMatch(migration, /insert into public\.automatic_bundle_pricing_versions[\s\S]*?values\s*\(\s*['"]automatic/i)
assert.match(migration, /full_cost_basis_confirmed/)
assert.match(migration, /snow_owner_authorized/)
assert.match(migration, /public_quote_schedule_availability\(p_token, p_quote_id, 60\)/)
assert.match(migration, /'held_for_review'/)
assert.match(migration, /start_time, duration_minutes/)
assert.match(migration, /p_date, null, v_duration/)
assert.match(migration, /No arrival time is promised/)
assert.doesNotMatch(migration.match(/create or replace function public\.reserve_automatic_quote_day[\s\S]*?\$function\$;/)?.[0] || '', /insert into public\.jobs/i)
assert.doesNotMatch(migration.match(/create or replace function public\.reserve_automatic_quote_day[\s\S]*?\$function\$;/)?.[0] || '', /insert into public\.payments/i)
assert.doesNotMatch(migration, /insert into public\.automatic_service_pricing_versions[\s\S]*?values\s*\(\s*['"]mowing/i)

const endpoint = fs.readFileSync(path.join(process.cwd(),
  'src/app/api/portal/quote-day-hold/route.ts'), 'utf8')
assert.match(endpoint, /consumeTokenIntakeLimit/)
assert.match(endpoint, /reserve_automatic_quote_day/)

console.log('automatic service pricing verification passed')
