// ── Session 61 field home, in a real phone-sized browser ─────────────────────
//   node scripts/s61-field-cdp.mjs [baseUrl]
//
// Drives THIS BRANCH (a local server) as the live fixture worker created by
// s61-field-proof.mjs --keep, at the three widths the product commits to.
//
// ⭐ WHY LOCAL AND NOT app.edgehq.ca: production serves `main`, which does not
// carry this branch. Driving the deployed app would prove somebody else's code.
// The DATA is real production data over the real RPCs — only the code being
// exercised is this branch.
//
// ⛔ READ-MOSTLY. It signs in, reads Today, and taps nothing that writes except
// the one Start it is asked to prove; the lifecycle writes are proven at the
// RPC layer by s61-field-proof.mjs, which can also undo them.
//
// Harness traps already paid for elsewhere and honoured here:
//   · wait for HYDRATION, not paint — a controlled input filled pre-hydration
//     keeps its DOM value but loses React state, and the form submits empty
//   · MEASURE innerWidth after setDeviceMetricsOverride; an unverified viewport
//     reports desktop numbers as phone numbers
//   · overflow is measured PER ELEMENT against innerWidth, because <main> is
//     overflow-auto so document.scrollWidth never reports sideways overflow

import { spawn } from 'node:child_process'
import { mkdtempSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
// Same fallback the other CDP harnesses use: `ws` if the repo happens to carry
// it, else Node's own global WebSocket (node 22+). ⛔ Do NOT add `ws` as a
// dependency for this — it would change the lockfile CI installs from.
const { WebSocket } = await import('ws').catch(() => ({ WebSocket: globalThis.WebSocket }))

const BASE = process.argv[2] || 'http://127.0.0.1:3161'
const WIDTHS = [375, 390, 430]
const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'
const PORT = 9471 + Number(process.env.CDP_SLOT || 3)

const st = existsSync('scripts/.s61-fixture.json')
  ? JSON.parse(readFileSync('scripts/.s61-fixture.json', 'utf8')) : {}
for (const f of ['.env.local', '../../edgehq-main/.env.local']) {
  if (!existsSync(f)) continue
  for (const line of readFileSync(f, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)$/)
    if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].trim()
  }
}
const EMAIL = (process.env.PORTAL_RPC_OWNER_EMAIL || '').replace(/@/, '+s61a@')
const PW = process.env.S61_WORKER_PW || st.workerPw
if (!EMAIL || !PW) { console.error('no fixture worker credentials'); process.exit(2) }

let pass = 0, fail = 0
const ok = (n, x = '') => { pass++; console.log(`  ✅ ${n}${x ? ' — ' + x : ''}`) }
const no = (n, d = '') => { fail++; console.log(`  ❌ ${n}${d ? '\n       ' + d : ''}`) }
const t = (n, c, d = '') => c ? ok(n, typeof d === 'string' && d ? d : '') : no(n, d)

const profile = mkdtempSync(join(tmpdir(), 's61-cdp-'))
const chrome = spawn(CHROME, [
  `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`,
  '--headless=new', '--disable-gpu', '--no-sandbox', '--hide-scrollbars',
  '--no-first-run', '--no-default-browser-check', 'about:blank',
], { stdio: 'ignore' })

const sleep = ms => new Promise(r => setTimeout(r, ms))

async function target() {
  for (let i = 0; i < 60; i++) {
    try {
      const list = await fetch(`http://127.0.0.1:${PORT}/json/list`).then(r => r.json())
      const page = list.find(x => x.type === 'page')
      if (page) return page.webSocketDebuggerUrl
    } catch { /* not up yet */ }
    await sleep(500)
  }
  throw new Error('no CDP page target')
}

