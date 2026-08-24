// ── verify:google-auth ───────────────────────────────────────────────────────
// "Continue with Google" — and the line this feature must never cross.
//
// THE ONE IDEA THIS GUARD DEFENDS. Signing in with Google proves that somebody
// controls a mailbox. It proves nothing else. It does not make them an EdgeHQ
// owner, it does not grant beta access, it does not create a business, it does
// not make them anybody's employee, and it does not hand them a capability.
// Every one of those remains a DATABASE decision about auth.uid():
//
//   business  → business_settings INSERT policy carries can_provision_business()
//   crew      → technicians.auth_user_id, written only by crew_redeem_invite()
//               or the owner's own invite route
//
// So most of what follows is not "does the Google button work". It is "is the
// authorization boundary still exactly where it was before the Google button
// existed" — because the way this feature fails is not a broken login, it is a
// working login that quietly grants more than it should.
//
// ⚠️ ASSERTED AGAINST THE APPLY PATH. The SQL half reads
// supabase/migrations/*_baseline.sql — what actually reaches the database —
// NOT supabase/archive/, which is never applied. A guard that pins a file no
// deploy ever runs is a guard that proves nothing, and this repo already
// carries several of those.

import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import {
  safeReturnPath, googleEmailVerified, classifyProviderError, readGoogleAuthError,
  buildCallbackUrl, GOOGLE_SCOPES, GOOGLE_PROVIDER, GOOGLE_AUTH_ERROR_TEXT,
  AUTH_CALLBACK_PATH, OAUTH_START_PATH, OAUTH_INVITE_COOKIE, OAUTH_INVITE_TTL_SECONDS,
  AUTH_ERROR_PARAM,
} from '../src/lib/googleAuth'
import { hashInviteToken } from '../src/lib/googleAuthServer'
import { hashBetaToken } from '../src/lib/betaInviteServer'
import { normalizeInviteEmail } from '../src/lib/crewInvite'
import { routeFor, landingFor } from '../src/lib/crewAccess'

let failures = 0
const ok = (name: string) => console.log(`  ✓ ${name}`)
const fail = (name: string, detail = '') => { failures++; console.log(`  ✗ ${name}${detail ? `\n      ${detail}` : ''}`) }
const check = (name: string, cond: boolean, detail = '') => { cond ? ok(name) : fail(name, detail) }
const H = (t: string) => console.log(`\n═══ ${t} ═══`)

const ROOT = join(__dirname, '..')
const read = (p: string) => readFileSync(join(ROOT, p), 'utf8')

// Strip PROSE before asserting on code. This file's subjects are heavily
// commented, and every forbidden term below appears in their comments
// explaining why it is forbidden — asserting on the raw text would fail on the
// documentation of the very rule being checked.
//
// ⚠️ Block comments FIRST, then WHOLE-LINE // comments only. A blanket
// line-comment strip would also eat `origin.startsWith('https://')` — real code
// whose `//` is inside a string literal — and silently delete the thing being
// measured. Anchored to line start with the m flag, which is also what keeps
// this CRLF-safe: [^\n] and $ both stop at \r rather than swallowing it.
const strip = (s: string) => s
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/^[ \t]*\/\/[^\n]*$/gm, '')

const CALLBACK = read('src/app/auth/callback/route.ts')
const START = read('src/app/api/auth/google/start/route.ts')
const GOOGLE_LIB = read('src/lib/googleAuth.ts')
const GOOGLE_SERVER = read('src/lib/googleAuthServer.ts')
const BUTTON = read('src/components/auth/GoogleButton.tsx')
const LOGIN = read('src/app/login/page.tsx')
const SIGNUP = read('src/app/signup/page.tsx')
const MIDDLEWARE = read('src/lib/supabase/middleware.ts')
const PKG = read('package.json')

const cCALLBACK = strip(CALLBACK)
const cSTART = strip(START)
const cSERVER = strip(GOOGLE_SERVER)
const cLIB = strip(GOOGLE_LIB)

