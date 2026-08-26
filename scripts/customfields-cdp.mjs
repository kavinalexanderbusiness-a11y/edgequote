// ── Drive the REAL app: Custom Fields V1 on production ───────────────────────
// Signs in with the owner credentials from .env.local and proves Session 70 the
// way a person would, at 375 / 390 / 430 / desktop:
//
//   1. SETTINGS: a field is created through the real "Add a custom field" modal,
//      appears in the list, and lands in the database.
//   2. CUSTOMER / SERVICE LOCATION / VISIT: the Details section renders one
//      control per type (text, long text, number, yes/no, date, dropdown), each
//      accepts a value, "Save details" persists it, and a RELOAD still shows it.
//      Every value is also re-read from the database, because a screen that
//      remembers its own optimistic state is not proof of a write.
//   3. REFUSALS the browser itself enforces: a number input refuses letters, a
//      date input refuses a non-date, and a dropdown offers only defined options
//      (so an invalid choice is not expressible rather than merely rejected).
//   4. ARCHIVE: archiving a field keeps the answer already recorded on screen and
//      read-only, and stops offering it for new answers.
//   5. LAYOUT: no element overflows sideways at any width.
//
//   node scripts/customfields-cdp.mjs <baseUrl>
//
// The definitions are ZZ-S70 labelled disposable fixtures. Values are written to
// the owner's real records and removed again by cfseed.mjs clean.
// ⚠️ Fresh Chrome profile every run — a persistent one serves a stale bundle.

import { spawn } from 'node:child_process'
import { readFileSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createClient } from '@supabase/supabase-js'

const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'
const [baseUrl = 'https://app.edgehq.ca'] = process.argv.slice(2)
const PORT = 9491 + Number(process.env.CDP_SLOT || 0)
const WIDTHS = [375, 390, 430]

// Records are RESOLVED, never hardcoded: a harness pinned to one book's ids stops
// being runnable the moment it is pointed at a different tenant.
let CUSTOMER = null
let PROPERTY = null

// One value per type. Chosen so a wrong-column write would be visible.
const VALUES = {
  text: 'ZZ gate 4471',
  textarea: 'ZZ long note, second clause',
  number: '42.5',
  date: '2027-03-01',
  select: 'silver',
  boolean: true,
}

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

const db = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.NEXT_PUBLIC_SUPABASE_ANON_KEY, { auth: { persistSession: false } })
const auth = await db.auth.signInWithPassword({ email: EMAIL, password: PASSWORD })
if (auth.error) { console.error('DB sign-in failed: ' + auth.error.message); process.exit(2) }
const UID = auth.data.user.id

// The visit we will edit: pick one the owner already has, far from today is not
// required because we only touch its Details, never its schedule.
const { data: jobRows } = await db.from('jobs').select('id, scheduled_date').eq('user_id', UID)
  .order('scheduled_date', { ascending: false }).limit(1)
const JOB = jobRows?.[0]?.id
const JOB_DATE = jobRows?.[0]?.scheduled_date

// A customer that actually has a service location, so both record screens under
// test belong to the same real thread of work rather than two unrelated rows.
const { data: propRows } = await db.from('properties').select('id, customer_id').eq('user_id', UID).limit(50)
const withCustomer = (propRows || []).find(p => p.customer_id)
if (withCustomer) { PROPERTY = withCustomer.id; CUSTOMER = withCustomer.customer_id }
else {
  const { data: custRows } = await db.from('customers').select('id').eq('user_id', UID).limit(1)
  CUSTOMER = custRows?.[0]?.id
  PROPERTY = (propRows || [])[0]?.id
}
if (!CUSTOMER || !PROPERTY || !JOB) {
  console.error(`this book lacks a record to test against — customer=${CUSTOMER} property=${PROPERTY} job=${JOB}`)
  process.exit(2)
}
console.log(`owner ${UID}\ncustomer ${CUSTOMER}\nproperty ${PROPERTY}\nvisit under test: ${JOB} on ${JOB_DATE}`)

