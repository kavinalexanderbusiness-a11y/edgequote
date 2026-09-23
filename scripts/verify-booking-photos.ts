// ── Booking photos verification — run by CI (npm run verify:booking-photos) ──
//
// lib/bookingPhotos.ts is a canonical booking-pipeline seam: it parses
// quotes.lead_meta.photos — the blob submit_booking writes from the PUBLIC booking
// door — and adapts it for the shared read-only gallery on the customer profile, the
// draft-quote review, and the Messages booking event. Because the input is untrusted
// public data rendered in the OWNER's UI, its guards are load-bearing and must not be
// weakened by a refactor:
//
//   1. THE URL FILTER: only http(s) URLs survive. A relative path, a data: URI, or a
//      javascript: pseudo-URL smuggled into the booking payload must never reach an
//      <img src> in the dashboard. This is the security-relevant line.
//   2. SHAPE GUARDS: a missing/renamed key, a non-array, or non-string entries yield
//      [] rather than a throw — one malformed booking can't blank a customer's page.
//   3. DEDUP + ORDER: photos are unique by URL and keep the caller's quote order
//      (newest quote first), each stamped with its quote's date.
//
// Style follows the other verify scripts: deterministic, no network, no DB. These pin
// CURRENT behavior — this is coverage, not a behavior change.

import { readFileSync } from 'node:fs'
import { extractBookingPhotos, bookingPhotoViews, bookingPhotosFromQuotes } from '../src/lib/bookingPhotos'
import {
  CUSTOMER_UPLOAD_BUCKET, LEGACY_CUSTOMER_UPLOAD_BUCKET, customerPhotoDisplayUrl,
  customerUploadPath, customerUploadRef, safeLegacyCustomerPhotoUrl,
  selectCustomerUploadTarget,
} from '../src/lib/customerUploadPhotos'

let pass = 0
let fail = 0
function H(title: string) { console.log(`\n═══ ${title} ═══`) }
function check(name: string, actual: unknown, expected: unknown) {
  const a = JSON.stringify(actual); const e = JSON.stringify(expected)
  if (a === e) { pass++; console.log(`  ✅ ${name}`) }
  else { fail++; console.log(`  ❌ ${name}\n     expected: ${e}\n     actual:   ${a}`) }
}

// ═══════════════════════════════════════════════════════════════════════════
const OWNER = '11111111-1111-4111-8111-111111111111'
const PHOTO = '22222222-2222-4222-8222-222222222222'
const REF = `customer-upload:${OWNER}/booking/${PHOTO}.jpg`
const LEGACY = 'https://x.supabase.co/storage/v1/object/public/booking-uploads/old/photo.jpg'

H('1. extractBookingPhotos — private refs + safe legacy compatibility')
check('a valid private reference survives', extractBookingPhotos({ photos: [REF] }), [REF])
check('the former Supabase booking bucket survives for historical records',
  extractBookingPhotos({ photos: [LEGACY] }), [LEGACY])
check('plain http is rejected', extractBookingPhotos({ photos: ['http://x.supabase.co/storage/v1/object/public/booking-uploads/a.jpg'] }), [])
check('an arbitrary https image is rejected (no owner-dashboard tracking pixel)',
  extractBookingPhotos({ photos: ['https://cdn.x/a.jpg'] }), [])
check('a javascript: pseudo-URL is rejected (no XSS into the owner UI)',
  extractBookingPhotos({ photos: ['javascript:alert(1)'] }), [])
check('a data: URI is rejected',
  extractBookingPhotos({ photos: ['data:image/png;base64,AAAA'] }), [])
check('a relative path is rejected (only durable refs or historical URLs)',
  extractBookingPhotos({ photos: ['/uploads/a.jpg', 'a.jpg'] }), [])
check('ftp and other schemes are rejected',
  extractBookingPhotos({ photos: ['ftp://cdn.x/a.jpg'] }), [])
check('non-string entries are dropped, valid ones kept',
  extractBookingPhotos({ photos: [REF, 123, null, {}, true] }), [REF])
check('a whitespace-padded https URL is accepted (trimmed before the scheme test)',
  extractBookingPhotos({ photos: [`  ${LEGACY}  `] }).length, 1)

// ═══════════════════════════════════════════════════════════════════════════
H('2. extractBookingPhotos — shape guards never throw, always return an array')
check('null → []', extractBookingPhotos(null), [])
check('undefined → []', extractBookingPhotos(undefined), [])
check('a bare string (not an object) → []', extractBookingPhotos('nope'), [])
check('a number → []', extractBookingPhotos(42), [])
check('no photos key → []', extractBookingPhotos({ address: '123 Main St' }), [])
check('photos is not an array → []', extractBookingPhotos({ photos: 'https://cdn.x/a.jpg' }), [])
check('photos is null → []', extractBookingPhotos({ photos: null }), [])
check('empty photos array → []', extractBookingPhotos({ photos: [] }), [])

// ═══════════════════════════════════════════════════════════════════════════
H('3. bookingPhotoViews — private refs use the authenticated reader')
const view = bookingPhotoViews([REF], '2026-07-01T10:00:00Z')[0]
check('storage_path keeps the durable private ref', view.storage_path, REF)
check('url points to the authenticated signing route', view.url, `/api/customer-photos/file?ref=${encodeURIComponent(REF)}`)
check('rendered as a general, ownerless, jobless photo', [view.kind, view.job_id, view.property_id, view.customer_id],
  ['general', null, null, null])
check('taken_at carries the quote date', view.taken_at, '2026-07-01T10:00:00Z')
check('a null takenAt becomes empty string, never null/undefined',
  bookingPhotoViews([REF], null)[0].taken_at, '')

