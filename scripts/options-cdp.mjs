// ── Real-app mobile measurement for the quote-options surfaces ───────────────
// Drives the RUNNING app over the Chrome DevTools Protocol at a genuine phone
// viewport. Two lessons are baked in and neither is optional:
//
//   ⚠️ A STATIC FIXTURE MEASURES THE WRONG SCREEN. The quote-builder pass that
//      "proved" a picker was fine had measured a 4-service fixture while
//      production has 23. This loads the real pages, signed in with the real
//      owner, against the real database.
//
//   ⚠️ THE PAGE NEVER REPORTS SIDEWAYS OVERFLOW. `<main>` is overflow-auto, so
//      document-level scrollWidth is useless — it hid a 501px row inside a 390px
//      viewport. So this measures each option CARD against the viewport, and
//      measures TEXT CLIPPING (scrollWidth > clientWidth) inside it, which is
//      what actually costs the customer the comparison.
//
//   node scripts/options-cdp.mjs <baseUrl> <path> <width> [--shot <file>]
import { spawn } from 'node:child_process'
import { writeFileSync } from 'node:fs'
import { resolve } from 'node:path'

const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'
const [base, path_, wArg, ...rest] = process.argv.slice(2)
const width = Number(wArg || 390)
const shotIdx = rest.indexOf('--shot')
const shotPath = shotIdx >= 0 ? rest[shotIdx + 1] : null
const login = rest.includes('--login')
const PORT = 9333 + Number(process.env.CDP_SLOT || 0)
const profile = resolve(process.env.TEMP || '.', `eq-opt-profile-${PORT}`)

const chrome = spawn(CHROME, [
  '--headless=new', '--disable-gpu', '--no-sandbox', '--hide-scrollbars',
  `--remote-debugging-port=${PORT}`, '--user-data-dir=' + profile,
  'about:blank',
], { stdio: 'ignore' })

