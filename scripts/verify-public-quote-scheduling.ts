import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import {
  affirmativeEmailMarketingConsent,
  EMAIL_MARKETING_CONSENT_VERSION,
  isolateClientEstimateClaim,
  parsePortalScheduleQuery,
  publicWebsiteLeadResponse,
} from '../src/lib/publicBookingContract'
import { validateWebsiteLeadPayload } from '../src/lib/publicIntakeSecurity'

let pass = 0
let fail = 0
function ok(name: string, condition: boolean) {
  if (condition) { pass++; console.log(`  ✅ ${name}`) }
  else { fail++; console.log(`  ❌ ${name}`) }
}
function eq(name: string, actual: unknown, expected: unknown) {
  ok(name, JSON.stringify(actual) === JSON.stringify(expected))
}

console.log('\n═══ Browser claims never become canonical price or measurement ═══')
const separated = isolateClientEstimateClaim({
  first_name: 'Pat', lawn_area_sqft: '2450', estimated_quote: '65',
  lawn_polygon: [{ section: 'front', ring: [] }], mowing_frequency: 'weekly',
})
eq('removes canonical lawn area', separated.payload.lawn_area_sqft, undefined)
eq('removes canonical price', separated.payload.estimated_quote, undefined)
eq('labels claim untrusted', separated.claim?.trusted_for_pricing, false)
eq('preserves claim for review', separated.claim?.lawn_area_sqft, '2450')
eq('leaves identity fields intact', separated.payload.first_name, 'Pat')

console.log('\n═══ Marketing consent is affirmative, evidenced and non-destructive ═══')
const now = Date.parse('2026-09-22T18:00:00.000Z')
const yes = affirmativeEmailMarketingConsent({
  marketing_consent: 'yes', email: 'pat@example.com', consent_version: EMAIL_MARKETING_CONSENT_VERSION,
  consent_utc: '2026-09-22T17:59:00.000Z',
}, 'edgepropertyservicesyyc.ca free quote form', now)
eq('valid yes creates evidence', yes?.version, EMAIL_MARKETING_CONSENT_VERSION)
eq('unchecked/no is not a withdrawal', affirmativeEmailMarketingConsent({
  marketing_consent: 'no', email: 'pat@example.com', consent_version: 'quote-v1',
  consent_utc: '2026-09-22T17:59:00.000Z',
}, 'site', now), null)
eq('yes without email is rejected', affirmativeEmailMarketingConsent({
  marketing_consent: 'yes', consent_version: 'quote-v1', consent_utc: '2026-09-22T17:59:00.000Z',
}, 'site', now), null)
eq('stale consent is rejected', affirmativeEmailMarketingConsent({
  marketing_consent: 'yes', email: 'p@x.ca', consent_version: EMAIL_MARKETING_CONSENT_VERSION,
  consent_utc: '2026-09-20T17:59:00.000Z',
}, 'site', now), null)
eq('invented disclosure version is rejected', affirmativeEmailMarketingConsent({
  marketing_consent: 'yes', email: 'p@x.ca', consent_version: 'attacker-supplied-version',
  consent_utc: '2026-09-22T17:59:00.000Z',
}, 'site', now), null)
ok('public validator requires evidence for yes', !validateWebsiteLeadPayload({
  first_name: 'Pat', address: '1 Main', email: 'p@x.ca', marketing_consent: 'yes',
}).ok)
ok('public validator accepts no without treating it as a withdrawal event', validateWebsiteLeadPayload({
  first_name: 'Pat', address: '1 Main', email: 'p@x.ca', marketing_consent: 'no',
}).ok)

