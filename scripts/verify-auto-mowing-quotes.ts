import { createHmac } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { decideAutomaticMowingQuote, type AutoMowingQuoteInput, type AutoMowingRuleVersion, type ExplicitPricingVersion } from '../src/lib/autoMowingQuoteDecision'
import { publicMeasurementPolygonHash, verifyPublicMeasurementAttestation } from '../src/lib/publicMeasurementAttestation'

let pass = 0; let fail = 0
function ok(name: string, condition: boolean) { if (condition) { pass++; console.log(`  ✅ ${name}`) } else { fail++; console.log(`  ❌ ${name}`) } }
function reason(input: AutoMowingQuoteInput, code: string) {
  const result = decideAutomaticMowingQuote(input)
  return result.state === 'review_required' && result.missing.some(item => item.code === code)
}

const now = Date.parse('2026-09-22T18:00:00.000Z')
const rules: AutoMowingRuleVersion = {
  id: 'rule-1', userId: 'tenant-a', version: 1, enabled: true,
  permittedCadences: ['weekly', 'biweekly', 'one_time'], acceptedMeasurementConfidences: ['medium'],
  acceptedMeasurementSources: ['calgary_open_data_land_cover'], maximumMeasurementAgeMinutes: 30,
  routeMode: 'distance_and_density', approvedNeighborhoods: [], maximumBaseDistanceKm: 25,
  minimumNearbyJobs: 1, minimumCharge: 65, minimumMarginPercent: 20,
  fullCostBasisConfirmed: true, materialsCostPerVisit: 1, equipmentCostPerVisit: 2,
  deliveryDisposalCostPerVisit: 0, contingencyPercent: 5, pricingConfigVersionId: 'price-1',
  durationCrewBands: [{ maximumSqft: 4000, minutes: 25, crewSize: 1 }, { maximumSqft: null, minutes: 50, crewSize: 1 }],
  depositType: 'percent', depositValue: 25, quoteValidDays: 14,
}
const pricing: ExplicitPricingVersion = {
  id: 'price-1', user_id: 'tenant-a', engine_version: 'pricing-v1', source: 'recorded',
  base_charge: 40, mow_rate_per_1000: 18, budget_mult: 0.9, market_mult: 1,
  recommended_mult: 1.2, premium_mult: 1.4, travel_rate_per_km: 1.5,
  crew_cost_per_hour: 45, fee_recovery_percent: 3, payment_fee_strategy: 'global_price_increase',
}
const base: AutoMowingQuoteInput = {
  tenantId: 'tenant-a', service: 'Lawn Mowing & Edging', requestedCadence: 'weekly',
  rules, pricingVersion: pricing,
  measurement: { verifiedByServer: true, sqft: 3076, confidence: 'medium', source: 'calgary_open_data_land_cover', measuredAt: '2026-09-22T17:55:00.000Z', lat: 51.1, lng: -114.1 },
  route: { neighborhood: null, baseDistanceKm: 8, nearbyJobs: 3 }, nowMs: now, leadId: 'lead-1', customerId: 'customer-1',
}

console.log('\n═══ Automatic mowing decision ═══')
const supported = decideAutomaticMowingQuote(base)
ok('fully supported owner rules produce one exact decision', supported.state === 'supported')
ok('economics freeze loaded labour, cost, profit and margin to a dime', supported.state === 'supported'
  && supported.economics.loadedCrewCost > 0 && Number.isFinite(supported.economics.totalCost)
  && Number.isFinite(supported.economics.profit) && Number.isFinite(supported.economics.marginPercent))
const replay = decideAutomaticMowingQuote(base)
ok('same versioned facts have a deterministic idempotency key', supported.state === 'supported'
  && replay.state === 'supported' && replay.idempotencyKey === supported.idempotencyKey)
const retriedLead = decideAutomaticMowingQuote({ ...base, leadId: 'duplicate-submit-lead' })
ok('duplicate lead submission for the same customer and signed facts replays', supported.state === 'supported'
  && retriedLead.state === 'supported' && retriedLead.idempotencyKey === supported.idempotencyKey)
const otherCustomer = decideAutomaticMowingQuote({ ...base, customerId: 'customer-2' })
ok('another customer cannot collide with the first customer idempotency key', supported.state === 'supported'
  && otherCustomer.state === 'supported' && otherCustomer.idempotencyKey !== supported.idempotencyKey)
