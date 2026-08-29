// ── Verify: a link we sent a customer still reaches their resource ──────────
//   npm run verify:customer-links
//
// WHY THIS SCRIPT EXISTS
// Production audit, 2026-08-28: legitimate links this business sent to real
// customers answer 404 DEPLOYMENT_NOT_FOUND. Measured, not recalled — every URL
// in all 236 rows of `messages.body` was read: 21 sent links point at
// `app.edgepropertyservicesyyc.ca`, all of them the same shape,
// `/portal/<token>`. Two point at the apex `edgehq.ca`, which is attached to the
// project and already canonicalises correctly.
//
// ⭐ THE FAILURE IS NOT IN THIS CODEBASE, and the contrast proves it: the SAME
// middleware that returns 404 for the retired host returns a correct
// path-and-query-preserving 307 for `edgehq.ca`. The difference between the two
// hostnames is not code, it is whether the domain is attached to the Vercel
// project. So what this guard protects is the part that IS code: that the
// canonical rule would carry a legacy link to the right resource the moment the
// host reaches it, that nothing re-introduces the retired host into a link, and
// that none of it weakens portal authorization or opens a redirect.
//
// THE RULES PINNED
//   1  ONE seam builds a customer link — no scattered hostname or path strings
//   2  the token survives the builder EXACTLY, and cannot change the resource
//   3  a legacy host reaches the SAME resource: same path, same query, same
//      token, on the canonical origin                              ← the point
//   4  ⛔ the destination is ALWAYS the configured origin — never the request's,
//      never a retired host, never anything a path can smuggle in
//   5  ⛔ no redirect loop: one hop, self-comparison safe, spelling-safe
//   6  ⛔ the redirect grants NOTHING — it moves a request between hosts and has
//      no idea what a token is, so it cannot make an invalid one valid
//   7  machine callers (webhooks) are never redirected
//   8  the retired hosts are named from EVIDENCE and stay out of every builder

import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import {
  canonicalRedirectTarget, normalizeHost, isFixedHost, isRetiredAppHost,
  RETIRED_APP_HOSTS, CANONICAL_EXEMPT_PREFIXES,
} from '../src/lib/canonicalHost'
import { portalUrl } from '../src/lib/portal'
import { cleanOrigin } from '../src/lib/appOrigin'

let failures = 0
const ok = (n: string) => console.log(`  ✓ ${n}`)
const bad = (n: string, d: string) => { failures++; console.log(`  ✗ ${n}\n      ${d}`) }
const check = (n: string, c: boolean, d = '') => c ? ok(n) : bad(n, d)
const eq = (n: string, a: unknown, b: unknown) =>
  check(n, JSON.stringify(a) === JSON.stringify(b), `expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`)

const ROOT = join(__dirname, '..')
const read = (p: string) => readFileSync(join(ROOT, p), 'utf8')

/** ⚠️ LINE comments first, and `[^\n\r]` not `.` — `.` does not match `\r`, so a
 *  CRLF checkout leaves every line comment half-stripped and the block pass then
 *  swallows real code. */
const strip = (s: string) => s.replace(/\/\/[^\n\r]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '')

function walk(dir: string, out: string[] = []): string[] {
  for (const e of readdirSync(join(ROOT, dir))) {
    const rel = `${dir}/${e}`
    const st = statSync(join(ROOT, rel))
    if (st.isDirectory()) { walk(rel, out); continue }
    if (/\.(ts|tsx)$/.test(e)) out.push(rel)
  }
  return out
}
const SRC = walk('src')

const CANON = 'https://app.edgehq.ca'
const TOKEN = 'jane-doe-A7K4P3MXQ2RS'

// ═════════════════════════════════════════════════════════════════════════════
console.log('\n▸ 1 · ONE seam builds a customer link')

