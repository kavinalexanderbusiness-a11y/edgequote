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
  AUTH_ERROR_PARAM, hasPkceVerifier, readProviderFragmentError,
} from '../src/lib/googleAuth'
import { hashInviteToken } from '../src/lib/googleAuthServer'
import { hashBetaToken } from '../src/lib/betaInviteServer'
import { normalizeInviteEmail } from '../src/lib/crewInvite'
import { routeFor, landingFor } from '../src/lib/crewAccess'
import { appOrigin, cleanOrigin } from '../src/lib/appOrigin'
import { loadEnvLocal } from './lib/verify-fixture'
import { endProcess } from './lib/shutdown'

let failures = 0
let skipped = 0
const ok = (name: string) => console.log(`  ✓ ${name}`)
const fail = (name: string, detail = '') => { failures++; console.log(`  ✗ ${name}${detail ? `\n      ${detail}` : ''}`) }
const check = (name: string, cond: boolean, detail = '') => { cond ? ok(name) : fail(name, detail) }
const H = (t: string) => console.log(`\n═══ ${t} ═══`)
// ⚠️ A live half that cannot reach its subject must SKIP, never pass. Reported
// separately from `failures` so `npm run verify` can tell "proved" from "could
// not look" — a guard that goes green because the network was down is worse than
// no guard, and this repo has shipped that mistake before (verify:schema).
const skip = (name: string, why: string) => { skipped++; console.log(`  … SKIPPED ${name} — ${why}`) }

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
const APP_ORIGIN_SRC = read('src/lib/appOrigin.ts')
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
  // The licence is stated inline (the invite-era body) or delegated to
  // provisioning_status() (the self-service-era body, migration
  // 20260905191549). Whichever body decides must still carry BOTH original
  // licences: an owner already, or a REDEEMED invite.
  const decider = /provisioning_status\(\)/.test(canProvision)
    ? (/CREATE OR REPLACE FUNCTION public\.provisioning_status\(\)[\s\S]*?\$function\$([\s\S]*?)\$function\$/.exec(SQL)?.[1] ?? '')
    : canProvision
  check('can_provision_business() still requires owner OR a REDEEMED invite',
    (/current_app_role\(\)\s*=\s*'owner'/.test(decider) || /business_settings b where b\.user_id = v_uid/.test(decider)) &&
    /beta_invites/.test(decider) && /redeemed_by\s*=\s*(auth\.uid\(\)|v_uid)/.test(decider),
    'this is the predicate a new Google account must fail while the sign-up switch is closed')

  check('the business_settings INSERT policy still carries can_provision_business()',
    /auth\.uid\(\)\s*=\s*user_id\)?\s*AND\s*can_provision_business\(\)/i.test(SQL),
    'the tenant door must stay licensed')

  // Redemption is keyed on the uid, never on an email — which is what makes a
  // duplicate Google account harmless rather than dangerous.
  check('redemption is keyed on redeemed_by = auth.uid(), not on an email',
    !/redeemed_by\s*=\s*[^\s;]*email/i.test(SQL))

  const claim = /CREATE OR REPLACE FUNCTION public\.claim_beta_invite\(\)[\s\S]*?\$function\$([\s\S]*?)\$function\$/.exec(SQL)?.[1] ?? ''
  // The structural half of "no duplicate business": even if every gate above
  // were bypassed, the table itself cannot hold a second row for one owner.
  // ⚠️ The parens are ESCAPED. Unescaped, `UNIQUE (user_id)` is a regex group
  // meaning "UNIQUE user_id" with a space — a spelling that appears in no SQL
  // dialect, so that alternative could never match and the check rested entirely
  // on the constraint NAME. It passes today because the name is present; rename
  // the constraint and this would have started silently proving nothing.
  check('business_settings cannot hold two rows for one user',
    /business_settings_user_id_key|UNIQUE \(user_id\)/i.test(SQL),
    'a unique constraint on user_id is what makes duplicate-business structurally impossible')

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
  // ⛔ NO FAILURE MAY COLLAPSE INTO ANOTHER. "This browser holds no verifier" and
  // "that code will not exchange" arrive from Supabase as one indistinguishable
  // error and need opposite advice. The callback asks the answerable half itself,
  // BEFORE the exchange, or the distinction is lost for good.
  check('a missing PKCE verifier is its own answer, not a generic exchange failure',
    /hasPkceVerifier\(/.test(cCALLBACK) && /fail\('no-verifier'\)/.test(cCALLBACK))
  check('the verifier is checked BEFORE the exchange',
    cCALLBACK.indexOf('hasPkceVerifier') < cCALLBACK.indexOf('exchangeCodeForSession'),
    'afterwards the two causes are indistinguishable')
  check('the verifier cookie is matched by SUFFIX, never a hard-coded name',
    /endsWith\(PKCE_VERIFIER_COOKIE_SUFFIX\)/.test(strip(GOOGLE_LIB)),
    '@supabase/ssr owns the storage key; a duplicated name silently stops matching')
  check('only the PRESENCE of the verifier is read, never its value',
    /getAll\(\)\.map\(c => c\.name\)/.test(cCALLBACK),
    'the value is the secret half of the handshake')
  check('hasPkceVerifier finds the real @supabase/ssr cookie and nothing else',
    hasPkceVerifier(['sb-abcdefghijklmnop-auth-token-code-verifier']) &&
    hasPkceVerifier(['other', 'sb-x-auth-token-code-verifier']) &&
    !hasPkceVerifier(['sb-abcdefghijklmnop-auth-token']) &&
    !hasPkceVerifier([]) && !hasPkceVerifier(['eq-oauth-invite']))

  // ── The failure the SERVER cannot see ──────────────────────────────────────
  // ⚠️⚠️ gotrue reports its OWN return-leg failures in the URL FRAGMENT, which is
  // never sent to a server. On 2026-08-26 that turned
  //   error=server_error&error_code=unexpected_failure
  // (Google refusing OUR client secret — "invalid_client") into "the link could
  // not be completed. Please try again", advice that could never have worked.
  // The fragment survives to /login, so that is where it must be read.
  check('a provider fragment failure is read, not lost',
    readProviderFragmentError('#error=server_error&error_code=unexpected_failure') === 'provider-config',
    'a server-side provider failure must not read as a generic retry')
  check('a cancelled consent screen is still cancelled from the fragment',
    readProviderFragmentError('#error=access_denied') === 'cancelled')
  check('an unknown fragment code degrades to exchange, never to nothing',
    readProviderFragmentError('#error=some_new_thing') === 'exchange')
  check('a fragment with no error at all is null (normal sign-in untouched)',
    readProviderFragmentError('') === null && readProviderFragmentError(null) === null &&
    readProviderFragmentError('#access_token=x') === null)
  check('the leading # is optional',
    readProviderFragmentError('error=access_denied') === 'cancelled')
  // ⛔ error_description is attacker-controllable: anyone can hand a victim a
  // /login URL carrying any fragment. Rendering it is a phishing surface.
  check('the provider’s own text is NEVER rendered',
    !/error_description/.test(strip(LOGIN)) &&
    /GOOGLE_AUTH_ERROR_TEXT\[authError\]/.test(strip(LOGIN)),
    'only our own sentences may reach the screen')
  check('the login page reads the fragment and clears it once read',
    /readProviderFragmentError\(window\.location\.hash\)/.test(strip(LOGIN)) &&
    /history\.replaceState/.test(strip(LOGIN)),
    'a fragment left behind rides along to the next page')
  check('the fragment outranks the generic query code when both are present',
    /fragmentError \?\? queryAuthError/.test(strip(LOGIN)))

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
H('11. The production return destination')
// ⚠️⚠️ THE FAILURE THIS SECTION EXISTS FOR — a real human hit it on 2026-08-23.
//
// Sections 1-10 passed, 33/33, while production Google sign-in was broken end to
// end. An owner clicked "Sign in with Google", authenticated successfully at
// Google, and landed on:
//
//     404: NOT_FOUND      Code: DEPLOYMENT_NOT_FOUND
//
// ⭐ NOTHING IN THIS REPOSITORY WAS WRONG. The app sent the correct
// redirect_to=https://app.edgehq.ca/auth/callback. The SUPABASE PROJECT's URL
// configuration still named the host that was retired in August:
//
//     site_url       = https://app.edgepropertyservicesyyc.ca      ← deployment deleted
//     uri_allow_list = https://app.edgepropertyservicesyyc.ca/**,http://localhost:3000/**
//
// ⭐⭐ THE MECHANISM, and why no amount of source-reading could have caught it.
// gotrue does NOT validate `redirect_to` when the flow STARTS — it carries any
// value straight through to the provider, which section 1 already measures. The
// allow list is enforced when the provider RETURNS, and a redirect_to that fails
// to match it is not reported as an error: it SILENTLY FALLS BACK TO site_url.
// A correct app talking to a misconfigured project therefore delivers the person
// to whatever host site_url names — here, a deployment that no longer exists.
//
// ⭐ WHY IT SURVIVED SO LONG UNNOTICED. Every other auth link in this codebase was
// deliberately built NOT to depend on the allow list: crewInvite.buildSetupUrl,
// passwordRecovery.buildResetUrl and betaInvite all construct their own URL
// around a `hashed_token` for exactly that reason, and passwordRecovery even
// records that site_url was once `http://localhost:3000` in production. They
// engineered AROUND this field instead of fixing it. signInWithOAuth is the FIRST
// and ONLY flow that consumes the allow list, so it is the first one this
// misconfiguration was able to break.
//
// The static half pins what this repo controls. The live halves ask the two
// systems that actually decide, and SKIP rather than pass when they cannot be
// reached.

/** The production origin of record. Not trusted on its own — cross-checked below
 *  against NEXT_PUBLIC_APP_URL as the deploy actually reports it. */
const CANONICAL_ORIGIN = 'https://app.edgehq.ca'
const CANONICAL_CALLBACK = `${CANONICAL_ORIGIN}${AUTH_CALLBACK_PATH}`
const CALLBACK_WITH_NEXT = `${CANONICAL_CALLBACK}?next=%2Fdashboard`

/** Hosts that must never be an authentication return destination. Both shapes
 *  have really shipped: the retired Edge Property Services app, and any
 *  *.vercel.app deployment — ephemeral previews and deleted production aliases
 *  alike answer DEPLOYMENT_NOT_FOUND once they are gone. */
const FORBIDDEN_RETURN: [string, RegExp][] = [
  ['the retired Edge Property Services host', /edgepropertyservicesyyc/i],
  ['an ephemeral or deleted *.vercel.app deployment', /\.vercel\.app/i],
]
const forbiddenIn = (s: string) => FORBIDDEN_RETURN.filter(([, re]) => re.test(s)).map(([n]) => n)

{
  check('buildCallbackUrl on the canonical origin is the canonical callback',
    buildCallbackUrl(CANONICAL_ORIGIN, null) === CANONICAL_CALLBACK,
    buildCallbackUrl(CANONICAL_ORIGIN, null))

  // ⛔ THE guard against an ephemeral preview hostname becoming the auth return.
  // VERCEL_URL and VERCEL_BRANCH_URL name a DEPLOYMENT, not the product: they
  // change on every push and stop resolving the moment it is removed. appOrigin
  // answers from NEXT_PUBLIC_APP_URL or the request, and must never learn a
  // third source.
  check('no auth redirect is ever built from VERCEL_URL or VERCEL_BRANCH_URL',
    !/VERCEL_URL|VERCEL_BRANCH_URL/.test(cSTART + cCALLBACK + strip(APP_ORIGIN_SRC)),
    'a deployment hostname is ephemeral; the product origin is not')

  const flowSrc = cSTART + cCALLBACK + cLIB + strip(BUTTON) + strip(LOGIN) + strip(SIGNUP)
  check('no forbidden return host appears anywhere in the flow',
    forbiddenIn(flowSrc).length === 0, forbiddenIn(flowSrc).join('; '))

  // ⭐ THE apex-domain question, settled by measurement rather than by guessing.
  // edgehq.ca is a live alias of the same deployment and serves /login itself, so
  // a person can legitimately BEGIN the flow there. It must not therefore become
  // the RETURN origin: appOrigin prefers the configured value over the request,
  // which canonicalises an apex entry onto app.edgehq.ca by construction. That is
  // what makes it safe for edgehq.ca to be absent from the Supabase allow list.
  const savedAppUrl = process.env.NEXT_PUBLIC_APP_URL
  process.env.NEXT_PUBLIC_APP_URL = CANONICAL_ORIGIN
  check('a configured origin outranks the request origin',
    appOrigin('https://edgehq.ca') === CANONICAL_ORIGIN,
    'entry via the apex must not make the apex the OAuth return')
  check('an apex-host entry still returns to the canonical callback',
    buildCallbackUrl(appOrigin('https://edgehq.ca'), null) === CANONICAL_CALLBACK)
  check('a hostile Host header cannot become the return origin',
    appOrigin('https://evil.tld') === CANONICAL_ORIGIN,
    'the configured value must win over anything the request carries')

  // ⭐⭐ THE 2026-08-26 FAILURE. appOrigin canonicalising the RETURN is correct;
  // it also means a flow begun on an alias host writes its PKCE verifier on that
  // host — a cookie with no Domain attribute, so host-only — and then returns to
  // a different one holding nothing to exchange with. The start route must move
  // the browser to the canonical host BEFORE it writes any state.
  check('the start route canonicalises the host before writing PKCE state',
    /requestHost\s*!==\s*canonicalHost/.test(cSTART),
    'an alias-host start strands the verifier on the wrong host — the exchange then has nothing to exchange against')

  // ⚠️⚠️ THE COMPARISON MUST BE THE HOST HEADER. Written against
  // `req.nextUrl.origin` this looped forever in a measured local run: a request
  // whose Host already WAS the configured origin still compared unequal and
  // redirected to itself. An infinite redirect on the sign-in door is worse than
  // the bug it was fixing, so the shape is pinned, not just the behaviour.
  check('the hop compares the HOST HEADER, never req.nextUrl.origin',
    /req\.headers\.get\('x-forwarded-host'\)/.test(cSTART) &&
    /req\.headers\.get\('host'\)/.test(cSTART) &&
    !/cleanOrigin\(req\.nextUrl\.origin\)/.test(cSTART),
    'nextUrl.origin is framework-normalised and is not the address the browser used')
  check('the hop is capped at ONE, so a loop is structurally impossible',
    /alreadyHopped/.test(cSTART) && /searchParams\.set\('canon', '1'\)/.test(cSTART),
    'a wrong host comparison must cost one wasted redirect, never a hang')

  // ⚠️ Anchored to the CALL, not the bare identifier: `createServerClient` also
  // appears in the import on line 2, so an indexOf on the name alone compares
  // against the top of the file and passes for any placement. Caught by this
  // guard failing on a correct implementation — the useful direction to fail in.
  check('that redirect happens BEFORE the supabase client is created',
    cSTART.indexOf('requestHost !== canonicalHost') < cSTART.indexOf('= createServerClient('),
    'redirecting after the verifier is written would write it on the wrong host anyway')
  check('the canonicalising hop carries the query string (next, invite) forward',
    /canonical\.search\s*=\s*req\.nextUrl\.search/.test(cSTART))
  if (savedAppUrl === undefined) delete process.env.NEXT_PUBLIC_APP_URL
  else process.env.NEXT_PUBLIC_APP_URL = savedAppUrl
}

// ── gotrue's own matching, reimplemented so the allow list can be TESTED ──────
// Supabase compiles each allow-list entry with glob.Compile(entry, '.', '/'):
// `*` stops at a separator, `**` crosses them, `?` is a single non-separator
// character, and the string matched is the WHOLE redirect URL — query string
// included. That last detail is why an entry must account for `?next=`.
//
// Reimplemented rather than merely described, because the obvious guard — "the
// canonical callback appears somewhere in the allow list" — would have passed on
// the broken production config. `https://app.edgepropertyservicesyyc.ca/**`
// contains no wildcard mistake at all; it simply names the wrong host. Only
// actually matching the two together catches that, so the matcher is driven over
// the real before-and-after below and cannot be silently wrong.
function globToRegExp(pattern: string): RegExp {
  let out = ''
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i]
    if (c === '*') {
      if (pattern[i + 1] === '*') { out += '.*'; i++ } else { out += '[^./]*' }
    } else if (c === '?') {
      out += '[^./]'
    } else {
      out += c.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    }
  }
  return new RegExp(`^${out}$`)
}
const allows = (entry: string, url: string) => globToRegExp(entry.trim()).test(url)

