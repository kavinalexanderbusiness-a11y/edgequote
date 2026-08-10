// ── Verify: a lead's badge tells the truth, and the road to a quote loses nothing ─
//   npm run verify:lead-journey
//
// WHY THIS SCRIPT EXISTS
// The owner's lead workflow (arrives → understand → contact → convert → quote)
// failed in ways tsc can't see, all downstream of one root cause: the lead's
// open/closed state had exactly ONE closer, reachable only through the
// sessionStorage prefill door. Quote the same person any other way and the lead
// stayed 'new' forever — the inbox chip, the dashboard priority and the LeadCard
// all demanding a response the owner had already given. Sibling defects: the
// dashboard's #1 priority deep-linked with a query key the Messages page never
// read; every fresh BOOKING lead was misfiled as a generic "reply" pointing at
// the bare inbox; a failed lead fetch rendered as "no lead"; and the handoff to
// the Quote Builder dropped the customer's budget, schedule and contact
// preference — the three facts that shape the call.
//
// Pure-function tests run the REAL engines on fixtures; structural checks pin
// the single-closer contract and the honest-failure surfaces.

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { computeLeadsNeedingResponse, type LeadConvRow, type LeadQuoteRow } from '../src/lib/leadResponse'
import { leadToPrefill, type WebsiteLead } from '../src/lib/leads'

let failures = 0
const ok = (name: string) => console.log(`  ✓ ${name}`)
const fail = (name: string, detail: string) => { failures++; console.log(`  ✗ ${name}\n      ${detail}`) }
const check = (name: string, cond: boolean, detail = '') => (cond ? ok(name) : fail(name, detail))
const eq = (name: string, actual: unknown, expected: unknown) =>
  check(name, Object.is(actual, expected), `expected ${String(expected)}, got ${String(actual)}`)

const read = (p: string) => readFileSync(join(process.cwd(), p), 'utf8')

// ── Fixtures ─────────────────────────────────────────────────────────────────
const NOW = new Date('2026-08-09T18:00:00Z')

function conv(p: Partial<LeadConvRow> & { id: string }): LeadConvRow {
  return {
    customer_id: null, lead_status: null, last_direction: null,
    last_message_at: '2026-08-09T12:00:00Z', created_at: '2026-08-09T10:00:00Z',
    snoozed_until: null, customers: { name: 'Dana' }, ...p,
  }
}
function quote(p: Partial<LeadQuoteRow> & { id: string }): LeadQuoteRow {
  return { customer_id: null, customer_name: 'Sam', created_at: '2026-08-09T11:00:00Z', status: 'draft', lead_meta: { plan: 'weekly' }, ...p }
}

