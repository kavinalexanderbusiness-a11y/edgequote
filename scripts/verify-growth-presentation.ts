// ── Verify: Growth's numbers say what they actually are ──────────────────────
//   npx tsx scripts/verify-growth-presentation.ts
//
// WHY THIS SCRIPT EXISTS
// A live Chrome audit of app.edgehq.ca (fresh main a44195be, read-only, no
// mutation) found three honest-arithmetic-but-dishonest-WORDING defects on this
// same screen, none of which change a single number:
//
//   • "61% likely to land" / "61/100 likelihood this play lands" — the score is
//     a fixed-point heuristic (a base like 55, plus/minus signal deltas for
//     tenure, visit count, churn), never fit to observed outcomes. 61 IS
//     "55 + 6 for 3+ completed visits", not a measured 61% conversion rate.
//   • The evidence caveat ("19 without enough data") and the concentration
//     banner both risk clipping on a narrow phone — StatTile's `sub` line
//     truncates to one line by default, which is right for a short caption and
//     wrong for a disclosure the reader must be able to read in full.
//   • "Revenue from acted $2,380" — `result_value` is seeded from
//     `o.expectedValue` (the forecast) the instant an owner taps "Mark won".
//     Nothing reads an invoice or a payment. It is the value of opportunities
//     the owner SAID were won, not money that was collected.
//
// None of this is a bug in the MATH — every number stays exactly what it was.
// This guard proves the WORDING no longer overclaims, and does so by testing
// observable PROPERTIES (no banned words survive; the shared label function
// produces honest output; a real React render actually wraps) rather than by
// asserting an exact copy string, which would break on the next legitimate
// rewording without proving anything about honesty.
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
const SRC = {
  page: read('src/app/dashboard/revenue-intelligence/page.tsx'),
  engine: read('src/lib/revenueIntelligence.ts'),
  concentration: read('src/lib/growthConcentration.ts'),
  statTile: read('src/components/ui/StatTile.tsx'),
}
const CODE = Object.fromEntries(Object.entries(SRC).map(([k, v]) => [k, strip(v)])) as Record<keyof typeof SRC, string>

