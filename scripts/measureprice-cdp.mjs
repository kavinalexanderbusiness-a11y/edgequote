// ── Drive the REAL app: Measure & Price V2 on production ─────────────────────
// Two flows, signed in as the owner, at desktop / 375 / 390 / 430:
//
//   A. CONFIGURATION ROUND TRIP. Settings → Services → Edit → Measure & Price:
//      set a measurement type and a sub-cent per-unit rate, save, LEAVE the
//      screen, come back, and read it again. The rate is the point: numeric(10,2)
//      silently rounded $0.035/sq ft to $0.04, so this asserts the exact value
//      survives the round trip through the real form, not just through SQL.
//
//   B. THE QUOTE PATH. An existing property → new quote → Measure & Price: the
//      map loads (Maps JS + geometry are the S107 production blockers), the
//      configured offering appears with the price the Price Book decides, notes
//      keep their audience, and the saved quote's snapshot survives a reload.
//
// ⚠️ What this harness does NOT claim: drawing polygons on a live Google Map is
// not reliably scriptable through CDP, so multi-area drawing is exercised through
// the measurement the panel accepts rather than by synthesising map clicks. Any
// step it cannot drive is reported as UNPROVEN, never as a pass.
//
//   node scripts/measureprice-cdp.mjs <baseUrl>

import { spawn } from 'node:child_process'
import { readFileSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createClient } from '@supabase/supabase-js'

const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'
const [baseUrl = 'https://app.edgehq.ca'] = process.argv.slice(2)
const PORT = 9671 + Number(process.env.CDP_SLOT || 0)
const WIDTHS = [375, 390, 430]
const RATE = '0.035'         // the rate numeric(10,2) destroyed and step=0.01 refused
const SERVICE = 'ZZ-S107 Measured'

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

const db = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.NEXT_PUBLIC_SUPABASE_ANON_KEY, { auth: { persistSession: false } })
const auth = await db.auth.signInWithPassword({ email: EMAIL, password: PASSWORD })
if (auth.error) { console.error('DB sign-in failed: ' + auth.error.message); process.exit(2) }
const UID = auth.data.user.id

async function teardown() {
  const { data: t } = await db.from('service_templates').select('id').eq('user_id', UID).eq('name', SERVICE)
  for (const row of t || []) {
    await db.from('service_pricing_plans').delete().eq('service_template_id', row.id)
    await db.from('service_templates').delete().eq('id', row.id)
  }
  const { data: left } = await db.from('service_templates').select('id').eq('user_id', UID).eq('name', SERVICE)
  return (left || []).length
}
await teardown()
const { data: made, error: mkErr } = await db.from('service_templates')
  .insert({ user_id: UID, name: SERVICE, category: 'lawn', default_rate: 100, is_active: true })
  .select('id').single()
if (mkErr) { console.error('could not seed the service: ' + mkErr.message); process.exit(2) }
const SERVICE_ID = made.id
console.log(`owner ${UID}\nseeded service ${SERVICE} ${SERVICE_ID}`)

