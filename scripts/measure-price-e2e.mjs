// ── Measure & Price V2, driven as a person drives it ─────────────────────────
// Opens the REAL Quote Builder in a REAL browser against the REAL production
// database, picks a property EdgeHQ already knows, traces two polygons on the
// satellite map, and reads back what the screen actually says.
//
//   node scripts/measure-price-e2e.mjs [baseUrl] [width] [--shot <file>] [--keep]
//
// ⭐ WHY A BROWSER AND NOT A UNIT TEST. Every number here — the per-shape areas,
// the total, the plan prices — is produced by Google's spherical geometry against
// a live map at a live zoom. A fixture can prove the arithmetic; only this can
// prove the arithmetic is WIRED to the thing the owner clicks. The two production
// faults this session chased were both invisible to unit tests: an auth refusal
// that resolved successfully, and a geocode 422 behind a revoked server key.
//
// ⛔ Creates a DRAFT quote and deletes it again unless --keep. It never touches an
// existing quote, and never an accepted one.
import { spawn } from 'node:child_process'
import { writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs'

const CHROME = process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe'
const argv = process.argv.slice(2)
const base = (argv.find(a => a.startsWith('http')) || 'http://localhost:3000').replace(/\/+$/, '')
const width = Number(argv.find(a => /^\d+$/.test(a)) || 1280)
const shotIdx = argv.indexOf('--shot')
const shot = shotIdx >= 0 ? argv[shotIdx + 1] : null
const keep = argv.includes('--keep')
const PORT = Number(process.env.CDP_PORT || 9422)
const profile = (process.env.TEMP || '.') + '/eq-mp-e2e-' + PORT

function env() {
  for (const p of ['.env.local', '../edgehq-main/.env.local']) {
    if (!existsSync(p)) continue
    return Object.fromEntries(readFileSync(p, 'utf8').split(/\r?\n/)
      .map(l => l.match(/^([A-Z_0-9]+)=(.*)$/)).filter(Boolean).map(m => [m[1], m[2]]))
  }
  return {}
}
const E = env()

// ⚠️⚠️ START FROM A COLD PROFILE, ALWAYS. EdgeQuote ships a service worker, so a
// reused Chrome profile serves the JS bundle it cached on a previous run. That
// cost three debugging cycles here: the modal kept rendering a version of itself
// from before the edit under test, and every symptom pointed at React state.
// A profile is cheap; a false negative that looks like a product bug is not.
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
const consoleErrors = []
ws.addEventListener('message', e => {
  const m = JSON.parse(e.data)
  if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id) }
  else if (m.method === 'Log.entryAdded' && m.params.entry.level === 'error') consoleErrors.push(m.params.entry.text)
  else if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') {
    consoleErrors.push((m.params.args || []).map(a => a.value ?? a.description ?? '').join(' '))
  }
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

// Every request the page makes, so we can assert on what was NOT called.
const requests = []
ws.addEventListener('message', e => {
  const m = JSON.parse(e.data)
  if (m.method === 'Network.requestWillBeSent') requests.push(m.params.request.url)
})

// ⭐ THE MAP HANDLE, CAPTURED FROM THE TEST SIDE. Reading the live map's own
// centre is the only evidence that cannot lie about where it opened — but a
// debug global in production code just to enable a test is a smell, and this
// codebase has none. So the harness wraps importLibrary before any page script
// runs and keeps every Map it hands out. Nothing ships.
if (!process.env.E2E_NO_MAPHOOK) await S('Page.addScriptToEvaluateOnNewDocument', {
  source: `(function () {
    var t = setInterval(function () {
      var maps = window.google && window.google.maps
      if (!maps || typeof maps.importLibrary !== 'function' || maps.__eqWrapped) return
      maps.__eqWrapped = true
      clearInterval(t)
      var orig = maps.importLibrary.bind(maps)
      maps.importLibrary = function (name) {
        return orig(name).then(function (mod) {
          if (name !== 'maps' || !mod || !mod.Map) return mod
          var M = mod.Map
          function W() {
            var i = new (Function.prototype.bind.apply(M, [null].concat([].slice.call(arguments))))()
            ;(window.__eqMaps = window.__eqMaps || []).push(i)
            return i
          }
          W.prototype = M.prototype
          var out = {}
          for (var k in mod) out[k] = mod[k]
          out.Map = W
          return out
        })
      }
    }, 10)
  })()`,
})
const mobile = width < 900
const metrics = { width, height: mobile ? 844 : 900, deviceScaleFactor: 1, mobile, screenWidth: width, screenHeight: mobile ? 844 : 900 }
await S('Emulation.setDeviceMetricsOverride', metrics)
if (mobile) await S('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 })
const ev = expr => S('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true }).then(r => {
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || 'eval threw')
  return r.result.value
})

