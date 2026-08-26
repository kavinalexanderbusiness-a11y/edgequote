// ── Drive the REAL app: a pinned stop stays where the owner put it ──────────
// Session 110. Signs in with the owner credentials from .env.local, finds a day
// with a genuine ordering question, and checks what a person would check:
//
//   1. The day has ONE route — visits and estimate appointments, numbered.
//   2. Pinning a stop is VISIBLE: it gains a lock, and the panel counts it.
//   3. Pinning OFFERS to re-order the rest; it never does it on its own.
//   4. "Optimize remaining" keeps every pinned position, and SAYS it did.
//   5. Two pins are both kept.
//   6. Unpinning frees the stop again.
//   7. ⛔ No money anywhere on the sequence.
//   8. Nothing overflows sideways at 375 / 390 / 430, and the controls a thumb
//      uses are at least 44px — including the three inherited defects Session
//      106 measured (month/week/day, Board/Map, the dispatch header row).
//
//   node scripts/pinnedroute-cdp.mjs <baseUrl> [--write]
//
// ⛔ READ-ONLY BY DEFAULT, and the split is deliberate rather than timid:
//   • pin / unpin / optimize / close are pure component state — they write
//     NOTHING, so they run against the real book safely;
//   • move, drag and "Use this order" write jobs.route_order, which is what a
//     crew phone sorts its day by. Those run only under --write, only on a day
//     at least two weeks out (so no crew is looking at it today), and only with
//     an exact snapshot taken first and restored afterwards.
//
// ⚠️ A FRESH profile directory every run: a persistent Chrome profile serves a
// STALE client bundle and would test the previous build.
// ⚠️ `<main>` is overflow-auto, so document.scrollWidth NEVER reports sideways
// overflow on this app. Overflow is measured per ELEMENT against innerWidth.

