// ── Verify: a legitimate session is never thrown away ────────────────────────
//   npm run verify:auth-session
//
// WHY THIS SCRIPT EXISTS
// EdgeQuote repeatedly dumped a signed-in owner back to the login form, on
// desktop and on mobile, during ordinary use. Three separate defects, each of
// which independently destroys a working session:
//
//   1. AUTOMATION REVOKING A HUMAN'S SESSIONS. supabase-js defaults signOut() to
//      scope:'global' — every session the account holds, on every device. Four
//      verify guards sign in as the REAL production owner and then called a bare
//      signOut(). Production logged 214 `/auth/v1/logout?scope=global` calls in
//      24 hours, every one from `node` on a dev machine. Running the test suite
//      signed the owner out of their own phone.
//
//   2. A REFRESH THROWN AWAY BY A REDIRECT. getUser() silently rotates an expired
//      access token; the new pair is written onto the middleware's response.
//      `NextResponse.redirect()` builds a NEW response carrying none of it, so a
//      request that both refreshed AND redirected sent the browser away holding
//      the OLD token. Rotation is on, and a rotated-away token was measured as
//      still accepted for a window — so this drifts rather than bangs: the
//      browser never advances, re-presenting an ageing token forever, until it
//      finally stops being honoured and the session is stranded.
//
//   3. "I COULDN'T ASK" READ AS "NOBODY'S THERE". `const { data: { user } } =
//      await getUser(); if (!user) redirect('/login')` cannot tell a verified
//      absence from a dropped connection. supabase-js RESOLVES with a null user
//      on network failure, so a phone changing towers looked exactly like a
//      stranger.
//
// Every check below runs the REAL code. No network, no fixtures, deterministic.
// The final section MUTATES lib/authState.ts and re-runs the classification
// suite, so a future edit that folds a transient failure back into "signed out"
// fails HERE rather than on a contractor's phone.

import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { NextResponse } from 'next/server'
import { AuthApiError, AuthRetryableFetchError, AuthSessionMissingError, type AuthError } from '@supabase/supabase-js'
import { classifyAuthError, describeAuthFailure } from '../src/lib/authState'
import { redirectPreservingSession } from '../src/lib/supabase/middleware'
import { canonicalRedirectTarget, type CanonicalInput } from '../src/lib/canonicalHost'
import { secureForOrigin, sessionCookieOptions } from '../src/lib/supabase/cookieSecurity'

let failures = 0
const ok = (name: string) => console.log(`  ✓ ${name}`)
const fail = (name: string, detail: string) => { failures++; console.log(`  ✗ ${name}\n      ${detail}`) }
const check = (name: string, cond: boolean, detail = '') => (cond ? ok(name) : fail(name, detail))

const ROOT = join(__dirname, '..')
// ⚠️ Normalised to \n before ANY match. Git hands these files to a Windows
// checkout as CRLF, and `.` never matches \r — a source scan written with \n
// anchors silently finds nothing and reports green. Same fix, same reason, as
// verify-job-cost's mutation reader.
const read = (rel: string) => readFileSync(join(ROOT, rel), 'utf8').replace(/\r\n?/g, '\n')

// ⚠️ Comments are stripped before any "this pattern must not appear" scan. The
// first run of this guard failed on its OWN documentation: the doc comment above
// redirectPreservingSession names `NextResponse.redirect(` in order to explain
// why it is forbidden, and the scan read the cure as the disease. (verify:
// public-edge learned the same lesson.) Applied to \n-normalised text only —
// `.` does not match \r, so a CRLF checkout would strip nothing.
const stripComments = (src: string) =>
  src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')

// ── 1. The classification predicate ──────────────────────────────────────────
// The single decision that separates "sign this person out" from "we could not
// reach the auth server". Everything else in the contract hangs off it.
console.log('\nclassifyAuthError — a verdict only when there IS one:')
{
  const api = (status: number, code = 'x') => new AuthApiError('rejected', status, code) as AuthError

  check('no error at all → signed-out (the client answered locally)',
    classifyAuthError(null) === 'signed-out')
  check('AuthSessionMissingError → signed-out (no credential was ever presented)',
    classifyAuthError(new AuthSessionMissingError() as AuthError) === 'signed-out')

  // The whole point: these must NOT sign anyone out.
  check('AuthRetryableFetchError → unavailable (offline / DNS / abort)',
    classifyAuthError(new AuthRetryableFetchError('failed to fetch', 0) as AuthError) === 'unavailable')
  check('429 rate limited → unavailable',
    classifyAuthError(api(429, 'over_request_rate_limit')) === 'unavailable')
  check('500 → unavailable', classifyAuthError(api(500)) === 'unavailable')
  check('502 → unavailable', classifyAuthError(api(502)) === 'unavailable')
  check('503 → unavailable', classifyAuthError(api(503)) === 'unavailable')
  check('504 gateway timeout → unavailable', classifyAuthError(api(504)) === 'unavailable')
  check('408 request timeout → unavailable', classifyAuthError(api(408)) === 'unavailable')
  check('status 0 (no transport at all) → unavailable', classifyAuthError(api(0)) === 'unavailable')
  check('an unrecognised failure defaults to unavailable, never to signed-out',
    classifyAuthError(api(418)) === 'unavailable',
    'the default must preserve the session: we do not sign people out over failures we cannot explain')

  // …and these MUST still sign people out. A revoked session that kept working
  // would be the real security regression.
  check('401 → signed-out (the credential was REJECTED)', classifyAuthError(api(401)) === 'signed-out')
  check('403 → signed-out', classifyAuthError(api(403)) === 'signed-out')
  check('400 refresh_token_not_found → signed-out (rotated away, or revoked)',
    classifyAuthError(api(400, 'refresh_token_not_found')) === 'signed-out',
    'this is the shape a password change and an explicit global sign-out both produce')
  check('422 → signed-out', classifyAuthError(api(422)) === 'signed-out')

  check('describeAuthFailure leaks no secret material',
    !/eyJ|token|password/i.test(describeAuthFailure(api(503))),
    'the retry surface prints this string')
}

