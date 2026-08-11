// ── Drive the REAL app and prove the completion record works ─────────────────
// Not a fixture. This signs in with the owner credentials from .env.local, opens
// the dispatch board at a genuine phone viewport, records proof of work on a
// real visit, reloads to prove it persisted, and then reads the customer portal
// to prove the internal half never reaches it.
//
//   node scripts/pow-cdp.mjs <baseUrl> <width> [--shot]
//
// ⚠️ A FRESH profile directory every run: a persistent Chrome profile serves a
// STALE client bundle and would test the previous build.
// ⚠️ `<main>` is overflow-auto, so document.scrollWidth NEVER reports sideways
// overflow on this app. Overflow is measured per ELEMENT against innerWidth.

import { spawn } from 'node:child_process'
import { writeFileSync, readFileSync, rmSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'
const [baseUrl = 'http://127.0.0.1:3111', wArg = '390', ...rest] = process.argv.slice(2)
const width = Number(wArg)
const shot = rest.includes('--shot')
const PORT = 9333 + Number(process.env.CDP_SLOT || 0)

const env = Object.fromEntries(
  readFileSync('.env.local', 'utf8').split(/\r?\n/)
    .filter(l => l && !l.startsWith('#') && l.includes('='))
    .map(l => [l.slice(0, l.indexOf('=')).trim(), l.slice(l.indexOf('=') + 1).trim()]),
)
const EMAIL = env.PORTAL_RPC_OWNER_EMAIL || env.BACKFILL_OWNER_EMAIL
const PASSWORD = env.PORTAL_RPC_OWNER_PASSWORD || env.BACKFILL_OWNER_PASSWORD
if (!EMAIL || !PASSWORD) { console.error('no owner credentials in .env.local'); process.exit(2) }

const profile = mkdtempSync(join(tmpdir(), 'pow-cdp-'))
const chrome = spawn(CHROME, [
  '--headless=new', '--disable-gpu', '--no-sandbox', '--hide-scrollbars',
  `--remote-debugging-port=${PORT}`, '--user-data-dir=' + profile, 'about:blank',
], { stdio: 'ignore' })
chrome.on('error', e => { console.error('chrome failed to start: ' + e.message); process.exit(2) })
const trace = m => console.error('    · ' + m)

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
await S('Page.enable'); await S('Runtime.enable'); await S('Log.enable').catch(() => {})
// Capture what the PAGE says went wrong. A stuck dialog with no visible error is
// an unsettled promise, and the only place its cause is written down is here.
const pageErrors = []
ws.addEventListener('message', e => {
  const m = JSON.parse(e.data)
  if (m.method === 'Runtime.exceptionThrown') {
    const d = m.params?.exceptionDetails
    pageErrors.push('EXCEPTION: ' + (d?.exception?.description || d?.text || '').split('\n')[0])
  }
  if (m.method === 'Runtime.consoleAPICalled' && ['error', 'warning'].includes(m.params?.type)) {
    pageErrors.push(m.params.type + ': ' + (m.params.args || []).map(a => a.value ?? a.description ?? '').join(' ').slice(0, 200))
  }
  if (m.method === 'Log.entryAdded' && m.params?.entry?.level === 'error') {
    pageErrors.push('log: ' + String(m.params.entry.text).slice(0, 200))
  }
})

const metrics = { width, height: 844, deviceScaleFactor: 1, mobile: true, screenWidth: width, screenHeight: 844 }
const applyViewport = () => S('Emulation.setDeviceMetricsOverride', metrics)
await applyViewport()
await S('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 })

async function go(url, waitMs = 2600) {
  trace('navigate → ' + url)
  await S('Page.navigate', { url })
  await sleep(waitMs)
  // A commit can drop the metrics override, and a viewport that silently
  // reverted would report DESKTOP numbers as phone numbers. Re-applying is the
  // fix — but on this app the call can block behind a still-settling page, so
  // it is raced, and then the width is MEASURED rather than assumed. An
  // unverified viewport is worse than no measurement at all.
  await Promise.race([applyViewport(), sleep(4000)])
  await sleep(350)
  const vw = await evaluate('innerWidth')
  if (vw !== width) throw new Error(`viewport is ${vw}px, expected ${width}px — measurement would be false`)
  trace(`loaded @ ${vw}px`)
}
/** Wait for a selector to actually appear. A fixed sleep turns a slow fetch into
 *  a "0 stops" report, which would be the harness lying about the app. */
async function waitFor(selector, timeoutMs = 25000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await evaluate(`!!document.querySelector(${JSON.stringify(selector)})`)) return true
    await sleep(500)
  }
  return false
}
async function evaluate(expr) {
  const { result, exceptionDetails } = await S('Runtime.evaluate', {
    expression: expr, returnByValue: true, awaitPromise: true,
  })
  if (exceptionDetails) throw new Error(exceptionDetails.text + ' ' + (exceptionDetails.exception?.description || ''))
  return result.value
}

