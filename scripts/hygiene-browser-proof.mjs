// ── Real customer-facing browser proof, with DISPOSABLE fixture data ─────────
//   node scripts/hygiene-browser-proof.mjs [baseUrl]
//
// The earlier viewport pass only ever reached the pre-token shell, which is not
// enough for a customer-facing change. This one signs in as the owner, seeds
// disposable services covering the states that must and must not be visible,
// drives the REAL booking page with the REAL booking token at four widths, and
// removes everything it created.
//
// ⛔⛔ WHAT IT WILL NOT DO, and these are load-bearing:
//   · It never mutates a real customer, quote, job or invoice. It creates only
//     service_templates rows it names itself, and deletes exactly those.
//   · It never uses a real customer's portal token for a mutation. The portal
//     half is a REFUSAL test against a forged token — proving nothing leaks —
//     which needs no real customer at all.
//   · It publishes nothing and unpublishes nothing. Where `published_at` does
//     not exist yet, it says so and reports which assertions it therefore could
//     not make, rather than quietly proving less than it claims.
//
// ⚠️ It writes to the owner's real tenant. The rows it adds are INACTIVE or
// Tier-1-named, so even in the window they exist they are either switched off or
// excluded — and the cleanup runs in a finally.
import { spawn } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { createClient } from '@supabase/supabase-js'

const CHROME = process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe'
const base = process.argv[2] || 'http://localhost:3000'
const PORT = 9457
const profile = (process.env.TEMP || '.') + '/eq-hyg-proof-' + PORT
const E = Object.fromEntries(readFileSync('.env.local', 'utf8')
  .split(/\r?\n/).map(l => l.match(/^([A-Z_0-9]+)=(.*)$/)).filter(Boolean).map(m => [m[1], m[2].trim()]))

let failures = 0
const ok = n => console.log(`     ✓ ${n}`)
const fail = (n, d = '') => { failures++; console.log(`     ✗ ${n}${d ? `\n         ${d}` : ''}`) }
const check = (n, c, d = '') => c ? ok(n) : fail(n, d)
const sleep = ms => new Promise(r => setTimeout(r, ms))

// ⭐ Every row this script creates carries a Tier-1 marker in its name, so if the
// cleanup ever fails the leftovers are already excluded from customers, capacity
// and analytics by the very rule under test — and hygiene-report will list them.
const RUN = `ZZ-PROOF-${Date.now().toString(36).toUpperCase()}`
const SEED = [
  { key: 'active_clean', name: `${RUN} ACTIVE CLEAN`, rate: 199, is_active: true },
  { key: 'inactive', name: `${RUN} INACTIVE`, rate: 199, is_active: false },
  { key: 'fixture_dollar', name: `${RUN} FIXTURE DOLLAR`, rate: 1, is_active: true },
]

const sb = createClient(E.NEXT_PUBLIC_SUPABASE_URL, E.NEXT_PUBLIC_SUPABASE_ANON_KEY, { auth: { persistSession: false } })
const created = []
let chrome

