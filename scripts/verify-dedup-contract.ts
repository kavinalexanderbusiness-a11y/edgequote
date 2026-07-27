// ── Duplicate-detection characterization — run by CI (npm run verify:dedup-contract) ──
//
// lib/dedup.ts is THE engine that answers "does this already exist?" for properties,
// jobs and photos — and every one of its decision functions shipped with NO test. These
// are business-critical: findPropertyMatch gates property creation (a wrong answer forks
// one house into two records or merges two), and findJobMatch drives the schedule form's
// duplicate-visit warning AND the "Possible duplicate visit" DELETE suggestion — a wrong
// answer there proposes deleting real work.
//
// The owner contract is "a match NEVER silently merges": phone/email/address/recurrence
// matches are `confident` (safe to auto-link or hard-block), coordinate/timestamp
// matches are NOT confident (the UI must ASK). These tests pin both the reason AND the
// confidence for every branch, so that distinction can't quietly erode.
//
// Characterization only — CURRENT behavior, no production change. DOM-dependent helpers
// (visualHash needs canvas, fileSignature needs File) are input-derivation, not decision
// logic, and are out of scope for a Node harness; hammingHex + findPhotoMatch cover the
// photo DECISION.

import { findPropertyMatch, findJobMatch, findPhotoMatch, hammingHex } from '../src/lib/dedup'

let pass = 0
let fail = 0
function H(title: string) { console.log(`\n═══ ${title} ═══`) }
function check(name: string, actual: unknown, expected: unknown) {
  const a = JSON.stringify(actual); const e = JSON.stringify(expected)
  if (a === e) { pass++; console.log(`  ✅ ${name}`) }
  else { fail++; console.log(`  ❌ ${name}\n     expected: ${e}\n     actual:   ${a}`) }
}
function ok(name: string, cond: boolean) { check(name, cond, true) }

// ═══════════════════════════════════════════════════════════════════════════
H('1. findPropertyMatch — property-creation dedup (address + coordinates)')
const props = [
  { id: 'pA', address: '84 17 St NW', customer_id: 'c1', lat: 51.0, lng: -114.0 },
]
check('same customer + same address → customer-address, confident',
  findPropertyMatch(props, { customerId: 'c1', address: '84 17 St NW' }),
  { property: props[0], reason: 'customer-address', confident: true })
check('same address, no/other customer → address, confident',
  findPropertyMatch(props, { address: '84 17 St NW' })?.reason, 'address')
check('address token+prefix reuse still matches ("St NW" == "Street Northwest")',
  findPropertyMatch(props, { address: '84 17 Street Northwest, Calgary' })?.reason, 'address')
// Precedence: the customer-scoped match must beat a bare address match, even when the
// bare-address candidate is earlier in the list.
const twoProps = [
  { id: 'pOther', address: '84 17 St NW', customer_id: 'cX' },
  { id: 'pMine', address: '84 17 St NW', customer_id: 'c1' },
]
check('customer-address beats a bare address match (picks the customer’s own row)',
  findPropertyMatch(twoProps, { customerId: 'c1', address: '84 17 St NW' })?.property.id, 'pMine')
// Coordinates: ~22 m apart is the same lot; ~111 m is not.
const geo = [{ id: 'pGeo', address: null, lat: 51.0, lng: -114.0 }]
const near = findPropertyMatch(geo, { lat: 51.0002, lng: -114.0 })
check('coordinates within ~35 m → coordinates reason', near?.reason, 'coordinates')
ok('a coordinate match is NOT confident (same lot ≠ same record — the UI must ask)', near?.confident === false)
check('coordinates ~111 m away → no match', findPropertyMatch(geo, { lat: 51.001, lng: -114.0 }), null)
check('among several within range, the NEAREST lot wins',
  findPropertyMatch(
    [{ id: 'far', lat: 51.0003, lng: -114.0, address: null }, { id: 'near', lat: 51.0001, lng: -114.0, address: null }],
    { lat: 51.0, lng: -114.0 },
  )?.property.id, 'near')
check('an address too short to be real (< 5 normalized) never matches by address',
  findPropertyMatch(props, { address: '12' }), null)
check('a genuinely different address matches nothing', findPropertyMatch(props, { address: '999 Nowhere Rd SE' }), null)

// ═══════════════════════════════════════════════════════════════════════════
H('2. findJobMatch — scheduling dedup (this drives a DELETE suggestion)')
const jobs = [
  { id: 'j1', property_id: 'p1', scheduled_date: '2026-07-20', service_type: 'Lawn Mowing', recurrence_id: 'r1', status: 'scheduled' },
]
check('same recurrence, same day → recurrence-visit, confident',
  findJobMatch(jobs, { recurrenceId: 'r1', date: '2026-07-20' }),
  { job: jobs[0], reason: 'recurrence-visit', confident: true })
