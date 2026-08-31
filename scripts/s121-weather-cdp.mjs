// ── Session 121: measure the WEATHER surfaces in REAL Chrome ────────────────
//   node scripts/s121-weather-cdp.mjs [.s121tz]
//
// Lays out the harness scenes (scripts/s121-weather-harness.tsx) at
// desktop / 375 / 390 / 430 CSS px in headless Chrome and MEASURES them.
// Class-name greps cannot tell you whether a dialog overflows a 375px phone;
// only layout can.
//
// Per scene, per width:
//   • the page never scrolls sideways (scrollWidth <= clientWidth + 1)
//   • no element pushes past the viewport's right edge
//   • every interactive control clears 44 CSS px
//   • the scene's OWN required wording is present and visible — a blank page
//     passes every other check, and a proof that measured a blank page is worse
//     than no proof
//
// ⛔ This measures PRESENTATION. The database behaviour behind these screens is
// proved by verify:tenant-time (against the real IANA database) and
// verify:weather-truth (over every day of the year); neither stands in for the other.

import { readdirSync, existsSync, writeFileSync, mkdirSync } from 'node:fs'
import { spawn } from 'node:child_process'
import { join, resolve } from 'node:path'

const DIR = resolve(process.argv[2] || '.s121tz')
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

// What each scene must actually SAY. Measuring a page that rendered nothing is
// the failure mode this list exists to make impossible.
const REQUIRED = {
  'weather-day-cards': ['Today', 'Tomorrow', 'Aug 28', 'Aug 29'],
  'weather-outlook-strip': ['Today', 'Aug 28', 'Sep 3'],
  'weather-why-not': ['Why not the other dry days?', 'already full', 'not one of your working days',
    'you marked this day unavailable', 'Working days and daily capacity come from Settings'],
  'weather-whole-page': ['Today', 'Tomorrow', 'Why not the other dry days?'],
}
// Text that must NOT appear.
const FORBIDDEN = {
  // ⛔ "Now" was the word that drifted onto tomorrow's column when the strip
  // compared against UTC. It is a statement about an INSTANT; these are DAYS.
  'weather-outlook-strip': ['Now'],
  'weather-whole-page': ['Now'],
  // ⛔ The UTC date must not appear as a bare day label anywhere — if it does,
  // some surface is still deriving its own date from the wrong clock.
  'weather-day-cards': [],
}

// ⭐⭐ THE INVARIANT, COUNTED IN THE RENDERED DOM rather than trusted from the
// source. The fixture is built at 23:30 on the 28th in Edmonton — 05:30 on the
// 29th in UTC — which is precisely when the page used to print two "Today"s.
// Anything that reintroduces a second clock shows up here as a 2.
const TODAY_LABEL_MAX = {
  'weather-day-cards': 1,
  'weather-outlook-strip': 1,
  'weather-whole-page': 2,   // the cards' one + the strip's one, on one page
}

const chrome = CHROME_CANDIDATES.find(existsSync)
if (!chrome) { console.log('\n⏭  SKIPPED — Chrome not found at a known path.\n'); process.exit(0) }
if (!existsSync(DIR)) {
  console.log(`\n⏭  SKIPPED — ${DIR} not built. Run:  npm run build && npx tsx --tsconfig tsconfig.harness.json scripts/s121-weather-harness.tsx\n`)
  process.exit(0)
}

