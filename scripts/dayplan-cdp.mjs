// ── Drive the REAL app: the day plan is honest and phone-sized ──────────────
// Signs in with the owner credentials from .env.local, opens the day board on a
// real multi-stop day, and checks what a person would check by hand:
//
//   1. The day plan renders — ordered stops, what the day takes, what is left
//      of it, and the travel claim NAMED (measured / road / straight-line).
//   2. It never states a drive time it cannot back: no "Measured drive time"
//      unless every leg was measured.
//   3. A day that cannot be staffed says so, and the header pill stops
//      offering spare hours it cannot honour.
//   4. The crew row states whether the field has this order.
//   5. Nothing overflows sideways at 375 / 390 / 430, and the stop reorder
//      controls stay reachable on a phone.
//
//   node scripts/dayplan-cdp.mjs <baseUrl> [jobId]
//
// ⛔ READ-ONLY. It never taps "Send this order", Start, Complete or any other
// write — this runs against the real book (see prod-proof-fixture-e2e).
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
const FIXTURE = argv.includes('--fixture')
const [baseUrl = 'http://127.0.0.1:3117', jobId = ''] = argv.filter(a => !a.startsWith('--'))
const PORT = 9471 + Number(process.env.CDP_SLOT || 0)
const WIDTHS = [375, 390, 430]

const env = Object.fromEntries(
  readFileSync('.env.local', 'utf8').split(/\r?\n/)
    .filter(l => l && !l.startsWith('#') && l.includes('='))
    .map(l => [l.slice(0, l.indexOf('=')).trim(), l.slice(l.indexOf('=') + 1).trim()]))
// --fixture drives the verification tenant (scripts/dayplan-e2e.ts seeds it).
// Without it, the owner's own book — read-only either way.
const EMAIL = FIXTURE ? env.VERIFY_FIXTURE_EMAIL : (env.PORTAL_RPC_OWNER_EMAIL || env.BACKFILL_OWNER_EMAIL)
const PASSWORD = FIXTURE ? env.VERIFY_FIXTURE_PASSWORD : (env.PORTAL_RPC_OWNER_PASSWORD || env.BACKFILL_OWNER_PASSWORD)
if (!EMAIL || !PASSWORD) { console.error('no credentials in .env.local'); process.exit(2) }

let fails = 0
const ok = n => console.log(`  ✓ ${n}`)
const bad = (n, d = '') => { fails++; console.log(`  ✗ ${n}${d ? `\n      ${d}` : ''}`) }
const check = (n, c, d) => c ? ok(n) : bad(n, d)

const profile = mkdtempSync(join(tmpdir(), 'dayplan-cdp-'))
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
// ⚠️ Poll for HYDRATION, not paint. A controlled React input filled before the
// client bundle attaches keeps its value in the DOM and loses it in state, so
// the form submits empty and the run reports "still at /login" — a broken
// harness that reads exactly like a broken feature.
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
await sleep(9000)
const signedIn = await evaluate('location.pathname')
const loginErr = await evaluate(`(document.body.innerText.match(/[^\\n]*(invalid|incorrect|failed|error)[^\\n]*/i) || [''])[0]`)
check('signed in as the owner', !String(signedIn).includes('/login'),
  `still at ${signedIn}${loginErr ? ` — page said: ${loginErr}` : ''}`)
if (String(signedIn).includes('/login')) { console.log('\n  (cannot continue without a session)'); ws.close(); chrome.kill(); process.exit(1) }

const OVERFLOW = `(() => {
  const bad = []
  for (const el of document.querySelectorAll('body *')) {
    const r = el.getBoundingClientRect()
    if (r.width === 0) continue
    if (r.right > innerWidth + 1 || r.left < -1) {
      bad.push((el.tagName.toLowerCase()) + '.' + String(el.className || '').slice(0, 40)
        + ' [' + Math.round(r.left) + '..' + Math.round(r.right) + ']')
    }
  }
  return bad.slice(0, 4)
})()`

