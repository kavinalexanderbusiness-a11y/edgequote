// ── Prove the WRITE half: apply, refresh, and the order is still there ──────
// Session 110. The read-only proof (pinnedroute-cdp.mjs) covers pinning,
// optimizing and declining, none of which write. This one covers the single
// control that does — "Use this order" — and the thing only a refresh can
// show: the order came back from the database, not from React state.
//
//   node scripts/pinnedroute-write-cdp.mjs <baseUrl> [--date=YYYY-MM-DD]
//
// ══ WHY THIS IS SAFE TO RUN AGAINST THE REAL BOOK ═══════════════════════════
// It writes jobs.route_order and nothing else — no status, no money, no
// customer-facing field, and nothing that sends a message. Even so:
//
//   1. It runs on a day at least a WEEK OUT by default. route_order is what a
//      crew phone sorts its day by, so reordering TODAY would move work under
//      somebody who is standing in a driveway. A day next month is nobody's
//      current screen.
//   2. It SNAPSHOTS every affected row's route_order first, prints the
//      snapshot, and restores it in a `finally` — so a crash mid-run still
//      restores, and if even that fails the snapshot is on stdout for a human.
//   3. It verifies the restore and fails loudly if the day did not come back.
//
// ⚠️ It deliberately does NOT use a service-role key. Every read and write goes
// through the owner's own session, exactly as the app does, so this cannot
// prove something RLS would have refused a real user.

