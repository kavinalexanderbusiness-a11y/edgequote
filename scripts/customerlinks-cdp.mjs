// ── Drive the REAL app: a legacy link lands on the right resource ───────────
// Session 110. Two halves, both against a production build:
//
//   1. THE REPAIR, exactly. A request arriving with the RETIRED hostname is
//      answered with a 307 to the canonical origin carrying the same path, the
//      same query and the same token — checked on the wire, not in a unit test.
//      This is the code path that is unreachable in production today only
//      because the domain is not attached to the project.
//   2. THE RESOURCE. The portal renders at desktop and at 375 / 390 / 430 with
//      nothing overflowing sideways, and an INVALID token is still refused —
//      the repair moves requests between hosts, it does not grant anything.
//
//   node scripts/customerlinks-cdp.mjs <baseUrl>
//
// ⛔ FIXTURE TOKENS ONLY. No real customer's portal is opened, no message is
// sent and nothing is written — the assertions are about routing and refusal,
// neither of which needs a real customer.
//
// ⚠️ The server must run with NEXT_PUBLIC_APP_URL set to a NON-LOCAL canonical
// origin, otherwise isFixedHost() correctly refuses to canonicalise anything and
// half of this proves nothing. The harness asserts that precondition rather than
// assuming it.

import { spawn } from 'node:child_process'
import { readFileSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe'
const base = process.argv.slice(2).find(a => a.startsWith('http')) || 'http://127.0.0.1:3120'
const CANONICAL = 'https://app.edgehq.ca'
const RETIRED = 'app.edgepropertyservicesyyc.ca'
const TOKEN = 'zz-s110-fixture-NOTAREALTOKEN'
const PORT = 9493
const WIDTHS = [1280, 430, 390, 375]

let fails = 0
const ok = n => console.log(`  ✓ ${n}`)
const bad = (n, d = '') => { fails++; console.log(`  ✗ ${n}${d ? `\n      ${d}` : ''}`) }
const check = (n, c, d) => c ? ok(n) : bad(n, d)
const sleep = ms => new Promise(r => setTimeout(r, ms))

// ── 1 · the repair, on the wire ─────────────────────────────────────────────
console.log('\n▸ 1 · a request on the RETIRED host is carried to the resource')

// ⚠️ x-forwarded-host, NOT Host. Two reasons, and the second is the important
// one: undici forbids setting `Host` from fetch and drops it silently (the first
// run of this proof reported 200s and looked like a broken redirect), and
// x-forwarded-host is exactly what Vercel puts on the request in production —
// the middleware reads it FIRST. So this is both the header that works and the
// header the real thing uses.
async function head(path, host) {
  const res = await fetch(`${base}${path}`, {
    method: 'GET', redirect: 'manual', headers: host ? { 'x-forwarded-host': host } : {},
  })
  return { status: res.status, location: res.headers.get('location') || '' }
}

{
  const r = await head(`/portal/${TOKEN}`, RETIRED)
  check('the retired host is redirected, not served', r.status === 307 || r.status === 308,
    `status ${r.status}`)
  check('…to the canonical origin', r.location.startsWith(`${CANONICAL}/`), r.location)
  let u = null
  try { u = new URL(r.location) } catch { /* location empty or malformed — reported by the checks below */ }
  check('…on the same path', u?.pathname === `/portal/${TOKEN}`, r.location)
  check('…with the token intact', u?.pathname.split('/')[2] === TOKEN, r.location)
}

{
  // The resource SELECTOR — which invoice, which quote — must survive too.
  const r = await head(`/portal/${TOKEN}?invoice=inv-abc&paid=1`, RETIRED)
  let u = null
  try { u = new URL(r.location) } catch { /* reported below */ }
  check('a query that selects the resource survives',
    u?.searchParams.get('invoice') === 'inv-abc' && u?.searchParams.get('paid') === '1', r.location)
  check('…and nothing was added to it', [...(u?.searchParams.keys() ?? [])].length === 2, r.location)
}

{
  // ⛔ A webhook must never be moved: senders do not follow redirects.
  const r = await head('/api/health', RETIRED)
  check('⛔ an /api path on the retired host is NOT redirected', r.status !== 307 && r.status !== 308,
    `status ${r.status} → ${r.location}`)
}

{
  // ⛔ OPEN REDIRECT, on the wire — with a RAW request line.
  // ⚠️ fetch() normalises `//evil.example/x` in a URL down to `/evil.example/x`
  // before it ever leaves the process, so testing this through fetch tests
  // nothing: the dangerous shape never reaches the server. node:http writes the
  // path verbatim, which is what a hand-built request or a crafted link does.
  const { request } = await import('node:http')
  const u = new URL(base)
  const raw = path => new Promise(res => {
    const req = request({ host: u.hostname, port: u.port, path, method: 'GET',
      headers: { 'x-forwarded-host': RETIRED } },
    r => { r.resume(); res({ status: r.statusCode, location: r.headers.location || '' }) })
    req.on('error', () => res({ status: 0, location: '' }))
    req.end()
  })

  for (const p of [`//evil.example/portal/${TOKEN}`, `/\\evil.example/portal/${TOKEN}`, `///evil.example/`]) {
    const r = await raw(p)
    // Safe means: no Location at all, or a Location that resolves to OUR host —
    // whether it is absolute-canonical or a same-origin relative path.
    let host = null
    try { host = r.location ? new URL(r.location, base).host : null } catch { host = 'unparseable' }
    const safe = host === null || host === new URL(CANONICAL).host || host === u.host
    check(`⛔ a path that looks like an authority cannot move the destination (${p.slice(0, 18)})`,
      safe, `status ${r.status} → ${r.location}`)
  }
}

{
  // The precondition this proof depends on.
  const r = await head('/login', RETIRED)
  check('the deploy under test has a canonical origin configured',
    r.status === 307 || r.status === 308,
    'NEXT_PUBLIC_APP_URL is unset or local — canonicalisation is a no-op and half this proof is vacuous')
}

// ── 2 · the resource, in a browser ──────────────────────────────────────────
const profile = mkdtempSync(join(tmpdir(), 'links-cdp-'))
const chrome = spawn(CHROME, ['--headless=new', '--disable-gpu', '--no-sandbox', '--hide-scrollbars',
  `--remote-debugging-port=${PORT}`, '--user-data-dir=' + profile, 'about:blank'], { stdio: 'ignore' })
chrome.on('error', e => { console.error('chrome: ' + e.message); process.exit(2) })

let wsUrl
for (let i = 0; i < 60; i++) {
  try {
    const r = await fetch(`http://127.0.0.1:${PORT}/json/list`)
    const t = (await r.json()).find(x => x.type === 'page')
    if (t) { wsUrl = t.webSocketDebuggerUrl; break }
  } catch { /* not up */ }
  await sleep(500)
}
const { WebSocket } = await import('ws').catch(() => ({ WebSocket: globalThis.WebSocket }))
const ws = new WebSocket(wsUrl)
await new Promise(r => ws.addEventListener('open', r))
let id = 0
const pend = new Map()
ws.addEventListener('message', e => {
  const m = JSON.parse(e.data)
  if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id) }
})
const send = (method, params = {}) => new Promise(res => { const i = ++id; pend.set(i, res); ws.send(JSON.stringify({ id: i, method, params })) })
const evaluate = async e => (await send('Runtime.evaluate', { expression: e, awaitPromise: true, returnByValue: true })).result?.result?.value
await send('Page.enable'); await send('Runtime.enable')
const goto = async u => {
  await send('Page.navigate', { url: u })
  for (let i = 0; i < 80; i++) { await sleep(250); if (await evaluate('document.readyState==="complete"')) break }
  await sleep(1800)
}