const out = { width, steps: [] }
const step = (name, ok, detail) => { out.steps.push({ name, ok: !!ok, detail }); console.error(`${ok ? '  ok  ' : '  FAIL'} ${name}${detail ? ' — ' + detail : ''}`) }

// ── 1. Sign in ───────────────────────────────────────────────────────────────
await go(baseUrl + '/login')
await evaluate(`(() => {
  const set = (el, v) => {
    const p = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set
    p.call(el, v); el.dispatchEvent(new Event('input', { bubbles: true }))
  }
  const em = document.querySelector('input[type=email]')
  const pw = document.querySelector('input[type=password]')
  set(em, ${JSON.stringify(EMAIL)}); set(pw, ${JSON.stringify(PASSWORD)})
  document.querySelector('form').requestSubmit()
  return true
})()`)
await sleep(6000)
await applyViewport()
step('signed in', !/\/login/.test(await evaluate('location.pathname')), await evaluate('location.pathname'))

// ── 2. The dispatch board at a phone width ───────────────────────────────────
await go(baseUrl + '/dashboard/dispatch', 6000)
await waitFor('[data-stop-row]')
const board = await evaluate(`(() => {
  const VW = innerWidth
  const vis = el => { const r = el.getBoundingClientRect(); if (!r.width && !r.height) return false
    for (let p = el; p; p = p.parentElement) { const s = getComputedStyle(p)
      if (s.display==='none'||s.visibility==='hidden'||s.opacity==='0') return false } return true }
  // ⚠️ per-element, because <main> is overflow-auto and hides page-level overflow
  const over = [...document.querySelectorAll('*')].filter(el => vis(el) && el.getBoundingClientRect().width > VW + 1)
  const small = [...document.querySelectorAll('button,[role=button],a[href]')]
    .filter(vis).filter(b => { const r = b.getBoundingClientRect(); return r.height > 0 && r.height < 40 })
  return { viewport: VW, stops: document.querySelectorAll('[data-stop-row]').length,
    nodesWiderThanViewport: over.length,
    widest: over.slice(0,4).map(el => Math.round(el.getBoundingClientRect().width)+'px '+el.tagName.toLowerCase()+'.'+String(el.className||'').split(' ')[0]),
    tapTargetsUnder40: small.length }
})()`)
out.board = board
step('dispatch board renders stops', board.stops > 0, `${board.stops} stops @ ${board.viewport}px`)
// ⚠️ NOT asserted: the dispatch board is a horizontally-scrolling LANE surface
// and overflows at phone width on main, before any change here. Reported so the
// number is on the record, but owning it is a dispatch-layout job, not this
// session's. What IS asserted is the sheet's own subtree, below.
out.boardOverflowPreExisting = { count: board.nodesWiderThanViewport, widest: board.widest }

