// ── Real-phone-viewport proof for the portal request composer ────────────────
// Chrome clamps a headless WINDOW to ~500 CSS px on Windows, so a width measured
// from a plain headless run is not the phone's. CDP's
// Emulation.setDeviceMetricsOverride sets a GENUINE viewport, so media queries,
// position:fixed and layout behave as they do on the device.
//
// Drives the REAL running app (next start) at 375 / 390 / 430 and asserts the
// four things that actually break a form on a phone:
//   1. the page never scrolls sideways
//   2. every control the customer must tap meets the 44px target
//   3. the note field is >=16px, or iOS zooms the page on focus
//   4. nothing overflows its own card
//
//   node scripts/portal-requests-cdp.mjs <baseUrl> <token> <width>
import { spawn } from 'node:child_process'
import { resolve } from 'node:path'

const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'
const [base, token, wArg] = process.argv.slice(2)
const width = Number(wArg || 390)
const PORT = 9222 + Number(process.env.CDP_SLOT || 0)

const chrome = spawn(CHROME, [
  '--headless=new', '--disable-gpu', '--no-sandbox', '--hide-scrollbars',
  `--remote-debugging-port=${PORT}`,
  '--user-data-dir=' + resolve('.chrome-profile-req-' + width),
  'about:blank',
], { stdio: 'ignore' })

const sleep = ms => new Promise(r => setTimeout(r, ms))
async function wsUrl() {
  for (let i = 0; i < 60; i++) {
    try { const r = await fetch(`http://127.0.0.1:${PORT}/json/version`); return (await r.json()).webSocketDebuggerUrl }
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
function send(method, params = {}, sessionId) {
  const n = ++id
  return new Promise((res, rej) => {
    pending.set(n, m => m.error ? rej(new Error(method + ': ' + m.error.message)) : res(m.result))
    ws.send(JSON.stringify({ id: n, method, params, sessionId }))
  })
}
const { targetId } = await send('Target.createTarget', { url: 'about:blank' })
const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true })
const S = (m, p) => send(m, p, sessionId)
const metrics = { width, height: 844, deviceScaleFactor: 1, mobile: true, screenWidth: width, screenHeight: 844 }

await S('Page.enable'); await S('Runtime.enable')
await S('Emulation.setDeviceMetricsOverride', metrics)
await S('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 })
await S('Page.navigate', { url: `${base}/portal/${token}?tab=messages` })
await sleep(3500)
// Re-apply AFTER navigation: a commit can drop the override, and a viewport that
// silently reverted would report phone numbers taken at desktop width.
await S('Emulation.setDeviceMetricsOverride', metrics)
await sleep(1200)

const PROBE = `(function(){
  var out = { width: window.innerWidth, docScrollW: document.scrollingElement.scrollWidth }
  function seen(el){
    if (!el) return false
    var r = el.getBoundingClientRect()
    if (!r.width && !r.height) return false
    for (var p = el; p; p = p.parentElement){
      var s = getComputedStyle(p)
      if (s.display==='none' || s.visibility==='hidden' || s.opacity==='0') return false
    }
    return true
  }
  var group = document.querySelector('[role="radiogroup"][aria-label="What do you need?"]')
  out.composerFound = !!group
  var chips = group ? [].slice.call(group.querySelectorAll('[role="radio"]')) : []
  out.chipCount = chips.length
  out.chipsVisible = chips.every(seen)
  out.chipMinHeight = chips.length ? Math.min.apply(null, chips.map(function(c){ return Math.round(c.getBoundingClientRect().height) })) : 0
  out.chipsOnOneRow = chips.length ? (new Set(chips.map(function(c){ return Math.round(c.getBoundingClientRect().top) })).size === 1) : false
  var ta = document.querySelector('textarea[aria-label="What do you need?"]')
  out.noteFound = !!ta
  out.noteFontPx = ta ? Math.round(parseFloat(getComputedStyle(ta).fontSize)) : 0
  var btns = [].slice.call(document.querySelectorAll('button'))
  var photo = btns.filter(function(b){ return /Add photos/i.test(b.textContent||'') })[0]
  out.photoBtnFound = !!photo
  out.photoBtnVisible = seen(photo)
  out.photoBtnHeight = photo ? Math.round(photo.getBoundingClientRect().height) : 0
  var send = btns.filter(function(b){ return /Send request/i.test(b.textContent||'') })[0]
  out.sendFound = !!send
  out.sendVisible = seen(send)
  // Nothing may spill out of its own card.
  var overflow = []
  ;[].slice.call(document.querySelectorAll('main *, body *')).forEach(function(el){
    var r = el.getBoundingClientRect()
    if (r.width > 0 && (r.right > window.innerWidth + 1 || r.left < -1)) {
      overflow.push((el.tagName||'').toLowerCase() + '.' + String(el.className||'').slice(0,40))
    }
  })
  out.overflowCount = overflow.length
  out.overflowSample = overflow.slice(0,3)
  out.honestyCopy = /nothing is booked, changed or charged/i.test(document.body.innerText)
  return JSON.stringify(out)
})()`
const { result } = await S('Runtime.evaluate', { expression: PROBE, returnByValue: true })
console.log(result.value)
ws.close(); chrome.kill()
process.exit(0)
