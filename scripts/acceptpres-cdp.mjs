// ── The customer portal must not claim an acceptance it cannot prove ─────────
//   node scripts/acceptpres-cdp.mjs <baseUrl> <portalToken> <width>
//
// Opens the CUSTOMER's own portal (token-scoped, no login) and reports what the
// page says about acceptance and money. ⛔ READ-ONLY: it navigates and reads,
// never taps Accept, never pays, never writes a row.
//
// The subject is EPS-2026-0152's customer, live: status=accepted,
// accepted_price=1400, current total=500, quote_acceptances=0.
import { spawn } from 'node:child_process'
import { writeFileSync, mkdirSync } from 'node:fs'
import { resolve } from 'node:path'

const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'
const [base, token, wArg] = process.argv.slice(2)
const width = Number(wArg || 390)
try { mkdirSync(resolve('screens'), { recursive: true }) } catch { /* exists */ }

const PORT = 9690 + Number(process.env.CDP_SLOT || 0)
const chrome = spawn(CHROME, [
  '--headless=new', '--disable-gpu', '--no-sandbox', '--hide-scrollbars',
  `--remote-debugging-port=${PORT}`, '--user-data-dir=' + resolve(process.env.TEMP || '.', `eq-ap-${PORT}-${Date.now()}`),
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
const mobile = width < 900
const metrics = { width, height: 900, deviceScaleFactor: 1, mobile, screenWidth: width, screenHeight: 900 }
await S('Emulation.setDeviceMetricsOverride', metrics)
// ⚠️ pointer:coarse comes from setTouchEmulationEnabled, NOT setEmulatedMedia.
if (mobile) await S('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 })
const ev = e => S('Runtime.evaluate', { expression: e, returnByValue: true, awaitPromise: true }).then(r => r.result.value)

await S('Page.navigate', { url: `${base}/portal/${token}` })
await sleep(1500)
await S('Emulation.setDeviceMetricsOverride', metrics)
await sleep(11000)
// Move to Billing, where the quote ROW (amount + amountNote) lives. Home shows
// the deposit banner only, so a Home-only probe would miss the headline figure.
await ev("(function(){var b=Array.from(document.querySelectorAll(String.fromCharCode(98,117,116,116,111,110)));var t=b.find(function(x){return /Billing/i.test(x.textContent||String())});if(t){t.click();return 1}return 0})()")
await sleep(4000)

// A blank page must never read as "the claim is absent" — that is a passing
// negative control invented by a failed load.
const len = await ev("(document.body.innerText||'').trim().length")
if (!len || len < 200) { console.error(`PAGE DID NOT RENDER (${len} chars) — aborting rather than reporting absence as success`); process.exit(3) }

console.log(`W=${width} OVERFLOW: ` + await ev("document.body.scrollWidth + '/' + window.innerWidth + (document.body.scrollWidth > window.innerWidth ? ' ✗ HORIZONTAL SCROLL' : ' ✓')"))
console.log(await ev(`(function(){
  var t = (document.body.innerText || '').replace(/\\s+/g, ' ')
  return JSON.stringify({
    saysYouAccepted:      /you accepted/i.test(t),
    saysPriceYouAccepted: /price you accepted/i.test(t),
    saysAcceptedVersion:  /accepted version/i.test(t),
    saysNoRecordOnFile:   /don.t have a record of your acceptance/i.test(t),
    showsStale1400:       /1,400/.test(t),
    showsCurrent500:      /500/.test(t),
    showsStaleDeposit700: /700/.test(t),
    showsHonestDeposit250:/250/.test(t)
  }, null, 1)
})()`))
const { data } = await S('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true })
writeFileSync(resolve('screens', `accept-presentation-${width}.png`), Buffer.from(data, 'base64'))
console.log('SHOT: screens/accept-presentation-' + width + '.png')
ws.close(); chrome.kill(); process.exit(0)
