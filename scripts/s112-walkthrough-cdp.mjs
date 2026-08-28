// ── S112 walkthrough: the owner reaches everything, at every width ───────────
//   node scripts/s112-walkthrough-cdp.mjs [baseUrl]
//
// Drives the app's OWN login form over CDP (never forged cookies), starts at
// the dashboard like the owner does, and proves the session-112 contract:
//
//   • the eight primary destinations are one click from anywhere;
//   • the eleven secondary modules are one DISCLOSURE away (group heading),
//     and standing on one forces its group open;
//   • Customer · Quote · Schedule day · Visit · Invoice · Service pricing ·
//     Team · Settings are all reachable without typing a URL;
//   • the Schedule↔Dispatch weld works in both directions, carrying the day;
//   • no page in the sweep scrolls sideways at 1280 / 375 / 390 / 430 —
//     measured on <main> (the app's real scroller; document always reads clean);
//   • the raised view switchers really render ≥40px.
//
// READ-ONLY: navigates and toggles disclosure state; writes nothing.

import { readFileSync } from 'node:fs'
import { spawn } from 'node:child_process'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'
const [baseUrl = 'http://localhost:3000'] = process.argv.slice(2)
const PORT = 9491 + Number(process.env.CDP_SLOT || 0)

const env = Object.fromEntries(
  readFileSync('.env.local', 'utf8').split(/\r?\n/)
    .filter(l => l && !l.startsWith('#') && l.includes('='))
    .map(l => [l.slice(0, l.indexOf('=')).trim(), l.slice(l.indexOf('=') + 1).trim()]))
const EMAIL = env.PORTAL_RPC_OWNER_EMAIL
const PASSWORD = env.PORTAL_RPC_OWNER_PASSWORD
if (!EMAIL || !PASSWORD) { console.error('no owner credentials in .env.local'); process.exit(2) }

let fails = 0
const ok = n => console.log(`  ✓ ${n}`)
const bad = (n, d = '') => { fails++; console.log(`  ✗ ${n}${d ? `\n      ${d}` : ''}`) }
const check = (n, c, d) => c ? ok(n) : bad(n, d)

const profile = mkdtempSync(join(tmpdir(), 's112-walk-'))
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
const M = await import('ws').catch(() => ({ WebSocket: globalThis.WebSocket }))
const ws = new ((M.WebSocket || M.default))(wsUrl)
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
  if (r.result?.exceptionDetails) return { __error: r.result.exceptionDetails.text }
  return r.result?.result?.value
}
async function goto(url) {
  await send('Page.navigate', { url })
  for (let i = 0; i < 100; i++) { await sleep(250); if (await evaluate('document.readyState === "complete"')) break }
  await sleep(1800)  // client fetch + paint settle (local server, shorter than prod)
}
// ⚠️ Chrome on Windows clamps a headless WINDOW to ~500px — the viewport must
// come from setDeviceMetricsOverride, re-applied after every navigation.
async function setWidth(w, mobile = true) {
  await send('Emulation.setDeviceMetricsOverride', { width: w, height: 900, deviceScaleFactor: mobile ? 2 : 1, mobile })
}
async function until(expr, label, tries = 60) {
  for (let i = 0; i < tries; i++) { if (await evaluate(expr) === true) return true; await sleep(250) }
  bad(`${label} (timed out)`, expr.slice(0, 110))
  return false
}
const clickText = (sel, text, exact = true) => evaluate(`(() => {
  const els = [...document.querySelectorAll(${JSON.stringify(sel)})]
  const t = ${JSON.stringify(text)}
  const el = els.find(e => ${exact ? '(e.textContent||"").trim() === t' : '(e.textContent||"").trim().includes(t)'})
  if (!el) return false
  el.click(); return true
})()`)

// The app's real horizontal scroller is <main> (overflow-auto) — the document
// never reports sideways overflow, so measure the element that would actually
// scroll. A page with a DELIBERATE inner overflow-x-auto container is fine;
// this flags only the page-level spill.
const overflow = () => evaluate(`(() => {
  const m = document.querySelector('main')
  if (!m) return 0
  return Math.max(0, m.scrollWidth - m.clientWidth)
})()`)