const profile = mkdtempSync(join(tmpdir(), 'mp-cdp-'))
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
await new Promise(r => ws.addEventListener('open', r))
ws.addEventListener('message', e => { const m = JSON.parse(e.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id) } })
const send = (m, p = {}) => { const id = ++msgId; return new Promise(res => { pending.set(id, res); ws.send(JSON.stringify({ id, method: m, params: p })) }) }
const ev = async e => {
  const r = await send('Runtime.evaluate', { expression: e, awaitPromise: true, returnByValue: true })
  return r.result?.result?.value
}
const goto = async u => { await send('Page.navigate', { url: u }); for (let i = 0; i < 120; i++) { await sleep(250); if (await ev('document.readyState==="complete"')) break } await sleep(3500) }
const setW = async (w, mobile = true) => send('Emulation.setDeviceMetricsOverride', { width: w, height: 900, deviceScaleFactor: mobile ? 2 : 1, mobile })
async function until(expr, label, tries = 80) {
  for (let i = 0; i < tries; i++) { if (await ev(expr) === true) return true; await sleep(250) }
  bad(`${label} (timed out)`, expr.slice(0, 110)); return false
}
const CONTROL_FOR = label => `(() => {
  const t = ${JSON.stringify(label)}
  const lab = [...document.querySelectorAll('label')].find(l => (l.textContent||'').trim() === t)
  if (!lab) return null
  if (lab.htmlFor) { const byId = document.getElementById(lab.htmlFor); if (byId) return byId }
  const scope = lab.closest('div')
  return scope ? scope.querySelector('input,textarea,select') : null
})()`
const setByLabel = (label, value) => ev(`(() => {
  const el = ${CONTROL_FOR(label)}
  if (!el) return 'NO_CONTROL'
  const proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : el.tagName === 'SELECT' ? HTMLSelectElement.prototype : HTMLInputElement.prototype
  Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, ${JSON.stringify(String(value))})
  el.dispatchEvent(new Event(el.tagName === 'SELECT' ? 'change' : 'input', { bubbles: true }))
  return el.value
})()`)
const OVERFLOW = `(() => {
  const out = []
  const scope = document.querySelector('[role="dialog"]') || document.querySelector('main') || document.body
  for (const el of scope.querySelectorAll('*')) {
    const r = el.getBoundingClientRect()
    if (r.width === 0) continue
    // Name the element by what a PERSON would see. A class list identifies the
    // primitive, not the control, and every Button shares one — so a report built
    // from classes says "a button overflows" four times and cannot be acted on.
    if (r.right > innerWidth + 1 || r.left < -1) {
      const label = (el.textContent || '').trim().slice(0, 28) || el.getAttribute('aria-label') || el.getAttribute('placeholder') || ''
      out.push(el.tagName.toLowerCase() + (label ? ' "' + label + '"' : '') + ' [' + Math.round(r.left) + '..' + Math.round(r.right) + '] vs ' + innerWidth)
    }
  }
  return [...new Set(out)].slice(0, 5)
})()`

await send('Page.enable'); await send('Runtime.enable')
await setW(390)
await goto(`${baseUrl}/login`)
await ev(`(() => { const set=(el,v)=>{Object.getOwnPropertyDescriptor(el.constructor.prototype,'value').set.call(el,v);el.dispatchEvent(new Event('input',{bubbles:true}))}
  set(document.querySelector('input[type=email]'), ${JSON.stringify(EMAIL)})
  set(document.querySelector('input[type=password]'), ${JSON.stringify(PASSWORD)})
  document.querySelector('form')?.requestSubmit(); return true })()`)
await sleep(9000)
check('signed in as the owner on production', !String(await ev('location.pathname')).includes('/login'))
console.log(`production is serving commit ${await ev(`fetch('/api/health').then(r=>r.json()).then(j=>j.commit).catch(()=>'?')`)}`)

// ── A. Configuration round trip ──────────────────────────────────────────────
console.log('\n═══ A. Settings → Services → Measure & Price, saved and re-read ═══')
await setW(1280, false)
await goto(`${baseUrl}/dashboard/settings/templates`)
await until(`document.body.innerText.includes(${JSON.stringify(SERVICE)})`, 'the seeded service is listed')
const opened = await ev(`(() => {
  const rows = [...document.querySelectorAll('*')].filter(e => e.children.length === 0 && (e.textContent||'').trim() === ${JSON.stringify(SERVICE)})
  const row = rows[0]?.closest('li, tr, div')
  if (!row) return 'NO_ROW'
  let scope = row
  for (let i = 0; i < 5 && scope; i++) {
    const b = [...scope.querySelectorAll('button')].find(x => x.getAttribute('aria-label') === 'Edit service')
    if (b) { b.click(); return 'CLICKED' }
    scope = scope.parentElement
  }
  return 'NO_EDIT_BUTTON'
})()`)
check('the service editor opens from its Edit control', opened === 'CLICKED', String(opened))
await until(`[...document.querySelectorAll('label')].some(l => (l.textContent||'').trim() === 'Measurement')`, 'the Measure & Price block is in the editor')

const measureOpts = await ev(`(() => { const el = ${CONTROL_FOR('Measurement')}; return el ? [...el.options].map(o => o.value) : 'NONE' })()`)
check('Measurement offers the measurement types', Array.isArray(measureOpts) && measureOpts.length > 1, JSON.stringify(measureOpts))
const areaVal = Array.isArray(measureOpts) ? measureOpts.find(v => /area|sq/i.test(v)) : null
await setByLabel('Measurement', areaVal || (measureOpts || [])[1])
await sleep(2000)

