// ── Verify: one surface means one thing ──────────────────────────────────────
//   npm run verify:surface-system
//
// WHY THIS SCRIPT EXISTS
// "A card" is painted 250+ times across this app, and for a long time which
// token a given file reached for was down to who wrote it: 126 hand-rolled
// cards said `bg-bg-secondary`, 54 said `bg-surface`, and the shared <Card>
// primitive said `bg-surface`. On dark those were three different navies four
// channels apart — too close to read as a hierarchy, far enough apart to look
// like a mistake when two landed side by side. Measured on the real running app
// before the fix, /dashboard/grow painted rgb(13,20,32) ×21 AND rgb(17,25,39)
// ×12 AND rgb(20,30,46) ×6 in a single viewport, with no rule saying which
// meant what. That is what made a mature product read as a pile of screens.
//
// The fix was not a rewrite — it was giving each rung ONE meaning, in one
// place. This guard keeps it that way. It pins RELATIONSHIPS, never values:
// re-tune the whole palette and this still passes, as long as the ladder holds.
//
//   bg              the page ground
//   bg-tertiary     a well RECESSED INTO a card (form fields, nested blocks)
//   bg-secondary    THE card  ─┬─ same rung, two names, one colour
//   surface         THE card  ─┘
//   surface-raised  floating ABOVE a card (menus, hovers, popovers)

import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'

let failures = 0
const ok = (n: string) => console.log(`  ✓ ${n}`)
const fail = (n: string, d: string) => { failures++; console.log(`  ✗ ${n}\n      ${d}`) }
const check = (n: string, cond: boolean, d = '') => (cond ? ok(n) : fail(n, d))

const ROOT = process.cwd()
const css = readFileSync(join(ROOT, 'src/app/globals.css'), 'utf8')

/** Pull one theme's token block out of globals.css. */
function themeBlock(selector: string): string {
  const i = css.indexOf(selector)
  if (i < 0) throw new Error(`globals.css has no ${selector} block`)
  const open = css.indexOf('{', i)
  const end = css.indexOf('\n  }', open)
  return css.slice(open, end)
}
/** `--c-x: 20 30 46;` → luminance-ordered sort key. Channel triplets only. */
function rung(block: string, name: string): { rgb: [number, number, number]; lum: number } {
  const m = block.match(new RegExp(`--c-${name}:\\s*([0-9]+)\\s+([0-9]+)\\s+([0-9]+)\\s*;`))
  if (!m) throw new Error(`--c-${name} is not a plain "R G B" triplet in this theme`)
  const rgb: [number, number, number] = [+m[1], +m[2], +m[3]]
  // Rec. 709 relative luminance is enough to order rungs; we only compare.
  return { rgb, lum: 0.2126 * rgb[0] + 0.7152 * rgb[1] + 0.0722 * rgb[2] }
}
const show = (r: { rgb: number[] }) => `rgb(${r.rgb.join(', ')})`

for (const [label, selector] of [
  ['dark', ":root[data-theme='dark']"],
  ['light', ":root[data-theme='light']"],
] as const) {
  console.log(`\n═══ The ${label} surface ladder ═══`)
  const b = themeBlock(selector)
  const ground = rung(b, 'bg')
  const well = rung(b, 'bg-tertiary')
  const card = rung(b, 'surface')
  const card2 = rung(b, 'bg-secondary')
  const raised = rung(b, 'surface-raised')

  // ⭐ THE contract. Two names for the card is fine — two COLOURS is the bug
  // this whole guard exists for, because it makes the same component render at
  // two different levels depending on which file drew it.
  check(`${label}: bg-secondary and surface are the SAME colour (one card fill)`,
    card.rgb.join() === card2.rgb.join(),
    `bg-secondary is ${show(card2)} but surface is ${show(card)} — pick one; every hand-rolled card uses one of these two names.`)

  check(`${label}: the card sits above the page ground`,
    Math.abs(card.lum - ground.lum) > 4,
    `ground ${show(ground)} vs card ${show(card)} — a card must be visibly off the canvas.`)

  // Direction matters, not distance: a "well" that is LIGHTER than its card is
  // a second card floating on the first, which is how "cards inside cards"
  // got everywhere. Light already did this correctly; dark did not.
  check(`${label}: bg-tertiary is RECESSED into the card, not floating on it`,
    well.lum < card.lum - 2,
    `bg-tertiary ${show(well)} is not darker than the card ${show(card)}. Form fields and nested blocks use this rung; if it outranks the card they read as cards themselves.`)

  // Distinctness is the universal part; DIRECTION is not, and pretending
  // otherwise would encode a dark-theme assumption as a law. On light the card
  // is pure white — there is no rung above it, so elevation is carried by
  // shadow and `surface-raised` is the slightly-grey hover tint BELOW white.
  // On dark there is headroom, and a hover that goes darker reads as pressed,
  // so there the direction genuinely matters.
  check(`${label}: surface-raised is visibly distinct from the card`,
    Math.abs(raised.lum - card.lum) > 2,
    `surface-raised ${show(raised)} is indistinguishable from the card ${show(card)} — it is what every hover, menu and popover lands on.`)

  if (label === 'dark') {
    check(`${label}: surface-raised floats ABOVE the card`,
      raised.lum > card.lum + 2,
      `surface-raised ${show(raised)} must sit above the card ${show(card)} on a dark theme, where there is headroom to rise into.`)

    // Light is exempt on purpose and it is NOT clean there: light's
    // bg-tertiary rgb(241,245,249) sits ~2 luminance off its ground
    // rgb(243,246,250), so a form field placed directly on the page (rather
    // than inside a card) is all but invisible in light mode. Pre-existing,
    // out of scope for this pass, and recorded here rather than asserted away.
    check(`${label}: the well stays clear of the page ground`,
      Math.abs(well.lum - ground.lum) > 2,
      `bg-tertiary ${show(well)} collides with the ground ${show(ground)}.`)
  }
}

