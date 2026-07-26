// ── Dedup engine verification — npm run verify:dedup ────────────────────────
//
// lib/dedup.ts is THE unified duplicate-detection engine: one place that answers
// "does this already exist?" for properties, jobs and photos, so every entry
// point (forms, quote save, photo upload, intake) agrees. Its failure modes are
// both silent data corruption: a FALSE POSITIVE swallows a real photo or blocks
// a real second visit; a FALSE NEGATIVE lets duplicates compound (the exact
// disease BK-1 documents on the booking door). Nothing exercised it.
//
// These are CHARACTERIZATION tests: expected values were captured from the
// module itself — including the geometry (the ~35 m same-lot radius against real
// haversine distances) and the bit math (hamming over hex nibbles). Pure +
// deterministic, no I/O, no canvas: visualHash is deliberately NOT driven here
// (it needs a browser; callers already degrade on null). The customer matcher is
// re-exported from lib/customers UNCHANGED and is pinned by verify-customer-v2 —
// re-testing it here would double-cover one implementation.

import {
  findPropertyMatch, findJobMatch, findPhotoMatch,
  fileSignature, hammingHex, PHOTO_MATCH_LABEL,
  type PropertyLite, type JobLiteForMatch, type ExistingPhotoLite,
} from '../src/lib/dedup'

let pass = 0
let fail = 0
function H(t: string) { console.log(`\n═══ ${t} ═══`) }
function check(name: string, actual: unknown, expected: unknown) {
  const a = JSON.stringify(actual); const e = JSON.stringify(expected)
  if (a === e) { pass++; console.log(`  ✅ ${name}`) }
  else { fail++; console.log(`  ❌ ${name}\n     expected: ${e}\n     actual:   ${a}`) }
}

// ═══════════════════════════════════════════════════════════════════════════
H('1. PROPERTIES — precedence: customer+address > address > coordinates')
const PROPS: PropertyLite[] = [
  { id: 'p1', address: '123 Main St SW', customer_id: 'c1' },
  { id: 'p2', address: '123 Main Street SW', customer_id: 'c2' },
  { id: 'p3', address: null, lat: 51.05, lng: -114.07 },
]
check('same customer + same address is the strongest signal (confident)',
  findPropertyMatch(PROPS, { address: '123 main street sw', customerId: 'c1' }),
  { property: PROPS[0], reason: 'customer-address', confident: true })
check('address alone still matches (street ≡ st via the shared normalizer)',
  findPropertyMatch(PROPS, { address: '123 main street sw' }),
  { property: PROPS[0], reason: 'address', confident: true })
check('a customer probe that matches ANOTHER customer\'s address falls to the address rule',
  findPropertyMatch(PROPS, { address: '123 main st sw', customerId: 'c-new' })?.reason, 'address')

// ═══════════════════════════════════════════════════════════════════════════
H('2. PROPERTIES — the guards that prevent false accusations')
check('an address whose normalized key is under 5 chars never address-matches ("12 A")',
  findPropertyMatch([{ id: 'px', address: '12 A' }], { address: '12 A' }), null)
check('no address, no coordinates → no match', findPropertyMatch(PROPS, {}), null)
check('a property with no coordinates is skipped by the coordinate pass',
  findPropertyMatch([{ id: 'p', address: null }], { lat: 51.05, lng: -114.07 }), null)

// ═══════════════════════════════════════════════════════════════════════════
H('3. PROPERTIES — the ~35 m same-lot radius, against real haversine distances')
// ΔLat 0.0003° ≈ 33.4 m (inside); 0.00032° ≈ 35.6 m (outside). GPS noise is
// 5–15 m, so this radius says "same lot", and the verdict is deliberately NOT
// confident — coordinates alone can't tell a new build from a demolished listing.
check('33 m away → coordinate match, NOT confident (ask, never auto-link)',
  findPropertyMatch(PROPS, { lat: 51.0503, lng: -114.07 }),
  { property: PROPS[2], reason: 'coordinates', confident: false })
check('36 m away → no match (just outside the lot radius)',
  findPropertyMatch(PROPS, { lat: 51.05032, lng: -114.07 }), null)
check('with two candidates in radius, the CLOSEST wins',
  findPropertyMatch(
    [{ id: 'far', address: null, lat: 51.0502, lng: -114.07 },
     { id: 'near', address: null, lat: 51.0501, lng: -114.07 }],
    { lat: 51.05, lng: -114.07 })?.property.id, 'near')

// ═══════════════════════════════════════════════════════════════════════════
H('4. JOBS — same series or same property+day+service, cancelled never counts')
const JOBS: JobLiteForMatch[] = [
  { id: 'j1', property_id: 'p1', scheduled_date: '2026-04-22', service_type: 'Weekly Mowing', recurrence_id: 'r1', status: 'scheduled' },
  { id: 'j2', property_id: 'p1', scheduled_date: '2026-04-22', service_type: 'Aeration', status: 'cancelled' },
  { id: 'j3', property_id: 'p2', scheduled_date: '2026-04-22', service_type: 'Weekly Mowing' },
]
check('no date → no match (a date is the minimum accusation)',
  findJobMatch(JOBS, { propertyId: 'p1', serviceType: 'Weekly Mowing' }), null)