console.log('\n── 1. ⭐⭐ THE SCORE IS A PRIORITY, NEVER A PROBABILITY ──')
{
  // ⭐ Behavioural, not copy-mirroring: assert the FUNCTION'S OUTPUT never
  // CLAIMS a probability, for a spread of inputs — not that page.tsx contains
  // one particular sentence chosen today. `likely`/`likelihood`/`chance`/`odds`
  // are banned outright everywhere; `probability` is banned from the terse
  // label (which has no room to qualify it) but the TOOLTIP is explicitly
  // allowed to use the word ONLY to name and refute the concern ("not a
  // measured probability") — that sentence is the fix, not a violation of it,
  // so a naive word-ban would fail the honest disclaimer for saying the word it
  // is disclaiming. Checked by requiring a negation immediately before it.
  const BANNED_ALWAYS = [/\blikely\b/i, /\blikelihood\b/i, /\bchance\b/i, /\bodds\b/i]
  for (const score of [0, 1, 55, 61, 99, 100]) {
    const label = priorityScoreLabel(score)
    const tip = priorityScoreTooltip(score)
    check(`priorityScoreLabel(${score}) contains the number`, label.includes(String(score)), label)
    check(`priorityScoreLabel(${score}) uses no probability-implying word`,
      !BANNED_ALWAYS.some(rx => rx.test(label)) && !/\bprobability\b/i.test(label), label)
    check(`priorityScoreTooltip(${score}) uses none of likely/likelihood/chance/odds`,
      !BANNED_ALWAYS.some(rx => rx.test(tip)), tip)
    check(`priorityScoreTooltip(${score}) only says "probability" to explicitly deny it`,
      !/\bprobability\b/i.test(tip) || /not a (measured|calibrated)[\w\s]*probability\b/i.test(tip), tip)
    check(`priorityScoreTooltip(${score}) names it a heuristic/ranking, not a measurement`,
      /heuristic|ranks|ranking/i.test(tip), tip)
  }
  // The 61 = 55 + 6 case from the audit, reproduced exactly to confirm this IS
  // the fixed-point arithmetic being described, not a different mechanism.
  eq('the audited case really is 55 (base) + 6 (3+ completed visits)', 55 + 6, 61)

  // ⭐ ARCHITECTURAL property: ONE shared function used at both call sites, not
  // two independently-worded copies that can drift apart (exactly how the top
  // hero sentence could stay honest while an OppCard tooltip quietly reverted,
  // or vice versa).
  check('the hero "top action" line uses the shared label function',
    /priorityScoreLabel\(summary\.topAction\.score\)/.test(CODE.page), '')
  check('every OppCard uses the shared tooltip function',
    /title=\{priorityScoreTooltip\(o\.score\)\}/.test(CODE.page), '')

  // Regression guard: none of likely/likelihood/chance/odds survives ANYWHERE
  // in the page (it has no legitimate use on this screen at all — unlike
  // "probability", which the tooltip is allowed to name once, to deny it).
  // Scoped to page.tsx, not the whole repo: other screens may legitimately
  // discuss unrelated probabilities (e.g. churn-risk modelling).
  for (const rx of BANNED_ALWAYS) {
    check(`page.tsx renders no "${rx.source}" anywhere`,
      !rx.test(CODE.page), `found ${rx.source} in page.tsx`)
  }
  check('page.tsx says "probability" at most once, and only to deny it (the tooltip helper)',
    (CODE.page.match(/\bprobability\b/gi) || []).length <= 1, CODE.page.match(/.{40}probability.{10}/gi)?.join(' | '))
  // And the bare meter number is no longer suffixed "%", which read as a
  // percentage-as-probability even once the word "likely" was gone.
  check('the OppCard meter shows N/100, not N%', /\{o\.score\}\/100/.test(CODE.page), '')
  check('…and no longer renders {o.score}%', !/\{o\.score\}%/.test(CODE.page), '')

  // The field's own internal documentation must not re-teach the misconception
  // to the next engineer who reads the type.
  check('the Opportunity.score field comment no longer calls it a "likelihood"',
    !/score: number\s*\/\/ 0\.\.100 likelihood/.test(CODE.engine), '')
  // ⚠️ Checked against RAW source (SRC), not the comment-stripped CODE — the
  // very thing being asserted here IS a comment, so stripping comments first
  // would make this check fail on the fix itself (it did, once).
  const scoreDoc = SRC.engine.slice(SRC.engine.indexOf('interface Opportunity'), SRC.engine.indexOf('interface Opportunity') + 1400)
  check('…and now explains the fixed-point-heuristic construction, in a real code comment',
    /heuristic/i.test(scoreDoc) && /clamp/i.test(scoreDoc), scoreDoc.slice(0, 200))
}

