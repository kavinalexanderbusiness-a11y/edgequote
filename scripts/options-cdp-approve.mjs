// ── Full customer approval, through the DEPLOYED bundle ──────────────────────
// Pick an option, tap Approve, confirm the dialog, and report what the screen
// says afterwards. ⚠️ Run ONLY against a fixture quote — this records a real
// approval through the real portal_accept_quote.
//   node scripts/options-cdp-approve.mjs <baseUrl> <portalPath> <optionName>
import { spawn } from 'node:child_process'
import { resolve } from 'node:path'

const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'
const [base, path_, optName] = process.argv.slice(2)
const PORT = 9500 + Number(process.env.CDP_SLOT || 0)
const chrome = spawn(CHROME, [
  '--headless=new', '--disable-gpu', '--no-sandbox', '--hide-scrollbars',
  `--remote-debugging-port=${PORT}`, '--user-data-dir=' + resolve(process.env.TEMP || '.', `eq-appr-${PORT}`),
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
const metrics = { width: 390, height: 844, deviceScaleFactor: 1, mobile: true, screenWidth: 390, screenHeight: 844 }
await S('Emulation.setDeviceMetricsOverride', metrics)
await S('Page.navigate', { url: base + path_ })
await sleep(1200)
await S('Emulation.setDeviceMetricsOverride', metrics)
await sleep(5000)
const ev = e => S('Runtime.evaluate', { expression: e, returnByValue: true, awaitPromise: true }).then(r => r.result.value)

// 1. pick the named option
console.log(await ev(`(function(){
  var card = Array.from(document.querySelectorAll('button[aria-pressed]')).find(function(b){
    return (b.textContent||'').startsWith(${JSON.stringify(optName)})
  })
  if (!card) return 'PICK: no ' + ${JSON.stringify(optName)} + ' card'
  card.click(); return 'PICK: clicked ' + ${JSON.stringify(optName)}
})()`))
await sleep(600)
// 2. tap Approve
console.log(await ev(`(function(){
  var b = Array.from(document.querySelectorAll('button')).find(function(x){ return /^Approve /.test((x.textContent||'').trim()) && !x.disabled })
  if (!b) return 'APPROVE: no armed button'
  var label = (b.textContent||'').trim(); b.click(); return 'APPROVE: tapped "' + label + '"'
})()`))
// accept() refetches the payload before the dialog opens — give it time
await sleep(4500)
// 3. the confirm dialog — report its copy, then confirm
console.log(await ev(`(function(){
  var txt = (document.body.innerText||'')
  var m = txt.match(/You're approving[\\s\\S]{0,260}/)
  return 'DIALOG: ' + (m ? m[0].replace(/\\s+/g,' ').slice(0,240) : 'not found')
})()`))
console.log(await ev(`(function(){
  var btns = Array.from(document.querySelectorAll('button'))
  var b = btns.reverse().find(function(x){ return /^Approve /.test((x.textContent||'').trim()) })
  if (!b) return 'CONFIRM: no dialog approve button'
  var label = (b.textContent||'').trim(); b.click(); return 'CONFIRM: tapped "' + label + '"'
})()`))
await sleep(6000)
// 4. what the screen says now
console.log(await ev(`(function(){
  var txt = (document.body.innerText||'').replace(/\\s+/g,' ')
  var approved = /Approved/.test(txt)
  var choice = /Your choice/.test(txt)
  var notSel = (txt.match(/Not selected/g)||[]).length
  var stillButtons = Array.from(document.querySelectorAll('button')).some(function(x){ return /^Approve /.test((x.textContent||'').trim()) })
  return 'AFTER: approvedPill=' + approved + ' yourChoice=' + choice + ' notSelected=' + notSel + ' approveButtonsRemain=' + stillButtons
})()`))
ws.close(); chrome.kill(); process.exit(0)
