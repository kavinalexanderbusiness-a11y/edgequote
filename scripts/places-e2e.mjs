// ── Address autocomplete, proved on the real thing ───────────────────────────
//   node scripts/places-e2e.mjs [baseUrl] [width] [--shot <file>]
//
// Types a partial address into the REAL New Quote page, waits for the REAL
// /api/places/autocomplete round trip, and reads back what the screen actually
// offers. Then picks one and checks the field is filled with the canonical
// address Google returned.
//
// ⭐ WHY THIS EXISTS AS A SEPARATE PROOF. AddressAutocomplete FAILS QUIETLY BY
// DESIGN: on a >=500 it renders "Address suggestions unavailable — you can still
// type the address manually" and lets the owner carry on. That is right for a
// genuine provider outage and WRONG as a resting state, because it looks
// identical whether Google is down or the production credential is broken —
// which is exactly how a revoked GOOGLE_MAPS_API_KEY sat unnoticed. So this
// asserts the banner is ABSENT, not merely that the page still works.
//
// ⛔ READ-ONLY against production. It types into a new-quote form and never
// saves; nothing is written to any customer, property or quote.
import { spawn } from 'node:child_process'
import { writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs'

const CHROME = process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe'
const argv = process.argv.slice(2)
const base = (argv.find(a => a.startsWith('http')) || 'https://app.edgehq.ca').replace(/\/+$/, '')
const width = Number(argv.find(a => /^\d+$/.test(a)) || 1280)
const shotIdx = argv.indexOf('--shot')
const shot = shotIdx >= 0 ? argv[shotIdx + 1] : null
const QUERY = process.env.E2E_QUERY || '2320 Deer Side'
const PORT = Number(process.env.CDP_PORT || 9500)
const profile = (process.env.TEMP || '.') + '/eq-places-e2e-' + PORT

const E = (() => {
  for (const p of ['.env.local', '../edgehq-main/.env.local']) {
    if (!existsSync(p)) continue
    return Object.fromEntries(readFileSync(p, 'utf8').split(/\r?\n/)
      .map(l => l.match(/^([A-Z_0-9]+)=(.*)$/)).filter(Boolean).map(m => [m[1], m[2]]))
  }
  return {}
})()

// A service worker will otherwise serve a bundle cached by a previous run.
try { rmSync(profile, { recursive: true, force: true }) } catch { /* first run */ }

const chrome = spawn(CHROME, [
  '--headless=new', '--disable-gpu', '--no-sandbox', '--hide-scrollbars',
  `--remote-debugging-port=${PORT}`, '--user-data-dir=' + profile, 'about:blank',
], { stdio: 'ignore' })
const sleep = ms => new Promise(r => setTimeout(r, ms))
async function wsUrl() {
  for (let i = 0; i < 120; i++) {
    try { return (await (await fetch(`http://127.0.0.1:${PORT}/json/version`)).json()).webSocketDebuggerUrl }
    catch { await sleep(250) }
  }
  throw new Error('Chrome never opened its debugging port')
}
const ws = new WebSocket(await wsUrl())
await new Promise(r => ws.addEventListener('open', r, { once: true }))
let id = 0
const pending = new Map()
const netEvents = []
const consoleErrors = []
const bodies = new Map()
ws.addEventListener('message', e => {
  const m = JSON.parse(e.data)
  if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); return }
  if (m.method === 'Network.responseReceived') {
    const u = m.params.response.url
    if (u.includes('/api/')) netEvents.push({ url: u, status: m.params.response.status, requestId: m.params.requestId })
  }
  if (m.method === 'Log.entryAdded' && m.params.entry.level === 'error') consoleErrors.push(m.params.entry.text)
})
const send = (method, params = {}, sessionId) => new Promise((res, rej) => {
  const n = ++id
  pending.set(n, m => m.error ? rej(new Error(method + ': ' + m.error.message)) : res(m.result))
  ws.send(JSON.stringify({ id: n, method, params, sessionId }))
})
const { targetId } = await send('Target.createTarget', { url: 'about:blank' })
const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true })
const S = (m, p) => send(m, p, sessionId)
await S('Page.enable'); await S('Runtime.enable'); await S('Log.enable'); await S('Network.enable')
const mobile = width < 900
const metrics = { width, height: mobile ? 844 : 900, deviceScaleFactor: 1, mobile, screenWidth: width, screenHeight: mobile ? 844 : 900 }
await S('Emulation.setDeviceMetricsOverride', metrics)
if (mobile) await S('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 })
const ev = expr => S('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true }).then(r => {
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || 'eval threw')
  return r.result.value
})