console.log('\n═══ Public intake response reveals no internal identifiers ═══')
const publicSuccess = publicWebsiteLeadResponse({
  ok: true,
  body: {
    ok: true, lead_id: '11111111-1111-4111-8111-111111111111',
    customer_id: '22222222-2222-4222-8222-222222222222', source: 'Website',
    photos: { received: 2, stored: 1, failed: 1 },
  },
}, {
  state: 'quoted', quote_number: 'Q-100', price: 65, cadence: 'weekly',
  price_label: 'weekly per visit', portal_path: '/portal-access', portal_delivery: 'email_if_provided',
})
eq('public response keeps only the minimum success fields', publicSuccess, {
  ok: true,
  photos: { received: 2, stored: 1, failed: 1 },
  warning: '1 photo(s) could not be stored',
  quote: {
    state: 'quoted', quote_number: 'Q-100', price: 65, cadence: 'weekly',
    price_label: 'weekly per visit', portal_path: '/portal-access', portal_delivery: 'email_if_provided',
  },
})
ok('internal customer and lead ids are absent', !('customer_id' in publicSuccess) && !('lead_id' in publicSuccess))
eq('review response never exposes owner-only reasons', publicWebsiteLeadResponse({ ok: true, body: { ok: true } }, {
  state: 'review_required', missing: [{ code: 'route_too_far', decision: 'owner-only detail' }],
}), { ok: true, quote: { state: 'review_required' } })

console.log('\n═══ Portal scheduling input boundary ═══')
const quoteId = '11111111-1111-4111-8111-111111111111'
ok('accepts customer token + quote + date', parsePortalScheduleQuery({
  token: 'portal-token', quoteId, date: '2026-09-28', days: '30',
}).ok)
ok('rejects non-UUID quote ids', !parsePortalScheduleQuery({ token: 'x', quoteId: 'another-tenant' }).ok)
ok('rejects malformed dates', !parsePortalScheduleQuery({ token: 'x', quoteId, date: '2026-99-99' }).ok)
const clamped = parsePortalScheduleQuery({ token: 'x', quoteId, days: 999 })
eq('clamps public lookahead', clamped.ok ? clamped.days : null, 60)

console.log('\n═══ Database contract is fail-closed and tenant-scoped ═══')
const migration = readFileSync(resolve(process.cwd(), 'supabase/migrations/20260922200202_secure_public_quote_scheduling.sql'), 'utf8')
const intakeMigration = readFileSync(resolve(process.cwd(), 'supabase/migrations/20260914021500_public_intake_hardening.sql'), 'utf8')
const notificationMigration = readFileSync(resolve(process.cwd(), 'supabase/migrations/20260921235500_portal_request_mute_exception.sql'), 'utf8')
const portalRoute = readFileSync(resolve(process.cwd(), 'src/app/api/portal/quote-schedule/route.ts'), 'utf8')
const websiteLeadRoute = readFileSync(resolve(process.cwd(), 'src/app/api/website-lead/route.ts'), 'utf8')
const websiteSettings = readFileSync(resolve(process.cwd(), 'src/components/settings/WebsiteIntegration.tsx'), 'utf8')
const portalClient = readFileSync(resolve(process.cwd(), 'src/app/portal/[token]/PortalClient.tsx'), 'utf8')
const scheduleCard = readFileSync(resolve(process.cwd(), 'src/app/portal/[token]/components/QuoteSchedulingCard.tsx'), 'utf8')
const availability = migration.slice(migration.indexOf('create or replace function public.public_quote_schedule_availability'))
const submitBooking = migration.slice(
  migration.indexOf('create or replace function public.submit_booking'),
  migration.indexOf('create or replace function public.ensure_public_lead_quote'),
)
ok('legacy direct booking is revoked from browser roles', /revoke all on function public\.book_service\(text, jsonb\) from public, anon, authenticated/.test(migration))
ok('legacy bare availability is revoked from browser roles', /revoke all on function public\.public_availability\(text, integer\) from public, anon, authenticated/.test(migration))
ok('new availability is service-role only', /grant execute on function public\.public_quote_schedule_availability\(text, uuid, integer\)\s+to service_role/.test(migration))
ok('security-definer intake and notification helpers put pg_temp last',
  /security definer\s+set search_path = 'public', 'pg_temp'/.test(intakeMigration)
    && /security definer\s+set search_path = 'public', 'pg_temp'/.test(notificationMigration))
