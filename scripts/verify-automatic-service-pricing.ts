import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import {
  decideAutomaticServicePrice,
  OWNER_APPROVED_MOWING_BASES_2026_09_23,
  type AutomaticServicePricingInput,
  type AutomaticServicePricingVersion,
} from '../src/lib/automaticServicePricing'
import { publicAutomaticServiceEstimate } from '../src/lib/automaticServicePricingServer'

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
      city: 'Calgary', province: 'AB', country: 'CA', quadrant: 'NW',
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

// Calgary NW is never rejected by quadrant. It prices when route economics pass.
assert.equal(weekly.state, 'priced')
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

const migration = fs.readFileSync(path.join(process.cwd(),
  'supabase/migrations/20260923083454_automatic_service_pricing_and_day_holds.sql'), 'utf8')
assert.match(migration, /automatic service pricing versions are immutable/)
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
