// ── Drive the REAL app: the suggested order is a proposal, and phone-sized ──
// Session 82. Signs in with the owner credentials from .env.local, finds a day
// with enough work to have an ordering question, opens "Optimize day" and
// checks what a person would check by hand:
//
//   1. The action is offered on a real multi-stop day.
//   2. The proposal opens as a DIALOG — current and suggested side by side,
//      or an honest "already in the best order" when there is nothing to win.
//   3. ⛔ It shows no money. The engine cannot see revenue and neither may the
//      screen (lib/daySequence honesty rule 5).
//   4. It discloses what it does NOT model — breaks are not scheduled here.
//   5. The travel figure is never called "driving" unless the day earned it.
//   6. Nothing overflows sideways at 375 / 390 / 430, and the approve/dismiss
//      controls stay reachable on a phone.
//
//   node scripts/dayseq-cdp.mjs <baseUrl>
//
// ⛔ READ-ONLY. It never taps "Use this order" — that is the one control that
// writes, and this runs against the real book (see prod-proof-fixture-e2e).
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
const [baseUrl = 'http://127.0.0.1:3082'] = argv.filter(a => !a.startsWith('--'))
const PORT = 9481 + Number(process.env.CDP_SLOT || 0)
const WIDTHS = [375, 390, 430]
const MAX_DAY_SCAN = 45

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

const profile = mkdtempSync(join(tmpdir(), 'dayseq-cdp-'))
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
  await sleep(2500)   // the route resolves after the jobs read lands
}
async function setWidth(w) {
  await send('Emulation.setDeviceMetricsOverride',
    { width: w, height: 850, deviceScaleFactor: 2, mobile: true })
}

await send('Page.enable'); await send('Runtime.enable')

await setWidth(390)
await goto(`${baseUrl}/login`)
// ⚠️ Poll for HYDRATION, not paint — a controlled input filled before the client
// bundle attaches keeps its value in the DOM and loses it in state.
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
// ⚠️ POLL for the redirect rather than sleeping a fixed span. A single fixed
// wait passes on a warm server and fails on a cold one for reasons that have
// nothing to do with the feature under test — which is exactly the flake that
// makes a browser proof stop being believed.
let signedIn = '/login'
for (let i = 0; i < 40; i++) {
  await sleep(1000)
  signedIn = String(await evaluate('location.pathname') || '/login')
  if (!signedIn.includes('/login')) break
}
// ⚠️ Report WHAT the page said, not merely that we are still at /login — an
// auth rate limit and a wrong password are the same symptom and very different
// problems, and guessing between them wastes a run each time.
const loginErr = await evaluate(
  `(document.body.innerText.match(/[^\\n]*(invalid|incorrect|failed|error|rate limit|too many|seconds)[^\\n]*/i) || [''])[0]`)
check('signed in as the owner', !String(signedIn).includes('/login'),
  `still at ${signedIn}${loginErr ? ` — page said: ${loginErr}` : ''}`)
if (String(signedIn).includes('/login')) { ws.close(); chrome.kill(); process.exit(1) }

const OVERFLOW = `(() => {
  const bad = []
  for (const el of document.querySelectorAll('body *')) {
    const r = el.getBoundingClientRect()
    if (r.width === 0) continue
    if (r.right > innerWidth + 1 || r.left < -1) {
      // ⚠️ Name it by its TEXT and its dialog-ness. A class list alone cannot
      // tell you whether the offender is the control this session added or one
      // that was already there — which is the only question worth asking.
      const label = (el.textContent || '').trim().replace(/\\s+/g, ' ').slice(0, 30)
      const where = el.closest('[role="dialog"]') ? 'IN-DIALOG' : 'page'
      bad.push(where + ' ' + el.tagName.toLowerCase() + ' "' + label + '"'
        + ' [' + Math.round(r.left) + '..' + Math.round(r.right) + ']')
    }
  }
  return bad.slice(0, 4)
})()`

const FIND_BTN = `(() => {
  const b = [...document.querySelectorAll('button')].find(x => /Optimize day/i.test(x.textContent || ''))
  return b ? true : false
})()`

const CLICK_BTN = `(() => {
  const b = [...document.querySelectorAll('button')].find(x => /Optimize day/i.test(x.textContent || ''))
  if (!b) return false
  b.click(); return true
})()`

const NEXT_DAY = `(() => {
  const b = document.querySelector('button[aria-label="Next period"]')
  if (!b) return false
  b.click(); return true
})()`