// ── The disposable definitions this proof drives ─────────────────────────────
// Seeded here rather than by hand, so the run is repeatable and leaves nothing:
// one field of every supported type on each of the three record kinds.
const TYPES = [
  ['text', 'text', []],
  ['textarea', 'textarea', []],
  ['number', 'number', []],
  ['boolean', 'boolean', []],
  ['date', 'date', []],
  ['select', 'select', [{ value: 'gold', label: 'Gold' }, { value: 'silver', label: 'Silver' }]],
]
const ENTITIES = ['customer', 'property', 'job']
async function teardown() {
  const { data: defs } = await db.from('custom_field_definitions').select('id')
    .eq('user_id', UID).like('field_key', 'zz_s70_%')
  for (const d of defs || []) {
    await db.from('custom_field_values').delete().eq('definition_id', d.id)
    await db.from('custom_field_definitions').delete().eq('id', d.id)
  }
  const { data: left } = await db.from('custom_field_definitions').select('id')
    .eq('user_id', UID).like('field_key', 'zz_s70_%')
  return (left || []).length
}
await teardown()   // a previous run's leftovers are not this run's state
{
  const rows = []
  let sort = 0
  for (const entity of ENTITIES) {
    for (const [name, field_type, options] of TYPES) {
      rows.push({ user_id: UID, entity, field_key: `zz_s70_${name}`, label: `ZZ-S70 ${name}`, field_type, options, sort_order: sort++ })
    }
  }
  const { error: seedErr } = await db.from('custom_field_definitions').insert(rows)
  if (seedErr) { console.error('could not seed the proof definitions: ' + seedErr.message); process.exit(2) }
  console.log(`seeded ${rows.length} disposable ZZ-S70 definitions (${ENTITIES.length} record kinds x ${TYPES.length} types)`)
}

const profile = mkdtempSync(join(tmpdir(), 'customfields-cdp-'))
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
const M = await import("ws").catch(() => ({ WebSocket: globalThis.WebSocket }))
const ws = new ((M.WebSocket || M.default))(wsUrl)
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
  for (let i = 0; i < 100; i++) { await sleep(250); if (await evaluate('document.readyState === "complete"')) break }
  // Production is a cold serverless render behind a real network: readyState
  // complete lands well before the client has fetched and painted a record's
  // sections. A short settle here reported "no Details section" on screens that
  // simply had not arrived yet.
  await sleep(3500)
}
async function setWidth(w, mobile = true) {
  await send('Emulation.setDeviceMetricsOverride', { width: w, height: 900, deviceScaleFactor: mobile ? 2 : 1, mobile })
}
async function until(expr, label, tries = 80) {
  for (let i = 0; i < tries; i++) { if (await evaluate(expr) === true) return true; await sleep(250) }
  bad(`${label} (timed out)`, expr.slice(0, 110))
  return false
}
const clickText = (sel, text, exact = true) => evaluate(`(() => {
  const els = [...document.querySelectorAll(${JSON.stringify(sel)})]
  const t = ${JSON.stringify(text)}
  const el = els.find(e => ${exact ? '(e.textContent||"").trim() === t' : '(e.textContent||"").trim().includes(t)'})
  if (!el) return false
  el.click(); return true
})()`)

