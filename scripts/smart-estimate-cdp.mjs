// ── Drive the REAL app: the Smart Estimate card is honest and phone-sized ────
// Signs in with the owner credentials from .env.local, opens the real New Job
// form on the real book, and checks what a person would check by hand:
//
//   1. The card renders one of its HONEST states, names its confidence in
//      WORDS, and always states how many jobs are behind the claim.
//   2. It stays a card: compact enough to sit beside a field on a phone.
//   3. Applying is deliberate — the duration field is NOT auto-filled, the
//      button applies the learned value, and the card then says Applied.
//   4. A service with no history says so and offers nothing to apply.
//   5. Nothing overflows sideways at 375 / 390 / 430.
//
//   node scripts/smart-estimate-cdp.mjs <baseUrl>
//
// It is the counterpart to `npm run verify:smart-estimate`, not a duplicate:
// the guard pins the arithmetic and the contracts, this proves the wiring. The
// difference is not academic — the source guard was fully green while the card
// rendered NOTHING on every new job, because the history read was gated on
// `status === 'completed'`. Both halves were individually correct.
//
// ⚠️ A FRESH profile directory every run: a persistent Chrome profile serves a
// STALE client bundle and would test the previous build. Kill any old `next
// start` on the port too — an EADDRINUSE server keeps serving the old build and
// this harness will happily test it.
// ⚠️ `<main>` is overflow-auto, so document.scrollWidth NEVER reports sideways
// overflow on this app. Overflow is measured per ELEMENT against innerWidth.
// ⚠️ Regexes inside the browser-side template literals lose a backslash. Use
// substring tests there, and normalise text on the Node side.

import { spawn } from 'node:child_process'
import { readFileSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'
const [baseUrl = 'http://127.0.0.1:3111'] = process.argv.slice(2)
const PORT = 9451 + Number(process.env.CDP_SLOT || 0)
const WIDTHS = [375, 390, 430]

const env = Object.fromEntries(
  readFileSync('.env.local', 'utf8').split(/\r?\n/)
    .filter(l => l && !l.startsWith('#') && l.includes('='))
    .map(l => [l.slice(0, l.indexOf('=')).trim(), l.slice(l.indexOf('=') + 1).trim()]))
const EMAIL = env.PORTAL_RPC_OWNER_EMAIL || env.BACKFILL_OWNER_EMAIL
const PASSWORD = env.PORTAL_RPC_OWNER_PASSWORD || env.BACKFILL_OWNER_PASSWORD
if (!EMAIL || !PASSWORD) { console.error('no owner credentials in .env.local'); process.exit(2) }

let fails = 0
const ok = n => console.log(`  ✓ ${n}`)
const bad = (n, d = '') => { fails++; console.log(`  ✗ ${n}${d ? `\n      ${d}` : ''}`) }
const check = (n, c, d) => c ? ok(n) : bad(n, d)

const profile = mkdtempSync(join(tmpdir(), 'dayfit-cdp-'))
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
  await sleep(1200)
}
async function setWidth(w) {
  await send('Emulation.setDeviceMetricsOverride',
    { width: w, height: 850, deviceScaleFactor: 2, mobile: true })
}

await send('Page.enable'); await send('Runtime.enable')

// ── Sign in ──────────────────────────────────────────────────────────────────
await setWidth(390)
await goto(`${baseUrl}/login`)
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
await sleep(6000)
const signedIn = await evaluate('location.pathname')
check('signed in as the owner', !String(signedIn).includes('/login'), `still at ${signedIn}`)

const OVERFLOW = `(() => {
  const bad = []
  for (const el of document.querySelectorAll('body *')) {
    const r = el.getBoundingClientRect()
    if (r.width === 0) continue
    if (r.right > innerWidth + 1 || r.left < -1) {
      bad.push(el.tagName.toLowerCase() + '.' + String(el.className || '').slice(0, 40)
        + ' [' + Math.round(r.left) + '..' + Math.round(r.right) + ']')
    }
  }
  return bad.slice(0, 4)
})()`