// ═══════════════════════════════════════════════════════════════════════════
H('4. bookingPhotosFromQuotes — flatten, dedupe by URL, keep quote order + date')
const quotes = [
  { lead_meta: { photos: [REF, LEGACY] }, created_at: '2026-07-02' },
  { lead_meta: { photos: [LEGACY] }, created_at: '2026-07-01' },
  { lead_meta: null, created_at: '2026-06-30' }, // a non-booking quote contributes nothing
]
const flat = bookingPhotosFromQuotes(quotes)
check('every distinct URL appears once (shared.jpg is not duplicated)',
  flat.map(v => v.storage_path), [REF, LEGACY])
check('the first quote to carry a URL stamps its date (shared.jpg keeps 2026-07-02)',
  flat.find(v => v.storage_path === LEGACY)?.taken_at, '2026-07-02')
check('a quote with no lead_meta adds nothing (no throw)',
  bookingPhotosFromQuotes([{ lead_meta: null }, { lead_meta: undefined }]), [])

// ═══════════════════════════════════════════════════════════════════════════
H('5. durable refs and private storage')
check('valid path becomes a durable ref', customerUploadRef(`${OWNER}/booking/${PHOTO}.jpg`), REF)
check('the durable ref parses back to the same path', customerUploadPath(REF), `${OWNER}/booking/${PHOTO}.jpg`)
check('a path containing a token-like top folder is refused', customerUploadRef(`token/booking/${PHOTO}.jpg`), null)
check('legacy validator allows only booking-uploads', !!safeLegacyCustomerPhotoUrl(LEGACY), true)
check('private display uses the authenticated reader', customerPhotoDisplayUrl(REF).startsWith('/api/customer-photos/file?ref='), true)
const uploadRoute = readFileSync('src/app/api/public/booking/photos/route.ts', 'utf8')
check('booking upload selects from the committed bucket catalog before writing',
  uploadRoute.includes('inspectCustomerUploadBuckets(admin)')
    && uploadRoute.includes('selectCustomerUploadTarget(buckets, file.type)'), true)
check('private booking upload returns a durable ref and only a signed preview',
  uploadRoute.includes('{ ok: true, url: ref, ref, previewUrl: preview.signedUrl }'), true)
check('bucket constant stays pinned', CUSTOMER_UPLOAD_BUCKET, 'customer-uploads')
check('legacy bucket constant stays pinned', LEGACY_CUSTOMER_UPLOAD_BUCKET, 'booking-uploads')

// ═══════════════════════════════════════════════════════════════════════════
H('6. pre/post migration upload compatibility fails closed')
const PRE_MIGRATION = [{ id: LEGACY_CUSTOMER_UPLOAD_BUCKET, public: true, allowed_mime_types: null }]
const POST_MIGRATION = [
  { id: LEGACY_CUSTOMER_UPLOAD_BUCKET, public: true, allowed_mime_types: ['application/x-edgehq-read-only-legacy'] },
  { id: CUSTOMER_UPLOAD_BUCKET, public: false, allowed_mime_types: ['image/jpeg', 'image/png'] },
]
check('before migration an image uses the legacy bucket',
  selectCustomerUploadTarget(PRE_MIGRATION, 'image/jpeg'),
  { bucket: LEGACY_CUSTOMER_UPLOAD_BUCKET, mode: 'legacy' })
check('after migration the same image uses private storage',
  selectCustomerUploadTarget(POST_MIGRATION, 'image/jpeg'),
  { bucket: CUSTOMER_UPLOAD_BUCKET, mode: 'private' })
check('a private bucket accidentally marked public blocks the upload instead of falling back',
  selectCustomerUploadTarget([
    PRE_MIGRATION[0],
    { id: CUSTOMER_UPLOAD_BUCKET, public: true, allowed_mime_types: ['image/jpeg'] },
  ], 'image/jpeg'), null)
check('a missing private bucket after the legacy write lock fails closed',
  selectCustomerUploadTarget([POST_MIGRATION[0]], 'image/jpeg'), null)
check('an empty legacy MIME allowlist is ambiguous and fails closed',
  selectCustomerUploadTarget([{ id: LEGACY_CUSTOMER_UPLOAD_BUCKET, public: true, allowed_mime_types: [] }], 'image/jpeg'), null)
check('a private bucket MIME mismatch fails closed instead of falling back',
  selectCustomerUploadTarget(POST_MIGRATION, 'image/webp'), null)
const bookingClient = readFileSync('src/app/book/[token]/BookingClient.tsx', 'utf8')
check('the browser accepts both the old URL response and the new ref/preview response',
  bookingClient.includes('const ref = result?.ref || result?.url')
    && bookingClient.includes('const preview = result?.previewUrl || result?.url'), true)
const portalUploadRoute = readFileSync('src/app/api/public/portal/photos/route.ts', 'utf8')
check('the public portal photo route uses the same compatibility decision',
  portalUploadRoute.includes('selectCustomerUploadTarget(buckets, file.type)')
    && portalUploadRoute.includes("target.mode === 'legacy'"), true)
const intake = readFileSync('src/lib/intake.ts', 'utf8')
check('inline website photos use the same compatibility decision',
  intake.includes('selectCustomerUploadTarget(buckets, decoded.contentType)')
    && intake.includes("target.mode === 'legacy'"), true)

// ═══════════════════════════════════════════════════════════════════════════
console.log(`\n${'═'.repeat(60)}\n  PASS ${pass}   FAIL ${fail}`)
if (fail > 0) process.exit(1)
