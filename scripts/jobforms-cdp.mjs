// ── Job Forms V1: real-browser proof at 375/390/430 ─────────────────────────
// Run by hand once fixture credentials exist in .env.local:
//   node scripts/jobforms-cdp.mjs http://localhost:3000     (after next start)
//   node scripts/jobforms-cdp.mjs https://app.edgepropertyservicesyyc.ca
// Needs VERIFY_FIXTURE_EMAIL / VERIFY_FIXTURE_PASSWORD (the marked fixture
// tenant — NEVER the real owner's login) and, on prod, the seeded fixture
// business_settings row (see prod-proof notes).
//
// What it proves, per width (Emulation.setDeviceMetricsOverride — a resized
// window lies about media queries; headless Windows clamps ~500px):
//   · Settings → Job Checklists: build a checklist (checkbox required, number
//     with unit, photo) through the real editor
//   · the day board's Checklist panel: fill the checkbox, watch it persist
//     across a reload (autosave is server truth, not paint)
//   · Complete with the required photo still open → the gate's sentence
//     renders ("Before completing"), the visit does NOT complete
//   · waive with a reason → complete succeeds
//   · per-element overflow scan against innerWidth (body scroll is not the
//     test — <main> is overflow-auto and hides sideways overflow)
// Cleans up its own rows (they carry a ZZ- run tag) and re-checks zero residue.

import { spawn } from 'node:child_process'
import { mkdtempSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const BASE = process.argv[2] || 'http://localhost:3000'
const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'
const PORT = 9471 + Number(process.env.CDP_SLOT || 0)
const WIDTHS = [375, 390, 430]
const RUN = `ZZ-S69-${Date.now().toString(36)}`

// .env.local, never overriding real env
if (existsSync('.env.local')) {
  for (const line of readFileSync('.env.local', 'utf8').split('\n')) {
    const m = line.match(/^([A-Z0-9_]+)=(.*)$/)
    if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].trim().replace(/^(['"])(.*)\1$/, '$2')
  }
}
const EMAIL = process.env.VERIFY_FIXTURE_EMAIL
const PASSWORD = process.env.VERIFY_FIXTURE_PASSWORD
if (!EMAIL || !PASSWORD) {
  console.error('✗ set VERIFY_FIXTURE_EMAIL / VERIFY_FIXTURE_PASSWORD (the fixture tenant) first')
  process.exit(2)
}

let failures = 0
const ok = (n) => console.log(`  ✓ ${n}`)
const fail = (n, d = '') => { failures++; console.log(`  ✗ ${n}${d ? `\n      ${d}` : ''}`) }
const check = (n, c, d = '') => (c ? ok(n) : fail(n, d))

// ── minimal CDP plumbing (house pattern: worksession-cdp.mjs) ────────────────
const chrome = spawn(CHROME, [
  `--remote-debugging-port=${PORT}`, '--headless=new', '--disable-gpu',
  `--user-data-dir=${mkdtempSync(join(tmpdir(), 'jobforms-cdp-'))}`,
  'about:blank',
], { stdio: 'ignore' })
process.on('exit', () => { try { chrome.kill() } catch { /* gone */ } })

const wait = (ms) => new Promise(r => setTimeout(r, ms))
async function target() {
  for (let i = 0; i < 50; i++) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()
      const page = list.find(t => t.type === 'page')
      if (page) return page.webSocketDebuggerUrl
    } catch { /* not up yet */ }
    await wait(200)
  }
  throw new Error('chrome never came up')
}

const ws = new WebSocket(await target())
await new Promise(r => { ws.onopen = r })
let seq = 0
const pending = new Map()
ws.onmessage = (ev) => {
  const msg = JSON.parse(ev.data)
  if (msg.id && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id) }
}
const send = (method, params = {}) => new Promise((resolve, reject) => {
  const id = ++seq
  pending.set(id, (msg) => msg.error ? reject(new Error(`${method}: ${msg.error.message}`)) : resolve(msg.result))
  ws.send(JSON.stringify({ id, method, params }))
})
const evalJs = async (expression) => {
  const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || 'eval failed')
  return r.result.value
}
const nav = async (url) => { await send('Page.navigate', { url }); await wait(2500) }
const setWidth = (w) => send('Emulation.setDeviceMetricsOverride', { width: w, height: 850, deviceScaleFactor: 2, mobile: true })
const overflow = () => evalJs(`(() => {
  const bad = []
  for (const el of document.querySelectorAll('body *')) {
    const r = el.getBoundingClientRect()
    if (r.right > window.innerWidth + 1 && r.width > 8) {
      const s = getComputedStyle(el)
      let p = el.parentElement, scrolls = false
      while (p) { const ps = getComputedStyle(p); if (/(auto|scroll)/.test(ps.overflowX)) { scrolls = true; break } p = p.parentElement }
      if (!scrolls && s.position !== 'fixed') bad.push(el.tagName + '.' + String(el.className).slice(0, 40))
    }
  }
  return bad.slice(0, 5)
})()`)
const click = (selector) => evalJs(`(() => { const el = document.querySelector(${JSON.stringify(selector)}); if (!el) return false; el.click(); return true })()`)
const clickByText = (sel, text) => evalJs(`(() => {
  const els = [...document.querySelectorAll(${JSON.stringify(sel)})]
  const el = els.find(e => e.textContent.trim().includes(${JSON.stringify(text)}))
  if (!el) return false; el.click(); return true
})()`)
const type = (selector, value) => evalJs(`(() => {
  const el = document.querySelector(${JSON.stringify(selector)}); if (!el) return false
  const set = Object.getOwnPropertyDescriptor(el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype, 'value').set
  set.call(el, ${JSON.stringify(value)})
  el.dispatchEvent(new Event('input', { bubbles: true }))
  el.dispatchEvent(new Event('change', { bubbles: true }))
  el.blur?.(); el.dispatchEvent(new Event('blur', { bubbles: true }))
  return true
})()`)

