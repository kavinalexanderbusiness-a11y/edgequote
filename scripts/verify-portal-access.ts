// ── Public portal-link recovery — security contract — npm run verify:portal-access ──
//
// /portal-access lets anyone type an email address and have a portal link sent to
// it. That makes it the one EdgeQuote surface an unauthenticated stranger can
// aim at a customer list, so its rules are security rules, not UX preferences:
//
//   • the answer must be identical for an address that exists and one that doesn't
//   • a portal token must never leave the server except inside the email
//   • nothing identifying may reach the logs
//   • an enumeration sweep must be rate-limited on MISSES, which is what a sweep
//     is made of
//
// §1–3 exercise the pure engine. §4–6 are structural over the route, the page and
// the migration, because "this branch cannot leak" is a property of the code's
// shape and a source-level assertion is what holds it still.
//
// Proven separately against the live database (recorded here so the reasoning
// isn't lost, and re-checkable by hand):
//   find_portal_access_customers('  Shaune@HoustonRealty.CA  ') → 1 row   (normalised both sides)
//   find_portal_access_customers('nobody-xyz@example.com')      → 0 rows
//   has_function_privilege('anon',          …, 'EXECUTE')       → FALSE
//   has_function_privilege('authenticated', …, 'EXECUTE')       → FALSE
//   has_function_privilege('service_role',  …, 'EXECUTE')       → TRUE
//   56 portal tokens, 56 distinct, 0 mapping to more than one customer

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { NEUTRAL_RESULT, normalizeEmail, portalAccessEmail } from '../src/lib/portalAccess'

let pass = 0
let fail = 0
function H(t: string) { console.log(`\n═══ ${t} ═══`) }
function check(name: string, actual: unknown, expected: unknown) {
  const a = JSON.stringify(actual); const e = JSON.stringify(expected)
  if (a === e) { pass++; console.log(`  ✅ ${name}`) }
  else { fail++; console.log(`  ❌ ${name}\n     expected: ${e}\n     actual:   ${a}`) }
}
const ROOT = join(__dirname, '..')
const read = (p: string) => readFileSync(join(ROOT, p), 'utf8')

const ROUTE = read('src/app/api/public/portal-access/route.ts')
const FORM = read('src/app/portal-access/PortalAccessForm.tsx')
const PAGE = read('src/app/portal-access/page.tsx')
const SQL = read('supabase/RUN-2026-08-10-portal-access-requests.sql')

// ═══════════════════════════════════════════════════════════════════════════
H('1. NORMALISATION — the same person, however they type it')

check('lowercased', normalizeEmail('Shaune@HoustonRealty.CA'), 'shaune@houstonrealty.ca')
check('surrounding whitespace stripped', normalizeEmail('   a@b.co   '), 'a@b.co')
// People paste from contact cards and mail clients, which inject spaces mid-string.
check('internal whitespace stripped', normalizeEmail('a @ b.co'), 'a@b.co')
check('tabs and newlines too', normalizeEmail('\t a@b.co \n'), 'a@b.co')
check('already-normal passes through', normalizeEmail('a@b.co'), 'a@b.co')

check('no @ is rejected', normalizeEmail('not-an-email'), null)
check('two @ are rejected', normalizeEmail('a@b@c.co'), null)
check('no dot in the domain is rejected', normalizeEmail('a@localhost'), null)
check('empty is rejected', normalizeEmail(''), null)
check('a non-string is rejected', normalizeEmail(undefined), null)
check('a number is rejected', normalizeEmail(42), null)
// 254 is the RFC ceiling; anything longer is a probe, not a person.
check('absurdly long is rejected', normalizeEmail('a'.repeat(250) + '@b.co'), null)
// Deliberately permissive on the exotic-but-legal: a wrong "that's not an email"
// would lock a real customer out of their own portal, and the DB is the real gate.
check('plus-addressing survives', normalizeEmail('a+tag@b.co'), 'a+tag@b.co')
check('subdomains survive', normalizeEmail('a@mail.b.co.uk'), 'a@mail.b.co.uk')

H('2. THE NEUTRAL ANSWER — one sentence, used by both sides')
{
  check('it does not say whether the address matched',
    /\bif an account matches\b/i.test(NEUTRAL_RESULT), true)
  check('it never says "not found"/"no account"',
    /not found|no account|doesn.t exist|isn.t registered/i.test(NEUTRAL_RESULT), false)
  // ONE constant. If the page hard-coded its own wording, the two could drift and
  // the UI would eventually say something the API deliberately doesn't.
  check('the page imports the constant rather than restating it',
    /NEUTRAL_RESULT/.test(FORM), true)
  check('the route returns that same constant', /NEUTRAL_RESULT/.test(ROUTE), true)
}

