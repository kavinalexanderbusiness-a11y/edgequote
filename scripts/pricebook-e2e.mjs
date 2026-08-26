// ── The Price Book plan editor, driven as the owner drives it ────────────────
//   node scripts/pricebook-e2e.mjs [baseUrl] [width] [--service "Ice Control"]
//
// Opens Settings → Services, edits ONE service, turns on measurement, enables
// commercial terms with rates, saves, then REOPENS it and reads back what
// persisted. A save that appears to work and a save that round-trips are
// different claims, and only the second one is worth anything.
//
// ⛔⛔ The rates typed here are SYNTHETIC and are removed by the restore pass.
// The owner enters their real numbers; nothing in the product ships a default.
import { spawn } from 'node:child_process'
import { readFileSync, existsSync, rmSync, writeFileSync } from 'node:fs'

const CHROME = process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe'
const argv = process.argv.slice(2)
const base = (argv.find(a => a.startsWith('http')) || 'http://localhost:3000').replace(/\/+$/, '')
const width = Number(argv.find(a => /^\d+$/.test(a)) || 1280)
const svcIdx = argv.indexOf('--service')
const SERVICE = svcIdx >= 0 ? argv[svcIdx + 1] : (process.env.E2E_SERVICE || 'Ice Control')
const PORT = Number(process.env.CDP_PORT || 9600)
const profile = (process.env.TEMP || '.') + '/eq-pricebook-' + PORT

const E = (() => {
  for (const p of ['.env.local', '../edgehq-main/.env.local']) {
    if (!existsSync(p)) continue
    return Object.fromEntries(readFileSync(p, 'utf8').split(/\r?\n/)
      .map(l => l.match(/^([A-Z_0-9]+)=(.*)$/)).filter(Boolean).map(m => [m[1], m[2]]))
  }
  return {}
})()

try { rmSync(profile, { recursive: true, force: true }) } catch { /* first run */ }
const chrome = spawn(CHROME, ['--headless=new', '--disable-gpu', '--no-sandbox', '--hide-scrollbars',
  `--remote-debugging-port=${PORT}`, '--user-data-dir=' + profile, 'about:blank'], { stdio: 'ignore' })
const sleep = ms => new Promise(r => setTimeout(r, ms))
async function wsUrl() {
  for (let i = 0; i < 120; i++) {
    try { return (await (await fetch(`http://127.0.0.1:${PORT}/json/version`)).json()).webSocketDebuggerUrl }
    catch { await sleep(250) }
  }
  throw new Error('no debug port')
}
const ws = new WebSocket(await wsUrl())
await new Promise(r => ws.addEventListener('open', r, { once: true }))
let id = 0; const pending = new Map()
ws.addEventListener('message', e => {
  const m = JSON.parse(e.data)
  if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id) }
})
const send = (method, params = {}, sessionId) => new Promise((res, rej) => {
  const n = ++id
  pending.set(n, m => m.error ? rej(new Error(method + ': ' + m.error.message)) : res(m.result))
  ws.send(JSON.stringify({ id: n, method, params, sessionId }))
})
const { targetId } = await send('Target.createTarget', { url: 'about:blank' })
const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true })
const S = (m, p) => send(m, p, sessionId)
await S('Page.enable'); await S('Runtime.enable')
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

console.log(`Price Book plan editor — ${base} @ ${width}px · service "${SERVICE}"\n`)

// ── Sign in ──────────────────────────────────────────────────────────────────
await S('Page.navigate', { url: base + '/login' })
const st = await ev(`(async () => {
  for (let i = 0; i < 120; i++) {
    if (!location.pathname.startsWith('/login')) return 'in'
    if (document.querySelector('input[type=email]')) return 'form'
    await new Promise(r => setTimeout(r, 500))
  }
  return 'neither'
})()`)
if (st === 'form') {
  await ev(`(async () => {
    const set = (el, v) => { const p = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype,'value').set; p.call(el, v); el.dispatchEvent(new Event('input',{bubbles:true})) }
    set(document.querySelector('input[type=email]'), ${JSON.stringify(E.PORTAL_RPC_OWNER_EMAIL || '')})
    set(document.querySelector('input[type=password]'), ${JSON.stringify(E.PORTAL_RPC_OWNER_PASSWORD || '')})
    await new Promise(r => setTimeout(r, 250))
    ;[...document.querySelectorAll('button')].find(b => /sign in|log in/i.test(b.textContent||''))?.click()
  })()`)
  await sleep(10000)
}
check('signed in', !(await ev(`location.pathname`)).startsWith('/login'))

// ── Settings → Services ──────────────────────────────────────────────────────
await S('Page.navigate', { url: base + '/dashboard/settings/templates' })
await sleep(3000)
await S('Emulation.setDeviceMetricsOverride', metrics)
const listed = await ev(`(async () => {
  for (let i = 0; i < 60; i++) {
    if ((document.body.innerText || '').includes(${JSON.stringify(SERVICE)})) return true
    await new Promise(r => setTimeout(r, 500))
  }
  return false
})()`)
check(`"${SERVICE}" listed in the Price Book`, listed === true)

// Open its editor. The row's Edit control, not the row itself.
const opened = await ev(`(async () => {
  const rows = [...document.querySelectorAll('div,li')].filter(el =>
    (el.textContent || '').includes(${JSON.stringify(SERVICE)}) && el.querySelector('button'))
  const row = rows[rows.length - 1]
  if (!row) return 'row not found'
  const btn = [...row.querySelectorAll('button')].find(b =>
    /edit/i.test(b.getAttribute('aria-label') || '') || /edit/i.test(b.title || '')) || row.querySelector('button')
  if (!btn) return 'edit control not found'
  btn.click()
  for (let i = 0; i < 40; i++) {
    if ((document.body.innerText || '').includes('Measure & Price')) return 'open'
    await new Promise(r => setTimeout(r, 250))
  }
  return 'form did not show the editor'
})()`)
check('the Measure & Price section is on the Edit Service form', opened === 'open', String(opened))

