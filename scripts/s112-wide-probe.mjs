// One-off: what is wider than the viewport in a harness scene? (debug tool)
import { spawn } from 'node:child_process'
import { join } from 'node:path'
const [scene = 'portal-drifted', width = '375'] = process.argv.slice(2)
const CH = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'
const proc = spawn(CH, ['--headless=new', '--remote-debugging-port=9379', '--disable-gpu',
  '--user-data-dir=' + join(process.cwd(), '.s112b', '.c2'), 'about:blank'], { stdio: 'ignore' })
const sleep = ms => new Promise(r => setTimeout(r, ms))
let t
for (let i = 0; i < 50 && !t; i++) {
  await sleep(300)
  try { t = (await (await fetch('http://127.0.0.1:9379/json/list')).json()).find(x => x.type === 'page') } catch { /* boot */ }
}
const ws = new WebSocket(t.webSocketDebuggerUrl)
await new Promise(r => { ws.onopen = r })
let id = 0; const pend = new Map()
ws.onmessage = m => { const x = JSON.parse(m.data); if (x.id && pend.has(x.id)) { pend.get(x.id)(x.result); pend.delete(x.id) } }
const send = (method, params = {}) => new Promise(res => { pend.set(++id, res); ws.send(JSON.stringify({ id, method, params })) })
const ev = async e => (await send('Runtime.evaluate', { expression: e, returnByValue: true })).result?.value
await send('Emulation.setDeviceMetricsOverride', { width: Number(width), height: 900, deviceScaleFactor: 1, mobile: true })
await send('Page.navigate', { url: 'file:///' + join(process.cwd(), '.s112b', scene + '.html').replace(/\\/g, '/') })
await sleep(1200)
const out = await ev(`(() => {
  const out = []
  for (const el of document.querySelectorAll('*')) {
    const r = el.getBoundingClientRect()
    if (r.width > ${Number(width)} + 5) out.push(Math.round(r.width) + ' <' + el.tagName.toLowerCase() + '> ' + String(el.className || '').slice(0, 90))
  }
  return out.slice(0, 14)
})()`)
console.log(JSON.stringify(out, null, 1))
ws.close(); proc.kill(); process.exit(0)