// Find the control that a visible LABEL text belongs to. The UI primitives wire
// label→control with htmlFor/id, so resolve through that and fall back to the
// nearest control inside the label's own block.
// ⚠️ EXACT match, not startsWith. "ZZ-S70 text" is a prefix of "ZZ-S70 textarea",
// so a prefix match silently resolves the wrong control — which made the archive
// check report that an archived field was still offered when what it had actually
// found was the long-text field sitting next to it.
const CONTROL_FOR = label => `(() => {
  const t = ${JSON.stringify(label)}
  const lab = [...document.querySelectorAll('label')].find(l => (l.textContent||'').trim() === t)
  if (!lab) return null
  if (lab.htmlFor) { const byId = document.getElementById(lab.htmlFor); if (byId) return byId }
  const scope = lab.closest('div')
  return scope ? scope.querySelector('input,textarea,select') : null
})()`
const setByLabel = (label, value) => evaluate(`(() => {
  const el = ${CONTROL_FOR(label)}
  if (!el) return 'NO_CONTROL'
  const proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype
    : el.tagName === 'SELECT' ? HTMLSelectElement.prototype : HTMLInputElement.prototype
  Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, ${JSON.stringify(String(value))})
  el.dispatchEvent(new Event(el.tagName === 'SELECT' ? 'change' : 'input', { bubbles: true }))
  return el.value
})()`)
const readByLabel = label => evaluate(`(() => {
  const el = ${CONTROL_FOR(label)}
  return el ? el.value : 'NO_CONTROL'
})()`)
// ⚠️ The customer screen has its OWN "Edit" in the header (title="Edit name,
// contact and address"), and it comes FIRST in the DOM. A loose text match hits
// that one and opens the wrong editor — which still returns true, so the harness
// reports a pass while proving nothing. Scope the click to the Details section.
const CLICK_DETAILS_EDIT = `(() => {
  const h = [...document.querySelectorAll('h3')].find(x => (x.textContent||'').trim().startsWith('Details'))
  if (!h) return 'NO_DETAILS'
  let scope = h.parentElement
  for (let i = 0; i < 4 && scope; i++) {
    const btn = [...scope.querySelectorAll('button')].find(b => (b.textContent||'').trim() === 'Edit')
    if (btn) { btn.click(); return 'CLICKED' }
    scope = scope.parentElement
  }
  return 'NO_EDIT_NEAR_DETAILS'
})()`
// When a dialog is open it is the surface under test; the day board behind it is
// not, and scanning both reports the board's own chrome as this feature's overflow.
const OVERFLOW = `(() => {
  const out = []
  const dlg = document.querySelector('[role="dialog"]')
  const scope = dlg || document.querySelector('main') || document.body
  for (const el of scope.querySelectorAll('*')) {
    const r = el.getBoundingClientRect()
    if (r.width === 0) continue
    if (r.right > innerWidth + 1 || r.left < -1) out.push(el.tagName.toLowerCase() + '.' + String(el.className||'').slice(0,40))
  }
  return out.slice(0, 4)
})()`

await send('Page.enable'); await send('Runtime.enable')

// ── Sign in ──────────────────────────────────────────────────────────────────
await setWidth(390)
await goto(`${baseUrl}/login`)
await evaluate(`(() => {
  const set = (el, v) => { Object.getOwnPropertyDescriptor(el.constructor.prototype,'value').set.call(el, v)
    el.dispatchEvent(new Event('input', { bubbles: true })) }
  const em = document.querySelector('input[type=email]'), pw = document.querySelector('input[type=password]')
  if (em) set(em, ${JSON.stringify(EMAIL)})
  if (pw) set(pw, ${JSON.stringify(PASSWORD)})
  document.querySelector('form')?.requestSubmit(); return true
})()`)
await sleep(7000)
const path = await evaluate('location.pathname')
check('signed in as the owner on production', !String(path).includes('/login'), `still at ${path}`)
const served = await evaluate(`fetch('/api/health').then(r=>r.json()).then(j=>j.commit).catch(()=>'?')`)
console.log(`production is serving commit ${served}`)

// ── 1. The settings surface creates a field through the real modal ───────────
console.log('\n═══ 1. Settings — create a field through the real modal ═══')
// A proof starts from a known state: a previous run's field would otherwise make
// "exactly one row" fail for a reason that has nothing to do with the product.
{
  const { data: old } = await db.from('custom_field_definitions').select('id')
    .eq('user_id', UID).eq('label', 'ZZ-S70 modal made')
  for (const row of old || []) {
    await db.from('custom_field_values').delete().eq('definition_id', row.id)
    await db.from('custom_field_definitions').delete().eq('id', row.id)
  }
  if ((old || []).length) console.log(`  (cleared ${old.length} field(s) left by an earlier run)`)
}
await goto(`${baseUrl}/dashboard/settings`)
await until(`!!document.querySelector('main')`, 'settings painted')
const foundCF = await evaluate(`/Custom fields|Custom Fields/.test(document.body.innerText)`)
check('the Custom fields card is on the settings screen', foundCF === true)
// The settings screen is long and its cards hydrate independently; the per-entity
// door appears after the definitions load, not when readyState says complete.
await until(`[...document.querySelectorAll('button')].some(b => (b.textContent||'').trim().startsWith('Add to '))`,
  'the per-record-kind "Add to …" door appeared')