// ── 1. The three doors are counted as what they are ──────────────────────────
console.log('\nEvery lead door is counted as itself, once:')
{
  // Website lead: source 'website', and the deep link uses the key Messages READS.
  const r1 = computeLeadsNeedingResponse({
    conversations: [conv({ id: 'c1', customer_id: 'x1', lead_status: 'new' })], quotes: [],
  }, NOW)
  eq('a website lead counts as website', r1.items[0]?.source, 'website')
  eq('…and deep-links with ?f=, the key the Messages page consumes',
    r1.items[0]?.href, '/dashboard/messages?f=website_lead')

  // THE misfiling: a booking writes an inbound portal message, so its
  // conversation used to win the dedupe as a generic 'reply' → bare inbox.
  const r2 = computeLeadsNeedingResponse({
    conversations: [conv({ id: 'c2', customer_id: 'x2', last_direction: 'inbound' })],
    quotes: [quote({ id: 'q2', customer_id: 'x2' })],
  }, NOW)
  eq('a fresh booking is a booking, not a "reply"', r2.items[0]?.source, 'booking')
  eq('…linked to the draft quote that answers it', r2.items[0]?.href, '/dashboard/quotes/q2')
  eq('…and counted once', r2.total, 1)

  // An open WEBSITE lead still outranks the booking identity for the same person.
  const r3 = computeLeadsNeedingResponse({
    conversations: [conv({ id: 'c3', customer_id: 'x3', lead_status: 'new' })],
    quotes: [quote({ id: 'q3', customer_id: 'x3' })],
  }, NOW)
  eq('website outranks booking for the same customer', r3.items[0]?.source, 'website')
  eq('…still once', r3.total, 1)

  // A plain awaited reply with no booking stays a reply.
  const r4 = computeLeadsNeedingResponse({
    conversations: [conv({ id: 'c4', customer_id: 'x4', last_direction: 'inbound' })], quotes: [],
  }, NOW)
  eq('an awaited reply without a booking stays a reply', r4.items[0]?.source, 'reply')

  // Snoozed = deliberately parked; the inbox hides it, so the count must too.
  const r5 = computeLeadsNeedingResponse({
    conversations: [conv({ id: 'c5', customer_id: 'x5', lead_status: 'new', snoozed_until: '2026-08-10T00:00:00Z' })], quotes: [],
  }, NOW)
  eq('a snoozed lead is not nagged about', r5.total, 0)
  const r6 = computeLeadsNeedingResponse({
    conversations: [conv({ id: 'c6', customer_id: 'x6', lead_status: 'new', snoozed_until: '2026-08-09T00:00:00Z' })], quotes: [],
  }, NOW)
  eq('…but an EXPIRED snooze wakes it back up', r6.total, 1)
}

// ── 2. The handoff carries what the customer said ────────────────────────────
console.log('\nLead → Quote Builder loses nothing the owner needs for the call:')
{
  const lead = {
    id: 'L1', created_at: '2026-08-09T10:00:00Z', customer_id: 'x1', conversation_id: null, quote_id: null,
    status: 'new', raw_submission: null, submitted_at: null,
    contact_first: 'Dana', contact_last: 'Reyes', contact_name: null,
    phone: '403-555-0101', email: 'dana@example.com', preferred_contact: 'text me',
    address: '12 Alder Bay SW', city: 'Calgary', province: 'AB', postal_code: 'T2T 0A1',
    place_id: null, maps_url: null, lat: null, lng: null,
    lawn_sqft: 3200, lawn_polygon: null, sections: null,
    travel_distance_km: null, travel_fee: null,
    requested_services: 'Aeration', frequency: 'one time', yard_condition: null,
    website_estimated_price: 180, budget: 'under $200', preferred_schedule: 'weekday mornings', notes: 'gate on the left',
  } satisfies WebsiteLead

  const p = leadToPrefill(lead)
  eq('name assembles from first/last', p.customerName, 'Dana Reyes')
  eq('budget survives', p.budget, 'under $200')
  eq('preferred schedule survives', p.preferredSchedule, 'weekday mornings')
  eq('preferred contact method survives', p.preferredContact, 'text me')
  eq('city survives to the ensure step', p.city, 'Calgary')
  eq('province survives', p.province, 'AB')
  eq('postal code survives', p.postalCode, 'T2T 0A1')
  eq('the stated service passes through', p.serviceType, 'Aeration')
  // The regression the mapping already fixed once: nothing stated → EMPTY, so
  // the builder's catalog fallback can run (never a hardcoded trade).
  eq('no stated service stays empty', leadToPrefill({ ...lead, requested_services: null }).serviceType, '')
}

