// ── Drive the REAL app: stopping for the day is reachable with a thumb ───────
//
// Session 47's two new surfaces, at the widths this app is actually used at:
//
//   1. THE DURATION CONTROL (job form) — a number and a unit, side by side, on a
//      375px screen. Both have to be usable: a unit dropdown squeezed to 40px is
//      a control nobody can hit, and this replaced a field that at least fitted.
//   2. STOP FOR TODAY (day board) — the whole point of the feature. The button
//      must be VISIBLE on the card rather than buried in an overflow menu, it
//      must be a real tap target, and the sheet it opens must fit.
//
//   node scripts/worksession-cdp.mjs <baseUrl>
//
// It seeds ONE obviously-named visit (ZZ-S47-CDP) for today, drives it, and
// deletes it in a finally block — the same shape earlier CDP proofs used. It
// never touches an existing job.
//
// ⚠️ A FRESH profile directory every run: a persistent Chrome profile serves a
// STALE client bundle and would test the previous build.
// ⚠️ `<main>` is overflow-auto, so document.scrollWidth NEVER reports sideways
// overflow on this app. Overflow is measured per ELEMENT against innerWidth.

import { spawn } from 'node:child_process'
import { readFileSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createClient } from '@supabase/supabase-js'

const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'
const [baseUrl = 'http://127.0.0.1:3147'] = process.argv.slice(2)
const PORT = 9471 + Number(process.env.CDP_SLOT || 0)
const WIDTHS = [375, 390, 430]
const TITLE = 'ZZ-S47-CDP'

const env = Object.fromEntries(
  readFileSync('.env.local', 'utf8').split(/\r?\n/)
    .filter(l => l && !l.startsWith('#') && l.includes('='))
    .map(l => [l.slice(0, l.indexOf('=')).trim(), l.slice(l.indexOf('=') + 1).trim()]))
const EMAIL = env.PORTAL_RPC_OWNER_EMAIL || env.BACKFILL_OWNER_EMAIL
const PASSWORD = env.PORTAL_RPC_OWNER_PASSWORD || env.BACKFILL_OWNER_PASSWORD
if (!EMAIL || !PASSWORD) { console.error('no owner credentials in .env.local'); process.exit(2) }

let fails = 0
const ok = n => console.log(`  ✓ ${n}`)
const bad = (n, d = '') => { fails++; console.log(`  ✗ ${n}${d ? `\n      ${d}` : ''}`) }
const check = (n, c, d) => c ? ok(n) : bad(n, d)

// ── Seed: one visit, on today, already on the clock ──────────────────────────
const sb = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.NEXT_PUBLIC_SUPABASE_ANON_KEY,
  { auth: { persistSession: false } })
const { data: auth, error: authErr } = await sb.auth.signInWithPassword({ email: EMAIL, password: PASSWORD })
if (authErr || !auth?.user) { console.error('sign-in failed: ' + authErr?.message); process.exit(2) }
const uid = auth.user.id
const d = new Date()
const today = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`

// Swept first, in case a previous run was killed before its finally block.
await sb.from('jobs').delete().eq('user_id', uid).eq('title', TITLE)
const { data: job, error: jobErr } = await sb.from('jobs').insert({
  user_id: uid, title: TITLE, scheduled_date: today, status: 'in_progress',
  crew_size: 2, duration_minutes: 480,
  started_at: new Date(Date.now() - 95 * 60_000).toISOString(),
}).select('id').single()
if (jobErr || !job) { console.error('could not seed the fixture visit: ' + jobErr?.message); process.exit(2) }
console.log(`  · seeded ${TITLE} on ${today} (deleted at the end)`)

const profile = mkdtempSync(join(tmpdir(), 'ws-cdp-'))
const chrome = spawn(CHROME, ['--headless=new', '--disable-gpu', '--no-sandbox', '--hide-scrollbars',
  `--remote-debugging-port=${PORT}`, '--user-data-dir=' + profile, 'about:blank'], { stdio: 'ignore' })
chrome.on('error', e => { console.error('chrome failed: ' + e.message); process.exit(2) })

const sleep = ms => new Promise(r => setTimeout(r, ms))
async function target() {
  for (let i = 0; i < 60; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${PORT}/json/list`)
      const t = (await r.json()).find(x => x.type === 'page')
      if (t) return t.webSocketDebuggerUrl
    } catch { /* not up yet */ }
    await sleep(500)
  }
  throw new Error('no CDP target')
}

