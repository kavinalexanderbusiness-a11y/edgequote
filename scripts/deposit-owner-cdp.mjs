// ── Owner side of deposit-gated scheduling, through the deployed bundle ──────
// Signs in with the owner credentials from .env.local (the pow-cdp pattern),
// then reports the quote page's gate panel and the dashboard queue's rows.
//   node scripts/deposit-owner-cdp.mjs <baseUrl> <quoteId> <width> [dashboard]
import { spawn } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'

const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'
const [base, quoteId, wArg, dash] = process.argv.slice(2)
const width = Number(wArg || 390)
const env = Object.fromEntries(
  readFileSync('.env.local', 'utf8').split(/\r?\n/)
    .filter(l => l.includes('=') && !l.startsWith('#'))
    .map(l => [l.slice(0, l.indexOf('=')).trim(), l.slice(l.indexOf('=') + 1).trim()]),
)
const EMAIL = env.PORTAL_RPC_OWNER_EMAIL || env.BACKFILL_OWNER_EMAIL
const PASSWORD = env.PORTAL_RPC_OWNER_PASSWORD || env.BACKFILL_OWNER_PASSWORD
if (!EMAIL || !PASSWORD) { console.error('no owner credentials in .env.local'); process.exit(2) }

const PORT = 9650 + Number(process.env.CDP_SLOT || 0)
const chrome = spawn(CHROME, [
  '--headless=new', '--disable-gpu', '--no-sandbox', '--hide-scrollbars',
  `--remote-debugging-port=${PORT}`, '--user-data-dir=' + resolve(process.env.TEMP || '.', `eq-own-${PORT}-${Date.now()}`),
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
const metrics = { width, height: 900, deviceScaleFactor: 1, mobile: true, screenWidth: width, screenHeight: 900 }
await S('Emulation.setDeviceMetricsOverride', metrics)
const ev = e => S('Runtime.evaluate', { expression: e, returnByValue: true, awaitPromise: true }).then(r => r.result.value)
const go = async url => { await S('Page.navigate', { url }); await sleep(1500); await S('Emulation.setDeviceMetricsOverride', metrics) }
async function shot(name) {
  const { data } = await S('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true })
  writeFileSync(resolve('screens', `${name}.png`), Buffer.from(data, 'base64'))
  console.log('SHOT: screens/' + name + '.png')
}

// sign in
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
await sleep(6000)
console.log('signed in:', await ev(`location.pathname`))

if (dash === 'dashboard') {
  await go(base + '/dashboard')
  await sleep(7000)
  console.log(await ev(`(function(){
    var t = (document.body.innerText||'').replace(/\\s+/g,' ')
    return JSON.stringify({
      waiting: (t.match(/Waiting on [^·]{0,60}deposit[\\s\\S]{0,120}/)||[''])[0].slice(0,150),
      schedule: (t.match(/Schedule [^ ]{0,30}[\\s\\S]{0,90}/)||[''])[0].slice(0,110),
      overflow: document.body.scrollWidth + '/' + window.innerWidth,
    })
  })()`))
  await shot(`dep-owner-${width}-dashboard`)
} else {
  await go(base + '/dashboard/quotes/' + quoteId)
  await sleep(7000)
  console.log(await ev(`'OVERFLOW: ' + document.body.scrollWidth + '/' + window.innerWidth + (document.body.scrollWidth > window.innerWidth ? ' ✗' : ' ✓')`))
  console.log(await ev(`(function(){
    var t = (document.body.innerText||'').replace(/\\s+/g,' ')
    var take = function(re){ var m = t.match(re); return m ? m[0].slice(0,200) : null }
    return JSON.stringify({
      banner: take(/Accepted — [^§]{0,160}/),
      ready: take(/Ready to schedule[^§]{0,120}/),
      pref: take(/Customer preference:[^§]{0,140}/),
      recordBtn: Array.from(document.querySelectorAll('button')).some(function(b){ return /Record deposit received/.test(b.textContent||'') }),
      overrideBtn: Array.from(document.querySelectorAll('button')).some(function(b){ return /Schedule without deposit/.test(b.textContent||'') }),
      scheduledOwed: take(/Scheduled[^§]{0,120}deposit still owed[^§]{0,80}/),
    })
  })()`))
  await shot(`dep-owner-${width}-quote`)
  // The override path: tap "Schedule without deposit…" and report the confirm copy — then CANCEL.
  console.log(await ev(`(function(){
    var b = Array.from(document.querySelectorAll('button')).find(function(x){ return /Schedule without deposit/.test(x.textContent||'') })
    if (!b) return 'OVERRIDE: no button'
    b.click(); return 'OVERRIDE: tapped'
  })()`))
  await sleep(3500)
  console.log(await ev(`(function(){
    var t = (document.body.innerText||'').replace(/\\s+/g,' ')
    var m = t.match(/Schedule without the required deposit\\?[\\s\\S]{0,320}/)
    return 'CONFIRM-DIALOG: ' + (m ? m[0].slice(0,300) : 'not shown')
  })()`))
  await shot(`dep-owner-${width}-override-confirm`)
  console.log(await ev(`(function(){
    var b = Array.from(document.querySelectorAll('button')).find(function(x){ return /^(Cancel|Keep)/.test((x.textContent||'').trim()) })
    if (!b) return 'CANCEL: no button'
    b.click(); return 'CANCEL: dialog dismissed — nothing scheduled'
  })()`))
}
ws.close(); chrome.kill(); process.exit(0)