// Everything the panel claims, scraped as text so the assertions are about what
// a person actually reads.
const PANEL = `(() => {
  const heads = [...document.querySelectorAll('span')]
    .filter(s => s.textContent.trim() === 'Day plan')
  const card = heads[0]?.closest('div.rounded-xl')
  if (!card) return null
  const text = card.innerText
  const pill = [...document.querySelectorAll('span')]
    .map(s => s.textContent.trim())
    .find(t => /^(Won’t fit|Over by|Room for|Full day)/.test(t)) || null
  return {
    text,
    pill,
    height: Math.round(card.getBoundingClientRect().height),
    width: Math.round(card.getBoundingClientRect().width),
  }
})()`

const url = `${baseUrl}/dashboard/schedule${jobId ? `?job=${jobId}` : ''}`
let panel390 = null

for (const w of WIDTHS) {
  console.log(`\n═══ Day board @ ${w}px ═══`)
  await setWidth(w)
  await goto(url)
  const p = await evaluate(PANEL)
  if (!p) { bad('the day plan renders', 'no "Day plan" card found'); continue }
  if (w === 390) panel390 = p
  ok(`the day plan renders (${p.width}×${p.height}px)`)

  // The travel claim is NAMED, and it is one of the four honest ones.
  const claims = ['Measured drive time', 'Real road distances, estimated minutes',
    'Straight-line grouping, estimated minutes', 'Some stops could not be placed', 'No route']
  const claim = claims.find(c => p.text.includes(c))
  check('the travel claim is named', !!claim, p.text.slice(0, 200))
  if (claim) console.log(`      → “${claim}”`)

  // A straight-line day must never also assert a measured drive.
  check('it does not claim both measured and straight-line',
    !(p.text.includes('Measured drive time') && p.text.includes('Straight-line')))

  // The day states its shape and what is left of it.
  check('it says how many stops', /\d+ stops?/.test(p.text), p.text.slice(0, 120))
  check('it says how much work', /\d+h( \d+m)? work|\d+m work/.test(p.text))
  check('it says when the day ends', /ends ~/.test(p.text))
  check('it says what is left of the day', /(left|over)\b/.test(p.text))
  check('it says who is available', /(people available|person available|People available: not known)/.test(p.text))
  check('it says whether the crew has this order',
    /(crew sees this order|crew’s screen|assigned to a crew)/i.test(p.text), p.text.slice(-220))

  const over = await evaluate(OVERFLOW)
  check(`nothing overflows sideways at ${w}px`, Array.isArray(over) && over.length === 0,
    (over || []).join('\n      '))

  // Reorder must stay reachable on a phone (Session 46/54: chevrons, not drag).
  const reorder = await evaluate(`document.querySelectorAll('[aria-label="Move up"], [aria-label="Move down"]').length`)
  check('stops can still be reordered by thumb', Number(reorder) > 0, `${reorder} controls`)
  const tiny = await evaluate(`(() => {
    const els = [...document.querySelectorAll('[aria-label="Move up"], [aria-label="Move down"]')]
    return els.filter(e => { const r = e.getBoundingClientRect(); return r.height < 28 || r.width < 24 })
      .map(e => e.getAttribute('aria-label') + ' ' + Math.round(e.getBoundingClientRect().height) + 'px').slice(0, 3)
  })()`)
  check('…with hit areas a thumb can land on', Array.isArray(tiny) && tiny.length === 0, (tiny || []).join(', '))
}

if (panel390) {
  console.log('\n═══ What the day actually says (390px) ═══')
  console.log(panel390.text.split('\n').map(l => '   │ ' + l).join('\n'))
  console.log(`   │ header pill: ${panel390.pill}`)
  // The session's headline rule: a day that cannot be staffed must not be
  // offering spare hours in the same breath.
  const blocked = /asks for \d+ people|Nobody is available|no working hours|needs .* of people/.test(panel390.text)
  if (blocked) {
    check('a day that cannot be staffed does NOT advertise spare hours',
      panel390.pill === 'Won’t fit' || /Over by/.test(panel390.pill || ''),
      `pill said “${panel390.pill}”`)
  } else {
    console.log('   (no blocking condition on this day — staffing pill rule not exercised)')
  }
}

console.log('')
console.log(fails ? `✗ day-plan browser: ${fails} check${fails === 1 ? '' : 's'} failed`
  : '✓ day-plan browser: every check passed')
ws.close(); chrome.kill()
process.exit(fails ? 1 : 0)