check('the recurring series already visiting that day wins over property+service',
  findJobMatch(JOBS, { date: '2026-04-22', recurrenceId: 'r1', propertyId: 'p2', serviceType: 'Weekly Mowing' }),
  { job: JOBS[0], reason: 'recurrence-visit', confident: true })
check('same property + day + service matches through the shared serviceKey ("lawn mowing" ≡ "Weekly Mowing")',
  findJobMatch(JOBS, { date: '2026-04-22', propertyId: 'p1', serviceType: 'lawn mowing' }),
  { job: JOBS[0], reason: 'property-day-service', confident: true })
check('a CANCELLED job is never a duplicate (rebooking a cancelled visit is normal)',
  findJobMatch(JOBS, { date: '2026-04-22', propertyId: 'p1', serviceType: 'Aeration' }), null)
check('excludeJobId keeps an edit from matching itself',
  findJobMatch(JOBS, { date: '2026-04-22', propertyId: 'p1', serviceType: 'Weekly Mowing', excludeJobId: 'j1' }), null)
check('a different day is a different visit',
  findJobMatch(JOBS, { date: '2026-04-23', propertyId: 'p1', serviceType: 'Weekly Mowing' }), null)

// ═══════════════════════════════════════════════════════════════════════════
H('5. HAMMING — the bit distance behind near-duplicate photos')
check('identical hashes → 0', hammingHex('ffff', 'ffff'), 0)
check('one flipped bit → 1', hammingHex('fffe', 'ffff'), 1)
check('f vs 0 in one nibble → 4 bits', hammingHex('f0', '00'), 4)
check('a LENGTH MISMATCH reads as maximally different (64), never a near-match',
  hammingHex('ff', 'ffff'), 64)
check('distance is symmetric', hammingHex('a3f0', '0c3f') === hammingHex('0c3f', 'a3f0'), true)

// ═══════════════════════════════════════════════════════════════════════════
H('6. PHOTOS — exact hash > near hash > EXIF timestamp, with honest confidence')
const PHOTOS: ExistingPhotoLite[] = [
  { id: 'a', taken_at: '2026-04-22T10:00:00.000Z', content_hash: 'aaaaaaaaaaaaaaaa' },
  { id: 'b', taken_at: null, content_hash: 'aaaaaaaaaaaaaaab' },
]
check('an identical content hash is an exact duplicate (confident)',
  findPhotoMatch(PHOTOS, { contentHash: 'aaaaaaaaaaaaaaaa' }),
  { photo: PHOTOS[0], reason: 'exact-hash', confident: true })
check('within 5 bits → near duplicate (re-encoded/cropped same shot)',
  findPhotoMatch(PHOTOS, { contentHash: 'aaaaaaaaaaaaaaae' }),
  { photo: PHOTOS[0], reason: 'near-hash', confident: true })
check('6 bits away is a DIFFERENT photo, not a near-match',
  findPhotoMatch([{ id: 'x', taken_at: null, content_hash: 'aaaaaaaaaaaaaa00' }],
    { contentHash: 'aaaaaaaaaaaaaa3f' }), null)
check('a photo with no stored hash can never hash-match',
  findPhotoMatch([{ id: 'n', taken_at: null }], { contentHash: 'aaaaaaaaaaaaaaaa' }), null)

// Timestamp matching only fires on EXIF-exact times — file mtimes collide too
// easily to accuse a photo of being a duplicate — and is never confident.
check('same property, captured within ±90 s (EXIF) → timestamp match, NOT confident',
  findPhotoMatch(PHOTOS, { takenAtMs: Date.parse('2026-04-22T10:01:30.000Z'), exactTime: true }),
  { photo: PHOTOS[0], reason: 'timestamp', confident: false })
check('the window edge is inclusive at exactly 90 s and closed 1 ms past it',
  findPhotoMatch(PHOTOS, { takenAtMs: Date.parse('2026-04-22T10:01:30.001Z'), exactTime: true }), null)
check('a non-EXIF (file mtime) timestamp never matches, even inside the window',
  findPhotoMatch(PHOTOS, { takenAtMs: Date.parse('2026-04-22T10:00:10.000Z'), exactTime: false }), null)
check('a photo with no taken_at never timestamp-matches',
  findPhotoMatch([{ id: 'n', taken_at: null }], { takenAtMs: Date.now(), exactTime: true }), null)

// ═══════════════════════════════════════════════════════════════════════════
H('7. SESSION SIGNATURE + LABELS — the UI contract')
check('fileSignature is name|size|lastModified',
  fileSignature({ name: 'a.jpg', size: 123, lastModified: 456 } as unknown as File), 'a.jpg|123|456')
check('every photo-match reason has an owner-readable label',
  (['exact-hash', 'near-hash', 'timestamp'] as const).every(r => PHOTO_MATCH_LABEL[r].length > 10), true)

// ═══════════════════════════════════════════════════════════════════════════
console.log(`\n${'═'.repeat(60)}\n  PASS ${pass}   FAIL ${fail}`)
if (fail > 0) process.exit(1)
