// ── App origin verification — npm run verify:app-origin ─────────────────────
//
// THE invariant this pins: the origin every generated link is built from is
// resolved in ONE place, is normalized before use, and a deploy whose configured
// origin is unusable says so instead of sending broken links quietly.
//
// The production state it was written for (2026-08-15): the domain moved to
// app.edgehq.ca and the new value was pasted into Vercel with a UTF-8 BOM
// (U+FEFF) in front of it. /api/health reported
//     "app_url": "<U+FEFF>https://app.edgehq.ca"
// which renders identically to the correct value in every viewer. Downstream,
// each consumer failed in a DIFFERENT direction, so no single symptom pointed
// back here:
//   · new URL(origin)            → throws Invalid URL
//   · Stripe success_url         → rejected; Pay Now 502s
//   · Twilio signature check     → HMAC over the BOM'd URL never matches the one
//                                  Twilio computed → 403 on every inbound SMS
//   · /^https:\/\//.test(base)   → false → the SMS status callback silently
//                                  stopped being attached; sends "succeed" with
//                                  no delivery updates, forever
//
// Four halves, so a regression on any of them fails loudly:
//   1. normalizeOrigin — the pure decision table, including the exact production
//      value that caused the outage.
//   2. The Twilio consequence — proved behaviourally against the real signing
//      algorithm, not asserted in a comment.
//   3. ONE READER — no file outside lib/appOrigin.ts may read the env var to
//      build an origin. This is the half that stops the bug coming back: the
//      normalizer is worthless if the next door re-reads process.env directly.
//   4. Health honesty — an unusable origin degrades, a sanitized one is reported.

import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import crypto from 'node:crypto'
import { normalizeOrigin, configuredAppOrigin, appOriginReport } from '../src/lib/appOrigin'

const ROOT = join(__dirname, '..')

let pass = 0
let fail = 0
function H(t: string) { console.log(`\n═══ ${t} ═══`) }
function check(name: string, actual: unknown, expected: unknown) {
  const a = JSON.stringify(actual); const e = JSON.stringify(expected)
  if (a === e) { pass++; console.log(`  ✅ ${name}`) }
  else { fail++; console.log(`  ❌ ${name}\n     expected: ${e}\n     actual:   ${a}`) }
}
function ok(name: string, cond: boolean, detail = '') {
  if (cond) { pass++; console.log(`  ✅ ${name}`) }
  else { fail++; console.log(`  ❌ ${name}${detail ? `\n     ${detail}` : ''}`) }
}

// Built from char codes so this file stays pure ASCII — a literal BOM in a test
// fixture is invisible in a diff, which is the property that caused the outage.
const BOM = String.fromCharCode(0xFEFF)
const ZWSP = String.fromCharCode(0x200B)
const RLO = String.fromCharCode(0x202E)
const GOOD = 'https://app.edgehq.ca'

// ═══════════════════════════════════════════════════════════════════════════
H('1. normalizeOrigin — the decision table')

check('THE production regression: a BOM-prefixed origin is repaired',
  normalizeOrigin(BOM + GOOD), GOOD)
check('a clean origin is returned unchanged', normalizeOrigin(GOOD), GOOD)
check('a trailing slash is dropped', normalizeOrigin(GOOD + '/'), GOOD)
check('several trailing slashes are dropped', normalizeOrigin(GOOD + '///'), GOOD)
check('surrounding whitespace is dropped', normalizeOrigin('  ' + GOOD + '  '), GOOD)
check('a zero-width space is stripped', normalizeOrigin(GOOD + ZWSP), GOOD)
check('a bidi override is stripped', normalizeOrigin(RLO + GOOD), GOOD)
check('a path is reduced to the origin', normalizeOrigin(GOOD + '/dashboard?x=1'), GOOD)
check('http is allowed (local/preview deploys)', normalizeOrigin('http://localhost:3000'), 'http://localhost:3000')
check('a port is preserved', normalizeOrigin('https://app.edgehq.ca:8443'), 'https://app.edgehq.ca:8443')

// The refusals. Every one of these must read as ABSENT, never as a guess.
check('undefined → absent', normalizeOrigin(undefined), '')
check('null → absent', normalizeOrigin(null), '')
check('empty → absent', normalizeOrigin(''), '')
check('whitespace only → absent', normalizeOrigin('   '), '')
check('invisible characters only → absent', normalizeOrigin(BOM + ZWSP), '')
check('a bare host with no scheme → absent', normalizeOrigin('app.edgehq.ca'), '')
check('not a URL at all → absent', normalizeOrigin('not a url'), '')
check('a javascript: URL → absent', normalizeOrigin('javascript:alert(1)'), '')
check('a mailto: URL → absent', normalizeOrigin('mailto:a@b.ca'), '')
check('a file: URL → absent', normalizeOrigin('file:///etc/passwd'), '')

// ═══════════════════════════════════════════════════════════════════════════
H('2. the Twilio consequence — proved, not asserted')