// The door is per record kind — "Add to customers" / "Add to service locations"
// / "Add to visits" — and the MODAL is the thing titled "Add a custom field".
const opened = await evaluate(`(() => {
  const btn = [...document.querySelectorAll('button')].find(b => (b.textContent||'').trim().startsWith('Add to '))
  if (!btn) return 'NO_ADD_DOOR'
  btn.click(); return 'CLICKED'
})()`) === 'CLICKED'
await until(`[...document.querySelectorAll('h2')].some(h => (h.textContent||'').trim() === 'Add a custom field')`, 'the add-field modal appeared', 40)
const modalUp = await evaluate(`[...document.querySelectorAll('h2')].some(h => (h.textContent||'').trim() === 'Add a custom field')`)
check('the "Add a custom field" modal opens', opened === true && modalUp === true,
  `door clicked: ${opened}, modal present: ${modalUp}`)
if (modalUp === true) {
  await setByLabel('Field name', 'ZZ-S70 modal made')
  await sleep(300)
  // entity + type selects are only offered while the field is new
  await evaluate(`(() => {
    const sels = [...document.querySelectorAll('select')]
    for (const s of sels) {
      const opts = [...s.options].map(o => o.value)
      if (opts.includes('customer')) { s.value = 'customer'; s.dispatchEvent(new Event('change', {bubbles:true})) }
      if (opts.includes('text') && opts.includes('number')) { s.value = 'text'; s.dispatchEvent(new Event('change', {bubbles:true})) }
    }
    return true
  })()`)
  await sleep(400)
  // ⚠️ Scope to the dialog: the settings screen has its own "Add field" button,
  // it comes first in the DOM, and a document-wide match clicks that one instead —
  // reporting a save that never happened.
  const saved = await evaluate(`(() => {
    const dlg = document.querySelector('[role="dialog"]')
    if (!dlg) return 'NO_DIALOG'
    const b = [...dlg.querySelectorAll('button')].find(x => (x.textContent||'').trim() === 'Add field')
    if (!b) return 'NO_SAVE_IN_DIALOG:' + [...dlg.querySelectorAll('button')].map(x => (x.textContent||'').trim()).join('|')
    b.click(); return 'CLICKED'
  })()`) === 'CLICKED'
  await sleep(6000)
  const { data: made } = await db.from('custom_field_definitions').select('id,label,field_type,entity')
    .eq('user_id', UID).eq('label', 'ZZ-S70 modal made')
  check('the field the modal created is IN THE DATABASE', (made || []).length === 1,
    `found ${(made || []).length} rows`)
  check('…as a customer text field', made?.[0]?.entity === 'customer' && made?.[0]?.field_type === 'text',
    JSON.stringify(made?.[0] || {}))
  check('…and the modal closed after saving', saved === true && await evaluate(`![...document.querySelectorAll('h2')].some(h => (h.textContent||'').trim() === 'Add a custom field')`) === true)
}

