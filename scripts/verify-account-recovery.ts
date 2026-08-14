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
  readRecoveryFragment, buildResetUrl, acceptedMessage, UNAVAILABLE_MESSAGE,
  MIN_PASSWORD, RESET_SIGNOUT_SCOPE, RESET_PATH, FORGOT_PATH, RESET_TOKEN_PARAMS,
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

const LIB = 'src/lib/passwordRecovery.ts'
const FORGOT_FORM = 'src/components/auth/ForgotPasswordForm.tsx'
const RESET_FORM = 'src/components/auth/ResetPasswordForm.tsx'
const RESET_PAGE = 'src/app/reset-password/page.tsx'
const FORGOT_PAGE = 'src/app/forgot-password/page.tsx'
const LOGIN_PAGE = 'src/app/login/page.tsx'

// ── 1. Asking for a link: what each server answer becomes ────────────────────
console.log('\n═══ Asking for a reset link ═══')

eq('no error → accepted', classifyRecoverySend(null), { kind: 'accepted' })
eq('200 with no error → accepted', classifyRecoverySend(undefined), { kind: 'accepted' })
eq('429 rate limit → accepted (the neutral answer)',
  classifyRecoverySend({ status: 429, code: 'over_email_send_rate_limit' }), { kind: 'accepted' })
eq('400 invalid address → accepted (the neutral answer)',
  classifyRecoverySend({ status: 400, code: 'email_address_invalid' }), { kind: 'accepted' })
eq('422 → accepted', classifyRecoverySend({ status: 422 }), { kind: 'accepted' })

eq('500 mailer failure → unavailable, NOT accepted',
  classifyRecoverySend({ status: 500, code: 'error_sending_recovery_email' }), { kind: 'unavailable' })
eq('502 → unavailable', classifyRecoverySend({ status: 502 }), { kind: 'unavailable' })
eq('a fetch that never landed → unavailable',
  classifyRecoverySend({ name: 'AuthRetryableFetchError', message: 'Failed to fetch' }), { kind: 'unavailable' })
eq('status 0 → unavailable', classifyRecoverySend({ status: 0 }), { kind: 'unavailable' })
eq('an unrecognised error defaults to unavailable, never to accepted',
  classifyRecoverySend({ message: 'something new' }), { kind: 'unavailable' })

// ── 2. The visible response cannot tell the two apart ────────────────────────
// Measured against this project on 2026-08-13: POST /recover answers 200 for an
// address with no account, 429 for one that has an account and asked twice
// inside a minute, and 400 for an existing account whose address the mailer
// rejects. That oracle is Supabase's, reachable with the public anon key, and no
// page of ours can close it. What this asserts is the half we own: that all
// three collapse to one indistinguishable outcome before anything is rendered.
console.log('\n═══ The screen does not say which addresses have accounts ═══')

const existingAccountAnswers = [
  classifyRecoverySend(null),                                                   // sent
  classifyRecoverySend({ status: 429, code: 'over_email_send_rate_limit' }),    // already sent
  classifyRecoverySend({ status: 400, code: 'email_address_invalid' }),         // will not send
]
const noAccountAnswer = classifyRecoverySend(null)
check('every answer an existing account can produce is the same one',
  new Set(existingAccountAnswers.map(a => a.kind)).size === 1)
eq('and it is the same answer an address with no account produces',
  existingAccountAnswers[0], noAccountAnswer)

const forgot = read(FORGOT_FORM)
check('the request form renders exactly one accepted message',
  (forgot.match(/acceptedMessage\(/g) || []).length === 1)
check('it never branches on a status code',
  !/\.status\s*===\s*4\d\d|error\.status|status\s*===\s*429/.test(forgot),
  'reading the status in the component is how the oracle comes back')
check('it never repeats a Supabase error message to an anonymous visitor',
  !/error\.message|error\?\.message/.test(forgot),
  'Supabase\'s own wording names the reason, and the reason is the leak')
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
eq('the link is built on the reset path',
  buildResetUrl('https://app.example.com/', 'HASH'), `https://app.example.com${RESET_PATH}?token=HASH`)
check('the token is url-encoded into the link',
  buildResetUrl('https://a.co', 'a+b/c=').includes('a%2Bb%2Fc%3D'))

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
check('no file declares a second minimum',
  !/const MIN_PASSWORD\s*=/.test(read('src/components/crew/CrewWelcomeForm.tsx')))

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

// ── 8. Nothing privileged is in reach of these pages ─────────────────────────
console.log('\n═══ No credential, no admin client ═══')
for (const f of [FORGOT_FORM, RESET_FORM, LIB, RESET_PAGE, FORGOT_PAGE]) {
  const src = read(f)
  check(`${f.split('/').pop()} holds no service role`,
    !/SERVICE_ROLE|createAdminClient|service_role/.test(src))
}
check('the flow adds no server route', !existsSync(join(ROOT, 'src/app/api/auth')),
  'nothing here needs a server: Supabase owns the token and the anon key is the right credential')
check('no migration ships with this feature',
  !/RUN-\d{4}-\d{2}-\d{2}-.*recovery/i.test(read('package.json')),
  'RLS and tenant membership are untouched because no SQL runs at all')

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
    ['another 56-character guess', 'f'.repeat(56)],
  ]
  const seen: string[] = []
  for (const [label, tok] of cases) {
    const r = await verify(tok)
    check(`${label} is refused`, r.status === 403 || r.status === 400, `got ${r.status}`)
    check(`${label} issues no session`, !r.body.access_token && !r.body.user,
      'a refusal that hands back a session is not a refusal')
    seen.push(`${r.status}:${r.code}`)
  }
  check('every refusal is the same refusal', new Set(seen).size === 1,
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
