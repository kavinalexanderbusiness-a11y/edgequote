// ── App origin verification — npm run verify:app-origin ─────────────────────
//
// THE invariant this pins: EVERY door that builds a link, a Stripe return URL or
// a webhook URL gets its origin from lib/appOrigin — never from a raw env read.
//
// Deliberately COMPLEMENTARY to verify:crew-auth, which already drives
// cleanOrigin over the corruption shapes it was written for (BOM, quotes,
// newlines, trailing slash). This guard covers the three things that one does
// not, all learned on 2026-08-15:
//
//   1. THE INVISIBLES trim() CANNOT REACH. cleanOrigin leans on trim() for the
//      BOM, which is correct — U+FEFF is WhiteSpace in ECMAScript. But U+200B
//      and the bidi controls are NOT, so trim() walks straight past them. The
//      explicit replace is therefore load-bearing, and this file is the reason a
//      future mutation test will not delete it as "dead" the way the BOM replace
//      (correctly) was.
//
//   2. ONE READER, ACROSS ALL OF src/. The fix that landed with the crew-invite
//      lane cleaned three doors — crew invite, password reset, health. Seventeen
//      others still read process.env.NEXT_PUBLIC_APP_URL raw, including
//      /api/sms/inbound, where the origin is not decoration: the Twilio signature
//      is an HMAC over the reconstructed URL, so a corrupt origin does not
//      produce an ugly link, it produces 403 on every inbound message. A
//      normalizer only helps the callers that actually call it.
//
//   3. THE TWILIO CONSEQUENCE, PROVED. Re-implements the real signing algorithm
//      and shows the mismatch appearing and disappearing, so the claim in the
//      comments is executable rather than remembered.

import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import crypto from 'node:crypto'
import { cleanOrigin, appOrigin, isUsableOrigin } from '../src/lib/appOrigin'

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

// Built from char codes so this file stays pure ASCII. A literal zero-width
// character in a test fixture is invisible in review — the exact property that
// let the production value stay broken through a migration everyone watched.
const ZWSP = String.fromCharCode(0x200B)   // zero-width space   — NOT trim()-able
const RLO = String.fromCharCode(0x202E)    // bidi override      — NOT trim()-able
const LRM = String.fromCharCode(0x200E)    // left-to-right mark — NOT trim()-able
const BOM = String.fromCharCode(0xFEFF)    // byte-order mark    — trim() takes this one
const GOOD = 'https://app.edgehq.ca'

// ═══════════════════════════════════════════════════════════════════════════
H('1. the invisibles trim() cannot reach')

// The premise, asserted so the reasoning above cannot rot: these really are
// invisible to trim(), so the explicit replace really is doing the work.
check('premise: trim() does NOT remove a zero-width space', (ZWSP + GOOD).trim(), ZWSP + GOOD)
check('premise: trim() DOES remove the BOM (so re-listing it would be dead code)',
  (BOM + GOOD).trim(), GOOD)

check('a leading zero-width space is stripped', cleanOrigin(ZWSP + GOOD), GOOD)
check('a trailing zero-width space is stripped', cleanOrigin(GOOD + ZWSP), GOOD)
check('a bidi override is stripped', cleanOrigin(RLO + GOOD), GOOD)
check('a left-to-right mark is stripped', cleanOrigin(LRM + GOOD), GOOD)
check('one embedded in the host is stripped', cleanOrigin('https://app' + ZWSP + '.edgehq.ca'), GOOD)
check('invisibles combined with the shapes crew-auth covers',
  cleanOrigin(' "' + ZWSP + GOOD + '/" '), GOOD)
check('a value that is ONLY invisible characters is empty, not a stray character',
  cleanOrigin(ZWSP + RLO), '')

// ═══════════════════════════════════════════════════════════════════════════
H('2. isUsableOrigin — the value cleaning cannot rescue')

