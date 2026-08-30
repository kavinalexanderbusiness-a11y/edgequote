// ── Session 112: measure the accepted-version portal states in REAL Chrome ───
//   node scripts/s112-accepted-doc-cdp.mjs [.s112b]
//
// Lays out the harness scenes (scripts/s112-accepted-doc-harness.tsx) at
// desktop / 375 / 390 / 430 CSS px and MEASURES them — the S121 runner's
// mechanics (including the setTouchEmulationEnabled lesson: `pointer: coarse`
// comes from touch emulation, never from setEmulatedMedia).
//
// Per scene, per width: no sideways scroll, nothing past the right edge, the
// scene really rendered, and (at 375) the scene's own REQUIRED wording.
// ⭐ Tap-floor is asserted ONLY on the controls THIS session added (the
// previously-accepted block's actions): DocRow is a pre-existing production
// component, and a blanket floor here would attribute main's resting density
// to this lane — the S82 lesson, applied.
//
// ⛔ Presentation only. The database behaviour is verify:accepted-document-truth's
// job; the owner surface is proved live against a local build.

import { readdirSync, existsSync, writeFileSync, mkdirSync } from 'node:fs'
import { spawn } from 'node:child_process'
import { join, resolve } from 'node:path'

const DIR = resolve(process.argv[2] || '.s112b')
const WIDTHS = [[1280, 'desktop'], [375, '375'], [390, '390'], [430, '430']]
const CHROME_CANDIDATES = [
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
]

let failures = 0
const ok = (n) => console.log(`  ✓ ${n}`)
const fail = (n, d = '') => { failures++; console.log(`  ✗ ${n}${d ? `\n      ${d}` : ''}`) }
const check = (n, c, d = '') => (c ? ok(n) : fail(n, d))
const sleep = (ms) => new Promise(r => setTimeout(r, ms))

const REQUIRED = {
  'portal-standing': [
    'Accepted', 'your download above is that accepted version',
  ],
  'portal-drifted': [
    'This is the price you accepted — we’ve made changes since',
    'your download above is that accepted version',
  ],
  'portal-resent': [
    'Updated quote — replaces the version you accepted',
    'Your previously accepted version',
    'unchanged by the update above, which needs your approval',
  ],
}
// Sentences that would mean the two documents were being confused again.
const FORBIDDEN = {
  // A drifted row must not claim the live figure is what they agreed to.
  'portal-drifted': ['6,225'],
  // A re-sent update must not present itself as already accepted.
  'portal-resent': ['your download above is that accepted version'],
}

const chrome = CHROME_CANDIDATES.find(existsSync)
if (!chrome) { console.log('\n⏭  SKIPPED — Chrome not found at a known path.\n'); process.exit(0) }
if (!existsSync(DIR)) {
  console.log(`\n⏭  SKIPPED — ${DIR} not built. Run:  npm run build && npx tsx --tsconfig tsconfig.harness.json scripts/s112-accepted-doc-harness.tsx .s112b\n`)
  process.exit(0)
}

let ws, nextId = 1
const pending = new Map()
function send(method, params = {}) {
  const id = nextId++
  return new Promise((res, rej) => { pending.set(id, { res, rej }); ws.send(JSON.stringify({ id, method, params })) })
}
async function evaluate(expression) {
  const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.text + ' ' + (r.exceptionDetails.exception?.description || ''))
  return r.result.value
}

const port = 9378
const proc = spawn(chrome, [
  '--headless=new', `--remote-debugging-port=${port}`, '--disable-gpu', '--no-first-run',
  '--no-default-browser-check', '--user-data-dir=' + join(DIR, '.chrome'), 'about:blank',
], { stdio: 'ignore' })

