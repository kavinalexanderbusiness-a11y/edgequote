import assert from 'node:assert/strict'
import { createHmac } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { publicWebsiteLeadResponse } from '../src/lib/publicBookingContract'
import {
  decideAutomaticServicePrice,
  type CanonicalRouteEvidence,
} from '../src/lib/automaticServicePricing'
import {
  attemptAutomaticServiceBundleEstimate,
  loadAutomaticServiceCapacityRequirement,
  publicAutomaticServiceBundleEstimate,
} from '../src/lib/automaticServicePricingServer'
import {
  canonicalQuadrantFromAddress,
  cityMeasurementRouteEvidence,
  collectAutomaticServiceRouteEvidence,
  type RouteEvidenceProvider,
} from '../src/lib/automaticServiceRouteEvidenceServer'
import {
  publicMeasurementPolygonHash,
  verifyPublicMeasurementAttestation,
} from '../src/lib/publicMeasurementAttestation'

const OWNER = '20000000-0000-4000-8000-000000000002'

const endpoint = fs.readFileSync(path.join(process.cwd(), 'src/app/api/website-lead/route.ts'), 'utf8')
const routeCollector = fs.readFileSync(path.join(process.cwd(), 'src/lib/automaticServiceRouteEvidenceServer.ts'), 'utf8')
const writer = fs.readFileSync(path.join(process.cwd(), 'supabase/migrations/20260923174500_issue_automatic_service_bundle_quote.sql'), 'utf8')

assert.match(endpoint, /collectAutomaticServiceRouteEvidence/)
assert.ok(endpoint.indexOf('cityMeasurementRouteEvidence(verified.measurement)')
  < endpoint.indexOf('loadAutomaticServiceCapacityRequirement({'),
  'signed City route evidence must exist before optional pricing/capacity collection')
assert.match(endpoint, /attemptAutomaticServiceBundleEstimate/)
assert.match(endpoint, /issueAutomaticServiceBundleQuote/)
assert.doesNotMatch(endpoint, /route_review_status[^\n]*(eligible|approved)/)
assert.doesNotMatch(endpoint, /estimated_quote[^\n]*(price|bundle)/i)
assert.match(routeCollector, /verifyPlace\(input\.placeId\)/)
assert.match(routeCollector, /haversineKm\(canonical, input\.measurementCentre\) > 0\.2/)
assert.match(routeCollector, /\.from\('jobs'\)/)
assert.match(routeCollector, /\.from\('day_statuses'\)/)
assert.match(routeCollector, /provider\.distances/)
assert.equal(canonicalQuadrantFromAddress('123 Main Street Northwest, Calgary, AB'), 'NW')
assert.equal(canonicalQuadrantFromAddress('123 Main St NW, Calgary, AB'), 'NW')

function stableJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`
  const object = value as Record<string, unknown>
  return `{${Object.keys(object).sort().map(key => `${JSON.stringify(key)}:${stableJson(object[key])}`).join(',')}}`
}

const measurementSecret = 'northwest-route-verification-secret-2026'
const measurementNow = Date.parse('2026-09-23T18:00:00.000Z')
const northwestPolygon = [{ section: 'lawn', ring: [
  { lat: 51.1000, lng: -114.2000 },
  { lat: 51.1001, lng: -114.2000 },
  { lat: 51.1001, lng: -114.2001 },
] }]
const signedMeasurementPayload = {
  v: 1,
  address: '123 example dr nw',
  matchedAddress: '123 Example Drive NW, Calgary, AB, Canada',
  sqft: 2400,
  polygonHash: publicMeasurementPolygonHash(northwestPolygon),
  centre: { lat: 51.10005, lng: -114.20005 },
  source: 'calgary_open_data_land_cover',
  confidence: 'high',
  measuredAt: '2026-09-23T17:55:00.000Z',
  expiresAt: '2026-09-23T18:25:00.000Z',
}
const encodedMeasurement = Buffer.from(stableJson(signedMeasurementPayload)).toString('base64url')
const signedMeasurement = `${encodedMeasurement}.${createHmac('sha256', measurementSecret).update(encodedMeasurement).digest('base64url')}`
const verifiedMeasurement = verifyPublicMeasurementAttestation({
  token: signedMeasurement,
  confirmation: 'automatic_applied',
  submittedAddress: '123 Example Dr NW, Calgary, AB',
  submittedSqft: '2400',
  submittedPolygon: northwestPolygon,
  nowMs: measurementNow,
  secret: measurementSecret,
})
if (!verifiedMeasurement.ok) throw new Error(`signed City measurement fixture failed: ${verifiedMeasurement.code}`)
const verifiedNorthwestMeasurement = verifiedMeasurement.measurement
const cityNorthwestRoute = cityMeasurementRouteEvidence(verifiedNorthwestMeasurement)
if (!cityNorthwestRoute) throw new Error('signed City measurement did not produce categorical route evidence')
assert.equal(cityNorthwestRoute.provider, 'city_of_calgary')
assert.equal(cityNorthwestRoute.quadrant, 'NW')
assert.equal(cityNorthwestRoute.baseDistanceKm, null)
assert.equal(cityNorthwestRoute.eligibleRouteDays, null)

assert.match(writer, /create or replace function public\.issue_automatic_service_bundle_quote/)
assert.match(writer, /insert into public\.quote_services/)
assert.match(writer, /automatic_bundle_pricing_versions/)
assert.match(writer, /minimum_margin_percent/)
assert.match(writer, /automatic_bundle_idempotency_key/)
assert.match(writer, /No booking or payment has been created/)
assert.doesNotMatch(writer, /insert into public\.(jobs|payments|invoices|payment_methods)/i)
assert.doesNotMatch(writer, /insert into public\.automatic_(service|bundle)_pricing_versions/i)

const priced = publicWebsiteLeadResponse({ ok: true, body: {} }, {
  state: 'priced', estimate_status: 'written_estimate', quote_number: 'EPS-2026-0042',
  lines: [
    { service: 'mowing', label: 'Lawn mowing', cadence: 'weekly', state: 'priced', price: 75, price_label: 'weekly per visit' },
    { service: 'fertilization', label: 'Fertilization', cadence: 'one_time', state: 'priced', price: 95, price_label: 'one-time service' },
  ],
  subtotal: 170, bundle_discount: 10, bundle_price: 160,
  bundle_price_label: 'combined service total', booking_status: 'not_booked',
  portal_path: '/portal-access', portal_delivery: 'email_if_provided',
  economics: { must_not_leak: true },
})
assert.equal((priced.quote as Record<string, unknown>).state, 'priced')
assert.equal((priced.quote as Record<string, unknown>).bundle_price, 160)
assert.equal((priced.quote as Record<string, unknown>).bundle_discount, 10)
assert.deepEqual(
  ((priced.quote as Record<string, unknown>).lines as Array<Record<string, unknown>>).map(line => line.price),
  [75, 95],
)
assert.equal(JSON.stringify(priced).includes('must_not_leak'), false)

const handoff = publicWebsiteLeadResponse({ ok: true, body: {} }, {
  state: 'written_quote_handoff',
  lines: [
    { service: 'mowing', label: 'Lawn mowing', cadence: 'weekly', state: 'priced', price: 75, price_label: 'weekly per visit' },
    { service: 'tree_pruning', label: 'Tree pruning', cadence: null, state: 'written_quote_handoff', price: null, price_label: null },
  ],
  bundle_price: null, booking_status: 'not_booked',
})
assert.equal((handoff.quote as Record<string, unknown>).state, 'written_quote_handoff')
assert.equal((handoff.quote as Record<string, unknown>).bundle_price, null)
assert.equal('bundle_discount' in (handoff.quote as Record<string, unknown>), false)
assert.equal(
  ((handoff.quote as Record<string, unknown>).lines as Array<Record<string, unknown>>)[0].price,
  75,
)
assert.equal(
  ((handoff.quote as Record<string, unknown>).lines as Array<Record<string, unknown>>)[1].price,
  null,
)

const northwestRoute: CanonicalRouteEvidence = {
  verifiedByServer: true,
  provider: 'google_places',
  placeId: 'ChIJ-northwest-calgary',
  checkedAt: new Date().toISOString(),
  city: 'Calgary',
  province: 'AB',
  country: 'CA',
  quadrant: 'NW',
  lat: 51.1,
  lng: -114.2,
  baseDistanceKm: 20,
  routeTravelKm: 20,
  nearbyJobs: 0,
  eligibleRouteDays: 3,
  routeRuleVersion: 'route-v1',
}
const northwestRecurringMowing = decideAutomaticServicePrice({
  tenantId: OWNER,
  serviceKey: 'mowing',
  cadence: 'weekly',
  rules: null,
  measurement: null,
  route: northwestRoute,
  nowMs: Date.now(),
})
assert.equal(northwestRecurringMowing.state, 'out_of_route')
assert.ok(northwestRecurringMowing.state === 'out_of_route')
assert.equal(northwestRecurringMowing.code, 'northwest_recurring_mowing_unavailable')

const northwestOneTimeMowing = decideAutomaticServicePrice({
  tenantId: OWNER,
  serviceKey: 'mowing',
  cadence: 'one_time',
  rules: null,
  measurement: null,
  route: northwestRoute,
  nowMs: Date.now(),
})
assert.equal(northwestOneTimeMowing.state, 'review_required', 'one-time mowing remains eligible for owner route review')

const northwestFertilization = decideAutomaticServicePrice({
  tenantId: OWNER,
  serviceKey: 'fertilization',
  cadence: 'one_time',
  rules: null,
  measurement: null,
  route: northwestRoute,
  nowMs: Date.now(),
})
assert.equal(northwestFertilization.state, 'review_required', 'the NW policy is service-specific, not a quadrant-wide ban')

const northwestMixedPublic = publicAutomaticServiceBundleEstimate({
  state: 'written_quote_handoff',
  lines: [
    {
      serviceKey: 'mowing', label: 'Lawn mowing', cadence: 'weekly', state: 'out_of_route',
      price: null, priceLabel: null, decision: northwestRecurringMowing,
    },
    {
      serviceKey: 'landscaping', label: 'Landscaping', cadence: null, state: 'written_quote_handoff',
      price: null, priceLabel: null, decision: null,
    },
  ],
  pricedSubtotal: 0,
  bundlePrice: null,
  reason: 'non_measurable_service',
})
const northwestMixed = publicWebsiteLeadResponse({ ok: true, body: {} }, northwestMixedPublic)
const northwestMixedQuote = northwestMixed.quote as Record<string, unknown>
const northwestMixedLines = northwestMixedQuote.lines as Array<Record<string, unknown>>
assert.equal(northwestMixedQuote.state, 'written_quote_handoff')
assert.match(String(northwestMixedQuote.message), /mowing is not available in Northwest Calgary/i)
assert.equal(northwestMixedLines[0].availability_code, 'northwest_recurring_mowing_unavailable')
assert.equal(northwestMixedLines[0].state, 'out_of_route')
assert.equal(northwestMixedLines[1].state, 'written_quote_handoff')

function missingPricingAdmin() {
  const responses: Record<string, unknown> = {
    business_settings: { data: { user_id: OWNER }, error: null },
    service_templates: { data: [{ id: 'published-mowing' }], error: null },
    automatic_service_pricing_versions: { data: null, error: null },
  }
  return {
    from(table: string) {
      const result = responses[table]
      const chain: Record<string, unknown> = {}
      for (const method of ['select', 'eq', 'not', 'in']) chain[method] = () => chain
      chain.limit = async () => result
      chain.maybeSingle = async () => result
      return chain
    },
  }
}

async function verifySignedNorthwestWithoutPricing() {
  const admin = missingPricingAdmin() as never
  const capacity = await loadAutomaticServiceCapacityRequirement({
    admin,
    bookingToken: 'token-with-no-pricing-version',
    serviceKey: 'mowing',
    measuredSqft: verifiedNorthwestMeasurement.sqft,
  })
  assert.equal(capacity.ok, false)
  assert.ok(!capacity.ok)
  assert.equal(capacity.code, 'pricing_version_missing',
    'the regression fixture must exercise the missing pricing/capacity path')
  const decision = await attemptAutomaticServiceBundleEstimate({
    admin,
    bookingToken: 'token-with-no-pricing-version',
    services: [
      { serviceKey: 'mowing', label: 'Lawn mowing', cadence: 'weekly' },
      { serviceKey: 'landscaping', label: 'Landscaping', cadence: null },
    ],
    measurementByService: {
      mowing: {
        verifiedByServer: true,
        sqft: verifiedNorthwestMeasurement.sqft,
        areaCount: 1,
        confidence: verifiedNorthwestMeasurement.confidence,
        source: verifiedNorthwestMeasurement.source,
        measuredAt: verifiedNorthwestMeasurement.measuredAt,
      },
    },
    routeByService: { mowing: cityNorthwestRoute },
    nowMs: measurementNow,
  })
  assert.equal(decision.state, 'written_quote_handoff')
  assert.equal(decision.lines[0].decision?.state, 'out_of_route',
    'signed Northwest City evidence enforces the route exclusion without pricing configuration')
  assert.ok(decision.lines[0].decision?.state === 'out_of_route')
  assert.equal(decision.lines[0].decision.code, 'northwest_recurring_mowing_unavailable')
  assert.equal(decision.lines[1].state, 'written_quote_handoff',
    'landscaping remains available for an owner-reviewed written quote')
  assert.equal(decision.bundlePrice, null, 'missing pricing configuration cannot produce an automatic bundle price')

  const response = publicWebsiteLeadResponse(
    { ok: true, body: {} },
    publicAutomaticServiceBundleEstimate(decision),
  )
  const quote = response.quote as Record<string, unknown>
  const lines = quote.lines as Array<Record<string, unknown>>
  assert.equal(quote.state, 'written_quote_handoff')
  assert.equal(quote.bundle_price, null)
  assert.equal(quote.booking_status, 'not_booked')
  assert.equal(lines[0].availability_code, 'northwest_recurring_mowing_unavailable')
  assert.equal(lines[0].state, 'out_of_route')
  assert.equal(lines[0].price, null)
  assert.equal(lines[1].state, 'written_quote_handoff')
  assert.equal(lines[1].price, null)
}

const tampered = publicWebsiteLeadResponse({ ok: true, body: {} }, {
  state: 'priced', estimate_status: 'written_estimate', quote_number: 'EPS-X',
  lines: [{ service: 'mowing', label: 'Mowing', cadence: 'weekly', state: 'priced', price: 1, price_label: 'weekly' }],
  subtotal: 1, bundle_discount: 0, bundle_price: 999,
  booking_status: 'not_booked', portal_path: '/portal-access', portal_delivery: 'manual_contact_required',
})
assert.equal('quote' in tampered, false)

function fakeAdmin() {
  const tomorrow = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString().slice(0, 10)
  const responses: Record<string, unknown> = {
    business_settings: { data: {
      user_id: '20000000-0000-4000-8000-000000000002', base_lat: 51.0, base_lng: -114.1,
      preferred_work_days: [0, 1, 2, 3, 4, 5, 6], daily_capacity_hours: 8,
    }, error: null },
    jobs: { data: [{
      property_id: 'property-1', service_type: 'Lawn Mowing', scheduled_date: tomorrow,
      duration_minutes: 60, properties: { lat: 51.051, lng: -114.081 },
    }], error: null, count: 1 },
    day_statuses: { data: [], error: null },
  }
  return {
    from(table: string) {
      const result = responses[table]
      const chain: Record<string, unknown> = {}
      for (const method of ['select', 'eq', 'gte', 'lte', 'in']) chain[method] = () => chain
      chain.limit = async () => result
      chain.maybeSingle = async () => result
      chain.then = (resolve: (value: unknown) => unknown) => Promise.resolve(result).then(resolve)
      return chain
    },
  }
}

const provider: RouteEvidenceProvider = {
  async verifyPlace(placeId) {
    return {
      placeId, formattedAddress: '123 Main St SE, Calgary, AB, Canada', city: 'Calgary',
      province: 'AB', country: 'CA', quadrant: 'SE', lat: 51.05, lng: -114.08,
    }
  },
  async distances(origin, destinations) {
    if (origin.lat === 51 && origin.lng === -114.1) return destinations.map((_, index) => index === 0 ? 8 : 7)
    return destinations.map((_, index) => index === 0 ? 8 : 1)
  },
}

async function verifyRouteCollector() {
  const collected = await collectAutomaticServiceRouteEvidence({
    admin: fakeAdmin() as never,
    bookingToken: 'token', serviceKey: 'mowing', placeId: 'ChIJ-test',
    measurementCentre: { lat: 51.05, lng: -114.08 }, routeRuleVersion: 'route-v1',
    requiredDurationMinutes: 60, provider,
  })
  assert.equal(collected.ok, true)
  assert.ok(collected.ok)
  assert.equal(collected.evidence.baseDistanceKm, 8)
  assert.equal(collected.evidence.routeTravelKm, 2)
  assert.equal(collected.evidence.nearbyJobs, 1)
  assert.ok(Number(collected.evidence.eligibleRouteDays) > 0)

  const mismatch = await collectAutomaticServiceRouteEvidence({
    admin: fakeAdmin() as never,
    bookingToken: 'token', serviceKey: 'mowing', placeId: 'ChIJ-test',
    measurementCentre: { lat: 50.7, lng: -114.4 }, routeRuleVersion: 'route-v1',
    requiredDurationMinutes: 60, provider,
  })
  assert.equal(mismatch.ok, false)
  assert.ok(!mismatch.ok && mismatch.code === 'address_measurement_mismatch')
}

Promise.all([verifyRouteCollector(), verifySignedNorthwestWithoutPricing()])
  .then(() => console.log('automatic service bundle integration verification passed'))
  .catch(error => { console.error(error); process.exit(1) })
