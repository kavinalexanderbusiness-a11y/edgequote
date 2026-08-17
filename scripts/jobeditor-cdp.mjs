// ── Drive the REAL app: the compact job editor + quick-edit sheet ─────────────
// Signs in with the owner credentials from .env.local and proves Session 81's
// redesign the way a person would, at 375 / 390 / 430:
//
//   1. QUICK EDIT (day board → overflow → Quick edit): the sheet opens with the
//      fast-path fields, Save is disabled until something changes, "Unsaved
//      changes" is said out loud, and dismissing a dirty sheet ASKS first.
//   2. FULL EDITOR: the common path (customer, location, service, date, time
//      window, duration, status, note) is visible with NO disclosure in the
//      way; price/Repeat wait behind "+ More options"; the dirty indicator
//      appears on typing; a dirty close asks first. Nothing overflows sideways.
//   3. SAVE PATH (one width): a disposable ZZ-labelled visit on a far-future
//      date is created, quick-edited (time/duration/service/note), MOVED a day
//      by the sheet's date field, verified IN THE DATABASE, then deleted.
//      ⛔ No other write touches the owner's book, and steps that change data
//      verify the control is on screen before acting (the S39 rule).
//
//   node scripts/jobeditor-cdp.mjs <baseUrl>
//
// ⚠️ Fresh Chrome profile every run — a persistent one serves a stale bundle.
// ⚠️ <main> is overflow-auto: sideways overflow is measured per ELEMENT.

import { spawn } from 'node:child_process'
import { readFileSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createClient } from '@supabase/supabase-js'

const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'
const [baseUrl = 'http://127.0.0.1:3181'] = process.argv.slice(2)
const PORT = 9461 + Number(process.env.CDP_SLOT || 0)
const WIDTHS = [375, 390, 430]
const PROOF_DATE = '2027-03-01'          // far future — collides with nobody's live day
const PROOF_DATE_MOVED = '2027-03-02'
const PROOF_SERVICE = 'ZZ-S81 Proof'     // ZZ prefix = the book's disposable-fixture idiom

const env = Object.fromEntries(
  readFileSync('.env.local', 'utf8').split(/\r?\n/)
    .filter(l => l && !l.startsWith('#') && l.includes('='))
    .map(l => [l.slice(0, l.indexOf('=')).trim(), l.slice(l.indexOf('=') + 1).trim()]))
const EMAIL = env.PORTAL_RPC_OWNER_EMAIL
const PASSWORD = env.PORTAL_RPC_OWNER_PASSWORD
if (!EMAIL || !PASSWORD) { console.error('no owner credentials in .env.local'); process.exit(2) }

let fails = 0
const ok = n => console.log(`  ✓ ${n}`)
const bad = (n, d = '') => { fails++; console.log(`  ✗ ${n}${d ? `\n      ${d}` : ''}`) }
const check = (n, c, d) => c ? ok(n) : bad(n, d)

// Read-only DB client for verification + a crews existence probe.
const db = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.NEXT_PUBLIC_SUPABASE_ANON_KEY, { auth: { persistSession: false } })
const auth = await db.auth.signInWithPassword({ email: EMAIL, password: PASSWORD })
if (auth.error) { console.error('DB sign-in failed: ' + auth.error.message); process.exit(2) }
const UID = auth.data.user.id
const { data: crewRows } = await db.from('crews').select('id, name, is_active').eq('user_id', UID)
const activeCrews = (crewRows || []).filter(c => c.is_active)
console.log(`owner has ${activeCrews.length} active crew(s) — assignee control ${activeCrews.length ? 'expected' : 'not expected'}`)