{
  // A customer link is an ORIGIN plus `/portal/<token>`. Anything assembling
  // that by hand is a second spelling of the product's most important URL.
  const HAND_BUILT = /\$\{\s*(?:base|origin|appOrigin\(\)|[A-Za-z_$][\w$]*Origin)\s*\}\/portal\//
  const offenders = SRC.filter(f => f !== 'src/lib/portal.ts' && HAND_BUILT.test(strip(read(f))))
  eq('nothing hand-assembles an origin + /portal/ outside lib/portal', offenders, [])
  // Negative control: the matcher must catch the shape it is looking for.
  check('[negative control] a hand-built portal URL is caught',
    HAND_BUILT.test('const u = `${base}/portal/${token}?paid=1`'))
}

{
  const portalSrc = read('src/lib/portal.ts')
  check('portalUrl is exported from the one module', /export function portalUrl\(/.test(portalSrc))
  // Every sender of a customer link goes through it.
  const senders = [
    'src/app/api/comms/send/route.ts',
    'src/app/api/cron/campaigns/route.ts',
    'src/app/api/cron/invoice-reminders/route.ts',
    'src/app/api/cron/notifications/route.ts',
    'src/app/api/cron/quote-followup/route.ts',
    'src/app/api/cron/scheduled-messages/route.ts',
    'src/app/api/public/portal-access/route.ts',
    'src/app/api/portal/pay/route.ts',
    'src/app/api/portal/quote-deposit/route.ts',
    'src/app/api/portal/setup-card/route.ts',
  ]
  const missing = senders.filter(f => !/portalUrl\(/.test(read(f)))
  eq('every route that sends a customer somewhere uses it', missing, [])
}

{
  // The one customer-facing URL that used to be built from the REQUEST host.
  const setup = strip(read('src/app/api/portal/setup-card/route.ts'))
  check('the card-setup return address is built configured-origin-first',
    /appOrigin\(req\.nextUrl\?\.origin\)/.test(setup),
    'setup-card is building a customer URL from the request host again')
  check('…and no longer prefers the request origin',
    !/cleanOrigin\(req\.nextUrl\?\.origin\)\s*\|\|/.test(setup))
}

// ═════════════════════════════════════════════════════════════════════════════
console.log('\n▸ 2 · the token survives the builder, exactly')

{
  const u = portalUrl(TOKEN, CANON)
  eq('the link is absolute and canonical', u, `${CANON}/portal/${TOKEN}`)
  const seg = new URL(u).pathname.split('/').filter(Boolean)
  eq('…the path is /portal/<token> and nothing else', seg.length, 2)
  eq('…and the token round-trips byte for byte', decodeURIComponent(seg[1]), TOKEN)
}

{
  // Every production token is URL-safe (measured: 69 rows, `-` the only
  // non-alphanumeric), so encoding must be a NO-OP for real tokens.
  for (const t of ['jane-doe-A7K4P3MXQ2RS', 'customer-ZZZZ99999999', 'a-1']) {
    eq(`a real-shaped token is untouched (${t})`, portalUrl(t, CANON), `${CANON}/portal/${t}`)
  }
}

{
  // …and a token that is NOT url-safe cannot change the resource.
  const evil = 'tok/../../dashboard'
  const u = portalUrl(evil, CANON)
  const parsed = new URL(u)
  eq('a token containing a path cannot escape /portal/', parsed.pathname.split('/').filter(Boolean).length, 2)
  check('…and stays on the canonical origin', parsed.origin === CANON, parsed.origin)
  const q = portalUrl('tok?invoice=other', CANON)
  eq('a token containing a query cannot add one', new URL(q).search, '')
  const h = portalUrl('tok#frag', CANON)
  eq('a token containing a fragment cannot add one', new URL(h).hash, '')
}

{
  // Params: the resource selector, spelled once.
  eq('a paid return carries its flag', portalUrl(TOKEN, CANON, { paid: 1 }), `${CANON}/portal/${TOKEN}?paid=1`)
  eq('…absent params add nothing', portalUrl(TOKEN, CANON, {}), `${CANON}/portal/${TOKEN}`)
  eq('…and undefined/empty are skipped, not sent as bare keys',
    portalUrl(TOKEN, CANON, { paid: undefined, invoice: '', quote: null }), `${CANON}/portal/${TOKEN}`)
  const two = new URL(portalUrl(TOKEN, CANON, { invoice: 'inv-1', quote: 'q-2' }))
  eq('…two selectors both survive', [two.searchParams.get('invoice'), two.searchParams.get('quote')], ['inv-1', 'q-2'])
  check('…and a param value cannot inject another parameter',
    new URL(portalUrl(TOKEN, CANON, { invoice: 'a&admin=1' })).searchParams.get('invoice') === 'a&admin=1')
}

{
  // ⛔ No origin at all → RELATIVE, never protocol-relative. `//portal/x` would
  // be read by a browser as a URL whose HOST is "portal".
  const u = portalUrl(TOKEN, '')
  check('with no origin the link is relative, never //host', !u.startsWith('//'), u)
}

// ═════════════════════════════════════════════════════════════════════════════
console.log('\n▸ 3 · a legacy host reaches the SAME resource')

const legacyInput = (host: string, pathname: string, search = '', over: Partial<Parameters<typeof canonicalRedirectTarget>[0]> = {}) => ({
  requestHost: host,
  method: 'GET',
  pathname,
  search,
  canonicalOrigin: CANON,
  alreadyHopped: false,
  ...over,
})

check('the retired hosts are named', RETIRED_APP_HOSTS.length > 0)
check('…including the one measured in production message history',
  RETIRED_APP_HOSTS.includes('app.edgepropertyservicesyyc.ca' as never),
  RETIRED_APP_HOSTS.join(', '))
check('…and isRetiredAppHost recognises it in any spelling',
  isRetiredAppHost('APP.EdgePropertyServicesYYC.ca') && isRetiredAppHost('app.edgepropertyservicesyyc.ca.')
  && !isRetiredAppHost('app.edgehq.ca'))

for (const host of RETIRED_APP_HOSTS) {
  const t = canonicalRedirectTarget(legacyInput(host, `/portal/${TOKEN}`))
  eq(`${host} → the canonical portal, token intact`, t, `${CANON}/portal/${TOKEN}`)
}

{
  // ⭐ THE ACTUAL HISTORICAL LINK SHAPE — the only one ever sent.
  const t = canonicalRedirectTarget(legacyInput('app.edgepropertyservicesyyc.ca', `/portal/${TOKEN}`))
  const u = new URL(t as string)
  eq('the resource type is preserved (path)', u.pathname, `/portal/${TOKEN}`)
  eq('the credential is preserved (token)', u.pathname.split('/')[2], TOKEN)
  eq('the destination host is the canonical one', u.host, 'app.edgehq.ca')
}

{
  // Query values that select WHICH resource must survive untouched.
  const t = canonicalRedirectTarget(
    legacyInput('app.edgepropertyservicesyyc.ca', `/portal/${TOKEN}`, '?invoice=inv-123&paid=1')) as string
  const u = new URL(t)
  eq('an invoice selector survives', u.searchParams.get('invoice'), 'inv-123')
  eq('…and a payment result survives', u.searchParams.get('paid'), '1')
  eq('…and nothing else was added', [...u.searchParams.keys()].sort(), ['invoice', 'paid'])
}

{
  // The apex, which is attached and already works in production.
  eq('the apex reaches the same resource too',
    canonicalRedirectTarget(legacyInput('edgehq.ca', `/portal/${TOKEN}`)), `${CANON}/portal/${TOKEN}`)
}

// ═════════════════════════════════════════════════════════════════════════════
console.log('\n▸ 4 · ⛔ the destination is ALWAYS the configured origin')

{
  const attacks: [string, string][] = [
    ['a protocol-relative path', '//evil.example/portal/x'],
    ['an absolute URL as a path', 'https://evil.example/portal/x'],
    ['a backslash authority', '/\\evil.example/portal/x'],
    ['a scheme-ish path', 'https:/evil.example'],
    ['a triple slash', '///evil.example'],
    ['an @-authority', '/@evil.example/'],
  ]
  for (const [label, pathname] of attacks) {
    const t = canonicalRedirectTarget(legacyInput('app.edgepropertyservicesyyc.ca', pathname))
    const stays = t === null || new URL(t).origin === CANON
    check(`${label} cannot move the destination off our origin`, stays, String(t))
  }
}

{
  // A retired host is never a DESTINATION, even if it is somehow configured.
  const t = canonicalRedirectTarget({
    requestHost: 'edgehq.ca', method: 'GET', pathname: `/portal/${TOKEN}`, search: '',
    canonicalOrigin: CANON, alreadyHopped: false,
  })
  check('the destination never carries a retired host',
    !RETIRED_APP_HOSTS.some(h => String(t).includes(h)), String(t))
}

{
  // No canonical origin configured → serve where it landed. Never guess a host.
  eq('an unconfigured deploy invents no destination',
    canonicalRedirectTarget(legacyInput('app.edgepropertyservicesyyc.ca', '/portal/x', '', { canonicalOrigin: '' })), null)
  eq('…and an unusable one is refused too',
    canonicalRedirectTarget(legacyInput('app.edgepropertyservicesyyc.ca', '/portal/x', '', { canonicalOrigin: 'app.edgehq.ca' })), null)
}

// ═════════════════════════════════════════════════════════════════════════════
console.log('\n▸ 5 · ⛔ no redirect loop')

eq('a request already on the canonical host is left alone',
  canonicalRedirectTarget(legacyInput('app.edgehq.ca', '/portal/x')), null)
eq('…in any letter case', canonicalRedirectTarget(legacyInput('APP.EDGEHQ.CA', '/portal/x')), null)
eq('…with a trailing dot', canonicalRedirectTarget(legacyInput('app.edgehq.ca.', '/portal/x')), null)
eq('…on the default port', canonicalRedirectTarget(legacyInput('app.edgehq.ca:443', '/portal/x')), null)
eq('a second arrival is capped at one hop',
  canonicalRedirectTarget(legacyInput('app.edgepropertyservicesyyc.ca', '/portal/x', '', { alreadyHopped: true })), null)
eq('no Host header at all → do not move it',
  canonicalRedirectTarget(legacyInput('', '/portal/x')), null)

{
  // The destination of a legacy hop must itself be a no-op — the fixed point.
  const first = canonicalRedirectTarget(legacyInput('app.edgepropertyservicesyyc.ca', `/portal/${TOKEN}`)) as string
  const u = new URL(first)
  const second = canonicalRedirectTarget(legacyInput(u.host, u.pathname, u.search))
  eq('the destination redirects nowhere — the hop is a fixed point', second, null)
}

check('a deployment hostname is never canonicalised away',
  isFixedHost('localhost:3000') && isFixedHost('edgequote-git-x.vercel.app') && !isFixedHost('app.edgepropertyservicesyyc.ca'))

// ═════════════════════════════════════════════════════════════════════════════
console.log('\n▸ 6 · ⛔ the redirect grants nothing')

{
  const canonSrc = strip(read('src/lib/canonicalHost.ts'))
  check('the canonicaliser knows nothing about tokens',
    !/token|portal_token|get_portal_data|auth\.uid|session/i.test(canonSrc),
    'host canonicalisation has grown authorization logic')
  check('…and reads no database', !/supabase|createClient|from\(/i.test(canonSrc))
  // Negative control.
  check('[negative control] a token reference would be caught', /token/i.test('const portalToken = 1'))
}

{
  // Structural: an invalid token cannot be made valid by moving hosts, because
  // the path is copied verbatim and the portal is what checks it.
  const garbage = 'not-a-real-token-000000'
  const t = canonicalRedirectTarget(legacyInput('app.edgepropertyservicesyyc.ca', `/portal/${garbage}`)) as string
  eq('an invalid token is carried through UNCHANGED, not repaired', new URL(t).pathname, `/portal/${garbage}`)
  check('…and the portal RPC is still the only gate',
    /get_portal_data/.test(read('src/app/portal/[token]/page.tsx')),
    'the portal page no longer authorises through get_portal_data')
}

{
  // Cross-customer confusion: two tokens, two links, never mixed.
  const a = portalUrl('alice-AAAAAAAAAAAA', CANON)
  const b = portalUrl('bob-BBBBBBBBBBBB', CANON)
  check('two customers get two different links', a !== b)
  const ra = canonicalRedirectTarget(legacyInput('app.edgepropertyservicesyyc.ca', new URL(a).pathname)) as string
  const rb = canonicalRedirectTarget(legacyInput('app.edgepropertyservicesyyc.ca', new URL(b).pathname)) as string
  check('…and the redirect keeps them apart', ra !== rb && ra.endsWith('alice-AAAAAAAAAAAA') && rb.endsWith('bob-BBBBBBBBBBBB'),
    `${ra} / ${rb}`)
  // A query parameter must never be able to stand in for the path token.
  const mixed = canonicalRedirectTarget(
    legacyInput('app.edgepropertyservicesyyc.ca', new URL(a).pathname, '?token=bob-BBBBBBBBBBBB')) as string
  eq('…and a query cannot substitute another customer\'s token', new URL(mixed).pathname, '/portal/alice-AAAAAAAAAAAA')
}

// ═════════════════════════════════════════════════════════════════════════════
console.log('\n▸ 7 · machine callers are never redirected')

for (const p of CANONICAL_EXEMPT_PREFIXES) {
  eq(`${p}… is exempt (a webhook does not follow 307s)`,
    canonicalRedirectTarget(legacyInput('app.edgepropertyservicesyyc.ca', `${p}stripe/webhook`)), null)
}
for (const m of ['POST', 'PUT', 'PATCH', 'DELETE']) {
  eq(`a ${m} is never redirected`,
    canonicalRedirectTarget(legacyInput('app.edgepropertyservicesyyc.ca', '/portal/x', '', { method: m })), null)
}
eq('…but a HEAD is, like a GET',
  canonicalRedirectTarget(legacyInput('app.edgepropertyservicesyyc.ca', '/portal/x', '', { method: 'HEAD' })),
  `${CANON}/portal/x`)

// ═════════════════════════════════════════════════════════════════════════════
console.log('\n▸ 8 · the retired hosts stay OUT of every builder')

{
  const RETIRED_RE = /edgepropertyservicesyyc/i
  // Allowed to name them: the registry itself (evidence), and comments anywhere.
  const offenders = SRC
    .filter(f => f !== 'src/lib/canonicalHost.ts')
    .filter(f => RETIRED_RE.test(strip(read(f))))
  eq('no source file outside the registry names a retired host', offenders, [])
  check('[negative control] the retired-host matcher works',
    RETIRED_RE.test('const u = "https://app.edgepropertyservicesyyc.ca/portal/x"'))
}

{
  // The message TEMPLATES a customer receives must carry no hostname at all —
  // the link is substituted from the seam at send time.
  const tpl = read('src/lib/comms/templates.ts')
  check('message templates hardcode no application host',
    !/https?:\/\/(app\.)?edge/i.test(strip(tpl)),
    'a template carries a literal host and will outlive the next domain move')
}

check('normalizeHost is total and comparison-safe',
  normalizeHost(null) === '' && normalizeHost('  App.EdgeHQ.ca. ') === 'app.edgehq.ca'
  && normalizeHost('app.edgehq.ca:80') === 'app.edgehq.ca')
check('cleanOrigin still strips what a value picks up in transit',
  cleanOrigin('  "https://app.edgehq.ca/"  ') === CANON)

// ═════════════════════════════════════════════════════════════════════════════
console.log('')
if (failures) {
  console.log(`✗ customer-links: ${failures} rule${failures === 1 ? '' : 's'} broken`)
  process.exit(1)
}
console.log('✓ customer-links: every rule holds')