check('same property + same service (normalized) + same day → property-day-service',
  findJobMatch(jobs, { propertyId: 'p1', serviceType: '  Lawn Mowing  ', date: '2026-07-20' })?.reason,
  'property-day-service')
check('a DIFFERENT service on the same property/day is NOT a duplicate',
  findJobMatch(jobs, { propertyId: 'p1', serviceType: 'Snow Removal', date: '2026-07-20' }), null)
check('a different day is not a duplicate',
  findJobMatch(jobs, { propertyId: 'p1', serviceType: 'Lawn Mowing', date: '2026-07-21' }), null)
check('a cancelled job is never a duplicate (it freed the slot)',
  findJobMatch([{ ...jobs[0], status: 'cancelled' }], { propertyId: 'p1', serviceType: 'Lawn Mowing', date: '2026-07-20' }), null)
check('editing a job does not match ITSELF (excludeJobId)',
  findJobMatch(jobs, { excludeJobId: 'j1', propertyId: 'p1', serviceType: 'Lawn Mowing', date: '2026-07-20' }), null)
check('no date → no match (a duplicate is a same-DAY concept)',
  findJobMatch(jobs, { propertyId: 'p1', serviceType: 'Lawn Mowing' }), null)
check('recurrence-visit takes precedence when both would match',
  findJobMatch(jobs, { recurrenceId: 'r1', propertyId: 'p1', serviceType: 'Lawn Mowing', date: '2026-07-20' })?.reason,
  'recurrence-visit')

// ═══════════════════════════════════════════════════════════════════════════
H('3. hammingHex — the visual-hash distance primitive')
check('identical hashes → distance 0', hammingHex('abcd', 'abcd'), 0)
check('a single differing bit → 1', hammingHex('0000000000000000', '1000000000000000'), 1)
check('f vs 0 in one nibble → 4 bits', hammingHex('f', '0'), 4)
check('different lengths → 64 (max — never a false "near")', hammingHex('abc', 'abcd'), 64)

// ═══════════════════════════════════════════════════════════════════════════
H('4. findPhotoMatch — photo dedup decision')
const zeros = '0000000000000000'
check('identical content hash → exact-hash, confident',
  findPhotoMatch([{ id: 'e1', taken_at: null, content_hash: zeros }], { contentHash: zeros }),
  { photo: { id: 'e1', taken_at: null, content_hash: zeros }, reason: 'exact-hash', confident: true })
check('a hash within 5 bits → near-hash, confident (re-encode/crop of the same shot)',
  findPhotoMatch([{ id: 'e1', taken_at: null, content_hash: zeros }], { contentHash: '1f00000000000000' })?.reason,
  'near-hash')
check('a hash 6 bits off is NOT near (and no timestamp given) → no match',
  findPhotoMatch([{ id: 'e1', taken_at: null, content_hash: zeros }], { contentHash: '3f00000000000000' }), null)
check('EXIF timestamp within 90 s → timestamp reason, NOT confident',
  findPhotoMatch([{ id: 'e1', taken_at: '2026-07-20T10:00:00Z', content_hash: null }],
    { takenAtMs: Date.parse('2026-07-20T10:00:30Z'), exactTime: true }),
  { photo: { id: 'e1', taken_at: '2026-07-20T10:00:00Z', content_hash: null }, reason: 'timestamp', confident: false })
check('a NON-EXIF timestamp never accuses (file mtimes collide) — exactTime false → null',
  findPhotoMatch([{ id: 'e1', taken_at: '2026-07-20T10:00:00Z', content_hash: null }],
    { takenAtMs: Date.parse('2026-07-20T10:00:30Z'), exactTime: false }), null)
check('a timestamp outside the 90 s window → no match',
  findPhotoMatch([{ id: 'e1', taken_at: '2026-07-20T10:00:00Z', content_hash: null }],
    { takenAtMs: Date.parse('2026-07-20T10:02:00Z'), exactTime: true }), null)
check('exact hash beats a coincident timestamp',
  findPhotoMatch([{ id: 'e1', taken_at: '2026-07-20T10:00:00Z', content_hash: zeros }],
    { contentHash: zeros, takenAtMs: Date.parse('2026-07-20T10:00:10Z'), exactTime: true })?.reason,
  'exact-hash')
check('nothing to match → null', findPhotoMatch([], { contentHash: zeros }), null)

// ═══════════════════════════════════════════════════════════════════════════
console.log(`\n${'═'.repeat(60)}\n  PASS ${pass}   FAIL ${fail}`)
if (fail > 0) process.exit(1)
