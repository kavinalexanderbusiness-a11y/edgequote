// Ask the running page exactly what is in the Measure & Price dialog.
import { spawn } from 'node:child_process'
import { readFileSync, existsSync } from 'node:fs'
const CHROME = process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe'
const base = process.argv[2] || 'http://localhost:3000'
const PORT = 9433
const profile = (process.env.TEMP || '.') + '/eq-dom-probe-' + PORT
const E = Object.fromEntries((existsSync('.env.local') ? readFileSync('.env.local', 'utf8') : '')
  .split(/\r?\n/).map(l => l.match(/^([A-Z_0-9]+)=(.*)$/)).filter(Boolean).map(m => [m[1], m[2]]))
const chrome = spawn(CHROME, ['--headless=new', '--disable-gpu', '--no-sandbox',
  `--remote-debugging-port=${PORT}`, '--user-data-dir=' + profile, 'about:blank'], { stdio: 'ignore' })
const sleep = ms => new Promise(r => setTimeout(r, ms))
async function wsUrl() {
  for (let i = 0; i < 120; i++) { try { return (await (await fetch(`http://127.0.0.1:${PORT}/json/version`)).json()).webSocketDebuggerUrl } catch { await sleep(250) } }
  throw new Error('no port')
}
const ws = new WebSocket(await wsUrl())
await new Promise(r => ws.addEventListener('open', r, { once: true }))
let id = 0; const pending = new Map()
ws.addEventListener('message', e => { const m = JSON.parse(e.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id) } })
const send = (method, params = {}, sessionId) => new Promise((res, rej) => { const n = ++id; pending.set(n, m => m.error ? rej(new Error(m.error.message)) : res(m.result)); ws.send(JSON.stringify({ id: n, method, params, sessionId })) })
const { targetId } = await send('Target.createTarget', { url: 'about:blank' })
const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true })
const S = (m, p) => send(m, p, sessionId)
await S('Page.enable'); await S('Runtime.enable')
if (process.env.PROBE_METRICS) await S('Emulation.setDeviceMetricsOverride', { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false, screenWidth: 1280, screenHeight: 900 })
const ev = expr => S('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true }).then(r => r.result.value)

await S('Page.navigate', { url: base + '/login' })
await sleep(6000)
if (await ev(`location.pathname.startsWith('/login')`)) {
  await ev(`(async () => {
    const set = (el, v) => { const p = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype,'value').set; p.call(el, v); el.dispatchEvent(new Event('input',{bubbles:true})) }
    set(document.querySelector('input[type=email]'), ${JSON.stringify(E.PORTAL_RPC_OWNER_EMAIL || '')})
    set(document.querySelector('input[type=password]'), ${JSON.stringify(E.PORTAL_RPC_OWNER_PASSWORD || '')})
    await new Promise(r => setTimeout(r, 250))
    ;[...document.querySelectorAll('button')].find(b => /sign in|log in/i.test(b.textContent||''))?.click()
  })()`)
  await sleep(9000)
}
await S('Page.navigate', { url: base + '/dashboard/quotes/new?customer=61c62da5-c9c3-4948-be12-439b93ef5622&property=62a0776a-459d-4b67-8567-e19892f7be13' })
await sleep(16000)
await ev(`[...document.querySelectorAll('button')].find(x => /measure/i.test(x.textContent||''))?.click()`)
await sleep(9000)

if (process.env.PROBE_SERVICE) {
  console.log('selecting service:', await ev(`(() => {
    const dlg = document.querySelector('[aria-label="Measure & Price"]')
    const sel = dlg && dlg.querySelector('select')
    if (!sel) return 'no select'
    const opt = [...sel.options].find(o => o.value === ${JSON.stringify(process.env.PROBE_SERVICE)})
    if (!opt) return 'not in list'
    const s = Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, 'value').set
    s.call(sel, opt.value); sel.dispatchEvent(new Event('change', { bubbles: true }))
    return 'picked'
  })()`))
  await sleep(4000)
}

console.log(await ev(`(() => {
  const dlgs = document.querySelectorAll('[aria-label="Measure & Price"]')
  const d = dlgs[0]
  if (!d) return 'NO DIALOG'
  const html = d.innerHTML
  return JSON.stringify({
    dialogCount: dlgs.length,
    numberInputs: d.querySelectorAll('input[type=number]').length,
    textareas: d.querySelectorAll('textarea').length,
    hasTypedByHand: html.includes('Typed by hand'),
    hasTotalArea: html.includes('Total area') || html.includes('Total:'),
    hasEnterMeasurement: html.includes('Enter the measurement'),
    htmlLength: html.length,
    scrollHeight: d.scrollHeight,
    clientHeight: d.clientHeight,
  }, null, 2)
})()`))
chrome.kill(); process.exit(0)