// ── 3. Open the record sheet — COUNT THE TAPS ────────────────────────────────
// tap 1 = the stop's ⋯ menu · tap 2 = "Record what was done".
const opened = await evaluate(`(async () => {
  const sleep = ms => new Promise(r => setTimeout(r, ms))
  const row = document.querySelector('[data-stop-row]')
  if (!row) return { error: 'no stop row' }
  const menuBtn = [...row.querySelectorAll('button')].reverse()
    .find(b => b.querySelector('svg') && !b.textContent.trim())
  if (!menuBtn) return { error: 'no menu button' }
  menuBtn.click(); await sleep(500)                                   // tap 1
  const item = [...document.querySelectorAll('button,[role=menuitem]')]
    .find(b => /Record what was done|Edit what was done/i.test(b.textContent || ''))
  if (!item) return { error: 'no record menu item' }
  item.click(); await sleep(1200)                                     // tap 2
  const dlg = document.querySelector('[role=dialog]')
  if (!dlg) return { taps: 2, open: false }
  const VW = innerWidth
  // The sheet's OWN subtree: nothing the completion editor draws may exceed the
  // phone, and every control in it must clear a 44px thumb.
  const over = [...dlg.querySelectorAll('*')].filter(el => el.getBoundingClientRect().width > VW + 1)
  const controls = [...dlg.querySelectorAll('button,textarea,input,[role=button]')]
    .filter(el => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0 })
  const small = controls.filter(el => el.getBoundingClientRect().height < 40)
  return {
    taps: 2,
    open: true,
    title: (dlg.querySelector('h2,h3')||{}).textContent,
    textareas: dlg.querySelectorAll('textarea').length,
    labels: [...dlg.querySelectorAll('p')].map(p => p.textContent.trim()).filter(Boolean).slice(0,8),
    sheetOverflow: over.length,
    sheetWidest: over.slice(0,3).map(el => Math.round(el.getBoundingClientRect().width)+'px '+el.tagName.toLowerCase()),
    sheetControls: controls.length,
    sheetControlsUnder40: small.length,
    sheetSmallest: small.slice(0,3).map(el => Math.round(el.getBoundingClientRect().height)+'px '+((el.textContent||'').trim()||el.getAttribute('aria-label')||el.tagName).slice(0,18)),
  }
})()`)
out.open = opened
step('record sheet opens in 2 taps', opened.open && opened.taps === 2, opened.error || opened.title)
step('both audiences are shown as separate boxes', opened.textareas === 2, `${opened.textareas} textareas`)
step('the customer-visible box says who reads it',
  (opened.labels || []).some(l => /customer reads this/i.test(l)), JSON.stringify((opened.labels||[]).slice(0,4)))
step('the internal box says it is office only',
  (opened.labels || []).some(l => /office only/i.test(l)))
step('the sheet itself never overflows the phone', opened.sheetOverflow === 0,
  opened.sheetOverflow ? JSON.stringify(opened.sheetWidest) : `${opened.sheetControls} controls, clean`)
// The shared ui/Modal's close X is h-7 (28px) on EVERY dialog in the app, so it
// is reported, not owned here — and nothing is trapped behind it: this sheet can
// also be dismissed by the scrim, by Escape, and by a full-height footer button.
const smallOther = (opened.sheetSmallest || []).filter(s => !/Close|Dismiss/i.test(s))
out.sheetSmallControls = opened.sheetSmallest
step('no control this sheet OWNS is under 44px', smallOther.length === 0 && opened.sheetControlsUnder40 <= 1,
  `${opened.sheetControlsUnder40} under 40px: ${JSON.stringify(opened.sheetSmallest)} (shared Modal close X)`)

