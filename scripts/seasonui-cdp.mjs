// ── Drive the REAL app: the season is a CONTROL, at every width ─────────────
// Session 110. The repair's whole claim is that the canonical fact is visible —
// so this checks what a person would: open a job, make it repeat, and see the
// Season control, including the state that used to be invisible.
//
//   node scripts/seasonui-cdp.mjs <baseUrl>
//
// ⛔ READ-ONLY. It opens the editor and reads the controls. It never saves, so
// no series, visit or declaration is written. The Season control is form state
// until a save, and no save is performed.

import { spawn } from 'node:child_process'
import { readFileSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe'
const base = process.argv.slice(2).find(a => a.startsWith('http')) || 'http://127.0.0.1:3130'
const PORT = 9495
const WIDTHS = [1280, 430, 390, 375]

const env = Object.fromEntries(readFileSync('.env.local', 'utf8').split(/\r?\n/)
  .filter(l => l && !l.startsWith('#') && l.includes('='))
  .map(l => [l.slice(0, l.indexOf('=')).trim(), l.slice(l.indexOf('=') + 1).trim()]))
const EMAIL = env.PORTAL_RPC_OWNER_EMAIL, PASSWORD = env.PORTAL_RPC_OWNER_PASSWORD
if (!EMAIL || !PASSWORD) { console.error('no credentials'); process.exit(2) }

let fails = 0
const ok = n => console.log(`  ✓ ${n}`)
const bad = (n, d = '') => { fails++; console.log(`  ✗ ${n}${d ? `\n      ${d}` : ''}`) }
const check = (n, c, d) => c ? ok(n) : bad(n, d)
const sleep = ms => new Promise(r => setTimeout(r, ms))

const profile = mkdtempSync(join(tmpdir(), 'seasonui-'))
const chrome = spawn(CHROME, ['--headless=new', '--disable-gpu', '--no-sandbox', '--hide-scrollbars',
  `--remote-debugging-port=${PORT}`, '--user-data-dir=' + profile, 'about:blank'], { stdio: 'ignore' })
chrome.on('error', e => { console.error('chrome: ' + e.message); process.exit(2) })

let wsUrl
for (let i = 0; i < 60; i++) {
  try {
    const r = await fetch(`http://127.0.0.1:${PORT}/json/list`)
    const t = (await r.json()).find(x => x.type === 'page')
    if (t) { wsUrl = t.webSocketDebuggerUrl; break }
  } catch { /* not up */ }
  await sleep(500)
}
const { WebSocket } = await import('ws').catch(() => ({ WebSocket: globalThis.WebSocket }))
const ws = new WebSocket(wsUrl)
await new Promise(r => ws.addEventListener('open', r))
let id = 0
const pend = new Map()
ws.addEventListener('message', e => {
  const m = JSON.parse(e.data)
  if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id) }
})
const send = (method, params = {}) => new Promise(res => { const i = ++id; pend.set(i, res); ws.send(JSON.stringify({ id: i, method, params })) })
const evaluate = async e => (await send('Runtime.evaluate', { expression: e, awaitPromise: true, returnByValue: true })).result?.result?.value
await send('Page.enable'); await send('Runtime.enable')
const width = w => send('Emulation.setDeviceMetricsOverride', { width: w, height: 950, deviceScaleFactor: 2, mobile: w < 1000 })
const goto = async u => {
  await send('Page.navigate', { url: u })
  for (let i = 0; i < 80; i++) { await sleep(250); if (await evaluate('document.readyState==="complete"')) break }
  await sleep(2600)
}

await width(1280)
await goto(`${base}/login`)
for (let i = 0; i < 60; i++) {
  if (await evaluate(`!!document.querySelector('form button[type=submit],form button:not([type])')&&!document.querySelector('form button[disabled]')`)) break
  await sleep(500)
}
await evaluate(`(()=>{const set=(el,v)=>{const p=Object.getOwnPropertyDescriptor(el.constructor.prototype,'value').set;p.call(el,v);el.dispatchEvent(new Event('input',{bubbles:true}))};const em=document.querySelector('input[type=email]');const pw=document.querySelector('input[type=password]');if(em)set(em,${JSON.stringify(EMAIL)});if(pw)set(pw,${JSON.stringify(PASSWORD)});document.querySelector('form')?.requestSubmit();return true})()`)
let path = '/login'
for (let i = 0; i < 40; i++) { await sleep(1000); path = String(await evaluate('location.pathname') || '/login'); if (!path.includes('/login')) break }
check('signed in as the owner', !path.includes('/login'), `still at ${path}`)
if (path.includes('/login')) { ws.close(); chrome.kill(); process.exit(1) }

