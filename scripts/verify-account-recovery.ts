// ── Verify: a locked-out owner can get back in, and nobody else can ──────────
//   npm run verify:account-recovery
//
// WHY THIS SCRIPT EXISTS
// Password recovery is the one feature whose whole job is to hand out access to
// an account to somebody who cannot currently prove they own it. Everything that
// makes it usable also makes it dangerous, and none of the four ways it goes
// wrong are visible to tsc or `next build`:
//
//   • the screen starts DISTINGUISHING server answers, and "we sent it" vs
//     "slow down" becomes a free directory of which addresses are EdgeQuote
//     owners (Supabase's own endpoint already leaks this — see §2; the one thing
//     we control is not building a second oracle in our own UI);
//   • a failed request gets folded into a success, and somebody waits for an
//     email that the server already knows it did not send;
//   • an unreachable server gets folded into "this link is dead", and a
//     legitimate owner on a flaky connection is told their good link is broken —
//     the exact failure already fixed for the crew day read and the portal;
//   • a sign-out loses its explicit scope and becomes GLOBAL, which is the bug
//     that revoked this owner's real sessions 214 times in a day.
//
// So the contract is asserted as behaviour, the copy is asserted for what it may
// not say, and the token half is asserted against the REAL Supabase endpoint —
// with tokens that were never issued, so it sends no mail and needs no secret.