// ── 2. A redirect must carry the refreshed session ───────────────────────────
// Executable, against the real Next response objects — not a grep. This is the
// defect that was measured on production: /dashboard with a stale token came
// back with a fresh auth cookie, /login with the same stale token came back with
// no Set-Cookie at all, having rotated the token anyway.
console.log('\nredirectPreservingSession — a refresh survives the redirect:')
{
  const carrying = NextResponse.next()
  carrying.cookies.set('sb-proj-auth-token', 'ROTATED', { path: '/', maxAge: 34560000, sameSite: 'lax' })
  carrying.cookies.set('sb-proj-auth-token.1', 'CHUNK', { path: '/' })

  const red = redirectPreservingSession(new URL('https://app.example.ca/login'), carrying)

  check('the redirect still redirects', red.status === 307 || red.status === 302 || red.status === 303,
    `got status ${red.status}`)
  check('Location survives', (red.headers.get('location') || '').endsWith('/login'))
  check('the rotated auth cookie is on the redirect',
    red.cookies.get('sb-proj-auth-token')?.value === 'ROTATED',
    'the browser would have been sent away holding the OLD, already-consumed refresh token')
  check('every chunk survives, not just the first',
    red.cookies.get('sb-proj-auth-token.1')?.value === 'CHUNK',
    'a session larger than 3180 bytes is split across numbered cookies; dropping one corrupts it')
  check('cookie attributes survive (a 400-day maxAge is what outlives a browser restart)',
    red.cookies.get('sb-proj-auth-token')?.maxAge === 34560000,
    'without maxAge the cookie becomes a session cookie and closing the browser signs the owner out')
}

// ── 3. No gate may reach for the two-answer shape ────────────────────────────
console.log('\nSource contract — nothing may collapse the three answers back into two:')
{
  // Every server file that can force a login must go through readUser().
  const GATES = [
    'src/lib/supabase/middleware.ts',
    'src/app/dashboard/layout.tsx',
    'src/app/crew/(app)/layout.tsx',
    'src/app/crew/join/page.tsx',
    'src/app/api/marketing/connect/callback/route.ts',
    'src/app/api/marketing/connect/[platform]/route.ts',
  ]
  for (const rel of GATES) {
    const src = read(rel)
    check(`${rel} reads auth through readUser()`, src.includes('readUser('),
      'a gate that can send someone to /login must use the three-answer read')
    check(`${rel} does not destructure getUser() directly`,
      !/data:\s*\{\s*user\s*\}\s*\}\s*=\s*await\s+supabase\.auth\.getUser\(\)/.test(src),
      'that shape cannot tell a verified absence from a failed read — it is the bug')
  }

  const mw = read('src/lib/supabase/middleware.ts')
  // The helper's own definition holds the only permitted NextResponse.redirect.
  const bareRedirects = stripComments(mw).split('\n')
    .filter(l => l.includes('NextResponse.redirect(') && !l.includes('const redirected ='))
  check('middleware issues no redirect that bypasses redirectPreservingSession',
    bareRedirects.length === 0,
    `found:\n      ${bareRedirects.map(l => l.trim()).join('\n      ')}`)

  check('middleware returns without redirecting when auth is unavailable',
    /auth\.kind === 'unavailable'\)\s*return supabaseResponse/.test(mw),
    'a failed auth read must pass the request through, never bounce it to /login')
}