// ── 3. One closer, no zombie NEW ─────────────────────────────────────────────
console.log('\nA lead closes through THE close engine, whichever door quoted it:')
{
  const leads = read('src/lib/leads.ts')
  check('closeOpenLeads exists and sweeps by customer',
    /export async function closeOpenLeads/.test(leads) && /\.in\('customer_id', ids\)\.eq\('status', 'new'\)/.test(leads),
    'the close must be keyed on the CUSTOMER (any open lead), not only the prefill handoff')
  check('…clearing the conversation chip in the same call',
    /lead_status: null/.test(leads),
    'website_leads and conversations.lead_status must close together or they split-brain')
  check('…with every write checked',
    !/closeOpenLeads[\s\S]*?^\}/m.test(leads) || !/await sb\.from\([^)]*\)\s*\.update[^;]*;\s*(?!.*error)/.test(leads),
    'closeOpenLeads must collect errors — a silent failed close is the zombie badge again')

  const builder = read('src/app/dashboard/quotes/new/page.tsx')
  check('the builder closes through the engine on every door',
    /closeOpenLeads\(supabase, \{/.test(builder) && /customerIds: \[customerId, lead\?\.customerId\]/.test(builder),
    'the close must run for the RESOLVED customer regardless of the prefill — ~14 other entry points reach this save')
  check('…and no inline website_leads status write survives',
    !/from\('website_leads'\)\.update\(\{ status/.test(builder),
    'inline status writes are the single-door bug this guard exists to keep out')
  check('…and a failed close gets its own toast',
    /lead badge didn’t clear/.test(builder),
    'a quote toast must never imply the badge cleared when the write failed')
  check('the prefill is spent on SAVE, not on read',
    /window\.sessionStorage\.removeItem\(LEAD_PREFILL_KEY\)/.test(builder) && !/setLead\(JSON\.parse\(leadRaw\) as LeadPrefillPayload\) \} catch \{ \/\* ignore \*\/ \}\s*window\.sessionStorage\.removeItem/.test(builder),
    'a destructive read meant a refresh mid-build severed the lead linkage forever')
  check('lead geo persists outside the lawn-size gate',
    /if \(lead && propertyId\) \{\s*\n\s*const geo/.test(builder),
    'polygon/place/travel must persist even when the lawn size did not change — they are not lawn_sqft')
}

// ── 4. Honest failure and honest state ───────────────────────────────────────
console.log('\nA failed read never renders as an answer, and state never lies:')
{
  const card = read('src/components/messages/LeadCard.tsx')
  check('LeadCard distinguishes a failed fetch from no-lead',
    /setLoadError\(!!error\)/.test(card) && /Couldn’t load this lead/.test(card),
    'a network failure used to erase the lead AND the only quote door, silently')
  check('…with a retry that re-asks', /onClick=\{fetchLead\}/.test(card),
    'the error banner must offer the retry, not just apologise')
  check('LeadCard offers Dismiss', /status: 'dismissed'/.test(card),
    'Build-quote must not be the only exit — a junk lead nagged forever')
  check('a failed storage handoff says so and still opens on the customer',
    /quotes\/new\?customer=\$\{lead\.customer_id \?\? customerId\}/.test(card),
    'a silently EMPTY builder reads as a bug; the customer param keeps the close working')

  const summary = read('src/components/leads/LeadSummary.tsx')
  check('NEW is gated on status, not just freshness',
    /const isOpen = lead\.status === 'new'/.test(summary) && /isFresh = isOpen &&/.test(summary),
    'a quoted lead must never wear NEW on the profile')
  check('a quoted lead says QUOTED', /QUOTED ✓/.test(summary), 'handled must look handled')
  check('phone and email are tappable', /href=\{`tel:\$\{lead\.phone\}`\}/.test(summary) && /href=\{`mailto:\$\{lead\.email\}`\}/.test(summary),
    '"how do I contact them" should be one tap, not a copy-paste')
  check('an unreachable lead says so', /No phone or email/.test(summary),
    'an empty contact row reads as a render gap, not a fact')

  const profile = read('src/app/dashboard/customers/[id]/page.tsx')
  check('the profile lead read keeps last-known-good on error',
    /if \(!lRes\.error\) setLead/.test(profile),
    'a transient error must not render as "never submitted a lead"')
}

if (failures) {
  console.log(`\n❌ verify:lead-journey — ${failures} failure${failures === 1 ? '' : 's'}\n`)
  process.exit(1)
}
console.log('\n✅ verify:lead-journey — the badge tells the truth and the handoff loses nothing\n')