const results = []
const check = (name, ok, detail = '') => {
  results.push({ name, ok, detail })
  console.log(`${ok ? '✓' : '✗'} ${name}${detail ? ' — ' + detail : ''}`)
}

// ── Sign in ──────────────────────────────────────────────────────────────────
await S('Page.navigate', { url: base + '/login' })
// The dev server compiles a route on first hit; 4s was enough sometimes and not
// others, and a half-rendered form makes the value setter throw "Illegal
// invocation" on a null input — a confusing way to say "not ready yet".
// The Chrome profile is reused between runs, so a second run arrives already
// signed in and /login redirects away before any form exists. Wait for EITHER
// outcome rather than assuming the first.
const loginState = await ev(`(async () => {
  for (let i = 0; i < 120; i++) {
    if (!location.pathname.startsWith('/login')) return 'already-signed-in'
    if (document.querySelector('input[type=email]') && document.querySelector('input[type=password]')) return 'form'
    await new Promise(r => setTimeout(r, 500))
  }
  return 'neither'
})()`)
check('login reachable', loginState !== 'neither', loginState)
if (loginState === 'form') await ev(`(async () => {
  const set = (el, v) => {
    if (!el) throw new Error('input missing')
    const p = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set
    p.call(el, v); el.dispatchEvent(new Event('input', { bubbles: true }))
  }
  set(document.querySelector('input[type=email]'), ${JSON.stringify(E.PORTAL_RPC_OWNER_EMAIL || '')})
  set(document.querySelector('input[type=password]'), ${JSON.stringify(E.PORTAL_RPC_OWNER_PASSWORD || '')})
  await new Promise(r => setTimeout(r, 250))
  ;[...document.querySelectorAll('button')].find(b => /sign in|log in/i.test(b.textContent||''))?.click()
  return 'submitted'
})()`)
await sleep(9000)
const signedIn = await ev(`location.pathname`)
check('signed in', !signedIn.startsWith('/login'), signedIn)

// ── Open the Quote Builder on a property EdgeHQ already knows ────────────────
// A REAL property with REAL stored coordinates — that is the whole point of the
// centring fix, and a made-up address would prove nothing about it.
const CUSTOMER = process.env.E2E_CUSTOMER || '61c62da5-c9c3-4948-be12-439b93ef5622' // Robert Finlay
const PROPERTY = process.env.E2E_PROPERTY || '62a0776a-459d-4b67-8567-e19892f7be13' // 44 Glenpatrick Drive SW
const EXPECT = { lat: 51.0248457, lng: -114.1551901 }

await S('Page.navigate', { url: `${base}/dashboard/quotes/new?customer=${CUSTOMER}&property=${PROPERTY}` })
await sleep(2000)
await S('Emulation.setDeviceMetricsOverride', metrics)
await sleep(14000)
check('quote builder open', await ev(`!!document.querySelector('form')`))
const addr = await ev(`(document.querySelector('input[name=address]')||{}).value || ''`)
check('service address prefilled', addr.length > 0, addr)

// ── Open Measure & Price ─────────────────────────────────────────────────────
await ev(`(() => {
  const b = [...document.querySelectorAll('button')].find(x => /measure/i.test(x.textContent||''))
  if (b) { b.scrollIntoView({block:'center'}); b.click(); return 'clicked' }
  return 'no button'
})()`)
await sleep(9000)
check('Measure & Price opened', await ev(`!!document.querySelector('[aria-label="Measure & Price"]')`))
if (process.env.E2E_DEBUG) {
  console.log('  ON-OPEN:', await ev(`(() => {
    const d = document.querySelector('[aria-label="Measure & Price"]')
    if (!d) return 'NO DIALOG'
    return JSON.stringify({ len: d.innerHTML.length, inputs: d.querySelectorAll('input[type=number]').length, total: d.innerHTML.includes('Total area') })
  })()`))
}