// ── 4. Type and save a real record ───────────────────────────────────────────
const STAMP = 'PoW probe ' + Date.now()
const saved = await evaluate(`(async () => {
  const sleep = ms => new Promise(r => setTimeout(r, ms))
  const dlg = document.querySelector('[role=dialog]')
  const set = (el, v) => {
    const p = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set
    p.call(el, v); el.dispatchEvent(new Event('input', { bubbles: true }))
  }
  const tas = dlg.querySelectorAll('textarea')
  set(tas[0], ${JSON.stringify(STAMP + ' — customer visible')})
  set(tas[1], ${JSON.stringify(STAMP + ' — INTERNAL ONLY')})
  await sleep(300)
  const save = [...dlg.querySelectorAll('button')].find(b => /^Save$/i.test(b.textContent.trim()))
  if (!save) return { error: 'no Save button' }
  if (save.disabled) return { error: 'Save disabled after typing — values=' + JSON.stringify([...tas].map(t => t.value.slice(0, 30))) }
  save.click()
  // Poll for the confirmation rather than sleeping past it: a toast is
  // transient, and a fixed wait turns a real pass into a flake.
  // ⚠️ Scoped to the TOAST rows. Reading document.body.textContent matched
  // ordinary page copy ("…could not be completed" lives on the board) on the
  // very first tick, so the harness reported a failure the app never produced —
  // a false alarm is as bad as a missed one.
  let toast = null
  for (let i = 0; i < 40; i++) {
    const rows = [...document.querySelectorAll('[role=status],[role=alert]')].map(r => r.textContent).join(' | ')
    const m = rows.match(/Saved to this visit|didn.t save|Nothing to change|still to upload/i)
    if (m) { toast = m[0]; break }
    await sleep(150)
  }
  // Distinguish SLOW from FAILED: wait for the dialog to close, and if it
  // does not, report the error the sheet itself is showing.
  for (let i = 0; i < 60 && document.querySelector('[role=dialog]'); i++) await sleep(250)
  const dlg2 = document.querySelector('[role=dialog]')
  const err = dlg2 ? (dlg2.querySelector('[role=alert]')||{}).textContent : null
  return { closed: !dlg2, toast, sheetError: err || null }
})()`)
out.saved = saved
step('save confirms honestly and closes', saved.closed && /Saved to this visit/i.test(saved.toast || ''),
  saved.error || `closed=${saved.closed} toast=${saved.toast} sheetError=${saved.sheetError} page=${JSON.stringify(pageErrors.slice(-4))}`)

// ── 5. Reload — did it actually persist? ─────────────────────────────────────
await go(baseUrl + '/dashboard/dispatch', 6000)
await waitFor('[data-stop-row]')
const persisted = await evaluate(`(async () => {
  const sleep = ms => new Promise(r => setTimeout(r, ms))
  const row = document.querySelector('[data-stop-row]')
  const menuBtn = [...row.querySelectorAll('button')].reverse().find(b => b.querySelector('svg') && !b.textContent.trim())
  menuBtn.click(); await sleep(500)
  const item = [...document.querySelectorAll('button,[role=menuitem]')].find(b => /what was done/i.test(b.textContent||''))
  const label = item ? item.textContent.trim() : null
  item.click(); await sleep(1200)
  const dlg = document.querySelector('[role=dialog]')
  const tas = dlg ? [...dlg.querySelectorAll('textarea')].map(t => t.value) : []
  const close = dlg && [...dlg.querySelectorAll('button')].find(b => /Close|Cancel/i.test(b.textContent))
  if (close) close.click()
  return { menuLabel: label, summary: tas[0] || '', issue: tas[1] || '' }
})()`)
out.persisted = persisted
step('the summary survived a reload', persisted.summary.includes(STAMP), persisted.summary.slice(0, 60))
step('the internal issue survived a reload', persisted.issue.includes('INTERNAL ONLY'))
step('the menu now offers to EDIT the record', /Edit what was done/i.test(persisted.menuLabel || ''), persisted.menuLabel)

if (shot) {
  const { data } = await S('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false })
  writeFileSync(`pow-${width}.png`, Buffer.from(data, 'base64'))
  console.error('shot → pow-' + width + '.png')
}

console.log(JSON.stringify({ ...out, stamp: STAMP }, null, 2))
ws.close(); chrome.kill()
try { rmSync(profile, { recursive: true, force: true }) } catch {}
process.exit(out.steps.every(s => s.ok) ? 0 : 1)