// ── 4. Automation may not revoke a human's sessions ──────────────────────────
console.log('\nNo script may end sessions it does not own:')
{
  const { readdirSync } = require('node:fs') as typeof import('node:fs')
  // This file is excluded from its own scan: it must be able to NAME the
  // forbidden call in its failure message, and a guard that trips on its own
  // error string can never go green.
  const SELF = 'verify-auth-session.ts'

  // ⚠️ RECURSIVE, and that is not a detail. The first version of this scan read
  // only the top level of scripts/, and the very next merge from main landed a
  // bare signOut() in scripts/lib/verify-fixture.ts — a shared helper called by
  // several guards, i.e. the highest-leverage place for this bug to hide, and
  // the one place the guard could not see. A scan whose blind spot is the shared
  // library is not a guard.
  const walk = (dir: string): string[] =>
    readdirSync(dir, { withFileTypes: true }).flatMap(e =>
      e.isDirectory() ? walk(join(dir, e.name))
        : /\.(ts|mjs|js)$/.test(e.name) && e.name !== SELF ? [join(dir, e.name)] : [])

  const files = walk(join(ROOT, 'scripts'))
  const rel = (f: string) => f.slice(join(ROOT, 'scripts').length + 1).replace(/\\/g, '/')
  const offenders: string[] = []
  for (const f of files) {
    const src = stripComments(readFileSync(f, 'utf8').replace(/\r\n?/g, '\n'))
    // A signOut with no argument is scope:'global' — every device, everywhere.
    for (const line of src.split('\n')) {
      if (/\.auth\.signOut\(\s*\)/.test(line)) offenders.push(`${rel(f)}: ${line.trim()}`)
    }
  }
  check('no bare .auth.signOut() anywhere in scripts/', offenders.length === 0,
    `these revoke EVERY session the account holds, including the owner's phone:\n      ${offenders.join('\n      ')}\n      use .auth.signOut({ scope: 'local' })`)

  // The scripts that sign in as the real owner must say so explicitly.
  const scoped = files.filter(f => stripComments(readFileSync(f, 'utf8')).includes('.auth.signOut('))
  check(`every script that signs out passes an explicit scope (${scoped.length} file(s))`,
    scoped.every(f => readFileSync(f, 'utf8').includes("scope: 'local'")),
    scoped.map(rel).join(', '))
}

// ── 5. The app's own explicit sign-out is DELIBERATELY global ────────────────
// Not an oversight and not in scope to change: a person clicking "Sign out"
// asked for it, and revoking everywhere is the security-positive reading of that
// click. Pinned so a later edit is a decision rather than a drift.
console.log('\nExplicit human sign-out stays global:')
{
  const sidebar = read('src/components/layout/Sidebar.tsx')
  check('Sidebar sign-out revokes every session (default global scope)',
    /supabase\.auth\.signOut\(\s*\)/.test(sidebar),
    'if this becomes scope-limited it must be a deliberate product decision, recorded')
}

// ── 6. MUTATION TESTS ────────────────────────────────────────────────────────
// Every check above passes against the real predicate. These prove the checks
// would FAIL against a broken one — a guard that cannot fail is not a guard.
console.log('\nMutation tests — breaking the predicate must break the suite:')
{
  const enginePath = join(ROOT, 'src', 'lib', 'authState.ts')
  const original = readFileSync(enginePath, 'utf8').replace(/\r\n?/g, '\n')
  const srcDir = join(ROOT, 'src').replace(/\\/g, '/')
  const req = createRequire(join(ROOT, 'scripts', 'verify-auth-session.ts'))

  type Engine = typeof import('../src/lib/authState')
  const apiErr = (status: number) => new AuthApiError('rejected', status, 'x') as AuthError

  const mutations: { name: string; from: string; to: string; wrong: (m: Engine) => boolean }[] = [
    {
      name: 'the default flips to signed-out — every unexplained failure signs people out',
      from: '      return \'unavailable\'\n  }\n}',
      to: '      return \'signed-out\'\n  }\n}',
      wrong: m => m.classifyAuthError(apiErr(503)) === 'signed-out',
    },
    {
      name: 'a network failure is treated as a verdict',
      from: '  if (isAuthRetryableFetchError(error)) return \'unavailable\'',
      to: '  if (isAuthRetryableFetchError(error)) return \'signed-out\'',
      wrong: m => m.classifyAuthError(new AuthRetryableFetchError('failed to fetch', 0) as AuthError) === 'signed-out',
    },
    {
      name: 'a REJECTED credential stops signing anyone out — a revoked session would keep working',
      from: '    case 401:',
      to: '    case 4010:',
      wrong: m => m.classifyAuthError(apiErr(401)) !== 'signed-out',
    },
    {
      name: 'a rotated-away refresh token stops signing anyone out',
      from: '    case 400:',
      to: '    case 4000:',
      wrong: m => m.classifyAuthError(apiErr(400)) !== 'signed-out',
    },
    {
      name: 'rate limiting becomes a sign-out — the exact shape of a rapid-navigation burst',
      from: '  const status = typeof error.status === \'number\' ? error.status : 0',
      to: '  const status = 401',
      wrong: m => m.classifyAuthError(apiErr(429)) === 'signed-out',
    },
  ]

  for (const m of mutations) {
    if (!original.includes(m.from)) {
      fail(`mutation "${m.name}" could not be applied`,
        `the anchor is no longer in src/lib/authState.ts, so this mutation tests nothing:\n      ${m.from}`)
      continue
    }
    const mutated = original.replace(m.from, m.to)
    if (mutated === original) { fail(`mutation "${m.name}" changed nothing`, 'replacement identical'); continue }

    // Written to a temp dir with @/ rewritten to absolute paths, so ONLY
    // authState.ts is mutated and every module it imports is the real one.
    const dir = mkdtempSync(join(tmpdir(), 'authstate-mutant-'))
    const file = join(dir, 'authState.ts')
    writeFileSync(file, mutated.replace(/from '@\/([^']+)'/g, (_x, p) => `from '${srcDir}/${p}'`), 'utf8')

    let observed: boolean
    try {
      observed = m.wrong(req(file) as Engine)
    } catch {
      // A mutant that throws is a mutant that visibly broke — which is what a
      // load-bearing predicate should do.
      observed = true
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }

    check(`caught: ${m.name}`, observed,
      'the mutant produced the SAME answer as the real predicate — it is not load-bearing')
  }
}