async function main() {
  let target = null
  for (let i = 0; i < 60 && !target; i++) {
    await sleep(250)
    try {
      const r = await fetch(`http://127.0.0.1:${port}/json/list`)
      target = (await r.json()).find(t => t.type === 'page')
    } catch { /* not up yet */ }
  }
  if (!target) { console.log('  ⏭  SKIPPED — Chrome did not expose a debugging target.'); return }

  const { WebSocket } = await import('ws').catch(() => ({ WebSocket: globalThis.WebSocket }))
  ws = new WebSocket(target.webSocketDebuggerUrl, { maxPayload: 256 * 1024 * 1024 })
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej })
  ws.onmessage = (m) => {
    const msg = JSON.parse(m.data)
    if (msg.id && pending.has(msg.id)) {
      const { res, rej } = pending.get(msg.id); pending.delete(msg.id)
      msg.error ? rej(new Error(msg.error.message)) : res(msg.result)
    }
  }
  await send('Page.enable'); await send('Runtime.enable')

  const shots = join(DIR, 'shots'); mkdirSync(shots, { recursive: true })
  const scenes = readdirSync(DIR).filter(f => f.endsWith('.html')).map(f => f.replace(/\.html$/, ''))

  for (const scene of scenes) {
    console.log(`\n■ ${scene}`)
    for (const [w, label] of WIDTHS) {
      const coarse = w < 1000
      await send('Emulation.setDeviceMetricsOverride', { width: w, height: 900, deviceScaleFactor: 1, mobile: coarse })
      // pointer:coarse comes from TOUCH EMULATION — the S121 lesson, kept.
      await send('Emulation.setTouchEmulationEnabled', { enabled: coarse, maxTouchPoints: 5 })
      await send('Page.navigate', { url: 'file:///' + join(DIR, `${scene}.html`).replace(/\\/g, '/') })
      await sleep(450)
      const isCoarse = await evaluate(`matchMedia('(pointer: coarse)').matches`)
      check(`${label}: the pointer emulation actually applied`, isCoarse === coarse)

      const m = await evaluate(`(() => {
        const de = document.documentElement, vw = de.clientWidth
        const overflow = []
        for (const el of document.querySelectorAll('*')) {
          const r = el.getBoundingClientRect()
          if (r.width === 0 && r.height === 0) continue
          if (r.right > vw + 1) overflow.push(el.tagName + ' right=' + Math.round(r.right))
        }
        // The controls THIS session added: buttons inside the previously-accepted
        // block (found by its own heading). Everything else is main's baseline.
        let acceptedBlockSmall = []
        const head = [...document.querySelectorAll('p')].find(p => (p.textContent||'').includes('Your previously accepted version'))
        if (head) {
          const blockEl = head.closest('div')
          for (const b of blockEl.querySelectorAll('button')) {
            const r = b.getBoundingClientRect()
            if (r.height > 0 && r.height < 39.5) acceptedBlockSmall.push('button["' + (b.textContent||'').trim().slice(0,20) + '"] h=' + Math.round(r.height))
          }
        }
        return { scrollW: de.scrollWidth, clientW: vw, overflow: overflow.slice(0, 6), overflowN: overflow.length,
                 acceptedBlockSmall, text: document.body.innerText, html: document.body.innerHTML.length }
      })()`)

      check(`${label}: the page does not scroll sideways`, m.scrollW <= m.clientW + 1,
        `scrollWidth ${m.scrollW} > clientWidth ${m.clientW}`)
      check(`${label}: nothing pushes past the right edge`, m.overflowN === 0, m.overflow.join(' | '))
      check(`${label}: the scene actually rendered`, m.html > 500, `body html ${m.html} chars`)
      if (coarse && scene === 'portal-resent') {
        check(`${label}: the previously-accepted block's actions clear 40px`,
          m.acceptedBlockSmall.length === 0, m.acceptedBlockSmall.join(' | '))
      }
      if (label === '375') {
        const raw = await evaluate('document.body.innerHTML')
        for (const needle of (REQUIRED[scene] || [])) {
          check(`${label}: says "${needle.slice(0, 46)}"`, raw.includes(needle) || m.text.includes(needle),
            'not found in the rendered scene')
        }
        for (const needle of (FORBIDDEN[scene] || [])) {
          check(`${label}: does NOT say "${needle.slice(0, 46)}"`, !m.text.includes(needle))
        }
      }
      const shot = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true })
      writeFileSync(join(shots, `${scene}-${label}.png`), Buffer.from(shot.data, 'base64'))
    }
  }
  console.log(`\n  screenshots → ${shots}`)
}

main()
  .catch(e => { fail('the run completed', String(e.message).slice(0, 300)) })
  .finally(() => {
    try { ws && ws.close() } catch { /* closing */ }
    try { proc.kill() } catch { /* closing */ }
    console.log(failures === 0
      ? '\n✅ accepted-version portal states: every measurement passed\n'
      : `\n❌ accepted-version portal states: ${failures} measurement(s) failed\n`)
    process.exit(failures === 0 ? 0 : 1)
  })
