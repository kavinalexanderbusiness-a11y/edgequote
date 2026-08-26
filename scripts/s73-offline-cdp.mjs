// ── Session 73: the offline layer in a real phone browser ────────────────────
//   node scripts/s73-offline-cdp.mjs [baseUrl]
//
// The browser half of the S73 proof. scripts/s73-offline-proof.ts proves the
// ENGINE against the real RPCs; this proves what a WORKER'S PHONE actually does
// when the network dies underneath it — which no RPC test can show, because the
// whole failure mode is a screen that looks fine.
//
// Runs as the live fixture worker B left up by s73-offline-proof.ts, at the
// three widths the product commits to.
//
// ⭐ WHY LOCAL AND NOT app.edgehq.ca: production serves `main`, which does not
// carry this branch. Driving the deployed app would prove somebody else's code.
// The DATA is real production data over the real RPCs — only the code being
// exercised is this branch. (s61-field-cdp.mjs's rule, and its reasoning.)
//
// ⭐⭐ OFFLINE IS EMULATED OVER CDP, NOT FAKED. Network.emulateNetworkConditions
// is the same switch DevTools' Offline toggle throws. ⚠️ It leaves
// `navigator.onLine` TRUE on this Chrome while killing every request — which is
// not a flaw in the harness but the CAPTIVE-PORTAL shape (hotel wifi at the edge
// of a job), and the layer is required to stay honest through it. So this file
// asserts the NETWORK is dead (a fetch that rejects), never the flag.
//
// Harness traps honoured from the sibling harnesses:
//   · wait for HYDRATION, not paint
//   · wait for the DAY, not the page — CrewToday fetches after mount
//   · MEASURE innerWidth after setDeviceMetricsOverride
//   · overflow measured PER ELEMENT (main is overflow-auto)
//   · auto-accept window.confirm — sign-out asks before discarding unsent work,
//     and a headless dialog nobody answers silently CANCELS the sign-out

import { spawn } from 'node:child_process'
import { mkdtempSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
const { WebSocket } = await import('ws').catch(() => ({ WebSocket: globalThis.WebSocket }))

const BASE = process.argv[2] || 'http://127.0.0.1:3173'
const WIDTHS = [375, 390, 430]
const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'
const PORT = 9471 + Number(process.env.CDP_SLOT || 7)

const s73 = existsSync('scripts/.s73-fixture.json')
  ? JSON.parse(readFileSync('scripts/.s73-fixture.json', 'utf8')) : {}
const s61 = existsSync('scripts/.s61-fixture.json')
  ? JSON.parse(readFileSync('scripts/.s61-fixture.json', 'utf8')) : {}
for (const f of ['.env.local', '../../edgehq-main/.env.local']) {
  if (!existsSync(f)) continue
  for (const line of readFileSync(f, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)$/)
    if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].trim()
  }
}
const EMAIL = (process.env.PORTAL_RPC_OWNER_EMAIL || '').replace(/@/, '+s61b@')
const PW = process.env.S73_WORKER_PW_B || s73.workerPwB
const JOB = s61.jobDirectB
if (!EMAIL || !PW) { console.error('no fixture worker credentials — run s73-offline-proof.ts first'); process.exit(2) }

let pass = 0, fail = 0, skipped = 0
const ok = (n, x = '') => { pass++; console.log('  ✅ ' + n + (x ? ' — ' + x : '')) }
const no = (n, d = '') => { fail++; console.log('  ❌ ' + n + (d ? '\n       ' + d : '')) }
const t = (n, c, d = '') => c ? ok(n, typeof d === 'string' && d ? d : '') : no(n, d)
// ⭐ NOT PROVEN is its own outcome, and it is neither a pass nor a failure.
// Counting an un-runnable check as green is how a suite starts lying; counting
// it as red trains people to ignore the red. It is reported loudly and tallied
// separately (verify-all's "a guard that cannot run proves nothing").
const skip = (n, why) => { skipped++; console.log('  ⏭  ' + n + '\n       NOT PROVEN HERE — ' + why) }

