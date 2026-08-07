// ── Lead intake verification — run by CI (npm run verify:lead-intake) ──
//
// lib/intake.ts is THE server-side door that turns any external submission (website
// form, Formspree, a generic webhook) into a customer + lead. Its pure helpers were
// untested, and two of them are boundaries on UNTRUSTED PUBLIC INPUT:
//
//   1. normalizeFormspree — flattens the submission AND strips fields that must never
//      become lead data: the auth token (a credential), and _gotcha (Formspree's spam
//      honeypot — a bot fills it, so a lead carrying it is suspicious and it certainly
//      isn't a real field to persist).
//   2. esc — HTML-escapes lead text into the owner-alert email. A lead's name/notes are
//      public-form input; without this a `<script>` reaches the owner's inbox live.
//   3. leadField — resolves the snake_case/camelCase aliases the live marketing site
//      posts (preferred_schedule vs preferredSchedule, service_address vs …). A dropped
//      alias silently blanks a field the owner needs.
//
// Deterministic, no network, no DB. Pins CURRENT behavior — coverage, not a change.

import {
  normalizeFormspree, esc, leadField,
  extractInlinePhotos, decodeInlinePhoto, applyPhotoResults, buildLeadEmail,
  MAX_LEAD_PHOTOS,
} from '../src/lib/intake'
// The CRM's OWN read path — asserting against the exact function LeadSummary calls,
// so "the CRM can see it" is proven rather than assumed.
import { extractBookingPhotos } from '../src/lib/bookingPhotos'

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
H('1. normalizeFormspree — flatten the submission, drop what must not persist')
check('nested `data` is lifted to the top level',
  normalizeFormspree({ data: { name: 'Pat', email: 'p@x.com' } }), { name: 'Pat', email: 'p@x.com' })
check('nested `fields` is lifted when there is no `data`',
  normalizeFormspree({ fields: { name: 'Sam' } }), { name: 'Sam' })
check('`data` wins over `fields` when both are present',
  normalizeFormspree({ data: { name: 'FromData' }, fields: { name: 'FromFields' } }), { name: 'FromData' })
check('a flat submission passes through unchanged (minus stripped keys)',
  normalizeFormspree({ name: 'Flat', phone: '4035550100' }), { name: 'Flat', phone: '4035550100' })
check('the auth token is stripped — a credential must never persist as lead data',
  normalizeFormspree({ name: 'Pat', token: 'eqin_secret', _token: 'x' }), { name: 'Pat' })
check('the _gotcha spam honeypot is stripped',
  normalizeFormspree({ name: 'Pat', _gotcha: 'bot-filled-this' }), { name: 'Pat' })
check('Formspree metadata (_subject/_replyto/source) is stripped',
  normalizeFormspree({ name: 'Pat', _subject: 's', _replyto: 'r', source: 'Website' }), { name: 'Pat' })
check('stripping happens on the NESTED payload too (token inside data)',
  normalizeFormspree({ data: { name: 'Pat', _gotcha: 'x', token: 't' } }), { name: 'Pat' })
// Purity: the caller's object must not be mutated (it may be reused for logging).
const original = { name: 'Pat', _gotcha: 'x' }
normalizeFormspree(original)
ok('does not mutate the caller’s object', '_gotcha' in original)

// ═══════════════════════════════════════════════════════════════════════════
H('2. esc — the HTML-injection boundary into the owner’s inbox')
check('all five HTML-significant characters are escaped',
  esc(`&<>"'`), '&amp;&lt;&gt;&quot;&#39;')
check('a script payload from a public form is neutralized',
  esc('<script>alert(1)</script>'), '&lt;script&gt;alert(1)&lt;/script&gt;')
check('an attribute-breakout payload is neutralized',
  esc('"><img src=x onerror=alert(1)>'), '&quot;&gt;&lt;img src=x onerror=alert(1)&gt;')
check('ordinary text is untouched', esc('Pat O Brien, 123 Main St'), 'Pat O Brien, 123 Main St')
check('empty string stays empty', esc(''), '')

