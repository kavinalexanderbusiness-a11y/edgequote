// ── Drive the REAL app: a change order, on a phone, from both sides ──────────
//
//   node scripts/changeorder-cdp.mjs <baseUrl>
//
// Two screens have to work at 375/390/430 or this feature is not usable:
//
//   1. THE OWNER'S JOB CARD. Adding a small change has to be a job you can do
//      standing in somebody's back garden in under a minute — so the door is
//      counted in TAPS, not admired. And the breakdown has to keep the three
//      figures apart on a 375px screen: original, approved, and the one that is
//      only ASKED (which must be visibly outside the authorized total).
//   2. THE CUSTOMER'S PORTAL. Approving is the whole point. It must be a
//      full-width, thumb-sized button on the surface a texted link opens, and
//      the card must say — in words, next to the button — that the original
//      approval does not change.
//
// It seeds ONE obviously-named customer + visit (ZZ-S51-CDP) with one APPROVED
// and one PENDING change order, drives them, and deletes everything in a finally
// block. It never touches an existing job, and it never SENDS: the seeded
// customer is opted out on both channels with an RFC-2606 .invalid address and a
// reserved fictional number, so there is nowhere for a message to go.
//
// ⚠️ IT NEEDS THE OWNER LOGIN, and that is not an oversight — it was tried the
// other way. The dashboard half cannot run in the verification fixture tenant:
// a tenant with no business_settings row is a first-run tenant and /dashboard
// bounces to /setup, and the fixture cannot be given one because
// `settings: insert own` is gated on can_provision_business() — the deliberate
// one-real-tenant licence. Widening that policy to make a test pass would trade a
// release gate for a green tick. So this half signs in as the business, writes
// only ZZ-tagged rows, and removes them in the finally block. The PORTAL half
// above needs no login at all.
// ⚠️ A FRESH profile directory every run: a persistent Chrome profile serves a
// STALE client bundle and would test the previous build.
// ⚠️ `<main>` is overflow-auto, so document.scrollWidth NEVER reports sideways
// overflow on this app. Overflow is measured per ELEMENT against innerWidth.

import { spawn } from 'node:child_process'
import { readFileSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { createClient } from '@supabase/supabase-js'

const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'
const [baseUrl = 'http://127.0.0.1:3147'] = process.argv.slice(2)
const PORT = 9481 + Number(process.env.CDP_SLOT || 0)
const WIDTHS = [375, 390, 430]
const TAG = 'ZZ-S51-CDP'
const ORIGINAL = 5500
const APPROVED = 575
const PENDING = 200

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

const sb = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.NEXT_PUBLIC_SUPABASE_ANON_KEY,
  { auth: { persistSession: false } })