const profile = mkdtempSync(join(tmpdir(), 's73-cdp-'))
const chrome = spawn(CHROME, [
  '--remote-debugging-port=' + PORT, '--user-data-dir=' + profile,
  '--headless=new', '--disable-gpu', '--no-sandbox', '--hide-scrollbars',
  '--no-first-run', '--no-default-browser-check', 'about:blank',
], { stdio: 'ignore' })

const sleep = ms => new Promise(r => setTimeout(r, ms))

async function target() {
  for (let i = 0; i < 60; i++) {
    try {
      const list = await fetch('http://127.0.0.1:' + PORT + '/json/list').then(r => r.json())
      const page = list.find(x => x.type === 'page')
      if (page) return page.webSocketDebuggerUrl
    } catch { /* not up yet */ }
    await sleep(500)
  }
  throw new Error('no CDP page target')
}

// Counting the outbox is done from page context repeatedly; one definition.
const COUNT_OUTBOX = `(async () => {
  const db = await new Promise(r => { const q = indexedDB.open('eq-offline', 1); q.onsuccess = () => r(q.result); q.onerror = () => r(null) })
  if (!db) return -1
  if (!db.objectStoreNames.contains('outbox')) return 0
  return await new Promise(r => { const c = db.transaction('outbox', 'readonly').objectStore('outbox').count(); c.onsuccess = () => r(c.result); c.onerror = () => r(-1) })
})()`

