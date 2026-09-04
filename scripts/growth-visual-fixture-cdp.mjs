// ── Drive the Growth visual fixture at 1280 / 375 / 390 / 430 ────────────────
//   # terminal 1 — the scrubbed server (allowlisted env, synthetic Supabase,
//   # loopback only, refuses to start beside an env file):
//   node scripts/growth-visual-fixture-serve.mjs 3111
//   # terminal 2:
//   node scripts/growth-visual-fixture-cdp.mjs http://127.0.0.1:3111
//
// Opens the dev-only fixture route (src/app/dev/growth-visual-fixture) in
// headless Chrome and reads what the SHIPPING view rendered over the SHIPPING
// engine's output. ⛔ No login, no .env.local, no database, no credential —
// the route is gated by NODE_ENV and GROWTH_VISUAL_FIXTURE, not by a session.
//
// ⛔ READ-ONLY. It navigates, resizes, toggles two disclosure controls ("Why?"
// and the forecast) and takes screenshots. It never follows a link and never
// presses Take action / Dismiss / Mark won — and the page's own readouts
// (#fixture-network, #fixture-actions) are asserted at the end of every width,
// so a run that reached a network or recorded an action cannot pass.
//
// ⚠️ A blank page aborts with exit 3 rather than reporting every absence as a
// success. Anything it cannot drive is reported UNPROVEN, never as a pass.
//
// Screenshots: screens/growth-visual-fixture-<width>.png (screens/ is
// gitignored), or SHOTS_DIR=<dir> to put them elsewhere.
import { spawn, execFileSync } from 'node:child_process'
import { readFileSync, writeFileSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const CHROME = process.env.CHROME_PATH || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'
const [baseUrl = 'http://127.0.0.1:3111'] = process.argv.slice(2)
const ROUTE = '/dev/growth-visual-fixture'

// ⛔ LOOPBACK ONLY, refused up front. A browser proof aimed at a deployed host
// is a browser proof against production.
if (!/^https?:\/\/(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/.test(baseUrl)) {
  console.error(`✗ REFUSING: ${baseUrl} is not a loopback address.`)
  process.exit(2)
}

// ── The SHAs this run is evidence for ───────────────────────────────────────
const git = a => { try { return execFileSync('git', a).toString().trim() } catch { return 'unknown' } }
const FIXTURE_SHA = git(['rev-parse', 'HEAD'])
const PRODUCT_SHA = git(['merge-base', 'HEAD', 'session111/growth-concentration-disclosure'])
const DIRTY = git(['status', '--short'])

// ⛔ Chrome gets an ALLOWLISTED environment too: a browser that never receives
// a key cannot leak one.
const CHROME_ALLOW = ['PATH', 'Path', 'SystemRoot', 'SYSTEMROOT', 'windir', 'ComSpec', 'COMSPEC',
  'TEMP', 'TMP', 'USERPROFILE', 'HOMEDRIVE', 'HOMEPATH', 'APPDATA', 'LOCALAPPDATA',
  'NUMBER_OF_PROCESSORS', 'PROCESSOR_ARCHITECTURE', 'OS', 'PATHEXT']
const chromeEnv = Object.fromEntries(Object.entries(process.env).filter(([k]) => CHROME_ALLOW.includes(k)))
const PORT = 9841 + Number(process.env.CDP_SLOT || 0)
const WIDTHS = [1280, 375, 390, 430]
const SHOTS = resolve(process.env.SHOTS_DIR || 'screens')
mkdirSync(SHOTS, { recursive: true })

// ⭐ ONE source of truth for the names and the audited score: the fixture's own
// data module. Read as text so this runner needs no TypeScript loader.
const fixtureSrc = readFileSync('src/app/dev/growth-visual-fixture/fixtureData.ts', 'utf8')
const name = id => { const m = fixtureSrc.match(new RegExp(`export const ${id} = \\{ id: '[^']+', name: '([^']+)' \\}`)); if (!m) { console.error(`cannot read ${id} from fixtureData.ts`); process.exit(2) } return m[1] }
const ANCHOR = name('ANCHOR'), UNBROKEN = name('UNBROKEN'), THIN = name('THIN')
const AUDITED = Number((fixtureSrc.match(/export const AUDITED_SCORE = (\d+)/) || [])[1])
if (!AUDITED) { console.error('cannot read AUDITED_SCORE from fixtureData.ts'); process.exit(2) }

let fails = 0, unprovenCount = 0
const ok = n => console.log(`  ✓ ${n}`)
const bad = (n, d = '') => { fails++; console.log(`  ✗ ${n}${d ? `\n      ${d}` : ''}`) }
const check = (n, c, d = '') => c ? ok(n) : bad(n, d)
const note = n => console.log(`  · ${n}`)
const unproven = n => { unprovenCount++; console.log(`  ? UNPROVEN  ${n}`) }

// ⚠️⚠️ A REUSED CHROME PROFILE SERVES A STALE BUNDLE VIA THE SERVICE WORKER.
const profile = mkdtempSync(join(tmpdir(), 'gvf-cdp-'))
const chrome = spawn(CHROME, ['--headless=new', '--disable-gpu', '--no-sandbox', '--hide-scrollbars',
  `--remote-debugging-port=${PORT}`, '--remote-debugging-address=127.0.0.1', '--user-data-dir=' + profile, 'about:blank'],
  { stdio: 'ignore', env: chromeEnv })
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
if (!ws) { console.error('no CDP target'); process.exit(2) }
await new Promise(r => ws.addEventListener('open', r))
// ⭐⭐ EVERY REQUEST THE BROWSER MAKES, recorded from the protocol rather than
// from the page. The page keeps its own violation counter, but that counter is
// written by the code under test — this list is written by Chrome.
const requested = []
ws.addEventListener('message', e => {
  const m = JSON.parse(e.data)
  if (m.method === 'Network.requestWillBeSent' && m.params?.request?.url) requested.push(m.params.request.url)
  if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id) }
})
const send = (m, p = {}) => { const id = ++msgId; return new Promise(res => { pending.set(id, res); ws.send(JSON.stringify({ id, method: m, params: p })) }) }
const ev = async e => {
  const r = await send('Runtime.evaluate', { expression: e, awaitPromise: true, returnByValue: true })
  return r.result?.result?.value
}
const goto = async u => { await send('Page.navigate', { url: u }); for (let i = 0; i < 120; i++) { await sleep(250); if (await ev('document.readyState==="complete"')) break } }
const setW = async w => {
  const mobile = w < 900
  await send('Emulation.setDeviceMetricsOverride', { width: w, height: 900, deviceScaleFactor: mobile ? 2 : 1, mobile })
  // ⚠️ pointer:coarse comes from setTouchEmulationEnabled, NOT setEmulatedMedia.
  await send('Emulation.setTouchEmulationEnabled', mobile ? { enabled: true, maxTouchPoints: 5 } : { enabled: false })
}
async function until(expr, label, tries = 240) {
  for (let i = 0; i < tries; i++) { if (await ev(expr) === true) return true; await sleep(250) }
  bad(`${label} (timed out)`, expr.slice(0, 110)); return false
}
const done = async code => { try { ws.close() } catch {} try { chrome.kill() } catch {} try { rmSync(profile, { recursive: true, force: true }) } catch {} process.exit(code) }