// ═══════════════════════════════════════════════════════════════════════════
H('3. leadField — the alias contract with the live marketing site')
check('camelCase alias resolves', leadField({ firstName: 'Pat' }, ['firstName', 'first_name']), 'Pat')
check('snake_case alias resolves', leadField({ preferred_schedule: 'Weekends' }, ['preferredSchedule', 'preferred_schedule']), 'Weekends')
check('first matching alias in order wins', leadField({ service: 'B', serviceType: 'A' }, ['serviceType', 'service']), 'A')
check('values are trimmed', leadField({ email: '  p@x.com  ' }, ['email']), 'p@x.com')
check('a numeric value is coerced to string (a budget posted as a number)',
  leadField({ budget: 500 }, ['budget']), '500')
check('a blank/whitespace value is skipped, not returned',
  leadField({ name: '   ', fullName: 'Pat' }, ['name', 'fullName']), 'Pat')
check('no alias present → empty string', leadField({ other: 'x' }, ['name', 'fullName']), '')

// ═══════════════════════════════════════════════════════════════════════════
// CUSTOMER PHOTOS — the production bug: the marketing site posts photos INLINE as
// base64 (`photos: [{base64, contentType, filename}]`), nothing converted them to
// the canonical `photos: string[]` URL contract every reader uses, so 17 real
// photos sat unreadable inside raw_submission — invisible in the CRM, absent from
// the owner email. These pin the whole chain: payload → storage → CRM → email.
H('Customer photos: payload → canonical URL contract')

const B64 = Buffer.from('fake-image-bytes').toString('base64')
const inline = (n: string) => ({ base64: B64, contentType: 'image/jpeg', filename: n })
const URL1 = 'https://x.supabase.co/storage/v1/object/public/booking-uploads/tok/a.jpg'
const URL2 = 'https://x.supabase.co/storage/v1/object/public/booking-uploads/tok/b.jpg'

// (1) ONE photo survives as a reference the rest of the app can read.
{
  const payload = { name: 'Pat', photos: [inline('front.jpg')] }
  const x = extractInlinePhotos(payload)
  check('1 photo → 1 inline item picked up', x.inline.length, 1)
  check('1 photo → nothing rejected', x.rejected, 0)
  const stored = applyPhotoResults(payload, { urls: [URL1], failed: [], rejected: 0 })
  check('1 photo → payload.photos becomes the URL array', stored.photos, [URL1])
  check('1 photo → no false failure flag', stored.photos_failed, undefined)
  check('1 photo → other fields untouched', stored.name, 'Pat')
}

// (2) MULTIPLE photos all preserved, in order.
{
  const payload = { photos: [inline('a.jpg'), inline('b.jpg'), inline('c.png')] }
  check('3 photos → all 3 picked up', extractInlinePhotos(payload).inline.length, 3)
  const stored = applyPhotoResults(payload, { urls: [URL1, URL2], failed: [], rejected: 0 })
  check('multi → every stored URL kept, in order', stored.photos, [URL1, URL2])
}

// A payload that ALREADY sends canonical URLs (future site version) passes through.
{
  const x = extractInlinePhotos({ photos: [URL1, URL2] })
  check('already-canonical URLs → not re-uploaded', x.inline.length, 0)
  check('already-canonical URLs → passed through', x.alreadyUrls, [URL1, URL2])
  check('already-canonical URLs → not rejected', x.rejected, 0)
}

// Decoding: bare base64 (what the site sends) and data: URLs both work; junk doesn't.
{
  check('bare base64 decodes', decodeInlinePhoto(inline('a.jpg'))?.bytes.toString(), 'fake-image-bytes')
  check('bare base64 → ext from contentType', decodeInlinePhoto(inline('a.jpg'))?.ext, 'jpg')
  check('png contentType → png ext',
    decodeInlinePhoto({ base64: B64, contentType: 'image/png', filename: 'x.png' })?.ext, 'png')
  check('data: URL prefix tolerated, its type wins',
    decodeInlinePhoto({ base64: `data:image/webp;base64,${B64}`, contentType: 'image/jpeg', filename: 'x' })?.ext, 'webp')
  check('non-base64 junk → null (counted, never uploaded)',
    decodeInlinePhoto({ base64: 'not valid!!', contentType: 'image/jpeg', filename: 'x' }), null)
  check('empty base64 → rejected at extract',
    extractInlinePhotos({ photos: [{ base64: '   ', contentType: 'image/jpeg' }] }).rejected, 1)
}