const sleep = ms => new Promise(r => setTimeout(r, ms))
async function wsUrl() {
  for (let i = 0; i < 80; i++) {
    try { return (await (await fetch(`http://127.0.0.1:${PORT}/json/version`)).json()).webSocketDebuggerUrl }
    catch { await sleep(250) }
  }
  throw new Error('Chrome never opened its debugging port')
}
const ws = new WebSocket(await wsUrl())
await new Promise(r => ws.addEventListener('open', r, { once: true }))
let id = 0
const pending = new Map()
ws.addEventListener('message', e => {
  const m = JSON.parse(e.data)
  if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id) }
})
const send = (method, params = {}, sessionId) => new Promise((res, rej) => {
  const n = ++id
  pending.set(n, m => m.error ? rej(new Error(method + ': ' + m.error.message)) : res(m.result))
  ws.send(JSON.stringify({ id: n, method, params, sessionId }))
})
const { targetId } = await send('Target.createTarget', { url: 'about:blank' })
const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true })
const S = (m, p) => send(m, p, sessionId)
await S('Page.enable'); await S('Runtime.enable')
const metrics = { width, height: 844, deviceScaleFactor: 1, mobile: true, screenWidth: width, screenHeight: 844 }
await S('Emulation.setDeviceMetricsOverride', metrics)
await S('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 })
const ev = expr => S('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true }).then(r => r.result.value)

if (login) {
  await S('Page.navigate', { url: base + '/login' })
  await sleep(2500)
  await ev(`(async () => {
    const set = (el, v) => {
      const p = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set
      p.call(el, v); el.dispatchEvent(new Event('input', { bubbles: true }))
    }
    const email = document.querySelector('input[type=email]')
    const pass = document.querySelector('input[type=password]')
    if (!email || !pass) return 'no form'
    set(email, ${JSON.stringify(process.env.PORTAL_RPC_OWNER_EMAIL || '')})
    set(pass, ${JSON.stringify(process.env.PORTAL_RPC_OWNER_PASSWORD || '')})
    await new Promise(r => setTimeout(r, 200))
    const btn = [...document.querySelectorAll('button')].find(b => /sign in|log in/i.test(b.textContent||''))
    btn?.click()
    return 'submitted'
  })()`)
  await sleep(6000)
}

await S('Page.navigate', { url: base + path_ })
await sleep(1200)
const clickIdx = rest.indexOf('--click')
const clickText = clickIdx >= 0 ? rest[clickIdx + 1] : null
// Re-apply AFTER navigation — a commit can drop the override, and a viewport
// that silently reverted would report phone numbers taken at desktop width.
await S('Emulation.setDeviceMetricsOverride', metrics)
await sleep(4500)

// Optionally flip a control before measuring — the options editor only exists
// once "Offer multiple options" is on, and measuring the screen without it would
// be measuring the wrong screen (the mistake the quote-builder pass made once).
if (clickText) {
  const r = await ev(`(function(){
    var t = ${JSON.stringify(clickText)}
    var el = Array.from(document.querySelectorAll('button,[role=switch],label,input'))
      .find(function(x){ return (x.textContent||'').includes(t) || (x.getAttribute('aria-label')||'').includes(t) })
    if (!el) return 'not found: ' + t
    el.click(); return 'clicked: ' + t
  })()`)
  console.error(r)
  await sleep(1200)
}

const PROBE = `(function(){
  var VW = window.innerWidth
  function vis(el){
    var r = el.getBoundingClientRect()
    if (!r.width && !r.height) return false
    for (var p = el; p; p = p.parentElement){
      var s = getComputedStyle(p)
      if (s.display==='none'||s.visibility==='hidden'||s.opacity==='0') return false
    }
    return true
  }
  var q = s => Array.from(document.querySelectorAll(s)).filter(vis)
  // The option cards. Identified by CONTENT, not by a test id: whatever markup
  // renders them, a card is the thing holding an option name and a price.
  var cards = q('button,div').filter(function(el){
    var t = (el.textContent||'')
    return /\\\$[\\d,]/.test(t) && /Budget|Standard|Premium|Option/.test(t)
      && el.getBoundingClientRect().width > VW*0.5 && t.length < 400
      && !Array.from(el.querySelectorAll('button,div')).some(function(c){
        var ct=(c.textContent||''); return /\\\$[\\d,]/.test(ct) && /Budget|Standard|Premium/.test(ct) && c.getBoundingClientRect().width > VW*0.5
      })
  })
  // ⚠️ Text that is CLIPPED, not text that overflows the page. scrollWidth >
  // clientWidth on a leaf is a truncated line — the scope sentence that IS the
  // comparison, cut off.
  var clipped = Array.from(document.querySelectorAll('p,span,h1,h2,h3,div,button')).filter(function(el){
    return vis(el) && el.children.length===0 && el.scrollWidth > el.clientWidth + 1 && (el.textContent||'').trim().length>0
  }).map(function(el){ return (el.textContent||'').trim().slice(0,42) + ' [' + el.scrollWidth + '>' + el.clientWidth + ']' })
  // Anything that physically sticks out past the phone's edge.
  var wide = Array.from(document.querySelectorAll('*')).filter(function(el){
    if (!vis(el)) return false
    var r = el.getBoundingClientRect()
    return r.width > VW + 1 || r.right > VW + 1
  }).map(function(el){ var r=el.getBoundingClientRect(); return Math.round(r.width)+'px@'+Math.round(r.right)+' '+el.tagName.toLowerCase()+'.'+String(el.className||'').split(' ')[0] })
  var tapSmall = q('button,[role=button],a[href]').filter(function(b){ var r=b.getBoundingClientRect(); return r.height>0 && r.height<40 })
  var approve = q('button').filter(function(b){ return /approve|choose an option/i.test(b.textContent||'') })
  return JSON.stringify({
    viewport: VW,
    optionCards: cards.length,
    cardWidths: cards.map(function(c){ return Math.round(c.getBoundingClientRect().width) }),
    cardTops: cards.map(function(c){ return Math.round(c.getBoundingClientRect().top + window.scrollY) }),
    cardTexts: cards.map(function(c){ return (c.textContent||'').replace(/\\s+/g,' ').trim().slice(0,90) }),
    approveLabel: approve.map(function(b){ return (b.textContent||'').replace(/\\s+/g,' ').trim() }),
    approveDisabled: approve.map(function(b){ return !!b.disabled }),
    clippedText: clipped.slice(0, 8),
    clippedCount: clipped.length,
    nodesPastEdge: wide.slice(0, 6),
    nodesPastEdgeCount: wide.length,
    tapTargetsUnder40: tapSmall.length,
    scrollHeight: Math.round(document.documentElement.scrollHeight),
    bodyText: (document.body.innerText||'').replace(/\\s+/g,' ').slice(0, 260)
  })
})()`
const out = await ev(PROBE)
console.log(JSON.stringify({ path: path_, width, ...JSON.parse(out) }, null, 1))

if (shotPath) {
  const { data } = await S('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true })
  writeFileSync(shotPath, Buffer.from(data, 'base64'))
  console.error('shot → ' + shotPath)
}
ws.close(); chrome.kill(); process.exit(0)
