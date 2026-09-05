// ── Browser proof: the duplicate-worker warning, on the real Workforce page ──
//   node scripts/workforce-identity-cdp.mjs [baseUrl]
//
// ⛔⛔ READ-ONLY. It signs in, navigates, expands a warning, and reads the DOM.
// It creates no technician, edits none, and deletes none — the whole point of
// this lane is that worker rows carry statutory payroll history, so a proof that
// wrote to the roster would contradict the thing it is proving.
//
// ⭐ It needs no seeded data: the live roster already contains both shapes this
// surface exists to render — one pair with real evidence (a shared phone) and
// one pair sharing only a name, which must read as UNCERTAIN and never as a
// duplicate.
//
// Widths: desktop, 430, 390, 375.
import { spawn } from 'node:child_process'
import { readFileSync } from 'node:fs'

const CHROME = process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe'
// ⚠️ A DISTINCT PORT, deliberately. A stale `next start` from another worktree
// was holding :3000, and this proof happily drove it — the page rendered, the
// roster looked right, and the card was simply absent because that build did not
// contain it. Nothing said so. Pin the port this worktree serves on.
const base = process.argv[2] || 'http://localhost:3113'
const PORT = 9463
const profile = (process.env.TEMP || '.') + '/eq-wf-identity-' + PORT
const E = Object.fromEntries(readFileSync('.env.local', 'utf8')
  .split(/\r?\n/).map(l => l.match(/^([A-Z_0-9]+)=(.*)$/)).filter(Boolean).map(m => [m[1], m[2].trim()]))

let failures = 0
const ok = n => console.log(`     ✓ ${n}`)
const fail = (n, d = '') => { failures++; console.log(`     ✗ ${n}${d ? `\n         ${d}` : ''}`) }
const check = (n, c, d = '') => c ? ok(n) : fail(n, d)
const sleep = ms => new Promise(r => setTimeout(r, ms))

const chrome = spawn(CHROME, ['--headless=new', '--disable-gpu', '--no-sandbox',
  `--remote-debugging-port=${PORT}`, '--user-data-dir=' + profile, 'about:blank'], { stdio: 'ignore' })
