// ── Measure the field workflow on a real phone-sized browser ─────────────────
//
// Session 54 asks a measurement question before it asks a design one: how far is
// the owner's thumb from the thing they came to do, on the five surfaces they
// touch all day? This drives the REAL app at 375 / 390 / 430 and reports
// numbers, not opinions:
//
//   · every primary action's y-position, height and whether it is inside the
//     viewport WITHOUT scrolling (a "one-handed action" that needs a scroll is
//     not one)
//   · the count of visible controls on the first day-board card (button wall)
//   · page height in phone screens per surface
//   · what the bottom nav actually offers, and how many taps a Customer lookup
//     costs from the day board
//   · sideways overflow, per element (⚠️ <main> is overflow-auto, so
//     document.scrollWidth NEVER reports it on this app)
//
//   node scripts/fieldmode-cdp.mjs <baseUrl> [--json out.json]
//
// It seeds ONE obviously-named visit (ZZ-S54-FIELD) on today and deletes it in a
// finally block — the same shape earlier CDP proofs used, and the only way to
// measure a day board on a day the owner has nothing booked. It never edits an
// existing row.
//
// ⚠️ A FRESH profile directory every run: a persistent Chrome profile serves a
// STALE client bundle and would measure the previous build.

import { spawn } from 'node:child_process'
import { readFileSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createClient } from '@supabase/supabase-js'

const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'
const args = process.argv.slice(2)
const baseUrl = args.find(a => !a.startsWith('--')) || 'http://127.0.0.1:3154'
const jsonOut = args.includes('--json') ? args[args.indexOf('--json') + 1] : null
const PORT = 9491 + Number(process.env.CDP_SLOT || 0)
const WIDTHS = [375, 390, 430]
const HEIGHT = 844          // iPhone 14/15 logical height — the screen we measure in

const env = Object.fromEntries(
  readFileSync('.env.local', 'utf8').split(/\r?\n/)
    .filter(l => l && !l.startsWith('#') && l.includes('='))
    .map(l => [l.slice(0, l.indexOf('=')).trim(), l.slice(l.indexOf('=') + 1).trim()]))
const EMAIL = env.PORTAL_RPC_OWNER_EMAIL || env.BACKFILL_OWNER_EMAIL
const PASSWORD = env.PORTAL_RPC_OWNER_PASSWORD || env.BACKFILL_OWNER_PASSWORD
if (!EMAIL || !PASSWORD) { console.error('no owner credentials in .env.local'); process.exit(2) }

const report = { baseUrl, widths: WIDTHS, height: HEIGHT, surfaces: {} }
const log = s => console.log(s)

// A customer id to open — read straight from the book (read-only).
const sb = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.NEXT_PUBLIC_SUPABASE_ANON_KEY,
  { auth: { persistSession: false } })
const { data: auth, error: authErr } = await sb.auth.signInWithPassword({ email: EMAIL, password: PASSWORD })
if (authErr || !auth?.user) { console.error('sign-in failed: ' + authErr?.message); process.exit(2) }
const uid = auth.user.id
// A customer WITH a phone number: "Call" is one of the four actions being
// measured, and on a contact with no phone it renders disabled — which would make
// the measurement a statement about that one record rather than about the page.
const { data: custRow } = await sb.from('customers').select('id,name,phone')
  .eq('user_id', uid).not('phone', 'is', null).neq('phone', '').limit(1).maybeSingle()
const customerId = custRow?.id
log(`  · measuring against customer ${custRow?.name ?? '(none found)'}`)

// A REAL day with real work on it. The day board opens on today, and an owner's
// today is often empty — measuring that would report a board with no cards and
// call the field bar "absent" when it is merely idle. So we find the busiest open
// day in the book and drive the board there via ?job=<id>, which moves the cursor
// to that visit's date. Read-only: nothing is seeded, nothing is edited.
const { data: openJobs } = await sb.from('jobs')
  .select('id,scheduled_date,status').eq('user_id', uid)
  .in('status', ['scheduled', 'in_progress']).order('scheduled_date').limit(400)
const byDay = {}
for (const j of openJobs || []) (byDay[j.scheduled_date] ||= []).push(j)
const busiest = Object.entries(byDay).sort((a, b) => b[1].length - a[1].length)[0]
const anchorJobId = busiest?.[1][0]?.id
log(`  · day board anchored on ${busiest?.[0] ?? '(no open work)'} — ${busiest?.[1].length ?? 0} visits`)

