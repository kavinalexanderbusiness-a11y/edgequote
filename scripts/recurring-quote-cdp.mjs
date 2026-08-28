// ── Drive the REAL app: the recurring-service quote flow ─────────────────────
//   node scripts/recurring-quote-cdp.mjs <baseUrl>
//
// Signed in as the owner, against the REAL production database, at desktop and
// 375 / 390 / 430. Local code, because the branch is not deployed — the thing
// being proved is that real tenant CONFIGURATION drives the flow, not that a
// particular server is running it.
//
// WHAT IT HAS TO PROVE, and why each is not provable in a unit test:
//
//   A. A service configured as NOT MEASURED reaches its own commercial plans
//      from the quote builder, with NO map opened. This is the whole session:
//      before it, the only door was inside the satellite modal, which answers
//      "this service isn't measured" and shows nothing.
//
//   B. Three plans become three Quote Options in one tap, priced from the Price
//      Book, with the owner's Recommended badge carried across.
//
//   C. A DIFFERENT service, configured differently (measured, four terms, mixed
//      per-unit and flat), reaches the same code and gets its own answer — with
//      both services deliberately named nothing.
//
//   D. No $0 anywhere, the billing-is-not-scheduling sentence is on screen, and
//      nothing overflows or falls under 40px at phone widths.
//
// ⚠️ Any step this cannot drive is reported UNPROVEN, never as a pass.
import { spawn } from 'node:child_process'
import { readFileSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'
const [baseUrl = 'http://127.0.0.1:3111'] = process.argv.slice(2)
const PORT = 9781 + Number(process.env.CDP_SLOT || 0)
const WIDTHS = [375, 390, 430]
const SVC_A = process.env.FIXTURE_SNOW || 'ZZ S111 Fixture A'   // NOT measured, 3 flat plans
const SVC_B = process.env.FIXTURE_MOW || 'ZZ S111 Fixture B'    // measured, 4 plans

const env = Object.fromEntries(readFileSync('.env.local', 'utf8').split(/\r?\n/)
  .filter(l => l && !l.startsWith('#') && l.includes('='))
  .map(l => [l.slice(0, l.indexOf('=')).trim(), l.slice(l.indexOf('=') + 1).trim()]))
const EMAIL = env.PORTAL_RPC_OWNER_EMAIL
const PASSWORD = env.PORTAL_RPC_OWNER_PASSWORD
if (!EMAIL || !PASSWORD) { console.error('no owner credentials in .env.local'); process.exit(2) }

let fails = 0
const ok = n => console.log(`  ✓ ${n}`)
const bad = (n, d = '') => { fails++; console.log(`  ✗ ${n}${d ? `\n      ${d}` : ''}`) }
const check = (n, c, d) => c ? ok(n) : bad(n, d)
const note = n => console.log(`  · ${n}`)
const unproven = n => console.log(`  ? UNPROVEN  ${n}`)

// ⚠️⚠️ A REUSED CHROME PROFILE SERVES A STALE BUNDLE VIA THE SERVICE WORKER —
// three debugging cycles in S107 chasing a "React state bug" that was a pre-edit
// chunk. Fresh profile every run, removed at the end.
const profile = mkdtempSync(join(tmpdir(), 's111-cdp-'))
const chrome = spawn(CHROME, ['--headless=new', '--disable-gpu', '--no-sandbox', '--hide-scrollbars',
  `--remote-debugging-port=${PORT}`, '--user-data-dir=' + profile, 'about:blank'], { stdio: 'ignore' })
chrome.on('error', e => { console.error('chrome failed: ' + e.message); process.exit(2) })
const sleep = ms => new Promise(r => setTimeout(r, ms))
let ws, msgId = 0
const pending = new Map()
for (let i = 0; i < 60; i++) {
  try {
    const r = await fetch(`http://127.0.0.1:${PORT}/json/list`)
    const t = (await r.json()).find(x => x.type === 'page')
    if (t) { const M = await import('ws').catch(() => ({ WebSocket: globalThis.WebSocket })); ws = new (M.WebSocket || M.default)(t.webSocketDebuggerUrl); break }
  } catch {}
  await sleep(500)
}
if (!ws) { console.error('no CDP target'); process.exit(2) }
await new Promise(r => ws.addEventListener('open', r))
ws.addEventListener('message', e => { const m = JSON.parse(e.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id) } })
const send = (m, p = {}) => { const id = ++msgId; return new Promise(res => { pending.set(id, res); ws.send(JSON.stringify({ id, method: m, params: p })) }) }
const ev = async e => {
  const r = await send('Runtime.evaluate', { expression: e, awaitPromise: true, returnByValue: true })
  return r.result?.result?.value
}
const goto = async u => { await send('Page.navigate', { url: u }); for (let i = 0; i < 120; i++) { await sleep(250); if (await ev('document.readyState==="complete"')) break } await sleep(3000) }
const setW = async (w, mobile = true) => send('Emulation.setDeviceMetricsOverride', { width: w, height: 900, deviceScaleFactor: mobile ? 2 : 1, mobile })
async function until(expr, label, tries = 80) {
  for (let i = 0; i < tries; i++) { if (await ev(expr) === true) return true; await sleep(250) }
  bad(`${label} (timed out)`, expr.slice(0, 110)); return false
}

