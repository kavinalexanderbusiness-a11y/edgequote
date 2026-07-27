// ── Visit-value characterization — run by CI (npm run verify:visit-value) ──
//
// lib/visitValue.ts is THE single answer to "what is one visit of this job worth", and
// it's imported by ~17 surfaces (geo/optimizer, accounting, businessIntelligence,
// customerHealth, dayPlan, reactivation, the invoice engine…). A wrong value here is the
// RPT-1 disease — a recurring visit valued at its setup-inflated first-visit price, or a
// null-priced job counted as $0 revenue — and it is invisible to tsc and next build: the
// margin on the owner's screen is simply wrong. Nothing exercised it.
//
// It is pure (imports nothing) and deterministic. These pin two things especially:
//   • effectiveFreq is a PRICE-BUCKET selector, not a cadence — there are exactly three
//     per-visit price columns (weekly/biweekly/monthly), so a monthly, quarterly or
//     annual interval ALL resolve to the 'monthly' bucket. This has been misread as a
//     billing bug more than once; the truth is written down here, executably.
//   • jobVisitValue's precedence: a manual job price wins; the anchor (isInitial) visit
//     uses the quote's INITIAL price, not the cadence price.
//
// CHARACTERIZATION only — expected values read from the implementation; no production
// change.

import { effectiveFreq, quoteVisitAmount, jobVisitValue } from '../src/lib/visitValue'

let pass = 0
let fail = 0
function H(t: string) { console.log(`\n═══ ${t} ═══`) }
function check(name: string, actual: unknown, expected: unknown) {
  const a = JSON.stringify(actual); const e = JSON.stringify(expected)
  if (a === e) { pass++; console.log(`  ✅ ${name}`) }
  else { fail++; console.log(`  ❌ ${name}\n     expected: ${e}\n     actual:   ${a}`) }
}

// ═══════════════════════════════════════════════════════════════════════════
H('1. effectiveFreq — resolve an interval to a per-visit PRICE BUCKET')
check('a legacy freq value wins verbatim', effectiveFreq('weekly'), 'weekly')
check('a legacy freq is returned even if unit/count disagree', effectiveFreq('biweekly', 'month', 3), 'biweekly')
check('weekly interval → weekly', effectiveFreq(null, 'week', 1), 'weekly')
check('every-2-weeks → biweekly', effectiveFreq(null, 'week', 2), 'biweekly')
check('every-3-weeks rounds to the NEAREST bucket, biweekly', effectiveFreq(null, 'week', 3), 'biweekly')
check('every-4-weeks → monthly', effectiveFreq(null, 'week', 4), 'monthly')
check('week with no count defaults to weekly', effectiveFreq(null, 'week'), 'weekly')
// The load-bearing one: there is NO quarterly/annual price column, so month-based
// intervals ALL collapse to the monthly bucket. This is a price-bucket selector, not a
// cadence — do not "fix" it into quarterly/annual without a price column to hold them.
check('MONTHLY interval → monthly', effectiveFreq(null, 'month', 1), 'monthly')
check('QUARTERLY (month×3) → monthly bucket (nearest per-visit price)', effectiveFreq(null, 'month', 3), 'monthly')
check('ANNUAL (month×12) → monthly bucket (there is no annual price column)', effectiveFreq(null, 'month', 12), 'monthly')
check('day-based interval → weekly bucket', effectiveFreq(null, 'day', 10), 'weekly')
check('no freq and no unit → null (not recurring)', effectiveFreq(null), null)
check('an unknown unit → null', effectiveFreq(null, 'year', 1), null)

// ═══════════════════════════════════════════════════════════════════════════
H('2. quoteVisitAmount — the per-visit price for a resolved bucket')
const Q = { initial_price: 150, weekly_price: 65, biweekly_price: 80, monthly_price: 200, total: 500 }
check('weekly bucket takes the weekly price', quoteVisitAmount(Q, 'weekly'), 65)
check('biweekly bucket takes the biweekly price', quoteVisitAmount(Q, 'biweekly'), 80)
check('monthly bucket takes the monthly price', quoteVisitAmount(Q, 'monthly'), 200)
check('a null quote is worth 0', quoteVisitAmount(null, 'weekly'), 0)
check('a recurring visit whose exact cadence price is blank uses ANY recurring price, not the setup-inflated first visit',
  quoteVisitAmount({ weekly_price: 0, biweekly_price: 80, initial_price: 300 }, 'weekly'), 80)
check('a recurring visit with NO recurring prices falls back to the initial price',
  quoteVisitAmount({ initial_price: 150, total: 500 }, 'weekly'), 150)
check('a NON-recurring visit (freq null) is the initial price', quoteVisitAmount(Q, null), 150)
check('non-recurring with a zero initial falls through to the quote total',
  quoteVisitAmount({ initial_price: 0, total: 500 }, null), 500)
check('an empty quote is worth 0', quoteVisitAmount({}, null), 0)

// ═══════════════════════════════════════════════════════════════════════════
H('3. jobVisitValue — manual price wins; the anchor visit uses the INITIAL price')
check('a positive job price overrides everything the quote would say',
  jobVisitValue(90, Q, 'weekly'), 90)
check('no job price → the quote cadence price', jobVisitValue(null, Q, 'weekly'), 65)
check('a zero job price is not a price → falls through to the quote', jobVisitValue(0, Q, 'weekly'), 65)
check('a negative job price falls through too', jobVisitValue(-5, Q, 'weekly'), 65)
check('the ANCHOR visit (isInitial) is the quote INITIAL price, not the cadence price',
  jobVisitValue(null, Q, 'weekly', true), 150)
check('a non-anchor recurring visit is the cadence price', jobVisitValue(null, Q, 'weekly', false), 65)
check('no job price and no quote → 0', jobVisitValue(null, null, 'weekly'), 0)

// ═══════════════════════════════════════════════════════════════════════════
console.log(`\n${'═'.repeat(60)}\n  PASS ${pass}   FAIL ${fail}`)
if (fail > 0) process.exit(1)