const { data: auth, error: authErr } = await sb.auth.signInWithPassword({ email: EMAIL, password: PASSWORD })
if (authErr || !auth?.user) { console.error('sign-in failed: ' + authErr?.message); process.exit(2) }
const uid = auth.user.id
const d = new Date()
const today = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`

// Swept first, in case a previous run was killed before its finally block.
await sb.from('jobs').delete().eq('user_id', uid).eq('title', TAG)
await sb.from('customers').delete().eq('user_id', uid).eq('name', TAG)

const { data: cust, error: cErr } = await sb.from('customers').insert({
  user_id: uid, name: TAG,
  // Structurally undeliverable on both channels, and opted out of both.
  email: `${TAG.toLowerCase()}@edgequote.invalid`, phone: '+15550151',
  address: 'Verification fixture — not a real address',
  sms_opt_in: false, email_opt_in: false,
}).select('id').single()
if (cErr || !cust) { console.error('could not seed the customer: ' + cErr?.message); process.exit(2) }

const token = `zz-s51-cdp-${randomUUID()}`
await sb.from('customer_portal_tokens').insert({ user_id: uid, customer_id: cust.id, token, revoked: false })

const { data: job, error: jErr } = await sb.from('jobs').insert({
  user_id: uid, customer_id: cust.id, title: TAG, service_type: 'Fence repair',
  scheduled_date: today, status: 'scheduled', price: ORIGINAL, duration_minutes: 120,
}).select('id').single()
if (jErr || !job) { console.error('could not seed the visit: ' + jErr?.message); process.exit(2) }

// Change orders are seeded THROUGH the lifecycle, never by writing 'approved'
// straight in — the approval trigger is what mints the billable line, and a
// fixture that skipped it would be testing a state the app cannot produce.
async function seedChange(description, amount, to) {
  const { data, error } = await sb.from('change_orders').insert({
    user_id: uid, job_id: job.id, customer_id: cust.id,
    description, amount, service_key: 'change_order', status: 'draft',
  }).select('id').single()
  if (error || !data) throw new Error(`seed change order: ${error?.message}`)
  await sb.from('change_orders').update({ status: 'pending' }).eq('id', data.id)
  if (to === 'approved') await sb.from('change_orders').update({ status: 'approved', decided_via: 'owner' }).eq('id', data.id)
  return data.id
}
await seedChange('Replace two gate posts', APPROVED, 'approved')
await seedChange('Extra coat of paint on the shed', PENDING, 'pending')
console.log(`  · seeded ${TAG} on ${today}: $${ORIGINAL} + $${APPROVED} approved + $${PENDING} asked (all deleted at the end)`)

const profile = mkdtempSync(join(tmpdir(), 'co-cdp-'))
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

  // ── The customer's side FIRST — it needs no login, so a failure here is not
  //    masked by a sign-in problem. ────────────────────────────────────────────
  console.log('\n═══ Customer portal: approving extra work with a thumb ═══')
  for (const w of WIDTHS) {
    await setWidth(w)
    await goto(`${baseUrl}/portal/${token}`)
    await sleep(2500)

    const card = await evaluate(`(() => {
      const ask = [...document.querySelectorAll('div')].find(el =>
        /Extra work needs your approval/i.test(el.innerText || '') && el.querySelector('button'))
      if (!ask) return { found: false, body: document.body.innerText.slice(0, 400) }
      const text = ask.innerText
      const approve = [...ask.querySelectorAll('button')].find(b => /^Approve /i.test((b.textContent||'').trim()))
      const decline = [...ask.querySelectorAll('button')].find(b => /No thanks/i.test(b.textContent||''))
      const r = approve ? approve.getBoundingClientRect() : null
      const cr = ask.getBoundingClientRect()
      return {
        found: true,
        namesTheScope: /Extra coat of paint on the shed/.test(text),
        namesThePrice: text.includes('$' + (${PENDING}).toFixed(2)),
        // ⭐ The sentence the feature exists to be able to say.
        saysOriginalUnchanged: /doesn.t change/i.test(text) && /5,500/.test(text),
        saysNotChargedYet: /Nothing is charged until/i.test(text),
        approveLabel: approve ? (approve.textContent||'').trim() : null,
        approveHeight: r ? Math.round(r.height) : 0,
        approveWidth: r ? Math.round(r.width) : 0,
        cardWidth: Math.round(cr.width),
        hasDecline: !!decline,
        inside: cr.right <= innerWidth + 1 && cr.left >= -1,
      }
    })()`)
    check(`${w}px: the pending change is on the landing surface`, card?.found,
      String(card?.body || '').slice(0, 200))
    check(`${w}px: it names the scope and the price`, card?.namesTheScope && card?.namesThePrice, JSON.stringify(card))
    check(`${w}px: ⭐ it says the original approval does not change`, card?.saysOriginalUnchanged, JSON.stringify(card))
    check(`${w}px: …and that approving does not charge them`, card?.saysNotChargedYet, JSON.stringify(card))
    check(`${w}px: Approve names the amount and is full-width and thumb-sized`,
      /^Approve \$/.test(card?.approveLabel || '') && card?.approveHeight >= 40
      && card?.approveWidth >= card?.cardWidth - 70,
      JSON.stringify(card))
    check(`${w}px: declining is offered beside it, not buried`, card?.hasDecline, JSON.stringify(card))
    check(`${w}px: the card fits the viewport`, card?.inside, JSON.stringify(card))
    const over = await evaluate(OVERFLOW)
    check(`${w}px: nothing overflows sideways`, (over || []).length === 0, (over || []).join(' · '))

    // The record: Billing carries the three figures, kept apart.
    await evaluate(`(() => {
      const b = [...document.querySelectorAll('button')].find(x => /^\\s*Billing/i.test(x.textContent||''))
      if (b) b.click(); return !!b
    })()`)
    await sleep(1800)
    const record = await evaluate(`(() => {
      const t = document.body.innerText
      return {
        section: /Changes to your work/i.test(t),
        original: /Originally approved/i.test(t) && /5,500/.test(t),
        approved: /Approved change/i.test(t) && /\\+\\$575/.test(t),
        total: /Approved total/i.test(t) && /6,075/.test(t),
        pendingKeptOut: /waiting for your decision/i.test(t) && /not included above/i.test(t),
      }
    })()`)
    check(`${w}px: Billing carries the record of changes`, record?.section, JSON.stringify(record))
    check(`${w}px: …original $5,500 shown as its own figure`, record?.original, JSON.stringify(record))
    check(`${w}px: …approved change shown as +$575`, record?.approved, JSON.stringify(record))
    check(`${w}px: …approved total $6,075`, record?.total, JSON.stringify(record))
    check(`${w}px: ⭐ the pending ask is stated as OUTSIDE that total`, record?.pendingKeptOut, JSON.stringify(record))
  }

  // Approving is two taps, and the second one is the confirmation.
  await setWidth(390)
  await goto(`${baseUrl}/portal/${token}`)
  await sleep(2500)
  const step1 = await evaluate(`(() => {
    const b = [...document.querySelectorAll('button')].find(x => /^Approve \\$/.test((x.textContent||'').trim()))
    if (!b) return false
    b.click(); return true
  })()`)
  await sleep(800)
  const confirmStep = await evaluate(`(() => {
    const t = document.body.innerText
    const yes = [...document.querySelectorAll('button')].find(x => /Yes, approve/i.test(x.textContent||''))
    return { asks: /Approve \\$200.00 of extra work\\?/.test(t), hasYes: !!yes, hasBack: [...document.querySelectorAll('button')].some(x => /^Back$/.test((x.textContent||'').trim())) }
  })()`)
  check('tap 1 of 2 opens a confirmation, it does not approve', step1 && confirmStep?.asks, JSON.stringify(confirmStep))
  check('…the confirmation names the amount again and offers a way back',
    confirmStep?.hasYes && confirmStep?.hasBack, JSON.stringify(confirmStep))

  // ── The owner's side ───────────────────────────────────────────────────────
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

  console.log('\n═══ Owner day board: the change is on the card ═══')
  for (const w of WIDTHS) {
    await setWidth(w)
    await goto(`${baseUrl}/dashboard/schedule?view=day`)
    await sleep(3500)

    const chips = await evaluate(`(() => {
      const card = [...document.querySelectorAll('div')].find(el =>
        (el.innerText||'').includes(${JSON.stringify(TAG)}) && el.querySelector('button'))
      const all = [...document.querySelectorAll('button')].map(b => (b.textContent||'').trim())
      const waiting = all.find(t => /awaiting approval/i.test(t))
      const approved = all.find(t => /approved change/i.test(t))
      const door = [...document.querySelectorAll('button')].find(b => /^Changes\\b/.test((b.textContent||'').trim()))
      const dr = door ? door.getBoundingClientRect() : null
      const services = all.find(t => /^Services/.test(t))
      return {
        cardFound: !!card,
        waiting, approved, services,
        doorLabel: door ? (door.textContent||'').trim() : null,
        doorHeight: dr ? Math.round(dr.height) : 0,
        doorInside: dr ? (dr.right <= innerWidth + 1 && dr.left >= -1) : false,
        doorInMenu: door ? !!door.closest('[role=menu]') : false,
        // The billed total on the card face = 5500 + 575 (approved only).
        showsBillable: (card?.innerText||'').includes('$6,075'),
        excludesPending: !(card?.innerText||'').includes('$6,275'),
      }
    })()`)
    check(`${w}px: the seeded visit is on the day board`, chips?.cardFound, JSON.stringify(chips).slice(0, 200))
    check(`${w}px: the unanswered change is amber on the card face`,
      (chips?.waiting || '').includes('$200.00 awaiting approval'), JSON.stringify(chips?.waiting))
    check(`${w}px: the approved change is named too`,
      (chips?.approved || '').includes('+$575.00 approved change'), JSON.stringify(chips?.approved))
    check(`${w}px: the card's money is original + APPROVED only`,
      chips?.showsBillable && chips?.excludesPending, JSON.stringify(chips))
    check(`${w}px: "Changes" is its own door, not inside the overflow menu`,
      !!chips?.doorLabel && !chips?.doorInMenu, JSON.stringify(chips))
    check(`${w}px: ⛔ …and is NOT the same door as "Services"`,
      !!chips?.services && chips.services !== chips.doorLabel, JSON.stringify(chips))
    check(`${w}px: it is a real tap target inside the viewport`,
      chips?.doorHeight >= 40 && chips?.doorInside, JSON.stringify(chips))

    // Open it and read the breakdown.
    await evaluate(`(() => {
      const b = [...document.querySelectorAll('button')].find(x => /^Changes\\b/.test((x.textContent||'').trim()))
      if (b) b.click(); return !!b
    })()`)
    await sleep(1500)
    const panel = await evaluate(`(() => {
      const t = document.body.innerText
      const add = [...document.querySelectorAll('button')].find(x => /Add a change/i.test(x.textContent||''))
      const ar = add ? add.getBoundingClientRect() : null
      return {
        original: /Originally approved/.test(t) && /\\$5,500\\.00/.test(t),
        approved: /Approved changes/.test(t) && /\\+\\$575\\.00/.test(t),
        authorized: /Authorized value/i.test(t) && /\\$6,075\\.00/.test(t),
        pendingOutside: /Awaiting approval.*not counted yet/is.test(t) && /\\$200\\.00/.test(t),
        provenance: /Recorded as approved by you/.test(t),
        addHeight: ar ? Math.round(ar.height) : 0,
        addWidth: ar ? Math.round(ar.width) : 0,
      }
    })()`)
    check(`${w}px: the panel keeps the original as its own figure`, panel?.original, JSON.stringify(panel))
    check(`${w}px: …the approved change as its own`, panel?.approved, JSON.stringify(panel))
    check(`${w}px: …and totals them as the authorized value`, panel?.authorized, JSON.stringify(panel))
    check(`${w}px: ⭐ the pending ask is stated as NOT counted`, panel?.pendingOutside, JSON.stringify(panel))
    check(`${w}px: an owner-recorded approval says so`, panel?.provenance, JSON.stringify(panel))
    check(`${w}px: "Add a change" is a full-width thumb target`,
      panel?.addHeight >= 40 && panel?.addWidth >= 200, JSON.stringify(panel))

    const over = await evaluate(OVERFLOW)
    check(`${w}px: the panel overflows nothing`, (over || []).length === 0, (over || []).join(' · '))
  }

  // ── Under a minute: count the taps, don't assert a stopwatch ───────────────
  console.log('\n═══ Owner: adding a change is three taps and two fields ═══')
  await setWidth(375)
  await goto(`${baseUrl}/dashboard/schedule?view=day`)
  await sleep(3500)
  const taps = await evaluate(`(() => {
    const b = [...document.querySelectorAll('button')].find(x => /^Changes\\b/.test((x.textContent||'').trim()))
    if (!b) return 0
    b.click(); return 1
  })()`)
  await sleep(1200)
  const tap2 = await evaluate(`(() => {
    const b = [...document.querySelectorAll('button')].find(x => /Add a change/i.test(x.textContent||''))
    if (!b) return false
    b.click(); return true
  })()`)
  await sleep(900)
  const form = await evaluate(`(() => {
    const inputs = [...document.querySelectorAll('input')]
    const desc = inputs.find(i => /What extra work/i.test(i.placeholder||''))
    const amt = inputs.find(i => i.type === 'number' && /^0$/.test(i.placeholder||''))
    const sendBtn = [...document.querySelectorAll('button')].find(x => /Send for approval/i.test(x.textContent||''))
    const saveBtn = [...document.querySelectorAll('button')].find(x => /Save without sending/i.test(x.textContent||''))
    return {
      fields: [!!desc, !!amt].filter(Boolean).length,
      hasSend: !!sendBtn, hasSave: !!saveBtn,
      // A blank form must not offer to send an empty change.
      sendDisabledWhenBlank: sendBtn ? sendBtn.disabled : null,
      descFocused: document.activeElement === desc,
      note: /original quote is not changed/i.test(document.body.innerText),
    }
  })()`)
  check('two taps reach a form with exactly two fields', taps === 1 && tap2 && form?.fields === 2, JSON.stringify(form))
  check('the description field is already focused (no third tap to type)', form?.descFocused, JSON.stringify(form))
  check('the third tap is Send for approval', form?.hasSend, JSON.stringify(form))
  check('…with "save without sending" beside it', form?.hasSave, JSON.stringify(form))
  check('⛔ an empty change cannot be sent', form?.sendDisabledWhenBlank === true, JSON.stringify(form))
  check('the form says the original quote is not changed', form?.note, JSON.stringify(form))

  ws.close()
} finally {
  chrome.kill()
  // The job cascades its change orders and their line items; the customer
  // cascades its portal token. Both are checked, not assumed.
  await sb.from('jobs').delete().eq('user_id', uid).eq('title', TAG)
  await sb.from('customers').delete().eq('user_id', uid).eq('name', TAG)
  const { count: jobsLeft } = await sb.from('jobs').select('id', { count: 'exact', head: true }).eq('user_id', uid).eq('title', TAG)
  const { count: cosLeft } = await sb.from('change_orders').select('id', { count: 'exact', head: true }).eq('user_id', uid).eq('job_id', job.id)
  const { count: custLeft } = await sb.from('customers').select('id', { count: 'exact', head: true }).eq('user_id', uid).eq('name', TAG)
  check('everything seeded is gone', (jobsLeft ?? 0) === 0 && (cosLeft ?? 0) === 0 && (custLeft ?? 0) === 0,
    `jobs ${jobsLeft}, change orders ${cosLeft}, customers ${custLeft}`)
}

console.log(fails === 0
  ? '\n✅ change orders work on a phone, from both sides\n'
  : `\n❌ ${fails} check${fails === 1 ? '' : 's'} failed\n`)
process.exit(fails === 0 ? 0 : 1)