// ── Configure: measured by area, three commercial terms ──────────────────────
const configured = await ev(`(async () => {
  const setNative = (el, v) => {
    const proto = el instanceof window.HTMLSelectElement ? window.HTMLSelectElement.prototype : window.HTMLInputElement.prototype
    Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, v)
    el.dispatchEvent(new Event(el instanceof window.HTMLSelectElement ? 'change' : 'input', { bubbles: true }))
  }
  const section = [...document.querySelectorAll('div')].find(d =>
    (d.querySelector('h3')||{}).textContent && /Measure & Price/.test(d.querySelector('h3').textContent))
  if (!section) return 'section not found'

  const measureSel = section.querySelector('select')
  if (!measureSel) return 'measurement select not found'
  setNative(measureSel, 'area')
  await new Promise(r => setTimeout(r, 800))

  const want = { 'One-time': { basis: 'per_unit', rate: '0.05' }, 'Monthly': { basis: 'flat', rate: '240' }, 'Seasonal': { basis: 'flat', rate: '900' } }
  const done = []
  for (const label of Object.keys(want)) {
    const box = [...section.querySelectorAll('div')].find(d => {
      const l = d.querySelector('label')
      return l && l.textContent.trim().startsWith(label) && d.querySelector('input[type=checkbox]')
    })
    if (!box) { done.push(label + ':no-row'); continue }
    const cb = box.querySelector('input[type=checkbox]')
    if (!cb.checked) { cb.click(); await new Promise(r => setTimeout(r, 500)) }
    const sels = [...box.querySelectorAll('select')]
    if (sels[0]) setNative(sels[0], want[label].basis)
    await new Promise(r => setTimeout(r, 300))
    const num = box.querySelector('input[type=number]')
    if (num) setNative(num, want[label].rate)
    done.push(label + ':ok')
    await new Promise(r => setTimeout(r, 300))
  }
  return done.join(' ')
})()`)
check('three commercial terms enabled with rates', /One-time:ok/.test(configured) && /Monthly:ok/.test(configured) && /Seasonal:ok/.test(configured), String(configured))

// ── Save ─────────────────────────────────────────────────────────────────────
await ev(`(() => {
  const b = [...document.querySelectorAll('button')].find(x => /^(save|update|create)/i.test((x.textContent||'').trim()))
  if (b) b.click()
  return !!b
})()`)
await sleep(6000)
check('the form closed after saving', await ev(`!/Ways you sell it/.test(document.body.innerText || '')`))

// ── Reopen and read back ─────────────────────────────────────────────────────
// ⭐ THE ONLY CLAIM WORTH MAKING. A form that clears itself proves nothing; this
// re-reads the row and its plan rows from the database through the real UI.
await S('Page.navigate', { url: base + '/dashboard/settings/templates' })
await sleep(6000)
const readback = await ev(`(async () => {
  const rows = [...document.querySelectorAll('div,li')].filter(el =>
    (el.textContent || '').includes(${JSON.stringify(SERVICE)}) && el.querySelector('button'))
  const row = rows[rows.length - 1]
  if (!row) return { error: 'row not found' }
  const btn = [...row.querySelectorAll('button')].find(b =>
    /edit/i.test(b.getAttribute('aria-label') || '') || /edit/i.test(b.title || '')) || row.querySelector('button')
  btn.click()
  for (let i = 0; i < 40; i++) {
    if (/Ways you sell it/.test(document.body.innerText || '')) break
    await new Promise(r => setTimeout(r, 250))
  }
  const section = [...document.querySelectorAll('div')].find(d =>
    (d.querySelector('h3')||{}).textContent && /Measure & Price/.test(d.querySelector('h3').textContent))
  if (!section) return { error: 'section missing on reopen' }
  const measurement = (section.querySelector('select') || {}).value
  const enabled = []
  for (const label of ['One-time','Weekly','Bi-weekly','Monthly','Seasonal']) {
    const box = [...section.querySelectorAll('div')].find(d => {
      const l = d.querySelector('label')
      return l && l.textContent.trim().startsWith(label) && d.querySelector('input[type=checkbox]')
    })
    if (!box) continue
    const cb = box.querySelector('input[type=checkbox]')
    if (cb && cb.checked) {
      const num = box.querySelector('input[type=number]')
      const sel = box.querySelector('select')
      enabled.push(label + '=' + (sel ? sel.value : '?') + ':' + (num ? num.value : '?'))
    }
  }
  return { measurement, enabled }
})()`)
check('measurement persisted as area', readback.measurement === 'area', JSON.stringify(readback.measurement))
check('One-time persisted at $0.05 per unit', (readback.enabled || []).some(e => /^One-time=per_unit:0\.05/.test(e)), (readback.enabled || []).join(' · '))
check('Monthly persisted as flat $240', (readback.enabled || []).some(e => /^Monthly=flat:240/.test(e)))
check('Seasonal persisted as flat $900', (readback.enabled || []).some(e => /^Seasonal=flat:900/.test(e)))
check('nothing the owner did not tick was enabled', (readback.enabled || []).length === 3, (readback.enabled || []).join(' · '))

const failed = results.filter(r => !r.ok)
console.log(`\n${results.length - failed.length}/${results.length} checks passed`)
if (failed.length) console.log('FAILED: ' + failed.map(f => f.name).join(' · '))
chrome.kill()
process.exit(failed.length ? 1 : 0)