import {
  classifyRecoverySend, classifyResetToken, passwordProblem, readResetToken,
  readResetPathToken, readRecoveryFragment, buildResetUrl, acceptedMessage,
  UNAVAILABLE_MESSAGE, THROTTLED_MESSAGE, MIN_PASSWORD, RESET_SIGNOUT_SCOPE,
  RESET_PATH, FORGOT_PATH, RESET_TOKEN_PARAMS, RESET_REQUEST_ENDPOINT,
} from '../src/lib/passwordRecovery'
import { routeFor } from '../src/lib/crewAccess'
import { readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'

// Same idiom as the other network-touching guards: read .env.local if it is
// here, and stay green on a machine that has none.
for (const line of existsSync('.env.local') ? readFileSync('.env.local', 'utf8').split(/\r?\n/) : []) {
  const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/)
  if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].trim().replace(/^(['"])(.*)\1$/, '$2')
}

let failures = 0
const ok = (n: string) => console.log(`  ✓ ${n}`)
const fail = (n: string, d: string) => { failures++; console.log(`  ✗ ${n}\n      ${d}`) }
const check = (n: string, cond: boolean, d = '') => cond ? ok(n) : fail(n, d)
const eq = (n: string, a: unknown, b: unknown) =>
  check(n, JSON.stringify(a) === JSON.stringify(b), `expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`)

const ROOT = process.cwd()
const read = (p: string) => readFileSync(join(ROOT, p), 'utf8')

// ⚠️ Assert over CODE, not over prose. Every one of these files documents the
// very thing it must not do ("NO user_id, NO token", "nothing from generateLink
// reaches the browser"), so a naive grep reports the cure as the disease — four
// of these checks failed that way before this existed. `[^\n]` keeps the line
// comment stripper CRLF-safe: `.` does not match `\r`.
const stripComments = (s: string) =>
  s.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/--[^\n]*/g, ' ').replace(/\/\/[^\n]*/g, ' ')
/** Comments AND string literals gone — what is left is only identifiers and
 *  syntax, so "email provider not configured" cannot look like logging `email`. */
const codeOnly = (s: string) =>
  stripComments(s).replace(/'(?:[^'\\]|\\.)*'/g, "''").replace(/"(?:[^"\\]|\\.)*"/g, '""')
    .replace(/`(?:[^`\\]|\\.)*`/g, '``')

const LIB = 'src/lib/passwordRecovery.ts'
const SERVER_LIB = 'src/lib/passwordRecoveryServer.ts'
const ROUTE = 'src/app/api/public/password-reset/route.ts'
const MIGRATION = 'supabase/RUN-2026-08-14-password-reset-requests.sql'
const FORGOT_FORM = 'src/components/auth/ForgotPasswordForm.tsx'
const RESET_FORM = 'src/components/auth/ResetPasswordForm.tsx'
const RESET_PAGE = 'src/app/reset-password/[[...link]]/page.tsx'
const FORGOT_PAGE = 'src/app/forgot-password/page.tsx'
const LOGIN_PAGE = 'src/app/login/page.tsx'

// ── 1. Asking for a link: what each server answer becomes ────────────────────
console.log('\n═══ Asking for a reset link ═══')

// Over OUR route's status now, not Supabase's error. Every status the route can
// return is decided BEFORE any account lookup, so each is safe to report.
eq('200 → accepted', classifyRecoverySend(200), { kind: 'accepted' })
eq('429 → throttled (the limiter counts attempts, not matches)',
  classifyRecoverySend(429), { kind: 'throttled' })
eq('400 → unavailable', classifyRecoverySend(400), { kind: 'unavailable' })
eq('503 no provider / no service role → unavailable, NOT accepted',
  classifyRecoverySend(503), { kind: 'unavailable' })
eq('500 → unavailable', classifyRecoverySend(500), { kind: 'unavailable' })
eq('a fetch that never landed → unavailable', classifyRecoverySend(null), { kind: 'unavailable' })
eq('an undefined status defaults to unavailable, never to accepted',
  classifyRecoverySend(undefined), { kind: 'unavailable' })
eq('a status nobody planned for is unavailable, never accepted',
  classifyRecoverySend(418), { kind: 'unavailable' })
check('only 200 is ever accepted',
  ![0, 201, 204, 301, 400, 401, 403, 404, 429, 500, 502, 503]
    .some(s => classifyRecoverySend(s).kind === 'accepted'),
  'anything but a real 200 claiming success is a link somebody waits for forever')

// ── 2. The visible response cannot tell the two apart ────────────────────────
// Measured against this project on 2026-08-13: POST /recover answers 200 for an
// address with no account, 429 for one that has an account and asked twice
// inside a minute, and 400 for an existing account whose address the mailer
// rejects. That oracle is Supabase's, reachable with the public anon key, and no
// page of ours can close it. What this asserts is the half we own: that all
// three collapse to one indistinguishable outcome before anything is rendered.
console.log('\n═══ The screen does not say which addresses have accounts ═══')

// The route answers 200 whether it matched an account, matched nothing, or
// matched and failed to send. Those three are the only branches that depend on
// the address, and they are the same branch.
const route = read(ROUTE)
{
  const code = route.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '')
  const returns = code.split('\n').filter(l => /return (ok\(\)|NextResponse\.json|unavailable\(\))/.test(l))
  check(`every account-dependent branch returns the same ok() (${returns.length} returns total)`,
    (code.match(/return ok\(\)/g) || []).length >= 2,
    'no-match and matched-and-sent must be the same answer, written the same way')
  check('there is exactly one success shape',
    (code.match(/const ok = \(\) =>/g) || []).length === 1
    && !/NextResponse\.json\(\{ ok: true/.test(code.replace(/const ok = \(\) => NextResponse\.json\([^\n]*/, '')),
    'two success bodies is two answers, and the difference is the oracle')
  check('the 400 is decided before any lookup',
    code.indexOf('status: 400') < code.indexOf('generateLink'),
    'a status that depends on the address is an oracle')
  check('the 429 is decided before any lookup',
    code.indexOf('status: 429') < code.indexOf('generateLink'))
  check('the 503 is decided before any lookup',
    code.indexOf('unavailable()') < code.indexOf('generateLink'))
  check('generateLink failure falls through to the neutral answer',
    /if \(linkErr \|\| !hashed\)[\s\S]{0,420}return ok\(\)/.test(code),
    'a missing account must not change the response, the status or the shape')
}

const forgot = read(FORGOT_FORM)
check('the request form renders exactly one accepted message',
  (forgot.match(/acceptedMessage\(/g) || []).length === 1)
check('it never reads a response body',
  !/\.json\(\)|res\.json|await r\.json/.test(forgot),
  'the body is one constant sentence; parsing it invites branching on it')
check('it never repeats a server error message to an anonymous visitor',
  !/error\.message|error\?\.message|data\.error/.test(forgot),
  'the server\'s own wording names the reason, and the reason is the leak')
check('the accepted copy is conditional, not a claim of delivery',
  /^If /.test(acceptedMessage('x@y.co')) && !/\b(sent|delivered)\b/i.test(acceptedMessage('x@y.co')),
  `got: ${acceptedMessage('x@y.co')}`)
check('the accepted copy echoes the address, so a typo is visible',
  acceptedMessage('typo@exmaple.com').includes('typo@exmaple.com'))
check('the honest failure says nothing was sent',
  /nothing has gone out|nothing was sent/i.test(UNAVAILABLE_MESSAGE), UNAVAILABLE_MESSAGE)
check('and it names no account',
  !/account|address|email/i.test(UNAVAILABLE_MESSAGE.replace(/reset link/gi, '')), UNAVAILABLE_MESSAGE)

// ── 3. Holding a link: three outcomes, never two ─────────────────────────────
console.log('\n═══ Redeeming a reset link ═══')

eq('a good token with a user → ready', classifyResetToken(null, true), { kind: 'ready', email: null })
eq('expired → dead', classifyResetToken({ status: 403, code: 'otp_expired' }, false), { kind: 'dead' })
eq('already used → dead (Supabase answers 403 otp_expired for this too)',
  classifyResetToken({ status: 403, code: 'otp_expired' }, false), { kind: 'dead' })
eq('malformed → dead', classifyResetToken({ status: 400, code: 'validation_failed' }, false), { kind: 'dead' })
eq('no error but no user → dead', classifyResetToken(null, false), { kind: 'dead' })

eq('a 5xx is NOT a dead link', classifyResetToken({ status: 503 }, false), { kind: 'unavailable' })
eq('a fetch that never landed is NOT a dead link',
  classifyResetToken({ name: 'AuthRetryableFetchError' }, false), { kind: 'unavailable' })
check('unavailable and dead are different outcomes',
  classifyResetToken({ status: 503 }, false).kind !== classifyResetToken({ status: 403 }, false).kind,
  'folding them tells an owner on a flaky connection that their good link is broken')

const reset = read(RESET_FORM)
check('the reset page distinguishes all three outcomes on screen',
  /'unavailable'/.test(reset) && /'dead'/.test(reset) && /'ready'/.test(reset))
check('the unavailable state does not claim the link expired',
  !/unavailable[\s\S]{0,600}(expired|invalid)/i.test(reset.split("outcome.kind === 'dead'")[0] ?? ''))
check('a pre-existing session is not accepted as proof',
  /readRecoveryFragment/.test(reset) && !/getSession\(\)/.test(reset),
  'this is the recovery door — being signed in already proves nothing about reading the email')
check('the token is spent once per mount',
  /spent\.current/.test(reset), 'React 18 runs effects twice in dev and would burn a live token')
check('the effect is keyed on the token STRING, not the searchParams object',
  /\}, \[token\]\)/.test(reset),
  'a new object every render re-runs the effect forever — the global-search failure')

// ── 3b. The other link shape ─────────────────────────────────────────────────
// Supabase's stock template puts the session in the URL fragment, and
// @supabase/ssr hard-codes flowType "pkce", which ignores it — measured: the
// hash was still in location.hash and no session had been stored. On the free
// tier the stock template is the ONLY one this project can send, so the
// fragment is not a fallback, it is the live path.
console.log('\n═══ The fragment link the stock email sends ═══')

eq('a recovery fragment yields a session',
  readRecoveryFragment('#access_token=AAA&refresh_token=RRR&expires_in=3600&token_type=bearer&type=recovery'),
  { kind: 'session', accessToken: 'AAA', refreshToken: 'RRR' })
eq('Supabase reporting a dead link in the fragment → error',
  readRecoveryFragment('#error=access_denied&error_code=otp_expired&error_description=Email+link+is+invalid'),
  { kind: 'error' })
eq('a magic-link fragment is NOT a password-change permit',
  readRecoveryFragment('#access_token=AAA&refresh_token=RRR&type=magiclink'), { kind: 'none' })
eq('a fragment with no type is refused',
  readRecoveryFragment('#access_token=AAA&refresh_token=RRR'), { kind: 'none' })
eq('a recovery fragment missing the refresh token is refused',
  readRecoveryFragment('#access_token=AAA&type=recovery'), { kind: 'none' })
eq('an empty hash is nothing', readRecoveryFragment(''), { kind: 'none' })
eq('a bare hash is nothing', readRecoveryFragment('#'), { kind: 'none' })

check('the reset page installs the fragment session explicitly',
  /setSession\(\{\s*access_token:/.test(reset),
  'supabase-js will not do it — flowType is pinned to pkce by @supabase/ssr')
check('the credential is stripped from the address bar',
  /history\.replaceState/.test(reset),
  'an access token left in location.hash rides into history and referrers')
check('stripping happens for the error fragment too',
  /if \(frag\.kind !== 'none'\)[\s\S]{0,160}replaceState/.test(reset))

// ── 4. The token belongs to Supabase ─────────────────────────────────────────
console.log('\n═══ No second token system ═══')
const lib = read(LIB)
check('nothing here mints, stores or hashes a token',
  !/crypto|randomUUID|createHash|jwt|sign\(/i.test(lib),
  'Supabase already owns the token, its expiry and its single use')
check('the reset page redeems through verifyOtp',
  /verifyOtp\(\{\s*token_hash/.test(reset))
check('it asks for type recovery', /type:\s*'recovery'/.test(reset))
check('both token spellings are accepted', RESET_TOKEN_PARAMS.length === 2)
eq('?token= is read', readResetToken(k => (k === 'token' ? 'abc' : null)), 'abc')
eq('?token_hash= is read', readResetToken(k => (k === 'token_hash' ? 'abc' : null)), 'abc')
eq('a blank token is no token', readResetToken(() => '   '), null)
eq('a missing token is no token', readResetToken(() => null), null)
eq('the link is path segments, not a query',
  buildResetUrl('https://app.example.com/', 'HASH'), `https://app.example.com${RESET_PATH}/HASH`)