// ── 7. ONE HOST HOLDS THE SESSION ────────────────────────────────────────────
// The fourth way this app threw a working session away, and the only one the
// three above cannot explain: the session was never destroyed at all, it was
// simply asked for on a hostname that had never been given it.
//
// Supabase writes the session cookie with no Domain attribute, so it is HOST-
// ONLY. Production serves the SAME deployment on app.edgehq.ca and on the apex
// edgehq.ca — byte-identical /login, and `/` sends you to /dashboard on both. So
// the apex is a fully working second front door that structurally cannot hold a
// session, and OAuth always finishes on app.edgehq.ca because redirectTo is built
// from NEXT_PUBLIC_APP_URL. An owner whose shortcut resolves to the apex signs in,
// is deposited on the other host, and is signed out again on the next reopen —
// every time, by construction.
//
// Measured on production 2026-08-26 in one browser profile, seconds apart:
//   app.edgehq.ca/dashboard → dashboard, 2 auth cookies
//   edgehq.ca/dashboard     → /login?next=%2Fdashboard, ZERO cookies
//   app.edgehq.ca/dashboard → dashboard again
console.log('\nCanonical host — a session on the wrong hostname is no session at all:')
{
  const CANON = 'https://app.edgehq.ca'
  const at = (over: Partial<CanonicalInput>): string | null => canonicalRedirectTarget({
    requestHost: 'app.edgehq.ca', method: 'GET', pathname: '/dashboard', search: '',
    canonicalOrigin: CANON, alreadyHopped: false, ...over,
  })

  // ⭐ THE loop guard. Everything else in this section is secondary to the fact
  // that the canonical host must never be sent to itself.
  check('the canonical host itself is never redirected', at({}) === null,
    'this is an infinite redirect on the front door — the S108 nextUrl.origin failure')
  check('Host is matched case-insensitively and without a trailing dot',
    at({ requestHost: 'APP.EdgeHQ.ca.' }) === null,
    'Host is case-insensitive and app.edgehq.ca. is the same host — comparing raw loops')
  check('the default port is not a different host',
    at({ requestHost: 'app.edgehq.ca:443' }) === null)

  check('the apex is sent to the canonical host, path AND query intact',
    at({ requestHost: 'edgehq.ca', pathname: '/dashboard', search: '?next=%2Fquotes' })
      === 'https://app.edgehq.ca/dashboard?next=%2Fquotes',
    'losing the query loses where the person was going')
  check('a portal deep link keeps its token when it is moved',
    at({ requestHost: 'edgehq.ca', pathname: '/portal/abc123' })
      === 'https://app.edgehq.ca/portal/abc123')

  check('a request that already hopped once is served where it landed',
    at({ requestHost: 'edgehq.ca', alreadyHopped: true }) === null,
    'without the cap, a wrong host comparison becomes a hang instead of one wasted hop')

  // ⚠️⚠️ Machines with a URL in a console live under /api/. They POST, and they
  // do not follow 307s — a canonicalised webhook is a SILENTLY dropped webhook.
  for (const m of ['POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'])
    check(`${m} is never redirected`, at({ requestHost: 'edgehq.ca', method: m }) === null,
      'a redirected webhook is a lost payment record')
  check('GET is redirected', at({ requestHost: 'edgehq.ca', method: 'GET' }) !== null)
  check('HEAD is redirected', at({ requestHost: 'edgehq.ca', method: 'HEAD' }) !== null)

  for (const p of ['/api/stripe/webhook', '/api/twilio/inbound', '/api/cron/autopay', '/monitoring'])
    check(`${p} is exempt from canonicalisation`,
      at({ requestHost: 'edgehq.ca', pathname: p }) === null)
  check('/api/auth/google/start is exempt — it does its own hop BEFORE writing PKCE state',
    at({ requestHost: 'edgehq.ca', pathname: '/api/auth/google/start' }) === null,
    'that route must canonicalise before it writes the verifier, which is stricter than this')

  // Where the hostname IS the deployment, canonicalising deletes it.
  for (const h of ['localhost:3000', '127.0.0.1:3000', '[::1]:3000', 'edgequote-git-x.vercel.app'])
    check(`${h} is never canonicalised`, at({ requestHost: h }) === null,
      'a preview deploy redirected to production is a preview you can no longer test')

  check('no configured origin → serve it here, never a guessed hostname',
    at({ requestHost: 'edgehq.ca', canonicalOrigin: '' }) === null)
  check('an unusable configured origin is refused (no scheme)',
    at({ requestHost: 'edgehq.ca', canonicalOrigin: 'app.edgehq.ca' }) === null)
  check('a non-http configured origin is refused outright',
    at({ requestHost: 'edgehq.ca', canonicalOrigin: 'ftp://evil.example' }) === null,
    'NEXT_PUBLIC_APP_URL is typed by a human — a non-web scheme must never become a redirect target')
  check('no Host header at all → nothing is moved',
    at({ requestHost: '', canonicalOrigin: CANON }) === null)

  // The app-origin corruption shapes, re-asked HERE: a BOM or zero-width in the
  // configured value must not make the canonical host unrecognisable, because the
  // symptom would be the canonical host redirecting to itself forever.
  check('a BOM in the configured origin does not break the comparison',
    at({ requestHost: 'app.edgehq.ca', canonicalOrigin: '﻿https://app.edgehq.ca' }) === null)
  check('a trailing slash in the configured origin does not break the comparison',
    at({ requestHost: 'app.edgehq.ca', canonicalOrigin: 'https://app.edgehq.ca/' }) === null)

  // ⛔ The request contributes a path and a query. It does not get a vote on the host.
  for (const p of ['//evil.example/x', '/\\evil.example', '/\\/evil.example', 'https://evil.example/x'])
    for (const s of ['', '?a=b']) {
      const t = at({ requestHost: 'edgehq.ca', pathname: p, search: s })
      check(`hostile pathname ${JSON.stringify(p + s)} cannot leave the canonical origin`,
        t === null || new URL(t).origin === CANON, `got ${String(t)}`)
    }
}