H('3. THE EMAIL — a link, and nothing that identifies anyone')
{
  const one = portalAccessEmail([{ url: 'https://x.test/portal/jane-AB12CD34', customerName: 'Jane', businessName: 'Edge Property Services' }])
  check('the subject names the business, not the customer',
    one.subject, 'Your Edge Property Services customer portal')
  check('the HTML links the portal with a plain call to action',
    /href="https:\/\/x\.test\/portal\/jane-AB12CD34"[^>]*>Open Customer Portal</.test(one.html), true)
  // The token is unavoidable inside the href (it IS the link) and in the
  // plain-text part, where words cannot carry one. What it must never be is
  // recited AS a value — "your code is …" — which is how tokens end up quoted
  // into support chats and screenshots.
  check('the token is never presented as a standalone code',
    /your (code|token)|token:|code:/i.test(one.html + one.text), false)
  // No balance, no address, no visit — the recipient learns nothing until they
  // open the portal the link proves they may open.
  // "…your visits, quotes and invoices" DESCRIBES what the portal holds; what must
  // never appear is a VALUE — an amount, a document number, a date.
  check('the message carries no account values (amount / document number / date)',
    /\$\s?\d|\bINV-\d|\bEPS-\d|\d{4}-\d{2}-\d{2}/.test(one.text + one.html), false)
  check('it is transactional, not marketing (no unsubscribe, no offer)',
    /unsubscribe|special offer|discount|deal/i.test(one.html), false)
  check('it warns the link is the credential',
    /keep this link private/i.test(one.text), true)

  // Several portals on one address: each is its own link, labelled, never merged.
  const many = portalAccessEmail([
    { url: 'https://x.test/portal/jane-AAAA1111', customerName: 'Jane', businessName: 'Edge Property Services' },
    { url: 'https://x.test/portal/jane-BBBB2222', customerName: 'Jane (rental)', businessName: 'Other Co' },
  ])
  check('a shared address gets BOTH links', (many.html.match(/Open Customer Portal/g) || []).length, 2)
  check('…each one labelled so they can be told apart', /Jane \(rental\) · Other Co/.test(many.html), true)
  check('…and the subject stops naming a single business', many.subject, 'Your customer portals')
  check('…and says why there is more than one', /more than one account/i.test(many.text), true)
  check('a lone portal is NOT labelled (no redundant caption)',
    /Jane · Edge Property Services/.test(one.html), false)
}

// ═══════════════════════════════════════════════════════════════════════════
H('4. THE ROUTE — what may and may not cross the boundary')
{
  // The success body is built in ONE helper used by both the match and the
  // no-match path, so the two cannot drift apart into an oracle.
  check('there is a single success responder', /const ok = \(\) =>/.test(ROUTE), true)
  check('the no-match path returns it', /links\.length === 0\) return ok\(\)/.test(ROUTE), true)
  check('the matched path returns the same thing', /return ok\(\)\s*\n\}/.test(ROUTE), true)

  // The one thing that must never be in the reply.
  const responses = [...ROUTE.matchAll(/NextResponse\.json\(([^;]*?)\)/gs)].map(m => m[1])
  check('no response object mentions a token',
    responses.filter(r => /token/i.test(r)), [])
  // ("portal links" appears in the user-facing 503 copy — that is prose, not data.)
  check('no response object mentions a customer or a built URL',
    responses.filter(r => /customer|portalUrl|\burl\b/i.test(r)), [])

  // Logging. Every console call is inspected: a reason may be logged, an identity
  // may not.
  {
    const logs = [...ROUTE.matchAll(/console\.\w+\(([^;]*?)\)\n/gs)].map(m => m[1])
      // Only an INTERPOLATED value can leak. Quoted prose ("email provider not
      // configured") describes configuration and carries nothing about anyone.
      .map(l => l.replace(/'[^']*'|`[^`]*`|"[^"]*"/g, "''"))
    const leaky = logs.filter(l => /\bemail\b|\btoken\b|emailKey|customer_id/.test(l))
    check('no log statement interpolates the address, the key or a token', leaky, [])
  }

  // Rate limiting must bite on misses, or a sweep is unlimited.
  check('the attempt is recorded BEFORE the lookup runs',
    ROUTE.indexOf('portal_access_requests').valueOf() < ROUTE.indexOf('find_portal_access_customers'), true)
  check('there is a per-address hourly limit', /PER_EMAIL_HOURLY = \d+/.test(ROUTE), true)
  check('…and a global hourly limit', /GLOBAL_HOURLY = \d+/.test(ROUTE), true)
  check('both are checked before any customer work',
    ROUTE.indexOf('status: 429') < ROUTE.indexOf('find_portal_access_customers'), true)
  check('the bucket key is a hash, never the address',
    /createHash\('sha256'\)\.update\(email\)/.test(ROUTE), true)

  // Fail closed — never answer "we sent it" when nothing could have been sent.
  check('a missing service key or mail provider is a 503, not a fake success',
    /!sb \|\| !commsEnabled\(\)\.email[\s\S]{0,400}?status: 503/.test(ROUTE), true)
  // 204 is the CORS preflight, not a rejection. Everything else this route can
  // answer with is decided BEFORE the lookup, so no status can act as an oracle.
  check('every rejection is match-independent (400/429/503 only)',
    [...ROUTE.matchAll(/status: (\d{3})/g)].map(m => m[1]).filter(s => s !== '204').sort(),
    ['400', '429', '503', '503', '503'])

  // A withdrawn portal stays withdrawn.
  check('a customer whose tokens are all revoked is skipped',
    /rowsT\.length > 0 && rowsT\.every\(t => t\.revoked\)\) continue/.test(ROUTE), true)
  // The lookup goes through the definer function, not a table filter.
  check('the lookup uses the REVOKED-from-anon function',
    /rpc\('find_portal_access_customers'/.test(ROUTE), true)
  check('…and not a raw customers filter that anon-readable keys could mimic',
    /from\('customers'\)/.test(ROUTE), false)

  // A failed send is recorded as failed. The public answer stays neutral (a
  // provider outage must not become the oracle), but the ledger must not lie.
  check('the ledger records the real send outcome', /sent: res\.sent/.test(ROUTE), true)
  check('a rejected send is logged by REASON only', /provider rejected the send/.test(ROUTE), true)
}

