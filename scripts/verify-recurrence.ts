// ── Recurrence verification — npm run verify:recurrence ─────────────────────
//
// lib/recurrence.ts is the recurring-visit backbone: it materialises a series'
// visit dates, labels a cadence, resolves the Apple-style this/future/all scope,
// and assembles the at-a-glance Service Plan shown on customer/property pages.
// Every output is a DATE or a COUNT a human reads and books against — a
// regression is a wrong value, not a type error, so tsc and next build stay
// green while a customer's schedule (or the "next visit" a page promises) is
// silently wrong. Nothing exercised it.
//
// These are CHARACTERIZATION tests: the expected values were captured from the
// module itself (date-fns math and all), so they pin today's behaviour without
// changing a line of source — including the two behaviours most likely to
// surprise a future editor: monthly steps DRIFT off the 31st once they clamp to
// February, and `count: 0` / `end_count: 0` fall through to their defaults.
// Pure + deterministic, no I/O — same discipline as verify-onboarding /
// verify-sms-segments, runnable in CI beside them.

import {
  generateOccurrences, recurrenceLabel, recurringCustomerLabel,
  jobsInScope, shiftDate, dayDelta, buildServicePlans,
} from '../src/lib/recurrence'
import { DEFAULT_SEASONS } from '../src/lib/seasons'
import type { Job, JobRecurrence } from '../src/types'

let pass = 0
let fail = 0
function H(t: string) { console.log(`\n═══ ${t} ═══`) }
function check(name: string, actual: unknown, expected: unknown) {
  const a = JSON.stringify(actual); const e = JSON.stringify(expected)
  if (a === e) { pass++; console.log(`  ✅ ${name}`) }
  else { fail++; console.log(`  ❌ ${name}\n     expected: ${e}\n     actual:   ${a}`) }
}

// Minimal fixtures — only the fields recurrence.ts reads, cast to the full row
// shape the same way the other harnesses build partial states.
const job = (o: Partial<Job>): Job => ({
  id: 'x', recurrence_id: null, scheduled_date: '2026-01-01', status: 'scheduled',
  service_type: null, property_id: null, is_initial_visit: false, ...o,
} as unknown as Job)
const rec = (o: Partial<JobRecurrence>): JobRecurrence => ({
  id: 'r', created_at: '', user_id: 'u', freq: null, interval_unit: 'week',
  interval_count: 1, start_date: '2026-04-08', end_date: null, end_count: null,
  customer_id: null, ...o,
} as unknown as JobRecurrence)

// ═══════════════════════════════════════════════════════════════════════════
H('1. GENERATE OCCURRENCES — the three end modes')
check('end-after-N: 5 weekly visits from the start',
  generateOccurrences('2026-04-15', 'week', 1, null, 5),
  ['2026-04-15', '2026-04-22', '2026-04-29', '2026-05-06', '2026-05-13'])
check('end-date: stops at the last visit ON OR BEFORE the end date',
  generateOccurrences('2026-04-15', 'week', 1, '2026-05-01', null),
  ['2026-04-15', '2026-04-22', '2026-04-29'])
check('end-date landing exactly on a visit INCLUDES that visit (strict >)',
  generateOccurrences('2026-04-15', 'week', 1, '2026-04-29', null),
  ['2026-04-15', '2026-04-22', '2026-04-29'])
check('every-3-weeks respects the interval count',
  generateOccurrences('2026-04-15', 'week', 3, null, 4),
  ['2026-04-15', '2026-05-06', '2026-05-27', '2026-06-17'])

// ═══════════════════════════════════════════════════════════════════════════
H('2. GENERATE OCCURRENCES — the caps and the coercions (the surprises)')
check('open-ended (no end) pre-creates the rolling horizon of 26',
  generateOccurrences('2026-04-15', 'week', 1, null, null).length, 26)
check('a huge end-count is clamped to the hard cap of 260',
  generateOccurrences('2026-04-15', 'week', 1, null, 1000).length, 260)
check('end_count 0 is falsy → treated as open-ended (26), not zero visits',
  generateOccurrences('2026-04-15', 'week', 1, null, 0).length, 26)
check('count 0 is coerced to a step of 1 (never an infinite same-day loop)',
  generateOccurrences('2026-04-15', 'day', 0, null, 3),
  ['2026-04-15', '2026-04-16', '2026-04-17'])
// The behaviour a future editor is most likely to "fix" and break: monthly steps
// use addMonths, which CLAMPS Jan 31 → Feb 28, and every later step is measured
// from the CLAMPED date — so the series settles on the 28th instead of drifting
// back to the 31st. Pinned so the drift is a decision, not an accident.
check('monthly from the 31st clamps to Feb, then holds the 28th (does NOT return to 31)',
  generateOccurrences('2026-01-31', 'month', 1, null, 4),
  ['2026-01-31', '2026-02-28', '2026-03-28', '2026-04-28'])