const profile = mkdtempSync(join(tmpdir(), 'fm-cdp-'))
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

// ── The measurement expressions, shared by every surface ─────────────────────

// Per-ELEMENT overflow. document.scrollWidth is useless here: <main> is
// overflow-auto, so it absorbs the overflow and reports a clean page.
//
// ⚠️ Content inside a DELIBERATE horizontal scroller is not overflow — it is the
// feature. The pill nav on Messages (CommsNav: overflow-x-auto with a fade mask)
// and every wide table's scroll container both put children past the right edge
// on purpose, and reporting them buries the one row that is genuinely broken.
// So an element is only flagged when NO ancestor scrolls sideways.
const OVERFLOW = `(() => {
  // ⚠️ The walk STOPS AT <main>. <main> is itself overflow-auto (it is the page
  // scroller), so walking through it would mark every element on every page as
  // "inside a scroller" and the check would pass on a page that is visibly
  // broken — a green light that means nothing.
  const scrolls = el => {
    for (let p = el.parentElement; p && p !== document.body && p.tagName !== 'MAIN'; p = p.parentElement) {
      const ox = getComputedStyle(p).overflowX
      if ((ox === 'auto' || ox === 'scroll') && p.scrollWidth > p.clientWidth + 1) return true
    }
    return false
  }
  const bad = []
  for (const el of document.querySelectorAll('body *')) {
    const r = el.getBoundingClientRect()
    if (r.width === 0 || r.height === 0) continue
    if (r.right > innerWidth + 1 || r.left < -1) {
      if (scrolls(el)) continue
      bad.push(el.tagName.toLowerCase() + '.' + String(el.className || '').slice(0, 44)
        + ' [' + Math.round(r.left) + '..' + Math.round(r.right) + ']')
    }
  }
  return bad.slice(0, 5)
})()`