ok('a clean https origin is usable', isUsableOrigin(GOOD))
ok('http is usable (local and preview deploys)', isUsableOrigin('http://localhost:3000'))
ok('a BOM-corrupted value is STILL usable — cleaning repairs it', isUsableOrigin(BOM + GOOD))
ok('a host with no scheme is NOT usable', !isUsableOrigin('app.edgehq.ca'))
ok('a javascript: URL is NOT usable', !isUsableOrigin('javascript:alert(1)'))
ok('a mailto: URL is NOT usable', !isUsableOrigin('mailto:a@b.ca'))
ok('nonsense is NOT usable', !isUsableOrigin('not a url'))
ok('an absent value is NOT usable', !isUsableOrigin(undefined))

// ═══════════════════════════════════════════════════════════════════════════
H('3. ONE READER — every door, not just the three that were bleeding')

function walk(dir: string, out: string[] = []): string[] {
  for (const e of readdirSync(dir)) {
    const p = join(dir, e)
    if (statSync(p).isDirectory()) walk(p, out)
    else if (/\.(ts|tsx)$/.test(e)) out.push(p)
  }
  return out
}
const ENGINE = join(ROOT, 'src', 'lib', 'appOrigin.ts')
// The ONE deliberate exception, and the reason it is allowed: /api/health
// reports the RAW value as app_url_raw. That is the whole diagnostic — a
// corrupted origin is invisible once cleaned, and reporting only the clean
// answer would have hidden the BOM that broke every link. It is allowed to READ
// the variable; it is asserted below that it never BUILDS a URL from it.
const HEALTH = join(ROOT, 'src', 'app', 'api', 'health', 'route.ts')
const ALLOWED = [ENGINE, HEALTH]
const readers = walk(join(ROOT, 'src')).filter(p => {
  const src = readFileSync(p, 'utf8')
  // The variable is NAMED in prose all over this codebase; a comment is not a read.
  const code = src.split('\n').filter(l => {
    const s = l.trimStart()
    return !s.startsWith('//') && !s.startsWith('*') && !s.startsWith('/*')
  }).join('\n')
  return /process\.env\.NEXT_PUBLIC_APP_URL/.test(code)
})
const strays = readers.filter(p => !ALLOWED.includes(p)).map(p => p.slice(ROOT.length + 1).replace(/\\/g, '/'))

ok('lib/appOrigin.ts is the only place src/ reads NEXT_PUBLIC_APP_URL to build an origin',
  strays.length === 0,
  strays.length ? `still reading it raw:\n     ${strays.join('\n     ')}` : '')
ok('…and the engine does read it (this guard is not passing vacuously)',
  readers.includes(ENGINE))

// The exception has to stay an exception. health may read the raw value, but only
// to REPORT it — the moment it builds a link from it, the allowance is a hole.
const healthSrc = readFileSync(HEALTH, 'utf8')
ok('health reads the raw value only to report it (app_url_raw)',
  /app_url_raw:\s*process\.env\.NEXT_PUBLIC_APP_URL/.test(healthSrc))
ok('…and health builds its reported origin through appOrigin()',
  /app_url:\s*appOrigin\(\)/.test(healthSrc))
