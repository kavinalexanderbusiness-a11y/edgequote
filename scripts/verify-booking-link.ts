// ── Booking link verification — run by CI (npm run verify:booking-link) ──
//
// lib/booking.ts mints the credential that gates the PUBLIC /book/<token> door and
// builds the shareable link. Both were untested. The token is not a secret — the link
// is meant to be shared — but it is an ANTI-ENUMERATION boundary: it must stay long and
// opaque so nobody can walk the space to reach other owners' funnels or spam bookings.
// A wrong VALUE here (a token quietly shortened, a link with a doubled or missing slash)
// is invisible to tsc and next build; only running the functions catches it.
//
//   1. newBookingToken — 64 lowercase hex chars (two v4 UUIDs, dashes stripped),
//      URL-safe, unique across calls. This pins the entropy so a refactor can't swap
//      in a short/guessable id without breaking this file.
//   2. bookingUrl — canonical link: the app base with exactly one trailing slash
//      removed, then /book/<token> with the token appended verbatim.
//
// Deterministic, no network, no DB. Pins CURRENT behavior — coverage, not a change.

import { newBookingToken, bookingUrl } from '../src/lib/booking'

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
H('1. newBookingToken — the anti-enumeration shape must not weaken')
const tok = newBookingToken()
ok('is exactly 64 characters', tok.length === 64)
ok('is lowercase hex only (no dashes, no separators, no uppercase)', /^[0-9a-f]{64}$/.test(tok))
ok('carries no UUID dashes', !tok.includes('-'))
ok('is URL-safe as-is (survives encodeURIComponent untouched)', encodeURIComponent(tok) === tok)
// Opaqueness/collision sanity — 2000 tokens, all distinct.
const many = Array.from({ length: 2000 }, () => newBookingToken())
ok('2000 tokens are all distinct', new Set(many).size === 2000)
ok('every one of the 2000 holds the shape', many.every(t => /^[0-9a-f]{64}$/.test(t)))

// ═══════════════════════════════════════════════════════════════════════════
H('2. bookingUrl — one canonical /book/<token> link')
const TKN = 'abc123'
// bookingUrl reads NEXT_PUBLIC_APP_URL (there is no window in Node), so drive it here.
process.env.NEXT_PUBLIC_APP_URL = 'https://app.example.com'
check('a base with no trailing slash', bookingUrl(TKN), 'https://app.example.com/book/abc123')
process.env.NEXT_PUBLIC_APP_URL = 'https://app.example.com/'
check('a base WITH a trailing slash yields the identical link (no double slash)',
  bookingUrl(TKN), 'https://app.example.com/book/abc123')
process.env.NEXT_PUBLIC_APP_URL = 'https://app.example.com'
ok('the token is appended verbatim, not re-encoded',
  bookingUrl(newBookingToken()).startsWith('https://app.example.com/book/') &&
  bookingUrl('a_b-c').endsWith('/book/a_b-c'))
process.env.NEXT_PUBLIC_APP_URL = ''
check('with no base configured it degrades to a relative /book/<token> (current behavior)',
  bookingUrl(TKN), '/book/abc123')

// ═══════════════════════════════════════════════════════════════════════════
console.log(`\n${'═'.repeat(60)}\n  PASS ${pass}   FAIL ${fail}`)
if (fail > 0) process.exit(1)
