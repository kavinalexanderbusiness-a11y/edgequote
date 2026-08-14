// ── Does CHOOSING actually work, on a real phone viewport? ───────────────────
// The measurement pass proves the comparison is readable. This one proves it is
// operable: tap an option, and the Approve button must arm, name that option and
// quote that option's figure. Stops short of approving — a guard must not accept
// a real customer's quote.
//
//   node scripts/options-cdp-pick.mjs <baseUrl> <portalPath> <width>
import { spawn } from 'node:child_process'
import { resolve } from 'node:path'

const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'
const [base, path_, wArg] = process.argv.slice(2)
const width = Number(wArg || 390)
const PORT = 9400 + Number(process.env.CDP_SLOT || 0)
const chrome = spawn(CHROME, [
  '--headless=new', '--disable-gpu', '--no-sandbox', '--hide-scrollbars',
  `--remote-debugging-port=${PORT}`, '--user-data-dir=' + resolve(process.env.TEMP || '.', `eq-pick-${PORT}`),
  'about:blank',
], { stdio: 'ignore' })
const sleep = ms => new Promise(r => setTimeout(r, ms))
async function wsUrl() {
  for (let i = 0; i < 80; i++) {
    try { return (await (await fetch(`http://127.0.0.1:${PORT}/json/version`)).json()).webSocketDebuggerUrl }
    catch { await sleep(250) }
  }
  throw new Error('no debugging port')
}
const ws = new WebSocket(await wsUrl())
await new Promise(r => ws.addEventListener('open', r, { once: true }))
let id = 0; const pending = new Map()
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
await S('Page.navigate', { url: base + path_ })
await sleep(1200)
await S('Emulation.setDeviceMetricsOverride', metrics)
await sleep(5000)
const ev = e => S('Runtime.evaluate', { expression: e, returnByValue: true, awaitPromise: true }).then(r => r.result.value)

const approveState = `(function(){
  var b = Array.from(document.querySelectorAll('button')).find(function(x){ return /approve|choose an option/i.test(x.textContent||'') })
  if (!b) return JSON.stringify({ found: false })
  var r = b.getBoundingClientRect(), cs = getComputedStyle(b)
  return JSON.stringify({
    found: true,
    label: (b.textContent||'').replace(/\\s+/g,' ').trim(),
    disabled: !!b.disabled,
    opacity: cs.opacity,
    cursor: cs.cursor,
    height: Math.round(r.height),
  })
})()`

const before = JSON.parse(await ev(approveState))
// Tap the option named on the command line's third card — Premium, deliberately
// NOT the recommended one, so a pre-selected default could not fake a pass.
const tapped = await ev(`(function(){
  var card = Array.from(document.querySelectorAll('button')).find(function(b){
    return /Premium/.test(b.textContent||'') && /\\$/.test(b.textContent||'')
  })
  if (!card) return 'no Premium card'
  card.click(); return 'clicked'
})()`)
await sleep(600)
const after = JSON.parse(await ev(approveState))
const pressed = await ev(`(function(){
  var cards = Array.from(document.querySelectorAll('button[aria-pressed]'))
  return JSON.stringify(cards.map(function(c){
    return { name: (c.textContent||'').replace(/\\s+/g,' ').trim().slice(0,20), pressed: c.getAttribute('aria-pressed') }
  }))
})()`)
console.log(JSON.stringify({ width, tapped, before, after, cards: JSON.parse(pressed) }, null, 1))
ws.close(); chrome.kill(); process.exit(0)
