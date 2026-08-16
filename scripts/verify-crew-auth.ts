// ── Verify: a worker can get in, only where they belong, and only while allowed ─
//   npm run verify:crew-auth
//
// WHY THIS SCRIPT EXISTS
// verify:crew-access pins the DATA boundary (RPC-only, no crew table grants) and
// verify:crew-invite pins the PROVISIONING boundary (the service role cannot bind
// the wrong person). Neither covers the thing a worker actually experiences: an
// invitation that arrives, a link that resolves, a landing that is theirs, and an
// access switch that is honest about being off.
//
// Every rule below is one that failed in production or would have:
//
//   • the emailed link carried a retired hostname and answered 404 — nothing in
//     the product ever looked at a generated link, so a worker's screenshot was
//     the detector;
//   • the link was never emailed at all, so "send invite" meant "copy this out
//     of a modal by hand";
//   • a query-form token in an email is one quoted-printable escape away from
//     arriving broken (`=73` → 's', measured on beta signup);
//   • a disabled worker was shown the join-code form and told to enter a code
//     that the redeem path refuses by design;
//   • sign-in sent everyone to the owner's dashboard and let the middleware
//     bounce workers back, which is a flash of the wrong product on every phone.
//
// Pure rules are driven as BEHAVIOUR; the rest is asserted over the real routes,
// the real components and the real allowlist.

import {
  buildSetupUrl, readSetupToken, readSetupPathToken, joinScreenFor,
  crewAccessState, CREW_WELCOME_PATH, type CrewSelfStatus,
} from '../src/lib/crewInvite'
import { routeFor, landingFor, isWelcomePath } from '../src/lib/crewAccess'
import { cleanOrigin, appOrigin } from '../src/lib/appOrigin'
import { crewInviteEmail } from '../src/lib/crewInviteServer'
import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'

let failures = 0
const ok = (n: string) => console.log(`  ✓ ${n}`)
const bad = (n: string, d: string) => { failures++; console.log(`  ✗ ${n}\n      ${d}`) }
const check = (n: string, cond: boolean, d = '') => cond ? ok(n) : bad(n, d)
const eq = (n: string, a: unknown, b: unknown) =>
  check(n, JSON.stringify(a) === JSON.stringify(b), `expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`)
const H = (t: string) => console.log(`\n═══ ${t} ═══`)

const ROOT = process.cwd()
const read = (p: string) => readFileSync(join(ROOT, p), 'utf8')
/**
 * Strip comments before any "must not contain" scan. A file that DOCUMENTS the
 * thing it refuses to do would otherwise read as the violation — this repo has
 * been bitten by that repeatedly.
 *
 * ⚠️ LINE COMMENTS FIRST, then blocks. The other order is a live bug and it bit
 * this very guard: a line comment mentioning a glob like `app/api/**` opens a
 * `/*` that the block regex then closes at the NEXT `*​/` anywhere below —
 * swallowing real code in between and failing checks about it. Removing line
 * comments first means such a `/*` never survives to start a false block.
 * CRLF-safe: `.` does not match `\r`, so the line pattern is anchored on \n.
 */
const strip = (s: string) =>
  s.replace(/^[^\n]*?\/\/[^\n]*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '')

// ═══════════════════════════════════════════════════════════════════════════
H('1. THE ORIGIN — every generated link is built on a value we cleaned')

// The production domain moved to app.edgehq.ca; the env var still held the old
// one, and every invitation 404'd. Then setting it from a shell wrote a UTF-8
// BOM into the value — invisible in every dashboard that displays it.
eq('a BOM is stripped', cleanOrigin('﻿https://app.edgehq.ca'), 'https://app.edgehq.ca')
eq('surrounding whitespace and newlines are stripped', cleanOrigin('  https://app.edgehq.ca\n'), 'https://app.edgehq.ca')
eq('wrapping quotes from a .env line are stripped', cleanOrigin('"https://app.edgehq.ca"'), 'https://app.edgehq.ca')
eq('a trailing slash is stripped (callers append their own)', cleanOrigin('https://app.edgehq.ca/'), 'https://app.edgehq.ca')
eq('several at once', cleanOrigin('﻿ "https://app.edgehq.ca/" '), 'https://app.edgehq.ca')
eq('an absent value is empty, never a guessed host', cleanOrigin(undefined), '')
eq('a BOM-only value is empty, not a one-character origin', cleanOrigin('﻿'), '')