// ── 7b. The middleware must ASK before it reads a session ────────────────────
console.log('\nThe host decision runs before any auth read:')
{
  const root = read('src/middleware.ts')
  const bare = stripComments(root)
  const iCanon = bare.indexOf('canonicalRedirectTarget(')
  const iSession = bare.indexOf('updateSession(request)')
  check('src/middleware.ts asks canonicalRedirectTarget at all', iCanon >= 0)
  check('it asks BEFORE updateSession', iCanon >= 0 && iSession >= 0 && iCanon < iSession,
    'on a non-canonical host an auth read can only answer "signed-out" — acting on that IS the bug')
  check('the host comes from the Host header, not nextUrl.origin',
    /x-forwarded-host/.test(bare) && !/requestHost:\s*request\.nextUrl\.origin/.test(bare),
    'nextUrl.origin is framework-normalised and is not the address the browser used — S108 measured the loop')
  check('appOrigin() is asked WITHOUT a request fallback',
    /canonicalOrigin:\s*appOrigin\(\)/.test(bare),
    'appOrigin(req.origin) can never disagree with the request, so the check silently becomes a no-op')
  check('the redirect carries the one-hop cap cookie', /CANON_HOP_COOKIE/.test(bare))
  check('the canonical redirect is not cached', /'Cache-Control':\s*'no-store'/.test(bare))
}