// ── A state fill must not be the card's own fill ─────────────────────────────
// `hover:bg-surface` on a card is not a hover — it paints the row the colour it
// already is. That was silently true at all 261 <Card> sites even before the
// rungs were straightened out; it is now true everywhere, so the class is
// simply wrong and the fix is always `-raised`.
console.log('\n═══ States land on a rung the card is not ═══')
const files: string[] = []
;(function walk(d: string) {
  for (const e of readdirSync(d)) {
    const p = join(d, e)
    if (statSync(p).isDirectory()) walk(p)
    else if (/\.(tsx|ts)$/.test(e)) files.push(p)
  }
})(join(ROOT, 'src'))

// (?![-\w]) so `bg-surface-raised` is not matched; the optional /NN keeps
// alpha variants (`hover:bg-surface/40`) in scope — blending a colour with
// itself is just as invisible.
const STATE_ON_CARD = /(?:hover|active|focus|focus-visible|group-hover|peer-focus|aria-\[[^\]]+\]|data-\[[^\]]+\]):bg-surface(?:\/\d+)?(?![-\w])/g
const offenders: string[] = []
for (const f of files) {
  const src = readFileSync(f, 'utf8')
  const hits = src.match(STATE_ON_CARD)
  if (hits) offenders.push(`${f.slice(ROOT.length + 1).replace(/\\/g, '/')} → ${[...new Set(hits)].join(', ')}`)
}
check('no state variant paints `bg-surface` (the card\'s own fill)',
  offenders.length === 0,
  offenders.join('\n      ') + '\n      Use `bg-surface-raised` — that is the rung a hover/active state belongs on.')

// ── A list track must be allowed to shrink ───────────────────────────────────
// A bare `grid`/`flex` track is floored at its items' MIN-CONTENT width. The
// customers list hit this for real: rows whose min-content was 501px rendered
// 111px past a 390px viewport, putting the row's primary action off-screen
// behind a sideways scroll — and because <main> is `overflow-auto`, the page
// itself never reported an overflow, so nothing caught it.
console.log('\n═══ Row tracks can shrink below min-content ═══')
const BARE_GRID = /className="[^"]*\bgrid gap-[\d.]+[^"]*"/g
const bare: string[] = []
for (const f of files) {
  for (const m of readFileSync(f, 'utf8').match(BARE_GRID) || []) {
    if (!/grid-cols-/.test(m)) bare.push(`${f.slice(ROOT.length + 1).replace(/\\/g, '/')} → ${m.slice(0, 80)}`)
  }
}
check('no `grid gap-*` without an explicit column count',
  bare.length === 0,
  bare.join('\n      ') + '\n      Add `grid-cols-1` (= minmax(0,1fr)); a bare implicit track cannot shrink below its widest row.')

console.log(failures === 0
  ? '\n✅ Surface system holds: one card fill, states above it, wells inside it.\n'
  : `\n❌ ${failures} surface-system check(s) failed.\n`)
process.exit(failures === 0 ? 0 : 1)