// ── 2. Details on each record type ───────────────────────────────────────────
const RECORDS = [
  ['CUSTOMER', `${baseUrl}/dashboard/customers/${CUSTOMER}`, 'customer', { customer_id: CUSTOMER }],
  ['SERVICE LOCATION', `${baseUrl}/dashboard/properties/${PROPERTY}`, 'property', { property_id: PROPERTY }],
]
for (const [name, url, entity, filter] of RECORDS) {
  console.log(`\n═══ 2. ${name} — every type saves, and survives a reload ═══`)
  await setWidth(390)
  await goto(url)
  await until(`[...document.querySelectorAll('h3')].some(h => (h.textContent||'').trim().startsWith('Details'))`,
    `${name}: the Details heading appeared`)
  const hasDetails = await evaluate(`[...document.querySelectorAll('h3')].some(h => (h.textContent||'').trim().startsWith('Details'))`)
  check(`${name}: the Details section is on the record`, hasDetails === true)
  const editOpened = await evaluate(CLICK_DETAILS_EDIT)
  await sleep(1800)
  check(`${name}: the one Edit control opens the whole section`, editOpened === 'CLICKED', String(editOpened))

  // dropdown offers ONLY the defined options — an invalid choice is not expressible
  const selOpts = await evaluate(`(() => {
    const el = ${CONTROL_FOR('ZZ-S70 select')}
    return el && el.tagName === 'SELECT' ? [...el.options].map(o => o.value) : 'NO_SELECT'
  })()`)
  check(`${name}: the dropdown offers only its defined choices`,
    Array.isArray(selOpts) && selOpts.filter(Boolean).sort().join(',') === 'gold,silver',
    JSON.stringify(selOpts))

  // number/date inputs are typed, so the browser itself refuses the wrong shape
  const numType = await evaluate(`(() => { const el = ${CONTROL_FOR('ZZ-S70 number')}; return el ? el.type : 'NONE' })()`)
  const dateType = await evaluate(`(() => { const el = ${CONTROL_FOR('ZZ-S70 date')}; return el ? el.type : 'NONE' })()`)
  check(`${name}: the number field is a number input (a phone gets a numeric keypad)`, numType === 'number', `type=${numType}`)
  check(`${name}: the date field is a date input (value arrives as YYYY-MM-DD)`, dateType === 'date', `type=${dateType}`)
  const badNum = await setByLabel('ZZ-S70 number', 'abc')
  check(`${name}: the number input REFUSES letters`, badNum === '' || badNum === 'NO_CONTROL' ? badNum !== 'NO_CONTROL' : false,
    `input kept "${badNum}"`)
  const badDate = await setByLabel('ZZ-S70 date', 'not-a-date')
  check(`${name}: the date input REFUSES a non-date`, badDate === '', `input kept "${badDate}"`)

  // now the real values
  await setByLabel('ZZ-S70 text', VALUES.text)
  await setByLabel('ZZ-S70 textarea', VALUES.textarea)
  await setByLabel('ZZ-S70 number', VALUES.number)
  await setByLabel('ZZ-S70 date', VALUES.date)
  await setByLabel('ZZ-S70 select', VALUES.select)
  await evaluate(`(() => {
    const t = [...document.querySelectorAll('[aria-label="ZZ-S70 boolean"],[role=switch]')]
      .find(e => (e.getAttribute('aria-label')||'') === 'ZZ-S70 boolean')
    if (!t) return 'NO_TOGGLE'
    if (t.getAttribute('aria-checked') !== 'true') t.click()
    return t.getAttribute('aria-checked')
  })()`)
  await sleep(400)
  const savedClick = await clickText('button', 'Save details', false)
  await sleep(5000)
  check(`${name}: Save details completes`, savedClick === true)

  // the database is the witness, not the screen
  let dbq = db.from('custom_field_values')
    .select('value_text,value_number,value_boolean,value_date,custom_field_definitions!inner(field_key)')
    .eq('user_id', UID)
  for (const [k, v] of Object.entries(filter)) dbq = dbq.eq(k, v)
  const { data: vals, error: valErr } = await dbq
  if (valErr) { bad(`${name}: could not re-read values from the database`, valErr.message) }
  else {
    const by = {}
    for (const r of vals || []) by[r.custom_field_definitions.field_key] = r
    check(`${name}: text persisted`, by.zz_s70_text?.value_text === VALUES.text, JSON.stringify(by.zz_s70_text))
    check(`${name}: long text persisted`, by.zz_s70_textarea?.value_text === VALUES.textarea, JSON.stringify(by.zz_s70_textarea))
    check(`${name}: number persisted as a NUMBER`, Number(by.zz_s70_number?.value_number) === 42.5, JSON.stringify(by.zz_s70_number))
    check(`${name}: yes/no persisted as a BOOLEAN`, by.zz_s70_boolean?.value_boolean === true, JSON.stringify(by.zz_s70_boolean))
    check(`${name}: date persisted as a DATE`, String(by.zz_s70_date?.value_date).startsWith('2027-03-01'), JSON.stringify(by.zz_s70_date))
    check(`${name}: dropdown persisted the stable slug`, by.zz_s70_select?.value_text === 'silver', JSON.stringify(by.zz_s70_select))
    // ⚠️ every() on an empty array is true, which would report a pass for rows
    // that were never written. Require the six answers to actually be there.
    check(`${name}: each answer used exactly ONE typed column (over ${(vals || []).length} rows)`,
      (vals || []).length >= 6
      && (vals || []).every(r => [r.value_text, r.value_number, r.value_boolean, r.value_date].filter(x => x !== null).length === 1),
      `${(vals || []).length} value rows found — expected at least 6`)
  }

  // reload: the screen shows what the database holds
  await goto(url)
  await until(`[...document.querySelectorAll('h3')].some(h => (h.textContent||'').trim().startsWith('Details'))`,
    `${name} reloaded`)
  const shown = await evaluate('document.body.innerText')
  const txt = String(shown || '')
  check(`${name}: after a RELOAD the text value is on screen`, txt.includes(VALUES.text))
  check(`${name}: after a RELOAD the long text is on screen`, txt.includes('ZZ long note'))
  check(`${name}: after a RELOAD the number is on screen`, /42\.5/.test(txt))
  check(`${name}: after a RELOAD the dropdown shows its LABEL, not its slug`, txt.includes('Silver'), 'expected the option label "Silver"')

  // layout at every width
  for (const w of WIDTHS) {
    await setWidth(w)
    await sleep(900)
    const over = await evaluate(OVERFLOW)
    check(`${name} @${w}px: nothing overflows sideways`, Array.isArray(over) && over.length === 0, JSON.stringify(over))
  }
  await setWidth(1280, false)
  await sleep(900)
  const overD = await evaluate(OVERFLOW)
  check(`${name} @desktop: nothing overflows sideways`, Array.isArray(overD) && overD.length === 0, JSON.stringify(overD))
}

