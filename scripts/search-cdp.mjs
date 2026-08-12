// ── Real-browser verification of global search (investigation tool) ──────────
//
// Drives the REAL running app — owner login, real database, real bundle — because
// the things this session had to get right are things a fixture cannot show:
// whether the palette opens at all on a phone, whether a result row fits in 375px
// without pushing the page sideways, whether typing fires one request or five, and
// whether a failed read says something different from an empty one.
//
//   node scripts/search-cdp.mjs <baseUrl> <width> [--shot]
//
// Chrome clamps a headless WINDOW to ~500 CSS px on Windows, so resizing a window
// is not a 375px measurement. Emulation.setDeviceMetricsOverride sets a genuine
// mobile viewport: media queries, flex-wrap and position:fixed all behave as they
// do on the handset.
//
// The profile directory is FRESH per run. A persistent one serves a stale client
// bundle, and you measure the previous build while believing you measured this one.
import { spawn } from 'node:child_process'
import { writeFileSync, rmSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'
const [baseUrl = 'http://127.0.0.1:3000', wArg = '390', ...rest] = process.argv.slice(2)
const width = Number(wArg)
const shot = rest.includes('--shot')
const PORT = 9222 + Number(process.env.CDP_SLOT || 0)
const PROFILE = resolve(`.chrome-search-${width}`)
try { rmSync(PROFILE, { recursive: true, force: true }) } catch {}

const env = Object.fromEntries(readFileSync('.env.local', 'utf8').split(/\r?\n/)
  .filter(l => /^[A-Z_]+=/.test(l)).map(l => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1).trim()]))
const EMAIL = env.PORTAL_RPC_OWNER_EMAIL || env.BACKFILL_OWNER_EMAIL
const PASSWORD = env.PORTAL_RPC_OWNER_PASSWORD || env.BACKFILL_OWNER_PASSWORD

const chrome = spawn(CHROME, [
  '--headless=new', '--disable-gpu', '--no-sandbox', '--hide-scrollbars',
  `--remote-debugging-port=${PORT}`, '--user-data-dir=' + PROFILE, 'about:blank',
], { stdio: 'ignore' })

const sleep = ms => new Promise(r => setTimeout(r, ms))
async function wsUrl() {
  for (let i = 0; i < 80; i++) {
    try { return (await (await fetch(`http://127.0.0.1:${PORT}/json/version`)).json()).webSocketDebuggerUrl }
    catch { await sleep(250) }
  }
  throw new Error('Chrome never opened its debugging port')
}
const ws = new WebSocket(await wsUrl())
await new Promise(r => ws.addEventListener('open', r, { once: true }))
let id = 0
const pending = new Map()
const events = []
ws.addEventListener('message', e => {
  const m = JSON.parse(e.data)
  if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id) }
  else if (m.method) events.push(m)
})
function send(method, params = {}, sessionId) {
  const n = ++id
  return new Promise((res, rej) => {
    pending.set(n, m => m.error ? rej(new Error(method + ': ' + m.error.message)) : res(m.result))
    ws.send(JSON.stringify({ id: n, method, params, sessionId }))
  })
}
const { targetId } = await send('Target.createTarget', { url: 'about:blank' })
const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true })
const S = (m, p) => send(m, p, sessionId)

const metrics = { width, height: 844, deviceScaleFactor: 1, mobile: width < 700, screenWidth: width, screenHeight: 844 }
await S('Page.enable'); await S('Runtime.enable'); await S('Network.enable')
await S('Emulation.setDeviceMetricsOverride', metrics)
await S('Emulation.setTouchEmulationEnabled', { enabled: width < 700, maxTouchPoints: 5 })

const evalJs = async (expr, awaitPromise = true) => {
  const r = await S('Runtime.evaluate', { expression: expr, awaitPromise, returnByValue: true })
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.text + ' :: ' + (r.exceptionDetails.exception?.description || ''))
  return r.result.value
}
async function goto(url, settle = 1800) {
  await S('Page.navigate', { url })
  await sleep(settle)
  await S('Emulation.setDeviceMetricsOverride', metrics)   // a commit can drop the override
}
const out = []
const say = (...a) => { const s = a.join(' '); out.push(s); console.log(s) }