ok('…and never interpolates the raw value into a URL',
  !/\$\{\s*process\.env\.NEXT_PUBLIC_APP_URL/.test(healthSrc))

// The doors where a corrupt origin is not cosmetic. Named individually so a
// regression says WHICH one, and so deleting a call site fails loudly.
const CRITICAL: [string, string][] = [
  ['src/app/api/sms/inbound/route.ts', 'the Twilio signature is computed over this URL — a corrupt origin is 403 on every inbound message'],
  ['src/app/api/sms/status/route.ts', 'delivery status callbacks'],
  ['src/app/api/payments/checkout/route.ts', 'Stripe return URLs'],
  ['src/app/api/portal/pay/route.ts', 'Stripe return URLs for the customer portal'],
  ['src/app/api/portal/quote-deposit/route.ts', 'Stripe return URLs for deposits'],
  ['src/app/api/beta/signup/route.ts', 'the beta confirmation link — the front door of the private beta'],
  ['src/app/api/beta/resend/route.ts', 'the re-sent beta confirmation link'],
  ['src/app/api/crew/invite/route.ts', 'the worker setup link'],
  ['src/app/api/public/password-reset/route.ts', 'the password reset link'],
]
for (const [rel, why] of CRITICAL) {
  const src = readFileSync(join(ROOT, rel), 'utf8')
  ok(`${rel.replace('src/app/api/', '')} builds its origin from lib/appOrigin`,
    /from '@\/lib\/appOrigin'/.test(src), why)
}

// ═══════════════════════════════════════════════════════════════════════════
H('4. the Twilio consequence — proved, not asserted')

// The real scheme (lib/comms/twilioSignature): HMAC-SHA1 over the URL followed
// by the sorted params, base64. Reproduced so this fails if the normalizer ever
// stops repairing the URL — not merely if a comment goes stale.
function twilioSig(url: string, params: Record<string, string>, token: string): string {
  const data = url + Object.keys(params).sort().map(k => k + params[k]).join('')
  return crypto.createHmac('sha1', token).update(Buffer.from(data, 'utf-8')).digest('base64')
}
const TOKEN = 'test_auth_token'
const PARAMS = { From: '+15875551234', Body: 'STOP', MessageSid: 'SM123' }
const realUrl = `${GOOD}/api/sms/inbound`
const expected = twilioSig(realUrl, PARAMS, TOKEN)

ok('a corrupt origin DOES break the signature (the outage, reproduced)',
  twilioSig(ZWSP + realUrl, PARAMS, TOKEN) !== expected)
ok('…and cleaning the origin makes it match again',
  twilioSig(`${cleanOrigin(ZWSP + GOOD)}/api/sms/inbound`, PARAMS, TOKEN) === expected)
ok('…the same holds for the BOM that actually shipped',
  twilioSig(`${cleanOrigin(BOM + GOOD)}/api/sms/inbound`, PARAMS, TOKEN) === expected)

// The route must reconstruct the URL from the engine, or none of the above helps.
const inbound = readFileSync(join(ROOT, 'src/app/api/sms/inbound/route.ts'), 'utf8')
ok('the inbound route reconstructs its URL from appOrigin()',
  /appOrigin\(\)/.test(inbound) && !/process\.env\.NEXT_PUBLIC_APP_URL/.test(inbound))
// Guard the guard: signature verification itself must stay strict.
const sig = readFileSync(join(ROOT, 'src/lib/comms/twilioSignature.ts'), 'utf8')
ok('signature verification still fails closed with no token or no signature',
  /if\s*\(!token\s*\|\|\s*!signature\)\s*return false/.test(sig))
ok('…and still compares in constant time', /timingSafeEqual/.test(sig))

// ═══════════════════════════════════════════════════════════════════════════
H('5. the configured origin resolves ahead of the request origin')

const saved = process.env.NEXT_PUBLIC_APP_URL
try {
  process.env.NEXT_PUBLIC_APP_URL = BOM + GOOD + '/'
  check('a corrupt configured value still wins over the request origin, cleaned',
    appOrigin('https://preview.vercel.app'), GOOD)
  delete process.env.NEXT_PUBLIC_APP_URL
  check('with none configured, the request origin is the honest fallback',
    appOrigin('http://localhost:3000'), 'http://localhost:3000')
  check('with neither, the answer is empty — never a guessed host', appOrigin(), '')
} finally {
  if (saved === undefined) delete process.env.NEXT_PUBLIC_APP_URL
  else process.env.NEXT_PUBLIC_APP_URL = saved
}

// ═══════════════════════════════════════════════════════════════════════════
console.log(`\n${fail === 0 ? '✅' : '❌'} verify:app-origin — ${pass} passed, ${fail} failed\n`)
process.exit(fail === 0 ? 0 : 1)
