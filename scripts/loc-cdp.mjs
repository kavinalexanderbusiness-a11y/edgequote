// ── Measure the REAL property page at phone widths, over CDP ─────────────────
// Not a static fixture: this signs in with the owner credentials from
// .env.local and drives the running app, because the two things this pass has to
// answer — "does the summary fit a 375px screen" and "is the critical line
// readable without scrolling" — depend on real data (a 14-visit recurring
// address renders differently from a fixture with two).
//
// Two traps this is built around, both of which have produced false passes here:
//   * Chrome clamps a headless WINDOW to ~500 CSS px on Windows, so a window
//     resize is not a phone. Emulation.setDeviceMetricsOverride is.
//   * `<main>` is overflow-auto, so the DOCUMENT never reports sideways
//     overflow no matter how wide a child is. Overflow is therefore measured
//     per-ELEMENT against the viewport, not from scrollWidth.
//
//   node scripts/loc-cdp.mjs <propertyId> <width> [--shot]
import { spawn } from 'node:child_process'
import { writeFileSync, readFileSync } from 'node:fs'
import { resolve, join } from 'node:path'

const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'
const [propId, wArg, ...rest] = process.argv.slice(2)
const width = Number(wArg || 390)
const shot = rest.includes('--shot')
const PORT = 9222 + Number(process.env.CDP_SLOT || 0)
const BASE = process.env.BASE_URL || 'http://127.0.0.1:3000'