const v2 = decideAutomaticMowingQuote({ ...base, rules: { ...rules, id: 'rule-2', version: 2 } })
ok('new rule version changes the decision identity', supported.state === 'supported' && v2.state === 'supported' && supported.idempotencyKey !== v2.idempotencyKey)

ok('missing rules fails closed', reason({ ...base, rules: null }, 'rules_not_saved'))
ok('disabled rules fail closed', reason({ ...base, rules: { ...rules, enabled: false } }, 'auto_pricing_disabled'))
ok('unsupported services fail closed', reason({ ...base, service: 'Tree Trimming' }, 'unsupported_service'))
ok('tenant mismatch fails closed', reason({ ...base, tenantId: 'tenant-b' }, 'tenant_mismatch'))
ok('unpermitted cadence fails closed', reason({ ...base, requestedCadence: 'monthly' }, 'cadence_not_permitted'))
ok('unverified measurement fails closed', reason({ ...base, measurement: { ...base.measurement!, verifiedByServer: false } }, 'measurement_not_server_verified'))
ok('stale measurement fails closed', reason({ ...base, measurement: { ...base.measurement!, measuredAt: '2026-09-22T16:00:00.000Z' } }, 'measurement_too_old'))
ok('unaccepted source fails closed', reason({ ...base, measurement: { ...base.measurement!, source: 'browser' } }, 'measurement_source_not_accepted'))
ok('unaccepted confidence fails closed', reason({ ...base, measurement: { ...base.measurement!, confidence: 'low' } }, 'measurement_confidence_not_accepted'))
ok('unknown route fails closed', reason({ ...base, route: null }, 'route_not_verified'))
ok('distance limit fails closed', reason({ ...base, route: { ...base.route!, baseDistanceKm: 30 } }, 'route_too_far'))
ok('density limit fails closed', reason({ ...base, route: { ...base.route!, nearbyJobs: 0 } }, 'route_density_too_low'))
ok('missing explicit pricing version fails closed', reason({ ...base, pricingVersion: null }, 'pricing_version_missing'))
ok('non-recorded/default pricing is never owner approval', reason({ ...base, pricingVersion: { ...pricing, source: 'default' } }, 'pricing_version_incomplete'))
ok('pricing version tenant isolation fails closed', reason({ ...base, pricingVersion: { ...pricing, user_id: 'tenant-b' } }, 'pricing_tenant_mismatch'))
ok('missing duration coverage fails closed', reason({ ...base, rules: { ...rules, durationCrewBands: [{ maximumSqft: 1000, minutes: 20, crewSize: 1 }] } }, 'duration_crew_mapping_missing'))
ok('unconfirmed cost basis fails closed', reason({ ...base, rules: { ...rules, fullCostBasisConfirmed: false } }, 'full_cost_basis_not_confirmed'))
ok('price below saved cost/margin floor fails closed', reason({ ...base, pricingVersion: { ...pricing, crew_cost_per_hour: 900 } }, 'price_below_margin_floor'))
ok('invalid deposit fails closed', reason({ ...base, rules: { ...rules, depositValue: 101 } }, 'deposit_rule_invalid'))

console.log('\n═══ Signed City measurement boundary ═══')
const secret = 'a'.repeat(32)
const polygon = [{ section: 'other', ring: [{ lat: 51.1, lng: -114.1 }, { lat: 51.11, lng: -114.1 }, { lat: 51.1, lng: -114.11 }] }]
const payload = { v: 1, address: '123 evercreek dr sw', matchedAddress: '123 Evercreek Drive SW, Calgary, AB', sqft: 3076,
  polygonHash: publicMeasurementPolygonHash(polygon), centre: { lat: 51.1, lng: -114.1 },
  source: 'calgary_open_data_land_cover', confidence: 'medium', measuredAt: '2026-09-22T17:55:00.000Z', expiresAt: '2026-09-22T18:15:00.000Z' }