// ═══════════════════════════════════════════════════════════════════════════
H('3. CADENCE LABELS — the named cadences and the generic fallback')
check('week ×1 → Weekly', recurrenceLabel('week', 1), 'Weekly')
check('week ×2 → Every 2 weeks', recurrenceLabel('week', 2), 'Every 2 weeks')
check('week ×3 → Every 3 weeks', recurrenceLabel('week', 3), 'Every 3 weeks')
check('month ×1 → Monthly', recurrenceLabel('month', 1), 'Monthly')
check('month ×2 → Every 2 months', recurrenceLabel('month', 2), 'Every 2 months')
check('day ×1 → Every day (singular)', recurrenceLabel('day', 1), 'Every day')
check('day ×10 → Every 10 days (plural)', recurrenceLabel('day', 10), 'Every 10 days')
// The freq fallback fires when unit/count are absent — including count 0, which is
// falsy, so a stored freq still names the cadence.
check('no unit/count → freq weekly', recurrenceLabel(null, null, 'weekly'), 'Weekly')
check('no unit/count → freq biweekly', recurrenceLabel(null, null, 'biweekly'), 'Every 2 weeks')
check('no unit/count → freq monthly', recurrenceLabel(null, null, 'monthly'), 'Monthly')
check('nothing known at all → Recurring', recurrenceLabel(null, null), 'Recurring')
check('count 0 is falsy → falls through to the freq label', recurrenceLabel('week', 0, 'monthly'), 'Monthly')

// ═══════════════════════════════════════════════════════════════════════════
H('4. CUSTOMER LABELS — only the three named cadences get a badge')
check('Weekly → Weekly Customer', recurringCustomerLabel('week', 1), 'Weekly Customer')
check('Every 2 weeks → Bi-Weekly Customer', recurringCustomerLabel('week', 2), 'Bi-Weekly Customer')
check('Monthly → Monthly Customer', recurringCustomerLabel('month', 1), 'Monthly Customer')
check('an off-cadence → Custom Schedule', recurringCustomerLabel('week', 3), 'Custom Schedule')
check('unknown → Custom Schedule', recurringCustomerLabel(null, null), 'Custom Schedule')

// ═══════════════════════════════════════════════════════════════════════════
H('5. SCOPE — this / future / all, relative to an anchor visit')
const anchor = job({ id: 'j2', recurrence_id: 'r1', scheduled_date: '2026-04-22' })
const allJobs = [
  job({ id: 'j1', recurrence_id: 'r1', scheduled_date: '2026-04-15' }),
  anchor,
  job({ id: 'j3', recurrence_id: 'r1', scheduled_date: '2026-04-29' }),
  job({ id: 'jX', recurrence_id: 'r9', scheduled_date: '2026-04-22' }), // other series
]
check('this → only the anchor', jobsInScope(anchor, allJobs, 'this').map(j => j.id), ['j2'])
check('future → the anchor and later visits in its series', jobsInScope(anchor, allJobs, 'future').map(j => j.id), ['j2', 'j3'])
check('all → every visit in the series (never another series)', jobsInScope(anchor, allJobs, 'all').map(j => j.id), ['j1', 'j2', 'j3'])
check('an anchor with no recurrence → just itself, whatever the scope',
  jobsInScope(job({ id: 'solo', recurrence_id: null, scheduled_date: '2026-04-22' }), allJobs, 'all').map(j => j.id), ['solo'])

// ═══════════════════════════════════════════════════════════════════════════
H('6. DATE ARITHMETIC — shiftDate / dayDelta across month and leap boundaries')
check('shift +7 days', shiftDate('2026-04-15', 7), '2026-04-22')
check('shift −1 day', shiftDate('2026-04-15', -1), '2026-04-14')
check('shift across a month end', shiftDate('2026-01-31', 1), '2026-02-01')
check('shift Feb 28 +1 in a non-leap year → Mar 1', shiftDate('2026-02-28', 1), '2026-03-01')
check('shift Feb 28 +1 in a leap year → Feb 29', shiftDate('2028-02-28', 1), '2028-02-29')
check('dayDelta forward is positive', dayDelta('2026-04-15', '2026-04-22'), 7)
check('dayDelta backward is negative', dayDelta('2026-04-22', '2026-04-15'), -7)
check('dayDelta of the same day is 0', dayDelta('2026-04-15', '2026-04-15'), 0)
check('dayDelta counts calendar days across a month boundary', dayDelta('2026-01-31', '2026-03-01'), 29)

