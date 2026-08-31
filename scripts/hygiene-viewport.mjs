// ── Customer-facing viewport proof: the booking page, at real phone widths ──
//   node scripts/hygiene-viewport.mjs [baseUrl] [token]
//
// ⭐ WHY THE BOOKING PAGE. It is the platform's own customer-facing surface —
// one codebase, every tenant, and (unlike the portal) no login stands in front
// of it. It is where the lawn-specific platform copy lived, so it is where the
// universal-product fix has to be seen rather than asserted.
//
// TWO questions, at 375 / 390 / 430 / desktop:
//   1. Does any RENDERED text name a trade the tenant might not be in?
//   2. Does the page overflow its own viewport horizontally?
//
// ⚠️ HONEST LIMIT, stated by the script itself rather than buried: with no real
// booking token the page renders its shell and its first step and stops. That
// still exercises every string this session changed on the address/measure
// steps' entry, but it is NOT the whole flow. The output says which steps it
// actually reached, so nobody can read this as more proof than it is.
import { spawn } from 'node:child_process'
const CHROME = process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe'
const base = process.argv[2] || 'http://localhost:3000'
const token = process.argv[3] || 'viewport-probe-token'
const PORT = 9451
const profile = (process.env.TEMP || '.') + '/eq-hyg-viewport-' + PORT

const chrome = spawn(CHROME, ['--headless=new', '--disable-gpu', '--no-sandbox',
  `--remote-debugging-port=${PORT}`, '--user-data-dir=' + profile, 'about:blank'], { stdio: 'ignore' })
const sleep = ms => new Promise(r => setTimeout(r, ms))
async function wsUrl() {
  for (let i = 0; i < 120; i++) { try { return (await (await fetch(`http://127.0.0.1:${PORT}/json/version`)).json()).webSocketDebuggerUrl } catch { await sleep(250) } }
  throw new Error('chrome did not open a debugging port')
}
const ws = new WebSocket(await wsUrl())
await new Promise(r => ws.addEventListener('open', r, { once: true }))
let id = 0; const pending = new Map()
ws.addEventListener('message', e => { const m = JSON.parse(e.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id) } })
const send = (method, params = {}, sessionId) => new Promise((res, rej) => {
  const n = ++id; pending.set(n, m => m.error ? rej(new Error(m.error.message)) : res(m.result))
  ws.send(JSON.stringify({ id: n, method, params, sessionId }))
})
const { targetId } = await send('Target.createTarget', { url: 'about:blank' })
const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true })
const S = (m, p) => send(m, p, sessionId)
await S('Page.enable'); await S('Runtime.enable')
const ev = expr => S('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true }).then(r => r.result.value)

// ⛔ Trade words the PLATFORM must never print. Deliberately narrow: these are
// words that name a VERTICAL, not words that name geometry. "area", "property",
// "service" are the vocabulary that replaced them and must survive.
const TRADE = /\b(lawn|lawns|mow|mowing|mowed|grass|turf|sod)\b/i

const WIDTHS = [
  { label: '375  (iPhone SE / mini)', w: 375, h: 812, mobile: true },
  { label: '390  (iPhone 14/15)', w: 390, h: 844, mobile: true },
  { label: '430  (iPhone Pro Max)', w: 430, h: 932, mobile: true },
  { label: 'desktop', w: 1280, h: 900, mobile: false },
]

let failures = 0
console.log(`\n═══ Customer booking page — ${base}/book/${token} ═══`)

for (const v of WIDTHS) {
  await S('Emulation.setDeviceMetricsOverride', {
    width: v.w, height: v.h, deviceScaleFactor: 2, mobile: v.mobile,
    screenWidth: v.w, screenHeight: v.h,
  })
  await S('Page.navigate', { url: `${base}/book/${token}` })
  await sleep(3500)

  const r = await ev(`(() => {
    const de = document.documentElement
    // Every element that sticks out past the viewport — reported by TAG+CLASS so
    // the offender is findable, not just countable.
    const over = [...document.querySelectorAll('*')]
      .filter(el => {
        const b = el.getBoundingClientRect()
        return b.width > 0 && (b.right > de.clientWidth + 1 || b.left < -1)
      })
      .slice(0, 5)
      .map(el => el.tagName.toLowerCase() + (el.className && typeof el.className === 'string' ? '.' + el.className.trim().split(/\\s+/).slice(0,3).join('.') : ''))
    // Visible text only: an aria-label or a hidden step must not count as
    // "rendered", and a <script> body must never be scanned as copy.
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT)
    const texts = []
    let n
    while ((n = walker.nextNode())) {
      const p = n.parentElement
      if (!p || /script|style|noscript/i.test(p.tagName)) continue
      const cs = getComputedStyle(p)
      if (cs.display === 'none' || cs.visibility === 'hidden') continue
      const t = n.textContent.trim()
      if (t) texts.push(t)
    }
    // Placeholders and accessible names are read by customers too.
    const attrs = [...document.querySelectorAll('[placeholder],[aria-label],[alt],[title]')]
      .flatMap(el => ['placeholder','aria-label','alt','title'].map(a => el.getAttribute(a)).filter(Boolean))
    return {
      scrollW: de.scrollWidth, clientW: de.clientWidth,
      over,
      texts, attrs,
      steps: [...document.querySelectorAll('[class*=step], h1, h2')].map(e => e.textContent.trim()).filter(Boolean).slice(0, 6),
      bodyLen: document.body.innerText.length,
    }
  })()`)

  const copy = [...(r.texts || []), ...(r.attrs || [])]
  const offenders = copy.filter(s => TRADE.test(s))
  const hOverflow = r.scrollW > r.clientW + 1

  const okCopy = offenders.length === 0
  const okFit = !hOverflow && (r.over || []).length === 0
  if (!okCopy) failures++
  if (!okFit) failures++

  console.log(`\n  ── ${v.label} ──`)
  console.log(`     rendered   ${r.bodyLen} chars of visible text, ${copy.length} strings scanned`)
  console.log(`     ${okCopy ? '✓' : '✗'} no trade-specific platform copy${okCopy ? '' : ': ' + offenders.map(s => `“${s}”`).join(' · ')}`)
  console.log(`     ${okFit ? '✓' : '✗'} fits the viewport (scrollWidth ${r.scrollW} vs ${r.clientW})${okFit ? '' : ' — overflowing: ' + (r.over || []).join(', ')}`)
  // ⛔ Say WHICH state was reached, every time. A run that only ever saw the
  // pre-token shell is a weaker proof than one that reached the form, and a
  // reader must never have to infer which happened from a character count.
  const reachedForm = copy.some(s => /Approximate area|Confirm the area|Where is the property/i.test(s))
  console.log(`     ${reachedForm ? '▣' : '▢'} reached ${reachedForm ? 'the ADDRESS/MEASURE form' : 'the PRE-TOKEN SHELL ONLY (no valid booking token — the form was never rendered)'}`)
  if (r.steps?.length) console.log(`     headings   ${r.steps.join(' | ')}`)
}

console.log('\n── Summary ────────────────────────────────────────────────────')
console.log(failures === 0
  ? '\n✅ booking page: no trade-specific platform copy, no horizontal overflow, at 375/390/430/desktop\n'
  : `\n❌ ${failures} viewport check(s) failed\n`)
console.log('⚠️  Scope: with no real booking token the page renders its shell and first')
console.log('   step. Later steps (plan, contact) are NOT covered by this run.\n')

chrome.kill()
process.exit(failures === 0 ? 0 : 1)