async function main() {
  const ws = new WebSocket(await target())
  await new Promise(r => ws.addEventListener('open', r, { once: true }))
  let id = 0
  const pending = new Map()
  let dialogs = 0
  ws.addEventListener('message', ev => {
    const m = JSON.parse(typeof ev.data === 'string' ? ev.data : ev.data.toString())
    if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); return }
    // ⚠️ Sign-out asks before discarding unsent work. Headless, nobody answers,
    // the promise never settles — the sign-out silently does NOT happen, and
    // section 7 would then assert against a still-signed-in page and "pass" for
    // the wrong reason. Accept every dialog, and COUNT them so the fact the
    // warning fired at all is itself observable.
    if (m.method === 'Page.javascriptDialogOpening') {
      dialogs++
      ws.send(JSON.stringify({ id: ++id, method: 'Page.handleJavaScriptDialog', params: { accept: true } }))
    }
  })
  const send = (method, params = {}) => new Promise(res => {
    const n = ++id
    pending.set(n, res)
    ws.send(JSON.stringify({ id: n, method, params }))
  })
  const evalJs = async (expr) => {
    const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true })
    return r.result?.result?.value
  }
  const goto = async (path) => {
    await send('Page.navigate', { url: BASE + path })
    for (let i = 0; i < 80; i++) {
      const ready = await evalJs("document.readyState === 'complete' && !!document.querySelector('#__next, body > div')")
      if (ready) break
      await sleep(250)
    }
    await sleep(900)
  }
  const waitForDay = async () => {
    for (let i = 0; i < 60; i++) {
      const ready = await evalJs(`(() => {
        if (document.querySelector('[id^="crew-stop-"]')) return 'stops'
        const x = document.body.innerText || ''
        if (/Nothing booked today|No stops on the board|access has been turned off|Couldn.t load today/.test(x)) return 'empty'
        return ''
      })()`)
      if (ready) return ready
      await sleep(500)
    }
    return 'timeout'
  }
  const setOffline = async (on) => {
    await send('Network.emulateNetworkConditions', {
      offline: on, latency: 0, downloadThroughput: -1, uploadThroughput: -1,
    })
  }

  await send('Page.enable'); await send('Runtime.enable'); await send('Network.enable')

  console.log('\n═══ S73 offline layer in a phone browser — ' + BASE + ' ═══')

  // ── 1. Sign in as the fixture worker ───────────────────────────────────────
  console.log('\n── 1. The authenticated worker ────────────────────────────────')
  await send('Emulation.setDeviceMetricsOverride',
    { width: 390, height: 850, deviceScaleFactor: 2, mobile: true })
  await goto('/login')
  t('the viewport is really a phone', (await evalJs('window.innerWidth')) === 390)
  await evalJs(`(() => {
    const set = (el, v) => {
      const d = Object.getOwnPropertyDescriptor(el.constructor.prototype, 'value')
      d.set.call(el, v); el.dispatchEvent(new Event('input', { bubbles: true }))
    }
    const em = document.querySelector('input[type=email]')
    const pw = document.querySelector('input[type=password]')
    if (em) set(em, ${JSON.stringify(EMAIL)})
    if (pw) set(pw, ${JSON.stringify(PW)})
    return !!(em && pw)
  })()`)
  await evalJs("document.querySelector('form')?.requestSubmit() ?? document.querySelector('button[type=submit]')?.click()")
  await sleep(4500)
  let url = await evalJs('location.pathname')
  t('⭐ a worker signing in lands in Today', url === '/crew', 'landed at ' + url)
  if (url !== '/crew') await goto('/crew')
  const arrived = await waitForDay()
  t('the day loaded over the real RPCs', arrived === 'stops', 'state=' + arrived)
  const dayText = await evalJs('document.body.innerText')
  t('⛔ no money reaches the worker screen', !/\$\d/.test(dayText),
    (dayText.match(/\$\d[\d.,]*/g) || []).join(' '))

  // ── 2. The three widths ────────────────────────────────────────────────────
  console.log('\n── 2. 375 / 390 / 430 ─────────────────────────────────────────')
  for (const w of WIDTHS) {
    await send('Emulation.setDeviceMetricsOverride',
      { width: w, height: 850, deviceScaleFactor: 2, mobile: true })
    await goto('/crew')
    await waitForDay()
    const real = await evalJs('window.innerWidth')
    const over = await evalJs(`(() => {
      const w = window.innerWidth, bad = []
      for (const el of document.querySelectorAll('body *')) {
        const r = el.getBoundingClientRect()
        if (r.width > 0 && (r.right > w + 1 || r.left < -1)) bad.push((el.tagName + '.' + (el.className || '')).slice(0, 60))
      }
      return bad.slice(0, 4)
    })()`)
    t(w + 'px — no horizontal overflow', real === w && (over || []).length === 0,
      'innerWidth=' + real + ' offenders=' + JSON.stringify(over))
  }
  await send('Emulation.setDeviceMetricsOverride',
    { width: 390, height: 850, deviceScaleFactor: 2, mobile: true })

  // ── 3. ⭐⭐ Photo retry cannot duplicate — and cannot over-dedupe ───────────
  // Driven through the REAL door (/api/crew/photos) from the worker's own
  // authenticated session, because that is where the guarantee lives. The same
  // token twice must return the SAME row; a different token must return a
  // DIFFERENT one — a dedupe that swallowed a genuine second shot would be data
  // loss dressed up as idempotency.
  console.log('\n── 3. Photo retry idempotency (the real door) ─────────────────')
  if (!JOB) {
    no('no fixture job id — run s73-offline-proof.ts first')
  } else {
    const shot = async (token, tint) => await evalJs(`(async () => {
      const c = document.createElement('canvas'); c.width = 40; c.height = 40
      const g = c.getContext('2d'); g.fillStyle = ${JSON.stringify(tint)}; g.fillRect(0, 0, 40, 40)
      const blob = await new Promise(r => c.toBlob(r, 'image/jpeg', 0.8))
      const fd = new FormData()
      fd.set('jobId', ${JSON.stringify(JOB)})
      fd.set('kind', 'after')
      fd.set('uploadToken', ${JSON.stringify(token)})
      fd.set('file', new File([blob], 'proof.jpg', { type: 'image/jpeg' }))
      const res = await fetch('/api/crew/photos', { method: 'POST', body: fd })
      const d = await res.json().catch(() => ({}))
      return { status: res.status, id: d.id || null, deduped: !!d.deduped, error: d.error || null }
    })()`)
    const tok = 'aa' + Math.random().toString(36).slice(2, 12).replace(/[^a-z0-9]/g, 'x') + 'zzzz'
    const first = await shot(tok, '#2f6f3f')
    // ⚠️ 503 here is the route REFUSING CORRECTLY, not a bug: /api/crew/photos
    // needs the service role to verify anything, and "no service key → the door
    // stays shut" is its documented contract. This machine's .env.local carries
    // only the URL and the anon key, so the door cannot run at all locally.
    //
    // ⛔ That makes the live half UNPROVEN HERE, and it must say so rather than
    // be quietly dropped or reported as a failure of the feature. The
    // idempotency itself is pinned at the unit level (verify:field-reliability
    // §10: the same token yields the same path, different tokens never collide,
    // the row lookup precedes the byte read, upsert:false stays the atomic
    // guard). What is missing is only the end-to-end run, which needs an
    // environment holding SUPABASE_SERVICE_ROLE_KEY.
    if (first?.status === 503) {
      skip('⭐⭐ photo retry idempotency, end to end',
        'the crew photo door needs SUPABASE_SERVICE_ROLE_KEY, which this environment does not have. '
        + 'The route refused correctly (503). Unit-level proof: verify:field-reliability §10.')
    } else {
      t('a proof photo uploads through the crew door', first?.status === 200 && !!first?.id,
        JSON.stringify(first))
      const retry = await shot(tok, '#2f6f3f')
      t('⭐⭐ the SAME token returns the SAME row — a retry cannot duplicate',
        !!retry?.id && retry.id === first?.id, 'first=' + first?.id + ' retry=' + retry?.id)
      t('…and the server says it deduped rather than pretending it stored again',
        retry?.deduped === true, JSON.stringify(retry))
      const tok2 = 'bb' + Math.random().toString(36).slice(2, 12).replace(/[^a-z0-9]/g, 'x') + 'zzzz'
      const second = await shot(tok2, '#8a2f2f')
      t('⛔ a GENUINE second photo is not swallowed by the dedupe',
        !!second?.id && second.id !== first?.id, 'first=' + first?.id + ' second=' + second?.id)
    }
  }

  // ── 4. ⭐⭐ Cached Today stays honest about staleness ───────────────────────
  console.log('\n── 4. Offline: the cached day, and whether it lies ────────────')
  await goto('/crew')
  await waitForDay()
  await setOffline(true)
  const dead = await evalJs("(async () => { try { await fetch('/api/health', { cache: 'no-store' }); return false } catch { return true } })()")
  t('the network is genuinely dead (requests reject)', dead === true,
    'navigator.onLine=' + (await evalJs('navigator.onLine')) + ' — the flag lies; the network is what matters')
  await send('Page.navigate', { url: BASE + '/crew' })
  await sleep(1500)
  await waitForDay()
  const offText = await evalJs('document.body.innerText')
  t('⭐⭐ the day still renders with no network (served from the phone)',
    /[A-Za-z]/.test(offText) && !/Couldn.t load today/.test(offText),
    offText.replace(/\s+/g, ' ').slice(0, 120))
  // ⭐⭐ THE INVARIANT IS "NEVER POSES AS LIVE", not one exact word — and the two
  // phrasings are a deliberate distinction, not sloppiness:
  //   navigator.onLine false → "Offline"              (a real dead zone)
  //   navigator.onLine true  → "Can't reach the server" (the CAPTIVE PORTAL —
  //     the phone genuinely has wifi bars, so "Offline" would contradict what
  //     the worker can see on their own status bar)
  // CDP emulation produces the second case, which is why this ran into it. An
  // assertion pinned to the literal word "Offline" would have pushed the code
  // into telling a captive-portal worker something they can see is false.
  t('⭐⭐ …and it SAYS it is not live — it never poses as current',
    /Offline|Can.t reach the server/i.test(offText),
    offText.replace(/\s+/g, ' ').slice(0, 160))
  t('⭐⭐ …naming when the server last answered',
    /Last updated \d{1,2}:\d{2}\s*(AM|PM)/i.test(offText),
    (offText.match(/Last updated[^\n]*/i) || ['(no timestamp)'])[0])
  t('…and warns the office may have changed the day since',
    /may have changed your day/i.test(offText))

  // ── 5. ⭐⭐ A queued write is not lost, and never claims to be saved ────────
  console.log('\n── 5. Offline writes: queued, honest, durable ─────────────────')
  const before = await evalJs(COUNT_OUTBOX)
  const tapped = await evalJs(`(() => {
    const b = Array.from(document.querySelectorAll('button')).find(x => /^(Start|Finish|Resume|Done for today)/i.test(x.innerText.trim()))
    if (!b) return null
    b.click(); return b.innerText.trim()
  })()`)
  await sleep(4000)
  const afterTap = await evalJs('document.body.innerText')
  t('an offline action was available to tap', !!tapped, 'button=' + tapped)
  t('⭐⭐ it reports the work as HELD ON THE PHONE, never as saved',
    /saved on your phone|will sync/i.test(afterTap),
    (afterTap.match(/[^\n]*(saved on your phone|will sync)[^\n]*/i) || ['(no pending message)'])[0])
  t('⛔ and it does not claim the server has it',
    !/Saved to this visit/i.test(afterTap))
  const queued = await evalJs(COUNT_OUTBOX)
  t('⭐⭐ the intent is on disk (the outbox grew)', queued > before, before + ' → ' + queued)
  await send('Page.navigate', { url: BASE + '/crew' })
  await sleep(2000)
  const survived = await evalJs(COUNT_OUTBOX)
  t('⭐ queued work survives a full reload with no network', survived >= queued, queued + ' → ' + survived)
  t('⭐ the sync pill tells the worker something is waiting',
    /to sync|Offline/i.test(await evalJs('document.body.innerText')))

  // ── 6. Reconnect drains it ─────────────────────────────────────────────────
  console.log('\n── 6. Reconnect ───────────────────────────────────────────────')
  await setOffline(false)
  await goto('/crew')
  await waitForDay()
  let drained = -1
  for (let i = 0; i < 24; i++) {
    drained = await evalJs(COUNT_OUTBOX)
    if (drained === 0) break
    await sleep(2500)
  }
  t('⭐⭐ the queue drains on reconnect (no stuck work)', drained === 0, 'left=' + drained)

  // ── 7. ⭐ Sign-out clears the device ───────────────────────────────────────
  console.log('\n── 7. Sign-out clears worker-specific state ───────────────────')
  await goto('/crew/profile')
  await sleep(1500)
  const signedOut = await evalJs(`(() => {
    const b = Array.from(document.querySelectorAll('button')).find(x => /sign out/i.test(x.innerText))
    if (!b) return false
    b.click(); return true
  })()`)
  t('the sign-out control is on the worker profile', signedOut === true)
  await sleep(6000)
  const afterOut = await evalJs('location.pathname')
  t('⭐ signing out leaves Crew Mode', afterOut !== '/crew', 'at ' + afterOut)
  const residue = await evalJs(`(async () => {
    const count = async (name, store) => {
      const db = await new Promise(r => { const q = indexedDB.open(name, 1); q.onsuccess = () => r(q.result); q.onerror = () => r(null) })
      if (!db) return -1
      if (!db.objectStoreNames.contains(store)) return 0
      return await new Promise(r => { const c = db.transaction(store, 'readonly').objectStore(store).count(); c.onsuccess = () => r(c.result); c.onerror = () => r(-1) })
    }
    const drafts = Object.keys(localStorage).filter(k => k.startsWith('eq-field-draft:')).length
    return { day: await count('eq-field', 'today'), outbox: await count('eq-offline', 'outbox'), drafts }
  })()`)
  t('⭐⭐ no cached day is left on the device', residue?.day === 0, JSON.stringify(residue))
  t('⭐⭐ no drafts are left on the device', residue?.drafts === 0, JSON.stringify(residue))
  t('⭐⭐ no replayable queue is left on the device', residue?.outbox === 0, JSON.stringify(residue))

  console.log('\n── ' + pass + ' passed, ' + fail + ' failed'
    + (skipped ? ', ' + skipped + ' NOT PROVEN' : '') + ' ──')
  if (skipped) console.log('   ⏭  resolve the unproven check(s) in an environment with the service role.')
  if (dialogs) console.log('   (' + dialogs + ' confirm dialog(s) auto-accepted — the unsent-work warning fired)')
  return fail ? 1 : 0
}

main()
  .then(code => { try { chrome.kill() } catch {} process.exit(code) })
  .catch(e => { console.error(e); try { chrome.kill() } catch {} process.exit(1) })