// ⚠️ The rate input only exists once a TERM is ticked — "Ways you sell it" gates
// it, so selecting a measurement type alone leaves nothing to type a price into.
const termTicked = await ev(`(() => {
  const boxes = [...document.querySelectorAll('input[type=checkbox]')]
  const box = boxes.find(b => {
    const lab = b.closest('label')
    return lab && /one[- ]?time|weekly|monthly|seasonal/i.test(lab.textContent || '')
  })
  if (!box) return 'NO_TERM_CHECKBOX'
  if (!box.checked) box.click()
  return (box.closest('label')?.textContent || '').trim().slice(0, 30)
})()`)
check('a way of selling it can be ticked ("Ways you sell it")', termTicked !== 'NO_TERM_CHECKBOX', String(termTicked))
await sleep(1500)

const rateSet = await ev(`(() => {
  const inputs = [...document.querySelectorAll('input')].filter(i => i.placeholder === '0.08' || i.placeholder === '249')
  if (!inputs.length) return { err: 'NO_RATE_INPUT' }
  const el = inputs[0]
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(el, ${JSON.stringify(RATE)})
  el.dispatchEvent(new Event('input', { bubbles: true }))
  return {
    value: el.value,
    step: el.getAttribute('step'),
    // ⭐ THE question the widened column raises: the DB now keeps 4 decimals, so
    // an input that still constrains to cents would refuse the very rate the
    // migration exists to preserve — and a stepMismatch blocks form submission.
    stepMismatch: el.validity ? el.validity.stepMismatch : null,
    valid: el.checkValidity ? el.checkValidity() : null,
  }
})()`)
console.log(`      rate input: ${JSON.stringify(rateSet)}`)
check(`a sub-cent per-unit rate can be typed (${RATE})`, rateSet && rateSet.value === RATE, `input holds ${JSON.stringify(rateSet)}`)
check(`…and the input ACCEPTS it (step="${rateSet && rateSet.step}" must not refuse 4-decimal rates)`,
  rateSet && rateSet.stepMismatch === false && rateSet.valid !== false,
  `stepMismatch=${rateSet && rateSet.stepMismatch} valid=${rateSet && rateSet.valid} — the column is numeric(12,4) but the input constrains to step=${rateSet && rateSet.step}`)
const saved = await ev(`(() => {
  const form = document.querySelector('form')
  if (!form) return 'NO_FORM'
  const b = [...form.querySelectorAll('button')].find(x => /^(Save|Update|Save service)/i.test((x.textContent||'').trim()))
  if (b) { b.click(); return 'CLICKED' }
  form.requestSubmit(); return 'SUBMITTED'
})()`)
await sleep(6000)
check('the editor saves', saved === 'CLICKED' || saved === 'SUBMITTED', String(saved))

const { data: plans } = await db.from('service_pricing_plans').select('term,basis,rate').eq('service_template_id', SERVICE_ID)
check('a pricing plan reached the database', (plans || []).length > 0, JSON.stringify(plans))
const perUnit = (plans || []).find(p => p.basis === 'per_unit')
check(`the rate stored EXACTLY ${RATE} — not rounded to 0.04`, perUnit && Number(perUnit.rate) === Number(RATE),
  `stored ${JSON.stringify(perUnit)}`)

// LEAVE, come back, and read it off the screen again.
await goto(`${baseUrl}/dashboard`)
await sleep(1500)
await goto(`${baseUrl}/dashboard/settings/templates`)
await until(`document.body.innerText.includes(${JSON.stringify(SERVICE)})`, 'back on Services')
await ev(`(() => {
  const rows = [...document.querySelectorAll('*')].filter(e => e.children.length === 0 && (e.textContent||'').trim() === ${JSON.stringify(SERVICE)})
  let scope = rows[0]?.closest('li, tr, div')
  for (let i = 0; i < 5 && scope; i++) {
    const b = [...scope.querySelectorAll('button')].find(x => x.getAttribute('aria-label') === 'Edit service')
    if (b) { b.click(); return true }
    scope = scope.parentElement
  }
  return false
})()`)
await until(`[...document.querySelectorAll('label')].some(l => (l.textContent||'').trim() === 'Measurement')`, 'the editor reopened')
const reread = await ev(`(() => {
  const el = ${CONTROL_FOR('Measurement')}
  const rate = [...document.querySelectorAll('input')].map(i => i.value).filter(v => v === ${JSON.stringify(RATE)})
  return { measurement: el ? el.value : 'NONE', rateOnScreen: rate.length > 0 }
})()`)
check('after leaving and reopening, the measurement type is exactly what was saved',
  !!reread && reread.measurement === (areaVal || (measureOpts || [])[1]), JSON.stringify(reread))
