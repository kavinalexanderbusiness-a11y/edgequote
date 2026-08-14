// ── Production proof: the pipeline on a real phone viewport ──────────────────
//   node scripts/prove-pipeline-mobile.mjs [baseUrl]
//
// Drives REAL Chrome over CDP at 375 / 390 / 430 CSS px against a running
// server, signs in as the owner, opens /dashboard/pipeline and MEASURES it.
// Class-name greps cannot tell you whether a row overflows; only layout can.
//
// What it asserts, per width:
//   • the page body never scrolls sideways (scrollWidth <= clientWidth + 1)
//   • no element pushes past the viewport's right edge
//   • every tap target on the board clears 44 CSS px
//   • the board actually rendered rows (a blank page passes every other check)
//
// ⚠️ It measures the SCREEN IT ASKED FOR. A prior session in this repo shipped a
// green mobile report having measured a different screen entirely, so this one
// asserts the URL it landed on and that pipeline-specific content is present
// before it believes a single number.
//
// Read-only. Dev tooling; `next build` never invokes it.

import { readFileSync } from 'node:fs'
import { spawn } from 'node:child_process'
import { join } from 'node:path'

const BASE = process.argv[2] || 'http://localhost:3210'
const WIDTHS = [375, 390, 430]
const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'

for (const line of readFileSync(join(process.cwd(), '.env.local'), 'utf8').split(/\r?\n/)) {
  const m = /^([A-Z_][A-Z0-9_]*)=(.*)$/.exec(line.trim())
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '')
}
const EMAIL = process.env.PORTAL_RPC_OWNER_EMAIL
const PASSWORD = process.env.PORTAL_RPC_OWNER_PASSWORD

let failures = 0
const ok = (n) => console.log(`  ✓ ${n}`)
const fail = (n, d) => { failures++; console.log(`  ✗ ${n}\n      ${d}`) }
const check = (n, cond, d = '') => (cond ? ok(n) : fail(n, d))
const sleep = (ms) => new Promise(r => setTimeout(r, ms))

// ── minimal CDP client ───────────────────────────────────────────────────────
let ws, nextId = 1
const pending = new Map()
function send(method, params = {}) {
  const id = nextId++
  ws.send(JSON.stringify({ id, method, params }))
  return new Promise((res, rej) => pending.set(id, { res, rej }))
}
async function evaluate(expression) {
  const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || 'eval threw')
  return r.result.value
}

const profile = join(process.env.TEMP || '.', 'eq-cdp-profile-s52')
const chrome = spawn(CHROME, [
  '--headless=new', '--remote-debugging-port=9333', '--no-first-run', '--no-default-browser-check',
  `--user-data-dir=${profile}`, '--hide-scrollbars', 'about:blank',
], { stdio: 'ignore' })

