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

import { extractBookingPhotos, bookingPhotoViews, bookingPhotosFromQuotes } from '../src/lib/bookingPhotos'

let pass = 0
let fail = 0
function H(title: string) { console.log(`\n═══ ${title} ═══`) }
function check(name: string, actual: unknown, expected: unknown) {
  const a = JSON.stringify(actual); const e = JSON.stringify(expected)
  if (a === e) { pass++; console.log(`  ✅ ${name}`) }
  else { fail++; console.log(`  ❌ ${name}\n     expected: ${e}\n     actual:   ${a}`) }
}

// ═══════════════════════════════════════════════════════════════════════════
H('1. extractBookingPhotos — the URL filter is the security boundary')
check('http and https both survive',
  extractBookingPhotos({ photos: ['https://cdn.x/a.jpg', 'http://cdn.x/b.png'] }),
  ['https://cdn.x/a.jpg', 'http://cdn.x/b.png'])
check('the scheme test is case-insensitive',
  extractBookingPhotos({ photos: ['HTTPS://CDN.X/A.JPG'] }), ['HTTPS://CDN.X/A.JPG'])
check('a javascript: pseudo-URL is rejected (no XSS into the owner UI)',
  extractBookingPhotos({ photos: ['javascript:alert(1)'] }), [])
check('a data: URI is rejected',
  extractBookingPhotos({ photos: ['data:image/png;base64,AAAA'] }), [])
check('a relative path is rejected (only absolute http(s))',
  extractBookingPhotos({ photos: ['/uploads/a.jpg', 'a.jpg'] }), [])
check('ftp and other schemes are rejected',
  extractBookingPhotos({ photos: ['ftp://cdn.x/a.jpg'] }), [])
check('non-string entries are dropped, valid ones kept',
  extractBookingPhotos({ photos: ['https://cdn.x/a.jpg', 123, null, {}, true] }), ['https://cdn.x/a.jpg'])
check('a whitespace-padded https URL is accepted (trimmed before the scheme test)',
  extractBookingPhotos({ photos: ['  https://cdn.x/a.jpg  '] }).length, 1)

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
H('3. bookingPhotoViews — the public URL IS the source (no second store)')
const view = bookingPhotoViews(['https://cdn.x/abc123.jpg'], '2026-07-01T10:00:00Z')[0]
check('storage_path is the raw public URL', view.storage_path, 'https://cdn.x/abc123.jpg')
check('url mirrors storage_path', view.url, 'https://cdn.x/abc123.jpg')
check('rendered as a general, ownerless, jobless photo', [view.kind, view.job_id, view.property_id, view.customer_id],
  ['general', null, null, null])
check('taken_at carries the quote date', view.taken_at, '2026-07-01T10:00:00Z')
check('a null takenAt becomes empty string, never null/undefined',
  bookingPhotoViews(['https://cdn.x/a.jpg'], null)[0].taken_at, '')

// ═══════════════════════════════════════════════════════════════════════════
H('4. bookingPhotosFromQuotes — flatten, dedupe by URL, keep quote order + date')
const quotes = [
  { lead_meta: { photos: ['https://cdn.x/new.jpg', 'https://cdn.x/shared.jpg'] }, created_at: '2026-07-02' },
  { lead_meta: { photos: ['https://cdn.x/shared.jpg', 'https://cdn.x/old.jpg'] }, created_at: '2026-07-01' },
  { lead_meta: null, created_at: '2026-06-30' }, // a non-booking quote contributes nothing
]
const flat = bookingPhotosFromQuotes(quotes)
check('every distinct URL appears once (shared.jpg is not duplicated)',
  flat.map(v => v.url), ['https://cdn.x/new.jpg', 'https://cdn.x/shared.jpg', 'https://cdn.x/old.jpg'])
check('the first quote to carry a URL stamps its date (shared.jpg keeps 2026-07-02)',
  flat.find(v => v.url === 'https://cdn.x/shared.jpg')?.taken_at, '2026-07-02')
check('a quote with no lead_meta adds nothing (no throw)',
  bookingPhotosFromQuotes([{ lead_meta: null }, { lead_meta: undefined }]), [])

// ═══════════════════════════════════════════════════════════════════════════
console.log(`\n${'═'.repeat(60)}\n  PASS ${pass}   FAIL ${fail}`)
if (fail > 0) process.exit(1)