async function wsUrl() {
  for (let i = 0; i < 120; i++) { try { return (await (await fetch(`http://127.0.0.1:${PORT}/json/version`)).json()).webSocketDebuggerUrl } catch { await sleep(250) } }
  throw new Error('chrome did not open a debugging port')
}
const ws = new WebSocket(await wsUrl())
await new Promise(r => ws.addEventListener('open', r, { once: true }))
let id = 0; const pending = new Map()
ws.addEventListener('message', e => { const m = JSON.parse(e.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id) } })
const send = (method, params = {}, sid) => new Promise((res, rej) => {
  const n = ++id; pending.set(n, m => m.error ? rej(new Error(m.error.message)) : res(m.result))
  ws.send(JSON.stringify({ id: n, method, params, sessionId: sid }))
})
const { targetId } = await send('Target.createTarget', { url: 'about:blank' })
const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true })
const S = (m, p) => send(m, p, sessionId)
await S('Page.enable'); await S('Runtime.enable')
const ev = expr => S('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true }).then(r => r.result.value)

// ── Sign in once, as the owner ───────────────────────────────────────────────
await S('Emulation.setDeviceMetricsOverride', { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false, screenWidth: 1280, screenHeight: 900 })
await S('Page.navigate', { url: base + '/login' })
await sleep(4000)
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
const signedIn = !(await ev(`location.pathname.startsWith('/login')`))
console.log(`\n═══ Workforce — duplicate-worker warning (${signedIn ? 'signed in' : 'NOT SIGNED IN'}) ═══`)
if (!signedIn) { fail('owner sign-in'); chrome.kill(); process.exit(1) }

// ⛔ The words that must NEVER appear as an action on this card.
const DESTRUCTIVE = /\b(merge|combine|delete|remove|archive|unarchive|dismiss)\b/i

const WIDTHS = [
  { label: 'desktop', w: 1280, h: 900, mobile: false },
  { label: '430', w: 430, h: 932, mobile: true },
  { label: '390', w: 390, h: 844, mobile: true },
  { label: '375', w: 375, h: 812, mobile: true },
]

for (const v of WIDTHS) {
  console.log(`\n  ── ${v.label} ──`)
  await S('Emulation.setDeviceMetricsOverride', { width: v.w, height: v.h, deviceScaleFactor: 2, mobile: v.mobile, screenWidth: v.w, screenHeight: v.h })
  await S('Page.navigate', { url: base + '/dashboard/workforce' })
  await sleep(6500)

  // Expand the first warning, so the history counts and the refusal sentence render.
  // ⚠️ Target the FINDING ROW by its own confidence label. An earlier version
  // searched `document.querySelectorAll('*')` for an element containing the card
  // heading — which matches <html> first, so it clicked the first aria-expanded
  // button in the whole document and then reported the card as "expanded".
  await ev(`(() => {
    const b = [...document.querySelectorAll('button[aria-expanded]')]
      .find(x => /Might be the same person|Likely the same person|Same sign-in account/i.test(x.innerText||''))
    if (b) b.click()
    return !!b
  })()`)
  await sleep(2500)
  // Reveal the uncertain section too.
  await ev(`(() => {
    const b = [...document.querySelectorAll('button')].find(x => /sharing a name/i.test(x.textContent||''))
    if (b && b.getAttribute('aria-expanded') === 'false') b.click()
    return !!b
  })()`)
  await sleep(1200)

  const r = await ev(`(() => {
    const de = document.documentElement
    // ⚠️ Walk UP from the heading until the ancestor actually holds the whole
    // card. An earlier version took the INNERMOST element containing the
    // heading, which is the heading's own <p> — so every text assertion below it
    // read a fragment and failed for the wrong reason.
    const heading = [...document.querySelectorAll('p,h1,h2,h3')]
      .find(e => /Possible duplicate worker records/.test(e.textContent || ''))
    let scope = heading
    while (scope && scope.parentElement) {
      const t = scope.innerText || ''
      // The card is the smallest ancestor carrying the heading AND the controls.
      if (/Possible duplicate worker records/.test(t) && /Review|sharing a name/.test(t)) break
      scope = scope.parentElement
    }
    if (scope === document.body) scope = null
    const cardText = scope ? scope.innerText : ''
    // Buttons INSIDE the warning card only.
    const cardButtons = scope ? [...scope.querySelectorAll('button')].map(b => (b.innerText||'').trim()).filter(Boolean) : []
    // Anything wider than the viewport, anywhere on the page.
    const over = [...document.querySelectorAll('*')].filter(el => {
      const b = el.getBoundingClientRect()
      return b.width > 0 && (b.right > de.clientWidth + 1 || b.left < -1)
    }).slice(0,5).map(el => el.tagName.toLowerCase() + (typeof el.className==='string'&&el.className ? '.'+el.className.trim().split(/\\s+/).slice(0,3).join('.') : ''))
    // The card's own box must sit inside the viewport.
    const cardBox = scope ? (() => { const b = scope.getBoundingClientRect(); return { l: Math.round(b.left), r: Math.round(b.right), w: Math.round(b.width) } })() : null
    const body = document.body.innerText
    return {
      present: !!scope, cardText, cardButtons, over, cardBox,
      // ⭐ Elements overflowing INSIDE MY CARD — the only ones this lane can be
      // responsible for. The page-wide scan is reported separately, because the
      // Workforce page already carries wide timesheet and stat strips that
      // predate this work; attributing those here would make the check noise.
      cardOver: scope ? [...scope.querySelectorAll("*")].filter(el => {
        const b = el.getBoundingClientRect()
        return b.width > 0 && (b.right > de.clientWidth + 1 || b.left < -1)
      }).slice(0,5).map(el => el.tagName.toLowerCase()) : [],
      expandedCount: scope ? [...scope.querySelectorAll('[aria-expanded="true"]')].length : 0,
      scrollW: de.scrollWidth, clientW: de.clientWidth,
      rosterHeadings: [...document.querySelectorAll('h1,h2,h3')].map(h=>h.textContent.trim()).filter(Boolean).slice(0,8),
      rosterNames: /Nicole Blackburn/.test(body) && /Kavin Alexander/.test(body),
      bodyLen: body.length,
    }
  })()`)

  check('the warning card is present', r.present, 'the live roster has one real finding and one uncertain pair')
  check('…and it is EXPANDED, so what follows is really being read',
    r.expandedCount >= 1,
    'an assertion over a collapsed card proves only that the card is collapsed')
  // ⭐ THE rule a person actually feels: the PAGE must not scroll sideways.
  check('the page does not scroll sideways',
    r.scrollW <= r.clientW + 1,
    `scrollWidth ${r.scrollW} vs ${r.clientW}`)
  // ⛔ And nothing in MY card may stick out. Scoped deliberately, so a
  // pre-existing wide strip elsewhere on this page can neither pass nor fail
  // this lane's work — attribute a responsive result, never infer it.
  check('⭐ nothing inside the warning card overflows the viewport',
    r.cardOver.length === 0,
    `overflowing inside the card: ${r.cardOver.join(', ')}`)
  if (r.over.length) console.log(`     ℹ pre-existing wide elements elsewhere on this page (page does not scroll): ${r.over.slice(0,3).join(', ')}`)
  check('the card itself sits inside the viewport',
    !!r.cardBox && r.cardBox.l >= -1 && r.cardBox.r <= r.clientW + 1,
    `card box ${JSON.stringify(r.cardBox)} vs clientW ${r.clientW}`)

  // ⛔ THE rule: no destructive action anywhere on this card.
  const bad = r.cardButtons.filter(t => DESTRUCTIVE.test(t))
  check('⛔ NO destructive action on the card — every button is Review or a disclosure',
    bad.length === 0,
    `offending buttons: ${bad.map(b=>`“${b}”`).join(' · ')}`)
  check('…and Review is offered', r.cardButtons.some(t => /^Review\b/.test(t)),
    `buttons: ${r.cardButtons.join(' | ')}`)

  // Uncertain pairs must READ as uncertain.
  check('⭐ the uncertain pair is clearly uncertain, and never called a duplicate',
    /not enough information to tell/i.test(r.cardText)
    && /would answer it/i.test(r.cardText),
    'a shared name must read as "we cannot tell", not as an accusation')

  // Evidence + standing + history counts.
  check('the finding says WHY it was flagged',
    /Same phone|Same email|Same sign-in account|Same invitation/i.test(r.cardText),
    'evidence must be named, not implied')
  check('active/archived standing is shown for each record',
    /Active/.test(r.cardText) && /(Former|Paused)/.test(r.cardText),
    'a rehire pair reads completely differently from two live records')
  check('linked history counts render (the reason there is no merge)',
    /linked record/i.test(r.cardText) && /shifts/.test(r.cardText),
    r.cardText.slice(0, 700))
  check('…and the refusal sentence is present',
    /not available|has to be done by a person/i.test(r.cardText))

  // The roster itself must still work.
  check('the normal roster still renders below the warning',
    r.rosterNames && r.bodyLen > 400,
    `bodyLen ${r.bodyLen}`)
}

console.log('\n── Summary ────────────────────────────────────────────────────')
console.log(failures === 0
  ? '\n✅ Workforce at desktop/430/390/375 — the card fits, uncertain reads uncertain, nothing destructive, standing and history render, roster intact\n'
  : `\n❌ ${failures} check(s) failed\n`)
chrome.kill()
await sleep(150)
process.exit(failures === 0 ? 0 : 1)
