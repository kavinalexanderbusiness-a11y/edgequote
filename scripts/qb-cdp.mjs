// ── Real mobile-viewport driver over the Chrome DevTools Protocol ────────────
// Chrome clamps a headless WINDOW to ~500 CSS px on Windows, and a fixed-position
// element measured inside a narrow wrapper reports the WINDOW's width, not the
// phone's — both of which quietly falsify a mobile measurement. CDP's
// Emulation.setDeviceMetricsOverride sets a genuine 390px viewport: media
// queries, `position: fixed`, and layout all behave as they do on the phone.
//
// Node 24 ships a WebSocket, so this needs no dependency.
//
//   node scripts/qb-cdp.mjs <dir> <scenario> <width> [--shot]
import { spawn } from 'node:child_process'
import { writeFileSync, readFileSync } from 'node:fs'
import { resolve, join } from 'node:path'

const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'
const [dir, scenario, wArg, ...rest] = process.argv.slice(2)
const width = Number(wArg || 390)
const shot = rest.includes('--shot')
const PORT = 9222 + (Number(process.env.CDP_SLOT || 0))

const chrome = spawn(CHROME, [
  '--headless=new', '--disable-gpu', '--no-sandbox', '--hide-scrollbars',
  `--remote-debugging-port=${PORT}`, '--user-data-dir=' + resolve(dir, '.chrome-profile'),
  'about:blank',
], { stdio: 'ignore' })

const sleep = ms => new Promise(r => setTimeout(r, ms))
async function wsUrl() {
  for (let i = 0; i < 60; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${PORT}/json/version`)
      return (await r.json()).webSocketDebuggerUrl
    } catch { await sleep(250) }
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

await S('Page.enable')
await S('Runtime.enable')
await S('Emulation.setDeviceMetricsOverride', {
  width, height: 844, deviceScaleFactor: 1, mobile: true,
  screenWidth: width, screenHeight: 844,
})
await S('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 })

const file = 'file:///' + resolve(join(dir, scenario + '.html')).replace(/\\/g, '/')
await S('Page.navigate', { url: file })
await sleep(900)
// Re-apply AFTER navigation: a commit can drop the override, and a viewport that
// silently reverted would report phone numbers taken at desktop width.
await S('Emulation.setDeviceMetricsOverride', {
  width, height: 844, deviceScaleFactor: 1, mobile: true,
  screenWidth: width, screenHeight: 844,
})
await sleep(400)

const PROBE = `(function(){
  var root = document.getElementById('root') || document.body
  function vis(el){
    var r = el.getBoundingClientRect()
    if (!r.width && !r.height) return false
    for (var p = el; p; p = p.parentElement){
      // A control inside a CLOSED <details> is not on screen, and counting it
      // would report the per-line disclosure as having changed nothing.
      if (p.tagName === 'DETAILS' && !p.open && el.closest('summary') !== p.querySelector('summary')) return false
      var s = getComputedStyle(p)
      if (s.display==='none' || s.visibility==='hidden' || s.opacity==='0') return false
    }
    return true
  }
  var q = s => Array.from(document.querySelectorAll(s)).filter(vis)
  var VW = window.innerWidth
  // A "section header" = the disclosure rows this app builds from ui/Collapsible:
  // a full-width button holding a chevron. Counting them counts closed drawers.
  var headers = q('button').filter(b => /w-full/.test(b.className||'') && b.querySelector('svg') && b.getBoundingClientRect().width > VW*0.7)
  var controls = q('input,select,textarea')
  var typed = controls.filter(c => !['hidden','checkbox','radio','button','submit'].includes(c.type))
  var tap = q('button,[role=button],a[href],input[type=checkbox],select').filter(b => { var r=b.getBoundingClientRect(); return r.height>0 && r.height<40 })
  var overflow = Array.from(document.querySelectorAll('*')).filter(el => vis(el) && el.getBoundingClientRect().width > VW + 1)
  // How big is the biggest list the owner has to walk? A native <select> shows
  // ONE row until it is opened and then covers the screen with the rest, so its
  // cost is invisible to a scroll-height measurement — which is exactly how a
  // 23-option dropdown survived a pass that called this screen healthy.
  var selects = q('select')
  var optionCounts = selects.map(s => s.options.length)
  return JSON.stringify({
    viewport: VW,
    selects: selects.length,
    longestSelect: optionCounts.length ? Math.max.apply(null, optionCounts) : 0,
    optionsBehindSelects: optionCounts.reduce((a, b) => a + b, 0),
    comboboxes: q('[role=combobox]').length,
    scrollHeight: Math.round(document.documentElement.scrollHeight),
    screens: +(document.documentElement.scrollHeight/844).toFixed(2),
    visibleTypedFields: typed.length,
    visibleSectionHeaders: headers.length,
    sectionTitles: headers.map(h => (h.textContent||'').trim().replace(/\\s+/g,' ').slice(0,34)),
    visibleButtons: q('button,[role=button]').length,
    tapTargetsUnder40: tap.length,
    nodesWiderThanViewport: overflow.length,
    widest: overflow.slice(0,3).map(el => Math.round(el.getBoundingClientRect().width) + 'px ' + el.tagName.toLowerCase())
  })
})()`

const { result } = await S('Runtime.evaluate', { expression: PROBE, returnByValue: true })
console.log(JSON.stringify({ scenario, ...JSON.parse(result.value) }))

if (shot) {
  const { data } = await S('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true })
  const out = join(dir, `${scenario}.${width}.png`)
  writeFileSync(out, Buffer.from(data, 'base64'))
  console.error('shot → ' + out)
}
ws.close(); chrome.kill(); process.exit(0)