async function main() {
  // Wait for the debugger, then attach to the page target.
  let target = null
  for (let i = 0; i < 60 && !target; i++) {
    try {
      const list = await (await fetch('http://127.0.0.1:9333/json/list')).json()
      target = list.find(t => t.type === 'page')
    } catch { /* not up yet */ }
    if (!target) await sleep(250)
  }
  if (!target) throw new Error('Chrome never opened its debugging port')

  ws = new WebSocket(target.webSocketDebuggerUrl)
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = () => rej(new Error('CDP socket failed')) })
  ws.onmessage = (ev) => {
    const msg = JSON.parse(ev.data)
    if (msg.id && pending.has(msg.id)) {
      const { res, rej } = pending.get(msg.id); pending.delete(msg.id)
      msg.error ? rej(new Error(msg.error.message)) : res(msg.result)
    }
  }
  await send('Page.enable'); await send('Runtime.enable')

  // ── Sign in once, at a phone width ──
  await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true })
  await send('Page.navigate', { url: `${BASE}/login` })
  // Poll for the form rather than guessing a sleep — a fixed wait is how a
  // measurement script starts reporting on a screen that had not painted.
  let formReady = false
  for (let i = 0; i < 60 && !formReady; i++) {
    formReady = await evaluate('!!document.querySelector("input[type=email]") && !!document.querySelector("input[type=password]")')
    if (!formReady) await sleep(500)
  }
  if (!formReady) throw new Error('the login form never rendered')
  await evaluate(`(() => {
    const set = (el, v) => {
      const proto = Object.getPrototypeOf(el)
      Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, v)
      el.dispatchEvent(new Event('input', { bubbles: true }))
    }
    set(document.querySelector('input[type=email]'), ${JSON.stringify(EMAIL)})
    set(document.querySelector('input[type=password]'), ${JSON.stringify(PASSWORD)})
    document.querySelector('form').requestSubmit()
    return true
  })()`)
  let landed = '/login'
  for (let i = 0; i < 60; i++) {
    landed = await evaluate('location.pathname')
    if (landed.startsWith('/dashboard')) break
    await sleep(500)
  }
  check(`signed in (landed on ${landed})`, landed.startsWith('/dashboard'), `still on ${landed} — check the credentials`)
  if (!landed.startsWith('/dashboard')) throw new Error('cannot measure without a session')

  for (const width of WIDTHS) {
    console.log(`\n─ ${width} × 844 ─`)
    await send('Emulation.setDeviceMetricsOverride', { width, height: 844, deviceScaleFactor: 2, mobile: true })
    await send('Page.navigate', { url: `${BASE}/dashboard/pipeline` })
    // Wait for the board itself, not a stopwatch.
    for (let i = 0; i < 60; i++) {
      const ready = await evaluate('!!document.querySelector("h1") && (!!document.querySelector("ol > li") || !!document.querySelector("[data-empty]"))')
      if (ready) break
      await sleep(500)
    }
    await sleep(400) // let the pill row settle before measuring

    const m = await evaluate(`(() => {
      const de = document.documentElement
      const rows = [...document.querySelectorAll('ol > li')]
      // Every interactive target ON THE BOARD (not the shell nav).
      const board = document.querySelector('ol')
      const targets = board ? [...board.querySelectorAll('a, button')] : []
      const small = targets
        .map(el => ({ t: (el.textContent || '').trim().slice(0, 30), h: Math.round(el.getBoundingClientRect().height) }))
        .filter(x => x.h > 0 && x.h < 44)
      // Anything sticking out past the right edge, named so it can be fixed.
      //
      // Content INSIDE its own horizontal scroller does not count, and that is
      // the real rule rather than a loosened one: wide content is allowed to
      // extend as long as it scrolls within its own container and the PAGE does
      // not. The stage-pill strip is deliberately such a scroller — six pills
      // plus counts cannot fit across 375px, and wrapping them into a four-line
      // wall is worse than a swipe. A genuine leak (a row, a price, a button)
      // has no scrolling ancestor and is still caught.
      const scrolls = el => {
        for (let n = el.parentElement; n && n !== document.body; n = n.parentElement) {
          const ox = getComputedStyle(n).overflowX
          if (ox === 'auto' || ox === 'scroll') return true
        }
        return false
      }
      const over = [...document.querySelectorAll('main *')]
        .map(el => ({ el, r: el.getBoundingClientRect() }))
        .filter(({ el, r }) => r.width > 0 && r.right > de.clientWidth + 1 && !scrolls(el))
        .slice(0, 5)
        .map(({ el, r }) => el.tagName.toLowerCase() + '.' + (el.className || '').toString().split(' ').slice(0, 2).join('.') + ' right=' + Math.round(r.right))
      const pills = [...document.querySelectorAll('[aria-pressed]')].length
      return {
        path: location.pathname,
        scrollWidth: de.scrollWidth, clientWidth: de.clientWidth,
        rows: rows.length, pills, small, over,
        heading: (document.querySelector('h1')||{}).textContent || '',
        firstRow: rows[0] ? rows[0].textContent.replace(/\\s+/g,' ').trim().slice(0, 90) : '',
      }
    })()`)

    // ⚠️ Prove it is THE pipeline before believing any measurement.
    check('this is the pipeline screen', m.path === '/dashboard/pipeline' && m.heading.includes('Pipeline'),
      `path=${m.path} heading=${JSON.stringify(m.heading)}`)
    check(`the board rendered rows (${m.rows}) and stage pills (${m.pills})`, m.rows > 0 && m.pills >= 6,
      'a blank page passes every layout check ever written')
    check(`no sideways scroll (${m.scrollWidth} ≤ ${m.clientWidth})`, m.scrollWidth <= m.clientWidth + 1,
      `the page scrolls ${m.scrollWidth - m.clientWidth}px sideways`)
    check('nothing overflows the right edge', m.over.length === 0, m.over.join(' · '))
    check('every tap target on the board clears 44px', m.small.length === 0,
      m.small.map(s => `"${s.t}" ${s.h}px`).join(' · '))
    if (m.firstRow) console.log(`    top row: ${m.firstRow}`)
  }

  console.log('\n── Summary ────────────────────────────────────────────────────')
  if (failures) { console.log(`\n❌ prove-pipeline-mobile — ${failures} failure(s)\n`); process.exitCode = 1 }
  else console.log('\n✅ prove-pipeline-mobile — clean at 375, 390 and 430\n')
}

main()
  .catch(e => { console.error('\n❌ ' + (e?.message || e) + '\n'); process.exitCode = 1 })
  .finally(() => { try { ws?.close() } catch {} chrome.kill() })
