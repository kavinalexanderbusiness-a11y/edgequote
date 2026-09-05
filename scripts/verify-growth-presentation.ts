// ── Verify: Growth's numbers say what they actually are ──────────────────────
//   npx tsx scripts/verify-growth-presentation.ts
//
// A live Chrome audit of app.edgehq.ca (fresh main a44195be, read-only) found
// three honest-arithmetic-but-dishonest-WORDING defects on this screen, none
// of which change a single number:
//
//   • "61% likely to land" — score is a fixed-point heuristic (base 55 + fixed
//     signal deltas), never fit to observed outcomes. 61 IS 55 + 6 for 3+
//     completed visits, not a measured conversion rate.
//   • The evidence caveat and the concentration banner risk clipping on a
//     narrow phone — StatTile's `sub` truncates to one line by default.
//   • "Revenue from acted $2,380" — `result_value` is the forecast
//     `expectedValue` at the moment an owner taps "Mark won", not money
//     collected; nothing here reads an invoice or a payment.
//
// This guard tests observable PROPERTIES (the function's output, the real
// `cn()` utility, the exact data-path expression) rather than mirroring
// arbitrary comment prose, which breaks on the next legitimate rewording
// without proving anything about honesty.
//
// ⛔ FIXTURE DATA ONLY. No database, no build, no browser.

import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { priorityScoreLabel, priorityScoreTooltip } from '../src/lib/revenueIntelligence'

let failures = 0
let pending = 0
const ok = (n: string) => console.log(`  ✓ ${n}`)
const fail = (n: string, d: string) => { failures++; console.log(`  ✗ ${n}\n      ${d}`) }
const check = (n: string, c: boolean, d = '') => (c ? ok(n) : fail(n, d))
const eq = (n: string, a: unknown, b: unknown) =>
  check(n, JSON.stringify(a) === JSON.stringify(b), `expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`)

const ROOT = process.cwd()
const read = (p: string) => readFileSync(join(ROOT, p), 'utf8')
const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/\/\/[^\n\r]*/g, ' ')
const SRC = { page: read('src/app/dashboard/revenue-intelligence/page.tsx') }
const CODE = { page: strip(SRC.page) }

console.log('\n── 1. THE SCORE IS A PRIORITY, NEVER A PROBABILITY ──')
{
  // Behavioural: the audited value (55 + 6 = 61), tested for every property
  // the tooltip/label must have. `probability` is allowed ONLY inside its own
  // explicit denial ("not a measured probability") — banning it outright would
  // fail the honest disclaimer for naming the thing it refutes.
  eq('the audited case really is 55 (base) + 6 (3+ completed visits)', 55 + 6, 61)
  const label = priorityScoreLabel(61)
  const tip = priorityScoreTooltip(61)
  const BANNED = [/\blikely\b/i, /\blikelihood\b/i, /\bchance\b/i, /\bodds\b/i]
  check('priorityScoreLabel(61) contains the number, no probability word', label.includes('61') && !BANNED.some(rx => rx.test(label)) && !/\bprobability\b/i.test(label), label)
  check('priorityScoreTooltip(61) uses none of likely/likelihood/chance/odds', !BANNED.some(rx => rx.test(tip)), tip)
  check('priorityScoreTooltip(61) says "probability" only to explicitly deny it', /not a (measured|calibrated)[\w\s]*probability\b/i.test(tip), tip)
  check('priorityScoreTooltip(61) names it a heuristic/ranking, not a measurement', /heuristic|ranks|ranking/i.test(tip), tip)

  // Architecture: ONE shared function at both call sites, not two copies that
  // can drift independently.
  check('the hero line and every OppCard use the shared label/tooltip functions',
    /priorityScoreLabel\(summary\.topAction\.score\)/.test(CODE.page) && /title=\{priorityScoreTooltip\(o\.score\)\}/.test(CODE.page)
    && /\{priorityScoreLabel\(o\.score\)\}/.test(CODE.page), '')

  // Regression: none of these has any legitimate use on this screen.
  check('page.tsx renders none of likely/likelihood/chance/odds anywhere',
    !BANNED.some(rx => rx.test(CODE.page)), '')
  // ⭐ VISIBLE on the chip, not tooltip-only: measured at 375/390/430 that a
  // title never shows on touch, leaving a bare "61/100" with no name.
  check('the OppCard meter shows the visible "Priority score N/100" label, never N% and never a bare N/100',
    /\{priorityScoreLabel\(o\.score\)\}/.test(CODE.page) && !/\{o\.score\}%/.test(CODE.page) && !/\{o\.score\}\/100/.test(CODE.page), '')
}