// ── 2c. The VISIT surface, which lives inside the job editor ─────────────────
// A `jobs` row IS a visit, and the section is EDIT ONLY: an answer is stored
// against a visit's id, so on create there is no visit yet to answer about.
console.log('\n═══ 2. VISIT — every type saves inside the job editor, and survives a reopen ═══')
if (!JOB || !JOB_DATE) {
  bad('VISIT: the owner has no visit to test against')
} else {
  await setWidth(390)
  await goto(`${baseUrl}/dashboard/schedule?d=${JOB_DATE}`)
  await until(`!!document.querySelector('button[aria-label="More actions"]')`, 'VISIT: the day board painted')
  await evaluate(`(() => { document.querySelector('button[aria-label="More actions"]')?.click(); return true })()`)
  await sleep(900)
  const editJob = await clickText('[role="menuitem"], [role="menu"] button, button', 'Edit job', false)
  check('VISIT: "Edit job" opens the editor', editJob === true)
  await until(`[...document.querySelectorAll('h2')].some(h => (h.textContent||'').trim() === 'Edit Job')`, 'VISIT: the editor opened')
  // ⭐ On a VISIT the Details section lives behind S81's progressive disclosure —
  // the compact editor keeps price/repeat/photos/custom fields out of the common
  // path. So it is not missing; it has to be asked for.
  const moreOpened = await evaluate(`(() => {
    const b = [...document.querySelectorAll('button')].find(x => (x.textContent||'').trim().startsWith('+ More options'))
    if (!b) return (document.body.innerText||'').includes('Fewer options') ? 'ALREADY_OPEN' : 'NO_MORE_BUTTON'
    b.click(); return 'CLICKED'
  })()`)
  await sleep(1800)
  check("VISIT: '+ More options' reveals the visit's own sections", moreOpened === 'CLICKED' || moreOpened === 'ALREADY_OPEN', String(moreOpened))
  const visitHasDetails = await evaluate(`[...document.querySelectorAll('h3')].some(h => (h.textContent||'').trim().startsWith('Details'))`)
  check('VISIT: the Details section is inside the job editor', visitHasDetails === true)

  const visitEdit = await evaluate(CLICK_DETAILS_EDIT)
  await sleep(1800)
  check('VISIT: the Details Edit control opens the section', visitEdit === 'CLICKED', String(visitEdit))

  const vNum = await evaluate(`(() => { const el = ${CONTROL_FOR('ZZ-S70 number')}; return el ? el.type : 'NONE' })()`)
  const vDate = await evaluate(`(() => { const el = ${CONTROL_FOR('ZZ-S70 date')}; return el ? el.type : 'NONE' })()`)
  check('VISIT: the number field is a number input', vNum === 'number', `type=${vNum}`)
  check('VISIT: the date field is a date input', vDate === 'date', `type=${vDate}`)
  const vSel = await evaluate(`(() => {
    const el = ${CONTROL_FOR('ZZ-S70 select')}
    return el && el.tagName === 'SELECT' ? [...el.options].map(o => o.value) : 'NO_SELECT'
  })()`)
  check('VISIT: the dropdown offers only its defined choices',
    Array.isArray(vSel) && vSel.filter(Boolean).sort().join(',') === 'gold,silver', JSON.stringify(vSel))

  await setByLabel('ZZ-S70 text', VALUES.text)
  await setByLabel('ZZ-S70 textarea', VALUES.textarea)
  await setByLabel('ZZ-S70 number', VALUES.number)
  await setByLabel('ZZ-S70 date', VALUES.date)
  await setByLabel('ZZ-S70 select', VALUES.select)
  await evaluate(`(() => {
    const t = [...document.querySelectorAll('[role=switch]')].find(e => (e.getAttribute('aria-label')||'') === 'ZZ-S70 boolean')
    if (!t) return 'NO_TOGGLE'
    if (t.getAttribute('aria-checked') !== 'true') t.click()
    return t.getAttribute('aria-checked')
  })()`)
  await sleep(400)
  const vSaved = await clickText('button', 'Save details', false)
  await sleep(5500)
  check('VISIT: Save details completes', vSaved === true)

  const { data: jv, error: jvErr } = await db.from('custom_field_values')
    .select('value_text,value_number,value_boolean,value_date,custom_field_definitions!inner(field_key)')
    .eq('user_id', UID).eq('job_id', JOB)
  if (jvErr) bad('VISIT: could not re-read values from the database', jvErr.message)
  else {
    const by = {}
    for (const r of jv || []) by[r.custom_field_definitions.field_key] = r
    check('VISIT: text persisted', by.zz_s70_text?.value_text === VALUES.text, JSON.stringify(by.zz_s70_text))
    check('VISIT: long text persisted', by.zz_s70_textarea?.value_text === VALUES.textarea, JSON.stringify(by.zz_s70_textarea))
    check('VISIT: number persisted as a NUMBER', Number(by.zz_s70_number?.value_number) === 42.5, JSON.stringify(by.zz_s70_number))
    check('VISIT: yes/no persisted as a BOOLEAN', by.zz_s70_boolean?.value_boolean === true, JSON.stringify(by.zz_s70_boolean))
    check('VISIT: date persisted as a DATE', String(by.zz_s70_date?.value_date).startsWith('2027-03-01'), JSON.stringify(by.zz_s70_date))
    check('VISIT: dropdown persisted the stable slug', by.zz_s70_select?.value_text === 'silver', JSON.stringify(by.zz_s70_select))
    check(`VISIT: each answer used exactly ONE typed column (over ${(jv || []).length} rows)`,
      (jv || []).length >= 6
      && (jv || []).every(r => [r.value_text, r.value_number, r.value_boolean, r.value_date].filter(x => x !== null).length === 1),
      `${(jv || []).length} value rows found — expected at least 6`)
  }

  // reopen the editor: the answers come back from the database, not from state
  await goto(`${baseUrl}/dashboard/schedule?d=${JOB_DATE}`)
  await until(`!!document.querySelector('button[aria-label="More actions"]')`, 'VISIT: day board painted again')
  await evaluate(`(() => { document.querySelector('button[aria-label="More actions"]')?.click(); return true })()`)
  await sleep(900)
  await clickText('[role="menuitem"], [role="menu"] button, button', 'Edit job', false)
  await until(`[...document.querySelectorAll('h2')].some(h => (h.textContent||'').trim() === 'Edit Job')`, 'VISIT: editor reopened')
  // The disclosure is closed again on a fresh open — that is the compact editor
  // working, so ask for the section a second time before reading it.
  await evaluate(`(() => {
    const b = [...document.querySelectorAll('button')].find(x => (x.textContent||'').trim().startsWith('+ More options'))
    if (b) b.click()
    return true
  })()`)
  await until(`[...document.querySelectorAll('h3')].some(h => (h.textContent||'').trim().startsWith('Details'))`,
    'VISIT: Details is back after the reopen')
  const vTxt = String(await evaluate('document.body.innerText') || '')
  check('VISIT: after a REOPEN the text value is on screen', vTxt.includes(VALUES.text))
  check('VISIT: after a REOPEN the number is on screen', /42\.5/.test(vTxt))
  check('VISIT: after a REOPEN the dropdown shows its LABEL, not its slug', vTxt.includes('Silver'))
  for (const w of WIDTHS) {
    await setWidth(w)
    await sleep(900)
    const over = await evaluate(OVERFLOW)
    check(`VISIT @${w}px: nothing overflows sideways`, Array.isArray(over) && over.length === 0, JSON.stringify(over))
  }
}

