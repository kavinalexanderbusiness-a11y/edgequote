// ── Drive the REAL customer-import page over the Chrome DevTools Protocol ────
//
// A CSV importer can be green in a Node harness and still be broken in the app:
// the mapping dropdowns are React-controlled, the preview only exists once the
// customer book has loaded, and the counts the owner acts on are rendered, not
// returned. So this signs in as the owner and reads what is actually on screen.
//
// Reads are safe against a real tenant — nothing is written unless --import is
// passed, and then only the rows in the CSV you hand it.
//
//   node scripts/import-cdp.mjs <csvFile> [--width 1280] [--import] [--shot name]
import { spawn } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { resolve, join } from 'node:path'

const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'
const argv = process.argv.slice(2)
const csvFile = argv[0]
const width = Number((argv[argv.indexOf('--width') + 1]) || 1280) || 1280
const doImport = argv.includes('--import')
const shotIdx = argv.indexOf('--shot')
const shotName = shotIdx >= 0 ? argv[shotIdx + 1] : null
const base = process.env.IMPORT_BASE || 'http://localhost:3125'
const PORT = 9322

const csv = csvFile ? readFileSync(csvFile, 'utf8') : ''
const sleep = ms => new Promise(r => setTimeout(r, ms))

// A fresh profile each run: a persistent one serves a STALE client bundle and
// would report yesterday's page as today's result.
const profile = resolve(process.env.TEMP || '.', `import-cdp-profile-${Date.now()}`)
const chrome = spawn(CHROME, [
  '--headless=new', '--disable-gpu', '--no-sandbox', '--hide-scrollbars',
  `--remote-debugging-port=${PORT}`, '--user-data-dir=' + profile, 'about:blank',
], { stdio: 'ignore' })

async function wsUrl() {
  for (let i = 0; i < 80; i++) {
    try { return (await (await fetch(`http://127.0.0.1:${PORT}/json/version`)).json()).webSocketDebuggerUrl }
    catch { await sleep(250) }
  }
  throw new Error('Chrome never opened its debugging port')
}
const ws = new WebSocket(await wsUrl())
await new Promise(r => ws.addEventListener('open', r, { once: true }))
let id = 0
const pending = new Map()
ws.addEventListener('message', e => {
  const m = JSON.parse(e.data)
  if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id) }
})
const send = (method, params = {}, sessionId) => new Promise((res, rej) => {
  const n = ++id
  pending.set(n, m => (m.error ? rej(new Error(method + ': ' + m.error.message)) : res(m.result)))
  ws.send(JSON.stringify({ id: n, method, params, sessionId }))
})

