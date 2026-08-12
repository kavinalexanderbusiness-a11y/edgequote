// ── Drive the REAL recurring-job editor's Season End flow, over CDP ──────────
// Signs in with the owner credentials from .env.local and exercises the exact
// gesture the bug report describes: open a recurring visit, look at (or set)
// the Ends control, save through the scope dialog, and read the toast. Run
// against a `next start` of the build under test.
//
// Probe mode (default):   node scripts/season-cdp.mjs <recurrenceId> <width>
//   Reports whether the editor hydrates the Ends control as "season", whether
//   the control is reachable at that width, and the layout facts (overflow,
//   tap sizes) the mobile pass needs.
// Save mode (--save):     node scripts/season-cdp.mjs <recurrenceId> <width> --save
//   Additionally re-asserts Season end, clicks Update job, answers the scope
//   dialog with "All visits", and reports the resulting toast.
//
// Same traps as loc-cdp.mjs: device metrics (not window size) for phone
// widths; per-element overflow because <main> is overflow-auto; poll for
// hydration, never sleep-and-hope.
import { spawn } from 'node:child_process'
import { writeFileSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'
const [recId, wArg, ...rest] = process.argv.slice(2)
const width = Number(wArg || 390)
const doSave = rest.includes('--save')
const shot = rest.includes('--shot')
const PORT = 9222 + Number(process.env.CDP_SLOT || 0)
const BASE = process.env.BASE_URL || 'http://127.0.0.1:3000'

const env = Object.fromEntries(
  readFileSync(resolve('.env.local'), 'utf8').replace(/\r\n/g, '\n').split('\n')
    .map(l => l.match(/^([A-Z_]+)=(.*)$/)).filter(Boolean).map(m => [m[1], m[2].replace(/^["']|["']$/g, '')]))
const EMAIL = env.BACKFILL_OWNER_EMAIL, PASS = env.BACKFILL_OWNER_PASSWORD

const PROFILE = resolve('.chrome-season')
const chrome = spawn(CHROME, [
  '--headless=new', '--disable-gpu', '--no-sandbox', '--hide-scrollbars',
  `--remote-debugging-port=${PORT}`,
  '--user-data-dir=' + PROFILE,
  'about:blank',
], { stdio: 'ignore' })

const sleep = ms => new Promise(r => setTimeout(r, ms))
async function wsUrl() {
  for (let i = 0; i < 80; i++) {
    try { return (await (await fetch(`http://127.0.0.1:${PORT}/json/version`)).json()).webSocketDebuggerUrl }
    catch { await sleep(250) }
  }
  throw new Error('Chrome never opened its debugging port')
}
const ws = new WebSocket(await wsUrl())
await new Promise(r => ws.addEventListener('open', r, { once: true }))
let id = 0
const pending = new Map()
ws.addEventListener('message', e => {
  const m = JSON.parse(e.data)
  if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id) }
})
function send(method, params = {}, sessionId) {
  const n = ++id
  return new Promise((res, rej) => {
    pending.set(n, m => m.error ? rej(new Error(method + ': ' + m.error.message)) : res(m.result))
    ws.send(JSON.stringify({ id: n, method, params, sessionId }))
  })
}
const { targetId } = await send('Target.createTarget', { url: 'about:blank' })
const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true })
const S = (m, p) => send(m, p, sessionId)
const metrics = () => S('Emulation.setDeviceMetricsOverride', {
  width, height: 844, deviceScaleFactor: 1, mobile: true, screenWidth: width, screenHeight: 844,
})
const evalx = async expr => (await S('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true })).result.value

await S('Page.enable'); await S('Runtime.enable'); await metrics()
await S('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 })

// ── Sign in only if the persisted session has lapsed (rate-limit safety) ─────
const FOCUS_URL = `${BASE}/dashboard/schedule?focus=${recId}`
await S('Page.navigate', { url: FOCUS_URL })
await sleep(3000)
if (await evalx(`location.pathname.indexOf('/dashboard') !== 0`)) {
  await S('Page.navigate', { url: `${BASE}/login` })
  let ready = false
  for (let i = 0; i < 40; i++) {
    await sleep(750)
    if (await evalx(`!!document.querySelector('input[type=email]') && !!document.querySelector('form')`)) { ready = true; break }
  }
  if (!ready) throw new Error('login form never appeared')
  await sleep(1500)
  await evalx(`(function(){
    var set = (el,v) => { var d=Object.getOwnPropertyDescriptor(el.constructor.prototype,'value').set; d.call(el,v);
      el.dispatchEvent(new Event('input',{bubbles:true})) }
    set(document.querySelector('input[type=email]'), ${JSON.stringify(EMAIL)})
    set(document.querySelector('input[type=password]'), ${JSON.stringify(PASS)})
    document.querySelector('button[type=submit]').click()
    return 'submitted'
  })()`)
  let inside = false
  for (let i = 0; i < 40; i++) {
    await sleep(750)
    if (await evalx(`location.pathname.indexOf('/dashboard') === 0`)) { inside = true; break }
  }
  if (!inside) throw new Error('login did not reach the dashboard: ' + await evalx(`document.body.innerText.slice(0,200)`))
  await S('Page.navigate', { url: FOCUS_URL })
}

// ── Wait for the ?focus= deep link to open the edit modal ────────────────────
let modal = false
for (let i = 0; i < 40; i++) {
  await sleep(1000)
  await metrics()
  if (await evalx(`Array.from(document.querySelectorAll('button')).some(b => /Update job/.test(b.textContent||''))`)) { modal = true; break }
}
if (!modal) { console.log(JSON.stringify({ width, error: 'edit modal never opened', path: await evalx('location.pathname + location.search') })); process.exit(2) }
await sleep(1500)

// ── Expand the Repeat collapsible if collapsed, bring Ends into view ─────────
const HELPERS = `
  function labelled(name){
    var labs = Array.from(document.querySelectorAll('label')).filter(l => (l.textContent||'').trim() === name)
    for (var i=0;i<labs.length;i++){
      var root = labs[i].closest('div')
      var sel = root && root.querySelector('select')
      if (sel) return sel
    }
    return null
  }
`
const expand = await evalx(`(function(){ ${HELPERS}
  if (labelled('Ends')) return 'already open'
  var t = Array.from(document.querySelectorAll('button')).filter(b => /Repeat/i.test(b.textContent||''))
  if (!t.length) return 'no repeat trigger; buttons: ' + Array.from(document.querySelectorAll('button')).map(b => (b.textContent||'').trim().slice(0,30)).filter(Boolean).slice(0,40).join(' | ')
  t[t.length - 1].click()
  return 'clicked: ' + (t[t.length - 1].textContent||'').trim().slice(0,60)
})()`)
await sleep(1000)
console.log(JSON.stringify({ width, phase: 'expand', expand }))

const PROBE = `(function(){ ${HELPERS}
  var VW = window.innerWidth
  var sel = labelled('Ends')
  var out = { viewport: VW, endsSelectFound: !!sel }
  if (sel) {
    sel.scrollIntoView({ block: 'center' })
    var r = sel.getBoundingClientRect()
    out.endsValue = sel.value
    out.endsOptions = Array.from(sel.options).map(o => o.value)
    out.endsRect = { left: Math.round(r.left), right: Math.round(r.right), height: Math.round(r.height) }
    out.endsFitsWidth = r.left >= 0 && r.right <= VW + 1
    out.endsTapOK = r.height >= 40
  }
  var txt = document.body.innerText
  out.seasonInfoLine = (txt.match(/Ends at season end[^\\n]*/)||[null])[0]
  var over = Array.from(document.querySelectorAll('body *')).filter(function(el){
    var r = el.getBoundingClientRect()
    if (!r.width && !r.height) return false
    var s = getComputedStyle(el)
    if (s.display==='none'||s.visibility==='hidden') return false
    return r.right > VW + 1
  })
  out.nodesWiderThanViewport = over.length
  out.widest = over.slice(0,3).map(function(el){ var r=el.getBoundingClientRect()
    return 'R'+Math.round(r.right)+' <'+el.tagName.toLowerCase()+'> '+String(el.className||'').slice(0,50) })
  var save = Array.from(document.querySelectorAll('button')).find(b => /Update job/.test(b.textContent||''))
  if (save) { var sr = save.getBoundingClientRect(); out.saveVisible = sr.top >= 0 && sr.bottom <= 844; out.saveTapOK = sr.height >= 40 }
  return JSON.stringify(out)
})()`
const probe1 = JSON.parse(await evalx(PROBE))
console.log(JSON.stringify({ width, phase: 'probe', ...probe1 }, null, 1))

if (doSave) {
  // Re-assert Season end through the REAL control (fires onChange → endTouched).
  const set = await evalx(`(function(){ ${HELPERS}
    var sel = labelled('Ends')
    if (!sel) return 'no select'
    var d = Object.getOwnPropertyDescriptor(sel.constructor.prototype, 'value').set
    d.call(sel, 'season')
    sel.dispatchEvent(new Event('change', { bubbles: true }))
    return 'set season'
  })()`)
  await sleep(600)
  await evalx(`Array.from(document.querySelectorAll('button')).find(b => /Update job/.test(b.textContent||'')).click()`)
  // Scope dialog → All visits (a rule applies to the series, not one stop).
  let scoped = false
  for (let i = 0; i < 20; i++) {
    await sleep(500)
    const hit = await evalx(`(function(){
      var b = Array.from(document.querySelectorAll('button')).find(x => /All visits/.test(x.textContent||''))
      if (b) { b.click(); return true } return false
    })()`)
    if (hit) { scoped = true; break }
  }
  await sleep(4000)
  const toast = await evalx(`(function(){
    var t = document.body.innerText.match(/(Removed [^\\n]+|kept[^\\n]+|Schedule updated[^\\n]+|Could not [^\\n]+|Saved[^\\n]+)/)
    return t ? t[0] : null
  })()`)
  console.log(JSON.stringify({ width, phase: 'save', set, scopeDialogAnswered: scoped, toast }, null, 1))
}

if (shot) {
  const { data } = await S('Page.captureScreenshot', { format: 'png' })
  writeFileSync(resolve(`season-end.${width}${doSave ? '.saved' : ''}.png`), Buffer.from(data, 'base64'))
}
chrome.kill()
process.exit(0)
