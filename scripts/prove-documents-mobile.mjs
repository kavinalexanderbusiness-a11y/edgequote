// ── Phone proof: the Session-74 document surfaces at real phone widths ──────
//   npx tsx --tsconfig tsconfig.harness.json scripts/documents-harness.tsx .documents-harness
//   node scripts/prove-documents-mobile.mjs [dir]
//
// Drives REAL Chrome over CDP at 375 / 390 / 430 CSS px against the harness
// pages (the real DocumentRow, the real dialogs, the real compiled CSS).
// Credential-free — same posture as prove-dayactions-mobile.
//
// Per width, per scenario:
//   • no sideways scroll; nothing pokes past the right edge
//   • every interactive target clears 44 CSS px under (pointer: coarse)
//   • the scenario rendered what it CLAIMS — a blank page passes every layout
//     check ever written, so each scenario asserts its own content
//
// Read-only. Dev tooling; `next build` never invokes it.

import { spawn } from 'node:child_process'
import { join, resolve } from 'node:path'
import { readdirSync } from 'node:fs'

const DIR = resolve(process.argv[2] || '.documents-harness')
const WIDTHS = [375, 390, 430]
const PORT = 9371 + (Number(process.env.CDP_SLOT) || 0)
const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'

let failures = 0
const ok = (n) => console.log(`  [ok]   ${n}`)
const fail = (n, d) => { failures++; console.log(`  [FAIL] ${n}\n         ${d}`) }
const check = (n, cond, d = '') => (cond ? ok(n) : fail(n, d))
const sleep = (ms) => new Promise(r => setTimeout(r, ms))

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

const profile = join(process.env.TEMP || '.', 'eq-cdp-profile-s74')
const chrome = spawn(CHROME, [
  '--headless=new', `--remote-debugging-port=${PORT}`, '--no-first-run', '--no-default-browser-check',
  `--user-data-dir=${profile}`, '--hide-scrollbars', '--allow-file-access-from-files', 'about:blank',
], { stdio: 'ignore' })

const SCENARIOS = readdirSync(DIR).filter(f => f.endsWith('.html')).map(f => f.replace(/\.html$/, ''))

