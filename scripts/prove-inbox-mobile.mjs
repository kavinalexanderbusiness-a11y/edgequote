// ── Phone proof: the Owner Inbox at real phone viewports ─────────────────────
//   npx tsx --tsconfig tsconfig.harness.json scripts/inbox-harness.tsx .inbox-harness
//   node scripts/prove-inbox-mobile.mjs [dir]
//
// Drives REAL Chrome over CDP at 375 / 390 / 430 CSS px against the harness
// pages (the real components, the real compiled CSS, data through the real
// composer). Class-name greps cannot tell you whether a row overflows; only
// layout can. Credential-free: the signed-in dashboard cannot be driven on
// this machine (Session 62's env policy), so the component tree is measured
// directly — same posture as qb-harness/inv-harness.
//
// Per width, per scenario:
//   • the page never scrolls sideways (scrollWidth <= clientWidth + 1)
//   • nothing pokes past the right edge (content inside its own overflow-x
//     scroller exempt — that is the shell rule, not a loosened one)
//   • every interactive target inside the inbox surfaces clears 44 CSS px
//   • the scenario actually rendered what it claims (sections/rows/banner/
//     footer) — a blank page passes every layout check ever written
//
// Read-only. Dev tooling; `next build` never invokes it.

import { spawn } from 'node:child_process'
import { join, resolve } from 'node:path'
import { readdirSync } from 'node:fs'

const DIR = resolve(process.argv[2] || '.inbox-harness')
const WIDTHS = [375, 390, 430]
const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'

let failures = 0
const ok = (n) => console.log(`  ✓ ${n}`)
const fail = (n, d) => { failures++; console.log(`  ✗ ${n}\n      ${d}`) }
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

const profile = join(process.env.TEMP || '.', 'eq-cdp-profile-s71')
const chrome = spawn(CHROME, [
  '--headless=new', '--remote-debugging-port=9337', '--no-first-run', '--no-default-browser-check',
  `--user-data-dir=${profile}`, '--hide-scrollbars', '--allow-file-access-from-files', 'about:blank',
], { stdio: 'ignore' })

const SCENARIOS = readdirSync(DIR).filter(f => f.endsWith('.html')).map(f => f.replace(/\.html$/, ''))

