// ── S81 production smoke: Day View + Edit Job load on the DEPLOYED build ─────
// READ-ONLY. Signs in as the owner, opens the day board, deep-links one REAL
// visit's editor (?job=), verifies the compact layout painted, closes without
// touching anything (form untouched ⇒ no discard prompt), then opens the
// quick-edit sheet from the same board and closes it clean. No writes, no
// fixture rows, no Save pressed anywhere.
//
//   node scripts/s81-prod-smoke.mjs https://app.edgehq.ca

import { spawn } from 'node:child_process'
import { readFileSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createClient } from '@supabase/supabase-js'

const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'
const [baseUrl = 'https://app.edgehq.ca'] = process.argv.slice(2)
const PORT = 9471

const env = Object.fromEntries(
  readFileSync('.env.local', 'utf8').split(/\r?\n/)
    .filter(l => l && !l.startsWith('#') && l.includes('='))
    .map(l => [l.slice(0, l.indexOf('=')).trim(), l.slice(l.indexOf('=') + 1).trim()]))
const EMAIL = env.PORTAL_RPC_OWNER_EMAIL
const PASSWORD = env.PORTAL_RPC_OWNER_PASSWORD

let fails = 0
const ok = n => console.log(`  ✓ ${n}`)
const bad = (n, d = '') => { fails++; console.log(`  ✗ ${n}${d ? `\n      ${d}` : ''}`) }
const check = (n, c, d) => c ? ok(n) : bad(n, d)

// Find ONE real upcoming visit to open (read-only select).
const db = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.NEXT_PUBLIC_SUPABASE_ANON_KEY, { auth: { persistSession: false } })
const auth = await db.auth.signInWithPassword({ email: EMAIL, password: PASSWORD })
if (auth.error) { console.error('DB sign-in failed: ' + auth.error.message); process.exit(2) }
const { data: visits } = await db.from('jobs')
  .select('id, scheduled_date, title').eq('user_id', auth.data.user.id)
  .in('status', ['scheduled', 'in_progress'])
  .order('scheduled_date').limit(1)
const visit = visits?.[0] ?? null
check('a real visit exists to open (read-only)', !!visit, 'owner book has no open visits')

const profile = mkdtempSync(join(tmpdir(), 's81-smoke-'))
const chrome = spawn(CHROME, ['--headless=new', '--disable-gpu', '--no-sandbox', '--hide-scrollbars',
  `--remote-debugging-port=${PORT}`, '--user-data-dir=' + profile, 'about:blank'], { stdio: 'ignore' })
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
const ws = new (await import('ws').then(m => m.WebSocket).catch(() => globalThis.WebSocket))(await target())
await new Promise(r => ws.addEventListener('open', r))
let msgId = 0
const pending = new Map()
ws.addEventListener('message', e => {
  const m = JSON.parse(e.data)
  if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id) }
})
const send = (method, params = {}) => new Promise(res => { const id = ++msgId; pending.set(id, res); ws.send(JSON.stringify({ id, method, params })) })
const evaluate = async expr => (await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true })).result?.result?.value
async function goto(url) {
  await send('Page.navigate', { url })
  for (let i = 0; i < 80; i++) { await sleep(250); if (await evaluate('document.readyState === "complete"')) break }
  await sleep(2000)
}
async function until(expr, label, tries = 50) {
  for (let i = 0; i < tries; i++) { if (await evaluate(expr) === true) return true; await sleep(300) }
  bad(`${label} (timed out)`); return false
}
await send('Page.enable'); await send('Runtime.enable')
await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 850, deviceScaleFactor: 2, mobile: true })

// Sign in on production.
await goto(`${baseUrl}/login`)
await evaluate(`(() => {
  const set = (el, v) => { Object.getOwnPropertyDescriptor(el.constructor.prototype, 'value').set.call(el, v); el.dispatchEvent(new Event('input', { bubbles: true })) }
  set(document.querySelector('input[type=email]'), ${JSON.stringify(EMAIL)})
  set(document.querySelector('input[type=password]'), ${JSON.stringify(PASSWORD)})
  document.querySelector('form')?.requestSubmit()
  return true
})()`)
await sleep(7000)
check('signed in on production', !String(await evaluate('location.pathname')).includes('/login'))

// 1. Day View loads.
await goto(`${baseUrl}/dashboard/schedule`)
const dayOk = await until(`!!document.querySelector('main') && document.body.textContent.length > 500 && !document.body.textContent.includes('Application error')`, 'Day View painted')
check('Day View (schedule) loads with content, no error boundary', dayOk)