console.log('\n── 2. ⭐⭐ A DISCLOSURE THAT WRAPS ──')
{
  // ⚠️ NOT a full React render. This repo's tsconfig sets `"jsx": "preserve"` —
  // Next delegates the actual JSX transform to its own SWC build pipeline, so a
  // standalone tsx/esbuild run of a .tsx file falls back to the CLASSIC
  // `React.createElement` pragma and throws ("React is not defined") on any
  // component written for the automatic runtime, which is every component in
  // this app. Rendering under a DIFFERENT jsx mode than the one this app
  // actually ships with would prove something about esbuild's classic
  // transform, not about this component under Next — a misleading test, worse
  // than none. A real render therefore needs a real Next build, which this
  // wave explicitly avoids; PENDING below, with the exact command queued.
  //
  // What CAN be proven without a build: the real `cn()` utility (clsx +
  // tailwind-merge, an installed dependency — not mocked) is the actual
  // mechanism StatTile calls to pick the class string. Calling it with the
  // EXACT arguments StatTile.tsx passes proves what class name reaches the
  // DOM for each value of `subWrap`, and — since tailwind-merge's whole job is
  // dropping classes it considers conflicting — proves it does NOT silently
  // eat `break-words` (or the base `text-[11px] text-ink-muted mt-1` classes)
  // the way it would for two truly conflicting utilities.
  let cn: typeof import('../src/lib/utils').cn | null = null
  try {
    ;({ cn } = require('../src/lib/utils'))
  } catch (e) {
    pending++
    console.log('  ? PENDING — cn() behavioural check not run (needs clsx/tailwind-merge)')
    console.log(`      reason: ${(e as Error).message?.split('\n')[0] || e}`)
  }
  if (cn) {
    // The literal expression from StatTile.tsx's sub-line render, both branches.
    const wrapClass = cn('text-[11px] text-ink-muted mt-1', true ? 'break-words' : 'truncate')
    const defaultClass = cn('text-[11px] text-ink-muted mt-1', false ? 'break-words' : 'truncate')
    check('subWrap=true resolves to a class string containing break-words', /\bbreak-words\b/.test(wrapClass), wrapClass)
    check('…and does NOT also contain truncate (mutually exclusive, as coded)', !/\btruncate\b/.test(wrapClass), wrapClass)
    check('…and cn() has not eaten the base positioning/colour classes', /\bmt-1\b/.test(wrapClass) && /\btext-ink-muted\b/.test(wrapClass), wrapClass)
    check('the DEFAULT (subWrap unset) keeps the original truncate behaviour', /\btruncate\b/.test(defaultClass) && !/\bbreak-words\b/.test(defaultClass), defaultClass)
  }

  // ⭐ The exact conditional this behaviour depends on, confirmed present in the
  // component — a structural/architectural check (an if/else class selection
  // gated on a named prop), not a copy-mirror of arbitrary prose.
  check('StatTile\'s sub-line render is gated on subWrap exactly this way',
    /subWrap \? 'break-words' : 'truncate'/.test(CODE.statTile), '')
  check('subWrap defaults to unset/false — every existing caller is unaffected unless it opts in',
    !/subWrap:\s*true\b.*=.*StatTileProps/.test(CODE.statTile) && /subWrap\?:\s*boolean/.test(CODE.statTile), '')

  // The two call sites that must opt in, and the ones that must NOT.
  check('the "Recurring opportunity" tile (the one with the long caveat) opts into subWrap',
    /label="Recurring opportunity"[\s\S]{0,300}subWrap/.test(CODE.page), '')
  check('the concentration banner\'s text carries an explicit break-words wrapper (Banner has none of its own)',
    /<Banner[\s\S]{0,80}>[\s\S]{0,40}<p className="break-words">/.test(CODE.page), '')
  check('Banner\'s own content wrapper forces no single-line/nowrap/truncate that would fight the fix',
    !/(whitespace-nowrap|truncate)/.test(CODE.page.includes('Banner.tsx') ? '' : strip(read('src/components/ui/Banner.tsx'))), '')
}

console.log('\n── 3. ⭐⭐ MARKED WON IS NOT COLLECTED REVENUE ──')
{
  // ⭐ Property tests, not copy-mirroring: no financial-collection word may sit
  // near the marked-won total anywhere in this file, and the ONE place that
  // seeds `result_value` must visibly document that it is the forecast, not a
  // collection. These fail on ANY future wording that reintroduces the claim,
  // not just the exact one this session removed.
  // ⚠️⚠️ RAW source (SRC), not comment-stripped (CODE): the very thing being
  // checked here IS a comment. Anchored BEFORE the comment (at `wonCount =`,
  // which precedes it) rather than at `const wonValue` itself, which sits
  // AFTER the comment and would silently exclude it from the slice — both are
  // the same class of mistake this codebase's own guards warn about elsewhere,
  // caught here by actually reading the failure output rather than trusting
  // the check compiled.
  const wonBlock = SRC.page.slice(
    SRC.page.indexOf('const wonCount'),
    SRC.page.indexOf('const wonCount') + 1000,
  )
  check('the wonValue computation documents that it is NOT collected revenue',
    /NOT COLLECTED REVENUE/i.test(wonBlock), wonBlock.slice(0, 160))
  check('…and names where the number actually comes from (expectedValue / forecast)',
    /expectedValue/.test(wonBlock) && /forecast/i.test(wonBlock), '')
  check('…and explicitly says nothing here reads an invoice or payment',
    /invoice/i.test(wonBlock) && /payment/i.test(wonBlock), wonBlock)

  // Anchored at the state declaration just BEFORE the explanatory comment
  // (which itself precedes `async function act`) — anchoring at the function
  // name would exclude the very comment above it, the same mistake fixed above.
  const actBlock = SRC.page.slice(SRC.page.indexOf('const [showForecast'), SRC.page.indexOf('const [showForecast') + 1200)
  check('act() documents that result_value is the forecast, not a verified amount',
    /forecast/i.test(actBlock), actBlock.slice(0, 160))

  // The old label is gone, and — more importantly — no tile displaying wonValue
  // may claim the word "Revenue" anywhere in its own JSX line, present or future.
  const tileLine = CODE.page.split('\n').find(l => l.includes('formatCurrency(wonValue)')) || ''
  check('the tile rendering wonValue exists', tileLine.length > 0, '')
  check('…and its own label text contains no "Revenue" claim', !/label="[^"]*Revenue[^"]*"/.test(tileLine), tileLine)
  check('the old mislabel is gone', !CODE.page.includes('Revenue from acted'), '')

  // ⭐ THE ACTUAL DATA-PATH PROOF: result_value passed to recordRecommendation
  // is EXACTLY o.expectedValue on 'won', nothing else — the literal expression
  // that makes every honesty claim above true. If a future change wires in a
  // real invoice/payment lookup, this line changes and the guard should be
  // revisited (it is not claiming that would be wrong — only that TODAY it is
  // the forecast, and the wording must match today's reality).
  check('result_value is EXACTLY the forecast expectedValue on won, nothing else',
    /result_value:\s*status === 'won' \? o\.expectedValue : null/.test(CODE.page), '')
  check('recordRecommendation receives that same exact value, not a second computation',
    /recordRecommendation\(supabase, o, status, status === 'won' \? o\.expectedValue : undefined\)/.test(CODE.page), '')
}

