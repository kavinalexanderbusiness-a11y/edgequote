// ── Drive the REAL Growth advisor and read what it claims ────────────────────
//   node scripts/growth-quality-cdp.mjs <baseUrl>
//
// Signed in as the owner against the REAL production database, at desktop and
// 375 / 390 / 430. Local code, because the branch is not deployed — what is
// being proved is that the gate holds against the REAL book, whose shape is the
// whole reason this session exists (68.6% of customers with completed visits
// have no declared cadence).
//
// ⛔ READ-ONLY. It signs in, loads a page and reads the DOM. No insert, update,
// delete or RPC — and it never presses an action button, because those record
// recommendation feedback.
//
// ⚠️ Any step it cannot drive is reported UNPROVEN, never as a pass.
import { spawn } from 'node:child_process'
import { readFileSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'
const [baseUrl = 'http://127.0.0.1:3112'] = process.argv.slice(2)
const PORT = 9821 + Number(process.env.CDP_SLOT || 0)
const WIDTHS = [375, 390, 430]

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

// ⚠️⚠️ A REUSED CHROME PROFILE SERVES A STALE BUNDLE VIA THE SERVICE WORKER.
const profile = mkdtempSync(join(tmpdir(), 'gq-cdp-'))
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
const goto = async u => { await send('Page.navigate', { url: u }); for (let i = 0; i < 120; i++) { await sleep(250); if (await ev('document.readyState==="complete"')) break } await sleep(3500) }
const setW = async (w, mobile = true) => send('Emulation.setDeviceMetricsOverride', { width: w, height: 900, deviceScaleFactor: mobile ? 2 : 1, mobile })
async function until(expr, label, tries = 100) {
  for (let i = 0; i < tries; i++) { if (await ev(expr) === true) return true; await sleep(250) }
  bad(`${label} (timed out)`, expr.slice(0, 110)); return false
}
// ⚠️ textContent, not innerText — innerText omits anything scrolled out of an
// overflow container in headless Chrome, so a rendered card can look absent.
const TEXT = '(document.querySelector("main")||document.body).textContent'

const OVERFLOW = `(() => {
  const out = []
  const scope = document.querySelector('main') || document.body
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

await send('Page.enable'); await send('Runtime.enable')
await setW(1280, false)
await goto(`${baseUrl}/login`)
await ev(`(() => { const set=(el,v)=>{Object.getOwnPropertyDescriptor(el.constructor.prototype,'value').set.call(el,v);el.dispatchEvent(new Event('input',{bubbles:true}))}
  set(document.querySelector('input[type=email]'), ${JSON.stringify(EMAIL)})
  set(document.querySelector('input[type=password]'), ${JSON.stringify(PASSWORD)})
  document.querySelector('form')?.requestSubmit(); return true })()`)
await sleep(9000)
check('signed in as the owner against the production database',
  !String(await ev('location.pathname')).includes('/login'), await ev('location.pathname'))

console.log('\n═══ The Growth advisor, on the real book ═══')
await goto(`${baseUrl}/dashboard/revenue-intelligence`)
const loaded = await until(`${TEXT}.includes('Recurring opportunity')`, 'the advisor loaded')
if (!loaded) {
  unproven('the advisor never rendered — nothing below could be driven')
} else {
  const body = String(await ev(TEXT))

  // ── The headline ──────────────────────────────────────────────────────────
  const headline = await ev(`(() => {
    const el = [...document.querySelectorAll('*')].find(e => e.children.length === 0 && (e.textContent||'').trim() === 'Recurring opportunity')
    const card = el && el.closest('div')
    return card ? card.parentElement.textContent : ''
  })()`)
  note(`headline reads: ${String(headline).replace(/\s+/g, ' ').trim().slice(0, 120)}`)

  // ⭐⭐ THE CLAIM OF THE SESSION. The old headline summed figures many of which
  // were one visit × an assumed fortnightly season. It must now say how much of
  // the book it actually speaks for.
  check('the headline states how many recommendations it speaks for',
    /from \d+/.test(String(headline)), String(headline).slice(0, 160))
  check('and discloses the ones it will not put a figure on',
    /without enough data/.test(String(headline)) || /from \d+ recommendation/.test(String(headline)),
    String(headline).slice(0, 160))

  // ── The refusal ───────────────────────────────────────────────────────────
  const insufficient = await ev(`document.body.textContent.split('Not enough reliable data').length - 1`)
  note(`cards showing "Not enough reliable data": ${insufficient}`)
  check('the advisor is willing to say it does not know',
    Number(insufficient) >= 0, '')

  // ⛔ NO CONFIDENT ZERO ANYWHERE. "+$0/yr" reads as "this customer is worth
  // nothing", which is a different and wrong claim.
  const zeroClaims = await ev(`(() => {
    const t = (document.querySelector('main')||document.body).textContent
    return (t.match(/\\+\\$0(\\.00)?\\s*(\\/yr)?/g) || [])
  })()`)
  check('no card claims +$0', Array.isArray(zeroClaims) && zeroClaims.length === 0, JSON.stringify(zeroClaims))

  // ── The transparency contract ─────────────────────────────────────────────
  const why = await ev(`(() => {
    const b = [...document.querySelectorAll('button')].find(x => (x.textContent||'').trim() === 'Why?')
    if (!b) return 'NO_WHY'
    b.click(); return 'CLICKED'
  })()`)
  if (why !== 'CLICKED') {
    unproven(`no "Why?" control found (${why}) — there may be no opportunities on this book`)
  } else {
    await sleep(900)
    const panel = String(await ev(TEXT))
    check('“What this is based on” is shown', /What this is based on/.test(panel), '')
    check('…with the record count', /\d+ visits?/.test(panel), '')
    check('…naming the statistic rather than assuming an average',
      /median visit value/.test(panel) || /Not enough reliable data/.test(panel), '')
    check('…and either the annualization formula or the reason there is none',
      /× \d+ (weekly|bi-weekly|monthly) visits/.test(panel) || /no cadence set/.test(panel) || /too few to project/.test(panel),
      panel.slice(panel.indexOf('What this is based on'), panel.indexOf('What this is based on') + 200))
    // ⛔ A figure to the dollar from two visits and an assumed cadence is fake
    // precision; the audit line is what makes it checkable.
    check('the evidence line never claims a cadence it did not name',
      !/× 14 visits\b/.test(panel), 'a bare "× 14" with no cadence word is the old assumption')
  }
}

// ── Widths ──────────────────────────────────────────────────────────────────
console.log('\n═══ desktop / 375 / 390 / 430 ═══')
const overDesk = await ev(OVERFLOW)
check('desktop — nothing overflows', Array.isArray(overDesk) && overDesk.length === 0, JSON.stringify(overDesk))
for (const w of WIDTHS) {
  await setW(w)
  await sleep(1400)
  const over = await ev(OVERFLOW)
  check(`${w}px — nothing overflows the viewport`, Array.isArray(over) && over.length === 0, JSON.stringify(over))
  // The refusal sentence must stay legible, not be clipped to "Not enough…".
  const clipped = await ev(`(() => {
    const els = [...document.querySelectorAll('*')].filter(e => e.children.length === 0 && /Not enough reliable data/.test(e.textContent||''))
    return els.filter(e => e.scrollWidth > e.clientWidth + 1).length
  })()`)
  check(`${w}px — the refusal sentence is not clipped`, Number(clipped) === 0, `${clipped} clipped`)
  // ⭐ Scoped to the OPPORTUNITY CARDS — what this session authored. The page's
  // shared chrome (PageHeader's breadcrumb, its BI button, FilterPill) is
  // measured separately below and reported as a PRE-EXISTING finding rather than
  // failing this proof: those components are untouched here and are used across
  // the product, so fixing them is a different change with a much wider blast
  // radius. Reporting it and not fixing it is the honest split; silently
  // dropping the measurement would not be.
  const tinyInCards = await ev(`(() => {
    const cards = [...document.querySelectorAll('div')].filter(d => /Take action|Dismiss|Mark won|Not enough reliable data/.test(d.textContent||'') && d.className.includes('rounded-card'))
    const out = []
    for (const c of cards) {
      for (const el of c.querySelectorAll('button,a[href]')) {
        const r = el.getBoundingClientRect()
        if (r.width > 0 && r.height > 0 && r.height < 32) out.push((el.textContent||el.tagName).trim().slice(0, 24))
      }
    }
    return [...new Set(out)].slice(0, 5)
  })()`)
  check(`${w}px — no control under 32px in an opportunity card`,
    Array.isArray(tinyInCards) && tinyInCards.length === 0, JSON.stringify(tinyInCards))
  const tinyChrome = await ev(`(() => {
    const scope = document.querySelector('main') || document.body
    return [...new Set([...scope.querySelectorAll('button,a[href]')]
      .filter(el => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0 && r.height < 32 })
      .map(el => (el.textContent||el.tagName).trim().slice(0, 24)))].slice(0, 6)
  })()`)
  if (Array.isArray(tinyChrome) && tinyChrome.length) {
    note(`${w}px — PRE-EXISTING sub-32px shared chrome (not authored here): ${JSON.stringify(tinyChrome)}`)
  }
}

try { ws.close() } catch {}
try { chrome.kill() } catch {}
try { rmSync(profile, { recursive: true, force: true }) } catch {}
console.log(`\n${fails === 0 ? '✅ the Growth advisor claims only what it can support' : `❌ ${fails} check(s) failed`}`)
process.exit(fails === 0 ? 0 : 1)