// ── 7c. MUTATION TESTS — the host rule must be load-bearing ──────────────────
console.log('\nMutation tests — breaking the host rule must break the suite:')
{
  const enginePath = join(ROOT, 'src', 'lib', 'canonicalHost.ts')
  const original = readFileSync(enginePath, 'utf8').replace(/\r\n?/g, '\n')
  const srcDir = join(ROOT, 'src').replace(/\\/g, '/')
  const req = createRequire(join(ROOT, 'scripts', 'verify-auth-session.ts'))
  type Engine = typeof import('../src/lib/canonicalHost')

  const CANON = 'https://app.edgehq.ca'
  const call = (m: Engine, over: Partial<CanonicalInput>) => m.canonicalRedirectTarget({
    requestHost: 'app.edgehq.ca', method: 'GET', pathname: '/dashboard', search: '',
    canonicalOrigin: CANON, alreadyHopped: false, ...over,
  })

  const mutations: { name: string; from: string; to: string; wrong: (m: Engine) => boolean }[] = [
    {
      name: 'the canonical host stops recognising ITSELF — an infinite redirect on the front door',
      from: '  if (requestHost === canonicalHost) return null',
      to: '  if (requestHost === canonicalHost && false) return null',
      wrong: m => call(m, {}) !== null,
    },
    {
      name: 'the one-hop cap is removed — a wrong comparison becomes a hang',
      from: '  if (input.alreadyHopped) return null',
      to: '  if (input.alreadyHopped && false) return null',
      wrong: m => call(m, { requestHost: 'edgehq.ca', alreadyHopped: true }) !== null,
    },
    {
      name: 'POSTs start being redirected — every webhook silently dropped',
      from: "  if (method !== 'GET' && method !== 'HEAD') return null",
      to: "  if (method !== 'GET' && method !== 'HEAD' && false) return null",
      wrong: m => call(m, { requestHost: 'edgehq.ca', method: 'POST' }) !== null,
    },
    {
      name: 'the /api/ exemption is removed — Stripe is redirected instead of answered',
      from: '  if (CANONICAL_EXEMPT_PREFIXES.some(p => pathname === p || pathname.startsWith(p))) return null',
      to: '  if (false) return null',
      wrong: m => call(m, { requestHost: 'edgehq.ca', pathname: '/api/stripe/webhook' }) !== null,
    },
    {
      name: 'preview and dev hosts start being canonicalised away',
      from: '  if (isFixedHost(requestHost)) return null',
      to: '  if (isFixedHost(requestHost) && false) return null',
      wrong: m => call(m, { requestHost: 'localhost:3000' }) !== null,
    },
    {
      name: 'the origin re-assertion is removed — a crafted path walks the URL off our host',
      from: '    if (target.origin !== base.origin) return null',
      to: '    if (false) return null',
      wrong: m => {
        const t = call(m, { requestHost: 'edgehq.ca', pathname: '//evil.example/x' })
        return typeof t === 'string' && new URL(t).origin !== CANON
      },
    },
    {
      name: 'a non-http configured origin stops being refused — the redirect leaves the web',
      from: "  if (!isUsableOrigin(clean)) return ''",
      to: "  if (false) return ''",
      wrong: m => {
        const t = call(m, { requestHost: 'edgehq.ca', canonicalOrigin: 'ftp://evil.example' })
        return typeof t === 'string' && !t.startsWith('https://')
      },
    },
    {
      name: 'host normalisation is dropped — APP.EdgeHQ.ca redirects to itself forever',
      from: "  return raw.trim().toLowerCase().replace(/\\.$/, '').replace(/:(80|443)$/, '')",
      to: '  return raw',
      wrong: m => call(m, { requestHost: 'APP.EdgeHQ.ca' }) !== null,
    },
  ]

  for (const mu of mutations) {
    if (!original.includes(mu.from)) {
      fail(`mutation "${mu.name}" could not be applied`,
        `the anchor is no longer in src/lib/canonicalHost.ts, so this mutation tests nothing:\n      ${mu.from}`)
      continue
    }
    const mutated = original.replace(mu.from, mu.to)
    if (mutated === original) { fail(`mutation "${mu.name}" changed nothing`, 'replacement identical'); continue }

    // Only canonicalHost.ts is mutated; its relative import of appOrigin is
    // rewritten to the REAL module so the corruption-cleaning stays honest.
    const dir = mkdtempSync(join(tmpdir(), 'canonhost-mutant-'))
    const file = join(dir, 'canonicalHost.ts')
    writeFileSync(file, mutated.replace(/from '\.\/([^']+)'/g, (_x, p) => `from '${srcDir}/lib/${p}'`), 'utf8')

    let observed: boolean
    try {
      observed = mu.wrong(req(file) as Engine)
    } catch {
      observed = true
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }

    check(`caught: ${mu.name}`, observed,
      'the mutant produced the SAME answer as the real rule — it is not load-bearing')
  }
}