async function main() {
  let target = null
  for (let i = 0; i < 60 && !target; i++) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()
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
  await send('Runtime.enable'); await send('Page.enable')
  // P setDeviceMetricsOverride(mobile:true) does NOT make (pointer: coarse)
  // match in headless Chrome — only touch emulation does (measured, Session 71).
  // Without it every .tap-target rule stays inert and the 44px assertions below
  // would be measuring a mouse UI and passing for the wrong reason.
  await send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 })

  for (const scenario of SCENARIOS) {
    const url = 'file:///' + join(DIR, `${scenario}.html`).replace(/\\/g, '/')
    for (const width of WIDTHS) {
      console.log(`\n─ ${scenario} @ ${width} × 844 ─`)
      await send('Emulation.setDeviceMetricsOverride', { width, height: 844, deviceScaleFactor: 2, mobile: true })
      await send('Page.navigate', { url })
      for (let i = 0; i < 40; i++) {
        const ready = await evaluate('document.readyState === "complete" && document.body.children.length > 0')
        if (ready) break
        await sleep(250)
      }
      await sleep(200)

      const coarse = await evaluate("matchMedia('(pointer: coarse)').matches")
      check('the viewport is a phone (pointer: coarse matches)', coarse === true,
        'touch emulation did not take — the 44px assertions below would measure a mouse UI')

      const m = await evaluate(`(() => {
        const de = document.documentElement
        // A rect past the edge is a LEAK only when nothing clips or scrolls it —
        // inside overflow auto/scroll it pans in place; hidden/clip is truncation
        // doing its job (the inbox prover's rule, unchanged).
        const scrolls = el => {
          for (let n = el.parentElement; n && n !== document.body; n = n.parentElement) {
            const ox = getComputedStyle(n).overflowX
            if (ox === 'auto' || ox === 'scroll' || ox === 'hidden' || ox === 'clip') return true
          }
          return false
        }
        const over = [...document.body.querySelectorAll('*')]
          .map(el => ({ el, r: el.getBoundingClientRect() }))
          .filter(({ el, r }) => r.width > 0 && r.right > de.clientWidth + 1 && !scrolls(el))
          .slice(0, 5)
          .map(({ el, r }) => el.tagName.toLowerCase() + '.' + (el.className || '').toString().split(' ').slice(0, 2).join('.') + ' right=' + Math.round(r.right))
        const small = [...document.querySelectorAll('a, button, select, textarea, input[type=file]')]
          .map(el => ({
            t: ((el.getAttribute('aria-label') || el.textContent) || el.tagName).trim().slice(0, 40),
            h: Math.round(el.getBoundingClientRect().height),
            w: Math.round(el.getBoundingClientRect().width),
          }))
          .filter(x => x.h > 0 && x.h < 44)
        const canvas = document.querySelector('canvas')
        const cr = canvas ? canvas.getBoundingClientRect() : null
        const dialog = document.querySelector('[role=dialog]')
        const dr = dialog ? dialog.getBoundingClientRect() : null
        const text = document.body.textContent || ''
        return {
          scrollWidth: de.scrollWidth, clientWidth: de.clientWidth, over, small,
          innerH: window.innerHeight,
          hasDialog: !!dialog, dialogBottom: dr ? Math.round(dr.bottom) : null,
          canvasW: cr ? Math.round(cr.width) : null, canvasH: cr ? Math.round(cr.height) : null,
          canvasTouchAction: canvas ? getComputedStyle(canvas).touchAction : null,
          text,
        }
      })()`)

      check(`no sideways scroll (${m.scrollWidth} <= ${m.clientWidth})`, m.scrollWidth <= m.clientWidth + 1,
        `the page scrolls ${m.scrollWidth - m.clientWidth}px sideways`)
      check('nothing overflows the right edge', m.over.length === 0, m.over.join(' · '))
      check('every tap target clears 44px', m.small.length === 0,
        m.small.map(s => `"${s.t}" ${s.w}x${s.h}px`).join(' · '))

      // ── the scenario rendered what it claims ────────────────────────────────
      if (scenario === 'owner-rows') {
        check('every document state is on screen (internal · awaiting · signed · archived)',
          /Development permit/.test(m.text) && /Awaiting signature/.test(m.text)
          && /Signed by Alexandra/.test(m.text) && /Archived/.test(m.text), 'a state is missing')
        check('visibility is stated in words, not a code',
          /Internal only/.test(m.text) && /Shared with the customer/.test(m.text))
      }
      if (scenario === 'owner-upload') {
        check('the upload sheet renders on-screen', m.hasDialog && m.dialogBottom <= m.innerH + 1,
          `dialog bottom ${m.dialogBottom} vs viewport ${m.innerH}`)
        check('it opens on Internal and says who that means',
          /Internal only/.test(m.text) && /Only you can see this/.test(m.text),
          'default-safe must be visible, not implied')
      }
      if (scenario === 'owner-signature-request') {
        check('the statement is editable and the honesty note is present',
          /Statement/.test(m.text) && /not a certified or qualified electronic signature/.test(m.text))
        check('it warns that a new version voids the request',
          /need to ask again/.test(m.text))
      }
      if (scenario === 'portal-documents') {
        check('the customer sees the ask and both documents',
          /needs your signature/.test(m.text) && /Work authorization/.test(m.text)
          && /Completion acknowledgement/.test(m.text))
        check('the signed one names its signer', /Signed by Alexandra/.test(m.text))
      }
      if (scenario === 'portal-sign') {
        check('the signing sheet is on-screen', m.hasDialog && m.dialogBottom <= m.innerH + 1,
          `dialog bottom ${m.dialogBottom} vs viewport ${m.innerH}`)
        check('the statement is shown verbatim above the pad',
          /I authorize the work described in this document to be carried out at my property\./.test(m.text))
        check('it says plainly what is recorded, and claims nothing more',
          /acknowledgement, not a certified electronic signature/.test(m.text))
        check('the pad is present and usable', m.canvasW !== null && m.canvasH >= 120,
          `canvas ${m.canvasW}x${m.canvasH}`)
      }
      if (scenario === 'signature-pad' || scenario === 'portal-sign') {
        // ⭐ THE bug that breaks signature pads on phones: without touch-action
        // none, the browser claims the gesture and the finger scrolls the page.
        check('the pad disables browser touch gestures (touch-action: none)',
          m.canvasTouchAction === 'none', `touch-action is "${m.canvasTouchAction}"`)
        check('the pad is wide enough to sign in', m.canvasW >= 240, `canvas width ${m.canvasW}`)
      }
      if (scenario === 'crew-documents') {
        check('the worker sees a document affordance with its count',
          /Documents/.test(m.text) && /2 documents/.test(m.text))
      }
    }
  }

  console.log('\n── Summary ────────────────────────────────────────────────────')
  if (failures) { console.log(`\nFAIL prove-documents-mobile — ${failures} failure(s)\n`); process.exitCode = 1 }
  else console.log(`\nOK prove-documents-mobile — ${SCENARIOS.length} scenarios clean at 375, 390 and 430\n`)
}

main()
  .catch(e => { console.error('\nERROR ' + (e?.message || e) + '\n'); process.exitCode = 1 })
  .finally(() => { try { ws?.close() } catch {} chrome.kill() })