// Open the New Job form, choose a customer, type a service, expand Time & crew.
const OPEN_FORM = svc => `(async () => {
  const set = (el, v) => {
    const p = Object.getOwnPropertyDescriptor(el.constructor.prototype, 'value').set
    p.call(el, v); el.dispatchEvent(new Event('input', { bubbles: true }))
    el.dispatchEvent(new Event('change', { bubbles: true }))
  }
  const sleep = ms => new Promise(r => setTimeout(r, ms))
  const byText = (sel, re) => [...document.querySelectorAll(sel)].find(e => re.test(e.textContent || ''))
  byText('button', /^Add job$/)?.click()
  await sleep(1500)
  // Customer — the first real option in the customer select.
  for (const s of document.querySelectorAll('select')) {
    const lab = s.closest('div')?.querySelector('label')?.textContent || ''
    if (/customer/i.test(lab)) {
      const opt = [...s.options].find(o => o.value && o.value.length > 20)
      if (opt) set(s, opt.value)
      break
    }
  }
  await sleep(900)
  // Service type — the free-text field the learner buckets on.
  for (const i of document.querySelectorAll('input')) {
    const lab = i.closest('div')?.querySelector('label')?.textContent || i.placeholder || ''
    if (/service/i.test(lab)) { set(i, ${JSON.stringify('%SVC%')}); break }
  }
  await sleep(600)
  // "+ More options" reveals the advanced block. ⚠️ "Time & crew" is already
  // OPEN on a new job (defaultOpen={!isEdit}) — clicking it CLOSES it, which is
  // how the first run of this harness reported the card missing when it was the
  // click that hid it. Only open it if it is shut.
  byText('button', /More options/)?.click()
  await sleep(800)
  // ⚠️ A plain substring test, NOT a regex: inside this template literal a
  // backslash-escaped paren collapses to a bare paren, so /DURATION \(MINUTES\)/
  // arrives as /DURATION (MINUTES)/ — a capture group that matches
  // "DURATION MINUTES" and never the real label. The first run of this harness
  // therefore always clicked, closing the section, and reported the card missing.
  if (!(document.querySelector('form')?.innerText || '').toUpperCase().includes('DURATION')) {
    byText('button', /Time & crew/)?.click()
  }
  await sleep(2500)
  return true
})()`.replace('%SVC%', svc)

// Whitespace-normalise the card copy HERE, in Node, where a regex is real source
// rather than text inside a template literal being shipped to the browser (there a
// lost backslash turns the whitespace class into a literal s and deletes every s.
const WS = new RegExp("[" + String.fromCharCode(9,10,11,12,13,32,160) + "]+", "g")
const norm = c => (c && typeof c.text === "string" ? { ...c, text: c.text.replace(WS, " ").trim() } : c)

const CARD = `(() => {
  const h = [...document.querySelectorAll('span')].find(e => /^Smart estimate$/.test((e.textContent||'').trim()))
  if (!h) return { found: false }
  const card = h.closest('div').parentElement
  const r = card.getBoundingClientRect()
  // ⚠️ Session 47 replaced the plain "Duration (minutes)" box with DurationField:
  // a number input paired with a unit select, so the STORED minutes are no
  // longer what the input shows (26 minutes reads as 26 + Minutes; 720 reads as
  // 1.5 + Workdays). The unit is read alongside the value, and the assertions
  // below compare the pair, never a bare number.
  const unitSel = document.querySelector('select[aria-label="Duration unit"]')
  const dur = unitSel ? unitSel.closest('div').querySelector('input[type=number]') : null
  const unit = unitSel ? unitSel.value : null
  return {
    // ⚠️ Raw text out; normalised on the NODE side. A whitespace regex written
    // inside this template literal loses a backslash and becomes /s+/g, which
    // silently deletes every letter "s" from the card's own copy — the checks
    // then fail against text the app never rendered.
    found: true, text: card.textContent || '',
    height: Math.round(r.height), width: Math.round(r.width), right: Math.round(r.right),
    hasApply: !!(card.querySelector('button') && /Use estimate/.test(card.textContent || '')),
    duration: dur ? dur.value : null, unit,
    storedMinutes: dur && unit
      ? Math.round(Number(dur.value) * (unit === 'days' ? 480 : unit === 'hours' ? 60 : 1))
      : null,
  }
})()`