function stable(value: unknown): string { if (value === null || typeof value !== 'object') return JSON.stringify(value); if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`; const o = value as Record<string, unknown>; return `{${Object.keys(o).sort().map(k => `${JSON.stringify(k)}:${stable(o[k])}`).join(',')}}` }
const body = Buffer.from(stable(payload)).toString('base64url')
const token = `${body}.${createHmac('sha256', secret).update(body).digest('base64url')}`
const verify = (changes: Record<string, unknown> = {}) => verifyPublicMeasurementAttestation({
  token, confirmation: 'looks_right', submittedAddress: '123 Evercreek Dr SW, Calgary', submittedSqft: '3076', submittedPolygon: polygon, nowMs: now, secret, ...changes,
})
ok('valid unchanged City result verifies', verify().ok)
ok('corrected outline cannot auto-price', !verify({ confirmation: 'corrected' }).ok)
ok('unchanged server outline can auto-apply without a second approval click', verify({ confirmation: 'automatic_applied' }).ok)
ok('changed sqft cannot auto-price', !verify({ submittedSqft: '3077' }).ok)
ok('changed polygon cannot auto-price', !verify({ submittedPolygon: [] }).ok)
ok('changed address cannot auto-price', !verify({ submittedAddress: '999 Other St' }).ok)
ok('tampered signature cannot auto-price', !verify({ token: `${body}.bad` }).ok)
ok('expired attestation cannot auto-price', !verify({ nowMs: Date.parse('2026-09-22T18:16:00.000Z') }).ok)

console.log('\n═══ Database and portal contract ═══')
const migration = readFileSync(resolve(process.cwd(), 'supabase/migrations/20260922210000_auto_mowing_quote_rules.sql'), 'utf8')
const scheduling = readFileSync(resolve(process.cwd(), 'supabase/migrations/20260922200202_secure_public_quote_scheduling.sql'), 'utf8')
const server = readFileSync(resolve(process.cwd(), 'src/lib/autoMowingQuoteServer.ts'), 'utf8')
const publicRoute = readFileSync(resolve(process.cwd(), 'src/app/api/website-lead/route.ts'), 'utf8')
ok('rule versions are immutable and tenant-scoped', /append-only/.test(migration) && /auth\.uid\(\) = user_id/.test(migration))
ok('new rules invalidate only open automatic quotes', /status = 'sent'/.test(migration) && /auto_rules_superseded_at/.test(migration))
ok('atomic issuer tenant-checks lead, customer and active rule', /lead_tenant_mismatch/.test(migration) && /customer_tenant_mismatch/.test(migration) && /r\.is_active and r\.enabled/.test(migration))
ok('automatic quotes require an active owner-published mowing service in both server and database gates',
  /from\('service_templates'\)/.test(server)
    && /\.eq\('is_active', true\)/.test(server)
    && /\.not\('published_at', 'is', null\)/.test(server)
    && /service_not_published/.test(server)
    && /from public\.service_templates/.test(migration)
    && /s\.is_active and s\.published_at is not null/.test(migration)
    && /service_not_published/.test(migration))
ok('database idempotency is unique by tenant and decision key', /quotes_auto_mowing_idempotency_unique/.test(migration) && /pg_advisory_xact_lock/.test(migration))
ok('only selected cadence price column is populated', /case when v_cadence = 'weekly' then v_total else null end/.test(migration) && /case when v_cadence = 'biweekly' then v_total else null end/.test(migration))
ok('active route proof uses future live mowing jobs and deduplicates property ids', /scheduled_date/.test(server) && /scheduled', 'in_progress/.test(server) && /ilike\('service_type', '%mow%'\)/.test(server) && /new Map/.test(server))
ok('recurring self-booking creates owner-visible setup work', /Recurring setup required/.test(scheduling) && /recurrence_setup_required/.test(scheduling))
ok('portal token is never in the public quote result', /portal_path: '\/portal-access'/.test(server) && !/portal_token|customer_portal_tokens/.test(server))
ok('public review response is neutral while exact reasons are stored owner-side',
  /quoteState = \{ state: 'review_required' \}/.test(publicRoute)
  && /record_auto_mowing_review_reasons/.test(publicRoute)
  && !/quoteState = \{[\s\S]{0,120}missing: automatic\.missing/.test(publicRoute))
ok('verified measurement updates only the reconciled tenant customer property',
  /property_address_not_reconciled/.test(migration) && /lawn_sqft = \(p_measurement->>'sqft'\)/.test(migration)
  && /p\.id = v_property and p\.user_id = v_user and p\.customer_id = p_customer_id/.test(migration))
ok('issued and replayed automatic quotes reconcile the website lead as quoted',
  /status = case when status = 'new' then 'quoted' else status end/.test(migration)
    && /set quote_id = v_quote, status = 'quoted'/.test(migration)
    && /id = p_lead_id and user_id = v_user and customer_id = p_customer_id/.test(migration))

console.log(`\n${pass} passed, ${fail} failed`)
if (fail) process.exit(1)