const profile = mkdtempSync(join(tmpdir(), 'jobeditor-cdp-'))
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
function send(method, params = {}) {
  const id = ++msgId
  return new Promise(res => { pending.set(id, res); ws.send(JSON.stringify({ id, method, params })) })
}
async function evaluate(expression) {
  const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })
  if (r.result?.exceptionDetails) return { __error: r.result.exceptionDetails.text }
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
async function setWidth(w) {
  await send('Emulation.setDeviceMetricsOverride', { width: w, height: 850, deviceScaleFactor: 2, mobile: true })
}
// Wait until an in-page predicate is true (expression string returning boolean).
async function until(expr, label, tries = 40) {
  for (let i = 0; i < tries; i++) {
    if (await evaluate(expr) === true) return true
    await sleep(250)
  }
  bad(`${label} (timed out waiting)`, expr.slice(0, 100))
  return false
}
// Click a button/element found by visible text (exact or startsWith).
const CLICK_BY_TEXT = (sel, text, exact) => `(() => {
  const els = [...document.querySelectorAll(${JSON.stringify(sel)})]
  const t = ${JSON.stringify(text)}
  const el = els.find(e => ${exact ? '(e.textContent || "").trim() === t' : '(e.textContent || "").trim().startsWith(t)'})
  if (!el) return false
  el.click(); return true
})()`
async function clickText(sel, text, { exact = true } = {}) {
  return await evaluate(CLICK_BY_TEXT(sel, text, exact)) === true
}
// React-safe input setter.
const SET_VALUE = (sel, v) => `(() => {
  const el = document.querySelector(${JSON.stringify(sel)})
  if (!el) return false
  const proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : el.tagName === 'SELECT' ? HTMLSelectElement.prototype : HTMLInputElement.prototype
  Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, ${JSON.stringify(v)})
  el.dispatchEvent(new Event(el.tagName === 'SELECT' ? 'change' : 'input', { bubbles: true }))
  return true
})()`
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
  return bad.slice(0, 5)
})()`

await send('Page.enable'); await send('Runtime.enable')

// ── Sign in ──────────────────────────────────────────────────────────────────
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
await sleep(6000)
const signedIn = await evaluate('location.pathname')
check('signed in as the owner', !String(signedIn).includes('/login'), `still at ${signedIn}`)

// ── The disposable proof visit (created ONCE, via the real Add Job form) ─────
console.log('\n═══ Creating the disposable proof visit (far-future, ZZ-labelled) ═══')
await goto(`${baseUrl}/dashboard/schedule?d=${PROOF_DATE}`)
await until(`!!document.querySelector('main')`, 'schedule painted')
// Open the New Job form from the board's Add job door.
const addOpened = await clickText('button', 'Add job', { exact: false })
check('the Add job door is on the board', addOpened)
await until(`[...document.querySelectorAll('h2')].some(h => h.textContent.trim() === 'New Job')`, 'the New Job form opened')
// The customer list loads async — wait for real options before touching it.
await until(`(document.querySelectorAll('form select')[0]?.options.length || 0) > 1`, 'the customer list loaded')
// Fill: first customer, our ZZ service, the far-future date. The customer select
// is the form's first combobox (label "Customer").
const filled = await evaluate(`(() => {
  const selects = [...document.querySelectorAll('form select')]
  const customer = selects[0]
  if (!customer || customer.options.length < 2) return 'no customer option'
  const proto = HTMLSelectElement.prototype
  Object.getOwnPropertyDescriptor(proto, 'value').set.call(customer, customer.options[1].value)
  customer.dispatchEvent(new Event('change', { bubbles: true }))
  return true
})()`)
check('a customer was selected', filled === true, String(filled))
await sleep(800)
await evaluate(SET_VALUE('form input[placeholder="Your most common service"]', PROOF_SERVICE))
await evaluate(SET_VALUE('form input[type="date"]', PROOF_DATE))
await sleep(500)
// The S39 rule: verify the control state on screen before pressing a write.
const preSave = await evaluate(`(() => {
  const svc = document.querySelector('form input[placeholder="Your most common service"]')?.value
  const date = document.querySelector('form input[type="date"]')?.value
  const btn = [...document.querySelectorAll('form button[type=submit]')].find(b => b.textContent.trim() === 'Add job')
  return { svc, date, hasBtn: !!btn }
})()`)
check('the form shows exactly what will be saved', preSave?.svc === PROOF_SERVICE && preSave?.date === PROOF_DATE && preSave?.hasBtn,
  JSON.stringify(preSave))
if (preSave?.svc === PROOF_SERVICE && preSave?.date === PROOF_DATE) {
  await clickText('form button[type=submit]', 'Add job')
  await sleep(3500)
}
// Confirm in the DATABASE that exactly one proof visit exists.
let proofJob = null
for (let i = 0; i < 10 && !proofJob; i++) {
  const { data } = await db.from('jobs').select('id, service_type, scheduled_date, start_time, duration_minutes, notes, status, crew_id')
    .eq('user_id', UID).eq('service_type', PROOF_SERVICE)
  if (data && data.length === 1) proofJob = data[0]
  else await sleep(1000)
}
check('exactly one proof visit exists in the DB', !!proofJob, 'insert not observed')

// ── Layout + interaction proof at each width ─────────────────────────────────
for (const w of WIDTHS) {
  console.log(`\n═══ ${w}px — quick-edit sheet + full editor ═══`)
  await setWidth(w)
  await goto(`${baseUrl}/dashboard/schedule?d=${PROOF_DATE}`)
  await until(`[...document.querySelectorAll('main *')].some(el => (el.textContent || '').trim() === ${JSON.stringify(PROOF_SERVICE)})`,
    `the proof visit is on the ${PROOF_DATE} board`)

  // Open the stop card's overflow menu → Quick edit.
  const menuOpened = await evaluate(`(() => {
    const btn = [...document.querySelectorAll('button[aria-label="More actions"]')][0]
    if (!btn) return false
    btn.click(); return true
  })()`)
  check(`${w}: the overflow menu opens`, menuOpened === true)
  await sleep(600)
  check(`${w}: Quick edit is in the menu`, await clickText('[role="menuitem"], [role="menu"] button, [data-eq-menu] button, button', 'Quick edit', { exact: false }))
  const sheetSel = '[role="dialog"]'
  await until(`[...document.querySelectorAll('${sheetSel} h2')].some(h => (h.textContent || '').includes('Quick edit'))`, `${w}: the sheet opened`)

  const sheetShape = await evaluate(`(() => {
    const dlg = [...document.querySelectorAll('${sheetSel}')].find(d => [...d.querySelectorAll('h2')].some(h => (h.textContent || '').includes('Quick edit')))
    if (!dlg) return null
    const labels = [...dlg.querySelectorAll('label')].map(l => (l.textContent || '').trim())
    const save = [...dlg.querySelectorAll('button')].find(b => b.textContent.trim() === 'Save')
    const r = dlg.getBoundingClientRect()
    return { labels, saveDisabled: save ? save.disabled : null, fits: r.right <= innerWidth + 1 && r.left >= -1, saveVisible: save ? save.getBoundingClientRect().bottom <= innerHeight + 1 : false }
  })()`)
  const need = ['Service', 'Date', 'Start time', 'Duration (min)', 'Crew size', 'Status']
  check(`${w}: the sheet carries the fast-path fields`, !!sheetShape && need.every(n => sheetShape.labels.some(l => l.startsWith(n))),
    JSON.stringify(sheetShape?.labels))
  check(`${w}: assignee control matches the crew roster`,
    !!sheetShape && (activeCrews.length > 0) === sheetShape.labels.some(l => l.startsWith('Assigned crew')))
  check(`${w}: Save is disabled while nothing changed`, sheetShape?.saveDisabled === true)
  check(`${w}: the sheet fits the viewport and Save is reachable`, !!sheetShape && sheetShape.fits && sheetShape.saveVisible)

  // Dirty → said out loud → protected on dismiss.
  await evaluate(SET_VALUE(`${sheetSel} textarea`, `dirty probe ${w}`))
  await sleep(400)
  const dirtyState = await evaluate(`(() => {
    const dlg = [...document.querySelectorAll('${sheetSel}')].find(d => [...d.querySelectorAll('h2')].some(h => (h.textContent || '').includes('Quick edit')))
    const save = [...dlg.querySelectorAll('button')].find(b => b.textContent.trim() === 'Save')
    return { unsaved: (dlg.textContent || '').includes('Unsaved changes'), saveEnabled: save && !save.disabled }
  })()`)
  check(`${w}: dirt is said out loud and Save arms`, dirtyState?.unsaved === true && dirtyState?.saveEnabled === true, JSON.stringify(dirtyState))
  await evaluate(`(() => { [...document.querySelectorAll('${sheetSel} button[aria-label="Close"]')][0]?.click(); return true })()`)
  await sleep(600)
  const asked = await evaluate(`(() => document.body.textContent.includes('Discard these changes?'))()`)
  check(`${w}: dismissing a dirty sheet ASKS first`, asked === true)
  await clickText('button', 'Keep editing')
  await sleep(400)
  check(`${w}: Keep editing keeps the sheet`, await evaluate(`(() => [...document.querySelectorAll('${sheetSel} h2')].some(h => (h.textContent || '').includes('Quick edit')))()`) === true)
  await evaluate(`(() => { [...document.querySelectorAll('${sheetSel} button[aria-label="Close"]')][0]?.click(); return true })()`)
  await sleep(500)
  await clickText('button', 'Discard')
  await sleep(500)
  check(`${w}: Discard closes without saving`, await evaluate(`(() => [...document.querySelectorAll('${sheetSel} h2')].some(h => (h.textContent || '').includes('Quick edit')))()`) !== true)

  // ── The full editor ──
  await evaluate(`(() => { [...document.querySelectorAll('button[aria-label="More actions"]')][0]?.click(); return true })()`)
  await sleep(600)
  check(`${w}: Edit job is in the menu`, await clickText('[role="menuitem"], [role="menu"] button, button', 'Edit job', { exact: false }))
  await until(`[...document.querySelectorAll('h2')].some(h => h.textContent.trim() === 'Edit Job')`, `${w}: the editor opened`)
  const editorShape = await evaluate(`(() => {
    const form = document.querySelector('[role="dialog"] form')
    if (!form) return null
    const labels = [...form.querySelectorAll('label')].map(l => (l.textContent || '').trim())
    const txt = form.textContent || ''
    const more = [...form.querySelectorAll('button')].find(b => b.textContent.trim().startsWith('+ More options'))
    const update = [...form.querySelectorAll('button[type=submit]')].find(b => b.textContent.trim() === 'Update job')
    return { labels, hasMore: !!more, hasRepeatNow: txt.includes('Repeats'), hasPriceNow: labels.some(l => l.startsWith('Price')), hasUpdate: !!update }
  })()`)
  const primary = ['Customer', 'Property', 'Service Type', 'Date', 'Start Time', 'End Time', 'Duration', 'Status']
  check(`${w}: the common path is all visible, no disclosure in the way`,
    !!editorShape && primary.every(n => editorShape.labels.some(l => l.startsWith(n))), JSON.stringify(editorShape?.labels))
  check(`${w}: price and Repeat wait behind More options`,
    !!editorShape && editorShape.hasMore && !editorShape.hasPriceNow && !editorShape.hasRepeatNow)
  await clickText('form button', '+ More options', { exact: false })
  await sleep(600)
  const moreShape = await evaluate(`(() => {
    const form = document.querySelector('[role="dialog"] form')
    const labels = [...form.querySelectorAll('label')].map(l => (l.textContent || '').trim())
    return { hasPrice: labels.some(l => l.startsWith('Price')), hasRepeat: (form.textContent || '').includes('Repeats') || [...form.querySelectorAll('button')].some(b => (b.textContent || '').trim().startsWith('Repeat')) }
  })()`)
  check(`${w}: More options reveals price + Repeat`, !!moreShape && moreShape.hasPrice && moreShape.hasRepeat, JSON.stringify(moreShape))
  // Dirty indicator + protected close.
  await evaluate(SET_VALUE('[role="dialog"] form input[placeholder="Your most common service"]', PROOF_SERVICE + ' x'))
  await sleep(400)
  check(`${w}: the editor says Unsaved changes on typing`,
    await evaluate(`(() => (document.querySelector('[role="dialog"] form')?.textContent || '').includes('Unsaved changes'))()`) === true)
  await evaluate(`(() => { [...document.querySelectorAll('[role="dialog"] button[aria-label="Close"], button[aria-label="Close"]')].pop()?.click(); return true })()`)
  await sleep(600)
  check(`${w}: dismissing the dirty editor ASKS first`, await evaluate(`(() => document.body.textContent.includes('Discard this job?'))()`) === true)
  await clickText('button', 'Discard')
  await sleep(600)

  const over = await evaluate(OVERFLOW)
  check(`${w}: nothing overflows sideways`, Array.isArray(over) && over.length === 0, JSON.stringify(over))
}

// ── Save path (390): quick-edit the proof visit, then move it, DB-verified ───
console.log('\n═══ 390px — the save path, verified in the database ═══')
await setWidth(390)
await goto(`${baseUrl}/dashboard/schedule?d=${PROOF_DATE}`)
await until(`[...document.querySelectorAll('main *')].some(el => (el.textContent || '').trim() === ${JSON.stringify(PROOF_SERVICE)})`, 'proof visit on board')
await evaluate(`(() => { [...document.querySelectorAll('button[aria-label="More actions"]')][0]?.click(); return true })()`)
await sleep(600)
await clickText('[role="menuitem"], [role="menu"] button, button', 'Quick edit', { exact: false })
await until(`[...document.querySelectorAll('[role="dialog"] h2')].some(h => (h.textContent || '').includes('Quick edit'))`, 'sheet open for save')
const DLG = `[...document.querySelectorAll('[role="dialog"]')].find(d => [...d.querySelectorAll('h2')].some(h => (h.textContent || '').includes('Quick edit')))`
// Set: start 09:15, duration 45, service rename, note, and the date move.
const setAll = await evaluate(`(() => {
  const dlg = ${DLG}
  if (!dlg) return 'no dialog'
  const set = (el, v) => {
    const proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : el.tagName === 'SELECT' ? HTMLSelectElement.prototype : HTMLInputElement.prototype
    Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, v)
    el.dispatchEvent(new Event(el.tagName === 'SELECT' ? 'change' : 'input', { bubbles: true }))
  }
  const byLabel = t => [...dlg.querySelectorAll('label')].find(l => (l.textContent || '').trim().startsWith(t))?.querySelector('input, select, textarea')
    || (() => { const lab = [...dlg.querySelectorAll('label')].find(l => (l.textContent || '').trim().startsWith(t)); if (!lab) return null; const id = lab.getAttribute('for'); return id ? dlg.querySelector('#' + CSS.escape(id)) : null })()
  const svc = byLabel('Service'), date = byLabel('Date'), start = byLabel('Start time'), dur = byLabel('Duration (min)')
  const note = dlg.querySelector('textarea')
  if (!svc || !date || !start || !dur || !note) return 'missing controls: ' + JSON.stringify({ svc: !!svc, date: !!date, start: !!start, dur: !!dur, note: !!note })
  set(svc, ${JSON.stringify(PROOF_SERVICE + ' B')}); set(start, '09:15'); set(dur, '45')
  set(note, 's81 quick-edit proof'); set(date, ${JSON.stringify(PROOF_DATE_MOVED)})
  return true
})()`)
check('all six quick-edit controls are on screen and set', setAll === true, String(setAll))
if (setAll === true) {
  // S39 rule: read the sheet back before pressing Save.
  const preview = await evaluate(`(() => {
    const dlg = ${DLG}
    const vals = [...dlg.querySelectorAll('input, textarea')].map(i => i.value)
    const save = [...dlg.querySelectorAll('button')].find(b => b.textContent.trim() === 'Save')
    return { vals, saveEnabled: save && !save.disabled }
  })()`)
  const wants = [PROOF_SERVICE + ' B', PROOF_DATE_MOVED, '09:15', '45']
  check('the sheet shows exactly what Save will write', !!preview && preview.saveEnabled && wants.every(v => preview.vals.includes(v)), JSON.stringify(preview))
  await evaluate(`(() => { const dlg = ${DLG}; [...dlg.querySelectorAll('button')].find(b => b.textContent.trim() === 'Save')?.click(); return true })()`)
  await sleep(4000)
  // DB truth: fields + the move, and nothing else on the row changed.
  let after = null
  for (let i = 0; i < 10; i++) {
    const { data } = await db.from('jobs').select('id, service_type, scheduled_date, start_time, duration_minutes, notes, status, price, quote_id, recurrence_id').eq('id', proofJob.id).single()
    after = data
    if (after && after.scheduled_date === PROOF_DATE_MOVED) break
    await sleep(1000)
  }
  check('DB: service renamed', after?.service_type === PROOF_SERVICE + ' B', JSON.stringify(after))
  check('DB: start time written', after?.start_time?.startsWith('09:15') === true, String(after?.start_time))
  check('DB: duration written', after?.duration_minutes === 45, String(after?.duration_minutes))
  check('DB: note written', after?.notes === 's81 quick-edit proof', String(after?.notes))
  check('DB: the date change MOVED the visit (move engine, not a bare patch)', after?.scheduled_date === PROOF_DATE_MOVED, String(after?.scheduled_date))
  check('DB: status/price/links untouched', after?.status === 'scheduled' && after?.price === null && after?.quote_id === null && after?.recurrence_id === null,
    JSON.stringify({ status: after?.status, price: after?.price }))
}

// ── Clean up: delete the proof visit through the UI trash, verify in DB ──────
console.log('\n═══ Cleanup ═══')
await goto(`${baseUrl}/dashboard/schedule?d=${PROOF_DATE_MOVED}`)
await until(`[...document.querySelectorAll('main *')].some(el => (el.textContent || '').includes(${JSON.stringify(PROOF_SERVICE)}))`, 'moved visit on its new day')
await evaluate(`(() => { [...document.querySelectorAll('button[aria-label="More actions"]')][0]?.click(); return true })()`)
await sleep(600)
await clickText('[role="menuitem"], [role="menu"] button, button', 'Edit job', { exact: false })
await until(`[...document.querySelectorAll('h2')].some(h => h.textContent.trim() === 'Edit Job')`, 'editor open for delete')
await evaluate(`(() => { document.querySelector('button[aria-label="Delete job"]')?.click(); return true })()`)
await sleep(2500)
let gone = false
for (let i = 0; i < 10 && !gone; i++) {
  const { data } = await db.from('jobs').select('id').eq('id', proofJob?.id ?? '00000000-0000-0000-0000-000000000000')
  gone = !data || data.length === 0
  if (!gone) await sleep(1000)
}
check('the proof visit is deleted from the DB', gone)

console.log('\n── Summary ────────────────────────────────────────────────────')
await db.auth.signOut({ scope: 'local' })
try { chrome.kill() } catch { /* already gone */ }
if (fails) { console.log(`\n❌ jobeditor-cdp — ${fails} failure${fails === 1 ? '' : 's'}\n`); process.exit(1) }
console.log('\n✅ jobeditor-cdp — sheet + editor proven at 375/390/430, save path DB-verified, proof data removed\n')