{
  check('matcher: a `**` entry covers the bare callback',
    allows(`${CANONICAL_CALLBACK}**`, CANONICAL_CALLBACK))
  check('matcher: a `**` entry covers a callback carrying ?next=',
    allows(`${CANONICAL_CALLBACK}**`, CALLBACK_WITH_NEXT))
  check('matcher: a bare entry does NOT cover a query string',
    !allows(CANONICAL_CALLBACK, CALLBACK_WITH_NEXT),
    'which is why the allow list needs the wildcard form as well')
  check('matcher: a single `*` does not cross a dot, so it cannot widen a host',
    !allows('https://app.*.ca/auth/callback', 'https://app.edge.hq.ca/auth/callback'))
  // ⭐ THE 2026-08-23 outage, expressed as an assertion. This is the pairing that
  // was live in production: an allow list that does not cover the callback the
  // app sends, which is precisely what made gotrue fall back to site_url.
  check('matcher: the RETIRED allow list does NOT cover the canonical callback',
    !allows('https://app.edgepropertyservicesyyc.ca/**', CANONICAL_CALLBACK),
    'this pairing IS the DEPLOYMENT_NOT_FOUND a real owner hit')
}

// ─────────────────────────────────────────────────────────────────────────────
// The two live systems. Neither is in this repository, and the outage lived in
// one of them, so a guard that only reads source cannot see this class of break.
const TIMEOUT_MS = 15_000