const results = []
const check = (name, cond, detail = '') => {
  results.push({ name, ok: !!cond })
  console.log(`${cond ? '✓' : '✗'} ${name}${detail ? ' — ' + detail : ''}`)
}

console.log(`Address autocomplete — ${base} @ ${width}px · query "${QUERY}"\n`)

// ── Sign in ──────────────────────────────────────────────────────────────────
await S('Page.navigate', { url: base + '/login' })
const loginState = await ev(`(async () => {
  for (let i = 0; i < 120; i++) {
    if (!location.pathname.startsWith('/login')) return 'already-signed-in'
    if (document.querySelector('input[type=email]') && document.querySelector('input[type=password]')) return 'form'
    await new Promise(r => setTimeout(r, 500))
  }
  return 'neither'
})()`)
if (loginState === 'form') {
  await ev(`(async () => {
    const set = (el, v) => {
      const p = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set
      p.call(el, v); el.dispatchEvent(new Event('input', { bubbles: true }))
    }
    set(document.querySelector('input[type=email]'), ${JSON.stringify(E.PORTAL_RPC_OWNER_EMAIL || '')})
    set(document.querySelector('input[type=password]'), ${JSON.stringify(E.PORTAL_RPC_OWNER_PASSWORD || '')})
    await new Promise(r => setTimeout(r, 250))
    ;[...document.querySelectorAll('button')].find(b => /sign in|log in/i.test(b.textContent||''))?.click()
  })()`)
  await sleep(10000)
}
check('signed in', !(await ev(`location.pathname`)).startsWith('/login'), await ev(`location.pathname`))

// ── The real New Quote page ──────────────────────────────────────────────────
await S('Page.navigate', { url: base + '/dashboard/quotes/new' })
await sleep(3000)
await S('Emulation.setDeviceMetricsOverride', metrics)
const ready = await ev(`(async () => {
  for (let i = 0; i < 60; i++) {
    if (document.querySelector('form')) return true
    await new Promise(r => setTimeout(r, 500))
  }
  return false
})()`)
check('New Quote page rendered', ready === true)

// The address field is an AddressAutocomplete: a combobox input inside a wrapper
// that also owns the listbox. Find it by role rather than by label text, so a
// copy change does not silently turn this proof into a no-op.
const found = await ev(`(() => {
  const inputs = [...document.querySelectorAll('input[role=combobox], input[aria-autocomplete]')]
  const addr = inputs.find(i => /address/i.test(i.id || '') || /address/i.test(i.getAttribute('aria-label') || '') || /address/i.test(i.placeholder || ''))
    || inputs[0]
  if (!addr) return 'not found'
  addr.setAttribute('data-eq-probe', '1')
  addr.scrollIntoView({ block: 'center' })
  return addr.id || addr.getAttribute('aria-label') || 'combobox'
})()`)
check('address combobox present', found !== 'not found', String(found))

// ── Type a partial address ───────────────────────────────────────────────────
// React controls this input, so the native value setter plus an input event is
// the only way to drive it; the component debounces 250ms and needs >= 3 chars.
await ev(`(() => {
  const el = document.querySelector('[data-eq-probe="1"]')
  el.focus()
  const set = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set
  set.call(el, ${JSON.stringify(QUERY)})
  el.dispatchEvent(new Event('input', { bubbles: true }))
  return true
})()`)
await sleep(4000)