// Where an action sits, and whether a thumb can reach it without scrolling.
// `wanted` maps a PLAIN NAME to a regex source, so results are read back by name
// ('call') and never by re-typing an escaped pattern — the first cut keyed the
// result by the pattern itself, and every lookup silently missed because `'\s'`
// in a JS string is just `s`. A measurement that reports "not found" for
// something plainly on the page is worse than no measurement.
const LOCATE = wanted => `(() => {
  const wanted = ${JSON.stringify(wanted)}
  const out = {}
  const scroller = document.querySelector('main') || document.scrollingElement
  const els = [...document.querySelectorAll('button, a, [role=button], input[type=submit]')]
  for (const [name, src] of Object.entries(wanted)) {
    const re = new RegExp(src, 'i')
    const hit = els.find(e => {
      const t = (e.textContent || '').trim()
      const al = e.getAttribute('aria-label') || ''
      return (re.test(t) || re.test(al)) && e.getBoundingClientRect().height > 0
    })
    if (!hit) { out[name] = { found: false }; continue }
    const r = hit.getBoundingClientRect()
    out[name] = {
      found: true,
      top: Math.round(r.top), bottom: Math.round(r.bottom),
      h: Math.round(r.height), w: Math.round(r.width),
      // "Reachable" = fully inside the first screenful with no scroll at all.
      onFirstScreen: r.top >= 0 && r.bottom <= innerHeight,
      // Thumb zone = the bottom 45% of the screen, where a one-handed grip rests.
      inThumbZone: r.top >= innerHeight * 0.55 && r.bottom <= innerHeight,
      // How far the page must scroll to bring it into view (0 = already there).
      scrollNeeded: Math.max(0, Math.round(r.top - innerHeight + r.height + 8)),
      tapOk: r.height >= 44 || (r.height >= 40 && r.width >= 88),
    }
  }
  const visible = els.filter(e => e.getBoundingClientRect().height > 0)
  out.__page = {
    scrollHeight: Math.round(scroller ? scroller.scrollHeight : 0),
    screens: scroller ? Math.round((scroller.scrollHeight / innerHeight) * 10) / 10 : 0,
    controls: visible.length,
    // What is actually on the page — so a "not found" reads as evidence rather
    // than a shrug. A missing action and a still-loading page look identical
    // without this.
    labels: visible.map(e => ((e.textContent || '').trim() || e.getAttribute('aria-label') || '?')
      .replace(/\\s+/g, ' ').slice(0, 26)).slice(0, 30),
  }
  return out
})()`

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
    if (r.result?.exceptionDetails) return { __error: r.result.exceptionDetails.text }
    return r.result?.result?.value
  }
  async function goto(url, settle = 2500) {
    await send('Page.navigate', { url })
    for (let i = 0; i < 80; i++) {
      await sleep(250)
      if (await evaluate('document.readyState === "complete"')) break
    }
    await sleep(settle)
  }
  const setWidth = w => send('Emulation.setDeviceMetricsOverride',
    { width: w, height: HEIGHT, deviceScaleFactor: 2, mobile: true })

  await send('Page.enable'); await send('Runtime.enable'); await send('Network.enable')

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
  await sleep(8000)
  const where = await evaluate('location.pathname')
  if (String(where).includes('/login')) { console.error(`sign-in did not take — still at ${where}`); process.exit(2) }
  log(`  · signed in\n`)

  // ── 1. THE SHELL: what the thumb can reach from anywhere ───────────────────
  log('═══ 1. Navigation shell ═══')
  await setWidth(390)
  await goto(`${baseUrl}/dashboard`)
  const shell = await evaluate(`(() => {
    const nav = document.querySelector('nav[aria-label=Primary].eq-bottom-nav, .eq-bottom-nav')
    const tabs = nav ? [...nav.querySelectorAll('a, button')].map(e => {
      const r = e.getBoundingClientRect()
      return {
        label: (e.textContent || '').trim() || e.getAttribute('aria-label') || '?',
        href: e.getAttribute('href') || null,
        h: Math.round(r.height), w: Math.round(r.width), top: Math.round(r.top),
      }
    }) : null
    const topBar = [...document.querySelectorAll('div.lg\\\\:hidden.sticky button, div.lg\\\\:hidden.sticky a')]
      .map(e => (e.getAttribute('aria-label') || e.textContent || '').trim())
    return { hasBottomNav: !!nav, navTop: nav ? Math.round(nav.getBoundingClientRect().top) : null, tabs, topBar }
  })()`)
  report.surfaces.shell = shell
  log(`  bottom nav: ${shell.hasBottomNav ? shell.tabs.map(t => t.label).join(' · ') : 'ABSENT'}`)
  log(`  top bar:    ${(shell.topBar || []).join(' · ')}`)

  // How many taps to reach a CUSTOMER from the day board?
  const custPath = await evaluate(`(() => {
    // Anything on screen right now that goes to the customer list.
    const direct = [...document.querySelectorAll('a[href="/dashboard/customers"]')]
      .filter(a => a.getBoundingClientRect().height > 0)
    const inBottomNav = direct.some(a => a.closest('.eq-bottom-nav'))
    return { visibleDirectLinks: direct.length, inBottomNav }
  })()`)
  report.surfaces.customerReach = custPath
  log(`  customers reachable in ONE tap from the shell: ${custPath.inBottomNav ? 'yes (bottom nav)' : 'no'}`)

  // What the [+] offers.
  const quick = await evaluate(`(async () => {
    const b = [...document.querySelectorAll('button')]
      .find(x => /^(quick actions|create)$/i.test(x.getAttribute('aria-label') || ''))
    if (!b) return { found: false }
    b.click()
    await new Promise(r => setTimeout(r, 700))
    const sheet = document.querySelector('[role=dialog][aria-label="Create"], [role=dialog][aria-label*="Quick"]')
    const items = sheet ? [...sheet.querySelectorAll('a, button')].map(e => ({
      label: (e.textContent || '').trim().replace(/\\s+/g, ' ').slice(0, 48),
      href: e.getAttribute('href') || null,
    })).filter(i => i.label) : []
    return { found: true, items }
  })()`)
  report.surfaces.quickAdd = quick
  log(`  [+] sheet: ${quick.found ? quick.items.map(i => i.label).join(' | ') : 'ABSENT'}\n`)

  // ── 2. TODAY / SCHEDULE (day view) ─────────────────────────────────────────
  log('═══ 2. Today / Schedule — day view ═══')
  report.surfaces.schedule = {}
  // ?job= moves the cursor to that visit's date AND opens the edit form; Escape
  // closes the form and leaves the board on the busy day underneath.
  const openBoard = async () => {
    await goto(`${baseUrl}/dashboard/schedule${anchorJobId ? `?job=${anchorJobId}` : ''}`, 5000)
    await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 })
    await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 })
    await sleep(1200)
    // Escape may be intercepted by the unsaved-changes guard; click Close as well.
    await evaluate(`(() => {
      const x = [...document.querySelectorAll('button')].find(b => (b.getAttribute('aria-label') || '') === 'Close')
      if (x) x.click(); return !!x
    })()`)
    await sleep(1500)
  }
  for (const w of WIDTHS) {
    await setWidth(w)
    await openBoard()
    const m = await evaluate(LOCATE({
      start: '^\\\s*Start\\\s*$', complete: '^\\\s*Complete\\\s*$', stop: 'Stop for today',
      routeTo: 'Route to', crewChat: 'Crew chat', photos: '^\\\s*Photos\\\s*$',
      onMyWay: 'On my way', directions: 'Directions|Navigate',
    }))
    const card = await evaluate(`(() => {
      // The first job card's visible controls — the "button wall" count.
      const cards = [...document.querySelectorAll('[data-job-card]')]
      const first = cards[0]
      if (!first) {
        // Fall back: the first element that holds a "Route to" link.
        const rt = [...document.querySelectorAll('a')].find(a => /route to/i.test(a.textContent || ''))
        const box = rt ? rt.closest('div.rounded-xl, div.rounded-2xl, li') : null
        if (!box) return { found: false }
        const ctrls = [...box.querySelectorAll('button, a')].filter(e => e.getBoundingClientRect().height > 0)
        const r = box.getBoundingClientRect()
        return { found: true, viaFallback: true, controls: ctrls.length,
          labels: ctrls.map(e => (e.textContent || '').trim() || e.getAttribute('aria-label') || '?').slice(0, 14),
          cardHeight: Math.round(r.height), cardTop: Math.round(r.top) }
      }
      const ctrls = [...first.querySelectorAll('button, a')].filter(e => e.getBoundingClientRect().height > 0)
      const r = first.getBoundingClientRect()
      return { found: true, controls: ctrls.length,
        labels: ctrls.map(e => (e.textContent || '').trim() || e.getAttribute('aria-label') || '?').slice(0, 14),
        cardHeight: Math.round(r.height), cardTop: Math.round(r.top) }
    })()`)
    const bar = await evaluate(`(() => {
      const b = [...document.querySelectorAll('div')].find(d =>
        /fixed/.test(d.className || '') && /Next stop|On the clock|Underway/i.test(d.textContent || ''))
      if (!b) return { found: false }
      const r = b.getBoundingClientRect()
      const ctrls = [...b.querySelectorAll('button, a')].map(e => (e.textContent || '').trim()).filter(Boolean)
      return { found: true, top: Math.round(r.top), h: Math.round(r.height), controls: ctrls,
        text: (b.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 120) }
    })()`)
    const over = await evaluate(OVERFLOW)
    report.surfaces.schedule[w] = { actions: m, firstCard: card, fieldBar: bar, overflow: over }
    log(`  ${w}px: page ${m.__page.screens} screens · ${m.__page.controls} controls · first card ${card.controls ?? '?'} buttons (${card.cardHeight ?? '?'}px)`)
    log(`         field bar: ${bar.found ? `[${bar.controls.join(' | ')}]` : 'ABSENT'}`)
    log(`         Start: y=${m.start?.top ?? '-'} first screen=${m.start?.onFirstScreen ?? 'n/a'} scroll=${m.start?.scrollNeeded ?? '-'}px · Route to y=${m.routeTo?.top ?? '-'} · Crew chat y=${m.crewChat?.top ?? '-'}`)
    if ((over || []).length) log(`         ⚠ overflow: ${over.join(' · ')}`)
  }
  log('')

  // ── 3. CUSTOMER ────────────────────────────────────────────────────────────
  if (customerId) {
    log('═══ 3. Customer ═══')
    report.surfaces.customer = {}
    for (const w of WIDTHS) {
      await setWidth(w)
      await goto(`${baseUrl}/dashboard/customers/${customerId}`, 6500)
      const m = await evaluate(LOCATE({
        call: '^\\\s*Call\\\s*$', message: '^\\\s*Message\\\s*$',
        quote: 'New quote', schedule: '^\\\s*Schedule\\\s*$',
      }))
      const over = await evaluate(OVERFLOW)
      report.surfaces.customer[w] = { actions: m, overflow: over }
      const call = m.call
      log(`  ${w}px: page ${m.__page.screens} screens · ${m.__page.controls} controls · Call at y=${call?.top ?? '?'} (first screen: ${call?.onFirstScreen}, thumb zone: ${call?.inThumbZone})`)
      if (!call?.found) log(`         on screen: ${m.__page.labels.join(' | ')}`)
      if ((over || []).length) log(`         ⚠ overflow: ${over.join(' · ')}`)
    }
    log('')
  }

  // ── 4. QUOTE (new) ─────────────────────────────────────────────────────────
  log('═══ 4. Quote — new ═══')
  report.surfaces.quoteNew = {}
  for (const w of WIDTHS) {
    await setWidth(w)
    await goto(`${baseUrl}/dashboard/quotes/new`, 4000)
    const m = await evaluate(LOCATE({ save: 'Save quote', cancel: '^\\\s*Cancel\\\s*$' }))
    const over = await evaluate(OVERFLOW)
    // Small-font inputs cause iOS to zoom the page on focus.
    const zoomy = await evaluate(`(() => {
      const bad = []
      for (const el of document.querySelectorAll('input, select, textarea')) {
        const r = el.getBoundingClientRect()
        if (r.height === 0) continue
        const fs = parseFloat(getComputedStyle(el).fontSize)
        if (fs < 16) bad.push((el.getAttribute('aria-label') || el.name || el.type) + ' @' + fs + 'px')
      }
      return bad.slice(0, 6)
    })()`)
    report.surfaces.quoteNew[w] = { actions: m, overflow: over, subSixteenInputs: zoomy }
    log(`  ${w}px: page ${m.__page.screens} screens · ${m.__page.controls} controls · Save y=${m.save?.top ?? '?'} (thumb zone: ${m.save?.inThumbZone})`)
    if ((zoomy || []).length) log(`         ⚠ inputs under 16px (iOS zooms): ${zoomy.join(' · ')}`)
    if ((over || []).length) log(`         ⚠ overflow: ${over.join(' · ')}`)
  }
  log('')

  // ── 5. MESSAGES ────────────────────────────────────────────────────────────
  log('═══ 5. Messages ═══')
  report.surfaces.messages = {}
  for (const w of WIDTHS) {
    await setWidth(w)
    await goto(`${baseUrl}/dashboard/messages`, 4000)
    const m = await evaluate(LOCATE({ send: '^\\\s*Send\\\s*$' }))
    const over = await evaluate(OVERFLOW)
    report.surfaces.messages[w] = { actions: m, overflow: over }
    log(`  ${w}px: page ${m.__page.screens} screens · ${m.__page.controls} controls`)
    if ((over || []).length) log(`         ⚠ overflow: ${over.join(' · ')}`)
  }
  log('')

  // ── 5b. The + on a customer: does it arrive knowing who? ──────────────────
  if (customerId) {
    log('═══ 5b. Quick Add, from a customer profile ═══')
    await setWidth(390)
    await goto(`${baseUrl}/dashboard/customers/${customerId}`, 6500)
    const qa = await evaluate(`(async () => {
      const b = [...document.querySelectorAll('button')].find(x => (x.getAttribute('aria-label') || '') === 'Create')
      if (!b) return { found: false }
      b.click()
      await new Promise(r => setTimeout(r, 800))
      const sheet = document.querySelector('[role=dialog][aria-label="Create"]')
      if (!sheet) return { found: true, opened: false }
      const rows = [...sheet.querySelectorAll('a')].map(a => {
        const r = a.getBoundingClientRect()
        return {
          label: (a.textContent || '').trim().replace(/\\s+/g, ' ').slice(0, 40),
          href: a.getAttribute('href'),
          h: Math.round(r.height),
          inThumbZone: r.top >= innerHeight * 0.45,
        }
      })
      return { found: true, opened: true, rows }
    })()`)
    report.surfaces.quickAddCustomer = qa
    log(`  sheet: ${qa.opened ? qa.rows.map(r => `${r.label} → ${r.href}`).join('  |  ') : 'DID NOT OPEN'}`)
    log(`  every row ≥56px and in the thumb zone: ${qa.rows ? qa.rows.every(r => r.h >= 56 && r.inThumbZone) : 'n/a'}`)
    log('')
  }

  // ── 5c. The keyboard ──────────────────────────────────────────────────────
  // ⚠️ CDP's setDeviceMetricsOverride does NOT move window.visualViewport, so a
  // software keyboard has to be simulated: shrink vv.height and fire its resize.
  // Without that the page believes the whole screen is visible and every "is the
  // save button reachable" answer is about a phone with no keyboard on it.
  log('═══ 5c. With the software keyboard open (390px, 336px keyboard) ═══')
  {
    await setWidth(390)
    await goto(`${baseUrl}/dashboard/quotes/new`, 4000)
    await evaluate(`(() => {
      const vv = window.visualViewport
      if (!vv) return { noVisualViewport: true }
      Object.defineProperty(vv, 'height', { value: innerHeight - 336, configurable: true })
      Object.defineProperty(vv, 'offsetTop', { value: 0, configurable: true })
      vv.dispatchEvent(new Event('resize'))
      return { visible: Math.round(vv.height) }
    })()`)
    await sleep(900)
    const save = await evaluate(`(() => {
      // ⚠️ There are TWO "Save quote" buttons: the desktop card's (0×0 at this
      // width — display:none, not removed) and the fixed mobile bar's. A bare
      // .find() picks the hidden one and reports 0–0, which reads as "the save
      // button has no position" — a scary non-fact. Size is the filter.
      const b = [...document.querySelectorAll('button')]
        .filter(x => x.getBoundingClientRect().height > 0)
        .find(x => /save quote/i.test(x.textContent || ''))
      if (!b) return { found: false }
      const r = b.getBoundingClientRect()
      const strip = innerHeight - 336
      const hit = document.elementFromPoint(Math.round(r.left + r.width / 2), Math.round(r.top + r.height / 2))
      return {
        found: true, top: Math.round(r.top), bottom: Math.round(r.bottom), strip,
        // The whole point: is it inside the strip the keyboard leaves visible?
        aboveKeyboard: r.bottom <= strip + 1,
        // …and is the button itself what a tap at its centre would reach?
        hitIsSave: !!hit && /save quote/i.test(((hit.closest && hit.closest('button')) || hit).textContent || ''),
        transform: getComputedStyle(b.closest('[class*=fixed]') || b).transform,
      }
    })()`)
    report.surfaces.keyboard = { quoteSave: save }
    log(`  Save quote: ${save.top}–${save.bottom} inside the ${save.strip}px visible strip → ${save.aboveKeyboard ? 'REACHABLE' : 'BEHIND THE KEYBOARD'} · tap hits Save: ${save.hitIsSave}`)
    log(`  bar transform: ${save.transform}`)
    log('')
  }

  // ── 6. PAGE WEIGHT on the core field routes ────────────────────────────────
  log('═══ 6. Script weight on the core field routes ═══')
  // ⚠️ Counting every Network.loadingFinished reports the same ~11 MB on every
  // route: the PWA service worker precaches the whole app on first load, and that
  // traffic is not this route's cost. This measures the SCRIPTS THIS ROUTE
  // EXECUTES — the number that actually decides how long a phone is busy before
  // the page responds — from the page's own resource timeline.
  report.surfaces.weight = {}
  for (const path of ['/dashboard', '/dashboard/schedule', '/dashboard/quotes/new', '/dashboard/messages',
    customerId ? `/dashboard/customers/${customerId}` : null].filter(Boolean)) {
    await setWidth(390)
    await goto(`${baseUrl}${path}`, 5000)
    const w8 = await evaluate(`(() => {
      const rs = performance.getEntriesByType('resource')
      const js = rs.filter(r => /\\.js(\\?|$)/.test(r.name))
      const sum = a => a.reduce((t, r) => t + (r.decodedBodySize || r.transferSize || 0), 0)
      const nav = performance.getEntriesByType('navigation')[0]
      return {
        scripts: js.length,
        scriptKb: Math.round(sum(js) / 1024),
        domInteractiveMs: nav ? Math.round(nav.domInteractive) : null,
        loadMs: nav ? Math.round(nav.loadEventEnd || nav.duration) : null,
      }
    })()`)
    report.surfaces.weight[path] = w8
    log(`  ${path.padEnd(34)} ${String(w8.scripts).padStart(3)} scripts · ${String(w8.scriptKb).padStart(5)} kB JS · interactive ${w8.domInteractiveMs}ms`)
  }

  // ── 7. Long names, and a bad connection ───────────────────────────────────
  // The field bar and the + both render a customer's name. "Sarah Kevol" fits;
  // a strata corporation does not. Tested by REWRITING the rendered text rather
  // than by creating a customer with a silly name — a layout question does not
  // justify a row in the owner's book.
  log('\n═══ 7. Long names · slow connection ═══')
  {
    await setWidth(375)
    await openBoard()
    const longName = await evaluate(`(() => {
      const LONG = 'Bridleridge Ravine Homeowners Association & Property Management Ltd.'
      const bar = [...document.querySelectorAll('div')].find(d =>
        /fixed/.test(d.className || '') && /Next stop|On the clock|Underway/i.test(d.textContent || ''))
      if (!bar) return { found: false }
      const name = [...bar.querySelectorAll('span')].find(s => /truncate/.test(s.className || ''))
      if (!name) return { found: true, named: false }
      name.textContent = LONG
      const r = bar.getBoundingClientRect()
      const nr = name.getBoundingClientRect()
      const primary = [...bar.querySelectorAll('button')].pop()
      const pr = primary ? primary.getBoundingClientRect() : null
      return {
        found: true, named: true,
        barRight: Math.round(r.right), viewport: innerWidth,
        nameOverflows: nr.right > innerWidth + 1,
        // The one thing that must survive a long name: the action is still there.
        primaryVisible: !!pr && pr.width > 40 && pr.right <= innerWidth + 1,
        primaryWidth: pr ? Math.round(pr.width) : 0,
      }
    })()`)
    const over = await evaluate(OVERFLOW)
    report.surfaces.longName = { ...longName, overflow: over }
    log(`  field bar with a 67-character customer name: name clipped cleanly=${!longName.nameOverflows} · primary still ${longName.primaryWidth}px and on screen=${longName.primaryVisible}`)
    if ((over || []).length) log(`  ⚠ overflow: ${over.join(' · ')}`)

    // Slow 3G. What is being checked is NOT a stopwatch — it is that the day
    // board paints something honest before the data lands, rather than an empty
    // page that reads as "you have no work today".
    // ⚠️ `skeleton` is expected to be FALSE on a warm profile: the board paints
    // from lib/clientCache first and revalidates behind it, so by 2.5s there is
    // real content and no skeleton left to find. The assertion that matters is
    // `claimsEmpty` — a board that has not loaded must never say the day is.
    await send('Network.emulateNetworkConditions', {
      offline: false, latency: 400, downloadThroughput: (400 * 1024) / 8, uploadThroughput: (400 * 1024) / 8,
    })
    await send('Page.navigate', { url: `${baseUrl}/dashboard/schedule` })
    await sleep(2500)
    const early = await evaluate(`(() => {
      const t = (document.querySelector('main') || document.body).textContent || ''
      return {
        skeleton: !!document.querySelector('[class*=animate-pulse], [class*=skeleton], [class*=Skeleton]'),
        // ⛔ The failure this guards: a still-loading board that says the day is empty.
        claimsEmpty: /no visits|nothing scheduled|no stops/i.test(t),
        chars: t.length,
      }
    })()`)
    await send('Network.emulateNetworkConditions', { offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1 })
    report.surfaces.slowNetwork = early
    log(`  on slow 3G at 2.5s: skeleton shown=${early.skeleton} · claims the day is empty=${early.claimsEmpty}`)
  }

  if (jsonOut) { writeFileSync(jsonOut, JSON.stringify(report, null, 2)); log(`\n  → ${jsonOut}`) }
} catch (e) {
  console.error('measurement failed: ' + (e?.stack || e?.message || e))
  process.exitCode = 2
} finally {
  chrome.kill()
}