check('the token is url-encoded into the path',
  buildResetUrl('https://a.co', 'a+b/c=').includes('a%2Bb%2Fc%3D'))
// The transport-safety property itself, the same one beta signup pinned after a
// query-form link measurably lost bytes on the way to a real inbox: `=73` is a
// valid quoted-printable escape, so an emailed URL must contain no '=' and no
// '?' for a QP decoder to have anything to misread.
{
  const real = buildResetUrl('https://app.example.com', '733853eddf4416c6b263419cb107b7a459fabd0b9e667bb319e0e547')
  check('emailed URL carries no "=" or "?" (quoted-printable cannot mangle it)',
    !real.includes('=') && !real.includes('?'), real)
}
eq('one path segment is the token', readResetPathToken(['abc']), 'abc')
eq('no segments is no token', readResetPathToken([]), null)
eq('undefined segments is no token', readResetPathToken(undefined), null)
eq('a deeper path is not a link we built', readResetPathToken(['a', 'b']), null)
eq('a blank segment is no token', readResetPathToken(['  ']), null)
check('the reset page prefers the path segment over the query',
  reset.indexOf('readResetPathToken') < reset.indexOf('readResetToken('),
  'the path form is the one we email and the one that survives transport')

// ── 5. The password rule exists once ─────────────────────────────────────────
console.log('\n═══ One password rule ═══')
eq('too short is refused', passwordProblem('short', 'short'), `Use at least ${MIN_PASSWORD} characters.`)
eq('a mismatch is refused', passwordProblem('a'.repeat(MIN_PASSWORD), 'b'.repeat(MIN_PASSWORD)), 'Those two don’t match.')
eq('a long matching pair passes', passwordProblem('a'.repeat(MIN_PASSWORD), 'a'.repeat(MIN_PASSWORD)), null)
check('the minimum is stated to the person typing',
  reset.includes('MIN_PASSWORD') && /At least \$\{MIN_PASSWORD\}/.test(reset))
