import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { publicWebsiteLeadResponse } from '../src/lib/publicBookingContract'
import {
  decideAutomaticServicePrice,
  type CanonicalRouteEvidence,
} from '../src/lib/automaticServicePricing'
import { publicAutomaticServiceBundleEstimate } from '../src/lib/automaticServicePricingServer'
import {
  canonicalQuadrantFromAddress,
  collectAutomaticServiceRouteEvidence,
  type RouteEvidenceProvider,
} from '../src/lib/automaticServiceRouteEvidenceServer'

const OWNER = '20000000-0000-4000-8000-000000000002'

const endpoint = fs.readFileSync(path.join(process.cwd(), 'src/app/api/website-lead/route.ts'), 'utf8')
const routeCollector = fs.readFileSync(path.join(process.cwd(), 'src/lib/automaticServiceRouteEvidenceServer.ts'), 'utf8')
const writer = fs.readFileSync(path.join(process.cwd(), 'supabase/migrations/20260923174500_issue_automatic_service_bundle_quote.sql'), 'utf8')

assert.match(endpoint, /collectAutomaticServiceRouteEvidence/)
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

verifyRouteCollector()
  .then(() => console.log('automatic service bundle integration verification passed'))
  .catch(error => { console.error(error); process.exit(1) })