try {
  const wsUrl = await target()
  const { WebSocket } = await import('ws').catch(() => ({ WebSocket: globalThis.WebSocket }))
  const ws = new WebSocket(wsUrl)
  await new Promise(r => ws.addEventListener('open', r))
  let msgId = 0
  const pending = new Map()
  ws.addEventListener('message', e => {
    const m = JSON.parse(e.data)
    if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id) }
  })
  const send = (method, params = {}) => new Promise(res => {
    const id = ++msgId; pending.set(id, res); ws.send(JSON.stringify({ id, method, params }))
  })
  async function evaluate(expression) {
    const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })
    return r.result?.result?.value
  }
  async function goto(url) {
    await send('Page.navigate', { url })
    for (let i = 0; i < 80; i++) {
      await sleep(250)
      if (await evaluate('document.readyState === "complete"')) break
    }
    await sleep(1500)
  }
  const setWidth = w => send('Emulation.setDeviceMetricsOverride',
    { width: w, height: 850, deviceScaleFactor: 2, mobile: true })

  await send('Page.enable'); await send('Runtime.enable')

  const OVERFLOW = `(() => {
    const bad = []
    for (const el of document.querySelectorAll('body *')) {
      const r = el.getBoundingClientRect()
      if (r.width === 0) continue
      if (r.right > innerWidth + 1 || r.left < -1) {
        bad.push(el.tagName.toLowerCase() + '.' + String(el.className || '').slice(0, 40)
          + ' [' + Math.round(r.left) + '..' + Math.round(r.right) + ']')
      }
    }
    return bad.slice(0, 4)
  })()`

  await setWidth(390)
  await goto(`${baseUrl}/login`)
  await evaluate(`(() => {
    const set = (el, v) => {
      const p = Object.getOwnPropertyDescriptor(el.constructor.prototype, 'value').set
      p.call(el, v); el.dispatchEvent(new Event('input', { bubbles: true }))
    }
    const em = document.querySelector('input[type=email]')
    const pw = document.querySelector('input[type=password]')
    if (em) set(em, ${JSON.stringify(EMAIL)})
    if (pw) set(pw, ${JSON.stringify(PASSWORD)})
    document.querySelector('form')?.requestSubmit()
    return true
  })()`)
  await sleep(7000)
  const where = await evaluate('location.pathname')
  check('signed in as the owner', !String(where).includes('/login'), `still at ${where}`)

  // ── 1. The duration control ────────────────────────────────────────────────
  console.log('\n═══ Job form: Duration — a value and a unit ═══')
  for (const w of WIDTHS) {
    await setWidth(w)
    await goto(`${baseUrl}/dashboard/schedule?job=${job.id}`)
    await sleep(2500)
    // "Time & crew" collapses when editing; open it.
    await evaluate(`(() => {
      for (const b of document.querySelectorAll('button, summary, [role=button]')) {
        if (/time & crew|time and crew/i.test(b.textContent || '')) { b.click(); return true }
      }
      return false
    })()`)
    await sleep(1200)

    const control = await evaluate(`(() => {
      const sel = [...document.querySelectorAll('select')].find(s =>
        (s.getAttribute('aria-label') || '') === 'Duration unit')
      if (!sel) return { found: false }
      const num = sel.parentElement?.querySelector('input[type=number]')
      const sr = sel.getBoundingClientRect()
      const nr = num ? num.getBoundingClientRect() : null
      return {
        found: true,
        units: [...sel.options].map(o => o.textContent),
        value: sel.value,
        numberWidth: nr ? Math.round(nr.width) : 0,
        unitWidth: Math.round(sr.width),
        numberHeight: nr ? Math.round(nr.height) : 0,
        unitHeight: Math.round(sr.height),
        sameRow: nr ? Math.abs(nr.top - sr.top) < 4 : false,
        rightEdge: Math.round(Math.max(sr.right, nr ? nr.right : 0)),
        // 480 stored on an 8h business must READ BACK as 1 workday.
        numberValue: num ? num.value : null,
      }
    })()`)
    check(`${w}px: the duration control is a value + a unit`, control?.found, JSON.stringify(control))
    check(`${w}px: it offers minutes, hours and workdays`,
      JSON.stringify(control?.units) === JSON.stringify(['Minutes', 'Hours', 'Workdays']),
      JSON.stringify(control?.units))
    check(`${w}px: 480 minutes reads back as 1 Workday`,
      control?.value === 'days' && control?.numberValue === '1',
      `showed ${control?.numberValue} ${control?.value}`)
    check(`${w}px: both halves are on one row and inside the viewport`,
      control?.sameRow && control?.rightEdge <= w, JSON.stringify(control))
    check(`${w}px: both are real tap targets (≥40px tall, unit ≥88px wide)`,
      control?.numberHeight >= 40 && control?.unitHeight >= 40 && control?.unitWidth >= 88,
      `number ${control?.numberWidth}x${control?.numberHeight}, unit ${control?.unitWidth}x${control?.unitHeight}`)
    const over = await evaluate(OVERFLOW)
    check(`${w}px: nothing overflows sideways`, (over || []).length === 0, (over || []).join(' · '))
  }

  // ── 2. Stop for today ──────────────────────────────────────────────────────
  console.log('\n═══ Day board: Stop for today ═══')
  for (const w of WIDTHS) {
    await setWidth(w)
    await goto(`${baseUrl}/dashboard/schedule?view=day`)
    await sleep(3500)

    const btn = await evaluate(`(() => {
      const all = [...document.querySelectorAll('button')]
      const stop = all.find(b => /stop for today/i.test(b.textContent || ''))
      const complete = all.find(b => /^\\s*complete\\s*$/i.test(b.textContent || ''))
      if (!stop) return { found: false, buttons: all.map(b => (b.textContent||'').trim()).filter(Boolean).slice(0, 25) }
      const r = stop.getBoundingClientRect()
      return {
        found: true,
        visible: r.width > 0 && r.height > 0,
        height: Math.round(r.height), width: Math.round(r.width),
        inside: r.right <= innerWidth + 1 && r.left >= -1,
        // The two doors are DIFFERENT buttons, both on the card.
        completeToo: !!complete,
        insideMenu: !!stop.closest('[role=menu]'),
      }
    })()`)
    check(`${w}px: "Stop for today" is on the card`, btn?.found,
      `buttons seen: ${JSON.stringify(btn?.buttons)}`)
    check(`${w}px: …not hidden in an overflow menu`, btn?.found && !btn?.insideMenu)
    check(`${w}px: …and Complete is a separate button beside it`, btn?.completeToo)
    check(`${w}px: …a real tap target inside the viewport`,
      btn?.found && btn.height >= 40 && btn.inside, JSON.stringify(btn))

    // Open the sheet and measure it.
    await evaluate(`(() => {
      const b = [...document.querySelectorAll('button')].find(x => /stop for today/i.test(x.textContent || ''))
      if (b) b.click()
      return !!b
    })()`)
    await sleep(1500)
    // ⚠️ SCOPED TO THE DIALOG, not the document. The day board is still in the
    // DOM behind the overlay, and its own (correct) "Complete" button made a
    // whole-document scan report that the stop sheet offered to finish the job.
    const sheet = await evaluate(`(() => {
      const dlg = document.querySelector('[role=dialog][aria-modal=true]')
      if (!dlg) return { open: false }
      const text = dlg.innerText
      const buttons = [...dlg.querySelectorAll('button')].map(b => (b.textContent || '').trim())
      return {
        open: /stop for today/i.test(text),
        showsBanked: /\\d+h( \\d+m)?|\\d+m/.test(text) && /recorded against this job/i.test(text),
        promisesNoBilling: /nothing is invoiced/i.test(text) && /isn.t told anything|isn’t told anything/i.test(text),
        // ⛔ The words that must never appear on THIS sheet.
        offersComplete: buttons.some(b => /complete|finish|mark done/i.test(b)),
        buttons,
        chips: ['Tomorrow', 'Pick a day', 'Not yet'].filter(c => buttons.includes(c)),
        asksPeople: /people on it today/i.test(text),
      }
    })()`)
    check(`${w}px: the sheet opens`, sheet?.open, JSON.stringify(sheet))
    check(`${w}px: it states the time being recorded`, sheet?.showsBanked, JSON.stringify(sheet))
    check(`${w}px: …and that nothing is billed and nobody is told`, sheet?.promisesNoBilling, JSON.stringify(sheet))
    check(`${w}px: ⛔ it never offers to complete the job`, !sheet?.offersComplete, JSON.stringify(sheet))
    check(`${w}px: the three "back on it" answers are all one tap`,
      JSON.stringify(sheet?.chips) === JSON.stringify(['Tomorrow', 'Pick a day', 'Not yet']),
      JSON.stringify(sheet?.chips))
    check(`${w}px: a 2-person crew is asked how many were there`, sheet?.asksPeople, JSON.stringify(sheet))
    const over = await evaluate(OVERFLOW)
    check(`${w}px: the sheet overflows nothing`, (over || []).length === 0, (over || []).join(' · '))
  }

  ws.close()
} finally {
  chrome.kill()
  const { error: delErr } = await sb.from('jobs').delete().eq('user_id', uid).eq('title', TITLE)
  const { count } = await sb.from('jobs')
    .select('id', { count: 'exact', head: true }).eq('user_id', uid).eq('title', TITLE)
  check('the seeded visit is gone', !delErr && (count ?? 0) === 0,
    `${count} left${delErr ? ` (${delErr.message})` : ''}`)
}

console.log(fails ? `\n✗ ${fails} failure(s)` : '\n✓ duration control and Stop for today are phone-sized at 375/390/430')
process.exit(fails ? 1 : 0)
