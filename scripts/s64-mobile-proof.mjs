// ── Session 64 mobile proof ──────────────────────────────────────────────────
// The worker-facing auth screens on a real headless Chrome at 375 / 390 / 430.
// Read-only: it loads pages and measures. No sign-in, no writes.
//
// Checks, per width: no horizontal overflow, tap targets >= 44px on the primary
// controls, inputs carry the autocomplete attributes a password manager needs,
// and the viewport meta does not block zoom.
import { launch } from 'puppeteer-core'
import { existsSync } from 'node:fs'

const BASE = process.env.BASE || 'https://app.edgehq.ca'
const WIDTHS = [375, 390, 430]
const CHROME = [
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
].find(existsSync)

let pass = 0, fail = 0
const t = (n, cond, d = '') => { if (cond) { pass++; console.log(`    ✅ ${n}${d ? ' — ' + d : ''}`) } else { fail++; console.log(`    ❌ ${n}${d ? ' — ' + d : ''}`) } }

const PAGES = [
  { name: 'worker sign-in', path: '/login' },
  // A dead token renders the "link has expired" panel — same layout as the live
  // form, and reachable without burning a real invitation.
  { name: 'invite acceptance', path: '/crew/welcome/deadtoken000000000000000000000000000000000000000000000' },
  { name: 'password recovery', path: '/forgot-password' },
]

async function main() {
  if (!CHROME) { console.error('no Chrome found'); process.exit(1) }
  const browser = await launch({ executablePath: CHROME, headless: 'new', args: ['--no-sandbox'] })
  try {
    for (const p of PAGES) {
      console.log(`\n── ${p.name} (${p.path.slice(0, 40)}) ──`)
      for (const width of WIDTHS) {
        const page = await browser.newPage()
        await page.setViewport({ width, height: 844, isMobile: true, hasTouch: true, deviceScaleFactor: 3 })
        await page.goto(BASE + p.path, { waitUntil: 'networkidle0', timeout: 45000 })
        await new Promise(r => setTimeout(r, 900))   // let the client form settle

        const m = await page.evaluate(() => {
          const de = document.documentElement
          // Anything sticking out past the viewport, ignoring what sits inside a
          // deliberate horizontal scroller.
          const over = [...document.querySelectorAll('body *')].filter(el => {
            const r = el.getBoundingClientRect()
            if (r.width === 0 || r.height === 0) return false
            // Skip anything inside a deliberate scroller OR a clipping box.
            // ⚠️ `hidden` matters as much as `auto`: the decorative background
            // orbs are absolutely positioned well past the viewport inside a
            // `fixed inset-0 overflow-hidden` layer, so they are CLIPPED and
            // cause no scroll. Counting them reported an overflow on three
            // pages that measured scrollWidth === clientWidth — a detector that
            // contradicts the page's own scroll width is measuring nothing.
            let a = el.parentElement
            while (a && a !== document.body) {
              const ox = getComputedStyle(a).overflowX
              if (ox === 'auto' || ox === 'scroll' || ox === 'hidden') return false
              a = a.parentElement
            }
            return r.right > window.innerWidth + 1 || r.left < -1
          }).length
          const controls = [...document.querySelectorAll('button, a[href], input')].filter(el => {
            const r = el.getBoundingClientRect()
            return r.width > 0 && r.height > 0
          }).map(el => ({
            tag: el.tagName.toLowerCase(),
            h: Math.round(el.getBoundingClientRect().height),
            text: (el.innerText || el.getAttribute('aria-label') || el.type || '').trim().slice(0, 28),
          }))
          const inputs = [...document.querySelectorAll('input')].map(i => ({
            type: i.type, autocomplete: i.getAttribute('autocomplete'),
          }))
          const viewport = document.querySelector('meta[name=viewport]')?.getAttribute('content') || ''
          return {
            scrollW: de.scrollWidth, clientW: de.clientWidth, over, controls, inputs, viewport,
          }
        })

        console.log(`  ${width}px`)
        t(`no horizontal page scroll`, m.scrollW <= m.clientW + 1, `scrollWidth ${m.scrollW} vs ${m.clientW}`)
        t(`nothing overflows the viewport`, m.over === 0, `${m.over} element(s)`)
        const small = m.controls.filter(c => c.h > 0 && c.h < 44)
        t(`visible controls are >= 44px tall`, small.length === 0,
          small.length ? small.map(c => `${c.tag}"${c.text}"=${c.h}px`).join(', ') : `${m.controls.length} checked`)
        t(`zoom is not disabled`, !/user-scalable\s*=\s*no|maximum-scale\s*=\s*1/.test(m.viewport), m.viewport || '(none)')
        if (m.inputs.length) {
          const named = m.inputs.every(i => !!i.autocomplete)
          t(`every input names an autocomplete (password managers)`, named,
            m.inputs.map(i => `${i.type}:${i.autocomplete ?? 'MISSING'}`).join(', '))
        }
        await page.close()
      }
    }
  } finally { await browser.close() }
  console.log(`\n${fail === 0 ? '✅' : '❌'} mobile proof: ${pass} passed, ${fail} failed`)
  process.exit(fail === 0 ? 0 : 1)
}
main()