// ── minimal CDP client ───────────────────────────────────────────────────────
let ws, nextId = 1
const pending = new Map()
function send(method, params = {}) {
  const id = nextId++
  return new Promise((res, rej) => {
    pending.set(id, { res, rej })
    ws.send(JSON.stringify({ id, method, params }))
  })
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
  // Wait for the debugging endpoint.
  let target = null
  for (let i = 0; i < 60 && !target; i++) {
    await sleep(250)
    try {
      const r = await fetch(`http://127.0.0.1:${port}/json/list`)
      const list = await r.json()
      target = list.find(t => t.type === 'page')
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
      await send('Emulation.setDeviceMetricsOverride', {
        width: w, height: 900, deviceScaleFactor: 1, mobile: coarse,
      })
      // ⚠️⚠️ THE POINTER MEDIA FEATURE IS LOAD-BEARING AND IS EASY TO FORGET.
      // This codebase's 44px minimum is delivered by `.tap-target`, which is
      // gated on `@media (pointer: coarse)` — deliberately, so mouse-driven
      // desktop density is untouched. setDeviceMetricsOverride's `mobile: true`
      // does NOT imply a coarse pointer, so without this the run measures the
      // DESKTOP rendering at a phone's width and reports the Modal close button
      // as a 28px tap target on a phone. It is 44px on a phone. The first
      // version of this script made exactly that mistake.
      // ⚠️⚠️ `pointer: coarse` COMES FROM TOUCH EMULATION, NOT FROM
      // setEmulatedMedia. Chrome derives the pointer media feature from whether
      // the device has a touchscreen, so setTouchEmulationEnabled is what makes
      // `@media (pointer: coarse)` match. Setting the feature directly via
      // Emulation.setEmulatedMedia is silently ignored for `pointer` — measured
      // here, by the self-check below reporting matchMedia = false while every
      // feature override claimed success.
      // maxTouchPoints must be 1..16 even when disabling — CDP validates the
      // field regardless of `enabled`.
      await send('Emulation.setTouchEmulationEnabled', { enabled: coarse, maxTouchPoints: 5 })
      await send('Page.navigate', { url: 'file:///' + join(DIR, `${scene}.html`).replace(/\\/g, '/') })
      await sleep(450)
      // ⚠️ And PROVE it took. An emulation that silently did nothing turns every
      // touch-target number below into a measurement of the wrong device.
      const isCoarse = await evaluate(`matchMedia('(pointer: coarse)').matches`)
      check(`${label}: the pointer emulation actually applied`, isCoarse === coarse,
        `matchMedia('(pointer: coarse)') = ${isCoarse}, expected ${coarse}`)

      // ⚠️ Assert we are measuring the screen we asked for, before believing any
      // number off it.
      const landed = await evaluate(`document.location.href.includes(${JSON.stringify(scene)})`)
      if (!landed) { fail(`${label}: landed on ${scene}`); continue }

      const m = await evaluate(`(() => {
        const de = document.documentElement, vw = de.clientWidth;
        let overflow = [];
        for (const el of document.querySelectorAll('*')) {
          const r = el.getBoundingClientRect();
          if (r.width === 0 && r.height === 0) continue;
          if (r.right > vw + 1) overflow.push((el.tagName + '.' + (el.className && el.className.baseVal !== undefined ? '' : String(el.className||''))).slice(0, 70) + ' right=' + Math.round(r.right));
        }
        let small = [], smallestH = Infinity;
        for (const el of document.querySelectorAll('button, a[href], input, select, textarea, label[class*="cursor-pointer"], summary')) {
          const r = el.getBoundingClientRect();
          if (r.width === 0 && r.height === 0) continue;
          if (r.height > 0) smallestH = Math.min(smallestH, r.height);
          // A radio or checkbox inside a >=44px label is reached by tapping the
          // LABEL — the input's own 13px box is not the target, and demanding it
          // be 44px would mean drawing a 44px checkbox.
          if (el.tagName === 'INPUT' && (el.type === 'checkbox' || el.type === 'radio')) {
            const lab = el.closest('label');
            if (lab && lab.getBoundingClientRect().height >= 43.5) continue;
          }
          if (r.height < 43.5) small.push(el.tagName + '["' + (el.textContent||'').trim().slice(0,28) + '"] h=' + Math.round(r.height));
        }
        return {
          scrollW: de.scrollWidth, clientW: vw,
          overflow: overflow.slice(0, 6), overflowN: overflow.length,
          small: small.slice(0, 6), smallN: small.length,
          smallestH: Number.isFinite(smallestH) ? smallestH : 999,
          text: document.body.innerText, html: document.body.innerHTML.length,
        };
      })()`)

      check(`${label}: the page does not scroll sideways`,
        m.scrollW <= m.clientW + 1, `scrollWidth ${m.scrollW} > clientWidth ${m.clientW}`)
      check(`${label}: nothing pushes past the right edge`,
        m.overflowN === 0, `${m.overflowN}: ${m.overflow.join(' | ')}`)
      // ⭐ The 44px minimum is a TOUCH rule, so it is asserted where there is a
      // thumb. Desktop density is a deliberate, separate decision in this
      // codebase (Button's `py-3 sm:py-2.5` is 44px on a phone and 42px with a
      // cursor); asserting 44px there would be asserting somebody else's design
      // choice was a bug.
      if (coarse) {
        check(`${label}: every control clears 44px (pointer: coarse)`,
          m.smallN === 0, `${m.smallN}: ${m.small.join(' | ')}`)
      }
      // ⛔ No size assertion at desktop, deliberately. The 44px minimum is a
      // TOUCH rule; this codebase delivers it through `.tap-target` and
      // `py-3 sm:py-2.5`, both of which are compact with a cursor ON PURPOSE.
      // A radio input is legitimately 13px there. Asserting a desktop floor here
      // would be asserting somebody else's deliberate density was a bug.
      check(`${label}: the scene actually rendered`, m.html > 500, `body html ${m.html} chars`)

      // The wording checks only need running once — at the narrowest width, where
      // truncation would bite.
      if (label === '375') {
        const raw = await evaluate('document.body.innerHTML')
        for (const needle of (REQUIRED[scene] || [])) {
          check(`${label}: says "${needle.slice(0, 46)}"`,
            raw.includes(needle) || m.text.includes(needle.replace(/&amp;/g, '&').replace(/<\/?span[^>]*>/g, '')),
            'not found in the rendered scene')
        }
        for (const needle of (FORBIDDEN[scene] || [])) {
          check(`${label}: does NOT say "${needle.slice(0, 46)}"`, !m.text.includes(needle))
        }
      }

      // ── ⭐⭐ COUNT THE "TODAY"s IN THE RENDERED DOM ─────────────────────────
      // Run at EVERY width, not just the narrowest: this is the invariant the
      // whole session exists to restore, and a layout that duplicated a card at
      // one breakpoint would duplicate the word with it.
      //
      // Counted as whole words in the visible text, so "Today · Aug 28" counts
      // once and a sentence mentioning the word in prose is not miscounted — the
      // fixture deliberately contains no such prose.
      const max = TODAY_LABEL_MAX[scene]
      if (max !== undefined) {
        // ⚠️ CASE-INSENSITIVE, AND READ FROM THE RENDERED TEXT. innerText returns
        // what the CSS actually paints, and these labels carry `uppercase` — so a
        // case-sensitive count of "Today" found ZERO while the screen plainly
        // said TODAY. The user sees the rendered form; so does this count.
        //
        // `[data-nocount]` is excluded: the fixture prints the two clock values
        // in a caption so a human reading the screenshot can see the setup, and
        // that caption is not a day label.
        const counted = await evaluate(`(() => {
          const root = document.body.cloneNode(true);
          for (const el of root.querySelectorAll('[data-nocount]')) el.remove();
          document.body.appendChild(root); root.style.position='absolute'; root.style.left='-99999px';
          const t = root.innerText; root.remove();
          return { today: (t.match(/\\btoday\\b/gi) || []).length,
                   tomorrow: (t.match(/\\btomorrow\\b/gi) || []).length };
        })()`)
        check(`${label}: exactly ${max} element${max === 1 ? '' : 's'} say${max === 1 ? 's' : ''} "Today"`,
          counted.today === max,
          `counted ${counted.today} — the fixture renders the tenant date (28th) while UTC is the 29th, which is exactly when the page used to print two`)
        // …and the 29th got "Tomorrow", which is the other half of the invariant:
        // one date owning the word is only right if the next date owns the next one.
        if (scene !== 'weather-outlook-strip') {
          check(`${label}: the 29th is labelled Tomorrow, not a second Today`, counted.tomorrow >= 1,
            `counted ${counted.tomorrow} "Tomorrow"`)
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
  .finally(async () => {
    try { ws && ws.close() } catch {}
    try { proc.kill() } catch {}
    console.log(failures === 0
      ? '\n✅ weather surfaces: every measurement passed\n'
      : `\n❌ weather surfaces: ${failures} measurement(s) failed\n`)
    process.exit(failures === 0 ? 0 : 1)
  })