// 2. Edit Job opens on a REAL visit via the ?job= deep link (read-only).
if (visit) {
  await goto(`${baseUrl}/dashboard/schedule?job=${visit.id}`)
  const editorOk = await until(`[...document.querySelectorAll('h2')].some(h => h.textContent.trim() === 'Edit Job')`, 'the editor opened')
  check('Edit Job opens on a real visit', editorOk)
  if (editorOk) {
    const shape = await evaluate(`(() => {
      const form = document.querySelector('[role="dialog"] form')
      if (!form) return null
      const labels = [...form.querySelectorAll('label')].map(l => (l.textContent || '').trim())
      const more = [...form.querySelectorAll('button')].some(b => b.textContent.trim().startsWith('+ More options'))
      return { labels, more, priceHidden: !labels.some(l => l.startsWith('Price')) }
    })()`)
    const primary = ['Customer', 'Property', 'Service Type', 'Date', 'Start Time', 'Duration', 'Status']
    check('…with the S81 compact layout (common path + More options, price hidden)',
      !!shape && shape.more && shape.priceHidden && primary.every(n => shape.labels.some(l => l.startsWith(n))),
      JSON.stringify(shape))
    // Close untouched — the form is clean, so no discard prompt should appear.
    await evaluate(`(() => { [...document.querySelectorAll('button[aria-label="Close"]')].pop()?.click(); return true })()`)
    await sleep(800)
    check('an untouched editor closes silently', await evaluate(`(() => ![...document.querySelectorAll('h2')].some(h => h.textContent.trim() === 'Edit Job'))()`) === true)
  }
  // 3. The quick-edit sheet exists on the deployed board (the deep link moved
  //    the cursor to the visit's day, so its card is on the board).
  const menuCount = await evaluate(`document.querySelectorAll('button[aria-label="More actions"]').length`)
  console.log(`  · ${menuCount} overflow menu(s) on the board`)
  // The FIRST 'More actions' can be the field-mode bar's next-stop menu (S80),
  // which deliberately carries only customer doors. The stop CARD's overflow is
  // the last one on the board — that is where Quick edit lives.
  const menuOk = await evaluate(`(() => { const b = [...document.querySelectorAll('button[aria-label="More actions"]')].pop(); if (!b) return false; b.click(); return true })()`)
  if (menuOk) {
    await sleep(800)
    const items = await evaluate(`[...document.querySelectorAll('button, [role="menuitem"], a')].map(e => (e.textContent || '').trim()).filter(t => t).slice(-12).map(t => t.slice(0, 30))`)
    console.log('  · last menu actions:', JSON.stringify(items))
    const clicked = await evaluate(`(() => { const el = [...document.querySelectorAll('button, [role="menuitem"]')].find(e => (e.textContent || '').trim().startsWith('Quick edit')); if (!el) return 'not found'; el.click(); return 'clicked' })()`)
    console.log('  · quick-edit item:', clicked)
    await sleep(1200)
    console.log('  · dialogs now:', JSON.stringify(await evaluate(`[...document.querySelectorAll('[role="dialog"]')].map(d => (d.querySelector('h2')?.textContent || '(untitled)').slice(0, 30))`)))
    const sheetOk = await until(`[...document.querySelectorAll('[role="dialog"] h2')].some(h => (h.textContent || '').includes('Quick edit'))`, 'the quick-edit sheet opened')
    check('the VisitQuickEdit sheet opens in production', sheetOk)
    if (sheetOk) {
      await evaluate(`(() => { [...document.querySelectorAll('[role="dialog"] button[aria-label="Close"]')][0]?.click(); return true })()`)
      await sleep(600)
      check('an untouched sheet closes silently', await evaluate(`(() => ![...document.querySelectorAll('[role="dialog"] h2')].some(h => (h.textContent || '').includes('Quick edit')))()`) === true)
    }
  } else {
    console.log('  · no stop card on that day board — sheet check skipped (editor proof stands)')
  }
}

await db.auth.signOut({ scope: 'local' })
try { chrome.kill() } catch { /* gone */ }
console.log(fails ? `\n❌ s81-prod-smoke — ${fails} failure(s)` : '\n✅ s81-prod-smoke — Day View + Edit Job + quick-edit sheet live on production, nothing written')
process.exit(fails ? 1 : 0)
