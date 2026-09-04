// ── S122 browser verification, against the offline fixture ───────────────────
//   node scripts/s122-fixture-cdp.mjs [baseUrl]
//
// Drives the REAL components in a REAL browser — the customer's blocked-deposit
// screen, the three accepted-version screens, and the owner's confirmation
// dialog in both of its shapes — and asserts what a person would see.
//
// ⛔⛔ WHAT IT CANNOT DO, and these are structural, not promises:
//   · It reads no `.env.local` and holds no credential. There is nothing here to
//     sign in with.
//   · The page it drives replaces window.fetch with a deny-by-default stub, so
//     no acceptance is recorded, no payment is started, and no request leaves the
//     browser. The page counts anything that tried; this script FAILS on a
//     non-zero count rather than trusting the claim.
//   · It needs no database and no production environment. The route it opens
//     refuses to exist unless NODE_ENV is not production AND S122_FIXTURE=1.
//
// ⚠️ It proves what the SCREEN says. It does not prove what the server would do —
// that is verify:deposit-charge-authority's job, which drives the real routes
// over a real Postgres. The two together are the claim; neither alone is.

import { spawn } from 'node:child_process'
import { writeFileSync, mkdirSync } from 'node:fs'
import { resolve } from 'node:path'

const CHROME = process.env.CHROME_PATH || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'
const base = (process.argv[2] || 'http://localhost:3000').replace(/\/$/, '')
const PORT = 9720 + Number(process.env.CDP_SLOT || 0)
const WIDTHS = [1280, 430, 390, 375]

let failures = 0
const ok = n => console.log(`     ✓ ${n}`)
const fail = (n, d = '') => { failures++; console.log(`     ✗ ${n}${d ? `\n         ${d}` : ''}`) }
const check = (n, c, d = '') => (c ? ok(n) : fail(n, d))
const sleep = ms => new Promise(r => setTimeout(r, ms))

try { mkdirSync(resolve('screens'), { recursive: true }) } catch { /* exists */ }

const chrome = spawn(CHROME, [
  '--headless=new', '--disable-gpu', '--no-sandbox', '--hide-scrollbars',
  `--remote-debugging-port=${PORT}`,
  '--user-data-dir=' + resolve(process.env.TEMP || '.', `eq-s122fx-${PORT}-${Date.now()}`),
  'about:blank',
], { stdio: 'ignore' })