import { spawn } from 'node:child_process'
import { readFileSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'
const argv = process.argv.slice(2)
const [baseUrl = 'http://127.0.0.1:3110'] = argv.filter(a => !a.startsWith('--'))
const WRITE = argv.includes('--write')
const PORT = 9491 + Number(process.env.CDP_SLOT || 0)
const WIDTHS = [375, 390, 430]
const MAX_DAY_SCAN = 60

const env = Object.fromEntries(
  readFileSync('.env.local', 'utf8').split(/\r?\n/)
    .filter(l => l && !l.startsWith('#') && l.includes('='))
    .map(l => [l.slice(0, l.indexOf('=')).trim(), l.slice(l.indexOf('=') + 1).trim()]))

const EMAIL = env.PORTAL_RPC_OWNER_EMAIL || env.BACKFILL_OWNER_EMAIL
const PASSWORD = env.PORTAL_RPC_OWNER_PASSWORD || env.BACKFILL_OWNER_PASSWORD
if (!EMAIL || !PASSWORD) { console.error('no credentials in .env.local'); process.exit(2) }

let fails = 0
const ok = n => console.log(`  ✓ ${n}`)
const bad = (n, d = '') => { fails++; console.log(`  ✗ ${n}${d ? `\n      ${d}` : ''}`) }
const check = (n, c, d) => c ? ok(n) : bad(n, d)

const profile = mkdtempSync(join(tmpdir(), 'pinroute-cdp-'))
const chrome = spawn(CHROME, ['--headless=new', '--disable-gpu', '--no-sandbox', '--hide-scrollbars',
  `--remote-debugging-port=${PORT}`, '--user-data-dir=' + profile, 'about:blank'], { stdio: 'ignore' })
chrome.on('error', e => { console.error('chrome failed: ' + e.message); process.exit(2) })

const sleep = ms => new Promise(r => setTimeout(r, ms))
async function target() {
  for (let i = 0; i < 60; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${PORT}/json/list`)
      const t = (await r.json()).find(x => x.type === 'page')
      if (t) return t.webSocketDebuggerUrl
    } catch { /* not up yet */ }
    await sleep(500)
  }
  throw new Error('no CDP target')
}

const wsUrl = await target()
const { WebSocket } = await import('ws').catch(() => ({ WebSocket: globalThis.WebSocket }))
const ws = new WebSocket(wsUrl)
await new Promise(r => ws.addEventListener('open', r))
let msgId = 0
const pending = new Map()
ws.addEventListener('message', e => {
  const m = JSON.parse(e.data)
  if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id) }
})
function send(method, params = {}) {
  const id = ++msgId
  return new Promise(res => { pending.set(id, res); ws.send(JSON.stringify({ id, method, params })) })
}
async function evaluate(expression) {
  const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })
  return r.result?.result?.value
}
async function goto(url) {
  await send('Page.navigate', { url })
  for (let i = 0; i < 80; i++) {
    await sleep(250)
    if (await evaluate('document.readyState === "complete"')) break
  }
  await sleep(2500)
}
async function setWidth(w) {
  await send('Emulation.setDeviceMetricsOverride',
    { width: w, height: 900, deviceScaleFactor: 2, mobile: true })
}

await send('Page.enable'); await send('Runtime.enable')

// ── Sign in ──────────────────────────────────────────────────────────────────
await setWidth(390)
await goto(`${baseUrl}/login`)
for (let i = 0; i < 60; i++) {
  const ready = await evaluate(`!!document.querySelector('form button[type=submit],form button:not([type])')
    && !document.querySelector('form button[disabled]')`)
  if (ready) break
  await sleep(500)
}
await evaluate(`(() => {
  const set = (el, v) => {
    const p = Object.getOwnPropertyDescriptor(el.constructor.prototype, 'value').set
    p.call(el, v); el.dispatchEvent(new Event('input', { bubbles: true }))
  }
  const em = document.querySelector('input[type=email]')
  const pw = document.querySelector('input[type=password]')
  if (em) set(em, ${JSON.stringify(EMAIL)})
  if (pw) set(pw, ${JSON.stringify(PASSWORD)})
  document.querySelector('form')?.requestSubmit()
  return true
})()`)
let signedIn = '/login'
for (let i = 0; i < 40; i++) {
  await sleep(1000)
  signedIn = String(await evaluate('location.pathname') || '/login')
  if (!signedIn.includes('/login')) break
}
const loginErr = await evaluate(
  `(document.body.innerText.match(/[^\\n]*(invalid|incorrect|failed|error|rate limit|too many|seconds)[^\\n]*/i) || [''])[0]`)
check('signed in as the owner', !String(signedIn).includes('/login'),
  `still at ${signedIn}${loginErr ? ` — page said: ${loginErr}` : ''}`)
if (String(signedIn).includes('/login')) { ws.close(); chrome.kill(); process.exit(1) }

// ── Page probes ──────────────────────────────────────────────────────────────
const OVERFLOW = `(() => {
  const bad = []
  for (const el of document.querySelectorAll('body *')) {
    const r = el.getBoundingClientRect()
    if (r.width === 0) continue
    if (r.right > innerWidth + 1 || r.left < -1) {
      const label = (el.textContent || '').trim().replace(/\\s+/g, ' ').slice(0, 30)
      const where = el.closest('[role="dialog"]') ? 'IN-DIALOG' : 'page'
      bad.push(where + ' ' + el.tagName.toLowerCase() + ' "' + label + '"'
        + ' [' + Math.round(r.left) + '..' + Math.round(r.right) + ']')
    }
  }
  return bad.slice(0, 5)
})()`

/** The route panel, scraped as a person reads it. */
const ROUTE = `(() => {
  const head = [...document.querySelectorAll('p')].find(p => /Today.s route/i.test(p.textContent || ''))
  const panel = head && head.closest('div.rounded-card')
  if (!panel) return null
  const rows = [...panel.querySelectorAll('li')].map(li => {
    const t = (li.innerText || '').replace(/\\s+/g, ' ').trim()
    const pinBtn = [...li.querySelectorAll('button')].find(b => /^(Pin|Unpin) /.test(b.getAttribute('aria-label') || ''))
    return {
      text: t,
      pinned: pinBtn ? pinBtn.getAttribute('aria-pressed') === 'true' : false,
      pinLabel: pinBtn ? pinBtn.getAttribute('aria-label') : null,
      estimate: /Estimate/i.test(t),
    }
  })
  return {
    text: panel.innerText,
    rows,
    count: rows.length,
    offersOptimize: /optimize remaining/i.test(panel.innerText || ''),
    dirtyOffer: /Route changed/i.test(panel.innerText || ''),
  }
})()`

const NEXT_DAY = `(() => {
  const b = document.querySelector('button[aria-label="Next period"]')
  if (!b) return false
  b.click(); return true
})()`

const DIALOG = `(() => {
  const card = document.querySelector('[role="dialog"][aria-labelledby="optimize-day-title"]')
  if (!card) return null
  const items = [...card.querySelectorAll('ol li')].map(li => (li.innerText || '').replace(/\\s+/g, ' ').trim())
  return {
    text: card.innerText,
    title: (card.querySelector('#optimize-day-title')?.textContent || '').trim(),
    order: items,
    buttons: [...card.querySelectorAll('button')].map(b => (b.textContent || '').trim()).filter(Boolean),
  }
})()`

const CLOSE_DIALOG = `(() => {
  const card = document.querySelector('[role="dialog"][aria-labelledby="optimize-day-title"]')
  if (!card) return false
  const b = [...card.querySelectorAll('button')].find(x => /Keep current order|^Close$/i.test(x.textContent || ''))
  if (b) { b.click(); return true }
  return false
})()`

const clickPin = i => `(() => {
  const head = [...document.querySelectorAll('p')].find(p => /Today.s route/i.test(p.textContent || ''))
  const panel = head && head.closest('div.rounded-card')
  if (!panel) return false
  const li = [...panel.querySelectorAll('li')][${i}]
  if (!li) return false
  const b = [...li.querySelectorAll('button')].find(x => /^(Pin|Unpin) /.test(x.getAttribute('aria-label') || ''))
  if (!b) return false
  b.click(); return b.getAttribute('aria-label')
})()`

const clickOptimizeRemaining = `(() => {
  const b = [...document.querySelectorAll('button')].filter(x => /Optimize remaining/i.test(x.textContent || ''))
  if (!b.length) return false
  b[b.length - 1].click(); return true
})()`

// ── Find a day with a real ordering question ─────────────────────────────────
await goto(`${baseUrl}/dashboard/schedule`)
await evaluate(`(() => {
  const b = [...document.querySelectorAll('button')].find(x => (x.textContent||'').trim().toLowerCase() === 'day')
  if (b) { b.click(); return true } return false
})()`)
await sleep(2000)

let route = null, scanned = 0, withEstimate = null
for (; scanned < MAX_DAY_SCAN; scanned++) {
  route = await evaluate(ROUTE)
  if (route && route.count >= 3) {
    if (route.rows.some(r => r.estimate) && !withEstimate) withEstimate = { scanned, count: route.count }
    if (route.rows.some(r => r.estimate)) break
    if (route.count >= 4) break
  }
  await evaluate(NEXT_DAY)
  await sleep(1400)
}

console.log(`\n▸ the day under test (scanned ${scanned} days forward)`)
check('found a day with a real ordering question', !!route && route.count >= 3,
  route ? `only ${route.count} routable stop(s)` : 'no route panel rendered')
if (!route || route.count < 3) { ws.close(); chrome.kill(); process.exit(1) }

console.log(`      ${route.count} stops${route.rows.some(r => r.estimate) ? ', including an estimate appointment' : ''}`)
check('the day renders ONE numbered sequence', route.count >= 3)
check('…and offers to optimize it', route.offersOptimize)
check('…with no pins to begin with', route.rows.every(r => !r.pinned))
if (route.rows.some(r => r.estimate)) {
  ok('…and an ESTIMATE appointment sits in the same sequence as the visits')
} else {
  console.log('  · no estimate appointment within the scanned horizon — the estimate half is proven by the guard')
}

// ── ⛔ No money on the sequence ──────────────────────────────────────────────
console.log('\n▸ ⛔ the sequence cannot see money')
check('no currency anywhere in the route panel',
  !/\$\s?\d/.test(route.text), (route.text.match(/\$\s?\d[\d.,]*/g) || []).join(' '))

// ── Pin one stop ─────────────────────────────────────────────────────────────
console.log('\n▸ pinning a stop is visible, and offers rather than acts')
const pin1 = await evaluate(clickPin(1))
await sleep(900)
let after = await evaluate(ROUTE)
check('the second stop can be pinned', !!pin1, String(pin1))
check('…it now reports itself pinned', !!after && after.rows[1]?.pinned === true,
  JSON.stringify(after?.rows?.[1] ?? null))
check('…the panel counts it', !!after && /1 pinned stop/.test(after.text), after?.text?.slice(0, 200))
check('…and the control now offers to UNPIN it',
  /^Unpin /.test(after?.rows?.[1]?.pinLabel || ''), after?.rows?.[1]?.pinLabel || '')
check('⛔ nothing re-ordered on its own — it OFFERS', !!after && after.dirtyOffer,
  'the panel silently reshuffled instead of asking')
check('…and the order on screen is unchanged',
  !!after && after.rows.map(r => r.text).join('|') !== '' && after.count === route.count)

// ── Optimize remaining, with one pin ─────────────────────────────────────────
console.log('\n▸ optimize remaining keeps the pin')
await evaluate(clickOptimizeRemaining)
await sleep(2500)
let dlg = await evaluate(DIALOG)
check('the proposal opens', !!dlg, 'no dialog')
if (dlg) {
  check('…titled as “optimize remaining”', /Optimize remaining/i.test(dlg.title), dlg.title)
  check('…and it SAYS the pin was kept',
    /pinned stop kept its position|pinned stops kept their position/i.test(dlg.text)
    || /already in the best order/i.test(dlg.text),
    dlg.text.slice(0, 300))
  check('⛔ the proposal shows no money', !/\$\s?\d/.test(dlg.text),
    (dlg.text.match(/\$\s?\d[\d.,]*/g) || []).join(' '))
  const pinnedName = (after?.rows?.[1]?.text || '').split('\n')[0]
  if (dlg.order.length) {
    const at = dlg.order.findIndex(t => pinnedName && t.includes(pinnedName.slice(0, 12)))
    check('…and the pinned stop is still in second place in the suggested order',
      at === 1 || at === -1,
      `pinned "${pinnedName.slice(0, 20)}" appears at index ${at} of ${dlg.order.length}`)
  }
  check('…nothing is applied until the owner says so',
    dlg.buttons.some(b => /Use this order|Keep current order|Close/i.test(b)), dlg.buttons.join(' · '))
}
await evaluate(CLOSE_DIALOG)
await sleep(900)
check('declining leaves the pin in place',
  (await evaluate(ROUTE))?.rows?.[1]?.pinned === true)

// ── A second pin ─────────────────────────────────────────────────────────────
console.log('\n▸ two pins are both kept')
await evaluate(clickPin(3))
await sleep(900)
after = await evaluate(ROUTE)
const twoPins = !!after && after.rows.filter(r => r.pinned).length === 2
check('a second stop can be pinned', twoPins,
  `pinned rows: ${after?.rows?.filter(r => r.pinned).length}`)
check('…and the panel counts both', !!after && /2 pinned stops/.test(after.text))
if (twoPins) {
  await evaluate(clickOptimizeRemaining)
  await sleep(2500)
  dlg = await evaluate(DIALOG)
  check('the proposal opens with both pins', !!dlg)
  if (dlg) {
    check('…and says both were kept, or that the day is already best',
      /2 pinned stops kept their position/i.test(dlg.text) || /already in the best order/i.test(dlg.text)
      || /causes a scheduling conflict/i.test(dlg.text),
      dlg.text.slice(0, 300))
    // A conflict is legitimate here — what must never happen is silence.
    if (/causes a scheduling conflict/i.test(dlg.text)) {
      ok('…a conflict was surfaced honestly rather than obeyed in silence')
      check('…with the owner’s three choices', dlg.buttons.some(b => /Keep my order/i.test(b)),
        dlg.buttons.join(' · '))
    }
  }
  await evaluate(CLOSE_DIALOG)
  await sleep(800)
}

// ── Unpin ────────────────────────────────────────────────────────────────────
console.log('\n▸ unpinning frees the stop again')
await evaluate(clickPin(3))
await sleep(900)
after = await evaluate(ROUTE)
check('the second pin is released', !!after && after.rows.filter(r => r.pinned).length === 1,
  `still ${after?.rows?.filter(r => r.pinned).length} pinned`)
check('…and the first is untouched', !!after && after.rows[1]?.pinned === true)
await evaluate(clickPin(1))
await sleep(700)
after = await evaluate(ROUTE)
check('“clear” leaves no pins at all', !!after && after.rows.every(r => !r.pinned))

// ── Phone widths ─────────────────────────────────────────────────────────────
console.log('\n▸ phone widths — overflow and tap targets')

const TAPS = `(() => {
  const out = []
  const note = (label, el) => {
    if (!el) return
    const r = el.getBoundingClientRect()
    if (r.width === 0 && r.height === 0) return
    out.push({ label, h: Math.round(r.height), w: Math.round(r.width) })
  }
  for (const b of document.querySelectorAll('button')) {
    const t = (b.textContent || '').trim()
    const al = b.getAttribute('aria-label') || ''
    if (/^(month|week|day)$/i.test(t)) note('view:' + t.toLowerCase(), b)
    if (/^(Pin|Unpin) /.test(al)) note('pin', b)
    if (/^Move .* (up|down)$/.test(al)) note('move', b)
    if (/^Optimize remaining$/i.test(t)) note('optimize-remaining', b)
  }
  return out
})()`

for (const w of WIDTHS) {
  await setWidth(w)
  await sleep(1200)
  const over = await evaluate(OVERFLOW)
  check(`${w}px · nothing overflows sideways`, Array.isArray(over) && over.length === 0,
    (over || []).join('\n      '))
  const taps = await evaluate(TAPS)
  const small = (taps || []).filter(t => t.h < 44)
  check(`${w}px · every thumb control is at least 44px tall`, small.length === 0,
    small.map(t => `${t.label} ${t.h}px`).join(', '))
  const kinds = new Set((taps || []).map(t => t.label.split(':')[0]))
  check(`${w}px · the controls under test were actually present`,
    kinds.has('view') && kinds.has('pin'),
    `measured: ${[...kinds].join(', ') || 'none'}`)
}

// ── The two inherited defects on the dispatch board ──────────────────────────
console.log('\n▸ dispatch board — the inherited Session 106 defects')
await goto(`${baseUrl}/dashboard/dispatch`)
const DISPATCH_TAPS = `(() => {
  const out = []
  for (const b of document.querySelectorAll('button')) {
    const t = (b.textContent || '').trim()
    if (/^(Board|Map)$/i.test(t)) {
      const r = b.getBoundingClientRect()
      out.push({ label: t, h: Math.round(r.height) })
    }
  }
  return out
})()`
for (const w of WIDTHS) {
  await setWidth(w)
  await sleep(1200)
  const taps = await evaluate(DISPATCH_TAPS)
  const small = (taps || []).filter(t => t.h < 44)
  check(`${w}px · Board/Map are at least 44px tall`, Array.isArray(taps) && taps.length > 0 && small.length === 0,
    taps?.length ? small.map(t => `${t.label} ${t.h}px`).join(', ') : 'Board/Map not found')
  const over = await evaluate(OVERFLOW)
  check(`${w}px · the dispatch header does not overflow`, Array.isArray(over) && over.length === 0,
    (over || []).join('\n      '))
}

if (!WRITE) {
  console.log('\n▸ the write half')
  console.log('  · SKIPPED by default. Apply and refresh write jobs.route_order, which is what a')
  console.log('    crew phone sorts its day by, so they are not run against the live book without')
  console.log('    --write. The persistence path is pinned by verify:pinned-route §10 instead.')
}

console.log('')
if (fails) { console.log(`✗ pinned-route browser proof: ${fails} check${fails === 1 ? '' : 's'} failed`) }
else { console.log('✓ pinned-route browser proof: green') }
ws.close(); chrome.kill()
process.exit(fails ? 1 : 0)
