// ── Signals verification — npm run verify:signals ────────────────────────────
//
// lib/signals/* is THE canonical detector engine (DETECTION_ENGINE_ADR): one
// definition each for "ran out", "lapsed", "churn risk", "seasonally dormant",
// cadence and lifetime value, consumed by eight surfaces — the signals cron,
// reactivation, the weekly review, TodaysPriorities, customerHealth, business/
// revenue intelligence and suggestions. It exists BECAUSE these rules once had
// four-to-six divergent copies: the same snow customer in July was suppressed as
// dormant on one screen and flagged as lost on another, and the same customer
// was a VIP on one page and not the next. A regression here re-opens exactly
// that disease — and it's a wrong VERDICT, not a type error, so tsc and next
// build stay green. Nothing exercised the module.
//
// These are CHARACTERIZATION tests: every expected value was captured from the
// module itself (seasons interplay and money fallbacks included), so today's
// behaviour is pinned without changing a line of source. Pure + deterministic,
// no I/O — the detectors take the clock as a parameter by design.

import {
  cadenceDays, daysBetween, isSeasonallyDormant, ranOut, isLapsed, churnRisk,
  visitValue, lifetimeValue, isVip,
  VIP_LTV, CHURN_RATIO_WARN, CHURN_RATIO_HIGH, RANOUT_URGENT_MIN_DAYS, RANOUT_URGENT_CADENCES,
  type RanOutInput,
} from '../src/lib/signals'
import { DEFAULT_SEASONS } from '../src/lib/seasons'

let pass = 0
let fail = 0
function H(t: string) { console.log(`\n═══ ${t} ═══`) }
function check(name: string, actual: unknown, expected: unknown) {
  const a = JSON.stringify(actual); const e = JSON.stringify(expected)
  if (a === e) { pass++; console.log(`  ✅ ${name}`) }
  else { fail++; console.log(`  ❌ ${name}\n     expected: ${e}\n     actual:   ${a}`) }
}

// ═══════════════════════════════════════════════════════════════════════════
H('1. CADENCE — the one "days between visits" answer (was four copies)')
check('weekly → 7', cadenceDays('weekly'), 7)
check('biweekly → 14', cadenceDays('biweekly'), 14)
check('monthly → 30', cadenceDays('monthly'), 30)
check('nothing knowable → the historical biweekly default (14)', cadenceDays(null), 14)
check('a named cadence BEATS the recurrence interval', cadenceDays('weekly', { interval_unit: 'month', interval_count: 2 }), 7)
check('recurrence: every 10 days → 10', cadenceDays(null, { interval_unit: 'day', interval_count: 10 }), 10)
check('recurrence: every 3 weeks → 21', cadenceDays(null, { interval_unit: 'week', interval_count: 3 }), 21)
check('recurrence: every 2 months → 60', cadenceDays(null, { interval_unit: 'month', interval_count: 2 }), 60)
check('interval_count 0 clamps to 1 (never a zero-day rhythm)', cadenceDays(null, { interval_unit: 'week', interval_count: 0 }), 7)
check('an unknown unit falls back to 14', cadenceDays(null, { interval_unit: 'year', interval_count: 1 }), 14)

// ═══════════════════════════════════════════════════════════════════════════
H('2. SEASONAL DORMANCY — the snow-customer-in-July rule, both directions')
check('a snow customer in July is dormant, not lost', isSeasonallyDormant('Snow Removal', DEFAULT_SEASONS, '2026-07-15'), true)
check('the same snow customer in January is IN season', isSeasonallyDormant('Snow Removal', DEFAULT_SEASONS, '2026-01-15'), false)
check('a mowing customer in January is dormant', isSeasonallyDormant('Weekly Mowing', DEFAULT_SEASONS, '2026-01-15'), true)
check('the same mowing customer in July is in season', isSeasonallyDormant('Weekly Mowing', DEFAULT_SEASONS, '2026-07-15'), false)
check('a service with NO season is never dormant (year-round trade)', isSeasonallyDormant('Plumbing Repair', DEFAULT_SEASONS, '2026-01-15'), false)
check('a null service is never dormant', isSeasonallyDormant(null, DEFAULT_SEASONS, '2026-01-15'), false)