// ⚠️ textContent, NOT innerText: innerText omits anything scrolled out of a
// max-h/overflow-auto container in headless Chrome, so a rendered panel can look
// absent. [[measure-price-v2-s107]]
const TEXT = '(document.querySelector("main")||document.body).textContent'

// The offerings panel, addressed by its own heading rather than a class.
const PANEL = `(() => {
  const h = [...document.querySelectorAll('p')].find(p => (p.textContent||'').trim() === 'How you sell this service')
  return h ? h.closest('div.rounded-xl') : null
})()`
const PANEL_TEXT = `(() => { const p = ${PANEL}; return p ? p.textContent : '' })()`

const OVERFLOW = `(() => {
  const out = []
  const scope = document.querySelector('[role="dialog"]') || document.querySelector('main') || document.body
  for (const el of scope.querySelectorAll('*')) {
    const r = el.getBoundingClientRect()
    if (r.width === 0) continue
    if (r.right > innerWidth + 1 || r.left < -1) {
      const label = (el.textContent || '').trim().slice(0, 28) || el.getAttribute('aria-label') || ''
      out.push(el.tagName.toLowerCase() + (label ? ' "' + label + '"' : '') + ' [' + Math.round(r.left) + '..' + Math.round(r.right) + ']')
    }
  }
  return [...new Set(out)].slice(0, 5)
})()`

// ⚠️ /\$0(\.00)?\b/ matches the RATE "$0.05/sq ft". A zero PRICE carries a
// term suffix, so that is what this looks for. [[measure-price-v2-s107]]
const ZERO_PRICE = `(() => {
  const t = ${PANEL_TEXT}
  const m = t.match(/\\$0(\\.00)?\\s*(\\/|per\\b)/g)
  return m || []
})()`

// ⚠️ ServicePicker's label and input are siblings under the picker's BOX, not
// under the input's own wrapper — the component says so in its own comment
// ("The INPUT's wrapper, not boxRef — boxRef includes the label"). A
// `input.closest('div').querySelector('label')` therefore finds nothing, which
// is what NO_FIELD meant on the first run. Resolve through htmlFor instead, the
// one link the component guarantees.
// ⚠️ AND the label must be matched EXACTLY. /^Service\b/ also matches "Service
// address" / "Service Location", which appear EARLIER in the form — so the first
// run typed the service name into the address field, reported TYPED, and then
// found no suggestions. A near-miss selector that succeeds is worse than one
// that fails.
const SERVICE_INPUT = `(() => {
  const labs = [...document.querySelectorAll('label')]
  const lab = labs.find(l => (l.textContent||'').trim() === 'Service *')
    || labs.find(l => (l.textContent||'').trim().replace(/\\s*\\*$/, '') === 'Service')
  if (lab && lab.htmlFor) { const el = document.getElementById(lab.htmlFor); if (el) return el }
  return document.querySelector('input[role=combobox][aria-autocomplete=list]')
})()`

async function pickService(name) {
  return ev(`(() => {
    const el = ${SERVICE_INPUT}
    if (!el) return 'NO_FIELD'
    const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set
    set.call(el, ${JSON.stringify(name)})
    el.dispatchEvent(new Event('input', { bubbles: true }))
    el.focus(); el.dispatchEvent(new Event('focus', { bubbles: true }))
    return 'TYPED'
  })()`)
}
async function clickOption(text) {
  return ev(`(() => {
    const opts = [...document.querySelectorAll('[role=option]')]
    const b = opts.find(x => (x.textContent||'').includes(${JSON.stringify(text)}))
      || [...document.querySelectorAll('button,li')].find(x => (x.textContent||'').trim().startsWith(${JSON.stringify(text)}))
    if (!b) return 'NO_MATCH:' + opts.length
    b.click(); return 'CLICKED'
  })()`)
}