ok('quote lookup binds customer and tenant', /q\.customer_id = v_customer and q\.user_id = v_user/.test(availability))
ok('current written acceptance is mandatory', /quote_acceptance_is_current\(v_q\.id\)/.test(availability))
ok('deposit uses canonical paid ledger rows', /p\.kind = 'payment' and p\.status = 'paid' and p\.provider is distinct from 'credit'/.test(availability))
ok('blocked days are excluded', /coalesce\(ds\.blocks, false\) = false/.test(availability))
ok('scheduled jobs and schedule items consume capacity', /public\.jobs bad/.test(availability) && /public\.schedule_items bads/.test(availability))
ok('unknown visit durations fail closed', /bad\.duration_minutes is null/.test(availability))
ok('route eligibility requires explicit per-quote approval', availability.includes("v_q.lead_meta->>'route_eligibility', '') <> 'approved'"))
ok('owner must configure the travel buffer', /travel_buffer_minutes_per_visit/.test(availability))
ok('scheduling is serialized by tenant/date', /pg_advisory_xact_lock\(hashtextextended\(v_user::text \|\| '\|' \|\| p_date::text/.test(migration))
ok('direct browser measurements remain only in labelled claims', /'measurement_sqft', p_sqft/.test(submitBooking) && /'trusted_for_pricing', false/.test(submitBooking))
ok('direct browser quote writes canonical measurements and prices as null', /null, null, null, null, 'draft', null, v_property/.test(submitBooking))
ok('marketing no cannot clear an earlier opt-in', /if p_consent is not true then return false/.test(migration) && !/set email_opt_in = false/.test(migration))
ok('marketing evidence is append-only and idempotent', /consent_changes_evidence_key_unique/.test(migration) && /on conflict \(user_id, evidence_key\)[\s\S]*do nothing/.test(migration))
ok('owner config RPC is authenticated-only and atomically merges module_meta', /configure_public_quote_scheduling/.test(migration) && /jsonb_set\(coalesce\(module_meta/.test(migration) && /to authenticated/.test(migration))
ok('per-quote owner approval validates facts', /set_public_quote_scheduling_approval/.test(migration) && /Set a positive on-site duration/.test(migration) && /Set a positive crew size/.test(migration))
ok('later quote and service edits clear stale approval', /quotes_clear_public_schedule_approval/.test(migration) && /quote_services_clear_public_schedule_approval/.test(migration))
ok('changing the top-level service also clears stale scheduling approval',
  /new\.service_type is distinct from old\.service_type/.test(migration)
    && /before update of property_id, address, service_type, hours, crew_size/.test(migration))
ok('review drafts link the durable website lead to the created quote',
  /update public\.website_leads[\s\S]{0,180}set quote_id = v_quote[\s\S]{0,180}id = p_lead_id/.test(migration))
ok('scheduled job carries the canonical accepted written price', /v_price := case when coalesce\(v_q\.accepted_price/.test(migration) && /v_q\.crew_size, v_price, 'scheduled'/.test(migration))
ok('idempotent availability and booking return the persisted visit date',
  (availability.match(/'date', v_existing_date/g) || []).length >= 2
    && /select j\.id, j\.scheduled_date into v_job, v_existing_date/.test(migration))
ok('portal capability stays in POST body rather than query strings', !/export async function GET/.test(portalRoute) && /body: JSON\.stringify\(\{ action: 'availability'/.test(readFileSync(resolve(process.cwd(), 'src/app/portal/[token]/components/QuoteSchedulingCard.tsx'), 'utf8')))
ok('portal booking requires an explicit schedule action',
  /body\.action !== 'availability' && body\.action !== 'schedule'/.test(portalRoute)
    && /JSON\.stringify\(\{ action: 'schedule', token, quoteId, date: selected \}\)/.test(scheduleCard))
ok('scheduled confirmation survives the portal data refresh',
  /q\.status === 'scheduled'[\s\S]{0,180}?j\.quote_id === q\.id/.test(portalClient)
    && /state === 'already_scheduled' \|\| state === 'scheduled'/.test(scheduleCard))
ok('public intake never returns a portal capability', !/portal_url|portalUrl|customer_portal_tokens/.test(websiteLeadRoute))
ok('settings copy describes review then acceptance/payment/scheduling', websiteSettings.includes('website submissions create a review-required draft') && !websiteSettings.includes('visitors get an instant quote'))

console.log(`\n${pass} passed, ${fail} failed`)
if (fail) process.exit(1)