try {
  const { data: auth, error: authErr } = await sb.auth.signInWithPassword({
    email: E.PORTAL_RPC_OWNER_EMAIL, password: E.PORTAL_RPC_OWNER_PASSWORD,
  })
  if (authErr || !auth?.user) throw new Error('owner sign-in failed: ' + (authErr?.message ?? 'no session'))
  const uid = auth.user.id
  console.log(`\n═══ Browser proof — owner session uid …${uid.slice(-6)} ═══`)

  const { data: bs } = await sb.from('business_settings').select('booking_token, booking_enabled').maybeSingle()
  if (!bs?.booking_token || !bs.booking_enabled) throw new Error('no live booking token — cannot drive the real page')
  const token = bs.booking_token

  // Does the publication column exist on THIS database?
  const probe = await sb.from('service_templates').select('published_at').limit(1)
  const HAS_PUB = !(probe.error && /published_at/.test(probe.error.message))
  console.log(HAS_PUB
    ? '  published_at EXISTS — internal-vs-published is provable here.'
    : '  ⚠️  published_at does NOT exist on this database (migration unapplied).\n     The INTERNAL-vs-PUBLISHED assertions are therefore NOT made below; they are\n     proven from zero instead by npm run verify:publication-cutover.')

  for (const s of SEED) {
    const row = { user_id: uid, name: s.name, category: 'General', default_rate: s.rate, is_active: s.is_active, sort_order: 900 }
    const { data, error } = await sb.from('service_templates').insert(row).select('id').single()
    if (error) throw new Error(`could not seed ${s.name}: ${error.message}`)
    created.push(data.id)
  }
  console.log(`  seeded ${created.length} disposable service(s), all Tier-1 named.`)

  // ── The API the website actually reads ────────────────────────────────────
  const anon = createClient(E.NEXT_PUBLIC_SUPABASE_URL, E.NEXT_PUBLIC_SUPABASE_ANON_KEY)
  const pub = await anon.rpc('public_services', { p_token: token })
  const pubNames = (pub.data?.services ?? []).map(x => x.name)
  console.log('\n  ── PUBLIC CATALOGUE (public_services, anonymous) ──')
  check('the inactive disposable service is NOT public',
    !pubNames.includes(`${RUN} INACTIVE`))
  if (HAS_PUB) {
    check('⭐ an unpublished (INTERNAL) service is NOT public',
      !pubNames.includes(`${RUN} ACTIVE CLEAN`))
    check('⭐ a Tier-1 FIXTURE service is NOT public',
      !pubNames.includes(`${RUN} FIXTURE DOLLAR`))
  } else {
    // ⛔ Reported as NOT PROVEN rather than skipped silently. On this database
    // the gate does not exist, so an active service IS public — and saying
    // otherwise would be the false all-clear again.
    const leaked = pubNames.filter(n => n.startsWith(RUN))
    console.log(`     ▢ NOT PROVEN here — no publication gate on this database.`)
    console.log(`         Measured consequence: ${leaked.length} of this run's active services ARE`)
    console.log(`         publicly listed right now (${leaked.join(', ') || 'none'}).`)
    check('…and that is exactly the exposure the migration closes',
      leaked.length === 2,
      `expected the 2 active seeds to be exposed pre-migration, saw ${leaked.length}`)
  }

  // ── Portal: a forged token must leak nothing ──────────────────────────────
  console.log('\n  ── PORTAL (forged token — no real customer is touched) ──')
  const forged = await anon.rpc('get_portal_data', { p_token: 'forged-token-' + RUN })
  check('a forged portal token returns no customer data',
    forged.error !== null || forged.data === null,
    `returned ${JSON.stringify(forged.data)?.slice(0, 120)}`)

  // ── The rendered page, at four widths ─────────────────────────────────────
  chrome = spawn(CHROME, ['--headless=new', '--disable-gpu', '--no-sandbox',
    `--remote-debugging-port=${PORT}`, '--user-data-dir=' + profile, 'about:blank'], { stdio: 'ignore' })
  const wsUrl = async () => {
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

  const TRADE = /\b(lawn|lawns|mow|mowing|mowed|grass|turf|sod)\b/i
  const WIDTHS = [
    { label: 'desktop', w: 1280, h: 900, mobile: false },
    { label: '375', w: 375, h: 812, mobile: true },
    { label: '390', w: 390, h: 844, mobile: true },
    { label: '430', w: 430, h: 932, mobile: true },
  ]

  for (const v of WIDTHS) {
    console.log(`\n  ── BOOKING PAGE @ ${v.label} ──`)
    await S('Emulation.setDeviceMetricsOverride', { width: v.w, height: v.h, deviceScaleFactor: 2, mobile: v.mobile, screenWidth: v.w, screenHeight: v.h })
    await S('Page.navigate', { url: `${base}/book/${token}` })
    await sleep(5000)

    const r = await ev(`(() => {
      const de = document.documentElement
      const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT)
      const texts = []; let n
      while ((n = walker.nextNode())) {
        const p = n.parentElement
        if (!p || /script|style|noscript/i.test(p.tagName)) continue
        const cs = getComputedStyle(p)
        if (cs.display === 'none' || cs.visibility === 'hidden') continue
        const t = n.textContent.trim(); if (t) texts.push(t)
      }
      const attrs = [...document.querySelectorAll('[placeholder],[aria-label],[alt],[title]')]
        .flatMap(el => ['placeholder','aria-label','alt','title'].map(a => el.getAttribute(a)).filter(Boolean))
      const over = [...document.querySelectorAll('*')].filter(el => {
        const b = el.getBoundingClientRect()
        return b.width > 0 && (b.right > de.clientWidth + 1 || b.left < -1)
      }).slice(0, 5).map(el => el.tagName.toLowerCase() + (typeof el.className === 'string' && el.className ? '.' + el.className.trim().split(/\\s+/).slice(0,3).join('.') : ''))
      return { scrollW: de.scrollWidth, clientW: de.clientWidth, over, texts, attrs, bodyLen: document.body.innerText.length }
    })()`)

    const copy = [...r.texts, ...r.attrs]
    const all = copy.join(' | ')
    const reached = /Where is the property|Approximate area|Estimated area|Confirm the area/i.test(all)
    console.log(`     rendered ${r.bodyLen} chars · ${reached ? '▣ reached the ADDRESS/MEASURE form' : '▢ pre-token shell only'}`)

    const offenders = copy.filter(s => TRADE.test(s))
    check('no lawn-specific platform copy anywhere on the page',
      offenders.length === 0, offenders.map(s => `“${s}”`).join(' · '))
    check('generic universal wording is present',
      /Instant quote|Measured area|Where is the property|Approximate area|the area/i.test(all),
      'removing the trade word is only half the fix')
    check('the page fits its viewport (no horizontal overflow)',
      r.scrollW <= r.clientW + 1 && r.over.length === 0,
      `scrollWidth ${r.scrollW} vs ${r.clientW}${r.over.length ? ' — ' + r.over.join(', ') : ''}`)
    check('⛔ no Tier-1 fixture service is rendered to the customer',
      !all.includes(`${RUN} FIXTURE`), 'a fixture row reached a customer-facing page')
    check('⛔ no INACTIVE service is rendered to the customer',
      !all.includes(`${RUN} INACTIVE`))
  }
} catch (e) {
  fail('the proof could not run', String(e?.message ?? e))
} finally {
  // ⭐ Cleanup runs whatever happened, and REPORTS what it removed rather than
  // assuming. Rows left behind would be listed by hygiene-report next run.
  if (created.length) {
    const { error } = await sb.from('service_templates').delete().in('id', created)
    const { data: left } = await sb.from('service_templates').select('id').in('id', created)
    check(`cleanup removed all ${created.length} disposable service(s)`,
      !error && (left ?? []).length === 0,
      error?.message ?? `${(left ?? []).length} row(s) remain — they are Tier-1 named, so they are already excluded`)
  }
  await sb.auth.signOut({ scope: 'local' }).catch(() => {})
  if (chrome) chrome.kill()
  console.log('\n── Summary ────────────────────────────────────────────────────')
  console.log(failures === 0
    ? '\n✅ customer-facing proof: fixture and inactive services never render, wording is generic, nothing overflows, a forged token leaks nothing\n'
    : `\n❌ ${failures} check(s) failed\n`)
  await sleep(150)
  process.exit(failures === 0 ? 0 : 1)
}