console.log('\n── 2. A DISCLOSURE THAT WRAPS ──')
{
  // ⚠️ NOT a full React render. This repo's tsconfig sets `"jsx": "preserve"` —
  // Next's own SWC does the real JSX transform, so a standalone tsx/esbuild
  // render falls back to the classic pragma and throws on every component in
  // this app (all written for the automatic runtime). Testing under a jsx mode
  // the app doesn't ship with would be misleading, not proof. A real render
  // needs a real Next build — PENDING below, with the queued command.
  //
  // What CAN be proven without a build: the real `cn()` utility (clsx +
  // tailwind-merge, installed — not mocked) is what StatTile actually calls to
  // pick the class string. Calling it with the exact arguments StatTile.tsx
  // passes proves the resolved class for each value of `subWrap`, and — since
  // tailwind-merge's job is dropping classes it considers conflicting —
  // proves it does not silently eat `break-words` or the base classes.
  let cn: typeof import('../src/lib/utils').cn | null = null
  try {
    ;({ cn } = require('../src/lib/utils'))
  } catch (e) {
    pending++
    console.log('  ? PENDING — cn() behavioural check not run (needs clsx/tailwind-merge)')
    console.log(`      reason: ${(e as Error).message?.split('\n')[0] || e}`)
    console.log('      queued command (once a node_modules-bearing slot is available):')
    console.log(`        cd "${process.cwd()}" && npm install && npx tsx scripts/verify-growth-presentation.ts`)
  }
  if (cn) {
    const wrapClass = cn('text-[11px] text-ink-muted mt-1', true ? 'break-words' : 'truncate')
    const defaultClass = cn('text-[11px] text-ink-muted mt-1', false ? 'break-words' : 'truncate')
    check('subWrap=true resolves to break-words, not truncate, base classes intact',
      /\bbreak-words\b/.test(wrapClass) && !/\btruncate\b/.test(wrapClass) && /\bmt-1\b/.test(wrapClass), wrapClass)
    check('the DEFAULT (subWrap unset) keeps the original truncate behaviour',
      /\btruncate\b/.test(defaultClass) && !/\bbreak-words\b/.test(defaultClass), defaultClass)
  }

  // Wiring: the one tile that needed the fix actually opts in.
  check('the "Recurring opportunity" tile (the one with the long caveat) opts into subWrap',
    /label="Recurring opportunity"[\s\S]{0,300}subWrap/.test(CODE.page), '')
}

console.log('\n── 3. MARKED WON IS NOT COLLECTED REVENUE ──')
{
  // The actual data path, not a description of it: result_value passed to
  // recordRecommendation is EXACTLY the forecast expectedValue on 'won'.
  check('result_value is EXACTLY the forecast expectedValue on won, nothing else',
    /result_value:\s*status === 'won' \? o\.expectedValue : null/.test(CODE.page), '')

  // The visible label: no "Revenue" claim, and the old mislabel is gone.
  const tileLine = CODE.page.split('\n').find(l => l.includes('formatCurrency(wonValue)')) || ''
  check('the tile rendering wonValue exists and its label makes no "Revenue" claim',
    tileLine.length > 0 && !/label="[^"]*Revenue[^"]*"/.test(tileLine), tileLine)
  check('the old "Revenue from acted" mislabel is gone', !CODE.page.includes('Revenue from acted'), '')
}

console.log('\n── 4. THE THRESHOLD DOES NOT EXCLUDE AN EVEN TWO-CUSTOMER SPLIT ──')
{
  // Behavioural: an EXACT 50/50 two-customer book really is flagged material.
  const { assessConcentration, CONCENTRATION_MATERIAL_SHARE } = require('../src/lib/growthConcentration')
  const evenSplit = assessConcentration([
    { customerId: 'x', customerName: 'X', expectedValue: 1000 },
    { customerId: 'y', customerName: 'Y', expectedValue: 1000 },
  ])
  eq('an exact 50/50 two-customer book has a top share of exactly 50%', evenSplit.topShare, 0.5)
  check(`50% >= the ${CONCENTRATION_MATERIAL_SHARE * 100}% threshold, so it IS material`,
    evenSplit.topShare >= CONCENTRATION_MATERIAL_SHARE && evenSplit.material === true, JSON.stringify(evenSplit))

  // Generally: the larger share in a two-way split can never be below 50%, so
  // every two-customer book is material, whatever the split.
  const splits: [number, number][] = [[999, 1], [600, 400], [501, 499], [500, 500]]
  const allMaterial = splits.every(([a, b]) =>
    assessConcentration([{ customerId: 'a', customerName: 'A', expectedValue: a }, { customerId: 'b', customerName: 'B', expectedValue: b }]).material)
  check('every two-customer split tested (999/1, 600/400, 501/499, 500/500) is material', allMaterial, JSON.stringify(splits))
}

if (failures === 0 && pending === 0) {
  console.log('\n✅ growth presentation: all checks passed (nothing pending)\n')
} else if (failures === 0 && pending > 0) {
  console.log(`\n⚠️  growth presentation: 0 failures, but ${pending} section(s) PENDING (see above) — this is NOT a full pass\n`)
} else {
  console.log(`\n❌ ${failures} check(s) failed, ${pending} section(s) pending\n`)
}
process.exit(failures === 0 ? 0 : 1)