// ── 3. Archive keeps history and stops offering the field ────────────────────
console.log('\n═══ 3. Archiving keeps the answer and stops offering the field ═══')
const { data: archDef } = await db.from('custom_field_definitions').select('id')
  .eq('user_id', UID).eq('entity', 'customer').eq('field_key', 'zz_s70_text').limit(1)
if (archDef?.[0]) {
  await db.from('custom_field_definitions').update({ archived_at: new Date().toISOString() }).eq('id', archDef[0].id)
  await setWidth(390)
  await goto(`${baseUrl}/dashboard/customers/${CUSTOMER}`)
  await until(`[...document.querySelectorAll('h3')].some(h => (h.textContent||'').trim().startsWith('Details'))`,
    'customer reloaded after archive')
  const afterTxt = String(await evaluate('document.body.innerText') || '')
  check('the archived field STILL shows the answer already recorded', afterTxt.includes(VALUES.text))
  const stillEditable = await evaluate(CLICK_DETAILS_EDIT)
  await sleep(1800)
  const offered = await evaluate(`(() => {
    const el = ${CONTROL_FOR('ZZ-S70 text')}
    return el ? 'OFFERED' : 'NOT_OFFERED'
  })()`)
  check('the archived field is NOT offered for a new answer', offered === 'NOT_OFFERED',
    `edit mode ${stillEditable === true ? 'opened' : String(stillEditable)}, control was ${offered}`)
  const { data: kept } = await db.from('custom_field_values').select('value_text')
    .eq('user_id', UID).eq('definition_id', archDef[0].id)
  check('the archived answer is still IN THE DATABASE', kept?.[0]?.value_text === VALUES.text, JSON.stringify(kept))
  await db.from('custom_field_definitions').update({ archived_at: null }).eq('id', archDef[0].id)
}

// ── Leave the book exactly as it was found ───────────────────────────────────
const leftover = await teardown()
check('every disposable definition and answer was removed', leftover === 0, `${leftover} left behind`)

console.log(`\n${fails === 0 ? '✅' : '❌'} customfields-cdp — ${fails} failed`)
ws.close(); chrome.kill()
process.exit(fails === 0 ? 0 : 1)