// Never assume a page has rendered because navigation settled — a cold Next.js
// route compiles on first hit, and a querySelector that runs early returns null,
// which surfaces as a confusing "Illegal invocation" from the native value setter.
async function waitFor(selector, timeout = 30000) {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) {
    if (await evalJs(`!!document.querySelector(${JSON.stringify(selector)})`)) return true
    await sleep(300)
  }
  const state = await evalJs(`JSON.stringify({
    path: location.pathname + location.search,
    ready: document.readyState,
    bodyChars: (document.body?.innerText || '').length,
    first: (document.body?.innerText || '').slice(0, 120),
  })`)
  throw new Error(`never appeared: ${selector} — page was ${state}`)
}

// ── Sign in ─────────────────────────────────────────────────────────────────
// Wrapped in a function because a long run outlives the session: partway through
// the deep-link checks the app bounces to /login?next=…, and every later
// assertion then fails against a login form for reasons that have nothing to do
// with search. ensureSignedIn() is called before each phase.
async function signIn() {
  await goto(`${baseUrl}/login`, 2500)
  await waitFor('input[type=email]')
  await waitFor('input[type=password]')
  // Type with REAL input events. Poking .value through the native setter and
  // firing a synthetic 'input' races React's controlled input: sometimes it takes,
  // sometimes React re-renders from its own (still empty) state and the form
  // submits blank — an unexplained "sign-in FAILED" on maybe one run in three.
  // Input.insertText goes through the browser's input pipeline, so React sees it.
  for (let attempt = 1; attempt <= 3; attempt++) {
    for (const [sel, text] of [['input[type=email]', EMAIL], ['input[type=password]', PASSWORD]]) {
      await evalJs(`(() => { const el = document.querySelector(${JSON.stringify(sel)})
        el.focus(); el.select?.(); return true })()`)
      await S('Input.insertText', { text })
      await sleep(150)
    }
    const filled = await evalJs(`document.querySelector('input[type=email]').value.length > 0
      && document.querySelector('input[type=password]').value.length > 0`)
    if (filled) break
    if (attempt === 3) { say('sign-in: FAILED — the login fields would not accept input'); chrome.kill(); process.exit(1) }
    await sleep(700)
  }
  await evalJs(`(() => {
    const btn = [...document.querySelectorAll('button')].find(b => /sign in|log in/i.test(b.textContent))
    btn?.click(); return true })()`)
  await sleep(6000)
  await goto(`${baseUrl}/dashboard`, 3500)
  const ok = await evalJs(`location.pathname.startsWith('/dashboard')`)
  if (!ok) {
    const why = await evalJs(`JSON.stringify({
      path: location.pathname,
      buttons: [...document.querySelectorAll('button')].map(b => b.textContent.trim()).slice(0, 8),
      alerts: [...document.querySelectorAll('[role=alert]')].map(e => e.textContent.trim()).slice(0, 4),
      emailVal: document.querySelector('input[type=email]')?.value ?? null,
    })`)
    say(`sign-in: FAILED — ${why}`)
    chrome.kill(); process.exit(1)
  }
  return true
}

// Re-authenticate only if the app has bounced us out.
async function ensureSignedIn() {
  if (await evalJs(`location.pathname.startsWith('/login')`)) {
    say('  (session expired — re-authenticating)')
    await signIn()
  }
}

await signIn()
say('sign-in: OK')

// ── How is search REACHED at this width? ────────────────────────────────────
const entry = await evalJs(`(() => {
  const vis = el => { const r = el.getBoundingClientRect(); const s = getComputedStyle(el)
    return r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && s.display !== 'none' }
  const btns = [...document.querySelectorAll('button')]
    .filter(b => /search/i.test(b.getAttribute('aria-label') || '') || /search/i.test(b.textContent))
    .filter(vis)
    .map(b => { const r = b.getBoundingClientRect()
      return { label: (b.getAttribute('aria-label') || b.textContent).trim().slice(0, 40),
               w: Math.round(r.width), h: Math.round(r.height), top: Math.round(r.top) } })
  return btns
})()`)
say(`search entry points visible at ${width}px: ${JSON.stringify(entry)}`)