// ── 8. The session cookie carries Secure ─────────────────────────────────────
// Measured on production 2026-08-26: `secure=false` on both `sb-…-auth-token`
// chunks. That is @supabase/ssr's default (DEFAULT_COOKIE_OPTIONS names path,
// sameSite, httpOnly and maxAge, and says nothing about Secure), not a decision
// anyone made here.
//
// ⚠️ httpOnly stays FALSE and that is not a defect: @supabase/ssr's browser
// client reads the session out of document.cookie, so an httpOnly session cookie
// would mean no client-side auth at all. It is asserted below so the day someone
// "hardens" it, the failure is here rather than a dead app.
console.log('\nSecure on the session cookie — derived from configuration, not from a header:')
{
  const saved = process.env.NEXT_PUBLIC_APP_URL

  check('https origin → Secure', secureForOrigin('https://app.edgehq.ca') === true)
  check('http origin → NOT Secure (a Secure cookie is dropped over http)',
    secureForOrigin('http://localhost:3000') === false,
    'hard-coding true makes local dev and LAN testing on a real phone unable to sign in')
  check('scheme is matched case-insensitively',
    secureForOrigin('HTTPS://APP.EDGEHQ.CA') === true)
  check('empty / null origin → NOT Secure', !secureForOrigin('') && !secureForOrigin(null))
  check('a look-alike scheme is not https',
    !secureForOrigin('httpsx://app.edgehq.ca') && !secureForOrigin('ftp://app.edgehq.ca'))

  // ⭐⭐ THE anti-downgrade property. The configured origin decides, so a request
  // that arrives claiming to be plaintext cannot talk this into writing a
  // non-Secure session cookie.
  process.env.NEXT_PUBLIC_APP_URL = 'https://app.edgehq.ca'
  check('a plaintext REQUEST cannot downgrade a configured https deploy',
    sessionCookieOptions('http://127.0.0.1:3161').secure === true,
    'reading x-forwarded-proto here would hand an attacker a non-Secure session cookie on request')
  check('the configured origin still wins with no request in hand',
    sessionCookieOptions().secure === true)
  check('it returns ONLY secure — anything else joins the cookie identity',
    JSON.stringify(Object.keys(sessionCookieOptions())) === '["secure"]')

  delete process.env.NEXT_PUBLIC_APP_URL
  check('unconfigured deploy falls back to the request origin (local dev)',
    sessionCookieOptions('http://localhost:3000').secure === false)
  check('unconfigured deploy on an https preview is still Secure',
    sessionCookieOptions('https://edgequote-git-x.vercel.app').secure === true)

  if (saved === undefined) delete process.env.NEXT_PUBLIC_APP_URL
  else process.env.NEXT_PUBLIC_APP_URL = saved

  // Every client that can WRITE the session must be constructed with it. Missing
  // one means a token rotation silently downgrades a cookie another path wrote
  // correctly — invisible, because the app keeps working either way.
  const WRITERS = [
    'src/lib/supabase/client.ts',
    'src/lib/supabase/server.ts',
    'src/lib/supabase/middleware.ts',
    'src/app/auth/callback/route.ts',
    'src/app/api/auth/google/start/route.ts',
  ]
  for (const rel of WRITERS)
    check(`${rel} passes cookieOptions: sessionCookieOptions(...)`,
      /cookieOptions:\s*sessionCookieOptions\(/.test(stripComments(read(rel))),
      'a client without it writes the @supabase/ssr default, which is secure=false')

  check('the browser client stays readable to JS (httpOnly must NOT be set)',
    !/httpOnly:\s*true/.test(stripComments(read('src/lib/supabase/client.ts'))),
    '@supabase/ssr reads the session from document.cookie — httpOnly would break auth entirely')

  // ⛔ No second auth store. The session lives in cookies and nowhere else.
  for (const rel of WRITERS.concat(['src/lib/authState.ts'])) {
    const src = stripComments(read(rel))
    check(`${rel} adds no localStorage/sessionStorage auth store`,
      !/localStorage|sessionStorage/.test(src),
      'two persistence stores means two answers to "are you signed in" and one of them goes stale')
  }
}

// ── 8b. MUTATION TESTS — the redirect must really carry the refresh ──────────
// Section 2 asserts the behaviour against the real helper. These prove those
// assertions would FAIL against a broken one: the production defect they encode
// (a redirect that drops a rotated token) is invisible by inspection, which is
// exactly the kind that comes back.
console.log('\nMutation tests — breaking the refresh hand-off must break the suite:')
{
  const enginePath = join(ROOT, 'src', 'lib', 'supabase', 'middleware.ts')
  const original = readFileSync(enginePath, 'utf8').replace(/\r\n?/g, '\n')
  const srcDir = join(ROOT, 'src').replace(/\\/g, '/')
  const req = createRequire(join(ROOT, 'scripts', 'verify-auth-session.ts'))
  type Mw = typeof import('../src/lib/supabase/middleware')

  /** The same rotation section 2 asserts on, run against a mutant. */
  const carry = () => {
    const c = NextResponse.next()
    c.cookies.set('sb-proj-auth-token', 'ROTATED', { path: '/', maxAge: 34560000, sameSite: 'lax' })
    c.cookies.set('sb-proj-auth-token.1', 'CHUNK', { path: '/' })
    return c
  }

  const mutations: { name: string; from: string; to: string; wrong: (m: Mw) => boolean }[] = [
    {
      name: 'the redirect stops carrying cookies at all — the measured production defect',
      from: '  for (const cookie of carrying.cookies.getAll()) redirected.cookies.set(cookie)',
      to:   '  for (const cookie of [] as ReturnType<typeof carrying.cookies.getAll>) redirected.cookies.set(cookie)',
      wrong: m => m.redirectPreservingSession(new URL('https://a.example/login'), carry())
        .cookies.get('sb-proj-auth-token')?.value !== 'ROTATED',
    },
    {
      name: 'only the FIRST chunk is carried — a Google-sized session arrives corrupt',
      from: '  for (const cookie of carrying.cookies.getAll()) redirected.cookies.set(cookie)',
      to:   '  for (const cookie of carrying.cookies.getAll().slice(0, 1)) redirected.cookies.set(cookie)',
      wrong: m => m.redirectPreservingSession(new URL('https://a.example/login'), carry())
        .cookies.get('sb-proj-auth-token.1')?.value !== 'CHUNK',
    },
    {
      name: 'name and value survive but the ATTRIBUTES are dropped — a 400-day cookie becomes session-only',
      from: '  for (const cookie of carrying.cookies.getAll()) redirected.cookies.set(cookie)',
      to:   '  for (const cookie of carrying.cookies.getAll()) redirected.cookies.set(cookie.name, cookie.value)',
      wrong: m => m.redirectPreservingSession(new URL('https://a.example/login'), carry())
        .cookies.get('sb-proj-auth-token')?.maxAge !== 34560000,
    },
  ]

  for (const mu of mutations) {
    if (!original.includes(mu.from)) {
      fail(`mutation "${mu.name}" could not be applied`,
        `the anchor is no longer in src/lib/supabase/middleware.ts:\n      ${mu.from}`)
      continue
    }
    const mutated = original.replace(mu.from, mu.to)
    if (mutated === original) { fail(`mutation "${mu.name}" changed nothing`, 'replacement identical'); continue }

    const dir = mkdtempSync(join(tmpdir(), 'mw-mutant-'))
    const file = join(dir, 'middleware.ts')
    writeFileSync(file, mutated
      .replace(/from '@\/([^']+)'/g, (_x, p) => `from '${srcDir}/${p}'`)
      .replace(/from '\.\/([^']+)'/g, (_x, p) => `from '${srcDir}/lib/supabase/${p}'`), 'utf8')

    let observed: boolean
    try { observed = mu.wrong(req(file) as Mw) } catch { observed = true }
    finally { rmSync(dir, { recursive: true, force: true }) }

    check(`caught: ${mu.name}`, observed,
      'the mutant behaved like the real helper — section 2 is not actually pinning this')
  }
}