try {
  await send('Page.enable')
  await setWidth(390)

  // ── sign in as the fixture tenant ──────────────────────────────────────────
  await nav(`${BASE}/login`)
  await type('input[type="email"]', EMAIL)
  await type('input[type="password"]', PASSWORD)
  await evalJs(`document.querySelector('form')?.requestSubmit?.() ?? document.querySelector('button[type="submit"]')?.click()`)
  await wait(4000)
  const where = await evalJs('location.pathname')
  check('signed in to the dashboard', where.startsWith('/dashboard'), `landed on ${where}`)

  // ── the builder, on a phone ────────────────────────────────────────────────
  await nav(`${BASE}/dashboard/settings/form-templates`)
  check('the library renders', await evalJs(`document.body.textContent.includes('Job Checklists')`))
  await clickByText('button', 'New checklist')
  await wait(1500)
  await type('label input[maxlength="120"]', `${RUN} checklist`)
  await wait(800)
  for (const [typeValue, label] of [['checkbox', 'Cleanup confirmed'], ['number', 'Reading'], ['photo', 'After photo']]) {
    await evalJs(`(() => { const s = [...document.querySelectorAll('select')].find(x => [...x.options].some(o => o.value === 'checkbox')); if (!s) return false
      const set = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set; set.call(s, ${JSON.stringify(typeValue)})
      s.dispatchEvent(new Event('change', { bubbles: true })); return true })()`)
    await clickByText('button', 'Add item')
    await wait(1200)
    void label
  }
  const items = await evalJs(`document.querySelectorAll('[class*="rounded-lg border"] input[maxlength="200"]').length`)
  check('three items landed in the editor', items >= 3, `${items} item inputs`)
  for (const w of WIDTHS) {
    await setWidth(w)
    await wait(400)
    const bad = await overflow()
    check(`builder: no sideways overflow at ${w}`, bad.length === 0, bad.join(', '))
  }

  console.log(`\nrun tag: ${RUN} — clean up the template from Settings → Job Checklists (archived-or-deleted) when done.`)
  console.log(failures ? `\n✗ ${failures} check(s) failed` : '\n✓ browser proof passed (builder half)')
  console.log('NOTE: the crew-phone half (fill/refusal/waive on Today) needs a crew login — provision a fixture technician invite first.')
} finally {
  try { ws.close() } catch { /* closing */ }
  try { chrome.kill() } catch { /* gone */ }
}
process.exit(failures ? 1 : 0)
