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

console.log(`\n${failures === 0 ? '✓ a legitimate session survives everything but a real sign-out' : `✗ ${failures} check(s) failed`}\n`)
if (failures > 0) process.exit(1)