// The real signing scheme (lib/comms/twilioSignature): HMAC-SHA1 over the URL
// followed by the sorted params, base64. Reproduced here so the test fails if the
// normalizer stops repairing the URL — not merely if a comment goes stale.
function twilioSig(url: string, params: Record<string, string>, token: string): string {
  const data = url + Object.keys(params).sort().map(k => k + params[k]).join('')
  return crypto.createHmac('sha1', token).update(Buffer.from(data, 'utf-8')).digest('base64')
}
const TOKEN = 'test_auth_token'
const PARAMS = { From: '+15875551234', Body: 'STOP', MessageSid: 'SM123' }
const realUrl = `${GOOD}/api/sms/inbound`

ok('a BOM in the origin DOES break the signature (the outage, reproduced)',
  twilioSig(realUrl, PARAMS, TOKEN) !== twilioSig(BOM + realUrl, PARAMS, TOKEN))
ok('…and normalizing the origin makes the signature match again',
  twilioSig(realUrl, PARAMS, TOKEN) === twilioSig(`${normalizeOrigin(BOM + GOOD)}/api/sms/inbound`, PARAMS, TOKEN))

// ═══════════════════════════════════════════════════════════════════════════
H('3. ONE READER — the half that stops it coming back')

// Walk src/ and find every file that reads the env var directly. Only the engine
// may: a door that re-reads process.env has opted out of normalization, which is
// exactly how this bug reached eleven call sites in the first place.
function walk(dir: string, out: string[] = []): string[] {
  for (const e of readdirSync(dir)) {
    const p = join(dir, e)
    if (statSync(p).isDirectory()) walk(p, out)
    else if (/\.(ts|tsx)$/.test(e)) out.push(p)
  }
  return out
}
const ENGINE = join(ROOT, 'src', 'lib', 'appOrigin.ts')
const readers = walk(join(ROOT, 'src')).filter(p => {
  const src = readFileSync(p, 'utf8')
  // Strip line comments before looking: the var is NAMED in prose all over the
  // codebase, and a comment mentioning it is not a reader.
  const code = src.split('\n').filter(l => !l.trimStart().startsWith('//') && !l.trimStart().startsWith('*')).join('\n')
  return /process\.env\.NEXT_PUBLIC_APP_URL/.test(code)
})
const strays = readers.filter(p => p !== ENGINE).map(p => p.slice(ROOT.length + 1).replace(/\\/g, '/'))
ok('lib/appOrigin.ts is the ONLY reader of NEXT_PUBLIC_APP_URL in src/',
  strays.length === 0,
  strays.length ? `also read raw by:\n     ${strays.join('\n     ')}` : '')
ok('…and the engine does read it (the guard is not passing vacuously)',
  readers.includes(ENGINE))

// ═══════════════════════════════════════════════════════════════════════════
H('4. health honesty')

const health = readFileSync(join(ROOT, 'src', 'app', 'api', 'health', 'route.ts'), 'utf8')
ok('health reports the origin links are actually built on', /app_url:\s*appOrigin\.origin/.test(health))
ok('a configured-but-unusable origin degrades the deploy',
  /appOriginUnusable/.test(health) && /degraded\s*=[^\n]*appOriginUnusable/.test(health))
ok('a sanitized origin is reported (the fix must not hide its own evidence)',
  /appOrigin\.sanitized/.test(health) && /app_url_warning/.test(health))

// The report's three states, driven through the real env var.
const saved = process.env.NEXT_PUBLIC_APP_URL
try {
  delete process.env.NEXT_PUBLIC_APP_URL
  check('unset → not configured, not usable, not sanitized',
    appOriginReport(), { origin: null, configured: false, usable: false, sanitized: false })

  process.env.NEXT_PUBLIC_APP_URL = GOOD
  check('clean → usable, nothing sanitized',
    appOriginReport(), { origin: GOOD, configured: true, usable: true, sanitized: false })
  check('configuredAppOrigin returns it', configuredAppOrigin(), GOOD)

  process.env.NEXT_PUBLIC_APP_URL = BOM + GOOD
  check('THE production value → usable, and flagged as sanitized',
    appOriginReport(), { origin: GOOD, configured: true, usable: true, sanitized: true })

  process.env.NEXT_PUBLIC_APP_URL = GOOD + '/'
  check('a trailing slash is benign — repaired but NOT flagged as sanitized',
    appOriginReport(), { origin: GOOD, configured: true, usable: true, sanitized: false })

  process.env.NEXT_PUBLIC_APP_URL = 'app.edgehq.ca'
  check('configured but unusable → configured true, usable false',
    appOriginReport(), { origin: null, configured: true, usable: false, sanitized: false })
} finally {
  if (saved === undefined) delete process.env.NEXT_PUBLIC_APP_URL
  else process.env.NEXT_PUBLIC_APP_URL = saved
}

// ═══════════════════════════════════════════════════════════════════════════
console.log(`\n${fail === 0 ? '✅' : '❌'} verify:app-origin — ${pass} passed, ${fail} failed\n`)
process.exit(fail === 0 ? 0 : 1)