async function getJson(url: string, headers: Record<string, string> = {}): Promise<Record<string, unknown> | null> {
  try {
    const r = await fetch(url, { headers, signal: AbortSignal.timeout(TIMEOUT_MS) })
    if (!r.ok) return null
    return (await r.json()) as Record<string, unknown>
  } catch { return null }
}

/** Is a browser sent here going to arrive somewhere real? A deleted Vercel
 *  deployment answers 404 with `x-vercel-error: DEPLOYMENT_NOT_FOUND`, which is
 *  the exact page the owner saw, so the header is read explicitly rather than
 *  inferred from the status alone. */
async function probeHost(url: string): Promise<{ ok: boolean; detail: string }> {
  try {
    const r = await fetch(url, { redirect: 'manual', signal: AbortSignal.timeout(TIMEOUT_MS) })
    const vercelError = r.headers.get('x-vercel-error')
    return {
      ok: r.status < 400 && !vercelError,
      detail: `HTTP ${r.status}${vercelError ? ` x-vercel-error: ${vercelError}` : ''}`,
    }
  } catch (e) {
    return { ok: false, detail: `unreachable: ${String((e as Error)?.message ?? e)}` }
  }
}

/** The project ref out of the Supabase URL, so the guard follows the environment
 *  it is pointed at instead of carrying a hard-coded project. */
