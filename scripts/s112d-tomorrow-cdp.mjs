// ── Session 112: the day header without its Tomorrow button, in real Chrome ──
//   npx next start -p 3117 &  →  node scripts/s112d-tomorrow-cdp.mjs http://localhost:3117
//
// Signs in through the real form (read-only), opens the Schedule DAY view and
// proves at desktop / 430 / 390 / 375:
//   · no button labelled "Tomorrow" renders anywhere on the page;
//   · Today and BOTH period chevrons render, and next-period actually MOVES the
//     day (heading changes) — capability, not just presence;
//   · a ?d= deep link still lands on its date;
//   · the toolbar does not overflow <main> sideways.

import { readFileSync, mkdtempSync } from 'node:fs'
import { spawn } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'
const [baseUrl = 'http://localhost:3117'] = process.argv.slice(2)
const PORT = 9499

const env = Object.fromEntries(readFileSync('.env.local', 'utf8').split(/\r?\n/)
  .filter(l => l && !l.startsWith('#') && l.includes('='))
  .map(l => [l.slice(0, l.indexOf('=')).trim(), l.slice(l.indexOf('=') + 1).trim()]))
const EMAIL = env.PORTAL_RPC_OWNER_EMAIL
const PASSWORD = env.PORTAL_RPC_OWNER_PASSWORD
if (!EMAIL || !PASSWORD) { console.error('no owner credentials in .env.local'); process.exit(2) }

let fails = 0
const ok = n => console.log(`  ✓ ${n}`)
const bad = (n, d = '') => { fails++; console.log(`  ✗ ${n}${d ? `\n      ${d}` : ''}`) }
const check = (n, c, d) => c ? ok(n) : bad(n, d)

const profile = mkdtempSync(join(tmpdir(), 's112d-'))
const chrome = spawn(CHROME, ['--headless=new', '--disable-gpu', '--no-sandbox', '--hide-scrollbars',
  `--remote-debugging-port=${PORT}`, '--user-data-dir=' + profile, 'about:blank'], { stdio: 'ignore' })
const sleep = ms => new Promise(r => setTimeout(r, ms))
async function target() {
  for (let i = 0; i < 60; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${PORT}/json/list`)
      const t = (await r.json()).find(x => x.type === 'page')
      if (t) return t.webSocketDebuggerUrl
    } catch { /* boot */ }
    await sleep(500)
  }
  throw new Error('no CDP target')
}
const M = await import('ws').catch(() => ({ WebSocket: globalThis.WebSocket }))
const ws = new ((M.WebSocket || M.default))(await target())
await new Promise(r => ws.addEventListener('open', r))
let msgId = 0
const pending = new Map()
ws.addEventListener('message', e => {
  const m = JSON.parse(e.data)
  if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id) }
})
const send = (method, params = {}) => new Promise(res => { pending.set(++msgId, res); ws.send(JSON.stringify({ id: msgId, method, params })) })
async function evaluate(expression) {
  const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })
  if (r.result?.exceptionDetails) return { __error: r.result.exceptionDetails.text }
  return r.result?.result?.value
}
async function goto(url) {
  await send('Page.navigate', { url })
  for (let i = 0; i < 100; i++) { await sleep(250); if (await evaluate('document.readyState === "complete"')) break }
  await sleep(1800)
}
const setWidth = (w, mobile = true) => send('Emulation.setDeviceMetricsOverride', { width: w, height: 900, deviceScaleFactor: mobile ? 2 : 1, mobile })
async function until(expr, label, tries = 80) {
  for (let i = 0; i < tries; i++) { if (await evaluate(expr) === true) return true; await sleep(250) }
  bad(`${label} (timed out)`, expr.slice(0, 110))
  return false
}

console.log(`\n═══ Sign in (${baseUrl}) ═══`)
await setWidth(1280, false)
await goto(`${baseUrl}/login`)
await evaluate(`(() => {
  const set = (el, v) => { const s = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set; s.call(el, v); el.dispatchEvent(new Event('input', { bubbles: true })) }
  set(document.querySelector('input[type=email]'), ${JSON.stringify(EMAIL)})
  set(document.querySelector('input[type=password]'), ${JSON.stringify(PASSWORD)})
  ;[...document.querySelectorAll('button')].find(b => /sign in/i.test(b.textContent || ''))?.click()
})()`)
check('signed in', await until(`location.pathname.startsWith('/dashboard')`, 'dashboard'))

const probe = () => evaluate(`(() => {
  const btns = [...document.querySelectorAll('button')]
  const heading = [...document.querySelectorAll('span')].find(s => /^\\w+, \\w+ \\d/.test((s.textContent || '').trim()))
  const m = document.querySelector('main')
  return {
    tomorrow: btns.some(b => (b.textContent || '').trim() === 'Tomorrow'),
    today: btns.some(b => (b.textContent || '').trim() === 'Today'),
    prev: !!btns.find(b => b.getAttribute('aria-label') === 'Previous period'),
    next: !!btns.find(b => b.getAttribute('aria-label') === 'Next period'),
    heading: (heading?.textContent || '').trim(),
    overflow: m ? Math.max(0, m.scrollWidth - m.clientWidth) : 0,
  }
})()`)

const DEEP = '2026-09-15'
for (const [w, mobile] of [[1280, false], [430, true], [390, true], [375, true]]) {
  console.log(`\n═══ ${w}px ═══`)
  await setWidth(w, mobile)
  await goto(`${baseUrl}/dashboard/schedule?d=${DEEP}`)
  await setWidth(w, mobile)
  await sleep(800)
  const p = await probe()
  check(`${w}: no button labelled Tomorrow`, p.tomorrow === false)
  check(`${w}: Today + both period chevrons render`, p.today && p.prev && p.next, JSON.stringify(p))
  check(`${w}: ?d=${DEEP} landed on its day`, /Sep(tember)? 15, 2026/.test(p.heading), p.heading)
  check(`${w}: the page does not scroll sideways`, p.overflow === 0, `main overflows by ${p.overflow}px`)
  // Capability, not presence: next-period MOVES the day.
  await evaluate(`[...document.querySelectorAll('button')].find(b => b.getAttribute('aria-label') === 'Next period')?.click()`)
  await sleep(600)
  const after = await probe()
  check(`${w}: next-period advanced the day`, /Sep(tember)? 16, 2026/.test(after.heading), after.heading)
}

console.log('\n── Summary ────────────────────────────────────────────────────')
console.log(fails ? `\n❌ day-view proof — ${fails} failure(s)\n` : '\n✅ day-view proof — simpler header, every road to tomorrow intact\n')
ws.close(); chrome.kill()
process.exit(fails ? 1 : 0)