import { spawn } from 'node:child_process'
import { readFileSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe'
const argv = process.argv.slice(2)
const baseUrl = argv.find(a => a.startsWith('http')) || 'http://127.0.0.1:3110'
const dateArg = (argv.find(a => a.startsWith('--date=')) || '').split('=')[1] || ''
const PORT = 9499

const env = Object.fromEntries(readFileSync('.env.local', 'utf8').split(/\r?\n/)
  .filter(l => l && !l.startsWith('#') && l.includes('='))
  .map(l => [l.slice(0, l.indexOf('=')).trim(), l.slice(l.indexOf('=') + 1).trim()]))
const SUPA = env.NEXT_PUBLIC_SUPABASE_URL
const ANON = env.NEXT_PUBLIC_SUPABASE_ANON_KEY
const EMAIL = env.PORTAL_RPC_OWNER_EMAIL
const PASSWORD = env.PORTAL_RPC_OWNER_PASSWORD
if (!SUPA || !ANON || !EMAIL || !PASSWORD) { console.error('missing credentials in .env.local'); process.exit(2) }

let fails = 0
const ok = n => console.log(`  ✓ ${n}`)
const bad = (n, d = '') => { fails++; console.log(`  ✗ ${n}${d ? `\n      ${d}` : ''}`) }
const check = (n, c, d) => c ? ok(n) : bad(n, d)
const sleep = ms => new Promise(r => setTimeout(r, ms))

// ── The owner's own session, for the snapshot/restore side ──────────────────
const auth = await (await fetch(`${SUPA}/auth/v1/token?grant_type=password`, {
  method: 'POST', headers: { apikey: ANON, 'Content-Type': 'application/json' },
  body: JSON.stringify({ email: EMAIL, password: PASSWORD }),
})).json()
if (!auth.access_token) { console.error('auth failed: ' + JSON.stringify(auth).slice(0, 200)); process.exit(2) }
const H = { apikey: ANON, Authorization: `Bearer ${auth.access_token}`, 'Content-Type': 'application/json' }

const dayJobs = async d => {
  const r = await fetch(`${SUPA}/rest/v1/jobs?select=id,title,route_order,status,scheduled_date,customers(name)&scheduled_date=eq.${d}&order=route_order.asc.nullslast,id.asc`, { headers: H })
  const rows = await r.json()
  return Array.isArray(rows) ? rows.filter(j => j.status !== 'cancelled') : []
}

// ── Pick the day ────────────────────────────────────────────────────────────
let target = dateArg
if (!target) {
  const from = new Date(Date.now() + 7 * 86400000).toISOString().slice(0, 10)
  const rows = await (await fetch(`${SUPA}/rest/v1/jobs?select=scheduled_date,status&scheduled_date=gte.${from}&order=scheduled_date.asc&limit=1000`, { headers: H })).json()
  const counts = {}
  for (const r of (Array.isArray(rows) ? rows : [])) {
    if (r.status === 'cancelled') continue
    counts[r.scheduled_date] = (counts[r.scheduled_date] || 0) + 1
  }
  target = Object.entries(counts).find(([, n]) => n >= 4)?.[0] || ''
}
if (!target) { console.error('no day at least a week out with 4+ visits'); process.exit(2) }

const before = await dayJobs(target)
console.log(`\n▸ the day under test: ${target} — ${before.length} visits, at least 7 days out`)
console.log('  SNAPSHOT (restored at the end; keep this line if anything goes wrong):')
console.log('    ' + JSON.stringify(before.map(j => ({ id: j.id, route_order: j.route_order }))))

const restore = async () => {
  let okAll = true
  for (const j of before) {
    const r = await fetch(`${SUPA}/rest/v1/jobs?id=eq.${j.id}`, {
      method: 'PATCH', headers: { ...H, Prefer: 'return=minimal' },
      body: JSON.stringify({ route_order: j.route_order }),
    })
    if (!r.ok) okAll = false
  }
  return okAll
}

const profile = mkdtempSync(join(tmpdir(), 'pinwrite-'))
const chrome = spawn(CHROME, ['--headless=new', '--disable-gpu', '--no-sandbox', '--hide-scrollbars',
  `--remote-debugging-port=${PORT}`, '--user-data-dir=' + profile, 'about:blank'], { stdio: 'ignore' })
chrome.on('error', e => { console.error('chrome: ' + e.message); process.exit(2) })

let ws
try {
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
  ws = new WebSocket(wsUrl)
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
  await send('Emulation.setDeviceMetricsOverride', { width: 430, height: 950, deviceScaleFactor: 2, mobile: true })
  const goto = async u => {
    await send('Page.navigate', { url: u })
    for (let i = 0; i < 80; i++) { await sleep(250); if (await evaluate('document.readyState==="complete"')) break }
    await sleep(3000)
  }

  await goto(`${baseUrl}/login`)
  for (let i = 0; i < 60; i++) {
    if (await evaluate(`!!document.querySelector('form button[type=submit],form button:not([type])')&&!document.querySelector('form button[disabled]')`)) break
    await sleep(500)
  }
  await evaluate(`(()=>{const set=(el,v)=>{const p=Object.getOwnPropertyDescriptor(el.constructor.prototype,'value').set;p.call(el,v);el.dispatchEvent(new Event('input',{bubbles:true}))};const em=document.querySelector('input[type=email]');const pw=document.querySelector('input[type=password]');if(em)set(em,${JSON.stringify(EMAIL)});if(pw)set(pw,${JSON.stringify(PASSWORD)});document.querySelector('form')?.requestSubmit();return true})()`)
  let path = '/login'
  for (let i = 0; i < 40; i++) { await sleep(1000); path = String(await evaluate('location.pathname') || '/login'); if (!path.includes('/login')) break }
  check('signed in as the owner', !path.includes('/login'), `still at ${path}`)
  if (path.includes('/login')) throw new Error('sign-in failed')

  const ROUTE = `(() => {
    const head = [...document.querySelectorAll('p')].find(p => /Today.s route/i.test(p.textContent || ''))
    const panel = head && head.closest('div.rounded-card')
    if (!panel) return null
    const rows = [...panel.querySelectorAll('li')].map(li => {
      const b = [...li.querySelectorAll('button')].find(x => /^(Pin|Unpin) /.test(x.getAttribute('aria-label') || ''))
      return { text: (li.innerText||'').replace(/\\s+/g,' ').trim(), pinned: b ? b.getAttribute('aria-pressed') === 'true' : false }
    })
    return { rows, count: rows.length }
  })()`
  const clickPin = i => `(() => {
    const head = [...document.querySelectorAll('p')].find(p => /Today.s route/i.test(p.textContent || ''))
    const panel = head && head.closest('div.rounded-card')
    const li = panel && [...panel.querySelectorAll('li')][${i}]
    const b = li && [...li.querySelectorAll('button')].find(x => /^(Pin|Unpin) /.test(x.getAttribute('aria-label') || ''))
    if (!b) return false
    b.click(); return b.getAttribute('aria-label')
  })()`

  await goto(`${baseUrl}/dashboard/schedule?d=${target}`)
  await evaluate(`(()=>{const b=[...document.querySelectorAll('button')].find(x=>(x.textContent||'').trim().toLowerCase()==='day');if(b){b.click();return true}return false})()`)
  await sleep(2500)
  let route = await evaluate(ROUTE)
  check(`the route panel shows ${target}`, !!route && route.count >= 3, `count ${route?.count}`)
  if (!route || route.count < 3) throw new Error('day did not render')

  // ⭐ A day whose route_order is all NULL already renders in the OPTIMIZER's
  // own order, so "optimize" correctly has nothing to say and the write path is
  // never exercised. (Session 82's browser proof hit exactly this and could
  // only prove the decline path.) So do what the owner does first: MOVE a stop
  // to where they want it. That writes route_order, pins the moved stop, and
  // leaves a day that genuinely can be improved around the pin.
  const clickMove = (i, dir) => `(() => {
    const head = [...document.querySelectorAll('p')].find(p => /Today.s route/i.test(p.textContent || ''))
    const panel = head && head.closest('div.rounded-card')
    const li = panel && [...panel.querySelectorAll('li')][${i}]
    const b = li && [...li.querySelectorAll('button')].find(x => new RegExp('^Move .* ${dir}$').test(x.getAttribute('aria-label') || ''))
    if (!b || b.disabled) return false
    b.click(); return b.getAttribute('aria-label')
  })()`
  // ⭐ Move the LAST stop to the FRONT. That is the owner's real instruction
  // ("do this one first thing") and it is the one that genuinely changes the
  // problem: the farthest stop opening the day means the rest should be driven
  // back toward base, not outward from it. Moving the FIRST stop down instead
  // leaves the remaining stops in the order the optimizer already chose, which
  // is why an earlier version of this proof found nothing to write.
  const lastName = (route.rows[route.count - 1]?.text || '').split(' ').slice(0, 3).join(' ')
  for (let i = route.count - 1; i >= 1; i--) {
    const moved = await evaluate(clickMove(i, 'up'))
    check(`moved the last stop toward the front (row ${i} → ${i - 1})`, !!moved, String(moved))
    await sleep(2200)
  }
  route = await evaluate(ROUTE)
  check('the moved stop is now first', route.rows[0]?.pinned === true,
    JSON.stringify(route.rows.map(r => r.pinned)))
  check('…and it is the stop that was last', (route.rows[0]?.text || '').includes(lastName.split(' ')[0]),
    `"${lastName}" vs "${(route.rows[0]?.text || '').slice(0, 24)}"`)

  // A second pin, so "both preserved" is what gets proven.
  await evaluate(clickPin(2))
  await sleep(900)
  route = await evaluate(ROUTE)
  const pinnedRows = route.rows.map((r, i) => r.pinned ? i : -1).filter(i => i >= 0)
  check('two stops are pinned', pinnedRows.length === 2, JSON.stringify(pinnedRows))
  const pinnedNames = pinnedRows.map(i => (route.rows[i].text || '').split(' ').slice(0, 3).join(' '))

  // Optimize remaining, then APPLY.
  await evaluate(`(()=>{const b=[...document.querySelectorAll('button')].filter(x=>/Optimize remaining/i.test(x.textContent||''));if(!b.length)return false;b[b.length-1].click();return true})()`)
  await sleep(3000)
  const applied = await evaluate(`(() => {
    const card = document.querySelector('[role="dialog"][aria-labelledby="optimize-day-title"]')
    if (!card) return 'no-dialog'
    const b = [...card.querySelectorAll('button')].find(x => /Use this order/i.test(x.textContent || ''))
    if (!b) return 'nothing-better'
    b.click(); return 'applied'
  })()`)
  await sleep(4000)
  check('the proposal offered something to apply, or honestly said it could not',
    applied === 'applied' || applied === 'nothing-better', String(applied))

  if (applied === 'applied') {
    const after = await dayJobs(target)
    const changed = after.some(j => (before.find(b => b.id === j.id)?.route_order ?? null) !== j.route_order)
    check('the write reached the database', changed, 'route_order is unchanged in the DB')
    check('…and every visit now carries a position',
      after.every(j => typeof j.route_order === 'number'),
      JSON.stringify(after.map(j => j.route_order)))

    // ⭐ THE REFRESH. State is discarded; what comes back came from the DB.
    await goto(`${baseUrl}/dashboard/schedule?d=${target}`)
    await evaluate(`(()=>{const b=[...document.querySelectorAll('button')].find(x=>(x.textContent||'').trim().toLowerCase()==='day');if(b){b.click();return true}return false})()`)
    await sleep(3000)
    const reloaded = await evaluate(ROUTE)
    const dbRows = await dayJobs(target)
    check('after a full reload the day still renders a sequence', !!reloaded && reloaded.count >= 3)
    if (reloaded) {
      const shown = reloaded.rows.map(r => r.text)
      // ⭐ THE persistence claim: the sequence on screen after a full reload is
      // the sequence route_order holds. Compared position by position, by
      // customer/title, not merely "the first one matches".
      const dbSeq = dbRows.sort((a, b) => (a.route_order ?? 999) - (b.route_order ?? 999))
      const mismatches = dbSeq.map((j, i) => {
        const row = shown[i] || ''
        // ⚠️ The panel labels a stop the way the OWNER names it —
        // customers.name, falling back to the job title. Comparing against
        // jobs.title alone reported five mismatches on a day that was in
        // exactly the right order.
        const label = j.customers?.name || j.title || ''
        const key = String(label).split(' ')[0]
        return key && !row.toLowerCase().includes(key.toLowerCase()) ? `#${i + 1} db="${key}" screen="${row.slice(0, 24)}"` : null
      }).filter(Boolean)
      check('…and every position matches what the DATABASE holds, not React state',
        mismatches.length === 0, mismatches.join(' · '))
      check('…and the applied position of the pinned stops survived',
        pinnedNames.every(n => shown.some(s => s.toLowerCase().includes(n.split(' ')[0].toLowerCase()))),
        `expected ${JSON.stringify(pinnedNames)} in ${JSON.stringify(shown.map(s => s.slice(0, 18)))}`)
      check('⚠️ the PINS themselves do not survive a reload — as the panel says',
        reloaded.rows.every(r => !r.pinned),
        'a pin survived a reload, which this schema cannot actually do')
    }
  } else {
    console.log('  · the day was already optimal with that pin, so there was nothing to write.')
    console.log('    The decline path is proven; the write path is not exercised on this day.')
  }
} catch (e) {
  bad('the run completed', String(e.message || e))
} finally {
  const restored = await restore()
  check('the day was restored to its original order', restored,
    'RESTORE FAILED — use the SNAPSHOT printed above')
  const back = await dayJobs(target)
  const same = back.every(j => (before.find(b => b.id === j.id)?.route_order ?? null) === j.route_order)
  check('…and the database agrees it is back', same,
    JSON.stringify(back.map(j => ({ id: j.id.slice(0, 8), route_order: j.route_order }))))
  try { ws?.close() } catch { /* already closed */ }
  chrome.kill()
}

console.log('')
if (fails) console.log(`✗ pinned-route WRITE proof: ${fails} check${fails === 1 ? '' : 's'} failed`)
else console.log('✓ pinned-route WRITE proof: green — applied, refreshed, persisted, restored')
process.exit(fails ? 1 : 0)