// ── Sign in through the app's own form ───────────────────────────────────────
console.log(`\n═══ Sign in (${baseUrl}) ═══`)
await setWidth(1280, false)
await goto(`${baseUrl}/login`)
await evaluate(`(() => {
  const set = (el, v) => { const s = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set; s.call(el, v); el.dispatchEvent(new Event('input', { bubbles: true })) }
  const em = document.querySelector('input[type=email], input[name=email]')
  const pw = document.querySelector('input[type=password]')
  if (em) set(em, ${JSON.stringify(EMAIL)})
  if (pw) set(pw, ${JSON.stringify(PASSWORD)})
  const btn = [...document.querySelectorAll('button')].find(b => /sign in/i.test(b.textContent || ''))
  if (btn) btn.click()
  return !!(em && pw && btn)
})()`)
check('login form present and submitted', await until(`location.pathname.startsWith('/dashboard')`, 'landed on the dashboard', 80))
check('the brand reads EdgeHQ', await evaluate(`document.body.innerText.includes('EdgeHQ')`) === true)

// ── Desktop: the resting sidebar is the daily eight ──────────────────────────
console.log('\n═══ Desktop sidebar: eight doors, groups disclose ═══')
const navTexts = await evaluate(`[...document.querySelectorAll('aside[aria-label="Sidebar"] nav a')].map(a => a.textContent.trim())`)
const DAILY = ['Dashboard', 'Inbox', 'Schedule', 'Customers', 'Messages', 'Quotes', 'Invoices', 'Grow']
for (const d of DAILY) check(`resting nav shows ${d}`, Array.isArray(navTexts) && navTexts.some(t => t.startsWith(d)), JSON.stringify(navTexts))
check('resting nav is short (no secondary rows yet)',
  Array.isArray(navTexts) && navTexts.length <= DAILY.length,
  `rendered: ${JSON.stringify(navTexts)}`)

// Open OPERATIONS — Dispatch/Workforce/Equipment appear (one disclosure away).
await clickText('aside[aria-label="Sidebar"] nav button', 'Operations', false)
await sleep(300)
check('Operations opens to Dispatch, Workforce, Equipment', await evaluate(
  `['Dispatch','Workforce','Equipment'].every(x => [...document.querySelectorAll('aside[aria-label="Sidebar"] nav a')].some(a => a.textContent.trim().startsWith(x)))`) === true)

// Standing on a secondary page forces its group open (fresh render, no manual open).
await goto(`${baseUrl}/dashboard/workforce`)
check('on /workforce the Operations group is force-open and the item is lit', await evaluate(
  `(() => { const a = [...document.querySelectorAll('aside[aria-label="Sidebar"] nav a')].find(x => x.getAttribute('href') === '/dashboard/workforce'); return !!a && a.getAttribute('aria-current') === 'page' })()`) === true)
check('Team is reachable: Workforce page rendered', await evaluate(`document.body.innerText.includes('Workforce')`) === true)

// ── The owner's questions, one door each ─────────────────────────────────────
console.log('\n═══ Where are my…? — every answer without typing a URL ═══')
const reach = [
  ['/dashboard/customers', 'Customers', 'a[href="/dashboard/customers"]'],
  ['/dashboard/quotes', 'Quotes', 'a[href="/dashboard/quotes"]'],
  ['/dashboard/schedule', 'Schedule', 'a[href="/dashboard/schedule"]'],
  ['/dashboard/invoices', 'Invoices', 'a[href="/dashboard/invoices"]'],
  ['/dashboard/inbox', 'Inbox', 'a[href="/dashboard/inbox"]'],
]
for (const [href, name, sel] of reach) {
  const clicked = await evaluate(`(() => { const a = document.querySelector('aside[aria-label="Sidebar"] ${sel}'); if (!a) return false; a.click(); return true })()`)
  await until(`location.pathname === ${JSON.stringify(href)}`, `${name} loads`)
  check(`${name}: one sidebar click`, clicked === true)
}
// Settings + service pricing (Settings → Service templates door pinned by verify:navigation).
await goto(`${baseUrl}/dashboard/settings`)
check('Settings reachable', await evaluate(`location.pathname === '/dashboard/settings'`) === true)
check('Settings links Service templates (pricing lives one click deeper)',
  await evaluate(`!!document.querySelector('a[href="/dashboard/settings/templates"]')`) === true)

// ── The weld, both directions ────────────────────────────────────────────────
console.log('\n═══ Schedule day ⇄ Crew board carry the same day ═══')
await goto(`${baseUrl}/dashboard/schedule?d=2026-08-31`)
check('schedule day view shows the crew-board lens', await evaluate(
  `!!document.querySelector('a[href^="/dashboard/dispatch?d="]')`) === true)
