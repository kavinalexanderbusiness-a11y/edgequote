// ── The terms-vs-timing send block, through the real bundle ──────────────────
//   node scripts/termsconflict-cdp.mjs <baseUrl> <quoteId> <width>
//
// Signs in with the owner credentials from .env.local (the deposit-owner-cdp
// pattern) and reports the quote page's send card.
//
// ⛔ READ-ONLY against production. It navigates and reads; it never taps Send,
// never edits the terms, never writes a row. The quote it opens is one the LIVE
// measurement already found to be blocked (scripts/terms-conflict-measure.ts),
// so the state being proven is real data, not a fixture.
import { spawn } from 'node:child_process'
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { resolve } from 'node:path'

const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'
const [base, quoteId, wArg] = process.argv.slice(2)
const width = Number(wArg || 390)
const env = Object.fromEntries(
  readFileSync('.env.local', 'utf8').split(/\r?\n/)
    .filter(l => l.includes('=') && !l.startsWith('#'))
    .map(l => [l.slice(0, l.indexOf('=')).trim(), l.slice(l.indexOf('=') + 1).trim()]),
)
const EMAIL = env.PORTAL_RPC_OWNER_EMAIL || env.BACKFILL_OWNER_EMAIL
const PASSWORD = env.PORTAL_RPC_OWNER_PASSWORD || env.BACKFILL_OWNER_PASSWORD
if (!EMAIL || !PASSWORD) { console.error('no owner credentials in .env.local'); process.exit(2) }
try { mkdirSync(resolve('screens'), { recursive: true }) } catch { /* exists */ }

const PORT = 9670 + Number(process.env.CDP_SLOT || 0)
const chrome = spawn(CHROME, [
  '--headless=new', '--disable-gpu', '--no-sandbox', '--hide-scrollbars',
  `--remote-debugging-port=${PORT}`, '--user-data-dir=' + resolve(process.env.TEMP || '.', `eq-terms-${PORT}-${Date.now()}`),
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
const go = async url => { await S('Page.navigate', { url }); await sleep(1500); await S('Emulation.setDeviceMetricsOverride', metrics) }
async function shot(name) {
  const { data } = await S('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true })
  writeFileSync(resolve('screens', `${name}.png`), Buffer.from(data, 'base64'))
  console.log('SHOT: screens/' + name + '.png')
}

await go(base + '/login')
await sleep(2500)
await ev(`(function(){
  var set = function(el, v){
    var proto = Object.getPrototypeOf(el)
    Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, v)
    el.dispatchEvent(new Event('input', { bubbles: true }))
  }
  var em = document.querySelector('input[type=email]')
  var pw = document.querySelector('input[type=password]')
  set(em, ${JSON.stringify(EMAIL)}); set(pw, ${JSON.stringify(PASSWORD)})
  var b = Array.from(document.querySelectorAll('button')).find(function(x){ return /sign in/i.test(x.textContent||'') })
  b.click(); return 'login tapped'
})()`)
await sleep(9000)
// Sign-in has to be CONFIRMED, not assumed. A failed login leaves an empty body
// and every assertion below then reports "absent" — which reads exactly like a
// passing negative control. This caught a whole wrong diagnosis once already:
// a bundle built from a lowercase `c:` cwd rendered nothing at all, and without
// this line it looked like the feature had stopped working.
const landed = await ev('location.pathname')
if (landed === '/login') { console.error('SIGN-IN FAILED — still on /login; aborting rather than reporting absence as success'); process.exit(3) }
console.log('signed in → ' + landed)

await go(base + '/dashboard/quotes/' + quoteId)
await sleep(12000)
console.log(`W=${width} OVERFLOW: ` + await ev(`document.body.scrollWidth + '/' + window.innerWidth + (document.body.scrollWidth > window.innerWidth ? ' ✗ HORIZONTAL SCROLL' : ' ✓')`))
console.log(await ev(`(function(){
  var t = (document.body.innerText||'').replace(/\\s+/g,' ')
  var take = function(re){ var m = t.match(re); return m ? m[0].slice(0,240) : null }
  var btns = Array.from(document.querySelectorAll('button')).map(function(b){ return (b.textContent||'').trim() })
  return JSON.stringify({
    headline: take(/Your Terms & Conditions contradict[^§]{0,80}/),
    quoted: take(/Your terms say:[^§]{0,120}/),
    explanation: take(/This quote requires a deposit[^§]{0,220}/),
    reassurance: take(/Nothing has been changed for you[^§]{0,60}/),
    editDeposit: btns.some(function(b){ return /Edit deposit rule/.test(b) }),
    editTerms: btns.some(function(b){ return /Edit terms/.test(b) }),
    sendButtonGone: !btns.some(function(b){ return /^(Send|Resend) quote$/.test(b) }),
    sendAnyway: btns.some(function(b){ return /send anyway/i.test(b) }),
  }, null, 1)
})()`))
// ⚠️ The page-text dump that stood here was written as a JS double-quoted string
// containing /\s+/g — which JS parses as /s+/g, so it stripped every letter "s"
// from the output ("Payment" → "Payment", but "varieties" → "varietie"). Harmless
// to the assertions above, actively misleading to read. Either escape the
// backslash or use a template literal; the dump is gone because the structured
// assertions above are what this script exists to report.
await shot(`terms-conflict-${width}`)
ws.close(); chrome.kill(); process.exit(0)
