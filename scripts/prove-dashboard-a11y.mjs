// ── Keyboard + phone proof for the dashboard fixture ─────────────────────────
//   CSS_DIR=<...>/.next/static/css npx tsx --tsconfig tsconfig.harness.json scripts/dashboard-a11y-harness.tsx
//   node scripts/prove-dashboard-a11y.mjs [.dashboard-a11y]
//
// Drives real headless Chrome over CDP against the static fixture pages at
// 375 / 390 / 430 (touch emulated, asserted) and 1280 (mouse). Per page/width:
//   • no sideways scroll; nothing pokes past the right edge
//   • (phone widths) every link/button clears 44 CSS px
//   • KEYBOARD: Tab walks the page; every element that receives focus is a
//     link, a button or a switch, has a non-empty accessible name, is not
//     inside an aria-hidden subtree, and shows a focus indicator (ring or
//     outline) — the :focus-visible styles fire because focus is keyboard-driven
//   • customize-open: the sheet is a labelled aria-modal dialog whose six rows
//     each expose a named switch and two named arrow buttons
// Not provable from static markup (read from Modal.tsx source instead): focus
// trap wrap-around, Escape-to-close, focus restore, initial focus on open.
// Read-only dev tooling; `next build` never invokes it.

import { spawn } from 'node:child_process'
import { join, resolve } from 'node:path'
import { readdirSync } from 'node:fs'

const DIR = resolve(process.argv[2] || '.dashboard-a11y')
const WIDTHS = [375, 390, 430, 1280]
const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'
let failures = 0
const ok = n => console.log(`  ✓ ${n}`)
const fail = (n, d = '') => { failures++; console.log(`  ✗ ${n}${d ? `\n      ${d}` : ''}`) }
const check = (n, c, d = '') => (c ? ok(n) : fail(n, d))
const sleep = ms => new Promise(r => setTimeout(r, ms))

let ws, nextId = 1
const pending = new Map()
const send = (method, params = {}) => new Promise((res, rej) => { const id = nextId++; pending.set(id, { res, rej }); ws.send(JSON.stringify({ id, method, params })) })
async function evaluate(expression) {
  const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || 'eval threw')
  return r.result.value
}
const tab = async () => {
  await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9 })
  await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9 })
}

const profile = join(process.env.TEMP || '.', 'eq-cdp-profile-s97-a11y')
const chrome = spawn(CHROME, ['--headless=new', '--remote-debugging-port=9341', '--no-first-run', '--no-default-browser-check',
  `--user-data-dir=${profile}`, '--hide-scrollbars', '--allow-file-access-from-files', 'about:blank'], { stdio: 'ignore' })
const SCENARIOS = readdirSync(DIR).filter(f => f.endsWith('.html')).map(f => f.replace(/\.html$/, ''))

const FOCUSED = `(() => {
  const el = document.activeElement
  if (!el || el === document.body) return null
  const cs = getComputedStyle(el)
  const name = (el.getAttribute('aria-label') || el.getAttribute('title') || el.textContent || '').trim().replace(/\\s+/g, ' ')
  const r = el.getBoundingClientRect()
  return {
    tag: el.tagName.toLowerCase(), role: el.getAttribute('role'), name: name.slice(0, 60),
    hidden: !!el.closest('[aria-hidden="true"]'),
    ring: cs.boxShadow !== 'none' || cs.outlineStyle !== 'none',
    w: Math.round(r.width), h: Math.round(r.height),
  }
})()`

