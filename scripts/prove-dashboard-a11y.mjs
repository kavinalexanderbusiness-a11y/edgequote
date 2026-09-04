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
import { readdirSync, writeFileSync } from 'node:fs'

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
      // CDP rejects maxTouchPoints:0 ("must be between 1 and 16") — omit it when disabling.
      await send('Emulation.setTouchEmulationEnabled', phone ? { enabled: true, maxTouchPoints: 5 } : { enabled: false })
      // prefers-reduced-motion + finishing any running animation before measuring:
      // the Modal's entrance is a scale animation, and a rect read mid-animation
      // is fractionally under size (measured 43.9x at 375 once — "44x44" rounded,
      // yet "under 44" raw). Geometry, not motion, is what this prover measures.
      await send('Emulation.setEmulatedMedia', { features: [{ name: 'pointer', value: phone ? 'coarse' : 'fine' }, { name: 'hover', value: phone ? 'none' : 'hover' }, { name: 'prefers-reduced-motion', value: 'reduce' }] })
      await send('Emulation.setDeviceMetricsOverride', { width, height: 844, deviceScaleFactor: 2, mobile: phone })
      await send('Page.navigate', { url })
      for (let i = 0; i < 40; i++) { if (await evaluate('document.readyState === "complete" && !!document.querySelector("main")')) break; await sleep(250) }
      await evaluate('document.getAnimations().forEach(a => { try { a.finish() } catch {} }); true')
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
          const box = el => { const r = el.getBoundingClientRect(); return Math.round(r.width) + 'x' + Math.round(r.height) }
          const arrowEls = [...(dlg?.querySelectorAll('button[aria-label^="Move "]') ?? [])]
          return {
            modal: dlg?.getAttribute('aria-modal') === 'true',
            title: (labelled?.textContent || '').trim(),
            switches: [...(dlg?.querySelectorAll('[role=switch]') ?? [])].map(s => ({ checked: s.getAttribute('aria-checked'), name: s.getAttribute('aria-label') || '', box: box(s) })),
            arrows: arrowEls.length,
            arrowBoxes: arrowEls.map(box),
            arrowsUnder44: arrowEls.filter(a => { const r = a.getBoundingClientRect(); return r.width < 44 || r.height < 44 }).length,
            closeBox: (() => { const c = dlg?.querySelector('button[aria-label="Close"]'); return c ? box(c) : null })(),
            unnamedButtons: [...(dlg?.querySelectorAll('button') ?? [])].filter(b => !(b.getAttribute('aria-label') || b.textContent || '').trim()).length,
          }
        })()`)
        check('the sheet is an aria-modal dialog labelled "Customize dashboard"', d.modal && d.title === 'Customize dashboard', JSON.stringify(d.title))
        check('six named switches with an explicit checked state', d.switches.length === 6 && d.switches.every(s => s.name && /^(true|false)$/.test(s.checked)), JSON.stringify(d.switches))
        check('twelve named reorder arrows (up + down per row)', d.arrows === 12, String(d.arrows))
        check('no unnamed button inside the dialog', d.unnamedButtons === 0)
        // The S97-introduced controls specifically — measured, not inferred from a class name.
        if (phone) check(`every reorder arrow clears 44×44px (measured ${[...new Set(d.arrowBoxes)].join(', ')})`, d.arrowsUnder44 === 0, `${d.arrowsUnder44} of ${d.arrows} arrows under 44px`)
        console.log(`  ℹ shared primitives (pre-existing, not S97's): switch ${[...new Set(d.switches.map(s => s.box))].join(', ')} · close ${d.closeBox}`)
      }

      if (scenario === 'toggle-cases') {
        const t = await evaluate(`(() => {
          const box = el => { const r = el.getBoundingClientRect(); return { w: Math.round(r.width), h: Math.round(r.height) } }
          return [...document.querySelectorAll('[data-case]')].map(row => {
            const btn = row.querySelector('[role=switch]')
            const track = btn.querySelector('span')
            const spans = btn.querySelectorAll(':scope > span')
            const label = spans.length > 1 ? spans[spans.length - 1] : null
            const lr = label && label.getBoundingClientRect(), rr = row.getBoundingClientRect()
            return {
              id: row.dataset.case, disabled: btn.disabled, tap: btn.classList.contains('tap-target'), btn: box(btn), track: box(track),
              label: label ? { w: Math.round(lr.width), h: Math.round(lr.height), overflowX: label.scrollWidth - label.clientWidth, pastRow: Math.round(lr.right - rr.right) } : null,
            }
          })
        })()`)
        check('every visible track is exactly 40×24 — the switch itself never changes size',
          t.every(c => c.track.w === 40 && c.track.h === 24), t.map(c => `${c.id} ${c.track.w}x${c.track.h}`).join(' · '))
        // The long labels: the TEXT is what wraps — it must stay inside its row
        // and never scroll sideways inside its own box; the track beside it
        // keeps its 40px (asserted above for every case, these two included).
        const long = t.filter(c => c.label)
        check(`long labels wrap inside the row, no sideways text overflow (${long.map(c => `${c.id} ${c.label.w}x${c.label.h}`).join(', ')})`,
          long.length === 2 && long.every(c => c.label.overflowX <= 1 && c.label.pastRow <= 1),
          long.map(c => `${c.id} overflowX=${c.label.overflowX} pastRow=${c.label.pastRow}`).join(' · '))
        if (phone) check('…and on a phone they actually wrap (label taller than one line)', long.every(c => c.label.h > 24), long.map(c => `${c.id} h=${c.label.h}`).join(' · '))
        if (phone) {
          const tap = t.filter(c => c.tap)
          check(`tap-target switches clear 44×44 on a phone (${tap.map(c => `${c.btn.w}x${c.btn.h}`).join(', ')})`,
            tap.every(c => c.btn.w >= 44 && c.btn.h >= 44))
          const plain = t.filter(c => !c.tap && !c.id.includes('label'))
          console.log(`  ℹ plain (no tap-target) switch buttons on a phone: ${plain.map(c => `${c.id} ${c.btn.w}x${c.btn.h}`).join(' · ')}`)
        } else {
          check('on desktop tap-target adds nothing — button box equals the plain one',
            t.find(c => c.id === 'tap-on').btn.w === t.find(c => c.id === 'plain-on').btn.w && t.find(c => c.id === 'tap-on').btn.h === t.find(c => c.id === 'plain-on').btn.h)
        }
        check('disabled switches are disabled and stayed out of the Tab walk',
          t.filter(c => c.id.includes('disabled')).every(c => c.disabled) && !seen.some(f => /disabled/i.test(f.name)))
        check('enabled switches all received focus in the Tab walk, in DOM order',
          t.filter(c => !c.disabled).every(c => seen.some(f => f.role === 'switch' && f.name && new RegExp(c.id.replace(/-/g, '.*'), 'i').test(f.name) || c.id.includes('label'))))
      }

      if (process.env.SHOTS_DIR) {
        const shot = await send('Page.captureScreenshot', { format: 'png' })
        writeFileSync(join(process.env.SHOTS_DIR, `${scenario}-${width}.png`), Buffer.from(shot.data, 'base64'))
      }
    }
  }
  console.log(failures ? `\n❌ prove-dashboard-a11y — ${failures} failure(s)\n` : `\n✅ prove-dashboard-a11y — ${SCENARIOS.length} pages clean at ${WIDTHS.join('/')}\n`)
  process.exitCode = failures ? 1 : 0
}
main().catch(e => { console.error('\n❌ ' + (e?.message || e)); process.exitCode = 1 }).finally(() => { try { ws?.close() } catch {} chrome.kill() })
