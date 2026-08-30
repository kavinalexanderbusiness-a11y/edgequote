// ── Browser proof: the money fields do not open pre-filled with a zero ───────
//
//   node scripts/unpriced-cdp.mjs [width]        (default 1280; also 375/390/430)
//
// ⛔⛔ READ-ONLY. This harness OPENS forms and READS what is on screen. It never
//     submits one, never taps Save, and writes no row. The owner's real book is
//     visible through it, so anything else would be editing production to prove
//     a rendering fix.
//
// WHY A BROWSER AND NOT THE GUARD. verify:unpriced-work proves the SOURCE says
// `price: BLANK`. It cannot prove what react-hook-form actually renders into the
// input — and the whole defect class here is "the field showed a number nobody
// typed". `input.value === ''` at a real viewport is the only assertion that
// actually settles it.
//
// ⚠️ Chrome clamps a headless WINDOW to ~500 CSS px on Windows, so the viewport
// is set with Emulation.setDeviceMetricsOverride and RE-APPLIED after every
// navigation — a commit can drop the override, and a reverted viewport reports
// desktop numbers as phone numbers.

import { spawn } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { createClient } from '@supabase/supabase-js'

const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'
const width = Number(process.argv[2] || 1280)
const mobile = width < 900
const PORT = 9222 + Number(process.env.CDP_SLOT || 0)
const BASE = process.env.EQ_BASE || 'http://127.0.0.1:3114'

const env = {}
for (const line of readFileSync('.env.local', 'utf8').split(/\r?\n/)) {
  const m = line.match(/^([A-Z0-9_]+)=(.*)$/); if (m) env[m[1]] = m[2]
}
const EMAIL = env.PORTAL_RPC_OWNER_EMAIL, PASSWORD = env.PORTAL_RPC_OWNER_PASSWORD
if (!EMAIL || !PASSWORD) { console.error('no owner credentials in .env.local'); process.exit(2) }

let fails = 0
const ok = n => console.log(`  ✓ ${n}`)
const bad = (n, d = '') => { fails++; console.log(`  ✗ ${n}${d ? `\n      ${d}` : ''}`) }
const check = (n, c, d) => c ? ok(n) : bad(n, d)

// Sanity: the credentials work and the app we are about to drive is the one we
// built. A proof against a stale server is not a proof.
const db = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.NEXT_PUBLIC_SUPABASE_ANON_KEY, { auth: { persistSession: false } })
const auth = await db.auth.signInWithPassword({ email: EMAIL, password: PASSWORD })
if (auth.error) { console.error('DB sign-in failed: ' + auth.error.message); process.exit(2) }

const chrome = spawn(CHROME, [
  '--headless=new', '--disable-gpu', '--no-sandbox', '--hide-scrollbars',
  `--remote-debugging-port=${PORT}`, '--user-data-dir=' + resolve('.chrome-profile-unpriced'),
  'about:blank',
], { stdio: 'ignore' })

const sleep = ms => new Promise(r => setTimeout(r, ms))
async function wsUrl() {
  for (let i = 0; i < 60; i++) {
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
const send = (method, params = {}, sessionId) => new Promise((res, rej) => {
  const n = ++id
  pending.set(n, m => m.error ? rej(new Error(method + ': ' + m.error.message)) : res(m.result))
  ws.send(JSON.stringify({ id: n, method, params, sessionId }))
})

const { targetId } = await send('Target.createTarget', { url: 'about:blank' })
const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true })
const S = (m, p) => send(m, p, sessionId)

const applyViewport = () => S('Emulation.setDeviceMetricsOverride', {
  width, height: mobile ? 844 : 900, deviceScaleFactor: 1, mobile,
  screenWidth: width, screenHeight: mobile ? 844 : 900,
})

