// ── Does a signed-in session survive closing the browser? ────────────────────
//   node scripts/authpersist-cdp.mjs [baseUrl] [altHostOrigin]
//   node scripts/authpersist-cdp.mjs https://app.edgehq.ca https://edgehq.ca
//
// WHY THIS EXISTS. The owner reported "every time I reopen EdgeHQ on desktop it
// makes me sign in with Google again", and every plausible cause — a session-only
// cookie, a short token, a middleware that fails to refresh, an app clearing its
// own storage — is invisible from the UI. All of them produce the same screen.
// So this measures rather than infers, and it measures the two things a screen
// cannot tell apart:
//
//   1. PERSISTENCE. Chrome is launched against a PERSISTENT profile directory,
//      signed in, then genuinely CLOSED (Browser.close, so the cookie store is
//      flushed exactly as it is when a person quits), then RELAUNCHED against
//      that same profile. Whatever survived on disk is what the second launch
//      sees. Session-only cookies die here, and that is the point — this is a
//      real quit and reopen, not a simulation of one.
//
//   2. WHICH HOST HOLDS IT. Supabase writes the session cookie with no Domain
//      attribute, so it is HOST-ONLY. If the app answers on more than one
//      hostname, a session established on one is invisible on the other, and the
//      person sees a login form while holding a perfectly good session.
//
// ⭐⭐ WHAT THIS FOUND, 2026-08-26 against production. Persistence was NEVER the
// problem: the cookie is written Max-Age 400d and survives a real quit intact.
// The second measurement is the bug — app.edgehq.ca held two auth cookies and
// served the dashboard, while edgehq.ca, in the same profile seconds later,
// served /login with ZERO cookies. See lib/canonicalHost.
//
// ⛔ NO TOKEN VALUE IS EVER PRINTED. Presence, size and metadata only — a probe
// that echoes a session is a probe that leaks one into a terminal scrollback.
// ⛔ NEVER SIGNS OUT. The app's sign-out is deliberately global, and this signs in
// as the real owner; ending the session here would end it on their phone too.

import { spawn } from 'node:child_process'
import { readFileSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe'
const BASE = (process.argv[2] || 'https://app.edgehq.ca').replace(/\/+$/, '')
const ALT = (process.argv[3] || '').replace(/\/+$/, '')
const PORT = Number(process.env.EQ_CDP_PORT || 9642)
const ENV_FILE = process.env.EQ_ENV || join(process.cwd(), '.env.local')
const sleep = ms => new Promise(r => setTimeout(r, ms))

const env = {}
for (const line of readFileSync(ENV_FILE, 'utf8').split(/\r?\n/)) {
  const m = line.match(/^([A-Z0-9_]+)=(.*)$/)
  if (m) env[m[1]] = m[2].replace(/^["']|["']$/g, '')
}
const EMAIL = env.PORTAL_RPC_OWNER_EMAIL
const PASSWORD = env.PORTAL_RPC_OWNER_PASSWORD
const REF = (env.NEXT_PUBLIC_SUPABASE_URL || '').match(/\/\/([a-z0-9]+)\.supabase/)?.[1]
const AUTH_PREFIX = `sb-${REF}-auth-token`
if (!EMAIL || !PASSWORD) { console.log(`no owner credentials in ${ENV_FILE}`); process.exit(1) }

// A profile that OUTLIVES the first browser, because that is the whole experiment.
const PROFILE = mkdtempSync(join(tmpdir(), 'eq-authpersist-'))
let failures = 0
const check = (n, c, d = '') => { if (c) console.log(`  ✓ ${n}`); else { failures++; console.log(`  ✗ ${n}${d ? '\n      ' + d : ''}`) } }

let ws, nextId = 1, pending = new Map()
const launch = () => spawn(CHROME, [
  `--remote-debugging-port=${PORT}`, `--user-data-dir=${PROFILE}`,
  '--headless=new', '--no-first-run', '--no-default-browser-check',
  '--disable-extensions', '--disable-background-networking', 'about:blank',
], { stdio: 'ignore' })

async function connect() {
  for (let i = 0; i < 80; i++) {
    try {
      const list = await fetch(`http://127.0.0.1:${PORT}/json/list`).then(r => r.json())
      const t = list.find(x => x.type === 'page' && x.webSocketDebuggerUrl)
      if (t) {
        ws = new WebSocket(t.webSocketDebuggerUrl)
        await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej })
        ws.onmessage = e => {
          const m = JSON.parse(e.data)
          if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id) }
        }
        return
      }
    } catch { /* chrome not up yet */ }
    await sleep(250)
  }
  throw new Error('no CDP page target')
}
const send = (method, params = {}) => {
  const id = nextId++
  return new Promise((res, rej) => {
    pending.set(id, m => (m.error ? rej(new Error(`${method}: ${m.error.message}`)) : res(m.result)))
    ws.send(JSON.stringify({ id, method, params }))
  })
}
const evalJs = async expr =>
  (await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true })).result?.value

async function openBrowser() {
  pending = new Map(); nextId = 1
  const p = launch()
  await connect()
  await send('Page.enable'); await send('Runtime.enable'); await send('Network.enable')
  return p
}
async function closeBrowser(p) {
  try { await send('Browser.close') } catch { /* already gone */ }
  await sleep(2500)
  try { p.kill() } catch { /* already gone */ }
  await sleep(2000)
}
/**
 * ⚠️ POLLED, NEVER SLEPT. The first version of this probe waited a fixed 10s
 * after submitting the form and read location.href once — and reported "sign-in
 * did not reach the dashboard" while the very next lines printed two freshly
 * written session cookies. The sign-in had worked; the read happened mid
 * navigation. A fixed sleep turns a slow redirect into a false bug report, which
 * is worse than no probe at all.
 */