async function main() {
  let target = null
  for (let i = 0; i < 60 && !target; i++) {
    try { target = (await (await fetch('http://127.0.0.1:9341/json/list')).json()).find(t => t.type === 'page') } catch {}
    if (!target) await sleep(250)
  }
  if (!target) throw new Error('Chrome never opened its debugging port')
  ws = new WebSocket(target.webSocketDebuggerUrl)
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = () => rej(new Error('CDP socket failed')) })
  ws.onmessage = ev => { const m = JSON.parse(ev.data); if (m.id && pending.has(m.id)) { const p = pending.get(m.id); pending.delete(m.id); m.error ? p.rej(new Error(m.error.message)) : p.res(m.result) } }
  await send('Page.enable'); await send('Runtime.enable')

  for (const scenario of SCENARIOS) {
    const url = 'file:///' + join(DIR, `${scenario}.html`).replace(/\\/g, '/')
    for (const width of WIDTHS) {
      const phone = width < 1000
      console.log(`\n─ ${scenario} @ ${width} ─`)
      await send('Emulation.setTouchEmulationEnabled', { enabled: phone, maxTouchPoints: phone ? 5 : 0 })
      await send('Emulation.setEmulatedMedia', { features: [{ name: 'pointer', value: phone ? 'coarse' : 'fine' }, { name: 'hover', value: phone ? 'none' : 'hover' }] })
      await send('Emulation.setDeviceMetricsOverride', { width, height: 844, deviceScaleFactor: 2, mobile: phone })
      await send('Page.navigate', { url })
      for (let i = 0; i < 40; i++) { if (await evaluate('document.readyState === "complete" && !!document.querySelector("main")')) break; await sleep(250) }
      await sleep(150)
      if (phone) check('the viewport is a phone (pointer: coarse matches)', await evaluate("matchMedia('(pointer: coarse)').matches") === true)

      const m = await evaluate(`(() => {
        const de = document.documentElement
        const scrolls = el => { for (let n = el.parentElement; n && n !== document.body; n = n.parentElement) { const ox = getComputedStyle(n).overflowX; if (/auto|scroll|hidden|clip/.test(ox)) return true } return false }
        const over = [...document.querySelectorAll('main *')].map(el => ({ el, r: el.getBoundingClientRect() }))
          .filter(({ el, r }) => r.width > 0 && r.right > de.clientWidth + 1 && !scrolls(el)).slice(0, 5)
          .map(({ el, r }) => el.tagName.toLowerCase() + ' right=' + Math.round(r.right))
        const small = [...document.querySelectorAll('a, button')].filter(el => el.offsetParent !== null)
          .map(el => ({ t: (el.getAttribute('aria-label') || el.textContent || '').trim().slice(0, 30), h: Math.round(el.getBoundingClientRect().height), w: Math.round(el.getBoundingClientRect().width) }))
          .filter(x => x.h > 0 && (x.h < 44 || x.w < 44))
        const focusables = [...document.querySelectorAll('a[href], button:not([disabled]), [role=switch]:not([disabled])')].filter(el => el.offsetParent !== null).length
        return { scrollWidth: de.scrollWidth, clientWidth: de.clientWidth, over, small, focusables }
      })()`)
      check(`no sideways scroll (${m.scrollWidth} ≤ ${m.clientWidth})`, m.scrollWidth <= m.clientWidth + 1)
      check('nothing overflows the right edge', m.over.length === 0, m.over.join(' · '))
      if (phone) check('every visible link/button clears 44×44px', m.small.length === 0, m.small.map(s => `"${s.t}" ${s.w}×${s.h}`).join(' · '))

      // Keyboard walk — one Tab past the visible focusable count catches a trap.
      const seen = []
      for (let i = 0; i < m.focusables + 1; i++) { await tab(); const f = await evaluate(FOCUSED); if (!f) break; seen.push(f) }
      check(`Tab reaches every visible control (${seen.length}/${m.focusables})`, seen.length >= m.focusables,
        `focus stopped after: ${seen.slice(-1)[0]?.name ?? '(nothing)'}`)
      const bad = seen.filter(f => !(f.tag === 'a' || f.tag === 'button' || f.role === 'switch'))
      check('everything focused is a link, button or switch', bad.length === 0, bad.map(f => f.tag).join(' · '))
      const unnamed = seen.filter(f => !f.name)
      check('every focused control has an accessible name', unnamed.length === 0, `${unnamed.length} unnamed`)
      check('focus never lands inside an aria-hidden subtree', seen.every(f => !f.hidden))
      const noRing = seen.filter(f => !f.ring)
      check('every focused control shows a focus indicator', noRing.length === 0, noRing.map(f => `"${f.name}"`).join(' · '))

      if (scenario === 'customize-open') {
        const d = await evaluate(`(() => {
          const dlg = document.querySelector('[role=dialog]')
          const labelled = dlg && document.getElementById(dlg.getAttribute('aria-labelledby') || '')
          return {
            modal: dlg?.getAttribute('aria-modal') === 'true',
            title: (labelled?.textContent || '').trim(),
            switches: [...(dlg?.querySelectorAll('[role=switch]') ?? [])].map(s => ({ checked: s.getAttribute('aria-checked'), name: s.getAttribute('aria-label') || '' })),
            arrows: [...(dlg?.querySelectorAll('button[aria-label^="Move "]') ?? [])].length,
            unnamedButtons: [...(dlg?.querySelectorAll('button') ?? [])].filter(b => !(b.getAttribute('aria-label') || b.textContent || '').trim()).length,
          }
        })()`)
        check('the sheet is an aria-modal dialog labelled "Customize dashboard"', d.modal && d.title === 'Customize dashboard', JSON.stringify(d.title))
        check('six named switches with an explicit checked state', d.switches.length === 6 && d.switches.every(s => s.name && /^(true|false)$/.test(s.checked)), JSON.stringify(d.switches))
        check('twelve named reorder arrows (up + down per row)', d.arrows === 12, String(d.arrows))
        check('no unnamed button inside the dialog', d.unnamedButtons === 0)
      }
    }
  }
  console.log(failures ? `\n❌ prove-dashboard-a11y — ${failures} failure(s)\n` : `\n✅ prove-dashboard-a11y — ${SCENARIOS.length} pages clean at ${WIDTHS.join('/')}\n`)
  process.exitCode = failures ? 1 : 0
}
main().catch(e => { console.error('\n❌ ' + (e?.message || e)); process.exitCode = 1 }).finally(() => { try { ws?.close() } catch {} chrome.kill() })