console.log('\n═══ Job form · Smart estimate · a service with ESTABLISHED history ═══')
for (const w of WIDTHS) {
  await setWidth(w)
  await goto(`${baseUrl}/dashboard/schedule`)
  await evaluate(OPEN_FORM('Lawn Mowing'))
  const c = norm(await evaluate(CARD))
  if (!c?.found) { bad(`${w}px — the Smart estimate card renders`, JSON.stringify(c)); continue }
  check(`${w}px — the card renders`, true)
  check(`${w}px — it names its confidence in words, not a percentage`,
    /Established estimate|Limited history|Not enough history/.test(c.text) && !/%/.test(c.text), c.text)
  check(`${w}px — it states the evidence count`, /Based on \d+ comparable completed job/.test(c.text)
    || /job.? recorded/.test(c.text) || /Not enough history/.test(c.text), c.text)
  check(`${w}px — the card stays compact (${c.height}px tall)`, c.height <= 175, `${c.height}px`)
  check(`${w}px — it fits the viewport (right edge ${c.right} ≤ ${w})`, c.right <= w + 1, `right ${c.right}`)
  const of = await evaluate(OVERFLOW)
  check(`${w}px — nothing overflows sideways`, Array.isArray(of) && of.length === 0, JSON.stringify(of))
  if (w === 390) console.log(`      CARD: ${c.text}`)
}

console.log('\n═══ Applying is a deliberate act ═══')
await setWidth(390)
await goto(`${baseUrl}/dashboard/schedule`)
await evaluate(OPEN_FORM('Lawn Mowing'))
{
  const before = norm(await evaluate(CARD))
  check('the duration field is NOT auto-filled by the learner',
    before.storedMinutes === 60, `field held ${before.storedMinutes}m (${before.duration} ${before.unit})`)
  check('…and an apply control is offered', before.hasApply === true, JSON.stringify(before))
  await evaluate(`(() => {
    const h = [...document.querySelectorAll('span')].find(e => /^Smart estimate$/.test((e.textContent||'').trim()))
    const card = h.closest('div').parentElement
    ;[...card.querySelectorAll('button')].find(b => /Use estimate/.test(b.textContent||''))?.click()
    return true
  })()`)
  await sleep(1200)
  const after = norm(await evaluate(CARD))
  check('clicking Use estimate applies the learned duration',
    !!after.duration && after.duration !== before.duration, `before ${before.duration}${before.unit} → after ${after.duration}${after.unit}`)
  check('…and the card then says Applied', /Applied/.test(after.text), after.text)
  console.log(`      duration ${before.duration} ${before.unit} (${before.storedMinutes}m) → ${after.duration} ${after.unit} (${after.storedMinutes}m)`)
}

console.log('\n═══ A service with NO history says so, and offers nothing ═══')
await setWidth(390)
await goto(`${baseUrl}/dashboard/schedule`)
await evaluate(OPEN_FORM('Warehouse Fit-Out'))
{
  const c = norm(await evaluate(CARD))
  check('the card renders in the empty state', c?.found === true, JSON.stringify(c))
  check('…and says there is not enough history', /Not enough history yet/.test(c?.text || ''), c?.text)
  check('…offers NO duration to apply', c?.hasApply === false, c?.text)
  check('…and invites a manual estimate', /manually/.test(c?.text || ''), c?.text)
  check('…while the duration field is untouched', c?.storedMinutes === 60, `was ${c?.storedMinutes}m`)
  console.log(`      CARD: ${c?.text}`)
}

console.log(fails ? `\n✗ ${fails} failure(s)` : '\n✓ smart estimate: honest and phone-sized in the real app')
ws.close(); chrome.kill(); process.exit(fails ? 1 : 0)
