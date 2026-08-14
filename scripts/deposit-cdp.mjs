// ── Deposit-gated scheduling: the real portal flow, on a real phone viewport ──
// Drives the DEPLOYED bundle over CDP against a fixture quote (ZZ-VERIFY-DEP-36):
// pick an option → approve (dialog must name the deposit) → deposit-required
// state → preferred-timing form → save → reload persists. Ledger states between
// steps are injected by the caller (SQL), so no Stripe object is ever created.
//
//   node scripts/deposit-cdp.mjs <baseUrl> <portalPath> <mode> <width> [shotName]
// modes: shot (screenshot only) · approve (full approve+preference flow) · state (report gate copy)
import { spawn } from 'node:child_process'
import { writeFileSync } from 'node:fs'
import { resolve } from 'node:path'

const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'
const [base, path_, mode, wArg, shotName] = process.argv.slice(2)
const width = Number(wArg || 390)
const PORT = 9600 + Number(process.env.CDP_SLOT || 0)
// FRESH profile per run — a persistent one serves a stale bundle (the
// portal-money-honesty lesson).
const profile = resolve(process.env.TEMP || '.', `eq-dep-${PORT}-${Date.now()}`)
const chrome = spawn(CHROME, [
  '--headless=new', '--disable-gpu', '--no-sandbox', '--hide-scrollbars',
  `--remote-debugging-port=${PORT}`, '--user-data-dir=' + profile, 'about:blank',
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
await S('Page.navigate', { url: base + path_ })
await sleep(1500)
await S('Emulation.setDeviceMetricsOverride', metrics)
await sleep(4500)
const ev = e => S('Runtime.evaluate', { expression: e, returnByValue: true, awaitPromise: true }).then(r => r.result.value)

async function shot(name) {
  const { data } = await S('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true })
  const p = resolve('screens', `${name}.png`)
  writeFileSync(p, Buffer.from(data, 'base64'))
  console.log('SHOT: ' + p)
}
// Every mode reports sideways overflow — the one layout failure a screenshot hides.
console.log(await ev(`'OVERFLOW: body=' + document.body.scrollWidth + ' viewport=' + window.innerWidth + (document.body.scrollWidth > window.innerWidth ? ' ✗ SIDEWAYS' : ' ✓')`))

if (mode === 'shot') {
  await shot(shotName || `dep-${width}`)
}

if (mode === 'state') {
  console.log(await ev(`(function(){
    var t = (document.body.innerText||'').replace(/\\s+/g,' ')
    var take = function(re){ var m = t.match(re); return m ? m[0].slice(0,180) : null }
    return JSON.stringify({
      approvedPill: /Approved/.test(t),
      depositAsk: take(/\\$[\\d,.]+ deposit to secure scheduling/),
      partial: take(/\\$[\\d,.]+ of \\$[\\d,.]+ received[^.]*/),
      received: take(/Deposit received[^.]*/),
      ready: /Ready to schedule/.test(t),
      requestNotBooking: /request, not a booking/i.test(t),
      confirmFinal: /confirm the final date/i.test(t),
      scheduledWord: /Scheduled/.test(t),
      preference: take(/Your preferred timing[\\s\\S]{0,120}/),
      payButton: Array.from(document.querySelectorAll('button')).some(function(b){ return /^Pay \\$[\\d,.]+ deposit/.test((b.textContent||'').trim()) }),
    })
  })()`))
  if (shotName) await shot(shotName)
}

if (mode === 'approve') {
  // 1. pick Recommended
  console.log(await ev(`(function(){
    var card = Array.from(document.querySelectorAll('button[aria-pressed]')).find(function(b){ return (b.textContent||'').indexOf('Recommended') === 0 })
    if (!card) return 'PICK: no Recommended card'
    card.click(); return 'PICK: Recommended'
  })()`))
  await sleep(700)
  // 2. approve
  console.log(await ev(`(function(){
    var b = Array.from(document.querySelectorAll('button')).find(function(x){ return /^Approve /.test((x.textContent||'').trim()) && !x.disabled })
    if (!b) return 'APPROVE: no armed button'
    b.click(); return 'APPROVE: tapped ' + (b.textContent||'').trim()
  })()`))
  await sleep(5000)
  // 3. the dialog MUST name the deposit that comes next
  console.log(await ev(`(function(){
    var t = (document.body.innerText||'').replace(/\\s+/g,' ')
    var m = t.match(/You're approving[\\s\\S]{0,320}/)
    return 'DIALOG: ' + (m ? m[0].slice(0,300) : 'not found')
  })()`))
  await shot(`dep-${width}-dialog`)
  console.log(await ev(`(function(){
    var btns = Array.from(document.querySelectorAll('button')).reverse()
    var b = btns.find(function(x){ return /^Approve /.test((x.textContent||'').trim()) })
    if (!b) return 'CONFIRM: no dialog approve'
    b.click(); return 'CONFIRM: tapped'
  })()`))
  await sleep(6500)
  await shot(`dep-${width}-after-approve`)
  console.log(await ev(`(function(){
    var t = (document.body.innerText||'').replace(/\\s+/g,' ')
    var m = t.match(/Next step:[^!]{0,160}/)
    var ask = t.match(/\\$[\\d,.]+ deposit to secure scheduling/)
    return 'AFTER: banner=' + (m ? m[0].slice(0,150) : 'none') + ' | ask=' + (ask ? ask[0] : 'none')
  })()`))
  // 4. preferred timing — fill and save through the real form
  console.log(await ev(`(function(){
    var dates = Array.from(document.querySelectorAll('input[type=date]'))
    if (dates.length < 2) return 'PREF: date inputs not found (' + dates.length + ')'
    var set = function(el, v){
      var proto = Object.getPrototypeOf(el)
      Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, v)
      el.dispatchEvent(new Event('input', { bubbles: true }))
      el.dispatchEvent(new Event('change', { bubbles: true }))
    }
    var d1 = new Date(Date.now() + 7 * 86400000), d2 = new Date(Date.now() + 9 * 86400000)
    var iso = function(d){ return d.toISOString().slice(0,10) }
    set(dates[0], iso(d1)); set(dates[1], iso(d2))
    var aft = Array.from(document.querySelectorAll('button[role=radio]')).find(function(b){ return (b.textContent||'').trim() === 'Afternoon' })
    if (aft) aft.click()
    var note = document.querySelector('textarea[placeholder*="weekday"]')
    if (note) set(note, 'Gate code 4411 — dog is friendly')
    return 'PREF: filled ' + iso(d1) + ' / ' + iso(d2) + ' afternoon'
  })()`))
  await sleep(600)
  console.log(await ev(`(function(){
    var b = Array.from(document.querySelectorAll('button')).find(function(x){ return /Save preference/.test((x.textContent||'').trim()) })
    if (!b) return 'PREF-SAVE: no button'
    b.click(); return 'PREF-SAVE: tapped'
  })()`))
  await sleep(5000)
  await shot(`dep-${width}-pref-saved`)
  console.log(await ev(`(function(){
    var t = (document.body.innerText||'').replace(/\\s+/g,' ')
    return 'PREF-AFTER: ' + JSON.stringify({
      saved: /Saved/.test(t),
      summary: (t.match(/Your preferred timing[\\s\\S]{0,140}/)||[''])[0].slice(0,130),
      requestNotBooking: /request, not a booking/i.test(t),
    })
  })()`))
  // 5. reload — persistence is the payload's, not local state's
  await S('Page.navigate', { url: base + path_ })
  await sleep(6000)
  console.log(await ev(`(function(){
    var t = (document.body.innerText||'').replace(/\\s+/g,' ')
    return 'RELOAD: ' + JSON.stringify({
      approved: /Approved/.test(t),
      ask: (t.match(/\\$[\\d,.]+ deposit to secure scheduling/)||[''])[0],
      prefKept: (t.match(/Your preferred timing[\\s\\S]{0,120}/)||[''])[0].slice(0,110),
      note: /Gate code 4411/.test(t),
    })
  })()`))
  await shot(`dep-${width}-reloaded`)
}

ws.close(); chrome.kill(); process.exit(0)