// Open the new-job editor and make it repeat, which is when a series exists and
// the Season control must appear.
const OPEN_EDITOR = `(() => {
  const b = [...document.querySelectorAll('button,a')].find(x => /add job|new job/i.test(x.textContent || ''))
  if (!b) return false
  b.click(); return true
})()`
// ⚠️ Repeat lives behind Session 81's disclosure — "+ More options (property,
// time, crew, repeat, notes)". A harness that looks for the control without
// opening this finds nothing and reports a missing feature. The first run of
// this proof did exactly that.
const OPEN_MORE = `(() => {
  const b = [...document.querySelectorAll('button')].find(x => /more option/i.test(x.textContent || ''))
  if (!b) return 'no-disclosure'
  b.click(); return 'opened'
})()`
const SET_REPEAT = `(() => {
  const labels = [...document.querySelectorAll('label')]
  const l = labels.find(x => /^repeats?$/i.test((x.textContent || '').trim()))
  const sel = l ? (l.querySelector('select') || l.parentElement?.querySelector('select')) : null
  const s = sel || [...document.querySelectorAll('select')].find(x =>
    [...x.options].some(o => /every 2 weeks/i.test(o.textContent || '')))
  if (!s) return 'no-repeat-select'
  const opt = [...s.options].find(o => /every 2 weeks/i.test(o.textContent || ''))
  if (!opt) return 'no-biweekly-option'
  const setter = Object.getOwnPropertyDescriptor(s.constructor.prototype, 'value').set
  setter.call(s, opt.value)
  s.dispatchEvent(new Event('change', { bubbles: true }))
  return 'ok'
})()`
const SEASON = `(() => {
  const labels = [...document.querySelectorAll('label')]
  const l = labels.find(x => /^season$/i.test((x.textContent || '').trim()))
  const sel = l ? (l.querySelector('select') || l.parentElement?.querySelector('select')) : null
  if (!sel) return null
  return {
    value: sel.value,
    options: [...sel.options].map(o => (o.textContent || '').trim()),
    notice: (document.body.innerText.match(/[^\\n]*No season is set for this series[^\\n]*/i) || [''])[0],
  }
})()`
const OVERFLOW = `(() => {
  const bad = []
  const scrolls = el => { for (let p = el.parentElement; p && p !== document.body; p = p.parentElement) { const ox = getComputedStyle(p).overflowX; if (ox === 'auto' || ox === 'scroll' || ox === 'hidden') return true } return false }
  for (const el of document.querySelectorAll('body *')) {
    const r = el.getBoundingClientRect()
    if (r.width === 0) continue
    if (r.right > innerWidth + 1 || r.left < -1) { if (scrolls(el)) continue
      bad.push(el.tagName.toLowerCase() + ' "' + (el.textContent||'').trim().replace(/\\s+/g,' ').slice(0,26) + '"') }
  }
  return bad.slice(0, 4)
})()`

console.log('\n▸ the Season control, at every width')
for (const w of WIDTHS) {
  const label = w >= 1000 ? 'desktop' : `${w}px`
  await width(w)
  await goto(`${base}/dashboard/schedule`)
  const opened = await evaluate(OPEN_EDITOR)
  await sleep(1600)
  check(`${label} · the job editor opens`, opened === true)
  const more = await evaluate(OPEN_MORE)
  await sleep(1300)
  check(`${label} · …and the repeat section discloses`, more === 'opened', String(more))
  const rep = await evaluate(SET_REPEAT)
  await sleep(1200)
  check(`${label} · the series can be made recurring`, rep === 'ok', String(rep))

  const s = await evaluate(SEASON)
  check(`${label} · a Season control is shown for the series`, !!s,
    'no control labelled "Season" is rendered')
  if (s) {
    check(`${label} · …offering "Needs selection"`, s.options.some(o => /needs selection/i.test(o)), s.options.join(' | '))
    check(`${label} · …every configured season`, s.options.some(o => /lawn/i.test(o)) && s.options.some(o => /snow/i.test(o)), s.options.join(' | '))
    check(`${label} · …and Year-round as an explicit choice`, s.options.some(o => /year-round/i.test(o)), s.options.join(' | '))
    // ⛔ THE POINT: an undeclared series says so, rather than reading as year-round.
    check(`${label} · ⛔ an undeclared series is SURFACED, not silently year-round`,
      s.value === '' && /No season is set for this series/i.test(s.notice),
      `value="${s.value}" notice="${s.notice}"`)
  }
  const over = await evaluate(OVERFLOW)
  check(`${label} · nothing overflows sideways`, Array.isArray(over) && over.length === 0, (over || []).join(' · '))
}

console.log('')
if (fails) console.log(`✗ season-ui browser proof: ${fails} check${fails === 1 ? '' : 's'} failed`)
else console.log('✓ season-ui browser proof: green — ⛔ nothing was saved')
ws.close(); chrome.kill()
process.exit(fails ? 1 : 0)
