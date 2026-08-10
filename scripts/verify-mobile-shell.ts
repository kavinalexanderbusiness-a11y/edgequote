// ── Mobile shell guard — `npm run verify:mobile-shell` ───────────────────────
//
// The owner runs this CRM from a phone in a driveway. Two viewport rules decide
// whether that works, and both are invisible to tsc, to lint, and to anyone
// testing on a desktop browser at a narrow window — because a desktop window
// narrowed to 375px has NO URL bar that overlays content and NO home indicator.
// You only see these on a real handset, which is exactly why they need a guard:
//
//   1. `vh` is the LARGE viewport — the height with the mobile URL bar HIDDEN.
//      While that bar is showing (the normal state) a 90vh panel is taller than
//      what you can see, so its footer — Save, Delete, Cancel — sits behind the
//      browser chrome. The dialog scrolls its BODY, not itself, so there is no
//      way to reach those buttons. `dvh` tracks the live viewport.
//   2. A `fixed` element is positioned against the viewport and therefore never
//      receives the safe-area padding globals.css puts on <body>. Without paying
//      the inset itself, the mobile bottom sheet's footer lands under the iPhone
//      home indicator in the installed app. StickyActionBar documents exactly
//      this for its own fixed bar; Modal is the other fixed surface.
//
// Modal is THE dialog primitive (~11 dialogs across the CRM), so these are
// asserted against a real render — not a grep — via renderToStaticMarkup, the
// same technique verify:team uses to assert UI it cannot see.
//
// Deterministic, offline, no network.

import { readFileSync } from 'node:fs'
import { execSync } from 'node:child_process'

let pass = 0, fail = 0
const check = (name: string, ok: boolean, detail?: string) => {
  if (ok) { pass++; console.log(`  ✓ ${name}`) }
  else { fail++; console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`) }
}

// ── 1. The dialog primitive, rendered ────────────────────────────────────────
console.log('\n── Modal: the two rules a phone cares about ──')
// createElement rather than JSX, and React on the global first: this file runs
// under the app's tsconfig, where `jsx: preserve` leaves the COMPONENT compiled to
// bare `React.createElement(...)` with no import. Next supplies that scope; a plain
// tsx process does not. Same mechanic as verify:team — see its note.
const React = require('react') as typeof import('react')
;(globalThis as Record<string, unknown>).React = React
const { renderToStaticMarkup } = require('react-dom/server') as typeof import('react-dom/server')
const { Modal } = require('../src/components/ui/Modal') as typeof import('../src/components/ui/Modal')
const html = renderToStaticMarkup(
  React.createElement(Modal, {
    open: true,
    onClose: () => {},
    title: 'Edit invoice',
    footer: React.createElement('button', null, 'Save'),
    children: React.createElement('p', null, 'body'),
  })
)

check('the dialog actually rendered', html.includes('role="dialog"'))
// 1. Dynamic viewport height, with the vh fallback kept.
check('panel height tracks the LIVE viewport (dvh), not the URL-bar-hidden one',
  /max-height:1dvh\]:max-h-\[9\d+dvh\]|max-h-\[9\d+dvh\]/.test(html),
  'no dvh max-height — the footer will hide behind mobile browser chrome')
check('… and keeps a vh fallback for anything without dvh', /max-h-\[9\d+vh\]/.test(html))
// 2. Safe area, paid by the fixed overlay itself.
check('the fixed overlay pays the bottom safe-area inset itself',
  /pb-\[max\(1rem,env\(safe-area-inset-bottom\)\)\]/.test(html),
  'bottom-sheet footer will sit under the iPhone home indicator')
// Supporting behaviours that make the sheet usable at all.
check('mobile presentation is a bottom sheet, centred from sm up',
  html.includes('items-end') && html.includes('sm:items-center'))
check('the body scrolls independently and does not chain to the page behind',
  /overflow-y-auto[^"]*overscroll-contain|overscroll-contain[^"]*overflow-y-auto/.test(html))
check('the footer is pinned (shrink-0), so it cannot be scrolled away from',
  /border-t[^"]*shrink-0|shrink-0[^"]*border-t/.test(html))
check('the swipe-to-dismiss handle is mobile-only and does not steal page scroll',
  /sm:hidden[^"]*touch-none|touch-none[^"]*sm:hidden/.test(html))

// ── 2. Tailwind must actually EMIT the dvh rule ──────────────────────────────
// An arbitrary `supports-[…]` variant that Tailwind silently drops would leave
// the class in the markup and no CSS behind it — the assertion above would pass
// while the bug stayed. Only meaningful after a build; skipped otherwise.
console.log('\n── the dvh rule survives the build ──')
let css = ''
try {
  css = execSync('node -e "const fs=require(\'fs\'),p=require(\'path\');const d=\'.next/static/css\';if(!fs.existsSync(d)){process.exit(0)}for(const f of fs.readdirSync(d))if(f.endsWith(\'.css\'))process.stdout.write(fs.readFileSync(p.join(d,f),\'utf8\'))"', { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
} catch { /* no build output — fall through to skip */ }
if (!css) {
  console.log('  … skipped (no .next/static/css — run `npm run build` first)')
} else {
  check('the compiled stylesheet contains a dvh max-height rule', /max-height:\s*9\d+dvh/.test(css),
    'Tailwind did not emit the dvh utility — the class in the markup does nothing')
  check('… and the safe-area padding rule', /padding-bottom:\s*max\(1rem,\s*env\(safe-area-inset-bottom\)\)/.test(css))
}

// ── 3. Tables on owner screens stay horizontally scrollable ──────────────────
// Verified by hand across the CRM; pinned here so the next table added to a
// dense screen cannot quietly push the page wider than the phone.
console.log('\n── every owner-CRM table can scroll sideways ──')
const files = execSync('git ls-files "src/app/dashboard/**/*.tsx" "src/components/**/*.tsx"', { encoding: 'utf8' })
  .split('\n').filter(Boolean)
  .filter(f => !/\/dispatch\/|\/crew\/|components\/crew\/|components\/dispatch\//.test(f))
const unwrapped: string[] = []
for (const f of files) {
  const lines = readFileSync(f, 'utf8').split('\n')
  lines.forEach((line, i) => {
    if (!/<table[\s>]/.test(line)) return
    // ui/Table.tsx's own header comment says "Use with a plain <table>" — prose
    // about tables is not a table. Skip comment lines rather than widen the regex.
    const t = line.trim()
    if (t.startsWith('//') || t.startsWith('*') || t.startsWith('/*') || t.startsWith('{/*')) return
    // The wrapper is on the table's own element or within a few lines above it.
    const near = lines.slice(Math.max(0, i - 5), i + 1).join(' ')
    if (!/overflow-x-auto/.test(near)) unwrapped.push(`${f}:${i + 1}`)
  })
}
check('no owner-CRM <table> lacks a horizontal scroll container', unwrapped.length === 0, unwrapped.join(', '))

console.log(`\n${fail === 0 ? '✓' : '✗'} mobile shell checks: ${pass} passed, ${fail} failed`)
process.exit(fail === 0 ? 0 : 1)