// ── Open the palette and run a query ────────────────────────────────────────
async function search(q, { settle = 2200 } = {}) {
  // Open the way a person does — CLICK the Search control. Dispatching the
  // internal event instead can land before the palette has mounted its listener
  // (right after a navigation), and then nothing opens and nothing says why.
  // Falling back to the event keeps this working at widths where the control is
  // the sidebar row rather than the header button.
  const INPUT = '[role=dialog][aria-label="Command palette"] input'
  await waitFor('button[aria-label="Search"], nav, aside', 30000)
  for (let i = 0; i < 30; i++) {
    if (await evalJs(`!!document.querySelector(${JSON.stringify(INPUT)})`)) break
    await evalJs(`(() => {
      const b = document.querySelector('button[aria-label="Search"]')
        || [...document.querySelectorAll('button')].find(x => /^\\s*search\\b/i.test(x.textContent))
      if (b) b.click(); else window.dispatchEvent(new Event('eq:command-open'))
      return true })()`)
    await sleep(400)
  }
  await waitFor(INPUT)
  await evalJs(`(() => {
    const inp = document.querySelector('[role=dialog][aria-label="Command palette"] input')
    const p = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set
    p.call(inp, ''); inp.dispatchEvent(new Event('input', { bubbles: true }))
    p.call(inp, ${JSON.stringify(q)}); inp.dispatchEvent(new Event('input', { bubbles: true }))
    return true })()`)
  await sleep(settle)
  return await evalJs(`(() => {
    const dlg = document.querySelector('[role=dialog][aria-label="Command palette"]')
    if (!dlg) return { error: 'palette not open' }
    const alert = dlg.querySelector('[role=alert]')
    const rows = [...dlg.querySelectorAll('[role=option]')].map(o => {
      const spans = [...o.querySelectorAll('span')].map(s => s.textContent.trim()).filter(Boolean)
      return spans.slice(0, 3).join(' | ')
    })
    const empty = dlg.querySelector('#cmdk-list > p')
    return {
      alert: alert ? alert.textContent.trim() : null,
      empty: empty ? empty.textContent.trim() : null,
      rows: rows.slice(0, 6),
      count: rows.length,
      dialogWidth: Math.round(dlg.getBoundingClientRect().width),
      overflowX: document.documentElement.scrollWidth > window.innerWidth
        ? document.documentElement.scrollWidth - window.innerWidth : 0,
    }
  })()`)
}

say(`\n── queries at ${width}px ──`)
for (const q of ['Sarah', 'INV-0069', '69', '4035107347', '236 86 Ave', 'Mowing', 'a', 'zzzzqqqq']) {
  const r = await search(q)
  say(`  "${q}" → ${r.count} rows${r.alert ? ` ALERT:"${r.alert}"` : ''}${r.empty ? ` EMPTY:"${r.empty}"` : ''} overflowX=${r.overflowX}px`)
  for (const row of r.rows) say(`      ${row}`)
}

// ── Requests per keystroke ──────────────────────────────────────────────────
events.length = 0
await evalJs(`(() => {
  const inp = document.querySelector('[role=dialog][aria-label="Command palette"] input')
  const p = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set
  p.call(inp, ''); inp.dispatchEvent(new Event('input', { bubbles: true }))
  return true })()`)
await sleep(600)
events.length = 0
for (const partial of ['S', 'Sa', 'Sar', 'Sara', 'Sarah']) {
  await evalJs(`(() => {
    const inp = document.querySelector('[role=dialog][aria-label="Command palette"] input')
    const p = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set
    p.call(inp, ${JSON.stringify(partial)}); inp.dispatchEvent(new Event('input', { bubbles: true }))
    return true })()`)
  await sleep(60)   // faster than the 180ms debounce — a real typist
}
await sleep(2500)
const searchReqs = events.filter(e => e.method === 'Network.requestWillBeSent'
  && /search_records/.test(e.params?.request?.url || '')).length