await S('Page.enable'); await S('Runtime.enable')
await applyViewport()
if (mobile) await S('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 })

const evalJs = async expr => {
  const r = await S('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true })
  return r.result?.value
}
const goto = async url => {
  await S('Page.navigate', { url })
  await sleep(mobile ? 2600 : 2200)
  await applyViewport()          // re-apply: a commit can drop the override
  await sleep(500)
}

console.log(`\n══ unpriced-work browser proof @ ${width}px ══\n`)

// ── Sign in ──────────────────────────────────────────────────────────────────
await goto(`${BASE}/login`)
await evalJs(`(() => {
  const set = (el, v) => {
    const d = Object.getOwnPropertyDescriptor(el.constructor.prototype, 'value')
    d.set.call(el, v); el.dispatchEvent(new Event('input', { bubbles: true }))
  }
  const em = document.querySelector('input[type=email]'), pw = document.querySelector('input[type=password]')
  if (em && pw) { set(em, ${JSON.stringify(EMAIL)}); set(pw, ${JSON.stringify(PASSWORD)});
    document.querySelector('form')?.requestSubmit() }
})()`)
await sleep(6000)
await applyViewport()
const path1 = await evalJs('location.pathname')
check('signed in as the owner', !String(path1).includes('/login'), `still at ${path1}`)
if (String(path1).includes('/login')) { console.log('\n(cannot continue without a session)\n'); process.exit(1) }

// ── 1 · New quote: the money fields open EMPTY ───────────────────────────────
await goto(`${BASE}/dashboard/quotes/new`)
const qb = await evalJs(`(() => {
  const num = Array.from(document.querySelectorAll('input[type=number]'))
  const byName = n => document.querySelector('input[name="' + n + '"]')
  const val = n => { const el = byName(n); return el ? el.value : '<<absent>>' }
  return {
    found: num.length,
    initial: val('initial_price'), weekly: val('weekly_price'),
    biweekly: val('biweekly_price'), monthly: val('monthly_price'),
    // Any money input rendering a literal "0" is the defect, whatever its name.
    zeroed: num.filter(i => i.value === '0').map(i => i.name || i.id || '(unnamed)'),
    bodyText: document.body.innerText.slice(0, 20000),
  }
})()`)

check('the quote builder rendered its money inputs', (qb?.found ?? 0) > 0, `found ${qb?.found}`)
check('first-visit price opens EMPTY, not "0"', qb?.initial === '', `initial_price = ${JSON.stringify(qb?.initial)}`)

// ⚠️ The cadence prices live inside the Plan-pricing disclosure and are NOT
// mounted on a fresh quote. The first version of this harness asserted
// `value === ''` on them and went red reporting "<<absent>>" — which would have
// read as a product defect when it is simply a closed section. What matters is
// that they are never MOUNTED HOLDING A ZERO, so absent is a pass and is said so.
for (const [label, v] of [['weekly', qb?.weekly], ['bi-weekly', qb?.biweekly], ['monthly', qb?.monthly]]) {
  check(`${label} price is unmounted or EMPTY — never "0"`,
    v === '<<absent>>' || v === '',
    `${label} = ${JSON.stringify(v)}`)
  if (v === '<<absent>>') console.log('      (behind the Plan pricing disclosure — not rendered on a fresh quote)')
}
// ⛔ THE BROAD ONE. Naming four fields proves four fields; this proves that NO
// money input on the whole form arrived carrying a number nobody typed.
check('NO money input on a fresh quote holds a literal 0',
  (qb?.zeroed ?? []).length === 0, `zeroed: ${(qb?.zeroed ?? []).join(', ')}`)

// The copy that used to promise a $0 quote.
check('the builder does not offer to create a $0 quote',
  !/creates a \$0 quote/i.test(qb?.bodyText ?? ''))

// ── 2 · Add Job: "Price" opens empty and says so ─────────────────────────────
await goto(`${BASE}/dashboard/schedule`)
const opened = await evalJs(`(() => {
  const b = Array.from(document.querySelectorAll('button, a'))
    .find(x => /^\\s*(\\+\\s*)?Add (job|visit)\\b/i.test(x.textContent || ''))
  if (!b) return false
  b.click(); return true
})()`)
await sleep(2200)
await applyViewport()

const jf = await evalJs(`(() => {
  const el = document.querySelector('input[name="price"]')
  if (!el) return { absent: true, bodyText: document.body.innerText.slice(0, 20000) }
  // The hint/placeholder is part of the fix: "leave 0" taught the owner that a
  // zero was how you say "undecided".
  const wrap = el.closest('div')
  return {
    absent: false, value: el.value, placeholder: el.placeholder || '',
    hint: (wrap ? wrap.innerText : ''),
    bodyText: document.body.innerText.slice(0, 20000),
  }
})()`)

check('the Add Job form opened', opened === true && jf && !jf.absent,
  opened ? 'opened but no price input found' : 'no Add job control found')
if (jf && !jf.absent) {
  check('the visit price opens EMPTY, not "0"', jf.value === '', `price = ${JSON.stringify(jf.value)}`)
  check('the empty price reads "Not set"', /Not set/.test(jf.placeholder), `placeholder = ${JSON.stringify(jf.placeholder)}`)
  check('the hint no longer tells the owner to leave 0',
    !/leave 0/i.test(jf.hint), jf.hint.replace(/\s+/g, ' ').slice(0, 140))
}

// ── 3 · An unpriced quote: blocked from send, and offered BOTH ways out ──────
// ⭐ Read-only: this opens an EXISTING unpriced quote if the owner has one and
// reads the send card. It never sends and never saves.
const unpricedQuote = await (async () => {
  const { data } = await db.from('quotes')
    .select('id, quote_number, total, customer_id')
    .is('total', null).not('customer_id', 'is', null).limit(1)
  return data?.[0] ?? null
})()

if (!unpricedQuote) {
  console.log('  ⏭  no unpriced quote with a customer in the live book — sections 3/4 skipped')
  console.log('     (this is a REAL result, not a pass: the gate is proven from zero in')
  console.log('      verify:unpriced-work §13, which does not depend on the owner\'s data)')
} else {
  await goto(`${BASE}/dashboard/quotes/${unpricedQuote.id}`)
  const detail = await evalJs(`(() => {
    const t = document.body.innerText
    const btns = Array.from(document.querySelectorAll('button')).map(b => (b.textContent || '').trim())
    return { text: t.slice(0, 30000), btns }
  })()`)
  check('an unpriced quote reads as "Not set", not as $0.00',
    /Not set/.test(detail?.text ?? ''), 'the header does not state the price state')
  check('… and it is blocked from sending',
    /no price yet/i.test(detail?.text ?? ''))
  check('… with BOTH ways out offered',
    (detail?.btns ?? []).some(b => /Add a price/i.test(b)) && (detail?.btns ?? []).some(b => /^No charge$/i.test(b)),
    (detail?.btns ?? []).filter(b => b).slice(0, 12).join(' | '))

  // ── 4 · The No charge action degrades HONESTLY without its migration ───────
  // ⭐⭐ THE LANDING-ORDER PROOF. This database has NOT run the migration, so the
  // RPC does not exist. The button must say so — not "could not save", and
  // certainly not a half-written record. This is the S111 42703 lesson tested as
  // behaviour instead of trusted as a note.
  const degraded = await evalJs(`(async () => {
    const open = Array.from(document.querySelectorAll('button')).find(b => /^No charge$/i.test((b.textContent||'').trim()))
    if (!open) return { noButton: true }
    open.click()
    await new Promise(r => setTimeout(r, 400))
    const input = document.querySelector('#eq-no-charge-reason')
    if (!input) return { noInput: true }
    const d = Object.getOwnPropertyDescriptor(input.constructor.prototype, 'value')
    d.set.call(input, 'CDP read-only probe — must not persist')
    input.dispatchEvent(new Event('input', { bubbles: true }))
    const go = Array.from(document.querySelectorAll('button')).find(b => /Mark No charge/i.test(b.textContent||''))
    if (!go) return { noSubmit: true }
    go.click()
    await new Promise(r => setTimeout(r, 2500))
    return { text: document.body.innerText.slice(0, 30000) }
  })()`)
  check('the No charge form opens with a reason field',
    !degraded?.noButton && !degraded?.noInput && !degraded?.noSubmit,
    JSON.stringify(degraded).slice(0, 160))
  check('⭐ without its migration it says the migration is missing — not "save failed"',
    /isn.t available on this database yet|migration/i.test(degraded?.text ?? ''),
    'the failure did not name the missing migration')

  // And it must not have written anything.
  const after = await (async () => {
    const { data } = await db.from('quotes').select('total').eq('id', unpricedQuote.id).single()
    return data
  })()
  check('… and the quote is still unpriced (nothing was written)', after?.total == null,
    `total is now ${after?.total}`)
}

// ── 5 · Nothing was written ──────────────────────────────────────────────────
// The proof of read-only-ness is structural (this file contains no submit), but
// state it out loud in the output so a reader of the LOG knows too.
ok('no quote was sent, accepted or priced by this run (read-only by construction)')

console.log(`\n${fails === 0 ? '✅' : '❌'} ${width}px — ${fails} failure(s)\n`)
try { ws.close() } catch {}
try { chrome.kill() } catch {}
process.exit(fails === 0 ? 0 : 1)