// ═══════════════════════════════════════════════════════════════════════════
H('3. RAN OUT — the guard ladder, in its exact order')
const BASE: RanOutInput = {
  hasRecurring: true, hasUpcoming: false, lastServiceDate: '2026-06-01',
  cadenceDays: 7, seasonallyDormant: false, today: '2026-06-15',
}
check('a dry weekly series 14 days on → ran out, urgent',
  ranOut(BASE), { isRanOut: true, isUrgent: true, daysSince: 14, reason: 'ran_out' })
check('no recurring series → no_recurring', ranOut({ ...BASE, hasRecurring: false }).reason, 'no_recurring')
check('a booked future visit → has_upcoming', ranOut({ ...BASE, hasUpcoming: true }).reason, 'has_upcoming')
check('off-season → seasonally_dormant (dormant, not lost)', ranOut({ ...BASE, seasonallyDormant: true }).reason, 'seasonally_dormant')
check('never actually serviced → never_serviced (not a re-book)', ranOut({ ...BASE, lastServiceDate: null }).reason, 'never_serviced')
check('the ladder checks dormancy BEFORE never-serviced',
  ranOut({ ...BASE, seasonallyDormant: true, lastServiceDate: null }).reason, 'seasonally_dormant')
check('every non-ran-out verdict reports no urgency and no daysSince',
  ranOut({ ...BASE, hasUpcoming: true }), { isRanOut: false, isUrgent: false, daysSince: null, reason: 'has_upcoming' })

// ═══════════════════════════════════════════════════════════════════════════
H('4. RAN OUT — the urgency window: max(21 days, 3 cadences), inclusive edge')
check(`constants agree with the window math (${RANOUT_URGENT_MIN_DAYS}, ×${RANOUT_URGENT_CADENCES})`,
  { min: RANOUT_URGENT_MIN_DAYS, mult: RANOUT_URGENT_CADENCES }, { min: 21, mult: 3 })
check('weekly (7×3=21, floored at 21): day 21 is still urgent',
  ranOut({ ...BASE, today: '2026-06-22' }), { isRanOut: true, isUrgent: true, daysSince: 21, reason: 'ran_out' })
check('weekly: day 22 ages out of urgent (into the lapse buckets)',
  ranOut({ ...BASE, today: '2026-06-23' }), { isRanOut: true, isUrgent: false, daysSince: 22, reason: 'ran_out' })
check('monthly (30×3=90): day 90 urgent', ranOut({ ...BASE, cadenceDays: 30, today: '2026-08-30' }).isUrgent, true)
check('monthly: day 91 not urgent', ranOut({ ...BASE, cadenceDays: 30, today: '2026-08-31' }).isUrgent, false)
check('a FUTURE last-service date clamps daysSince to 0 rather than going negative',
  ranOut({ ...BASE, lastServiceDate: '2026-06-20' }), { isRanOut: true, isUrgent: true, daysSince: 0, reason: 'ran_out' })

// ═══════════════════════════════════════════════════════════════════════════
H('5. LAPSED — history, nothing booked, no active series (all three required)')
check('served before + nothing booked + no series → lapsed',
  isLapsed({ hasRecurring: false, hasUpcoming: false, completedVisits: 1 }), true)
check('an active series is never lapsed', isLapsed({ hasRecurring: true, hasUpcoming: false, completedVisits: 5 }), false)
check('a booked visit is never lapsed', isLapsed({ hasRecurring: false, hasUpcoming: true, completedVisits: 5 }), false)
check('no completed visits = a lead, not a lapse', isLapsed({ hasRecurring: false, hasUpcoming: false, completedVisits: 0 }), false)

// ═══════════════════════════════════════════════════════════════════════════
H('6. CHURN RISK — one threshold ladder (was four engines, four thresholds)')
check(`constants: warn ${CHURN_RATIO_WARN}, high ${CHURN_RATIO_HIGH}`,
  { warn: CHURN_RATIO_WARN, high: CHURN_RATIO_HIGH }, { warn: 1.25, high: 1.6 })
// Deliberate and easy to "fix" wrong: a customer with NO active series carries a
// 0.5 probability — HIGHER than an on-rhythm active customer's 0.2 — because no
// rhythm means no evidence either way; a coin flip, not confidence.
check('no active series → flat 0.5 (a coin flip, not confidence)',
  churnRisk({ hasActiveRecurring: false, daysSinceLastService: 100, cadenceDays: 7 }),
  { level: 'none', ratio: 0, probability: 0.5, overdueDays: null })