// ⚠️ innerText, deliberately: it is what a person SEES. `title` attributes and
// sr-only text are not in it — which is exactly what one note below measures.
const TEXT = `(document.querySelector('main')||document.body).innerText`

// Every element painted outside the viewport, by bounding box.
const OVERFLOW = `(() => {
  const out = []
  const scope = document.querySelector('main') || document.body
  for (const el of scope.querySelectorAll('*')) {
    const r = el.getBoundingClientRect()
    if (r.width === 0) continue
    if (r.right > innerWidth + 1 || r.left < -1) {
      const label = (el.textContent || '').trim().slice(0, 28) || el.getAttribute('aria-label') || ''
      out.push(el.tagName.toLowerCase() + (label ? ' "' + label + '"' : '') + ' [' + Math.round(r.left) + '..' + Math.round(r.right) + ']')
    }
  }
  return [...new Set(out)].slice(0, 5)
})()`

// ⭐ Text that is painted wider than its own box: the shape a bounding-box
// check cannot see. A `truncate` line reports it (the ellipsis hides the rest),
// and so does an unbroken token spilling past a `min-w-0` flex child. Returns
// every leaf element containing the needle with its own scrollWidth/clientWidth.
const LEAVES = needle => `(() => {
  const scope = document.querySelector('main') || document.body
  return [...scope.querySelectorAll('*')]
    .filter(e => e.children.length === 0 && (e.textContent || '').includes(${JSON.stringify(needle)}))
    .map(e => ({ tag: e.tagName.toLowerCase(), text: (e.textContent || '').trim().slice(0, 40), clipped: e.scrollWidth > e.clientWidth + 1,
                 sw: e.scrollWidth, cw: e.clientWidth, right: Math.round(e.getBoundingClientRect().right), inner: innerWidth }))
})()`
const clippedOnes = list => (Array.isArray(list) ? list : []).filter(x => x.clipped || x.right > x.inner + 1)