// ═══════════════════════════════════════════════════════════════════════════
H('7. SERVICE PLANS — the at-a-glance summary of an active schedule')
const r1 = rec({ id: 'r1', start_date: '2026-04-08', end_date: '2026-06-30' })
const r2 = rec({ id: 'r2', start_date: '2026-03-01' })
const r3 = rec({ id: 'r3' }) // no jobs → must be skipped
const planJobs: Job[] = [
  job({ id: 'a1', recurrence_id: 'r1', scheduled_date: '2026-04-08', status: 'completed', service_type: 'Weekly Mowing', property_id: 'p1', is_initial_visit: true }),
  job({ id: 'a2', recurrence_id: 'r1', scheduled_date: '2026-04-15', status: 'completed', service_type: 'Weekly Mowing', property_id: 'p1' }),
  job({ id: 'a3', recurrence_id: 'r1', scheduled_date: '2026-04-22', status: 'scheduled', service_type: 'Weekly Mowing', property_id: 'p1' }),
  job({ id: 'a4', recurrence_id: 'r1', scheduled_date: '2026-04-29', status: 'scheduled', service_type: 'Weekly Mowing', property_id: 'p1' }),
  job({ id: 'b1', recurrence_id: 'r2', scheduled_date: '2026-03-01', status: 'completed', service_type: 'Handyman Repair', property_id: 'p2', is_initial_visit: true }),
]
const valueOf = (j: Job) => (j.is_initial_visit ? 120 : 60)
const plans = buildServicePlans([r1, r2, r3], planJobs, DEFAULT_SEASONS, '2026-04-20', valueOf)

check('a recurrence with zero jobs is skipped entirely', plans.map(p => p.recurrenceId), ['r1', 'r2'])
check('active plan sorts before paused (its two future visits vs none)',
  plans.map(p => ({ id: p.recurrenceId, paused: p.paused })),
  [{ id: 'r1', paused: false }, { id: 'r2', paused: true }])
check('the active plan is fully summarised', plans[0], {
  recurrenceId: 'r1', propertyId: 'p1', serviceName: 'Weekly Mowing', cadenceLabel: 'Weekly',
  weekday: 'Wednesdays', windowLabel: 'Apr 8 → Jun 30', remaining: 2, nextVisitDate: '2026-04-22',
  paused: false, initialPrice: 120, recurringPrice: 60,
})
check('the paused plan reports no future work and no next visit',
  { remaining: plans[1].remaining, next: plans[1].nextVisitDate, paused: plans[1].paused },
  { remaining: 0, next: null, paused: true })
check('a single initial-only visit has an initial price but no recurring price',
  { i: plans[1].initialPrice, r: plans[1].recurringPrice }, { i: 120, r: null })

// ═══════════════════════════════════════════════════════════════════════════
H('8. SERVICE PLANS — weekday consistency, window source, and prices')
// Weekday is reported only when it is actually consistent (≥60% of non-cancelled
// visits share it); a fixed-day route reads clean, a scattered schedule reads null.
const split = buildServicePlans(
  [rec({ id: 'r1', end_count: 5 })],
  [job({ id: 's1', recurrence_id: 'r1', scheduled_date: '2026-04-15', service_type: 'Mow' }),   // Wed
   job({ id: 's2', recurrence_id: 'r1', scheduled_date: '2026-04-17', service_type: 'Mow' })],  // Fri
  DEFAULT_SEASONS, '2026-04-10')
check('a 50/50 weekday split is below the 60% bar → no weekday claimed', split[0].weekday, null)
check('a count-limited series (end_count) has no calendar window', split[0].windowLabel, null)

const cancelled = buildServicePlans(
  [rec({ id: 'r1', end_count: 5 })],
  [job({ id: 'c1', recurrence_id: 'r1', scheduled_date: '2026-04-15', service_type: 'Mow' }),                       // Wed
   job({ id: 'c2', recurrence_id: 'r1', scheduled_date: '2026-04-22', service_type: 'Mow' }),                       // Wed
   job({ id: 'c3', recurrence_id: 'r1', scheduled_date: '2026-04-17', status: 'cancelled', service_type: 'Mow' })], // Fri, cancelled
  DEFAULT_SEASONS, '2026-04-10')
check('cancelled visits are excluded from the weekday tally', cancelled[0].weekday, 'Wednesdays')
check('without a valueOf, both prices are null (no invented money)',
  { i: cancelled[0].initialPrice, r: cancelled[0].recurringPrice }, { i: null, r: null })

// ═══════════════════════════════════════════════════════════════════════════
console.log(`\n${'═'.repeat(60)}\n  PASS ${pass}   FAIL ${fail}`)
if (fail > 0) process.exit(1)