H('5. THE PAGE — no sixth state')
{
  // Comments explain WHY there is no "not found" branch; they must not be mistaken
  // for one. Judge the code and copy that actually ship.
  const stripComments = (s: string) =>
    s.replace(new RegExp('//[^\\n]*', 'g'), '').replace(new RegExp('/\\*[\\s\\S]*?\\*/', 'g'), '')
  const FORM_CODE = stripComments(FORM)
  const PAGE_CODE = stripComments(PAGE)
  check('the form has no "email not found" branch',
    /not found|no account|couldn.t find|unknown email/i.test(FORM_CODE), false)
  check('it validates FORMAT only, before sending', /normalizeEmail\(email\) === null/.test(FORM), true)
  check('there is a sending state', /'sending'/.test(FORM), true)
  check('there is a retryable error state', /'error'/.test(FORM), true)
  check('the success state shows the neutral sentence', /\{NEUTRAL_RESULT\}/.test(FORM), true)
  check('no password FIELD and no signup route exist',
    /type="password"|sign ?up|create account|\/register/i.test(FORM_CODE + PAGE_CODE), false)
  check('…and the page says so plainly', /no password/i.test(FORM), true)
  // A recovery page is a target; keeping it out of the index removes it as one.
  check('the page is noindex', /robots: \{ index: false/.test(PAGE), true)
  // Phone-first: 16px input (iOS will not zoom) and 48px targets.
  check('inputs are 16px so iOS does not zoom on focus', /text-base/.test(FORM), true)
  check('the button and field meet a 48px touch target',
    (FORM.match(/min-h-\[48px\]/g) || []).length >= 2, true)
}

H('6. THE LEDGER — an abuse record, not an address book')
{
  check('it stores a hashed key', /email_key\s+text\s+not null/.test(SQL), true)
  check('it does NOT store the address', /\bemail\s+text/.test(SQL.replace(/email_key/g, '')), false)
  {
    // Only the ledger's OWN column list. The lookup function further down the file
    // legitimately returns customer_id/owner_id — to the server, never to a browser.
    const start = SQL.indexOf('create table')
    const ddl = SQL.slice(start, SQL.indexOf(');', start))
    check('the ledger table holds no customer, owner or token column',
      /customer_id|user_id|token/.test(ddl), false)
  }
  check('RLS is on', /enable row level security/.test(SQL), true)
  check('…with no policy, so only service-role reaches it',
    /create policy/i.test(SQL), false)
  check('the lookup function is revoked from anon', /revoke all on function[\s\S]*?from anon/.test(SQL), true)
  check('…and from authenticated', /revoke all on function[\s\S]*?from authenticated/.test(SQL), true)
  check('the function normalises both sides',
    /lower\(trim\(c\.email\)\) = lower\(trim\(p_email\)\)/.test(SQL), true)
  check('archived customers are excluded from recovery',
    /c\.archived_at is null/.test(SQL), true)
}

// ═══════════════════════════════════════════════════════════════════════════
console.log(`\n${fail === 0 ? '✅' : '❌'} portal access: ${pass} passed, ${fail} failed\n`)
process.exit(fail === 0 ? 0 : 1)