// ── The fixture, once per width ─────────────────────────────────────────────
console.log(`fixture SHA ${FIXTURE_SHA} · product SHA ${PRODUCT_SHA} (merge-base with session111/growth-concentration-disclosure)`)
if (DIRTY) console.log(`⚠️  worktree is DIRTY — this run is NOT evidence for the SHA above:\n${DIRTY}`)
await send('Page.enable'); await send('Runtime.enable'); await send('Network.enable')
for (const w of WIDTHS) {
  console.log(`\n═══ ${w}px ═══`)
  await setW(w)
  await goto(`${baseUrl}${ROUTE}`)
  const ready = await until(`document.querySelector('#fixture-ready')?.dataset.ready === '1'`, 'the fixture mounted')
  if (!ready) {
    const len = Number(await ev(`(document.body.innerText || '').trim().length`))
    console.error(`PAGE DID NOT RENDER at ${w}px (${len} chars) — is the dev server up with GROWTH_VISUAL_FIXTURE=1? Aborting rather than reporting absence as success.`)
    await done(3)
  }
  await sleep(1200) // let animate-rise / stagger settle before measuring
  const body = String(await ev(TEXT))
  if (body.length < 500) { console.error(`PAGE TOO SHORT at ${w}px (${body.length} chars) — aborting`); await done(3) }
  note(`content column: ${await ev(`document.querySelector('main').clientWidth`)}px of a ${w}px viewport`)

  // 1. The page and the shell
  const over = await ev(OVERFLOW)
  check('nothing paints outside the viewport', Array.isArray(over) && over.length === 0, JSON.stringify(over))
  check('the content column has no horizontal scroll',
    await ev(`(() => { const m = document.querySelector('main'); return m.scrollWidth <= m.clientWidth + 1 })()`) === true,
    await ev(`(() => { const m = document.querySelector('main'); return m.scrollWidth + ' > ' + m.clientWidth })()`))
  check('the document itself has no horizontal scroll',
    await ev(`document.documentElement.scrollWidth <= innerWidth + 1`) === true, await ev(`document.documentElement.scrollWidth + ' > ' + innerWidth`))

  // 2. The headline caveat — the disclosure the audit found clipped to "…"
  const caveat = await ev(LEAVES('without enough data'))
  check('the "without enough data" caveat is rendered', Array.isArray(caveat) && caveat.length >= 1, JSON.stringify(caveat))
  check('…and is not truncated or painted past its tile', clippedOnes(caveat).length === 0, JSON.stringify(clippedOnes(caveat)))

  // 3. The concentration disclosure — real threshold, real sentence, long name
  const alert = await ev(`(() => { const a = document.querySelector('main [role="alert"]'); return a ? a.innerText : null })()`)
  check('the concentration banner renders as an alert', typeof alert === 'string' && alert.length > 0, String(alert))
  check(`…names ${ANCHOR.slice(0, 24)}… as the dominant share`, typeof alert === 'string' && alert.includes(ANCHOR) && /alone accounts for \d+%/.test(alert), String(alert).slice(0, 160))
  const banner = await ev(LEAVES('alone accounts for'))
  check('…and its sentence wraps inside the banner', clippedOnes(banner).length === 0, JSON.stringify(clippedOnes(banner)))

  // 4. The score — a priority, never a probability, everywhere it is shown
  check(`the top move reads "Priority score N/100"`, /Priority score \d+\/100/.test(body), body.match(/Priority score[^\n]*/)?.[0] || '(absent)')
  check('no visible text says likely / likelihood / chance / odds / probability',
    !/\b(likely|likelihood|chance|odds|probability)\b/i.test(body), (body.match(/[^\n]*\b(likely|likelihood|chance|odds|probability)\b[^\n]*/i) || [])[0] || '')
  const chips = await ev(`(() => [...document.querySelectorAll('main span[title]')]
    .filter(s => /^\\d+\\/100$/.test((s.textContent || '').trim()))
    .map(s => ({ text: (s.textContent || '').trim(), honest: /not a measured probability/.test(s.getAttribute('title') || '') })))()`)
  check('every card meter reads N/100', Array.isArray(chips) && chips.length >= 3, JSON.stringify(chips))
  check(`…one of them is the audited ${AUDITED}/100`, Array.isArray(chips) && chips.some(c => c.text === `${AUDITED}/100`), JSON.stringify((chips || []).map(c => c.text)))
  check('…each carries the shared honesty tooltip', Array.isArray(chips) && chips.every(c => c.honest), JSON.stringify(chips))
  check('no meter reads N%', await ev(`[...document.querySelectorAll('main span')].some(s => /^\\d+%$/.test((s.textContent || '').trim()))`) === false, '')
  if (w < 900 && !body.includes('not a measured probability')) {
    note(`touch screens never show a title tooltip: on the cards the honesty sentence ("…not a measured probability") is NOT visible at ${w}px — only the meter "N/100" is. The top-move line does carry the visible "Priority score N/100". Finding for review, not a failure of this proof.`)
  }

  // 5. The refusal — a figure only where the evidence earned it
  const refusal = await ev(LEAVES('Not enough reliable data'))
  check(`"${THIN}" is shown "Not enough reliable data" instead of a figure`, Array.isArray(refusal) && refusal.length >= 1 && body.includes(THIN), JSON.stringify(refusal))
  check('…and the refusal is not clipped', clippedOnes(refusal).length === 0, JSON.stringify(clippedOnes(refusal)))
  check('no card claims +$0', (body.match(/\+\$0(\.00)?\s*(\/yr)?/g) || []).length === 0, JSON.stringify(body.match(/\+\$0[^\n]*/g)))

  // 6. Long names — the spaced one must wrap; the unbroken one must not escape
  const anchorLeaves = await ev(LEAVES(ANCHOR))
  check(`the long spaced name appears on ${Array.isArray(anchorLeaves) ? anchorLeaves.length : 0} element(s), none clipped`, Array.isArray(anchorLeaves) && anchorLeaves.length >= 2 && clippedOnes(anchorLeaves).length === 0, JSON.stringify(clippedOnes(anchorLeaves)))
  const unbrokenLeaves = await ev(LEAVES(UNBROKEN))
  check(`the unbroken ${UNBROKEN.length}-char name appears on ${Array.isArray(unbrokenLeaves) ? unbrokenLeaves.length : 0} element(s), none painted past its box`,
    Array.isArray(unbrokenLeaves) && unbrokenLeaves.length >= 2 && clippedOnes(unbrokenLeaves).length === 0, JSON.stringify(clippedOnes(unbrokenLeaves)))

  // 7. Marked won is not collected revenue
  check('the "Value marked won" tile is labelled as marked won, not revenue', body.includes('Value marked won') && !/Revenue from acted/.test(body), '')
  check('one card is Won and one is Acted', /\bWon\b/.test(body) && /\bActed\b/.test(body), '')

  // 8. Reachability and accessibility of the controls
  const tiny = await ev(`(() => {
    const cards = [...document.querySelectorAll('main div')].filter(d => /Take action|Dismiss|Mark won|Not enough reliable data/.test(d.textContent || '') && d.className.includes('rounded-card'))
    const out = []
    for (const c of cards) for (const el of c.querySelectorAll('button,a[href]')) { const r = el.getBoundingClientRect(); if (r.width > 0 && r.height > 0 && r.height < 32) out.push((el.textContent || el.tagName).trim().slice(0, 24)) }
    return [...new Set(out)].slice(0, 5)
  })()`)
  check('no control under 32px tall in an opportunity card', Array.isArray(tiny) && tiny.length === 0, JSON.stringify(tiny))
  const unnamed = await ev(`[...document.querySelectorAll('main button, main a[href]')]
    .filter(el => !((el.getAttribute('aria-label') || el.textContent || '').trim()))
    .map(el => el.outerHTML.slice(0, 80))`)
  check('every button and link in the view has an accessible name', Array.isArray(unnamed) && unnamed.length === 0, JSON.stringify(unnamed))
  check('the Why? disclosures expose aria-expanded', await ev(`[...document.querySelectorAll('main button')].filter(b => /^Why\\?$/.test((b.textContent || '').trim())).every(b => b.hasAttribute('aria-expanded'))`) === true, '')

  // 9. Open the two disclosures — the transparency block and the forecast — and re-measure
  const why = await ev(`(() => { const b = [...document.querySelectorAll('main button')].find(x => (x.textContent || '').trim() === 'Why?'); if (!b) return 'NO_WHY'; b.click(); return 'CLICKED' })()`)
  if (why !== 'CLICKED') unproven(`no "Why?" control found (${why})`)
  else {
    await until(`${TEXT}.includes('What this is based on')`, 'the Why? panel opened')
    const evidence = String(await ev(TEXT))
    check('the evidence block names the record count and the statistic', /\d+ visits?/.test(evidence) && /median visit value/.test(evidence), '')
  }
  const fc = await ev(`(() => { const b = [...document.querySelectorAll('main button[aria-expanded]')].find(x => /Lifetime Value Forecast/.test(x.textContent || '')); if (!b) return 'NO_FORECAST'; b.click(); return 'CLICKED' })()`)
  if (fc !== 'CLICKED') unproven(`no forecast toggle found (${fc})`)
  else {
    await until(`${TEXT}.includes('at risk')`, 'the forecast opened')
    check('the forecast shows an at-risk pill for the slipping customer', /\/yr at risk/.test(String(await ev(TEXT))), '')
  }
  await sleep(600)
  const over2 = await ev(OVERFLOW)
  check('with both disclosures open, still nothing paints outside the viewport', Array.isArray(over2) && over2.length === 0, JSON.stringify(over2))
  check('…and still no horizontal scroll', await ev(`(() => { const m = document.querySelector('main'); return m.scrollWidth <= m.clientWidth + 1 && document.documentElement.scrollWidth <= innerWidth + 1 })()`) === true, '')

  // 10. The safety readouts — asserted LAST, after everything above was driven
  check('the page made no network request', await ev(`document.querySelector('#fixture-network')?.dataset.count`) === '0', await ev(`document.querySelector('#fixture-network')?.innerText`))
  check('no recommendation action fired', await ev(`document.querySelector('#fixture-actions')?.dataset.count`) === '0', await ev(`document.querySelector('#fixture-actions')?.innerText`))

  const { result } = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true })
  if (result?.data) { const file = join(SHOTS, `growth-visual-fixture-${w}.png`); writeFileSync(file, Buffer.from(result.data, 'base64')); note(`screenshot: ${file}`) }
  else unproven('screenshot could not be captured')
}

// ── The ledger Chrome kept ──────────────────────────────────────────────────
// ⛔ A single off-box request — a font CDN, an analytics beacon, a stray auth
// call — and this was not an offline proof. data:/blob: are in-page, not network.
console.log('\n═══ network ═══')
const offBox = [...new Set(requested)].filter(u => !/^(data|blob):/.test(u) && !/^https?:\/\/(127\.0\.0\.1|localhost|\[::1\])(:\d+)?(\/|$)/.test(u))
note(`${requested.length} request(s) recorded by Chrome, ${new Set(requested).size} distinct`)
check('⛔ every request the browser made was loopback', offBox.length === 0, offBox.join('\n      '))
if (DIRTY) bad('the worktree was dirty — a clean run is required for this to be evidence')

console.log(`\n${fails === 0 ? '✅ the Growth screen renders honestly at every width' : `❌ ${fails} check(s) failed`}${unprovenCount ? ` · ${unprovenCount} UNPROVEN` : ''} — fixture ${FIXTURE_SHA.slice(0, 8)} / product ${PRODUCT_SHA.slice(0, 8)}`)
await done(fails === 0 ? 0 : 1)
