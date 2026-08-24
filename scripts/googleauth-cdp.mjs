// ── Measure the sign-in screen on real phone widths ──────────────────────────
// The brief asks that login and signup stay "extremely clean" at 375 / 390 /
// 430 after a second control appears above the password form. That is a
// measurable claim, so this measures it rather than eyeballing a screenshot:
//
//   · the Google button's height (a tap target below 44px fails a thumb)
//   · whether it is reachable WITHOUT scrolling at each width
//   · the password form is still present and still above the fold
//   · sideways overflow, PER ELEMENT
//
// ⚠️ Per element, deliberately. <main> is overflow-auto on this app, so
// document.scrollWidth never reports horizontal overflow — the trap
// fieldmode-cdp.mjs documents. An element wider than the viewport is found by
// comparing its own rect against innerWidth.
//
// ⚠️ A FRESH profile every run: a persistent Chrome profile serves a stale
// bundle and would measure the previous build.
//
//   node scripts/googleauth-cdp.mjs http://127.0.0.1:3155

import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'
const baseUrl = process.argv[2] || 'http://127.0.0.1:3155'
const PORT = 9531
const WIDTHS = [375, 390, 430]
const HEIGHT = 844

const profile = mkdtempSync(join(tmpdir(), 'eq-gauth-'))
const chrome = spawn(CHROME, [
  `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`,
  '--headless=new', '--no-first-run', '--no-default-browser-check',
  '--disable-extensions', 'about:blank',
], { stdio: 'ignore' })

const sleep = ms => new Promise(r => setTimeout(r, ms))
let failures = 0
const bad = (m) => { failures++; console.log(`  ✗ ${m}`) }
const good = (m) => console.log(`  ✓ ${m}`)

async function pageTarget() {
  for (let i = 0; i < 60; i++) {
    try {
      const list = await fetch(`http://127.0.0.1:${PORT}/json/list`).then(r => r.json())
      const t = list.find(x => x.type === 'page' && x.webSocketDebuggerUrl)
      if (t) return t.webSocketDebuggerUrl
    } catch { /* chrome not up yet */ }
    await sleep(250)
  }
  throw new Error('no CDP page target')
}

try {
  const wsUrl = await pageTarget()
  const ws = new WebSocket(wsUrl)
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej })

  let id = 0
  const pending = new Map()
  ws.onmessage = e => {
    const m = JSON.parse(e.data)
    if (m.id && pending.has(m.id)) { pending.get(m.id)(m.result ?? {}); pending.delete(m.id) }
  }
  const send = (method, params = {}) => new Promise(res => {
    const n = ++id
    pending.set(n, res)
    ws.send(JSON.stringify({ id: n, method, params }))
  })

  await send('Page.enable')
  await send('Runtime.enable')

  // What we ask the page, once it has painted.
  const PROBE = `(() => {
    const q = s => document.querySelector(s)
    const g = q('[data-testid="google-auth"]')
    const pw = q('input[type="password"]')
    const email = q('input[type="email"]')
    const r = el => { if (!el) return null; const b = el.getBoundingClientRect()
      return { top: Math.round(b.top), bottom: Math.round(b.bottom), h: Math.round(b.height), w: Math.round(b.width) } }
    // Per-element sideways overflow — but only for elements that can ACTUALLY
    // push the page sideways. An element whose ancestor clips (overflow hidden
    // or clip) is painted inside that box no matter how wide its own layout
    // rect is, so reporting it is a false alarm. This app's login screen is
    // built from exactly that: two 500px decorative orbs deliberately hanging
    // off the edges inside a 'fixed inset-0 overflow-hidden' parent. They are
    // the design, they are pre-existing, and they scroll nothing.
    const clipped = el => {
      for (let p = el.parentElement; p; p = p.parentElement) {
        const s = getComputedStyle(p)
        if (/hidden|clip/.test(s.overflowX) || /hidden|clip/.test(s.overflow)) return true
      }
      return false
    }
    const over = []
    for (const el of document.querySelectorAll('body *')) {
      const b = el.getBoundingClientRect()
      if (b.width > 0 && b.right > window.innerWidth + 1 && !clipped(el)) {
        over.push((el.tagName + '.' + (el.className || '').toString().slice(0, 40)).trim())
      }
    }
    return { vw: window.innerWidth, vh: window.innerHeight,
             google: r(g), pw: r(pw), email: r(email),
             googleText: g ? g.textContent.trim() : null,
             // The independent cross-check: does the document actually scroll?
             docScroll: document.documentElement.scrollWidth > window.innerWidth + 1,
             overflow: over.slice(0, 5) }
  })()`

  for (const path of ['/login', '/signup?invite=eqb_' + 'a'.repeat(64)]) {
    console.log(`\n═══ ${path} ═══`)
    for (const w of WIDTHS) {
      await send('Emulation.setDeviceMetricsOverride',
        { width: w, height: HEIGHT, deviceScaleFactor: 1, mobile: true })
      await send('Page.navigate', { url: baseUrl + path })
      await sleep(2200)
      const { result } = await send('Runtime.evaluate', { expression: PROBE, returnByValue: true })
      const m = result?.value
      if (!m) { bad(`${w}px — page did not answer`); continue }

      const label = `${w}px`
      if (m.overflow.length) bad(`${label} sideways overflow: ${m.overflow.join(', ')}`)
      else if (m.docScroll) bad(`${label} the document scrolls sideways`)
      else good(`${label} no sideways overflow (element scan + document cross-check)`)

      if (path.startsWith('/login')) {
        if (!m.google) { bad(`${label} Google button MISSING`); continue }
        if (m.google.h < 44) bad(`${label} Google tap target ${m.google.h}px < 44px`)
        else good(`${label} Google tap target ${m.google.h}px`)
        if (m.google.bottom > m.vh) bad(`${label} Google button below the fold (${m.google.bottom} > ${m.vh})`)
        else good(`${label} Google reachable without scrolling (bottom ${m.google.bottom}/${m.vh})`)
        if (!m.pw || !m.email) bad(`${label} email/password form missing`)
        else if (m.pw.bottom > m.vh) bad(`${label} password field below the fold (${m.pw.bottom} > ${m.vh})`)
        else good(`${label} password form still above the fold (${m.pw.bottom}/${m.vh})`)
        if (m.googleText && !/Sign in with Google/.test(m.googleText)) bad(`${label} label reads "${m.googleText}"`)
      } else {
        // A bogus invite renders the dead-end card by design — no Google button,
        // and that is the correct answer, not a failure.
        if (m.google) bad(`${label} Google offered on an INVALID invite`)
        else good(`${label} invalid invite offers no Google button (correct)`)
      }
    }
  }
  ws.close()
} finally {
  chrome.kill()
  try { rmSync(profile, { recursive: true, force: true }) } catch { /* best effort */ }
}

console.log(`\n${failures === 0 ? '✅ auth screens: clean at 375/390/430' : `❌ auth screens: ${failures} problem(s)`}`)
process.exit(failures === 0 ? 0 : 1)