async function waitForUrl(pred, timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs
  let href = ''
  while (Date.now() < deadline) {
    href = (await evalJs('location.href')) || ''
    if (pred(href)) return href
    await sleep(500)
  }
  return href
}
async function visit(url, settle = 8000) {
  await send('Page.navigate', { url })
  // Settle to the first URL that is not the one we were on, then let the app's
  // own gates finish redirecting before anyone asks where we landed.
  await sleep(Math.min(settle, 2500))
  await waitForUrl(h => !!h && h !== 'about:blank', settle)
  await sleep(1500)
  return await evalJs('location.href')
}

/** Cookie metadata, never cookie values. */
async function cookies(label) {
  const { cookies: all } = await send('Network.getAllCookies')
  const host = new URL(BASE).hostname.split('.').slice(-2).join('.')
  const mine = all.filter(c => c.domain.replace(/^\./, '').endsWith(host))
  console.log(`\n  ── ${label}: ${mine.length} cookie(s) on *.${host} ──`)
  for (const c of mine.sort((a, b) => a.name.localeCompare(b.name))) {
    const exp = c.session
      ? 'SESSION-ONLY — dies when the browser closes'
      : `${new Date(c.expires * 1000).toISOString()} (+${Math.round((c.expires * 1000 - Date.now()) / 86400000)}d)`
    console.log(`     ${c.name}  [${c.size}B]`)
    console.log(`        domain=${c.domain} hostOnly=${!c.domain.startsWith('.')} path=${c.path}`)
    console.log(`        secure=${c.secure} httpOnly=${c.httpOnly} sameSite=${c.sameSite ?? '(unset)'}`)
    console.log(`        expiry=${exp}`)
  }
  return mine.filter(c => c.name.startsWith(AUTH_PREFIX) && !c.name.endsWith('-code-verifier'))
}

let proc
try {
  console.log(`\n═══ PHASE 1 — sign in at ${BASE} ═══`)
  proc = await openBrowser()
  await visit(`${BASE}/login`, 5000)
  await evalJs(`(() => {
    const set = (el, v) => {
      const p = Object.getOwnPropertyDescriptor(el.constructor.prototype, 'value').set
      p.call(el, v); el.dispatchEvent(new Event('input', { bubbles: true }))
    }
    const e = document.querySelector('input[type=email]'), w = document.querySelector('input[type=password]')
    if (!e || !w) return 'NO FORM'
    set(e, ${JSON.stringify(EMAIL)}); set(w, ${JSON.stringify(PASSWORD)}); return 'filled'
  })()`)
  await sleep(300)
  await evalJs(`document.querySelector('button[type=submit]').click()`)
  const landed = await waitForUrl(h => /\/dashboard|\/crew|\/setup/.test(h), 30000)
  check('password sign-in reaches the dashboard', /\/dashboard|\/crew|\/setup/.test(landed),
    `landed on ${landed}`)

  const before = await cookies('PHASE 1 — signed in, browser still open')
  check('a session cookie exists', before.length > 0)
  check('NO auth cookie is session-only (this is what a browser close deletes)',
    before.every(c => !c.session),
    'a cookie with no Max-Age dies on close — that would be the reported bug')
  check('every auth cookie is host-only (never Domain=.edgehq.ca)',
    before.every(c => !c.domain.startsWith('.')),
    'a domain-wide session cookie is readable by every present and future subdomain')

  console.log('\n═══ CLOSING THE BROWSER (clean exit, cookie store flushed) ═══')
  await closeBrowser(proc)

  console.log(`\n═══ PHASE 2 — reopen the SAME profile ═══`)
  proc = await openBrowser()
  const after = await cookies('PHASE 2 — fresh launch, before any navigation')
  check('the session cookie survived the close', after.length === before.length,
    `${before.length} before, ${after.length} after — the browser dropped them`)

  const reopened = await visit(`${BASE}/dashboard`, 10000)
  check('CASE B — still signed in after a real close and reopen',
    !/\/login/.test(reopened), `landed on ${reopened}`)

  if (ALT) {
    console.log(`\n═══ PHASE 3 — the same session, asked for on ${ALT} ═══`)
    const altLanded = await visit(`${ALT}/dashboard`, 10000)
    const altNames = await evalJs(`document.cookie.split('; ').map(s => s.split('=')[0]).filter(Boolean).join(',')`)
    console.log(`     ${ALT}/dashboard → ${altLanded}`)
    console.log(`     cookies that host can see: ${altNames || '(none)'}`)
    check(`CASE D — ${ALT} does not strand the session`,
      !/\/login/.test(altLanded),
      'the alternate host served a login form to a signed-in person — it must canonicalise to ' +
      `${BASE} instead (lib/canonicalHost). Until that ships, this failure IS the reported bug.`)
    const back = await visit(`${BASE}/dashboard`, 8000)
    check('the canonical host still has the session afterwards', !/\/login/.test(back), `landed on ${back}`)
  }
} catch (e) {
  failures++
  console.log(`\nPROBE ERROR: ${e.message}`)
} finally {
  if (proc) await closeBrowser(proc)
  try { rmSync(PROFILE, { recursive: true, force: true }) } catch { /* windows lock */ }
}

console.log(failures === 0
  ? '\n✅ the session survives a real browser close, on every host tested\n'
  : `\n❌ ${failures} check(s) failed\n`)
process.exit(failures === 0 ? 0 : 1)