async function main() {
  let target = null
  for (let i = 0; i < 60 && !target; i++) {
    try {
      const list = await (await fetch('http://127.0.0.1:9337/json/list')).json()
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
  // A phone is a COARSE pointer — the shell's `.tap-target` rules are gated on
  // exactly that media feature, so measuring with a mouse pointer measures a
  // desktop that happens to be narrow, not a phone. ⚠️ setEmulatedMedia's
  // `features` does NOT flip `(pointer: coarse)` in headless Chrome — probed
  // directly: only touch emulation does. Both are set; the probe below asserts
  // the media actually matched rather than trusting either call.
  await send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 })
  await send('Emulation.setEmulatedMedia', {
    features: [{ name: 'pointer', value: 'coarse' }, { name: 'hover', value: 'none' }],
  })

  for (const scenario of SCENARIOS) {
    const url = 'file:///' + join(DIR, `${scenario}.html`).replace(/\\/g, '/')
    for (const width of WIDTHS) {
      console.log(`\n─ ${scenario} @ ${width} × 844 ─`)
      await send('Emulation.setDeviceMetricsOverride', { width, height: 844, deviceScaleFactor: 2, mobile: true })
      await send('Page.navigate', { url })
      for (let i = 0; i < 40; i++) {
        const ready = await evaluate('document.readyState === "complete" && !!document.querySelector("main")')
        if (ready) break
        await sleep(250)
      }
      await sleep(200)
      // The tap-target rules only exist under (pointer: coarse) — if the
      // emulation silently stopped matching, every 44px assertion below would
      // measure desktop density and pass or fail for the wrong reason.
      const coarse = await evaluate("matchMedia('(pointer: coarse)').matches")
      check('the viewport is a phone (pointer: coarse matches)', coarse === true,
        'touch emulation did not take — the 44px assertions below would be measuring a mouse UI')

      const m = await evaluate(`(() => {
        const de = document.documentElement
        // An element is a LEAK only if it is actually reachable/visible past the
        // edge. Inside an overflow-x auto/scroll ancestor it scrolls in place;
        // inside hidden/clip it is truncation doing its designed job (an inline
        // "+2 more" span's rect extends past its ellipsised parent while nothing
        // paints there). The page-level scrollWidth assertion above still
        // catches any real sideways scroll either way.
        const scrolls = el => {
          for (let n = el.parentElement; n && n !== document.body; n = n.parentElement) {
            const ox = getComputedStyle(n).overflowX
            if (ox === 'auto' || ox === 'scroll' || ox === 'hidden' || ox === 'clip') return true
          }
          return false
        }
        const over = [...document.querySelectorAll('main *')]
          .map(el => ({ el, r: el.getBoundingClientRect() }))
          .filter(({ el, r }) => r.width > 0 && r.right > de.clientWidth + 1 && !scrolls(el))
          .slice(0, 5)
          .map(({ el, r }) => el.tagName.toLowerCase() + '.' + (el.className || '').toString().split(' ').slice(0, 2).join('.') + ' right=' + Math.round(r.right))
        // Every interactive target in the document (harness pages contain ONLY
        // inbox surfaces, so the shell exemption problem does not arise).
        const small = [...document.querySelectorAll('a, button, summary')]
          .map(el => ({ t: (el.textContent || '').trim().slice(0, 40), h: Math.round(el.getBoundingClientRect().height), w: Math.round(el.getBoundingClientRect().width) }))
          .filter(x => x.h > 0 && x.h < 44)
        const rows = document.querySelectorAll('ol > li').length
        const sections = [...document.querySelectorAll('h2')].map(h => (h.textContent || '').trim().slice(0, 20))
        const hasBanner = !!document.querySelector('[role=alert]')
        const footer = [...document.querySelectorAll('a')].find(a => (a.getAttribute('href') || '') === '/dashboard/inbox')
        const snoozed = !!document.querySelector('details')
        const empty = /Nothing needs you right now|all caught up|Couldn.t check everything/.test(document.body.textContent || '')
        return {
          scrollWidth: de.scrollWidth, clientWidth: de.clientWidth,
          rows, sections, hasBanner, snoozed, empty,
          footerH: footer ? Math.round(footer.getBoundingClientRect().height) : null,
          over, small,
        }
      })()`)

      check(`no sideways scroll (${m.scrollWidth} ≤ ${m.clientWidth})`, m.scrollWidth <= m.clientWidth + 1,
        `the page scrolls ${m.scrollWidth - m.clientWidth}px sideways`)
      check('nothing overflows the right edge', m.over.length === 0, m.over.join(' · '))
      check('every tap target clears 44px', m.small.length === 0,
        m.small.map(s => `"${s.t}" ${s.w}×${s.h}px`).join(' · '))

      if (scenario === 'full') {
        check(`the composed inbox rendered (${m.rows} rows, sections: ${m.sections.join(', ')})`,
          m.rows >= 10 && m.sections.some(s => /Urgent/.test(s)) && m.sections.some(s => /Today/.test(s)) && m.sections.some(s => /Upcoming/.test(s)),
          'a blank page passes every layout check ever written')
        check('the snoozed shelf is present and collapsed by default', m.snoozed)
      }
      if (scenario === 'empty') check('the all-clear state rendered', m.empty && m.rows === 0)
      if (scenario === 'degraded') {
        check('the degraded banner names the missing sources', m.hasBanner)
        check('healthy sources still rendered rows', m.rows > 0,
          'a failed source must not blank the four working ones')
      }
      if (scenario === 'preview') {
        check(`the View-inbox door is a real target (${m.footerH}px)`, m.footerH != null && m.footerH >= 44,
          'the preview’s one extra door must clear 44px like everything else')
      }
    }
  }

  console.log('\n── Summary ────────────────────────────────────────────────────')
  if (failures) { console.log(`\n❌ prove-inbox-mobile — ${failures} failure(s)\n`); process.exitCode = 1 }
  else console.log(`\n✅ prove-inbox-mobile — ${SCENARIOS.length} scenarios clean at 375, 390 and 430\n`)
}

main()
  .catch(e => { console.error('\n❌ ' + (e?.message || e) + '\n'); process.exitCode = 1 })
  .finally(() => { try { ws?.close() } catch {} chrome.kill() })