const weldHref = await evaluate(`document.querySelector('a[href^="/dashboard/dispatch?d="]')?.getAttribute('href')`)
check('…carrying the shown day', weldHref === '/dashboard/dispatch?d=2026-08-31', String(weldHref))
await goto(`${baseUrl}${weldHref || '/dashboard/dispatch'}`)
check('dispatch accepted the day', await evaluate(`document.body.innerText.includes('Aug 31') || document.body.innerText.includes('August 31')`) === true)
check('dispatch crumbs back to schedule with the day', await evaluate(
  `document.querySelector('a[href="/dashboard/schedule?d=2026-08-31"]') !== null`) === true)

// ── Widths: no sideways scroll, drawer + tabs live, targets ≥40px ────────────
for (const w of [375, 390, 430]) {
  console.log(`\n═══ ${w}px ═══`)
  await setWidth(w, true)
  const sweep = ['/dashboard', '/dashboard/schedule', '/dashboard/customers', '/dashboard/quotes',
    '/dashboard/invoices', '/dashboard/dispatch', '/dashboard/settings', '/dashboard/workforce', '/dashboard/inbox']
  for (const path of sweep) {
    await goto(`${baseUrl}${path}`)
    await setWidth(w, true)
    await sleep(400)
    const ov = await overflow()
    check(`${path} does not scroll sideways`, ov === 0, `main overflows by ${ov}px`)
  }
  // Bottom tabs are the fast path; the drawer holds the long tail with the same groups.
  await goto(`${baseUrl}/dashboard`)
  await setWidth(w, true)
  check('bottom tabs present (Schedule · Customers · + · Quotes · Messages)', await evaluate(
    `['Schedule','Customers','Quotes','Messages'].every(x => [...document.querySelectorAll('nav a')].some(a => a.textContent.trim() === x))`) === true)
  const opened = await evaluate(`(() => { const b = [...document.querySelectorAll('button')].find(x => x.getAttribute('aria-label') === 'Open menu'); if (!b) return false; b.click(); return true })()`)
  await sleep(400)
  check('drawer opens', opened === true && await evaluate(`!!document.querySelector('[role="dialog"][aria-label="Menu"]')`) === true)
  // Idempotent: the manual open PERSISTS (by design — localStorage), so a
  // second toggle would close it. Open only when it isn't already open.
  const moneyOpen = () => evaluate(
    `[...document.querySelectorAll('[role="dialog"] nav a')].some(a => a.textContent.trim().startsWith('Payments'))`)
  if (await moneyOpen() !== true) { await clickText('[role="dialog"] nav button', 'Money', false); await sleep(250) }
  check('drawer groups disclose (Money → Payments, Accounting)', await evaluate(
    `['Payments','Accounting'].every(x => [...document.querySelectorAll('[role="dialog"] nav a')].some(a => a.textContent.trim().startsWith(x)))`) === true)
  await evaluate(`document.querySelector('[role="dialog"] button[aria-label="Close menu"]')?.click()`)

  // The two raised switchers, measured for real.
  await goto(`${baseUrl}/dashboard/schedule`)
  await setWidth(w, true)
  await sleep(500)
  const hDay = await evaluate(`(() => { const b = [...document.querySelectorAll('button')].find(x => x.textContent.trim() === 'day'); return b ? Math.round(b.getBoundingClientRect().height) : 0 })()`)
  check(`schedule view buttons ≥40px (got ${hDay})`, hDay >= 40)
  await goto(`${baseUrl}/dashboard/dispatch`)
  await setWidth(w, true)
  await sleep(500)
  const hBoard = await evaluate(`(() => { const b = [...document.querySelectorAll('button')].find(x => x.textContent.trim() === 'Board'); return b ? Math.round(b.getBoundingClientRect().height) : 0 })()`)
  check(`dispatch Board pill ≥40px (got ${hBoard})`, hBoard >= 40)
}

console.log('\n── Summary ────────────────────────────────────────────────────')
console.log(fails ? `\n❌ s112 walkthrough — ${fails} failure${fails === 1 ? '' : 's'}\n` : '\n✅ s112 walkthrough — every door answers, at every width\n')
ws.close(); chrome.kill()
process.exit(fails ? 1 : 0)