say(`\ntyping "Sarah" one character at a time (60ms apart) → ${searchReqs} search request(s)`)

// ── Keyboard ────────────────────────────────────────────────────────────────
// Read AFTER React has re-rendered — a state update is not synchronous, so
// sampling the DOM in the same tick measures the previous frame and reports a
// working keyboard as broken.
const before = await evalJs(`document.querySelector('[role=dialog] [aria-selected=true]')?.id ?? null`)
await evalJs(`(() => { window.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true })); return true })()`)
await sleep(400)
const afterDown = await evalJs(`document.querySelector('[role=dialog] [aria-selected=true]')?.id ?? null`)
await evalJs(`(() => { window.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true })); return true })()`)
await sleep(400)
const afterUp = await evalJs(`document.querySelector('[role=dialog] [aria-selected=true]')?.id ?? null`)
say(`ArrowDown: ${before} → ${afterDown} (moved: ${before !== afterDown});  ArrowUp back to ${afterUp}`)
const esc = await evalJs(`(() => {
  window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
  return true })()`)
await sleep(300)
say(`Escape closes: ${!(await evalJs(`!!document.querySelector('[role=dialog][aria-label="Command palette"]')`))}`)

// ── Deep link: open the top result for a query and report where we land ─────
for (const q of ['INV-0069', 'Sarah Brown', 'Bi-Weekly Mowing', '236 86 Ave']) {
  await goto(`${baseUrl}/dashboard`, 2000)
  await ensureSignedIn()
  await search(q)
  await evalJs(`(() => {
    const o = document.querySelector('[role=dialog][aria-label="Command palette"] [role=option]')
    o?.click(); return true })()`)
  await sleep(3000)
  const landed = await evalJs('location.pathname + location.search')
  // A deep link is only real if the destination SHOWS the record. ?job= and
  // ?invoice= both focus in place, so the URL alone does not prove arrival.
  const focused = await evalJs(`(() => {
    const t = (document.body.innerText || '')
    return { showsQuery: t.toLowerCase().includes(${JSON.stringify(q.toLowerCase())}),
             banner: (t.match(/Showing[^\\n]{0,60}/) || [null])[0] }
  })()`)
  say(`"${q}" → Enter lands on ${landed}  [record visible: ${focused.showsQuery}${focused.banner ? `; "${focused.banner}"` : ''}]`)
}

// ── Failed read ─────────────────────────────────────────────────────────────
await goto(`${baseUrl}/dashboard`, 2000)
await ensureSignedIn()
await S('Network.setBlockedURLs', { urls: ['*search_records*'] })
const failed = await search('Sarah', { settle: 2500 })
say(`\nwith the search endpoint blocked → alert:"${failed.alert}" rows=${failed.count} empty:"${failed.empty}"`)
await S('Network.setBlockedURLs', { urls: [] })
const recovered = await evalJs(`(() => {
  const b = [...document.querySelectorAll('[role=dialog] button')].find(x => /try again/i.test(x.textContent))
  if (!b) return 'no retry button'; b.click(); return 'clicked' })()`)
await sleep(2500)
const after = await evalJs(`(() => {
  const dlg = document.querySelector('[role=dialog][aria-label="Command palette"]')
  return { rows: dlg.querySelectorAll('[role=option]').length, alert: !!dlg.querySelector('[role=alert]') } })()`)
say(`retry (${recovered}) → rows=${after.rows} alert=${after.alert}`)

if (shot) {
  await search('Sarah')
  const { data } = await S('Page.captureScreenshot', { format: 'png' })
  writeFileSync(`search-${width}.png`, Buffer.from(data, 'base64'))
  say(`screenshot → search-${width}.png`)
}

writeFileSync(`search-cdp-${width}.txt`, out.join('\n'))
ws.close(); chrome.kill()
try { rmSync(PROFILE, { recursive: true, force: true }) } catch {}
process.exit(0)
