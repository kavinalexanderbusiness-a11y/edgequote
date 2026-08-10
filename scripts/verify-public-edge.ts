// ── Verify: the unauthenticated edge stays closed ────────────────────────────
//   npm run verify:public-edge
//
// WHY THIS SCRIPT EXISTS
// The tenant audit (verify:tenant-boundary) proved the RLS model is sound and
// that every real hole lived where RLS was OFF. This suite covers the next ring
// out: the surfaces that take no login at all. Their only credential is a
// booking token, and that token is PUBLIC BY CONSTRUCTION — it is the
// /book/<token> URL a business publishes on its own website. So "the caller knew
// the token" proves which business is being addressed and nothing else.
//
// Two exploits were reproduced live on 2026-08-10 and are pinned here:
//
//   1. /api/booking/notify sent the owner an email whose every field — INCLUDING
//      THE SUBJECT LINE — came from the request body, with no quote id required,
//      no rate limit, and no notification_log row. Anyone could POST in a loop
//      and put words they chose in front of a business owner, from this app's own
//      sending domain, wearing the template that owner is trained to act on.
//
//   2. record_booking_measurement inserted its p_quote_id verbatim. As `anon`,
//      two calls landed two fabricated rows carrying 99999 sq ft (56 -> 58).
//      Measurements feed pricing intelligence, so it was a channel for poisoning
//      an owner's pricing data.
//
// The shared lesson, and the thing these checks defend: a token proves WHICH
// TENANT, never WHICH ROW. Every id a public caller names must be re-resolved
// against that tenant before it is trusted, and every public send must be
// derived from persisted data, capped, and logged.
//
// Structural checks against real source, so the contracts survive a refactor.

import { readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'

let failures = 0
const ok = (n: string) => console.log(`  ✓ ${n}`)
const fail = (n: string, d = '') => { failures++; console.log(`  ✗ ${n}${d ? `\n      ${d}` : ''}`) }
const check = (n: string, cond: boolean, d = '') => cond ? ok(n) : fail(n, d)

const ROOT = process.cwd()
const read = (p: string) => readFileSync(join(ROOT, p), 'utf8')
const has = (p: string) => existsSync(join(ROOT, p))

// Every file this suite guards carries a long comment describing the exploit it
// closed — including the literal strings `body.phone`, `body.smsConsent` and
// `Math.random`. Scanning raw source therefore reports the CURE as the DISEASE:
// the first run of this script failed three checks purely on its own prose.
// Deleting the comments to satisfy a regex would be exactly backwards, so the
// scanner reads code only. Walks the source tracking string/template/comment
// state rather than regexing, so an apostrophe in a comment or a `//` inside a
// URL literal cannot desynchronise it.
//
// ⚠️ REGEX LITERALS have to be understood too, not just skipped past. The route
// this guards opens with `.replace(/[&<>"']/g, …)` — a regex containing BOTH
// quote characters. Treating those as string delimiters desynchronises the
// scanner for the rest of the file, and the security comment 13 lines later then
// reads as string contents. That is precisely how the second run of this script
// still reported `body.phone` in code that has not contained it for hours.
// Whether a `/` opens a regex or means division is decided by the previous
// significant token — the standard heuristic, and unambiguous for real source.
const BEFORE_REGEX = new Set(['(', ',', '=', ':', '[', '!', '&', '|', '?', '{', '}', ';', '+', '-', '*', '%', '<', '>', '~', '^', '\n'])
function codeOnly(src: string): string {
  let out = ''
  let i = 0
  let prev = ''   // last significant (non-space) code character emitted
  type S = 'code' | 'line' | 'block' | 'regex' | '"' | "'" | '`'
  let state: S = 'code'
  while (i < src.length) {
    const c = src[i], d = src[i + 1]
    if (state === 'code') {
      if (c === '/' && d === '/') { state = 'line'; i += 2; continue }
      if (c === '/' && d === '*') { state = 'block'; i += 2; continue }
      if (c === '/' && (prev === '' || BEFORE_REGEX.has(prev))) { state = 'regex'; out += c; i++; continue }
      if (c === '"' || c === "'" || c === '`') state = c
      out += c
      if (c.trim()) prev = c
      i++; continue
    }
    if (state === 'regex') {
      // A character class may contain an unescaped `/`, so track it.
      if (c === '\\') { out += c + (d ?? ''); i += 2; continue }
      if (c === '[') { while (i < src.length && src[i] !== ']') { if (src[i] === '\\') { out += src[i]; i++ } ; out += src[i]; i++ } ; continue }
      if (c === '/') { state = 'code'; prev = c }
      out += c; i++; continue
    }
    if (state === 'line') { if (c === '\n') { state = 'code'; out += c } ; i++; continue }
    if (state === 'block') { if (c === '*' && d === '/') { state = 'code'; i += 2 } else i++; continue }
    // inside a string: copy through, honour escapes, end on the matching quote
    if (c === '\\') { out += c + (d ?? ''); i += 2; continue }
    if (c === state) state = 'code'
    out += c; i++
  }
  return out
}
const readCode = (p: string) => codeOnly(read(p))

// ── 1. /api/booking/notify is not a mail relay ───────────────────────────────
console.log('\n═══ A public endpoint cannot be used to send mail of the caller’s choosing ═══')
const NOTIFY = 'src/app/api/booking/notify/route.ts'
check('the booking-notify route exists', has(NOTIFY))
if (has(NOTIFY)) {
  const r = readCode(NOTIFY)

  // The whole fix in one line: the body may name a booking, and nothing else.
  const bodyReads = [...r.matchAll(/body\.(\w+)/g)].map(m => m[1])
  const allowed = new Set(['token', 'quoteId'])
  const extras = [...new Set(bodyReads.filter(k => !allowed.has(k)))]
  check('the request body contributes only `token` and `quoteId`',
    extras.length === 0,
    extras.length
      ? `caller-controlled values are back in this route: ${extras.map(e => `body.${e}`).join(', ')}\n`
        + '      every field of both messages must come from the quote/customer rows the booking persisted'
      : '')

  check('a verifiable quote id is required before anything is sent',
    /if \(!quoteId \|\| !svc\) return/.test(r),
    'without a quote id the owner alert had no anchor at all — that was the hole')

  check('the quote is re-scoped to the business that owns the booking token',
    /\.eq\('id', quoteId\)\.eq\('user_id', userId\)/.test(r),
    'a token proves which tenant is speaking, not that the id the caller named belongs to them')

  check('the route bails when the quote does not resolve',
    /if \(!userId \|\| !quote\) return/.test(r),
    'falling through to a send with an unresolved quote reinstates the relay')

  // Idempotency + ceiling: one alert per booking, and a floor under a flood.
  check('the owner alert is deduped per quote through notification_log',
    /\.eq\('template', OWNER_ALERT_TEMPLATE\)\.eq\('detail', quoteId\)/.test(r),
    'a replayed request must be a no-op, not a second email')
  check('a replay is refused rather than re-sent',
    /if \(already && already\.length > 0\)/.test(r))
  check('there is an hourly ceiling per business',
    /OWNER_ALERT_HOURLY\s*=\s*\d+/.test(r) && />= OWNER_ALERT_HOURLY/.test(r),
    'even genuine bookings must not be turnable into a mail bomb')
  check('a failed send still spends the booking’s one slot',
    /status: r\.sent \? 'sent' : 'error'/.test(r),
    'logging only successes leaves a retry loop open for anyone who can make the send fail')

  // It has to be VISIBLE. The original sent nothing to notification_log at all.
  check('the owner alert is written to the canonical comms log',
    /logSend\(admin, \{/.test(r) && /from '@\/lib\/comms\/log'/.test(r),
    'lib/comms/log.ts is the only permitted notification_log writer — an unlogged send is invisible to the owner')

  // The last caller-controlled string used to land in a CUSTOMER's message.
  check('the customer confirmation takes its address from the quote',
    /address: quote\.address \|\| ''/.test(r),
    'this one is delivered to a real person over the business’s own number — body.address put arbitrary words there')
  check('the customer send still goes through the one consent-gated path',
    /dispatchToCustomer\(/.test(r) && /logDispatch\(/.test(r),
    'consent, threading and the audit trail all live in dispatchToCustomer')
  check('no consent boolean is ever accepted over the wire',
    !/body\.smsConsent|body\.consent/.test(r),
    'the caller asserting the victim consented is how the original SMS relay worked')
}

// ── 2. The migration that closed the DB half is committed ────────────────────
console.log('\n═══ A live database change is explained by a committed migration ═══')
const MIG = 'supabase/RUN-2026-08-10-public-edge-hardening.sql'
check('the public-edge migration is committed', has(MIG),
  'the live database was changed; the repo must carry the migration that explains it')
if (has(MIG)) {
  const m = read(MIG)

  check('record_booking_measurement re-scopes its quote id to the token’s business',
    /not exists \(select 1 from public\.quotes q where q\.id = p_quote_id and q\.user_id = v_user\)/.test(m),
    'this was the one token RPC that inserted a caller-supplied id verbatim')
  check('…and refuses rather than silently dropping the id',
    /\)\s*\n\s*then\s*\n\s*return false;/.test(m),
    'inserting the row with a NULL quote_id would still let a stranger write measurements')
  check('record_booking_measurement is rate limited',
    /count\(\*\) from public\.measurements[\s\S]{0,120}interval '1 hour'[\s\S]{0,40}>= 30/.test(m),
    'an unauthenticated insert with no ceiling is a data-poisoning channel')

  check('join codes come from a CSPRNG',
    /gen_random_bytes/.test(m) && !/floor\(random\(\) \* 31\)/.test(m),
    'PG random() is a per-session PRNG and Supabase pools sessions across tenants — outputs observed by one owner leak the state that generates another owner’s codes')
  check('the code alphabet and length are unchanged (forward-safe, still readable)',
    /length\(v_code\) < 8/.test(m) && /ABCDEFGHJKMNPQRSTUVWXYZ23456789/.test(m),
    'existing codes must keep working and a code still has to be readable over the phone')
  check('modulo bias is rejected rather than ignored',
    /v_byte < 248/.test(m),
    '248 = 8 * 31; without the rejection `% 31` over-weights the first 8 characters')

  check('the migration proves its own work',
    /raise exception/.test(m) && /has_function_privilege\('anon'/.test(m),
    'the previous migration’s verify block caught a real mistake — always include one')
  check('the booking form keeps the anon EXECUTE it depends on',
    /anon lost EXECUTE/.test(m),
    'hardening that breaks the public booking funnel is not hardening')
}

// ── 3. Portal links: forward-safe issuance, and revocation that is reachable ─
console.log('\n═══ A portal link can be widened and, at last, turned off ═══')
const PORTAL = 'src/lib/portal.ts'
check('the portal library exists', has(PORTAL))
if (has(PORTAL)) {
  const p = readCode(PORTAL)

  const len = Number(/const SUFFIX_LEN = (\d+)/.exec(p)?.[1] ?? 0)
  check('new tokens carry at least 12 random characters', len >= 12,
    `SUFFIX_LEN is ${len || 'missing'} — the portal token is a permanent, password-less bearer credential`)
  check('the suffix length is used, not re-hardcoded at the call site',
    /randomSuffix\(\)/.test(p) && !/randomSuffix\(8\)/.test(p),
    'the constant is the contract; a literal at the call site silently un-does it')
  check('the suffix comes from a CSPRNG',
    /crypto\.getRandomValues/.test(p) && !/Math\.random/.test(p))

  // Forward-safe is the whole point: nobody's existing link may break.
  check('an existing token is always reused, so links already sent keep working',
    /\.eq\('revoked', false\)[\s\S]{0,120}if \(existing\?\.token\) return existing\.token/.test(p),
    'widening the suffix must not invalidate a single link a customer already has')

  check('revocation exists and is scoped to the caller’s own customer',
    /revoked: true \}\)\s*\n?\s*\.eq\('user_id', userId\)\.eq\('customer_id', customerId\)/.test(p),
    '`revoked` has been enforced by get_portal_data and portal-access all along, with nothing able to set it')
  check('a failed revoke is reported, not assumed',
    /return !error/.test(p),
    'the undo-contract rule: a persisting action must BRANCH on its write’s error')
  check('rotate never hands back the old token after a failed revoke',
    /if \(!\(await revokePortalAccess\([\s\S]{0,60}\)\)\) return null/.test(p),
    'returning the old link would tell the owner a leaked link was closed while it is still live')
}

// ── 4. The owner can actually reach it ───────────────────────────────────────
// A capability nobody can invoke is the exact bug this fixes; a lib function
// with no caller would just be the same bug one layer up.
console.log('\n═══ …and the owner can reach it without reading the source ═══')
const CUST = 'src/app/dashboard/customers/[id]/page.tsx'
if (has(CUST)) {
  const c = readCode(CUST)
  check('the customer page wires the reset action',
    /rotatePortalToken\(/.test(c) && /resetPortalLink/.test(c))
  check('resetting asks first and is styled as destructive',
    /confirmDialog\(\{[\s\S]{0,320}confirmLabel: 'Reset link', destructive: true/.test(c),
    'it silently breaks a link the customer may be using right now')
  check('a failed reset says the old link is still active',
    /the old one is still active/.test(c),
    'a success toast over a still-live leaked link is the worst possible outcome here')
}

console.log(failures === 0
  ? '\n✅ public-edge: a booking token proves which tenant, never which row — and no public path sends mail of the caller’s choosing.\n'
  : `\n❌ public-edge: ${failures} contract${failures === 1 ? '' : 's'} broken.\n`)
process.exit(failures === 0 ? 0 : 1)