async function wsUrl() {
  for (let i = 0; i < 80; i++) {
    try { return (await (await fetch(`http://127.0.0.1:${PORT}/json/version`)).json()).webSocketDebuggerUrl }
    catch { await sleep(250) }
  }
  throw new Error('no debugging port — is Chrome at CHROME_PATH?')
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
await S('Page.enable'); await S('Runtime.enable')
const ev = e => S('Runtime.evaluate', { expression: e, returnByValue: true, awaitPromise: true })
  .then(r => r.result.value)

async function open(path, width) {
  const metrics = { width, height: 1400, deviceScaleFactor: 1, mobile: width < 900, screenWidth: width, screenHeight: 1400 }
  await S('Emulation.setDeviceMetricsOverride', metrics)
  // ⚠️ pointer:coarse comes from setTouchEmulationEnabled, not setEmulatedMedia.
  if (width < 900) await S('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 })
  await S('Page.navigate', { url: `${base}${path}` })
  await sleep(2200)
  await S('Emulation.setDeviceMetricsOverride', metrics)
  await sleep(800)
  // ⛔ A blank page must never read as "the bad string is absent". That is a
  // passing negative invented by a failed load, and it is how a browser proof
  // comes to certify nothing at all.
  const len = await ev("(document.body.innerText||'').trim().length")
  if (!len || len < 120) {
    fail(`PAGE DID NOT RENDER at ${path} (${len} chars)`,
      'is the dev server up, and was it started with S122_FIXTURE=1?')
    return false
  }
  return true
}

/** innerText of one scene container — assertions are scoped, never page-wide. */
const sceneText = id_ => ev(
  `(function(){var e=document.getElementById(${JSON.stringify(id_)});` +
  `return e ? (e.innerText||'').replace(/\\s+/g,' ') : ''})()`)

const sceneHasPayButton = id_ => ev(
  `(function(){var e=document.getElementById(${JSON.stringify(id_)});if(!e)return null;` +
  `return Array.from(e.querySelectorAll('button')).some(function(b){return /Pay\\s+\\$/i.test(b.textContent||'')})})()`)

const safety = () => ev(`(function(){
  var n=document.getElementById('fixture-network'), a=document.getElementById('fixture-actions');
  return { net: n ? (n.innerText||'') : 'MISSING', act: a ? (a.innerText||'') : 'MISSING' }
})()`)

async function shot(name) {
  const { data } = await S('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true })
  writeFileSync(resolve('screens', `${name}.png`), Buffer.from(data, 'base64'))
  console.log(`       shot: screens/${name}.png`)
}

// ═════════════════════════════════════════════════════════════════════════════
console.log(`\n══ S122 fixture · ${base}/dev/s122-fixture ══\n`)

for (const w of WIDTHS) {
  console.log(`── ${w}px ──`)
  if (!(await open('/dev/s122-fixture', w))) continue

  const overflow = await ev('document.body.scrollWidth + "/" + window.innerWidth')
  const [sw, iw] = overflow.split('/').map(Number)
  check(`no horizontal scroll (${overflow})`, sw <= iw + 1)

  // ── 1 · Legacy acceptance: the deposit is withheld ────────────────────────
  {
    const t = await sceneText('scene-legacy-blocked')
    check('legacy · no Pay button', (await sceneHasPayButton('scene-legacy-blocked')) === false,
      'payments are ENABLED on this fixture, so a missing button can only be the acceptance rule')
    check('legacy · the reason is on screen',
      /can’t take its deposit online|cannot take its deposit online/i.test(t), t.slice(0, 220))
    check('legacy · …and points somewhere', /message us/i.test(t))
    check('legacy · the $250 ask still stands', /\$250/.test(t))
    check('legacy · ⛔ the raw-snapshot $700 appears nowhere', !/700/.test(t))
    check('legacy · ⛔ nor the unproven $1,400', !/1,400/.test(t))
    check('legacy · ⛔ and it never says "you accepted"', !/you accepted/i.test(t))
  }

  // ── 2 · The customer's own acceptance: the snapshot IS shown ──────────────
  {
    const t = await sceneText('scene-accepted-current')
    check('customer · the consent snapshot is shown', /1,400/.test(t), t.slice(0, 220))
    check('customer · …and only here is "the price you accepted" said',
      /price you accepted/i.test(t))
    check('customer · the Pay button is offered', (await sceneHasPayButton('scene-accepted-current')) === true,
      'the strip must be conditional — an always-strip regression shows up here')
    check('customer · at the snapshot-derived $700', /\$700/.test(t))
  }

  // ── 3 · Recorded on their behalf: same figure, different voice ────────────
  {
    const t = await sceneText('scene-accepted-on-behalf')
    check('on-behalf · the agreed figure is shown', /1,400/.test(t))
    check('on-behalf · worded as the business’s record', /on your behalf/i.test(t), t.slice(0, 220))
    check('on-behalf · ⛔ never in the customer’s voice', !/you accepted/i.test(t))
  }

  // ── 4 · Marked accepted with nothing behind it ────────────────────────────
  {
    const t = await sceneText('scene-unevidenced')
    check('unevidenced · says plainly there is no record',
      /don’t have a record of your acceptance|don't have a record of your acceptance/i.test(t), t.slice(0, 220))
    check('unevidenced · shows the CURRENT price, not the stale one', /\$500/.test(t) && !/1,400/.test(t))
    check('unevidenced · no Pay button', (await sceneHasPayButton('scene-unevidenced')) === false)
  }

  // ── 0 · The PDF seam ──────────────────────────────────────────────────────
  // ⚠️ On an ACCEPTED quote the timing sentence is not rendered in the portal at
  // all (BillingTab shows `explain` only while a quote can still be accepted), so
  // the "$700 against a $500 quote" half of the original defect reaches the
  // customer through the PDF. This asks each row's real getBlob what basis it
  // hands the renderer — the fact the repair turns on — without building a PDF.
  {
    const clicked = await ev(`(function(){
      var b=Array.from(document.querySelectorAll('button'))
        .find(function(x){return /Ask every row for its PDF/.test(x.textContent||'')});
      if(!b) return false; b.click(); return true })()`)
    check('the PDF seam can be interrogated', clicked === true)
    await sleep(600)
    const seam = await ev("(document.getElementById('fixture-pdf')||{}).innerText||''")
    check('pdf · ⛔ no snapshot goes to the document when nobody is named',
      /scene-legacy-blocked=null/.test(seam) && /scene-unevidenced=null/.test(seam), seam)
    check('pdf · …and the agreed figure does when somebody is',
      /scene-accepted-current=1400/.test(seam) && /scene-accepted-on-behalf=1400/.test(seam), seam)
  }

  const s = await safety()
  check('⛔ nothing left the browser', /violations: 0/.test(s.net), s.net)
  check('⛔ no portal action fired', /fired: 0/.test(s.act), s.act)
  await shot(`s122-fixture-portal-${w}`)
}

// ── 5 & 6 · The owner's confirmation dialog, driven for real ────────────────
// ⭐ Every click below is on a REAL control. The fixture presses none of its own
// buttons: a page that submitted itself would prove the page works.
const setReactValue = (sel, value) => ev(`(function(){
  var el=document.querySelector(${JSON.stringify(sel)}); if(!el) return false;
  var proto = el.tagName === 'TEXTAREA' ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(proto,'value').set.call(el, ${JSON.stringify(value)});
  el.dispatchEvent(new Event('input',{bubbles:true})); return true;
})()`)

const clickText = (text, tag = 'button') => ev(`(function(){
  var b=Array.from(document.querySelectorAll(${JSON.stringify(tag)}))
    .find(function(x){return (x.textContent||'').indexOf(${JSON.stringify(text)})>=0});
  if(!b) return false; b.click(); return true;
})()`)

for (const shape of ['unnamed', 'revised']) {
  for (const w of [1280, 375]) {
    console.log(`── owner confirmation · ${shape} · ${w}px ──`)
    if (!(await open(`/dev/s122-fixture?scene=owner-${shape}`, w))) continue

    check('the dialog is open on its first step',
      /How did they tell you\?/i.test(await ev("document.body.innerText||''")))

    check('a reason can be chosen', (await clickText('They replied by text')) === true)
    await sleep(200)
    check('…and Record then becomes pressable', (await clickText('Record acceptance')) === true)
    await sleep(900)

    const t = (await ev("(document.body.innerText||'').replace(/\\s+/g,' ')"))
    if (shape === 'unnamed') {
      check('unnamed · the headline names the real problem',
        /No acceptance naming who agreed is on file/i.test(t), t.slice(0, 300))
      check('unnamed · ⛔ it does NOT claim the quote changed',
        !/changed after it was marked Accepted/i.test(t))
      check('unnamed · ⛔ and shows no struck-through prior figure',
        !/Previous unsupported acceptance figure/i.test(t))
    } else {
      check('revised · the headline names the revision',
        /This quote changed after it was marked Accepted/i.test(t), t.slice(0, 300))
      check('revised · the prior unsupported figure is shown, struck through',
        /Previous unsupported acceptance figure/i.test(t) && /1,400/.test(t))
    }
    check('the confirm button NAMES the amount', /Confirm acceptance of \$500/.test(t), t.slice(0, 300))
    check('…and the panel says a note is required', /A note is required/i.test(t))

    // The confirm step demands the checkbox AND a note — assert it refuses first.
    const disabledBefore = await ev(`(function(){
      var b=Array.from(document.querySelectorAll('button')).find(function(x){return /Confirm acceptance of/.test(x.textContent||'')});
      return b ? b.disabled : null })()`)
    check('⛔ confirming is refused before the owner attests', disabledBefore === true)

    await ev(`(function(){var c=document.querySelector('input[type=checkbox]'); if(c) c.click(); })()`)
    await setReactValue('#acceptance-note', 'Fixture note: customer confirmed by text.')
    await sleep(250)
    const disabledAfter = await ev(`(function(){
      var b=Array.from(document.querySelectorAll('button')).find(function(x){return /Confirm acceptance of/.test(x.textContent||'')});
      return b ? b.disabled : null })()`)
    check('…and allowed once the box is ticked and a note written', disabledAfter === false)

    await shot(`s122-fixture-owner-${shape}-${w}`)

    check('the attestation submits', (await clickText('Confirm acceptance of')) === true)
    await sleep(900)
    const after = await ev("(document.body.innerText||'').replace(/\\s+/g,' ')")
    check('…and the owner is told it landed, naming the amount',
      /Recorded — ZZ-2026-0152 is accepted at \$500/.test(after), after.slice(0, 300))
    check('…and the page saw onRecorded fire once', /onRecorded fired: 1/.test(after))

    const s = await safety()
    check('⛔ nothing left the browser', /violations: 0/.test(s.net), s.net)
  }
}

console.log(failures > 0 ? `\n✗ ${failures} FAILURE(S)` : '\n✓ s122 fixture: every browser check passed')
ws.close(); chrome.kill()
process.exit(failures > 0 ? 1 : 0)