const { targetId } = await send('Target.createTarget', { url: 'about:blank' })
const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true })
const S = (m, p) => send(m, p, sessionId)
const ev = expr => S('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true }).then(r => r.result.value)

await S('Page.enable'); await S('Runtime.enable')
const metrics = { width, height: 900, deviceScaleFactor: 1, mobile: width < 700, screenWidth: width, screenHeight: 900 }
await S('Emulation.setDeviceMetricsOverride', metrics)

await S('Page.navigate', { url: base + '/login' })
await sleep(3000)
const signedIn = await ev(`(async () => {
  const set = (el, v) => {
    const p = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set
    p.call(el, v); el.dispatchEvent(new Event('input', { bubbles: true }))
  }
  const email = document.querySelector('input[type=email]')
  const pass = document.querySelector('input[type=password]')
  if (!email || !pass) return 'no login form'
  set(email, ${JSON.stringify(process.env.PORTAL_RPC_OWNER_EMAIL || '')})
  set(pass, ${JSON.stringify(process.env.PORTAL_RPC_OWNER_PASSWORD || '')})
  await new Promise(r => setTimeout(r, 250))
  ;[...document.querySelectorAll('button')].find(b => /sign in|log in/i.test(b.textContent||''))?.click()
  return 'submitted'
})()`)
await sleep(7000)

await S('Page.navigate', { url: base + '/dashboard/customers/import' })
await S('Emulation.setDeviceMetricsOverride', metrics)
// The page blocks preview until the customer book has loaded — give it time, or
// this measures the loading state and calls it the product.
await sleep(6000)

// Two genuinely different doors. Pasting drives the textarea; --upload performs
// a REAL file selection, which is the only path that can prove what an empty
// file does (a blank textarea is a blank slate; an empty file is an answer the
// owner is owed).
//
// ⚠️ Uploading via `input.files = dataTransfer.files` + a synthetic `change`
// does NOT work here and is not a product bug: React's ChangeEventPlugin
// suppresses onChange when the input's tracked `value` is unchanged, and
// assigning `.files` leaves `.value` empty. `DOM.setFileInputFiles` drives the
// browser's own file-selection machinery, so the event is trusted and `.value`
// is set exactly as a click on the label would leave it. A harness that used
// the synthetic route would report this page as broken when it is not.
// ⚠️ And `DOM.setFileInputFiles` alone is not enough either: in this headless
// build it attaches the files and sets `.value` to "C:\fakepath\<name>" but
// fires NO change event. So the two steps are combined — the protocol performs
// the real selection (which is what moves `.value`, defeating React's
// suppression), then the event is dispatched. Verified: files.length 1,
// value "C:\fakepath\header-only.csv", handler runs.
async function selectFile(path) {
  const { root } = await S('DOM.getDocument', { depth: -1 })
  const { nodeId } = await S('DOM.querySelector', { nodeId: root.nodeId, selector: 'input[type=file]' })
  if (!nodeId) return 'no file input'
  await S('DOM.setFileInputFiles', { files: [path], nodeId })
  const fired = await ev(`(() => {
    const i = document.querySelector('input[type=file]')
    if (!i || !i.files.length) return 'files never attached'
    i.dispatchEvent(new Event('change', { bubbles: true }))
    return 'uploaded (' + i.files.length + ' file, value=' + i.value + ')'
  })()`)
  return fired
}

const fed = argv.includes('--upload')
  ? await (async () => { await S('DOM.enable'); return selectFile(resolve(csvFile)) })()
  : await ev(`(() => {
      const ta = document.querySelector('textarea')
      if (!ta) return 'no textarea'
      const p = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set
      p.call(ta, ${JSON.stringify(csv)})
      ta.dispatchEvent(new Event('input', { bubbles: true }))
      return 'pasted'
    })()`)
await sleep(2500)

const READ = `(function(){
  const txt = el => (el.textContent||'').replace(/\\s+/g,' ').trim()
  const vis = el => { const r = el.getBoundingClientRect(); return r.width>0 && r.height>0 }
  const body = txt(document.body)
  // The mapping dropdowns, by their field label.
  const selects = [...document.querySelectorAll('select')].map(s => {
    const wrap = s.closest('div')
    const label = wrap ? txt(wrap.querySelector('label') || wrap) : ''
    return { field: label.split('—')[0].trim().slice(0, 30), chosen: s.selectedOptions[0] ? txt(s.selectedOptions[0]) : '' }
  })
  // The four figures, read off the rendered tiles rather than recomputed.
  const figures = [...document.querySelectorAll('div.rounded-lg.border')]
    .map(d => ({ n: txt(d.querySelector('p')), label: txt(d.querySelectorAll('p')[1]||d) }))
    .filter(f => /^[0-9,]+$/.test(f.n) && f.label && f.label.length < 30)
  const badges = {}
  for (const b of document.querySelectorAll('span')) {
    const t = txt(b)
    if (['New','Already here','Needs review','Can’t import'].includes(t)) badges[t] = (badges[t]||0)+1
  }
  const buttons = [...document.querySelectorAll('button')].filter(vis).map(b => ({
    label: txt(b).slice(0,60), disabled: b.disabled,
  })).filter(b => b.label)
  const VW = window.innerWidth
  const overflow = [...document.querySelectorAll('*')].filter(el => vis(el) && el.getBoundingClientRect().width > VW + 1)
  return JSON.stringify({
    viewport: VW,
    url: location.pathname,
    signedIn: !/sign in to edgequote/i.test(body),
    bookBlocked: /Import is blocked until/i.test(body),
    mobileNote: /easiest on a desktop/i.test(body),
    rowsRead: (body.match(/([0-9,]+) rows? · ([0-9]+) columns?/)||[])[0] || null,
    mapping: selects,
    figures,
    badgesVisible: badges,
    reasonsSample: [...document.querySelectorAll('p.text-ink-muted')].map(txt).filter(t => /already in EdgeQuote|New customer|row |No name|same name/i.test(t)).slice(0,6),
    warningsSample: [...document.querySelectorAll('p.text-amber-400\\\\/90')].map(txt).slice(0,4),
    buttons,
    nodesWiderThanViewport: overflow.length,
    // Everything the page SAYS about why it will not proceed. Matched on the
    // sentences themselves, so a message that stops rendering shows up here as
    // an absence rather than being filtered out by a too-clever selector.
    notices: [
      'has no rows in it', 'no customers under it', 'Map a name column',
      'Import is blocked until', 'was larger than', 'Only the first',
      'could be someone you already have', 'easiest on a desktop',
      'already in EdgeQuote. Importing it again',
    ].filter(s => body.includes(s)),
    // The page's own words, so a missing notice can be told apart from a notice
    // this probe simply did not know to look for.
    bodySample: body.slice(0, 700),
  })
})()`

const before = JSON.parse(await ev(READ))
console.log(JSON.stringify({ phase: 'preview', signedInStep: signedIn, fed, ...before }, null, 2))

// The SMS acknowledgement gate: --ack ticks it, so a run can show BOTH states —
// blocked with the box clear, released once the owner has read the notice.
if (argv.includes('--ack')) {
  const acked = await ev(`(() => {
    const box = document.getElementById('sms-consent-ack')
    if (!box) return 'no acknowledgement box on the page'
    box.click()
    return 'ticked'
  })()`)
  await sleep(1200)
  const after = JSON.parse(await ev(READ))
  console.log(JSON.stringify({ phase: 'after-ack', acked, buttons: after.buttons.filter(b => /Import|Nothing/.test(b.label)) }, null, 2))
}

if (shotName) {
  const { data } = await S('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true })
  writeFileSync(join(process.env.TEMP || '.', `${shotName}.${width}.png`), Buffer.from(data, 'base64'))
}

if (doImport) {
  const clicked = await ev(`(() => {
    const b = [...document.querySelectorAll('button')].find(x => /^Import [0-9,]+ customer/.test((x.textContent||'').trim()))
    if (!b) return 'no import button'
    if (b.disabled) return 'import button disabled'
    b.click(); return 'clicked'
  })()`)
  await sleep(9000)
  const after = JSON.parse(await ev(READ))
  const result = await ev(`(() => {
    const txt = el => (el.textContent||'').replace(/\\s+/g,' ').trim()
    return JSON.stringify({
      headline: txt(document.querySelector('p.text-lg')||document.body).slice(0,120),
      detail: [...document.querySelectorAll('p.text-sm')].map(txt).filter(t=>/row/.test(t)).slice(0,2),
      body: txt(document.body).slice(0, 900),
    })
  })()`)
  console.log(JSON.stringify({ phase: 'import', clicked, result: JSON.parse(result), buttons: after.buttons }, null, 2))
}

ws.close(); chrome.kill()
process.exit(0)