check('seasonally dormant → 0.2 (rhythm paused, not broken)',
  churnRisk({ hasActiveRecurring: true, daysSinceLastService: 100, cadenceDays: 7, seasonallyDormant: true }),
  { level: 'none', ratio: 0, probability: 0.2, overdueDays: null })
check('never serviced (null days) → 0.2, no ratio',
  churnRisk({ hasActiveRecurring: true, daysSinceLastService: null, cadenceDays: 7 }),
  { level: 'none', ratio: 0, probability: 0.2, overdueDays: null })
check('a zero cadence cannot divide → 0.2, no ratio',
  churnRisk({ hasActiveRecurring: true, daysSinceLastService: 10, cadenceDays: 0 }),
  { level: 'none', ratio: 0, probability: 0.2, overdueDays: null })
check('exactly on rhythm (ratio 1.0) → none, and overdueDays stays null',
  churnRisk({ hasActiveRecurring: true, daysSinceLastService: 7, cadenceDays: 7 }),
  { level: 'none', ratio: 1, probability: 0.2, overdueDays: null })
check('exactly at the warn ratio (1.25) → watch, overdueDays reported',
  churnRisk({ hasActiveRecurring: true, daysSinceLastService: 10, cadenceDays: 8 }),
  { level: 'watch', ratio: 1.25, probability: 0.4, overdueDays: 10 })
check('just under the warn ratio → still none',
  churnRisk({ hasActiveRecurring: true, daysSinceLastService: 87, cadenceDays: 70 }).level, 'none')
check('exactly at the high ratio (1.6) → high',
  churnRisk({ hasActiveRecurring: true, daysSinceLastService: 16, cadenceDays: 10 }),
  { level: 'high', ratio: 1.6, probability: 0.6, overdueDays: 16 })

// ═══════════════════════════════════════════════════════════════════════════
H('7. VALUE — one visit, one lifetime, one VIP line (was five disagreeing copies)')
const QUOTES = { q1: { weekly_price: 60, initial_price: 120, total: 500 } }
const RECS = { r1: { freq: 'weekly' } }
check('a job\'s own price wins over its quote', visitValue({ price: 80, quote_id: 'q1', recurrence_id: 'r1' }, QUOTES, RECS), 80)
check('no own price → the quote\'s recurring cadence price', visitValue({ price: null, quote_id: 'q1', recurrence_id: 'r1' }, QUOTES, RECS), 60)
// The exact bug this module fixed: the reactivation page ignored is_initial_visit,
// valuing an initial visit at the recurring rate there and the initial rate on the
// customer page — and LTV gates the VIP flag, so the SAME customer flipped VIP
// status between screens.
check('an INITIAL visit values at the initial price, not the recurring rate',
  visitValue({ price: null, quote_id: 'q1', recurrence_id: 'r1', is_initial_visit: true }, QUOTES, RECS), 120)
check('no price and no quote → 0, never invented money', visitValue({ price: null }, QUOTES, RECS), 0)
check('lifetime value sums every completed visit through the same engine (80+60+120)',
  lifetimeValue([
    { price: 80 },
    { price: null, quote_id: 'q1', recurrence_id: 'r1' },
    { price: null, quote_id: 'q1', recurrence_id: 'r1', is_initial_visit: true },
  ], QUOTES, RECS), 260)
check(`VIP at exactly the line (${VIP_LTV})`, isVip(VIP_LTV), true)
check('one dollar under the line is not a VIP', isVip(VIP_LTV - 1), false)

// ═══════════════════════════════════════════════════════════════════════════
H('8. DATE MATH — daysBetween is calendar days, signed')
check('forward 14 days', daysBetween('2026-06-01', '2026-06-15'), 14)
check('backward is negative', daysBetween('2026-06-15', '2026-06-01'), -14)
check('same day is 0', daysBetween('2026-06-15', '2026-06-15'), 0)
check('across a month boundary', daysBetween('2026-01-31', '2026-03-01'), 29)

// ═══════════════════════════════════════════════════════════════════════════
console.log(`\n${'═'.repeat(60)}\n  PASS ${pass}   FAIL ${fail}`)
if (fail > 0) process.exit(1)
