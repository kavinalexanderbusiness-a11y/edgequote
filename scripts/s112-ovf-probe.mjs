// Find WHAT overflows <main> on the dispatch board at 375px. Read-only.
import { readFileSync, mkdtempSync } from 'node:fs'
import { spawn } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'
const [baseUrl = 'http://localhost:3112'] = process.argv.slice(2)
const PORT = 9591

const env = Object.fromEntries(readFileSync('.env.local', 'utf8').split(/\r?\n/)
  .filter(l => l && !l.startsWith('#') && l.includes('='))
  .map(l => [l.slice(0, l.indexOf('=')).trim(), l.slice(l.indexOf('=') + 1).trim()]))

const profile = mkdtempSync(join(tmpdir(), 's112-ovf-'))
const chrome = spawn(CHROME, ['--headless=new', '--disable-gpu', '--no-sandbox', '--hide-scrollbars',
  `--remote-debugging-port=${PORT}`, '--user-data-dir=' + profile, 'about:blank'], { stdio: 'ignore' })
const sleep = ms => new Promise(r => setTimeout(r, ms))
async function target() {
  for (let i = 0; i < 60; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${PORT}/json/list`)
      const t = (await r.json()).find(x => x.type === 'page')
      if (t) return t.webSocketDebuggerUrl
    } catch { }
    await sleep(400)
  }
  throw new Error('no CDP target')
}
const ws = new WebSocket(await target())
await new Promise(r => ws.addEventListener('open', r))
let msgId = 0
const pending = new Map()
ws.addEventListener('message', e => { const m = JSON.parse(e.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id) } })
const send = (method, params = {}) => new Promise(res => { const id = ++msgId; pending.set(id, res); ws.send(JSON.stringify({ id, method, params })) })
const evaluate = async expression => (await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })).result?.result?.value
const goto = async url => { await send('Page.navigate', { url }); for (let i = 0; i < 80; i++) { await sleep(250); if (await evaluate('document.readyState === "complete"')) break } await sleep(1800) }
const setW = w => send('Emulation.setDeviceMetricsOverride', { width: w, height: 900, deviceScaleFactor: 2, mobile: true })

await setW(1280)
await goto(`${baseUrl}/login`)
await evaluate(`(() => {
  const set = (el, v) => { const s = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set; s.call(el, v); el.dispatchEvent(new Event('input', { bubbles: true })) }
  set(document.querySelector('input[type=email]'), ${JSON.stringify(env.PORTAL_RPC_OWNER_EMAIL)})
  set(document.querySelector('input[type=password]'), ${JSON.stringify(env.PORTAL_RPC_OWNER_PASSWORD)})
  ;[...document.querySelectorAll('button')].find(b => /sign in/i.test(b.textContent || '')).click()
})()`)
for (let i = 0; i < 80; i++) { await sleep(250); if (await evaluate(`location.pathname.startsWith('/dashboard')`)) break }

await setW(375)
await goto(`${baseUrl}/dashboard/dispatch`)
await setW(375)
await sleep(1200)
const out = await evaluate(`(() => {
  const m = document.querySelector('main')
  const limit = m.clientWidth
  const rows = []
  for (const el of m.querySelectorAll('*')) {
    const r = el.getBoundingClientRect()
    if (r.width > limit + 1) {
      const cls = (el.className && typeof el.className === 'string') ? el.className.slice(0, 90) : ''
      rows.push(Math.round(r.width) + 'px <' + el.tagName.toLowerCase() + '> ' + cls)
    }
  }
  return { limit, over: m.scrollWidth - m.clientWidth, widest: rows.slice(0, 14) }
})()`)
console.log(JSON.stringify(out, null, 2))
ws.close(); chrome.kill(); process.exit(0)
