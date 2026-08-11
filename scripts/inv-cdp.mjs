// ── Real-viewport measurement of the invoice detail (investigation tool) ─────
// Chrome clamps a headless WINDOW to ~500 CSS px on Windows, so a "390px"
// measurement taken by resizing a window is not one. CDP's
// Emulation.setDeviceMetricsOverride sets a genuine mobile viewport: media
// queries, flex-wrap and position:fixed all behave as they do on the phone.
//
//   node scripts/inv-cdp.mjs <dir> <scenario> <width> [--shot]
//
// Reports, per scenario/width: the detail card's own height, every visible
// button with its label / vertical position / background (so "how many actions
// look equally important?" is a measurement, not an impression), the money
// figures with their type sizes (the financial hierarchy), and the panels/
// disclosures the owner must scroll past.
import { spawn } from 'node:child_process'
import { writeFileSync } from 'node:fs'
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

const metrics = { width, height: 844, deviceScaleFactor: 1, mobile: width < 700, screenWidth: width, screenHeight: 844 }
await S('Page.enable')
await S('Runtime.enable')
await S('Emulation.setDeviceMetricsOverride', metrics)
await S('Emulation.setTouchEmulationEnabled', { enabled: width < 700, maxTouchPoints: 5 })

const file = 'file:///' + resolve(join(dir, scenario + '.html')).replace(/\\/g, '/')
await S('Page.navigate', { url: file })
await sleep(700)
// Re-apply AFTER navigation: a commit can drop the override, and a viewport that
// silently reverted would report phone numbers taken at desktop width.
await S('Emulation.setDeviceMetricsOverride', metrics)
await sleep(300)

const PROBE = `(function(){
  function vis(el){
    var r = el.getBoundingClientRect()
    if (!r.width && !r.height) return false
    for (var p = el; p; p = p.parentElement){
      var s = getComputedStyle(p)
      if (s.display==='none' || s.visibility==='hidden' || s.opacity==='0') return false
    }
    return true
  }
  var q = s => Array.from(document.querySelectorAll(s)).filter(vis)
  var VW = window.innerWidth
  var card = document.querySelector('#root .rounded-card, #root [class*=rounded-card]')
  var cardBox = card ? card.getBoundingClientRect() : null
  var text = el => (el.textContent||'').trim().replace(/\\s+/g,' ')

  // Every visible button, with what it says, where it sits and how loud it looks.
  // Background colour is the honest measure of "equally prominent": two buttons
  // painted the same accent are two primaries, whatever the markup intended.
  var buttons = q('button,[role=button]').map(b => {
    var r = b.getBoundingClientRect(), cs = getComputedStyle(b)
    return {
      label: text(b).slice(0,38) || (b.getAttribute('aria-label')||'').slice(0,38),
      top: Math.round(r.top + window.scrollY), h: Math.round(r.height), w: Math.round(r.width),
      bg: cs.backgroundColor, border: cs.borderTopWidth !== '0px',
    }
  })
  var accent = buttons.filter(b => {
    var m = b.bg.match(/rgba?\\(([^)]+)\\)/); if (!m) return false
    var p = m[1].split(',').map(Number)
    if (p.length > 3 && p[3] < 0.5) return false
    // The accent fill is a saturated colour; surfaces/ghosts are near-black greys.
    return Math.max(p[0],p[1],p[2]) - Math.min(p[0],p[1],p[2]) > 40
  })

  // The money hierarchy: every tabular figure at 15px or more, biggest first.
  var figures = q('[class*=tabular-nums], .tabular-nums').filter(el => {
    var fs = parseFloat(getComputedStyle(el).fontSize)
    return fs >= 15 && /[0-9]/.test(text(el)) && el.children.length === 0
  }).map(el => ({ t: text(el).slice(0,22), px: Math.round(parseFloat(getComputedStyle(el).fontSize)),
                  weight: getComputedStyle(el).fontWeight, top: Math.round(el.getBoundingClientRect().top + window.scrollY) }))
    .sort((a,b) => b.px - a.px)

  // Bordered boxes inside the card = the panels an owner reads past.
  var panels = q('#root div').filter(el => {
    var cs = getComputedStyle(el), r = el.getBoundingClientRect()
    return parseFloat(cs.borderTopWidth) > 0 && parseFloat(cs.borderTopLeftRadius) > 0
      && r.height > 36 && el !== card && card && card.contains(el)
  }).map(el => ({ h: Math.round(el.getBoundingClientRect().height), label: text(el).slice(0,30) }))

  // Disclosure rows (ui/Collapsible) — EXACTLY: a button that reports expanded
  // state and is not a menu trigger. Matching on "wide button with an icon"
  // instead counted the full-width primary action and both menu triggers as
  // disclosures, which would have credited this pass with sections it never made.
  var headerEls = q('button[aria-expanded]').filter(b => !b.hasAttribute('aria-haspopup'))
  var headers = headerEls.map(b => text(b).slice(0,40))

  var overflow = Array.from(document.querySelectorAll('*')).filter(el => vis(el) && el.getBoundingClientRect().width > VW + 1)
  var tap = q('button,[role=button],a[href],select').filter(b => { var r=b.getBoundingClientRect(); return r.height>0 && r.height<40 })

  return JSON.stringify({
    viewport: VW,
    cardHeight: cardBox ? Math.round(cardBox.height) : null,
    scrollHeight: Math.round(document.documentElement.scrollHeight),
    buttons: buttons.length,
    // Things you can ACT with, i.e. excluding the disclosure rows that only
    // reveal what is already summarised on them.
    actionButtons: buttons.length - headerEls.length,
    accentButtons: accent.length,
    buttonList: buttons.map(b => b.label + '@' + b.top + (b.h < 40 ? '(' + b.h + 'px)' : '')),
    figures: figures.slice(0,6),
    panels: panels.length,
    panelList: panels.map(p => p.h + 'px ' + p.label),
    disclosures: headers,
    tapTargetsUnder40: tap.length,
    nodesWiderThanViewport: overflow.length,
    widest: overflow.slice(0,3).map(el => Math.round(el.getBoundingClientRect().width) + 'px ' + el.tagName.toLowerCase()),
  })
})()`

const { result } = await S('Runtime.evaluate', { expression: PROBE, returnByValue: true })
console.log(JSON.stringify({ scenario, w: width, ...JSON.parse(result.value) }))

if (shot) {
  const { data } = await S('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true })
  const out = join(dir, `${scenario}.${width}.png`)
  writeFileSync(out, Buffer.from(data, 'base64'))
  console.error('shot → ' + out)
}
ws.close(); chrome.kill(); process.exit(0)