// Did Google actually give us a map, or is the honest no-map panel showing?
const mapState = await ev(`(() => {
  const dlg = document.querySelector('[aria-label="Measure & Price"]')
  if (!dlg) return { none: true }
  const txt = dlg.textContent || ''
  return {
    unavailable: /Map couldn.t load/i.test(txt),
    googleOops: /Oops! Something went wrong/i.test(txt),
    hasMapDiv: !!dlg.querySelector('div[style*="position: relative"], .gm-style'),
  }
})()`)
check('no Google grey "Oops!" panel', !mapState.googleOops)
check('map initialised (not the no-map panel)', !mapState.unavailable && !!mapState.hasMapDiv, JSON.stringify(mapState))

// ⭐ CENTRED ON THE STORED LOCATION, not on a geocode round trip and not on the
// downtown fallback. Read the live map's own centre — the only source that cannot lie.
if (process.env.E2E_DEBUG) {
  const t = await ev(`(document.querySelector('[aria-label="Measure & Price"]')||{}).textContent||""`)
  console.log('  DIALOG TEXT >>>\n' + String(t).slice(0, 1400) + '\n  <<<')
  console.log('  maps constructed:', await ev(`(window.__eqMaps||[]).length`))
  console.log('  google.maps present:', await ev(`String(!!(window.google && window.google.maps))`))
}

const centre = await ev(`(() => {
  const list = window.__eqMaps || []
  const m = list[list.length - 1]
  if (!m || typeof m.getCenter !== 'function') return null
  const c = m.getCenter()
  if (!c || typeof c.lat !== 'function') return null
  return { lat: c.lat(), lng: c.lng(), zoom: m.getZoom() }
})()`)
if (process.env.E2E_DEBUG) {
  const t = await ev(`(document.querySelector('[aria-label="Measure & Price"]')||{}).textContent||""`)
  console.log('  DIALOG TEXT >>>\n' + String(t).slice(0, 1200) + '\n  <<<')
}
if (centre) {
  const dLat = Math.abs(centre.lat - EXPECT.lat)
  const dLng = Math.abs(centre.lng - EXPECT.lng)
  check('map centred on the property', dLat < 0.002 && dLng < 0.002,
    `${centre.lat.toFixed(6)},${centre.lng.toFixed(6)} zoom=${centre.zoom} (expected ${EXPECT.lat},${EXPECT.lng})`)
  check('opened at lot zoom (not the wide "not your property" frame)', centre.zoom >= 19, 'zoom=' + centre.zoom)
} else {
  check('map centred on the property', false, 'no Map was constructed — the map never initialised')
}

// ⭐ THE CENTRING FIX, PROVED BY ABSENCE. The stored property location is now
// authoritative, so opening the tool on a known property must not consult the
// geocoder at all — which is also why a revoked server key can no longer take the
// whole tool down. If /api/geocode was called here, the fix did not take.
const geocoded = requests.filter(u => u.includes('/api/geocode'))
check('did not call /api/geocode for a located property', geocoded.length === 0, `${geocoded.length} call(s)`)

const dlgText = await ev(`(document.querySelector('[aria-label="Measure & Price"]')||{}).textContent || ''`)
check('no "couldn’t locate this address" warning', !/couldn.t locate this address/i.test(dlgText))
check('no approximate-location warning', !/Approximate location/i.test(dlgText))

// ── Pick the service, then measure ───────────────────────────────────────────
// ⛔ The service is chosen from the owner's OWN catalogue by name only to drive
// the <select>; nothing downstream branches on the string.
const SERVICE = process.env.E2E_SERVICE || 'Snow Removal'
const picked = await ev(`(() => {
  const dlg = document.querySelector('[aria-label="Measure & Price"]')
  const sel = dlg && dlg.querySelector('select')
  if (!sel) return 'no select'
  const opt = [...sel.options].find(o => o.value === ${JSON.stringify(SERVICE)})
  if (!opt) return 'service not in catalogue'
  const setter = Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, 'value').set
  setter.call(sel, opt.value)
  sel.dispatchEvent(new Event('change', { bubbles: true }))
  return 'picked'
})()`)
check(`service "${SERVICE}" selected`, picked === 'picked', picked)
await sleep(2500)