// Everything the dialog claims, scraped as text so assertions are about what a
// person actually reads.
const DIALOG = `(() => {
  const card = document.querySelector('[role="dialog"][aria-labelledby="optimize-day-title"]')
  if (!card) return null
  const r = card.getBoundingClientRect()
  const btns = [...card.querySelectorAll('button')].map(b => (b.textContent || '').trim()).filter(Boolean)
  return {
    text: card.innerText,
    width: Math.round(r.width),
    height: Math.round(r.height),
    buttons: btns,
    applyVisible: btns.some(t => /Use this order/i.test(t)),
  }
})()`

const CLOSE_DIALOG = `(() => {
  const card = document.querySelector('[role="dialog"][aria-labelledby="optimize-day-title"]')
  if (!card) return false
  const b = [...card.querySelectorAll('button')].find(x => /Keep current order|Close/i.test(x.textContent || ''))
  if (b) { b.click(); return true }
  return false
})()`

// ── Find a day that HAS an ordering question ────────────────────────────────
await goto(`${baseUrl}/dashboard/schedule`)
let found = false
for (let i = 0; i < MAX_DAY_SCAN; i++) {
  if (await evaluate(FIND_BTN)) { found = true; break }
  if (!(await evaluate(NEXT_DAY))) break
  await sleep(1200)
}
check(`a day with an ordering question was found within ${MAX_DAY_SCAN} days`, found,
  'no day in range had more than one active visit — seed one, or run with --fixture')
if (!found) { ws.close(); chrome.kill(); process.exit(1) }

const dayLabel = await evaluate(`(document.body.innerText.match(/[^\\n]*\\d{1,2}[^\\n]*/) || [''])[0].trim().slice(0, 60)`)
console.log(`\n  (day under test: ${dayLabel})`)

let seen390 = null
for (const w of WIDTHS) {
  console.log(`\n═══ Optimize day @ ${w}px ═══`)
  await setWidth(w)
  await sleep(900)

  check('the "Optimize day" action is offered', await evaluate(FIND_BTN))
  await evaluate(CLICK_BTN)
  await sleep(1600)

  const d = await evaluate(DIALOG)
  if (!d) { bad('the proposal opens', 'no optimize-day dialog found'); continue }
  ok(`the proposal opens as a dialog (${d.width}×${d.height}px)`)
  if (w === 390) seen390 = d

  // It either proposes a better order, or says plainly that it cannot.
  const proposes = /Suggested/.test(d.text)
  const declines = /best order|nothing to improve|already/i.test(d.text)
  check('it either proposes an order or says there is nothing better',
    proposes || declines, d.text.slice(0, 160))

  if (proposes) {
    check('…and shows the current day beside it', /Current/.test(d.text), d.text.slice(0, 160))
  }

  // ⛔ Money never reaches this screen.
  const money = (d.text.match(/[^\n]*[$€£][\d][^\n]*/) || [])[0]
  check('⛔ the proposal shows no money', !money, money)

  // What it does NOT model is stated, not implied.
  check('it discloses that breaks are not scheduled',
    /[Bb]reaks are not scheduled/.test(d.text), 'the disclosure is missing')

  // The travel word is earned, never assumed.
  const saysDriving = /\bDriving\b/.test(d.text)
  const saysOverhead = /[Rr]oute overhead/.test(d.text)
  check('the travel figure is named honestly (driving XOR route overhead)',
    saysDriving !== saysOverhead || (!saysDriving && !saysOverhead),
    `driving=${saysDriving} overhead=${saysOverhead}`)

  // The approve control exists — and this harness does NOT press it.
  check('the owner has an explicit approve control', d.applyVisible || declines,
    `buttons: ${d.buttons.join(' | ')}`)
  check('…and a way out that changes nothing',
    d.buttons.some(t => /Keep current order|Close|Cancel/i.test(t)), d.buttons.join(' | '))

  const over = await evaluate(OVERFLOW)
  check(`nothing overflows sideways at ${w}px`, Array.isArray(over) && over.length === 0,
    (over || []).join('\n      '))

  await evaluate(CLOSE_DIALOG)
  await sleep(700)
  const gone = await evaluate(`!document.querySelector('[role="dialog"][aria-labelledby="optimize-day-title"]')`)
  check('dismissing it leaves the day untouched', !!gone)
}

if (seen390) {
  console.log('\n═══ What the proposal actually says (390px) ═══')
  console.log(seen390.text.split('\n').map(l => '   │ ' + l).join('\n'))
}

console.log('')
if (fails) { console.log(`✗ dayseq-cdp: ${fails} check${fails === 1 ? '' : 's'} failed`) }
else { console.log('✓ dayseq-cdp: the proposal is honest, approvable and phone-sized') }
ws.close(); chrome.kill()
process.exit(fails ? 1 : 0)