// ── 8c. MUTATION TESTS — the Secure flag must be load-bearing ────────────────
console.log('\nMutation tests — breaking the Secure rule must break the suite:')
{
  const enginePath = join(ROOT, 'src', 'lib', 'supabase', 'cookieSecurity.ts')
  const original = readFileSync(enginePath, 'utf8').replace(/\r\n?/g, '\n')
  const srcDir = join(ROOT, 'src').replace(/\\/g, '/')
  const req = createRequire(join(ROOT, 'scripts', 'verify-auth-session.ts'))
  type Engine = typeof import('../src/lib/supabase/cookieSecurity')

  const mutations: { name: string; from: string; to: string; wrong: (m: Engine) => boolean }[] = [
    {
      name: 'Secure is never set — production writes a plaintext-capable session cookie',
      from: "  return typeof origin === 'string' && origin.trim().toLowerCase().startsWith('https://')",
      to: '  return false',
      wrong: m => m.secureForOrigin('https://app.edgehq.ca') === false,
    },
    {
      name: 'Secure is ALWAYS set — local dev and LAN phone testing can no longer sign in',
      from: "  return typeof origin === 'string' && origin.trim().toLowerCase().startsWith('https://')",
      to: '  return true',
      wrong: m => m.secureForOrigin('http://localhost:3000') === true,
    },
    {
      name: 'the REQUEST decides instead of the configuration — a header downgrades the cookie',
      from: '  return { secure: secureForOrigin(appOrigin(requestOrigin)) }',
      to: '  return { secure: secureForOrigin(requestOrigin) }',
      wrong: m => {
        const saved = process.env.NEXT_PUBLIC_APP_URL
        process.env.NEXT_PUBLIC_APP_URL = 'https://app.edgehq.ca'
        try { return m.sessionCookieOptions('http://127.0.0.1:3161').secure === false }
        finally {
          if (saved === undefined) delete process.env.NEXT_PUBLIC_APP_URL
          else process.env.NEXT_PUBLIC_APP_URL = saved
        }
      },
    },
  ]

  for (const mu of mutations) {
    if (!original.includes(mu.from)) {
      fail(`mutation "${mu.name}" could not be applied`,
        `the anchor is no longer in src/lib/supabase/cookieSecurity.ts:\n      ${mu.from}`)
      continue
    }
    const mutated = original.replace(mu.from, mu.to)
    if (mutated === original) { fail(`mutation "${mu.name}" changed nothing`, 'replacement identical'); continue }

    const dir = mkdtempSync(join(tmpdir(), 'cookiesec-mutant-'))
    const file = join(dir, 'cookieSecurity.ts')
    writeFileSync(file, mutated.replace(/from '@\/([^']+)'/g, (_x, p) => `from '${srcDir}/${p}'`), 'utf8')

    let observed: boolean
    try { observed = mu.wrong(req(file) as Engine) } catch { observed = true }
    finally { rmSync(dir, { recursive: true, force: true }) }

    check(`caught: ${mu.name}`, observed,
      'the mutant produced the SAME answer as the real rule — it is not load-bearing')
  }
}
console.log(`\n${failures === 0 ? '✓ a legitimate session survives everything but a real sign-out' : `✗ ${failures} check(s) failed`}\n`)
if (failures > 0) process.exit(1)