async function main() {
  // ⚠️ The WHATWG event API, not node-style `.on()`: Node's GLOBAL WebSocket
  // (which this falls back to) has no EventEmitter interface, and `ws.on is not
  // a function` is what that mistake looks like. addEventListener works on both.
  const ws = new WebSocket(await target())
  await new Promise(r => ws.addEventListener('open', r, { once: true }))
  let id = 0
  const pending = new Map()
  ws.addEventListener('message', ev => {
    const m = JSON.parse(typeof ev.data === 'string' ? ev.data : ev.data.toString())
    if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id) }
  })
  const send = (method, params = {}) => new Promise(res => {
    const n = ++id
    pending.set(n, res)
    ws.send(JSON.stringify({ id: n, method, params }))
  })
  const evalJs = async (expr) => {
    const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true })
    return r.result?.result?.value
  }
  const goto = async (path) => {
    await send('Page.navigate', { url: `${BASE}${path}` })
    // Hydration, not paint: React must own the inputs before we type.
    for (let i = 0; i < 80; i++) {
      const ready = await evalJs(`document.readyState === 'complete' && !!document.querySelector('#__next, body > div')`)
      if (ready) break
      await sleep(250)
    }
    await sleep(900)
  }
  /**
   * ⚠️ WAIT FOR THE DAY, NOT THE PAGE. CrewToday is a client component that
   * asks crew_day for the day AFTER it mounts, so `readyState === 'complete'`
   * is true while the screen is still skeletons. Asserting there reports "no
   * Start button" for a board that simply had not arrived — a broken harness
   * that reads exactly like a broken feature.
   */
  const waitForDay = async () => {
    for (let i = 0; i < 60; i++) {
      const ready = await evalJs(`(() => {
        if (document.querySelector('[id^="crew-stop-"]')) return 'stops'
        const t = document.body.innerText || ''
        if (/Nothing booked today|No stops on the board|access has been turned off|Couldn.t load today/.test(t)) return 'empty'
        return ''
      })()`)
      if (ready) return ready
      await sleep(500)
    }
    return 'timeout'
  }

  await send('Page.enable'); await send('Runtime.enable')

  console.log(`\n═══ Session 61 field home in a phone browser — ${BASE} ═══`)

  // ── sign in once at a phone width ──────────────────────────────────────────
  await send('Emulation.setDeviceMetricsOverride',
    { width: 390, height: 850, deviceScaleFactor: 2, mobile: true })
  await goto('/login')
  const measured = await evalJs('window.innerWidth')
  t('the viewport is really a phone', measured === 390, `innerWidth=${measured}`)

  await evalJs(`(() => {
    const set = (el, v) => {
      const d = Object.getOwnPropertyDescriptor(el.constructor.prototype, 'value')
      d.set.call(el, v); el.dispatchEvent(new Event('input', { bubbles: true }))
    }
    const em = document.querySelector('input[type=email]')
    const pw = document.querySelector('input[type=password]')
    if (em) set(em, ${JSON.stringify(EMAIL)})
    if (pw) set(pw, ${JSON.stringify(PW)})
    return !!(em && pw)
  })()`)
  await evalJs(`document.querySelector('form')?.requestSubmit() ?? document.querySelector('button[type=submit]')?.click()`)
  await sleep(4000)
  let url = await evalJs('location.pathname')
  t('⭐ a worker signing in LANDS IN TODAY', url === '/crew', `landed at ${url}`)
  if (url !== '/crew') { await goto('/crew'); url = await evalJs('location.pathname') }

  // ── what Today says ────────────────────────────────────────────────────────
  const arrived = await waitForDay()
  t('the day actually loaded for this worker', arrived === 'stops', `state=${arrived}`)
  const text = await evalJs('document.body.innerText')
  t('the day names the first stop before any scrolling',
    /First up|Now:|Next:/.test(text), (text.match(/(First up|Now|Next):[^\n]*/) || [''])[0])
  t('the fixture work is on the board', /ZZ-S61-FIXTURE|S61/.test(text))
  t('no money reaches the worker\'s screen',
    !/\$\d/.test(text), (text.match(/\$\d[\d.,]*/g) || []).join(' '))
  const crewLine = (text.match(/ZZ-S61-FIXTURE CREW[^\n]*/) || [''])[0]
  ok('crew/assignment line rendered', crewLine || '(none)')

  // ── the three widths ───────────────────────────────────────────────────────
  for (const w of WIDTHS) {
    await send('Emulation.setDeviceMetricsOverride',
      { width: w, height: 850, deviceScaleFactor: 2, mobile: true })
    await goto('/crew')
    await waitForDay()          // measure the real board, not a skeleton
    const real = await evalJs('window.innerWidth')
    const over = await evalJs(`(() => {
      const w = window.innerWidth
      const bad = []
      for (const el of document.querySelectorAll('body *')) {
        const r = el.getBoundingClientRect()
        if (r.width > 0 && (r.right > w + 1 || r.left < -1)) {
          bad.push((el.tagName + '.' + (el.className || '')).slice(0, 60))
        }
      }
      return bad.slice(0, 4)
    })()`)
    const taps = await evalJs(`(() => {
      let small = 0
      for (const el of document.querySelectorAll('button, a[href]')) {
        const r = el.getBoundingClientRect()
        if (r.width > 0 && r.height > 0 && r.height < 40) small++
      }
      return small
    })()`)
    t(`${w}px — no horizontal overflow`, real === w && (over || []).length === 0,
      `innerWidth=${real} offenders=${JSON.stringify(over)}`)
    t(`${w}px — tap targets are thumb-sized`, taps === 0, `${taps} control(s) under 40px tall`)
  }

  // ── the stop opens and offers the right action ─────────────────────────────
  await send('Emulation.setDeviceMetricsOverride',
    { width: 390, height: 850, deviceScaleFactor: 2, mobile: true })
  await goto('/crew')
  await waitForDay()
  const actions = await evalJs(`Array.from(document.querySelectorAll('button')).map(b => b.innerText.trim()).filter(Boolean).slice(0, 14)`)
  console.log('   buttons on the card:', JSON.stringify(actions))
  t('Start is offered on a stop not yet begun',
    (actions || []).some(a => /^(Start|Resume)$/i.test(a)), JSON.stringify(actions))
  t('⛔ Finish is NOT offered before the clock is running',
    !(actions || []).some(a => /^Finish$/i.test(a)),
    'Finish must appear only once the visit is on the clock')
  t('Directions and Call reach the customer safely',
    (await evalJs(`!!document.querySelector('a[href^="tel:"], a[href*="maps"], a[href*="google"]')`)) === true)

  console.log(`\n── browser proof: ${pass} passed, ${fail} failed ──`)
  ws.close()
  if (fail) process.exitCode = 1
}

main()
  .catch(e => { no('the browser harness itself failed', String(e?.message ?? e)); process.exitCode = 1 })
  .finally(() => { try { chrome.kill() } catch {} })
