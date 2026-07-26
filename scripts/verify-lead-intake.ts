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

import { normalizeFormspree, esc, leadField } from '../src/lib/intake'

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
console.log(`\n${'═'.repeat(60)}\n  PASS ${pass}   FAIL ${fail}`)
if (fail > 0) process.exit(1)