function projectRef(supabaseUrl: string | undefined): string | null {
  const m = /^https:\/\/([a-z0-9]+)\.supabase\.co$/i.exec(cleanOrigin(supabaseUrl))
  return m ? m[1] : null
}

async function main(): Promise<void> {
  loadEnvLocal()

  H('12. What the DEPLOY says its origin is')
  {
    const health = await getJson(`${CANONICAL_ORIGIN}/api/health`)
    if (!health) {
      skip('the deploy’s own origin report', `${CANONICAL_ORIGIN}/api/health could not be read`)
    } else {
      const appUrl = String(health.app_url ?? '')
      check('production reports the canonical origin', appUrl === CANONICAL_ORIGIN, appUrl || '(absent)')
      // The stored value, not the cleaned one: a BOM or a wrapping quote is
      // invisible in every dashboard that renders it, and cost a day in August.
      check('the STORED value needed no sanitising',
        String(health.app_url_raw ?? '') === CANONICAL_ORIGIN,
        JSON.stringify(health.app_url_raw))
      check('the reported origin is not a forbidden return host',
        forbiddenIn(appUrl).length === 0, forbiddenIn(appUrl).join('; '))
    }
  }

  H('13. What SUPABASE will do with our redirect_to')
  {
    const ref = projectRef(process.env.NEXT_PUBLIC_SUPABASE_URL)
    const token = process.env.SUPABASE_ACCESS_TOKEN
    if (!ref || !token) {
      // CI runs with NEXT_PUBLIC_SUPABASE_URL=https://placeholder.supabase.co and
      // holds no management token. There is nothing to ask.
      skip('the live Supabase URL configuration',
        !token ? 'no SUPABASE_ACCESS_TOKEN (CI holds no management token)' : 'no real Supabase project configured')
      return
    }
    const cfg = await getJson(`https://api.supabase.com/v1/projects/${ref}/config/auth`,
      { Authorization: `Bearer ${token}` })
    if (!cfg) {
      skip('the live Supabase URL configuration', `could not read config/auth for project ${ref}`)
      return
    }

    check('Google is still enabled on the project', cfg.external_google_enabled === true)

    // ── Site URL: the SILENT fallback, and therefore the dangerous field ─────
    const site = cleanOrigin(String(cfg.site_url ?? ''))
    check('Site URL is the canonical origin', site === CANONICAL_ORIGIN, site || '(absent)')
    check('Site URL is not a retired or ephemeral deployment host',
      forbiddenIn(site).length === 0, forbiddenIn(site).join('; '))
    const probe = await probeHost(site || CANONICAL_ORIGIN)
    check('the Site URL fallback resolves to a LIVE host',
      probe.ok, `${site} → ${probe.detail}`)

    // ── The allow list: what gotrue will and will not honour on the way back ──
    const entries = String(cfg.uri_allow_list ?? '').split(',').map(s => s.trim()).filter(Boolean)
    check('the allow list is not empty', entries.length > 0)
    check('the allow list covers the callback the app actually sends',
      entries.some(e => allows(e, CANONICAL_CALLBACK)),
      `${CANONICAL_CALLBACK} matched no entry — gotrue would fall back to Site URL. entries: ${entries.join(' ')}`)
    check('the allow list also covers a callback carrying ?next=',
      entries.some(e => allows(e, CALLBACK_WITH_NEXT)),
      `${CALLBACK_WITH_NEXT} matched no entry; a signed-in return to a deep link would fall back to Site URL`)

    const badEntries = entries.filter(e => forbiddenIn(e).length > 0)
    check('no allow-list entry names a retired or ephemeral deployment host',
      badEntries.length === 0, badEntries.join(' '))

    // ⛔ An over-broad entry is an open redirect that our own safeReturnPath
    // cannot defend against, because gotrue decides this one before our code
    // ever runs. Every shape below is a real bypass an entry like
    // `https://app.edgehq.ca**` (no slash) or a bare `**` would admit.
    const HOSTILE = [
      'https://evil.tld/auth/callback',
      'https://app.edgehq.ca.evil.tld/auth/callback',
      'https://edgequote-git-preview-abc123.vercel.app/auth/callback',
      'http://evil.tld/',
    ]
    const admitted = HOSTILE.filter(h => entries.some(e => allows(e, h)))
    check(`no allow-list entry admits any of ${HOSTILE.length} foreign origins`,
      admitted.length === 0,
      admitted.length ? `admitted: ${admitted.join(' ')}` : '')
  }
}

main()
  .catch(e => fail('the live half could not run', String((e as Error)?.message ?? e)))
  .finally(() => {
    // ⚠️ endProcess, NOT process.exit. This guard now performs network I/O, and
    // process.exit() while undici still holds a pooled keep-alive socket aborts
    // node on Windows with a libuv assertion — AFTER the summary prints, which
    // inside `npm run verify` killed the runner mid-suite. See scripts/lib/shutdown.
    console.log(`\n${failures === 0
      ? '✅ google-auth: all checks passed'
      : `❌ google-auth: ${failures} check(s) failed`}${skipped ? `  (${skipped} live check group(s) skipped)` : ''}`)
    void endProcess(failures === 0 ? 0 : 1)
  })
