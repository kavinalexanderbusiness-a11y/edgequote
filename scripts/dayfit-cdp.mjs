// ── Drive the REAL app: Day Suggestions are honest and phone-sized ───────────
// Signs in with the owner credentials from .env.local, opens the two surfaces
// that carry day suggestions (quote builder "Best days", job form "Plan this
// job into your week"), and checks what a person would check by hand:
//
//   1. The suggestion block renders one of its HONEST states — a capacity-
//      annotated recommendation, "duration unknown — review", "no nearby
//      visits", or "couldn't check day capacity" — never a bare crash and
//      never a "fits" claim alongside an unknown duration.
//   2. Nothing overflows sideways at 375 / 390 / 430.
//
//   node scripts/dayfit-cdp.mjs <baseUrl> [--shot]
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
      bad.push((el.tagName.toLowerCase()) + '.' + String(el.className || '').slice(0, 40)
        + ' [' + Math.round(r.left) + '..' + Math.round(r.right) + ']')
    }
  }
  return bad.slice(0, 4)
})()`

// ── 1. Quote builder — the "Best days" block, sized by the quote itself ──────
console.log('\n═══ Quote builder: Best days to schedule ═══')
for (const w of WIDTHS) {
  await setWidth(w)
  await goto(`${baseUrl}/dashboard/quotes/new`)
  // Type an address so the suggester has a target, and open the collapsed
  // sections until the "Find best days" button (or the block itself) shows.
  await evaluate(`(() => {
    const set = (el, v) => {
      const p = Object.getOwnPropertyDescriptor(el.constructor.prototype, 'value').set
      p.call(el, v); el.dispatchEvent(new Event('input', { bubbles: true }))
    }
    for (const inp of document.querySelectorAll('input')) {
      const label = inp.closest('div')?.querySelector('label')?.textContent || inp.placeholder || ''
      if (/address/i.test(label)) { set(inp, '128 Queensland Circle SE, Calgary'); break }
    }
    for (const b of document.querySelectorAll('button')) {
      if (/best days|more options|advanced/i.test(b.textContent || '')) b.click()
    }
    return true
  })()`)
  await sleep(1000)
  await evaluate(`(() => {
    for (const b of document.querySelectorAll('button')) {
      if (/find best days/i.test(b.textContent || '')) { b.click(); return 'clicked' }
    }
    return 'no button'
  })()`)
  await sleep(5000)

  const state = await evaluate(`(() => {
    const text = document.body.innerText
    return {
      hasBlock: /best days to schedule/i.test(text),
      honest: /recommended based on nearby visits|duration unknown|no nearby visits|couldn.t check day capacity|add a located address|analyzing your schedule|enter a service address/i.test(text),
      claimsFitWhileUnknown: /duration unknown/i.test(text) && /~\\d+[hm].*(estimated|typical).*free/i.test(text),
    }
  })()`)
  check(`${w}px: the Best days block is present`, state?.hasBlock, JSON.stringify(state))
  check(`${w}px: it is in an HONEST state`, state?.honest, JSON.stringify(state))
  check(`${w}px: no fits-claim beside an unknown duration`, !state?.claimsFitWhileUnknown)
  const over = await evaluate(OVERFLOW)
  check(`${w}px: nothing overflows sideways`, (over || []).length === 0, (over || []).join(' · '))
}

// ── 2. Schedule — the job form's week planner carries the fit line ───────────
console.log('\n═══ Schedule: Plan this job into your week ═══')
for (const w of WIDTHS) {
  await setWidth(w)
  await goto(`${baseUrl}/dashboard/schedule?new=1`)
  await sleep(1500)
  // Open the add-job form if a button guards it, then pick the first customer.
  await evaluate(`(() => {
    for (const b of document.querySelectorAll('button')) {
      if (/add (a )?(job|visit)|new (job|visit)/i.test(b.textContent || '')) { b.click(); break }
    }
    return true
  })()`)
  await sleep(1200)
  await evaluate(`(() => {
    const sel = [...document.querySelectorAll('select')].find(s =>
      [...s.options].some(o => /select a customer/i.test(o.textContent || '')))
    if (sel && sel.options.length > 1) {
      sel.value = sel.options[1].value
      sel.dispatchEvent(new Event('change', { bubbles: true }))
      return sel.options[1].textContent
    }
    return null
  })()`)
  await sleep(4000)

  const state = await evaluate(`(() => {
    const text = document.body.innerText
    const hasPlanner = /plan this job into your week/i.test(text)
    return {
      hasForm: /service type/i.test(text),
      hasPlanner,
      plannerHonest: !hasPlanner || /pick one|duration unknown|couldn.t check day capacity|no work day|add a located address|planning your work week|no upcoming work days/i.test(text),
    }
  })()`)
  check(`${w}px: the job form opened`, state?.hasForm, JSON.stringify(state))
  check(`${w}px: the week planner is honest (or absent for an unlocated customer)`, state?.plannerHonest, JSON.stringify(state))
  const over = await evaluate(OVERFLOW)
  check(`${w}px: nothing overflows sideways`, (over || []).length === 0, (over || []).join(' · '))
}

ws.close(); chrome.kill()
console.log(fails ? `\n✗ ${fails} failure(s)` : '\n✓ day suggestions honest and phone-sized at 375/390/430')
process.exit(fails ? 1 : 0)