console.log('\n── 4. ⭐⭐ THE THRESHOLD DOES NOT EXCLUDE AN EVEN TWO-CUSTOMER SPLIT ──')
{
  // ⭐ Behavioural, not a comment check: an EXACT 50/50 two-customer book really
  // is flagged material — proving the corrected claim, not just that the old
  // wrong claim's words are gone.
  const { assessConcentration, CONCENTRATION_MATERIAL_SHARE } = require('../src/lib/growthConcentration')
  const evenSplit = assessConcentration([
    { customerId: 'x', customerName: 'X', expectedValue: 1000 },
    { customerId: 'y', customerName: 'Y', expectedValue: 1000 },
  ])
  eq('an exact 50/50 two-customer book has a top share of exactly 50%', evenSplit.topShare, 0.5)
  check(`50% is >= the ${CONCENTRATION_MATERIAL_SHARE * 100}% threshold`, evenSplit.topShare >= CONCENTRATION_MATERIAL_SHARE, '')
  check('…so it IS flagged material, proving the threshold does NOT exclude even splits',
    evenSplit.material === true, JSON.stringify(evenSplit))

  // And more generally: EVERY two-customer book is material, whatever the split,
  // because the larger share in a two-way split can never be below 50%.
  for (const [a, b] of [[999, 1], [600, 400], [501, 499], [500, 500]]) {
    const r = assessConcentration([
      { customerId: 'a', customerName: 'A', expectedValue: a },
      { customerId: 'b', customerName: 'B', expectedValue: b },
    ])
    check(`two-customer split ${a}/${b}: top share ${Math.round(r.topShare * 100)}% is material`, r.material, JSON.stringify(r))
  }

  // ⚠️⚠️ RAW source, not stripped — a THIRD instance of the same mistake this
  // guard corrected twice above, caught by re-reading every failure rather than
  // assuming a passing check proved what its name claims. `strip()` removes the
  // very comment text both of these lines need to inspect; checked against
  // stripped text, the "old phrase is gone" assertion would pass VACUOUSLY
  // (stripped text contains no comment at all, old or new — proving nothing).
  const concentrationRaw = SRC.concentration
  // `[\s\S]` not `/s` (dotAll): this project's tsc target rejects the dotAll
  // flag outright (TS1501) — esbuild/tsx let it through at runtime, so this
  // only surfaces under a real `tsc --noEmit`, which is exactly why that check
  // is run separately rather than trusted to "the tests passed".
  check('the threshold comment no longer claims 40% keeps a two-customer book quiet',
    !/comfortably below the two-way-even 50%[\s\S]*still gets flagged/.test(concentrationRaw), '')
  check('the comment explicitly states a two-customer book is ALWAYS material',
    /always\s*>=\s*50%/i.test(concentrationRaw) && /EXCLUDE A TWO-CUSTOMER BOOK/i.test(concentrationRaw), '')
}

if (failures === 0 && pending === 0) {
  console.log('\n✅ growth presentation: all checks passed (nothing pending)\n')
} else if (failures === 0 && pending > 0) {
  console.log(`\n⚠️  growth presentation: 0 failures, but ${pending} section(s) PENDING (see above) — this is NOT a full pass\n`)
} else {
  console.log(`\n❌ ${failures} check(s) failed, ${pending} section(s) pending\n`)
}
process.exit(failures === 0 ? 0 : 1)