check('the crew welcome form reads the same rule',
  /from '@\/lib\/passwordRecovery'/.test(read('src/components/crew/CrewWelcomeForm.tsx')),
  'two minimums in two files is how a policy becomes a suggestion')

// EVERY password door, not only the ones this session wrote. Beta signup landed
// its own `const MIN_PASSWORD = 8` hours after this feature, described as the
// Supabase default — which was 6, and is now 10. That screen would have accepted
// 9 characters and then been refused by the server, having said 9 was fine. The
// scan covers the whole set so the next door to appear cannot repeat it.
{
  const PASSWORD_DOORS = [
    'src/components/crew/CrewWelcomeForm.tsx',
    'src/components/auth/ResetPasswordForm.tsx',
    'src/lib/betaInvite.ts',
    'src/app/signup/page.tsx',
    'src/app/api/beta/signup/route.ts',
  ].filter(f => existsSync(join(ROOT, f)))
  const declarers = PASSWORD_DOORS.filter(f => /(const|let)\s+MIN_PASSWORD\s*=\s*\d/.test(read(f)))
  check(`no other file declares its own minimum (${PASSWORD_DOORS.length} door(s) checked)`,
    declarers.length === 0,
    `a second number lives in: ${declarers.join(', ')} — re-export from lib/passwordRecovery instead`)
  check('lib/passwordRecovery holds the only declaration',
    /export const MIN_PASSWORD\s*=\s*\d+/.test(lib))
}