await send('Page.enable'); await send('Runtime.enable')
await setW(390)
await goto(`${baseUrl}/login`)
await ev(`(() => { const set=(el,v)=>{Object.getOwnPropertyDescriptor(el.constructor.prototype,'value').set.call(el,v);el.dispatchEvent(new Event('input',{bubbles:true}))}
  set(document.querySelector('input[type=email]'), ${JSON.stringify(EMAIL)})
  set(document.querySelector('input[type=password]'), ${JSON.stringify(PASSWORD)})
  document.querySelector('form')?.requestSubmit(); return true })()`)
await sleep(9000)
check('signed in as the owner against the production database',
  !String(await ev('location.pathname')).includes('/login'), await ev('location.pathname'))

// ── A. A NOT-MEASURED service reaches its plans with no map ──────────────────
console.log(`\n═══ A. "${SVC_A}" — configured NOT MEASURED, three flat plans ═══`)
await setW(1280, false)
await goto(`${baseUrl}/dashboard/quotes/new`)
await until(`${TEXT}.includes('Service')`, 'the quote builder loaded')

const typed = await pickService(SVC_A)
check('the fixture service can be typed into the service field', typed === 'TYPED', String(typed))
await sleep(1500)
let picked = await clickOption(SVC_A)
if (picked !== 'CLICKED') {
  // Say WHICH field was reached and what the menu held, rather than "no match".
  const diag = await ev(`(() => {
    const el = ${SERVICE_INPUT}
    const lab = el && [...document.querySelectorAll('label')].find(l => l.htmlFor === el.id)
    return JSON.stringify({
      field: lab ? (lab.textContent||'').trim() : (el ? el.id : 'NONE'),
      value: el ? el.value : null,
      expanded: el ? el.getAttribute('aria-expanded') : null,
      listbox: (document.querySelector('[role=listbox]')?.textContent || '').slice(0, 160),
      options: document.querySelectorAll('[role=option]').length,
    })
  })()`)
  note(`picker diagnostics: ${diag}`)
  unproven(`could not click the "${SVC_A}" suggestion (${picked})`)
}
await sleep(2500)

const panelUp = await until(`${PANEL} !== null`, 'the offerings panel appears beside the service')
if (panelUp) {
  const t = String(await ev(PANEL_TEXT))
  // ⭐⭐ THE CLAIM OF THE SESSION. No map was opened; no measurement exists.
  check('the panel appears WITHOUT the satellite map being opened',
    !(await ev(`document.querySelector('[role="dialog"]') !== null`)), 'a dialog is open — the map path was used')
  check('all three commercial terms are on screen',
    /One-time/.test(t) && /Monthly/.test(t) && /Seasonal/.test(t), t.slice(0, 200))
  check('the per-visit price is the Price Book\'s, per VISIT', /\$70\s*\/visit/.test(t.replace(/\s+/g, ' ')), t.slice(0, 300))
  check('the monthly price is per MONTH, not per visit', /\$240\s*\/month/.test(t.replace(/\s+/g, ' ')), t.slice(0, 300))
  check('the seasonal price is per SEASON', /\$900\s*\/season/.test(t.replace(/\s+/g, ' ')), t.slice(0, 300))
  check('the owner\'s Recommended badge is carried, not invented', /Recommended/.test(t), '')
  check('⛔ the billing-is-not-scheduling sentence is on screen',
    /priced and billed/i.test(t) && /scheduled separately/i.test(t), t.slice(0, 300))
  const zeros = await ev(ZERO_PRICE)
  check('no $0 price anywhere in the panel', Array.isArray(zeros) && zeros.length === 0, JSON.stringify(zeros))

  // ── B. Three plans → three Quote Options, one tap ──────────────────────────
  console.log('\n═══ B. One tap turns the plans into Quote Options ═══')
  const offered = await ev(`(() => {
    const p = ${PANEL}
    if (!p) return 'NO_PANEL'
    const b = [...p.querySelectorAll('button')].find(x => /Offer all \\d+ as options/.test(x.textContent||''))
    if (!b) return 'NO_BUTTON'
    b.click(); return 'CLICKED'
  })()`)
  check('the "offer all as options" action exists and fires', offered === 'CLICKED', String(offered))
  await sleep(2500)
  const body = String(await ev(TEXT))
  check('the quote now offers multiple options', /Offer multiple options|Options/.test(body), '')
  const optionNames = await ev(`(() => {
    const inputs = [...document.querySelectorAll('input')]
    return inputs.map(i => i.value).filter(v => ['One-time','Monthly','Seasonal'].includes(v))
  })()`)
  check('the three options are seeded with the commercial terms as names',
    Array.isArray(optionNames) && ['One-time', 'Monthly', 'Seasonal'].every(n => optionNames.includes(n)),
    JSON.stringify(optionNames))
  const optionPrices = await ev(`(() => {
    const inputs = [...document.querySelectorAll('input[type=number]')]
    return inputs.map(i => i.value)
  })()`)
  check('the option prices are the Price Book\'s, not re-derived',
    Array.isArray(optionPrices) && ['70', '240', '900'].every(p => optionPrices.includes(p)),
    JSON.stringify(optionPrices))
  // ⭐ The description must NOT be the owner-facing provenance string. With no
  // customer_note configured (the column is unapplied in production), the honest
  // result is an EMPTY description — not "$70 flat per visit".
  const descs = await ev(`(() => {
    const tas = [...document.querySelectorAll('textarea')]
    return tas.map(t => t.value).filter(v => v && v.length)
  })()`)
  check('no option carries the owner-facing provenance string as its description',
    !(descs || []).some(d => /\\$|per unit|sq ft|Flat \\$/i.test(d)), JSON.stringify(descs))
} else {
  unproven('the offerings panel never rendered — A and B could not be driven')
}