// The fallback exists so previews and local dev work; it must not invent a host.
const savedEnv = process.env.NEXT_PUBLIC_APP_URL
delete process.env.NEXT_PUBLIC_APP_URL
eq('with nothing configured, the request origin is used', appOrigin('http://localhost:3000'), 'http://localhost:3000')
eq('with nothing configured and no request, the answer is empty', appOrigin(), '')
process.env.NEXT_PUBLIC_APP_URL = '﻿https://app.edgehq.ca/'
eq('a corrupt configured value still yields a usable origin', appOrigin('http://localhost:3000'), 'https://app.edgehq.ca')
if (savedEnv === undefined) delete process.env.NEXT_PUBLIC_APP_URL
else process.env.NEXT_PUBLIC_APP_URL = savedEnv

// The deploy has to be able to SAY which origin it stamps, or the next domain
// move is invisible again.
const health = read('src/app/api/health/route.ts')
check('/api/health reports the cleaned origin and the raw one',
  /app_url:\s*appOrigin\(\)/.test(health) && /app_url_raw:/.test(health),
  'reporting only the cleaned value would have hidden the BOM that broke every link')

// ═══════════════════════════════════════════════════════════════════════════
H('2. THE LINK — emailed, so it must survive an email')

const url = buildSetupUrl('https://app.edgehq.ca/', 'tok/en+with=chars')
check('the link points at the welcome page', url.startsWith('https://app.edgehq.ca' + CREW_WELCOME_PATH + '/'))
check('no "=" and no "?" survive into the emailed URL', !url.includes('=') && !url.includes('?'),
  '`=73` is a valid quoted-printable escape — a query-form token can arrive mangled')
check('the token is percent-encoded', url.includes('tok%2Fen%2Bwith%3Dchars'))
check('a trailing slash on the origin does not double up', !url.includes('.ca//'))

// Both spellings still open, so a link copied out of the old UI keeps working.
eq('the canonical path token is read', readSetupPathToken(['abc123']), 'abc123')
eq('a deeper path is not a link we built', readSetupPathToken(['a', 'b']), null)
eq('the legacy ?token= form still opens', readSetupToken(k => (k === 'token' ? 'legacy' : null)), 'legacy')
eq('Supabase\'s own ?token_hash= spelling still opens', readSetupToken(k => (k === 'token_hash' ? 'legacy' : null)), 'legacy')

// The route that serves it must exist at the catch-all, or the emailed shape 404s
// exactly the way the old hostname did.
check('the welcome route is an optional catch-all (serves /crew/welcome/<hash>)',
  existsSync(join(ROOT, 'src/app/crew/welcome/[[...link]]/page.tsx')),
  'without the catch-all the emailed path-segment link is a 404')
check('the old fixed welcome page is gone (one route, not two)',
  !existsSync(join(ROOT, 'src/app/crew/welcome/page.tsx')))

// …and it must stay reachable with no session at all: the worker arrives holding
// a token and nothing else.
eq('signed out → the welcome page is allowed', routeFor('none', '/crew/welcome/abc', false), null)
eq('signed in but unlinked → allowed', routeFor('none', '/crew/welcome/abc', true), null)
eq('crew → allowed', routeFor('crew', '/crew/welcome/abc', true), null)
eq('owner → allowed', routeFor('owner', '/crew/welcome/abc', true), null)
check('the deep welcome path is recognised as a welcome path', isWelcomePath('/crew/welcome/abc123'))

const welcome = read('src/components/crew/CrewWelcomeForm.tsx')
// ⚠️ Assert the USE, not the first mention: both names appear on the import
// line, where the query reader is written first.
check('the path token is preferred over the query token',
  /readSetupPathToken\([^)]*\)\s*\?\?\s*readSetupToken\(/.test(welcome),
  'the canonical shape must win when both are somehow present')
check('acceptance lands the worker in the crew app, not the dashboard',
  /router\.replace\('\/crew'\)/.test(welcome))

// ═══════════════════════════════════════════════════════════════════════════
H('3. THE INVITATION — actually sent, and never claimed when it was not')

const route = read('src/app/api/crew/invite/route.ts')
const routeCode = strip(route)