// ── 6. Session 34 is not regressed ───────────────────────────────────────────
// supabase-js defaults signOut() to scope 'global'. A bare call anywhere in this
// feature would end the session the owner just recovered — and, in a script,
// would revoke their real sessions on every device they own.
console.log('\n═══ Every sign-out names its scope ═══')
for (const f of [FORGOT_FORM, RESET_FORM, LIB]) {
  const src = read(f)
  const bare = /auth\.signOut\(\s*\)/.test(src)
  check(`${f.split('/').pop()} has no bare signOut()`, !bare,
    'a bare signOut() is GLOBAL — name the scope or do not call it')
}
eq('the reset revokes OTHERS, not everything', RESET_SIGNOUT_SCOPE, 'others')
check('the reset page passes that scope explicitly',
  /signOut\(\{\s*scope:\s*RESET_SIGNOUT_SCOPE\s*\}\)/.test(reset))
check('a failed sign-out does not report a failed reset',
  /signOut\([\s\S]{0,80}\)\.catch\(/.test(reset),
  'the password already changed — sending the owner round again would be worse than useless')
check('the screen says the other devices will be signed out',
  /signs you out everywhere else/i.test(reset),
  'a session-ending side effect the owner was not told about is a surprise, not a feature')

// ── 7. The doors are reachable by the people who need them ───────────────────
// Neither page sits under a gated prefix, so the middleware never resolves a
// role for them. That is the property — a signed-OUT visitor is exactly who
// these pages are for, and a gate would lock them out of the unlock.
console.log('\n═══ Both doors are open when signed out ═══')
for (const p of [FORGOT_PATH, RESET_PATH]) {
  eq(`${p} is reachable signed out`, routeFor('none', p, false), null)
  eq(`${p} is reachable mid-recovery (a session now exists)`, routeFor('none', p, true), null)
  eq(`${p} does not bounce an owner`, routeFor('owner', p, true), null)
  eq(`${p} does not bounce a crew member`, routeFor('crew', p, true), null)
}
check('neither path sits under /dashboard or /crew',
  !FORGOT_PATH.startsWith('/dashboard') && !FORGOT_PATH.startsWith('/crew')
  && !RESET_PATH.startsWith('/dashboard') && !RESET_PATH.startsWith('/crew'))
check('the pages exist where the paths say they do',
  existsSync(join(ROOT, FORGOT_PAGE)) && existsSync(join(ROOT, RESET_PAGE)))
check('login offers the way in',
  read(LOGIN_PAGE).includes('FORGOT_PATH') && /Forgot your password/i.test(read(LOGIN_PAGE)),
  'a recovery flow nobody can find is not a recovery flow')
check('the reset page is not indexable',
  /robots:\s*\{\s*index:\s*false/.test(read(RESET_PAGE)),
  'the URL carries a live credential')

// ── 8. The service role stays on the server ──────────────────────────────────
console.log('\n═══ No credential reaches the browser ═══')
for (const f of [FORGOT_FORM, RESET_FORM, LIB, RESET_PAGE, FORGOT_PAGE]) {
  const src = read(f)
  check(`${f.split('/').pop()} holds no service role`,
    !/SERVICE_ROLE|serviceClient|service_role|generateLink/.test(src))
  check(`${f.split('/').pop()} does not import the server-only module`,
    !/passwordRecoveryServer/.test(src),
    'it would drag the email builder — and the limiter\'s numbers — into a client bundle')
}
check('the client contract imports nothing server-only',
  !/passwordRecoveryServer|node:crypto|from 'crypto'/.test(read(LIB)),
  'lib/passwordRecovery is imported by client components')
check('the server module is never marked use client',
  !/^\s*['"]use client['"]/.test(read(SERVER_LIB)),
  'it names the directive in its own header — the check is the first line, not any mention')
{
  // The whole client tree, not just this feature's files — the leak that matters
  // is the one that appears somewhere nobody thought to look.
  const walk = (dir: string): string[] => require('node:fs')
    .readdirSync(dir, { withFileTypes: true })
    .flatMap((e: { name: string; isDirectory(): boolean }) => e.isDirectory()
      ? walk(join(dir, e.name))
      : (/\.tsx?$/.test(e.name) ? [join(dir, e.name)] : []))
  const clientFiles = walk(join(ROOT, 'src')).filter((f: string) => {
    const s = readFileSync(f, 'utf8')
    return s.startsWith("'use client'") || s.startsWith('"use client"')
  })
  const leaks = clientFiles.filter((f: string) => /passwordRecoveryServer/.test(readFileSync(f, 'utf8')))
  check(`no 'use client' file imports passwordRecoveryServer (${clientFiles.length} scanned)`,
    leaks.length === 0, leaks.join(', '))
}
check('the route pins the nodejs runtime',
  /export const runtime = 'nodejs'/.test(route),
  'the service role must never run at the edge')
check('the route sends through the shared sendEmail, not its own mailer',
  /from '@\/lib\/comms\/send'/.test(route) && !/api\.resend\.com/.test(route),
  'one place talks to Resend; this builds a message and hands it over')
check('the emailed link is the only place the token goes',
  !/hashed[\s\S]{0,200}NextResponse\.json/.test(route.replace(/\/\/[^\n]*/g, '')),
  'a token in the response body is the whole feature, handed to whoever asked')

// ── 8b. The abuse ledger ─────────────────────────────────────────────────────
console.log('\n═══ The limiter counts attempts, not matches ═══')
{
  const sql = read(MIGRATION)
  const sqlCode = stripComments(sql)
  check('RLS is on', /alter table public\.password_reset_requests enable row level security/.test(sqlCode))
  check('ZERO policies (the deny is structural)',
    !/create policy[^\n]*password_reset_requests/.test(sqlCode))
  check('grants revoked by role name as well',
    /revoke all on table public\.password_reset_requests from anon, authenticated/.test(sqlCode),
    'RLS with no policies already denies, but a future policy would make the default grants live')
  check('the address is never stored, only a hash',
    !/\bemail\s+text/.test(sqlCode) && /email_key/.test(sqlCode),
    'an abuse ledger holding plaintext is a harvestable list of everyone who ever typed into the form')
  check('the columns are exactly id, email_key, created_at, matched, sent',
    !/\b(user_id|token|token_hash|ip_address|ip)\b/.test(sqlCode.slice(
      sqlCode.indexOf('create table'), sqlCode.indexOf(');', sqlCode.indexOf('create table')))),
    'this row must never become a second place the link — or the person — exists')
  check('both count windows are indexed',
    /password_reset_requests_key_time_idx/.test(sqlCode) && /password_reset_requests_time_idx/.test(sqlCode))

  const routeCode = stripComments(route)
  check('the route hashes the address for the bucket',
    /createHash\('sha256'\)\.update\(email\)/.test(routeCode))
  check('the attempt is recorded BEFORE the lookup',
    routeCode.indexOf("from('password_reset_requests').insert") < routeCode.indexOf('generateLink'),
    'a sweep that crashes us mid-lookup must still have spent its slot')
  check('both a per-address and a global window are counted',
    /\.eq\('email_key', emailKey\)/.test(routeCode) && /PER_EMAIL_HOURLY/.test(routeCode) && /GLOBAL_HOURLY/.test(routeCode))
  check('the ledger records the truth about the send',
    /matched: true, sent: res\.sent/.test(routeCode),
    'the reply stays neutral, but a failed send must not be recorded as a success')
  check('nothing identifying is logged',
    !/console\.(error|log|warn)\([^)]*\b(email|hashed|resetUrl|attemptId)\b/.test(codeOnly(route)),
    'a reason and a counter, never the address and never the link')
}

// ── 9. Against the real endpoint ─────────────────────────────────────────────
// Tokens that were never issued: this sends no mail, spends no rate limit, and
// needs no secret. It is the half that would catch Supabase changing its
// contract under us — the reason `dead` may collapse expired/used/malformed is
// that Supabase itself refuses to tell them apart, and if that ever stops being
// true this is where we find out.
console.log('\n═══ Supabase refuses invented tokens, identically ═══')

const SB_URL = process.env.NEXT_PUBLIC_SUPABASE_URL
const SB_KEY = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY

async function liveRefusals() {
  if (!SB_URL || !SB_KEY) {
    console.log('  … skipped — NEXT_PUBLIC_SUPABASE_URL / _ANON_KEY not in the environment')
    return
  }
  const verify = async (token_hash: string) => {
    const res = await fetch(`${SB_URL}/auth/v1/verify`, {
      method: 'POST',
      headers: { apikey: SB_KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'recovery', token_hash }),
    })
    const body = await res.json().catch(() => ({} as Record<string, unknown>))
    return { status: res.status, code: String(body.error_code ?? body.code ?? ''), body }
  }

  const cases: [string, string][] = [
    ['a malformed token', 'not-a-real-token'],
    ['a well-formed hash that was never issued', '0'.repeat(56)],
  ]
  const seen: string[] = []
  for (const [label, tok] of cases) {
    const r = await verify(tok)
    // ⚠️ /verify is capped at 30 requests an hour for the whole project. Running
    // this guard in a mutation-testing loop exhausts that, and a rate-limited
    // answer is evidence of NOTHING about Supabase's refusal contract. Reporting
    // it as a failure would make the guard fail for having been run — the same
    // class of flake as asserting over transient production data.
    if (r.status === 429) {
      console.log(`  … live checks skipped — the project's /verify rate limit (30/hour) is spent`)
      return
    }
    check(`${label} is refused`, r.status === 403 || r.status === 400, `got ${r.status}`)
    check(`${label} issues no session`, !r.body.access_token && !r.body.user,
      'a refusal that hands back a session is not a refusal')
    seen.push(`${r.status}:${r.code}`)
  }
  check('both refusals are the same refusal', new Set(seen).size === 1,
    `distinguishable answers would say which guesses were close: ${seen.join(' | ')}`)
  check('and it is Supabase\'s own combined invalid-or-expired answer',
    seen[0] === '403:otp_expired', `got ${seen[0]}`)

  // The classifier must agree with what the live endpoint actually returns.
  eq('classifyResetToken calls that refusal dead',
    classifyResetToken({ status: 403, code: 'otp_expired' }, false), { kind: 'dead' })
}

liveRefusals()
  .catch(e => { failures++; console.log(`  ✗ live checks threw\n      ${e instanceof Error ? e.message : String(e)}`) })
  .then(() => {
    console.log('\n── Summary ────────────────────────────────────────────────────')
    if (failures) {
      console.log(`\n❌ verify:account-recovery — ${failures} failure${failures === 1 ? '' : 's'}\n`)
      process.exit(1)
    }
    console.log('\n✅ verify:account-recovery — one way back in, and it says nothing it does not know\n')
  })