// ── C. A different configuration, same code, no name logic ──────────────────
console.log(`\n═══ C. "${SVC_B}" — measured, four terms, mixed per-unit and flat ═══`)
await goto(`${baseUrl}/dashboard/quotes/new`)
await until(`${TEXT}.includes('Service')`, 'a fresh quote builder loaded')
await pickService(SVC_B)
await sleep(1200)
await clickOption(SVC_B)
await sleep(2500)
if (await until(`${PANEL} !== null`, 'the offerings panel appears for the second service')) {
  const t = String(await ev(PANEL_TEXT))
  check('all four of ITS terms appear — a different answer from the same code',
    /One-time/.test(t) && /Weekly/.test(t) && /Bi-weekly/.test(t) && /Monthly/.test(t), t.slice(0, 220))
  check('its flat monthly plan is priced with nothing measured', /\$180\s*\/month/.test(t.replace(/\s+/g, ' ')), t.slice(0, 300))
  // ⭐⭐ UNKNOWN IS NOT ZERO, on a real screen: per-unit plans with no trace.
  check('its per-unit plans say they need a measurement rather than showing $0',
    /measure to price/i.test(t) && /No price/.test(t), t.slice(0, 400))
  const zeros = await ev(ZERO_PRICE)
  check('still no $0 price anywhere', Array.isArray(zeros) && zeros.length === 0, JSON.stringify(zeros))
  check('the map is offered as a way to MEASURE, not as the way to price',
    /Measure from satellite to price the per-unit plans/.test(t), t.slice(0, 400))
}

// ── D. Phone widths ─────────────────────────────────────────────────────────
console.log('\n═══ D. 375 / 390 / 430 ═══')
for (const w of WIDTHS) {
  await setW(w)
  await sleep(1200)
  const over = await ev(OVERFLOW)
  check(`${w}px — nothing overflows the viewport`, Array.isArray(over) && over.length === 0, JSON.stringify(over))
  const small = await ev(`(() => {
    const p = ${PANEL}
    if (!p) return 'NO_PANEL'
    return [...p.querySelectorAll('button,a[href],input,select')]
      .filter(el => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0 && r.height < 40 })
      .map(el => (el.textContent||el.tagName).trim().slice(0, 30))
  })()`)
  check(`${w}px — no control in the panel under 40px`, Array.isArray(small) && small.length === 0, JSON.stringify(small))
  const stacked = await ev(`(() => {
    const p = ${PANEL}
    if (!p) return null
    const bs = [...p.querySelectorAll('button')].filter(b => /Use |Offer all/.test(b.textContent||''))
    if (bs.length < 2) return 'single-action'
    const [a, b] = bs.map(x => x.getBoundingClientRect())
    return a.top !== b.top ? 'stacked' : 'side-by-side'
  })()`)
  check(`${w}px — the two primary actions stack rather than crush`,
    stacked === 'stacked' || stacked === 'single-action' || stacked === null, String(stacked))
}
await setW(1280, false)
await sleep(1000)
const overDesk = await ev(OVERFLOW)
check('desktop — nothing overflows', Array.isArray(overDesk) && overDesk.length === 0, JSON.stringify(overDesk))

try { ws.close() } catch {}
try { chrome.kill() } catch {}
try { rmSync(profile, { recursive: true, force: true }) } catch {}
console.log(`\n${fails === 0 ? '✅ recurring quote flow drives correctly in the real app' : `❌ ${fails} check(s) failed`}`)
process.exit(fails === 0 ? 0 : 1)