const state = await ev(`(() => {
  const el = document.querySelector('[data-eq-probe="1"]')
  const box = el && el.closest('div')
  const listbox = document.querySelector('[role=listbox]')
  const opts = listbox ? [...listbox.querySelectorAll('[role=option]')].map(o => (o.textContent || '').trim()) : []
  return {
    value: el ? el.value : null,
    optionCount: opts.length,
    options: opts.slice(0, 5),
    bannerShown: /Address suggestions unavailable/i.test(document.body.innerText || ''),
  }
})()`)

const placesCalls = netEvents.filter(n => n.url.includes('/api/places/autocomplete'))
check('/api/places/autocomplete was called', placesCalls.length > 0, `${placesCalls.length} call(s)`)
check('…and did not 502', !placesCalls.some(c => c.status >= 500),
  placesCalls.map(c => c.status).join(',') || 'none')
check('…and returned 200', placesCalls.every(c => c.status === 200),
  placesCalls.map(c => c.status).join(',') || 'none')

// ⭐ THE BANNER IS THE THING BEING DISPROVED. Its presence is the exact symptom
// the owner reported, and it renders only on a >= 500 — i.e. a broken credential,
// never a mere no-result.
check('the "suggestions unavailable" banner is ABSENT', state.bannerShown === false,
  state.bannerShown ? 'STILL SHOWING — the credential is not fixed' : 'not shown')
check('suggestions appeared', state.optionCount > 0, `${state.optionCount} option(s)`)
if (state.options.length) console.log('    ' + state.options.map(o => `• ${o}`).join('\n    '))

// ── Pick one, and check the canonical address lands ──────────────────────────
let picked = null
if (state.optionCount > 0) {
  const before = state.value
  await ev(`(() => {
    const o = document.querySelector('[role=listbox] [role=option]')
    o.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }))
    o.click()
    return true
  })()`)
  await sleep(3500)
  picked = await ev(`(() => {
    const el = document.querySelector('[data-eq-probe="1"]')
    return { value: el ? el.value : null, listOpen: !!document.querySelector('[role=listbox]') }
  })()`)
  check('selecting a suggestion fills the address', !!picked.value && picked.value !== before,
    `"${before}" → "${picked.value}"`)
  check('…with a canonical address, not the fragment',
    !!picked.value && picked.value.length > String(QUERY).length,
    picked.value || '')
  check('the suggestion list closes after picking', picked.listOpen === false)

  const details = netEvents.filter(n => n.url.includes('/api/places/details'))
  check('/api/places/details resolved the pick', details.length > 0 && details.every(d => d.status === 200),
    details.map(d => d.status).join(',') || 'not called')
}

// ── Nothing anywhere may say the key is bad ──────────────────────────────────
const apiFailures = netEvents.filter(n => n.status >= 400)
check('no /api/* call failed', apiFailures.length === 0,
  apiFailures.map(f => `${f.status} ${f.url.replace(base, '')}`).join(' · ') || 'all clean')
const badKey = consoleErrors.filter(t => /REQUEST_DENIED|API key|InvalidKey|RefererNotAllowed/i.test(t))
check('no invalid-key error in the console', badKey.length === 0, badKey[0]?.slice(0, 140) || 'clean')

if (shot) {
  const { data } = await S('Page.captureScreenshot', { format: 'png' })
  writeFileSync(shot, Buffer.from(data, 'base64'))
  console.log('  screenshot → ' + shot)
}

const failed = results.filter(r => !r.ok)
console.log(`\n${results.length - failed.length}/${results.length} checks passed`)
if (failed.length) console.log('FAILED: ' + failed.map(f => f.name).join(' · '))
chrome.kill()
process.exit(failed.length ? 1 : 0)