// The baseline that is actually applied.
const MIGRATIONS = join(ROOT, 'supabase', 'migrations')
const baselineName = readdirSync(MIGRATIONS).filter(f => f.endsWith('_baseline.sql')).sort().pop()
const SQL = baselineName ? readFileSync(join(MIGRATIONS, baselineName), 'utf8') : ''

// ─────────────────────────────────────────────────────────────────────────────
H('1. safeReturnPath — THE open-redirect gate')
{
  // Every one of these is a real bypass of a naive startsWith('/') check, and
  // each has been used against a real product's OAuth return parameter.
  const hostile = [
    '//evil.tld/x',                 // protocol-relative: the browser reads absolute
    '//evil.tld',
    '/\\evil.tld/x',                // backslash normalises to / in the authority
    '/\\/evil.tld',
    'https://evil.tld/x',           // plainly absolute
    'http://evil.tld',
    '//attacker%2Ecom',
    'javascript:alert(1)',          // not a navigation at all
    'JavaScript:alert(1)',
    'data:text/html,<script>',
    '/%09/evil.tld',                // tab stripped before the authority is read
    '/%0a//evil.tld',               // newline, same trick
    '/%2f/evil.tld',                // encoded slash decodes to a second /
    'evil.tld',                     // schemeless host
    '',
    '   ',
  ]
  let bad = 0
  for (const h of hostile) {
    if (safeReturnPath(h) !== null) { bad++; fail(`REJECTS ${JSON.stringify(h)}`, `returned ${JSON.stringify(safeReturnPath(h))}`) }
  }
  check(`rejects all ${hostile.length} open-redirect shapes`, bad === 0)

  const legit = ['/dashboard', '/crew', '/crew/join', '/dashboard/customers/123', '/setup']
  let lost = 0
  for (const l of legit) if (safeReturnPath(l) !== l) { lost++; fail(`ACCEPTS ${l}`) }
  check(`accepts all ${legit.length} genuine in-app destinations`, lost === 0)

  check('null/undefined are null, never a guessed default',
    safeReturnPath(null) === null && safeReturnPath(undefined) === null)

  // The gate must be THE gate — one definition, not a copy per caller.
  check('the login form uses safeReturnPath, not its own inline check',
    /safeReturnPath\(/.test(strip(LOGIN)) && !/startsWith\('\/\/'\)/.test(strip(LOGIN)),
    'an inline open-redirect check reappeared on the login form')
  check('the OAuth start route validates `next` through the same gate',
    /safeReturnPath\(/.test(cSTART))
  check('the callback re-validates `next` on the way BACK',
    /safeReturnPath\(/.test(cCALLBACK),
    'next survives a provider round trip and is attacker-controllable at both ends')
}

// ─────────────────────────────────────────────────────────────────────────────
H('2. Provider-verified email — the takeover gate')
{
  const g = (data: Record<string, unknown>) => ({ identities: [{ provider: 'google', identity_data: data }] })

  check('google identity with email_verified true → verified', googleEmailVerified(g({ email_verified: true })))
  check('google identity with email_verified FALSE → NOT verified',
    !googleEmailVerified(g({ email_verified: false })),
    'a Workspace admin can mint an account whose email claim is false — this is the documented takeover shape')
  check('google identity with NO verified flag → NOT verified (absent is not verified)',
    !googleEmailVerified(g({ email: 'x@y.z' })))
  check('null user → NOT verified', !googleEmailVerified(null))
  check('no identities at all → NOT verified', !googleEmailVerified({ email: 'x@y.z' }))

  // ⭐ The one that matters most: user_metadata is writable by the user via
  // updateUser, so it must never promote an address on its own.
  check('user_metadata email_verified ALONE cannot promote an unconfirmed address',
    !googleEmailVerified({ user_metadata: { email_verified: true }, email_confirmed_at: null }),
    'self-set metadata would be a self-service verification bypass')
  check('user_metadata is honoured only alongside email_confirmed_at',
    googleEmailVerified({ user_metadata: { email_verified: true }, email_confirmed_at: '2026-08-16T00:00:00Z' }))

  // The binding engine must consult it, and must also restate the DB's own rule.
  check('the binding engine gates on googleEmailVerified', /googleEmailVerified\(/.test(cSERVER))
  check('the binding engine ALSO requires email_confirmed_at',
    /email_confirmed_at/.test(cSERVER),
    'claim_beta_invite() requires it; this parallel path must not be laxer')
}

// ─────────────────────────────────────────────────────────────────────────────
H('3. The beta gate is untouched (SQL, apply path)')
{
  check(`baseline located (${baselineName ?? 'NONE'})`, !!SQL, 'no *_baseline.sql under supabase/migrations')

  const canProvision = /CREATE OR REPLACE FUNCTION public\.can_provision_business\(\)[\s\S]*?\$function\$([\s\S]*?)\$function\$/.exec(SQL)?.[1] ?? ''
  check('can_provision_business() still requires owner OR a REDEEMED invite',
    /current_app_role\(\)\s*=\s*'owner'/.test(canProvision) &&
    /beta_invites/.test(canProvision) && /redeemed_by\s*=\s*auth\.uid\(\)/.test(canProvision),
    'this is the predicate a new Google account must fail')

  check('the business_settings INSERT policy still carries can_provision_business()',
    /auth\.uid\(\)\s*=\s*user_id\)?\s*AND\s*can_provision_business\(\)/i.test(SQL),
    'the tenant door must stay licensed')

  // Redemption is keyed on the uid, never on an email — which is what makes a
  // duplicate Google account harmless rather than dangerous.
  check('redemption is keyed on redeemed_by = auth.uid(), not on an email',
    !/redeemed_by\s*=\s*[^\s;]*email/i.test(SQL))

  const claim = /CREATE OR REPLACE FUNCTION public\.claim_beta_invite\(\)[\s\S]*?\$function\$([\s\S]*?)\$function\$/.exec(SQL)?.[1] ?? ''
  check('claim_beta_invite() still refuses an unverified email',
    /email_confirmed_at/.test(claim) && /email-unverified/.test(claim))

  check('can_provision_business() is NOT granted to anon',
    /revoke all on function public\."can_provision_business"\(\) from public, anon, authenticated, service_role;/.test(SQL) &&
    !/grant execute on function public\."can_provision_business"\(\) to anon;/.test(SQL))
}

// ─────────────────────────────────────────────────────────────────────────────
H('4. Crew authorization is untouched (SQL, apply path)')
{
  const redeem = /CREATE OR REPLACE FUNCTION public\.crew_redeem_invite\(([\s\S]*?)\$function\$([\s\S]*?)\$function\$/.exec(SQL)?.[2] ?? ''
  check('crew_redeem_invite() still demands a signed-in caller', /auth\.uid\(\) is null/.test(redeem))
  check('crew_redeem_invite() still refuses a DISABLED or ARCHIVED roster row',
    /archived_at is not null/.test(redeem) && /not v_tech\.is_active/.test(redeem),
    'a revoked worker must not be able to re-join with a Google account')
  check('crew_redeem_invite() still refuses an ALREADY-USED code',
    /auth_user_id is not null/.test(redeem))
  check('crew_redeem_invite() still refuses an EXPIRED code',
    /invite_expires_at/.test(redeem))
  check('crew_redeem_invite() still binds auth_user_id = auth.uid() and nothing else',
    /set auth_user_id = auth\.uid\(\)/.test(redeem),
    'the caller can never choose WHICH technician row, only redeem a code they hold')
  check('an owner account still cannot also become crew',
    /business_settings/.test(redeem))

  // Nothing in this feature may write the crew link.
  check('the Google callback never writes technicians.auth_user_id',
    !/technicians/.test(cCALLBACK) && !/auth_user_id/.test(cCALLBACK),
    'crew access is the owner-invite relationship, not an authentication side effect')
  check('the binding engine never touches technicians',
    !/technicians/.test(cSERVER))

  // Routing for an unlinked account: a stranger who authenticates lands on the
  // join screen, which demands a code. This is the self-provisioning refusal.
  check('an authenticated, unlinked account is routed to /crew/join, not into /crew',
    routeFor('none', '/crew', true) === '/crew/join')
  check('a crew account is never routed into the owner CRM',
    routeFor('crew', '/dashboard', true) === '/crew')
  check('an owner is never demoted into crew mode', routeFor('owner', '/crew', true) === '/dashboard')
  check('landingFor still sends crew to /crew and everyone else to /dashboard',
    landingFor('crew') === '/crew' && landingFor('owner') === '/dashboard' && landingFor('none') === '/dashboard')
}

// ─────────────────────────────────────────────────────────────────────────────
H('5. The callback grants nothing it should not')
{
  check('the callback reads the user through lib/authState, not off the exchange payload',
    /readUser\(supabase\)/.test(cCALLBACK) && /auth\.kind === 'unavailable'/.test(cCALLBACK),
    'the three-answer read is what stops a blip straight after a good exchange reading as "nobody"')
  check('the callback asks current_app_role() — the database, not the browser',
    /rpc\('current_app_role'\)/.test(cCALLBACK))
  check('the callback asks can_provision_business() rather than inferring it',
    /rpc\('can_provision_business'\)/.test(cCALLBACK),
    'the answer here and at the tenant door must not be able to drift')
  check('an account entitled to nothing is signed out, not left stranded',
    /abandon\('no-invite'\)/.test(cCALLBACK))

  // ⭐⭐ The 2026-08-12 incident, pinned. A bare signOut() defaults to GLOBAL,
  // which revokes every session the person holds on every device.
  const signOuts = cCALLBACK.match(/signOut\(([^)]*)\)/g) ?? []
  check('every signOut in the callback is scope:\'local\'',
    signOuts.length > 0 && signOuts.every(s => /scope:\s*'local'/.test(s)),
    `found ${JSON.stringify(signOuts)} — a bare signOut() is GLOBAL and ends the person's other sessions`)

  // ⭐⭐ The other landed lesson: a redirect is a NEW response and carries none
  // of the session cookies the exchange just wrote.
  check('the callback preserves session cookies across every redirect',
    /for \(const c of jar\) res\.cookies\.set/.test(cCALLBACK),
    'NextResponse.redirect() drops the cookies the code exchange wrote — see lib/supabase/middleware')
  check('the start route preserves the PKCE verifier cookie across its redirect',
    /for \(const c of jar\) res\.cookies\.set/.test(cSTART),
    'losing the verifier makes the callback unable to exchange, every time')

  check('"could not ask" never becomes a verdict: a failed RPC keeps the session',
    /roleError\)? return fail\('unavailable'\)/.test(cCALLBACK) ||
    /if \(roleError\) return fail\('unavailable'\)/.test(cCALLBACK),
    'a transient DB error must not sign a real owner out of their own login')
  check('an unavailable binding does NOT abandon the session',
    /outcome\.reason === 'unavailable'[\s\S]{0,240}?return fail\('unavailable'\)/.test(cCALLBACK))

  check('the callback runs on nodejs and is never cached',
    /runtime = 'nodejs'/.test(cCALLBACK) && /dynamic = 'force-dynamic'/.test(cCALLBACK))
  check('the callback never logs — the URL carries an authorization code',
    !/console\./.test(cCALLBACK))
  check('the start route never logs — the URL carries the PKCE challenge',
    !/console\./.test(cSTART))
}

// ─────────────────────────────────────────────────────────────────────────────
H('6. Invite binding: server-authoritative, atomic, idempotent')
{
  check('the two token hashers agree (one token, one hash, two modules)',
    hashInviteToken('eqb_' + 'a'.repeat(64)) === hashBetaToken('eqb_' + 'a'.repeat(64)),
    'a divergent hash would look up nothing and fail every legitimate invite')

  check('the database is only ever handed a sha256, never a raw token',
    /eq\('token_hash', hashInviteToken\(/.test(cSERVER))
  check('the uid comes from the exchanged session, never from the request',
    /user\.id/.test(cSERVER) && !/body|searchParams|req\./.test(cSERVER),
    'a client-supplied uid would let anyone redeem an invite onto any account')

  // Every eligibility condition restated in the WHERE — two callbacks racing on
  // one invite must not both win.
  for (const clause of [
    ["is\\('redeemed_at', null\\)", 'already redeemed'],
    ["is\\('revoked_at', null\\)", 'revoked'],
    ["gt\\('expires_at'", 'expired'],
    ['reserved_by', 'reserved by another account'],
  ]) {
    check(`the atomic UPDATE restates: ${clause[1]}`, new RegExp(clause[0]).test(cSERVER))
  }
  check('losing the race is reported as taken, never silently shared',
    /won\.length === 0\) return \{ ok: false, reason: 'invite-taken' \}/.test(cSERVER))

  check('a replayed binding by the RIGHTFUL holder is idempotent',
    /redeemed_by === user\.id[\s\S]{0,120}?alreadyBound: true/.test(cSERVER),
    'a refreshed tab must not tell a legitimate owner their invite is gone')
  check('a redeemed invite belonging to SOMEBODY ELSE is refused',
    /reason: 'invite-invalid'/.test(cSERVER))
  check('an invite addressed to another email is refused',
    /invite\.email[\s\S]{0,200}?'invite-mismatch'/.test(cSERVER))
  check('the email comparison is normalised on BOTH sides',
    (cSERVER.match(/normalizeInviteEmail\(/g) ?? []).length >= 2,
    'Sam@Example.com and sam@example.com are one person')
  check('normalizeInviteEmail actually folds case and whitespace',
    normalizeInviteEmail('  Sam@Example.COM ') === 'sam@example.com')
  check('a reservation held by another live account is refused',
    /reserved_by && invite\.reserved_by !== user\.id/.test(cSERVER))

  check('the binding engine cannot create a business',
    !/business_settings/.test(cSERVER))
  check('the binding engine cannot grant platform privilege',
    !/platform_operators/.test(cSERVER) && !/platform_capabilities/.test(cSERVER))
  check('the callback cannot grant platform privilege',
    !/platform_operators/.test(cCALLBACK) && !/platform_capabilities/.test(cCALLBACK))
  check('an existing OWNER never has a second invite spent on them',
    /role !== 'owner'/.test(cCALLBACK))
}

// ─────────────────────────────────────────────────────────────────────────────
H('7. The invite never travels in a URL')
{
  check('the handshake cookie is httpOnly', /httpOnly: true/.test(cSTART))
  check('the handshake cookie is SameSite=Lax (Strict would drop the return trip)',
    /sameSite: 'lax'/.test(cSTART))
  check('the handshake cookie is Secure on https origins',
    /secure: origin\.startsWith\('https:\/\/'\)/.test(cSTART))
  check('the handshake cookie is short-lived', OAUTH_INVITE_TTL_SECONDS <= 900 && OAUTH_INVITE_TTL_SECONDS >= 120)
  check('the callback clears the handshake cookie on EVERY exit',
    /res\.cookies\.set\(OAUTH_INVITE_COOKIE, '', CLEARED\)/.test(cCALLBACK),
    'an abandoned attempt must not leave an entitlement in the browser')
  check('the invite is read from the COOKIE, never from the callback query string',
    /req\.cookies\.get\(OAUTH_INVITE_COOKIE\)/.test(cCALLBACK) &&
    !/searchParams\.get\('invite'\)/.test(cCALLBACK))

  // The redirect the provider is given must be our callback on our origin.
  const built = buildCallbackUrl('https://app.edgehq.ca', '/crew')
  check('buildCallbackUrl targets our own callback path',
    built === `https://app.edgehq.ca${AUTH_CALLBACK_PATH}?next=%2Fcrew`, built)
  check('buildCallbackUrl DROPS a hostile next rather than forwarding it',
    buildCallbackUrl('https://app.edgehq.ca', '//evil.tld') === `https://app.edgehq.ca${AUTH_CALLBACK_PATH}`)
  check('buildCallbackUrl tolerates a trailing slash on the origin',
    buildCallbackUrl('https://app.edgehq.ca/', null) === `https://app.edgehq.ca${AUTH_CALLBACK_PATH}`)

  check('the origin comes from the canonical appOrigin primitive',
    /from '@\/lib\/appOrigin'/.test(START) && /from '@\/lib\/appOrigin'/.test(CALLBACK),
    'never a raw NEXT_PUBLIC_APP_URL read')
  check('neither route reads NEXT_PUBLIC_APP_URL directly',
    !/NEXT_PUBLIC_APP_URL/.test(cSTART) && !/NEXT_PUBLIC_APP_URL/.test(cCALLBACK))
  check('the retired host is nowhere in this feature',
    !/edgepropertyservicesyyc/.test(START + CALLBACK + GOOGLE_LIB + BUTTON + LOGIN + SIGNUP))
}

// ─────────────────────────────────────────────────────────────────────────────
H('8. Tokens, scopes and what is deliberately NOT requested')
{
  check('PKCE is stated outright on both server clients',
    /flowType: 'pkce'/.test(cSTART) && /flowType: 'pkce'/.test(cCALLBACK))
  check('the code is exchanged server-side',
    /exchangeCodeForSession\(code\)/.test(cCALLBACK))

  // ⛔ A refresh token is a standing key to somebody's Google account, and
  // EdgeHQ reads nothing from Google after sign-in.
  check('access_type=offline is NOT requested',
    !/access_type/.test(cSTART) && !/offline/.test(cSTART),
    'that is what makes Google issue a refresh token we would then be storing')
  check('no Google token is persisted anywhere in this feature',
    !/provider_token|provider_refresh_token/.test(cSTART + cCALLBACK + cSERVER))
  check('scopes are the minimum that answers who this is',
    GOOGLE_SCOPES === 'openid email profile', GOOGLE_SCOPES)
  check('the provider is google, and only google', GOOGLE_PROVIDER === 'google')

  // ⛔ V1 refuses to link a second identity rather than doing it silently.
  const ALL_SRC = [cSTART, cCALLBACK, cSERVER, cLIB, strip(BUTTON), strip(LOGIN), strip(SIGNUP)].join('\n')
  check('linkIdentity() is never called in V1',
    !/linkIdentity/.test(ALL_SRC),
    'explicit account linking is a V2 decision; silent linking would be worse than refusing')
  check('there is a refusal message for the ambiguous-link case',
    typeof GOOGLE_AUTH_ERROR_TEXT['link-ambiguous'] === 'string' &&
    GOOGLE_AUTH_ERROR_TEXT['link-ambiguous'].length > 20)
}

// ─────────────────────────────────────────────────────────────────────────────
H('9. Failure is legible, and never reflected')
{
  check('a cancelled consent screen reads as cancelled, not as an error',
    classifyProviderError('access_denied') === 'cancelled')
  check('every other provider error is uninformative on purpose',
    classifyProviderError('server_error') === 'exchange' &&
    classifyProviderError('temporarily_unavailable') === 'exchange' &&
    classifyProviderError(null) === 'exchange')

  check('an unknown error code renders NOTHING rather than being echoed',
    readGoogleAuthError('<script>alert(1)</script>') === null &&
    readGoogleAuthError('anything') === null && readGoogleAuthError(null) === null,
    'reflecting a query parameter is how a login page becomes a phishing surface')
  check('every known code round-trips',
    (Object.keys(GOOGLE_AUTH_ERROR_TEXT) as (keyof typeof GOOGLE_AUTH_ERROR_TEXT)[])
      .every(k => readGoogleAuthError(k) === k))
  check('every code has human text that names a way forward',
    Object.values(GOOGLE_AUTH_ERROR_TEXT).every(t => t.length > 25))
  check('no error text leaks a provider code, a token or an email',
    !Object.values(GOOGLE_AUTH_ERROR_TEXT).some(t => /access_denied|token|@|eqb_/.test(t)))

  check('the login screen renders the failure',
    /GOOGLE_AUTH_ERROR_TEXT\[authError\]/.test(strip(LOGIN)))
  check('the callback fails back to /login carrying only a stable code',
    new RegExp(`/login\\?\\$\\{AUTH_ERROR_PARAM\\}=`).test(cCALLBACK) && AUTH_ERROR_PARAM === 'auth_error')
}

// ─────────────────────────────────────────────────────────────────────────────
H('10. Surfaces, bundle safety and wiring')
{
  check('the server-only binding module is never imported by client code', (() => {
    const clientFiles = [LOGIN, SIGNUP, BUTTON]
    return !clientFiles.some(f => /googleAuthServer/.test(f))
  })(), 'it reaches for the service role and would drag crypto into the bundle')
  check('the shared contract module pulls no server-only dependency',
    !/from 'crypto'/.test(GOOGLE_LIB) && !/createAdminClient/.test(GOOGLE_LIB))
  check('the Google button is not a <button> inside the sign-in form',
    /<a$/m.test(BUTTON) || /<a\s/.test(BUTTON),
    'a <button> in a form defaults to type=submit and would fire the password submit')
  check('the button links to the server start route',
    /OAUTH_START_PATH/.test(BUTTON) && OAUTH_START_PATH === '/api/auth/google/start')

  check('both auth screens offer Google', /GoogleButton/.test(LOGIN) && /GoogleButton/.test(SIGNUP))
  check('the labels are Google-permitted wording',
    /label="Sign in with Google"/.test(LOGIN) && /label="Continue with Google"/.test(SIGNUP))
  check('the four-colour G is intact and un-recoloured',
    ['#EA4335', '#4285F4', '#FBBC05', '#34A853'].every(c => BUTTON.includes(c)),
    "Google's identity guidelines govern this mark")
  check('signup offers Google ONLY once the invite is known live',
    /phase === 'form'[\s\S]*?GoogleButton/.test(SIGNUP))
  check('signup hands the invite to the start route',
    /invite=\{token\}/.test(SIGNUP))
  check('V1 is Google only — no social-login list',
    !/facebook|apple|github|twitter|microsoft/i.test(strip(LOGIN) + strip(SIGNUP) + strip(BUTTON)))

  // The callback must be reachable signed-out, or an invited owner can never
  // complete the round trip.
  check('the callback path is NOT inside the gated trees',
    routeFor('none', AUTH_CALLBACK_PATH, false) === null,
    'middleware would bounce it to /login and the exchange would never run')
  check('the middleware still routes every redirect through redirectPreservingSession',
    /redirectPreservingSession/.test(MIDDLEWARE))

  check('verify:google-auth is registered so `npm run verify` runs it',
    /"verify:google-auth": "tsx scripts\/verify-google-auth\.ts"/.test(PKG),
    'an unregistered guard is dead safety')
}

// ─────────────────────────────────────────────────────────────────────────────
console.log(`\n${failures === 0 ? '✅ google-auth: all checks passed' : `❌ google-auth: ${failures} check(s) failed`}`)
process.exit(failures === 0 ? 0 : 1)