check('the route sends the invitation email', /sendEmail\(/.test(routeCode))
check('it builds the message from the shared server-only builder', /crewInviteEmail\(/.test(routeCode))
check('the origin comes from lib/appOrigin, not a raw env read',
  /appOrigin\(/.test(routeCode) && !/process\.env\.NEXT_PUBLIC_APP_URL/.test(routeCode),
  'a raw read re-opens the BOM/trailing-slash class of failure')
check('`emailed` reports the REAL send result, never a constant',
  /emailed\s*=\s*res\.sent/.test(routeCode) && !/emailed:\s*true/.test(routeCode),
  'telling an owner it was emailed when it was not leaves them waiting for nothing')
check('a failed send still returns the working link',
  routeCode.indexOf('setupUrl') > -1 && /ok:\s*true/.test(routeCode),
  'a provider outage must not cost the owner the one thing they can act on')

// The whole ownership shape must survive the new code: role from the database,
// technician read through the CALLER'S client, admin client only after both.
const iRole = routeCode.indexOf("resolveAppRole")
const iTech = routeCode.indexOf(".from('technicians')")
const iAdmin = routeCode.indexOf('createAdminClient()')
check('the role is asked of the database before anything else', iRole > -1 && iRole < iTech)
check('ownership is proved by the caller\'s own RLS-scoped read', iTech > -1 && iTech < iAdmin,
  'RLS returning nothing for a foreign roster IS the ownership proof')
check('the admin client is constructed only after both checks', iAdmin > iTech)
check('the privileged link write is still scoped to the caller\'s tenant',
  /\.eq\('id', tech\.id\)\s*\r?\n?\s*\.eq\('user_id', user\.id\)/.test(routeCode),
  'the admin write must not be able to land on a foreign row')
check('the business name is read with the caller\'s client, not the admin one',
  /supabase\s*\r?\n?\s*\.from\('business_settings'\)/.test(routeCode),
  'reading a tenant row with the service role would skip the proof RLS provides')

// Nothing secret may reach a log. Line-based: this codebase is semicolon-free,
// so an argument-span regex runs to the end of the file and reports everything.
check('no console call names the link or the token', (() => {
  const SECRETS = /\b(setupUrl|hashed|hashed_token|action_link)\b/
  const leaky = route.split(/\r?\n/).filter(l => /console\.(log|info|warn|error)\s*\(/.test(l) && SECRETS.test(l))
  if (leaky.length) console.log(`     leaking: ${leaky.map(l => l.trim()).join(' | ')}`)
  return leaky.length === 0
})())
check('the log scan is not vacuous', (route.match(/console\.(log|info|warn|error)\s*\(/g) ?? []).length >= 1)

// The email itself: it must identify the employer (an unattributed "set up your
// login" is indistinguishable from phishing) and must never carry tenant data.
const mail = crewInviteEmail('https://app.edgehq.ca/crew/welcome/abc', 'Edge Property Services', 'Sam')
check('the subject names the business', mail.subject.includes('Edge Property Services'))
check('the body greets the worker by name', mail.html.includes('Sam') && mail.text.includes('Sam'))
check('both parts carry the link', mail.html.includes('/crew/welcome/abc') && mail.text.includes('/crew/welcome/abc'))
check('it tells an unexpecting recipient to ignore it',
  /ignore it/i.test(mail.text), 'an owner can type any address; the message must read correctly to a stranger')
check('it states the link is single-use and expiring', /once/i.test(mail.text) && /expires/i.test(mail.text))
check('it sets the expectation that money and pricing are not visible',
  /billing|pricing/i.test(mail.text))
const anon = crewInviteEmail('https://app.edgehq.ca/crew/welcome/abc', null, null)
check('with no business name it still reads correctly', anon.subject.length > 0 && !anon.subject.includes('null'))
check('with no worker name it still reads correctly', !anon.text.includes('null'))
// An owner-supplied name lands in an HTML document.
const evil = crewInviteEmail('https://app.edgehq.ca/x', '<script>alert(1)</script>', 'Sam')
check('an owner-supplied business name is HTML-escaped',
  !evil.html.includes('<script>') && evil.html.includes('&lt;script&gt;'))

// The send must be on the audited allowlist — that guard is what stops a new
// sender appearing with no decision recorded about whose behalf it speaks on.
check('the invite route is on verify:capabilities\' SEND_ALLOWLIST',
  read('scripts/verify-capabilities.ts').includes("'src/app/api/crew/invite/route.ts'"),
  'every sendEmail importer must be justified there or the capability guard fails')

// The server-only email builder must never reach a browser bundle.
check('the email builder is not imported by any client component', (() => {
  const offenders: string[] = []
  const walk = (dir: string) => {
    for (const e of readdirSync(dir)) {
      const p = join(dir, e)
      if (statSync(p).isDirectory()) { walk(p); continue }
      if (!/\.(ts|tsx)$/.test(p)) continue
      const t = readFileSync(p, 'utf8')
      if (/^['"]use client['"]/m.test(t) && /crewInviteServer/.test(t)) offenders.push(relative(ROOT, p))
    }
  }
  walk(join(ROOT, 'src'))
  if (offenders.length) console.log(`     client importer(s): ${offenders.join(', ')}`)
  return offenders.length === 0
})())

// ═══════════════════════════════════════════════════════════════════════════
H('4. DISABLED IS NOT "NEVER INVITED"')

// The router has one word for both. Telling a disabled worker to enter a join
// code sends them after a code crew_redeem_invite refuses by design.
eq('a disabled worker is not offered a code', joinScreenFor('disabled'), 'turned-off')
eq('somebody never invited gets the code form', joinScreenFor('none'), 'code-form')
eq('an UNKNOWN answer must not assert "turned off"', joinScreenFor('unknown'), 'code-form')
for (const s of ['signed-out', 'owner', 'active'] as CrewSelfStatus[]) {
  eq(`${s} does not see the turned-off screen`, joinScreenFor(s), 'code-form')
}

const joinPage = read('src/app/crew/join/page.tsx')
const joinCode = strip(joinPage)
check('the join page resolves the status server-side (no wrong-screen flash)',
  /joinScreenFor\(/.test(joinCode) && !/useEffect/.test(joinCode) && !/'use client'/.test(joinCode))
check('the turned-off screen offers NO join-code form',
  (() => {
    const i = joinCode.indexOf('turned-off')
    const j = joinCode.indexOf('Join your crew')
    return i > -1 && j > -1 && i < j   // the disabled branch returns before the form
  })(),
  'a code cannot fix a disabled roster row')
check('the turned-off screen says the record is intact',
  /nothing of yours has been deleted/i.test(joinPage),
  'disabling access must not read as being erased')
check('the turned-off screen offers a way out (sign out)', /CrewSignOut/.test(joinCode))

// ⭐ ONE ENGINE. The decision lives in lib/crewSelfStatus; the page and the API
// route both call it. Two copies of "which kind of no is this" would drift, and
// the guards that forbid a crew screen from touching an owner table (and the
// service role from leaving app/api|lib) are what forced the split — correctly.
const statusLib = strip(read('src/lib/crewSelfStatus.ts'))
const statusRoute = strip(read('src/app/api/crew/access-status/route.ts'))

check('the status engine derives identity from the caller\'s id only',
  /\.eq\('auth_user_id', userId\)/.test(statusLib),
  'the filter must be the verified session\'s uid, never anything sent in')
check('the route passes the VERIFIED session user, not a parameter',
  /auth\.getUser\(\)/.test(statusRoute) && /readCrewSelfStatus\(supabase, user\.id\)/.test(statusRoute))
check('the route accepts NO caller-supplied identifier',
  !/req\.json\(\)/.test(statusRoute) && !/searchParams/.test(statusRoute) && !/params/.test(statusRoute),
  'any parameter here would be a way to ask about somebody else')
check('the page and the route share the one engine',
  /readCrewSelfStatus\(/.test(strip(joinPage)) && /readCrewSelfStatus\(/.test(statusRoute),
  'a second copy of this decision is a second answer waiting to drift')
check('a crew SCREEN never queries the roster itself',
  !/from\('technicians'\)/.test(strip(joinPage)),
  'a crew screen may not touch an owner table — that is the RPC-only boundary')
check('the engine reports a verdict only — no employer, name or wage',
  !/select\('[^']*name/.test(statusLib) && !/employer/.test(statusLib) && !/hourly_wage/.test(statusLib))
check('a failed read is "unknown", never "none"',
  /if \(error\) return 'unknown'/.test(statusLib),
  'folding a failed read into "never invited" asserts something we did not learn')
check('a missing service key is "unknown", never "none"',
  /if \(!admin\) return 'unknown'/.test(statusLib))

// ═══════════════════════════════════════════════════════════════════════════
H('5. LANDING — a worker arrives in worker mode, first time')

eq('a worker lands in the crew app', landingFor('crew'), '/crew')
eq('an owner lands on the dashboard', landingFor('owner'), '/dashboard')
eq('no role lands on the dashboard (a new owner\'s first-run path)', landingFor('none'), '/dashboard')

const login = read('src/app/login/page.tsx')
check('sign-in asks for the role before navigating',
  /resolveAppRole\(/.test(login) && /landingFor\(/.test(login),
  'pushing /dashboard and letting middleware bounce is a flash of the wrong product')
check('sign-in still honours an explicit ?next=', /next \?\? landingFor\(/.test(login))
check('the ?next= open-redirect guard survives',
  /startsWith\('\/'\)/.test(login) && /startsWith\('\/\/'\)/.test(login))

const reset = read('src/components/auth/ResetPasswordForm.tsx')
check('a worker who resets their password lands in the crew app',
  /landingFor\(/.test(reset) && /resolveAppRole\(/.test(reset))
check('recovery grants no role — it only reads one',
  !/business_settings/.test(strip(reset)) && !/crew_redeem_invite/.test(strip(reset)),
  'a password reset must never change what somebody is')

// ═══════════════════════════════════════════════════════════════════════════
H('6. THE ROUTE TABLE — owner and worker halves stay separate')

eq('a worker in the CRM is sent to the crew app', routeFor('crew', '/dashboard', true), '/crew')
eq('a worker deep in the CRM is sent back too', routeFor('crew', '/dashboard/invoices', true), '/crew')
eq('an owner in the crew app is sent to the CRM', routeFor('owner', '/crew', true), '/dashboard')
eq('an unlinked account in the crew app goes to the join screen', routeFor('none', '/crew', true), '/crew/join')
eq('signed out, the crew app requires a login', routeFor('none', '/crew', false), '/login')
eq('signed out, the CRM requires a login', routeFor('none', '/dashboard', false), '/login')
eq('a worker at /login goes to the crew app', routeFor('crew', '/login', true), '/crew')
eq('an owner at /login goes to the CRM', routeFor('owner', '/login', true), '/dashboard')
eq('an account with no role keeps the first-run dashboard path', routeFor('none', '/dashboard', true), null)
// Segment-exactness: a path that merely starts with the same letters is not the tree.
eq('/dashboardfoo is not the CRM tree', routeFor('crew', '/dashboardfoo', true), null)
eq('/crewfoo is not the crew tree', routeFor('owner', '/crewfoo', true), null)

const mw = read('src/lib/supabase/middleware.ts')
check('the role is asked of the database, never of a cookie or a body',
  /resolveAppRole\(supabase\)/.test(mw) && !/request\.cookies\.get\(['"]role/.test(mw))
check('an unavailable auth server is not a sign-out', /'unavailable'/.test(mw) && /return supabaseResponse/.test(mw))
// getUser() rotates an expired token onto the response; NextResponse.redirect()
// builds a new one carrying none of it. Exactly ONE construction is allowed, and
// it must be the helper that copies the cookies across.
check('every redirect preserves the refreshed session', (() => {
  const code = strip(mw)
  const constructions = code.match(/NextResponse\.redirect\(/g) ?? []
  const helper = /export function redirectPreservingSession[\s\S]*?NextResponse\.redirect\(/.test(code)
  const used = /redirectPreservingSession\(/.test(code.split('export async function updateSession')[1] ?? '')
  return constructions.length === 1 && helper && used
})(), 'a bare redirect drops the rotated token and strands the session')

// ═══════════════════════════════════════════════════════════════════════════
H('7. THE ACCESS STATE MACHINE — disabled outranks everything')

const S = (o: Partial<Parameters<typeof crewAccessState>[0]>) =>
  crewAccessState({ isActive: true, linked: false, ...o })
eq('inactive outranks a working login', S({ isActive: false, linked: true, lastSignInAt: '2026-08-01T00:00:00Z' }), 'disabled')
eq('inactive outranks an outstanding invite', S({ isActive: false, inviteSentAt: '2026-08-01T00:00:00Z' }), 'disabled')
eq('linked and arrived → active', S({ linked: true, lastSignInAt: '2026-08-01T00:00:00Z' }), 'active')
eq('linked but never arrived → invite pending', S({ linked: true }), 'invited')
eq('a live join code → invite pending', S({ hasCode: true }), 'invited')
eq('nothing outstanding → no access', S({}), 'none')

// The owner's control surface must not offer actions that cannot take effect.
const control = read('src/components/dispatch/CrewAccessControl.tsx')
check('resend uses the LINKED account\'s address, not the roster free-text',
  /invite\(access\?\.email/.test(control),
  'technicians.email may be blank (bad-email) or edited (already-linked)')
check('the UI reports the real send result',
  /data\.emailed/.test(control) && !/emailed:\s*true/.test(control))
check('revoking clears the shown link and the sent state',
  /setSetupUrl\(null\);\s*setSentTo\(null\)/.test(control),
  'a revoked invite must not leave a working-looking link on screen')

// ═══════════════════════════════════════════════════════════════════════════
console.log(`\n${failures === 0 ? '✅' : '❌'} verify:crew-auth — ${failures === 0 ? 'a worker gets in, where they belong, while allowed' : `${failures} failure(s)`}\n`)
process.exit(failures === 0 ? 0 : 1)