// Abuse bound: a hostile payload can't push unlimited photos into storage, and the
// overflow is COUNTED (never silently dropped).
{
  const many = Array.from({ length: MAX_LEAD_PHOTOS + 3 }, (_, i) => inline(`p${i}.jpg`))
  const x = extractInlinePhotos({ photos: many })
  check('over-cap → capped at MAX_LEAD_PHOTOS', x.inline.length, MAX_LEAD_PHOTOS)
  check('over-cap → overflow counted, not dropped silently', x.rejected, 3)
}

// (3) THE CRM read path: what intake persists is exactly what LeadSummary reads.
{
  const persisted = applyPhotoResults({ photos: [inline('a.jpg'), inline('b.jpg')] },
    { urls: [URL1, URL2], failed: [], rejected: 0 })
  check('CRM: extractBookingPhotos reads the persisted lead photos', extractBookingPhotos(persisted), [URL1, URL2])
  check('CRM: a no-photo lead shows nothing', extractBookingPhotos({ name: 'Pat' }), [])
  check('CRM: base64 objects are NOT mistaken for displayable photos (the bug)',
    extractBookingPhotos({ photos: [inline('a.jpg')] }), [])
}

// (4) THE EMAIL gets the same canonical data.
{
  const persisted = applyPhotoResults({ email: 'a@b.c', photos: [inline('a.jpg'), inline('b.jpg')] },
    { urls: [URL1, URL2], failed: [], rejected: 0 })
  const mail = buildLeadEmail('Website', persisted)
  check('email: says how many photos', mail.html.includes('2 photos attached'), true)
  check('email: links photo 1', mail.html.includes(URL1), true)
  check('email: links photo 2', mail.html.includes(URL2), true)
  check('email: plain-text part carries the URLs too', mail.text.includes(URL1), true)
  check('email: no photo section when there are none',
    buildLeadEmail('Website', { email: 'a@b.c' }).html.includes('photo'), false)
}

// (5) A FAILED upload can never read as a clean, photo-free success.
{
  const failedItem = inline('lost.jpg')
  const partial = applyPhotoResults({ photos: [inline('ok.jpg'), failedItem] },
    { urls: [URL1], failed: [failedItem], rejected: 0 })
  check('failure: the photo that stored is still stored', partial.photos, [URL1])
  check('failure: loss is COUNTED', partial.photos_failed, 1)
  check('failure: original bytes preserved for recovery',
    Array.isArray(partial.photos_unprocessed) && (partial.photos_unprocessed as unknown[]).length, 1)
  const mail = buildLeadEmail('Website', partial)
  check('failure: owner email warns out loud', mail.html.includes('could not be stored'), true)
  check('failure: warning reaches the text part', mail.text.includes('could not be stored'), true)

  // Total failure is the dangerous one — it must NOT look like "no photos sent".
  const total = applyPhotoResults({ photos: [failedItem] }, { urls: [], failed: [failedItem], rejected: 0 })
  check('total failure: photos array is empty…', total.photos, [])
  check('…but the loss is flagged, not silent', total.photos_failed, 1)
  check('total failure: bytes still recoverable',
    Array.isArray(total.photos_unprocessed) && (total.photos_unprocessed as unknown[]).length, 1)
  check('total failure: email still warns', buildLeadEmail('Website', total).html.includes('⚠️'), true)
}

// (6) A perfectly ordinary text-only lead is completely unaffected.
{
  const plain = { fullName: 'Pat', phone: '403-555-0100', notes: 'Front and back' }
  const x = extractInlinePhotos(plain)
  check('no photos → nothing to upload', [x.inline.length, x.alreadyUrls.length, x.rejected], [0, 0, 0])
  const out = applyPhotoResults(plain, { urls: [], failed: [], rejected: 0 })
  check('no photos → payload unchanged (no photos key invented)', out, plain)
  const mail = buildLeadEmail('Website', plain)
  check('no photos → email still lists the lead', mail.html.includes('Pat'), true)
  check('no photos → no photo section, no warning', mail.html.includes('photo') || mail.html.includes('⚠️'), false)
}

// ═══════════════════════════════════════════════════════════════════════════
console.log(`\n${'═'.repeat(60)}\n  PASS ${pass}   FAIL ${fail}`)
if (fail > 0) process.exit(1)