// ⚠️ Elements inside a designed horizontal scroller are not a page defect —
// exempt anything an ancestor already scrolls or clips, and report the rest.
const OVERFLOW = `(() => {
  const bad = []
  const scrolls = el => {
    for (let p = el.parentElement; p && p !== document.body; p = p.parentElement) {
      const ox = getComputedStyle(p).overflowX
      if (ox === 'auto' || ox === 'scroll' || ox === 'hidden') return true
    }
    return false
  }
  for (const el of document.querySelectorAll('body *')) {
    const r = el.getBoundingClientRect()
    if (r.width === 0) continue
    if (r.right > innerWidth + 1 || r.left < -1) {
      if (scrolls(el)) continue
      bad.push(el.tagName.toLowerCase() + ' "' + (el.textContent||'').trim().replace(/\\s+/g,' ').slice(0,28) + '"')
    }
  }
  return bad.slice(0, 4)
})()`

console.log('\n▸ 2 · the resource renders, and an invalid token is still refused')
for (const w of WIDTHS) {
  await send('Emulation.setDeviceMetricsOverride', { width: w, height: 900, deviceScaleFactor: 2, mobile: w < 1000 })
  await goto(`${base}/portal/${TOKEN}`)
  const body = String(await evaluate('document.body.innerText') || '')
  const label = w >= 1000 ? 'desktop' : `${w}px`

  check(`${label} · the portal page responds rather than crashing`, body.length > 0)
  // ⛔ THE SECURITY POINT: moving hosts grants nothing. A fixture token that was
  // never issued must still be refused after all the routing work.
  check(`${label} · ⛔ an invalid token is REFUSED, not honoured`,
    /not (valid|found)|expired|no longer|can.t find|couldn.t find|invalid|sign in|link/i.test(body),
    body.slice(0, 160).replace(/\n/g, ' '))
  check(`${label} · ⛔ and no customer data is shown for it`,
    !/invoice #|balance due|amount due|\$\s?\d/i.test(body),
    body.slice(0, 160).replace(/\n/g, ' '))
  const over = await evaluate(OVERFLOW)
  check(`${label} · nothing overflows sideways`, Array.isArray(over) && over.length === 0,
    (over || []).join(' · '))
}

console.log('')
if (fails) console.log(`✗ customer-links browser proof: ${fails} check${fails === 1 ? '' : 's'} failed`)
else console.log('✓ customer-links browser proof: green')
ws.close(); chrome.kill()
process.exit(fails ? 1 : 0)