const env = Object.fromEntries(
  readFileSync(resolve('.env.local'), 'utf8').replace(/\r\n/g, '\n').split('\n')
    .map(l => l.match(/^([A-Z_]+)=(.*)$/)).filter(Boolean).map(m => [m[1], m[2].replace(/^["']|["']$/g, '')]))
const EMAIL = env.BACKFILL_OWNER_EMAIL, PASS = env.BACKFILL_OWNER_PASSWORD

// ONE profile shared by every width in a batch, wiped between BUILDS (not
// between runs) — `rm -rf .chrome-loc` before the batch, which the caller does.
//
// Both alternatives were tried and are worse:
//   * wiping per run  — throws away the session, so runs 2..n re-authenticate;
//     the app then lands back on /login and every field reads as absent, which
//     is indistinguishable from a broken feature.
//   * Network.setCacheDisabled — also breaks the persisted session here, with
//     the same symptom.
// Since all widths in a batch measure the SAME build, a shared warm profile
// cannot serve a stale bundle within the batch; only a cross-build reuse could,
// and that is what the wipe covers.
const PROFILE = resolve('.chrome-loc')

const chrome = spawn(CHROME, [
  '--headless=new', '--disable-gpu', '--no-sandbox', '--hide-scrollbars',
  `--remote-debugging-port=${PORT}`,
  // A FRESH profile each run: a persistent one serves a stale client bundle and
  // reports yesterday's layout as today's.
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

// ── Sign in, but only if the persisted session has actually lapsed ───────────
// Re-authenticating on every run trips Supabase's auth rate limit, and a
// throttled login fails silently — leaving a signed-out page whose every field
// reads as absent, which is indistinguishable from a broken feature.
await S('Page.navigate', { url: `${BASE}/dashboard/properties/${propId}` })
await sleep(3000)
const needsLogin = await evalx(`location.pathname.indexOf('/dashboard') !== 0`)
if (needsLogin) {
  await S('Page.navigate', { url: `${BASE}/login` })
  // Poll for HYDRATION, not for paint. React attaches its onSubmit after the
  // bundle executes; filling the inputs before that fires a submit no handler is
  // listening for, which lands back on /login looking exactly like bad
  // credentials. With the HTTP cache disabled this can take several seconds.
  let ready = false
  for (let i = 0; i < 40; i++) {
    await sleep(750)
    if (await evalx(`!!document.querySelector('input[type=email]') && !!document.querySelector('form')`)) { ready = true; break }
  }
  if (!ready) throw new Error('login form never appeared')
  await sleep(1500)   // let React finish attaching handlers
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
}

// --fail-visits: block the visits read at the network so the REAL failure path
// runs. This is the claim that matters most — "couldn't load" must not render as
// "no service history" — and it cannot be proven by a fixture, only by breaking
// the request the shipped page actually makes.
if (rest.includes('--fail-visits')) {
  await S('Network.enable')
  await S('Network.setBlockedURLs', { urls: ['*/rest/v1/jobs*'] })
}

await S('Page.navigate', { url: `${BASE}/dashboard/properties/${propId}` })
// POLL, don't guess. With a wiped profile the client bundle is downloaded cold,
// so a fixed sleep measures the loading skeleton and reports every field as
// absent — which reads exactly like a broken feature.
let settled = false
for (let i = 0; i < 40; i++) {
  await sleep(1000)
  await metrics()
  const txt = await evalx(`((document.querySelector('main')||document.body).innerText||'')`)
  if (/Access & site notes/.test(txt)) { settled = true; break }
}
if (!settled) console.error('WARN: summary card never appeared — numbers below describe an unsettled page')
await metrics(); await sleep(1200)

const PROBE = `(function(){
  var VW = window.innerWidth
  function vis(el){
    var r = el.getBoundingClientRect()
    if (!r.width && !r.height) return false
    for (var p=el;p;p=p.parentElement){ var s=getComputedStyle(p)
      if (s.display==='none'||s.visibility==='hidden'||s.opacity==='0') return false }
    return true
  }
  var all = Array.from(document.querySelectorAll('main *')).filter(vis)
  // Per-element, because <main> is overflow-auto and hides document overflow.
  var over = all.filter(el => el.getBoundingClientRect().right > VW + 1)
  var txt = (document.querySelector('main')||document.body).innerText
  var card = Array.from(document.querySelectorAll('main *'))
    .find(el => /Access & site notes/.test(el.textContent||'') && el.className && /rounded/.test(el.className))
  var cr = card ? card.getBoundingClientRect() : null
  // Tap targets: anything interactive shorter than 40px fails the thumb test.
  var taps = all.filter(el => /^(BUTTON|A)$/.test(el.tagName) || el.getAttribute('role')==='button')
  var small = taps.filter(el => { var r=el.getBoundingClientRect(); return r.height>0 && r.height<40 })
  return JSON.stringify({
    viewport: VW,
    loggedIn: !/Sign in|Log in/i.test(document.title||'') && location.pathname.indexOf('/dashboard')===0,
    path: location.pathname,
    nodesWiderThanViewport: over.length,
    widest: over.slice(0,4).map(function(el){ var r=el.getBoundingClientRect()
      return 'L'+Math.round(r.left)+' R'+Math.round(r.right)+' w'+Math.round(r.width)+' <'+el.tagName.toLowerCase()+'> "'
        +(el.innerText||'').trim().replace(/\\s+/g,' ').slice(0,40)+'" cls='+String(el.className||'').slice(0,70) }),
    summaryCardTop: cr ? Math.round(cr.top) : null,
    summaryCardHeight: cr ? Math.round(cr.height) : null,
    summaryEndsWithinFirstScreen: cr ? (cr.top + cr.height) <= 844 : null,
    hasAccessNotes: /Access & site notes/.test(txt),
    hasPrivateLabel: /private/i.test(txt),
    hasNextVisit: /Next visit/.test(txt),
    hasLastVisit: /Last completed visit/.test(txt),
    hasTypical: /Typical visit/.test(txt),
    typicalLine: (txt.match(/Typical visit\\s*\\n?\\s*([^\\n]+)/)||[])[1] || null,
    nextLine: (txt.match(/Next visit\\s*\\n?\\s*([^\\n]+)/)||[])[1] || null,
    lastLine: (txt.match(/Last completed visit\\s*\\n?\\s*([^\\n]+)/)||[])[1] || null,
    servicesLine: (txt.match(/Services performed[^\\n]*\\n?\\s*([^\\n]+)/)||[])[1] || null,
    saysUnknown: /Couldn.t load/.test(txt),
    saysNoHistory: /No completed visits yet/.test(txt),
    tapTargetsUnder40: small.length,
    scrollHeight: Math.round(document.documentElement.scrollHeight),
    onScreen: txt.replace(/\\s+/g,' ').slice(0,400)
  })
})()`

console.log(JSON.stringify({ width, ...JSON.parse(await evalx(PROBE)) }, null, 1))

if (shot) {
  const { data } = await S('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true })
  const out = resolve(`loc-property.${width}.png`)
  writeFileSync(out, Buffer.from(data, 'base64'))
  console.error('shot → ' + out)
}
ws.close(); chrome.kill(); process.exit(0)
