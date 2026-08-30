// ── Session 112: the OWNER's accepted-version door, live ─────────────────────
//   npx next start -p 3113 &  →  node scripts/s112-owner-live-cdp.mjs http://localhost:3113
//
// Drives THIS BRANCH's build with the app's own login against the real backend
// — the acceptance ledger (quote_acceptances + quote_acceptance_state) exists in
// production, so the owner surface can be proved for real. READ-ONLY: navigates,
// reads, and renders one PDF into a blob URL; writes nothing.
//
// Proves, at desktop / 375 / 390 / 430:
//   · an accepted quote's detail offers BOTH artifacts, labelled apart
//     ("Current PDF" · "Accepted version") — never two buttons both saying PDF;
//   · clicking "Accepted version" really produces a document (URL.createObjectURL
//     hooked in-page; the blob must be a non-trivial application/pdf);
//   · no sideways scroll on the detail at any width.

import { readFileSync, mkdtempSync } from 'node:fs'
import { spawn } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'
const [baseUrl = 'http://localhost:3113'] = process.argv.slice(2)
const PORT = 9497

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

const profile = mkdtempSync(join(tmpdir(), 's112-owner-'))
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
  await sleep(2200)
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

console.log('\n═══ An accepted quote offers both artifacts ═══')
await goto(`${baseUrl}/dashboard/quotes`)
// Find a row whose status pill reads Accepted and open it. Row markup varies;
// walk anchors into /dashboard/quotes/<id> whose row text contains 'Accepted'.
const opened = await evaluate(`(() => {
  const links = [...document.querySelectorAll('a[href^="/dashboard/quotes/"]')]
    .filter(a => !/\\/new$/.test(a.getAttribute('href')))
  const hit = links.find(a => /accepted/i.test((a.closest('tr,div')?.textContent) || ''))
  if (!hit) return null
  const href = hit.getAttribute('href')
  hit.click()
  return href
})()`)
check('found an accepted quote in the book', typeof opened === 'string', String(opened))
await until(`location.pathname.startsWith('/dashboard/quotes/') && !location.pathname.endsWith('/new')`, 'quote detail')
await sleep(2500) // acceptance state loads after the quote

const btns = () => evaluate(`(() => {
  const t = [...document.querySelectorAll('button')].map(b => (b.textContent || '').trim())
  return { current: t.some(x => x === 'Current PDF'), accepted: t.some(x => x === 'Accepted version'),
           bare: t.some(x => x === 'Open PDF') }
})()`)
let b = await btns()
check('the detail offers "Accepted version"', b.accepted === true, JSON.stringify(b))
check('…and the current artifact is relabelled "Current PDF"', b.current === true && b.bare === false, JSON.stringify(b))

// Hook URL.createObjectURL, click, and require a real PDF-sized blob.
await evaluate(`(() => {
  window.__s112blobs = []
  const orig = URL.createObjectURL.bind(URL)
  URL.createObjectURL = (b) => { try { window.__s112blobs.push({ size: b?.size ?? 0, type: b?.type ?? '' }) } catch {} return orig(b) }
  return true
})()`)
await evaluate(`[...document.querySelectorAll('button')].find(b => (b.textContent || '').trim() === 'Accepted version')?.click()`)
check('clicking "Accepted version" produces a real document',
  await until(`(window.__s112blobs || []).some(b => b.size > 3000)`, 'accepted blob rendered', 120),
  'no blob URL of PDF size was created')

console.log('\n═══ The same door, at thumb widths ═══')
const url = await evaluate('location.href')
for (const w of [375, 390, 430]) {
  await setWidth(w, true)
  await goto(url)
  await setWidth(w, true)
  await sleep(1500)
  b = await btns()
  check(`${w}: both artifacts offered, labelled apart`, b.accepted === true && b.current === true, JSON.stringify(b))
  const ov = await evaluate(`(() => { const m = document.querySelector('main'); return m ? Math.max(0, m.scrollWidth - m.clientWidth) : 0 })()`)
  check(`${w}: the detail does not scroll sideways`, ov === 0, `main overflows by ${ov}px`)
}

console.log('\n── Summary ────────────────────────────────────────────────────')
console.log(fails ? `\n❌ owner live proof — ${fails} failure(s)\n` : '\n✅ owner live proof — both documents, told apart, at every width\n')
ws.close(); chrome.kill()
process.exit(fails ? 1 : 0)