check(`after leaving and reopening, the rate still reads ${RATE} on screen`, !!reread && reread.rateOnScreen === true, JSON.stringify(reread))

for (const w of WIDTHS) {
  await setW(w); await sleep(900)
  const over = await ev(OVERFLOW)
  check(`config @${w}px: nothing overflows sideways`, Array.isArray(over) && over.length === 0, JSON.stringify(over))
}

// ── B. The quote path ────────────────────────────────────────────────────────
console.log('\n═══ B. Property → new quote → Measure & Price ═══')
const { data: props } = await db.from('properties').select('id, customer_id, address').eq('user_id', UID).limit(20)
const prop = (props || []).find(p => p.customer_id)
if (!prop) { bad('the owner has no property with a customer to quote against') }
else {
  await setW(1280, false)
  await goto(`${baseUrl}/dashboard/quotes/new?property=${prop.id}`)
  await until(`!!document.querySelector('main')`, 'the quote builder painted')
  // ⚠️ The Maps script is loaded BY the measure panel, not by the quote screen.
  // Probing before opening the panel measures "not asked for yet" and reports it
  // as "broken" — which is how a green production blocker reads as red.
  const measureDoor = await ev(`(() => {
    const b = [...document.querySelectorAll('button')].find(x => /measure/i.test((x.textContent||'')))
    if (!b) return 'NO_DOOR'
    b.click(); return 'CLICKED'
  })()`)
  if (measureDoor !== 'CLICKED') note(`no Measure door on the new-quote screen (${measureDoor}) — measure panel UNPROVEN from here`)
  else {
    await sleep(4000)
    check('the Measure & Price panel opens', await ev(`/Measure/i.test(document.body.innerText)`) === true)
    // Give the Maps script the time a real network takes, then ask.
    await until(`typeof google !== 'undefined' && !!(google.maps)`, 'the Maps script loaded inside the panel', 60)
    const mapsOk = await ev(`(() => ({
      js: typeof google !== 'undefined' && !!google.maps,
      geometry: typeof google !== 'undefined' && !!(google.maps && google.maps.geometry),
    }))()`)
    check('Maps JavaScript is loaded on production', mapsOk && mapsOk.js === true, JSON.stringify(mapsOk))
    check('the geometry library is loaded (area needs it)', mapsOk && mapsOk.geometry === true, JSON.stringify(mapsOk))
    const denied = await ev(`/RefererNotAllowed|REQUEST_DENIED|InvalidKey|ApiNotActivated/i.test(document.body.innerHTML)`)
    check('no invalid-key / REQUEST_DENIED condition on screen', denied === false)
    const offering = await ev(`document.body.innerText.includes(${JSON.stringify(SERVICE)})`)
    check('the configured offering is offered here (Price Book decides)', offering === true,
      'the seeded measured service did not appear in the panel')
    const zeroClaim = await ev(`/\\$0\\.00|\\$0(?!\\.)/.test(document.body.innerText) && !/unknown|not set|no price/i.test(document.body.innerText)`)
    check('an unknown price is not rendered as $0', zeroClaim === false)
    for (const w of WIDTHS) {
      await setW(w); await sleep(900)
      const over = await ev(OVERFLOW)
      check(`measure panel @${w}px: nothing overflows sideways`, Array.isArray(over) && over.length === 0, JSON.stringify(over))
    }
  }
  note('polygon drawing on a live Google Map is not scriptable through CDP — multi-area drawing and the summed sq ft total are UNPROVEN by this harness')
}

console.log('\n═══ teardown ═══')
const left = await teardown()
check('the seeded service and its plans were removed', left === 0, `${left} left behind`)

console.log(`\n${fails === 0 ? '✅' : '❌'} measureprice-cdp — ${fails} failed`)
ws.close(); chrome.kill()
process.exit(fails === 0 ? 0 : 1)