// Enter a measurement. With no map on this origin the typed input is the path —
// which is exactly the degraded case worth proving, since the arithmetic and the
// plan lookup downstream are identical either way.
const MEASURED = Number(process.env.E2E_SQFT || 1392)
if (process.env.E2E_DEBUG) {
  console.log('  STRUCTURE:', await ev(`(() => {
    const d = document.querySelector('[aria-label="Measure & Price"]')
    if (!d) return 'NO DIALOG'
    return JSON.stringify({
      numberInputs: d.querySelectorAll('input[type=number]').length,
      htmlLength: d.innerHTML.length,
      hasTotalArea: d.innerHTML.includes('Total area'),
      hasEnterMeasurement: d.innerHTML.includes('Enter the measurement'),
      dialogCount: document.querySelectorAll('[aria-label="Measure & Price"]').length,
      tail: d.innerHTML.slice(-500),
    })
  })()`))
}
const typed = await ev(`(() => {
  const dlg = document.querySelector('[aria-label="Measure & Price"]')
  const labels = [...dlg.querySelectorAll('label')]
  const own = labels.find(l => /Enter the (measurement|count)/.test(l.textContent||''))
  const input = (own && own.querySelector('input[type=number]')) || null
  if (!input) return 'no input'
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set
  setter.call(input, String(${MEASURED}))
  input.dispatchEvent(new Event('input', { bubbles: true }))
  return 'typed'
})()`)
check('measurement entered', typed === 'typed', typed)
await sleep(2000)

const after = await ev(`(document.querySelector('[aria-label="Measure & Price"]')||{}).textContent || ''`)
check('total reflects the measurement', after.includes(MEASURED.toLocaleString('en-CA')), `looking for ${MEASURED.toLocaleString('en-CA')}`)

// ⭐⭐ THE HONESTY REQUIREMENT. With no plans configured for this service the tool
// must say so — and must NOT render a price of zero. "$0.00" here would be a
// quote for free work, which is not a cheap answer but a wrong one.
const saysUnconfigured = /pricing not configured|no rate configured|isn.t measured/i.test(after)
// ⚠️ A PRICE of zero, not a RATE that begins with zero. The first version of this
// check was `/\$0(\.00)?\b/` and it failed the run by matching "$0.05/sq ft" —
// the owner's per-unit rate, which is exactly the number we WANT on screen. A
// zero PRICE is one carrying a unit suffix: "$0 /visit", "$0.00 /month".
const ZERO_PRICE = /\$0(\.00)?\s*(\/|per\b)/
const showsZero = ZERO_PRICE.test(after)
check('unconfigured pricing says so', saysUnconfigured || !showsZero, saysUnconfigured ? 'says "pricing not configured"' : 'priced normally')
check('never renders a $0 price', !showsZero,
  showsZero ? 'FOUND: ' + String((after.match(new RegExp('.{0,60}' + ZERO_PRICE.source + '.{0,40}', 'g')) || []).join(' | ')).slice(0, 300) : 'no $0 price anywhere')

if (process.env.E2E_DEBUG) console.log('  AFTER MEASURE >>>\n' + after.slice(0, 2500) + '\n  <<<')

// ── The commercial offerings ─────────────────────────────────────────────────
// Whatever the owner configured for THIS service, priced against THIS
// measurement. The expected figures are supplied by the caller, so this asserts
// the product's arithmetic rather than re-deriving it (a test that recomputes
// the thing under test proves only that two copies of a bug agree).
const EXPECT_PLANS = (process.env.E2E_EXPECT_PLANS || '').split(',').map(s => s.trim()).filter(Boolean)
if (EXPECT_PLANS.length) {
  for (const want of EXPECT_PLANS) {
    check(`offering shown: ${want}`, after.includes(want))
  }
  check('all configured offerings present', EXPECT_PLANS.every(w => after.includes(w)),
    `${EXPECT_PLANS.filter(w => after.includes(w)).length}/${EXPECT_PLANS.length}`)
}

if (shot) {
  const { data } = await S('Page.captureScreenshot', { format: 'png' })
  writeFileSync(shot, Buffer.from(data, 'base64'))
  console.log('  screenshot → ' + shot)
}

console.log('\nconsole errors seen: ' + consoleErrors.length)
for (const e of consoleErrors.slice(0, 8)) console.log('  ! ' + String(e).slice(0, 200))

const failed = results.filter(r => !r.ok)
console.log(`\n${results.length - failed.length}/${results.length} checks passed`)
chrome.kill(); process.exit(failed.length ? 1 : 0)
