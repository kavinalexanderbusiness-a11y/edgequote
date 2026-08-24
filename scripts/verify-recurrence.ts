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

import { readFileSync } from 'node:fs'
import {
  generateOccurrences, recurrenceLabel, recurringCustomerLabel,
  jobsInScope, shiftDate, dayDelta, buildServicePlans, visitsBeyondEnd, planSeriesChange, recurrenceToUi, mayRemoveRecurrence,
  partitionSeriesVisits, planRecurrenceRemoval, reseedRepeatUi,
  scopeImpacts, OPEN_ENDED_HORIZON,
} from '../src/lib/recurrence'
import { HISTORY_TABLES } from '../src/lib/seriesHistory'
import { DEFAULT_SEASONS, DEFAULT_LAWN_SEASON, DEFAULT_SNOW_SEASON, seasonEndDateFor } from '../src/lib/seasons'
import { addDays, format, parseISO } from 'date-fns'
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
  status: 'active', paused: false, initialPrice: 120, recurringPrice: 60,
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
H('9. SEASON END — generation stops at the season cutoff (Session 39)')
// Season End is stored as a plain end_date resolved by seasonEndDateFor, so the
// whole contract is: resolver gives the right date, generator never steps past
// it, and the last valid day is INCLUDED. Pinned per cadence the UI offers.
const lawnEnd = seasonEndDateFor('2026-08-14', DEFAULT_LAWN_SEASON)
check('lawn season end for an Aug 14 series is Oct 31 of the SAME year', lawnEnd, '2026-10-31')
check('weekly stops at the cutoff — no November visit',
  generateOccurrences('2026-08-14', 'week', 1, lawnEnd, null).at(-1), '2026-10-30')
check('weekly landing EXACTLY on the season end keeps that final visit',
  generateOccurrences('2026-08-15', 'week', 1, lawnEnd, null).at(-1), '2026-10-31')
check('biweekly stops at the cutoff',
  generateOccurrences('2026-08-14', 'week', 2, lawnEnd, null),
  ['2026-08-14', '2026-08-28', '2026-09-11', '2026-09-25', '2026-10-09', '2026-10-23'])
check('monthly stops at the cutoff',
  generateOccurrences('2026-08-14', 'month', 1, lawnEnd, null),
  ['2026-08-14', '2026-09-14', '2026-10-14'])
check('nothing on/after Nov 1 in any cadence', [
  ...generateOccurrences('2026-08-14', 'week', 1, lawnEnd, null),
  ...generateOccurrences('2026-08-14', 'week', 2, lawnEnd, null),
  ...generateOccurrences('2026-08-14', 'month', 1, lawnEnd, null),
].filter(d => d > lawnEnd), [])
// Year semantics: the boundary is a month/day anchor, resolved against the
// series' start. A start after this year's end resolves to NEXT year's end
// (scheduling for next season), and the wrapping snow season crosses New Year.
check('a start past this year\'s lawn end resolves to NEXT year\'s Oct 31',
  seasonEndDateFor('2026-11-14', DEFAULT_LAWN_SEASON), '2027-10-31')
check('snow season starting Nov wraps to the FOLLOWING March',
  seasonEndDateFor('2026-11-15', DEFAULT_SNOW_SEASON), '2027-03-31')
check('snow season starting Jan ends THAT March',
  seasonEndDateFor('2027-01-10', DEFAULT_SNOW_SEASON), '2027-03-31')

// ═══════════════════════════════════════════════════════════════════════════
H('10. VISITS BEYOND END — the reconcile predicate (Session 39)')
// The predicate behind "saving Season End removes the ghost visits": only
// merely-scheduled, uninvoiced, non-anchor visits strictly past the end are
// removable. Everything else is history or someone's open editor.
const sv = (id: string, date: string, status = 'scheduled') => ({ id, scheduled_date: date, status })
const seasonSeries = [
  sv('past-done', '2026-07-02', 'completed'),
  sv('anchor', '2026-08-14'),
  sv('sep', '2026-09-19'),
  sv('on-end', '2026-10-31'),          // ON the end date — the season's last stop
  sv('ghost1', '2026-11-06'),          // strictly past — the production bug
  sv('ghost2', '2026-11-14'),
  sv('done-late', '2026-11-20', 'completed'),   // finished work is never a ghost
  sv('busy-late', '2026-11-21', 'in_progress'), // nor is work underway
  sv('gone-late', '2026-11-22', 'cancelled'),   // a called-off visit is a record
  sv('billed-late', '2026-11-28'),              // invoiced — protected below
]
check('removes exactly the scheduled ghosts past the end',
  visitsBeyondEnd(seasonSeries, '2026-10-31', { anchorId: 'anchor', protectedIds: new Set(['billed-late']) }),
  ['ghost1', 'ghost2'])
check('a visit ON the end date is the last legitimate stop, never removed',
  visitsBeyondEnd(seasonSeries, '2026-10-31').includes('on-end'), false)
check('completed / in-progress / cancelled visits are untouchable history',
  visitsBeyondEnd(seasonSeries, '2026-10-31').filter(id => ['done-late', 'busy-late', 'gone-late'].includes(id)), [])
check('an invoiced visit is protected even when scheduled past the end',
  visitsBeyondEnd(seasonSeries, '2026-10-31', { protectedIds: new Set(['billed-late']) }).includes('billed-late'), false)
check('the anchor (the visit under the open editor) is never removed',
  visitsBeyondEnd([sv('anchor', '2026-11-14')], '2026-10-31', { anchorId: 'anchor' }), [])
check('without an anchor exclusion the same late visit IS a ghost (guard is load-bearing)',
  visitsBeyondEnd([sv('anchor', '2026-11-14')], '2026-10-31'), ['anchor'])
check('no end date → nothing to reconcile (never-ending series are untouched)',
  visitsBeyondEnd(seasonSeries, null), [])
check('moving the end EARLIER reconciles more; the boundary stays exclusive',
  visitsBeyondEnd(seasonSeries, '2026-09-19', { anchorId: 'anchor', protectedIds: new Set(['billed-late']) }),
  ['on-end', 'ghost1', 'ghost2'])
check('moving the end LATER reconciles less',
  visitsBeyondEnd(seasonSeries, '2026-11-10', { anchorId: 'anchor', protectedIds: new Set(['billed-late']) }),
  ['ghost2'])

// ═══════════════════════════════════════════════════════════════════════════
H('11. RULE-CHANGE PLAN — "no future visits" is not the same as "no rule" (S39)')
// The production shape: an owner standing on a late-October visit picks
// "Season end". The rule has no visits AHEAD of that visit, and the save path
// used to read that as a broken rule and refuse — discarding the end rule while
// reporting the schedule "kept unchanged". Reopening still said "Never ends".
const T = '2026-08-13'
check('an end date with visits ahead regenerates the forward grid',
  planSeriesChange('2026-08-14', 'week', 1, '2026-10-31', null, T).kind, 'regenerate')
check('…and the grid stops at the last visit ON OR BEFORE the season end',
  (planSeriesChange('2026-08-14', 'week', 1, '2026-10-31', null, T) as { future: string[] }).future.slice(-1), ['2026-10-30'])
check('…with nothing at all in November',
  (planSeriesChange('2026-08-14', 'week', 1, '2026-10-31', null, T) as { future: string[] }).future.some(d => d >= '2026-11-01'), false)
check('an end date on the LAST visit ahead still regenerates',
  planSeriesChange('2026-10-21', 'week', 1, '2026-10-31', null, T).kind, 'regenerate')
check('an end date with nothing ahead ENDS the series — it does not reject',
  planSeriesChange('2026-10-28', 'week', 1, '2026-10-31', null, T).kind, 'end')
check('…and it ends at the OWNER\'S date, not the last generated visit',
  (planSeriesChange('2026-10-28', 'week', 1, '2026-10-31', null, T) as { cutoff: string }).cutoff, '2026-10-31')
check('standing exactly ON the season end also ends the series',
  planSeriesChange('2026-10-31', 'week', 1, '2026-10-31', null, T).kind, 'end')
check('a count-limited rule with nothing ahead ends at its last occurrence',
  (planSeriesChange('2026-10-28', 'week', 1, null, 1, T) as { cutoff: string }).cutoff, '2026-10-28')
check('an end date BEFORE the visit is a broken rule — reject, keep the schedule',
  planSeriesChange('2026-10-28', 'week', 1, '2026-09-01', null, T),
  { kind: 'reject', reason: 'no-occurrences' })
check('an END-LESS rule that yields nothing forward is still rejected',
  planSeriesChange('2020-01-01', 'week', 1, null, null, T),
  { kind: 'reject', reason: 'no-future' })
check('biweekly ends the same way', planSeriesChange('2026-10-24', 'week', 2, '2026-10-31', null, T).kind, 'end')
check('monthly ends the same way', planSeriesChange('2026-10-15', 'month', 1, '2026-10-31', null, T).kind, 'end')

H('12. SEASON END BELONGS TO THE SERIES, not the visit under the editor (S39)')
// An open-ended series pre-creates a rolling horizon, so visits PAST the season
// end already sit on the calendar. Resolving "Season end" from the open visit
// made a November visit answer "next year's Oct 31" — a full extra season, and
// no cutoff at all. Anchoring on job_recurrences.start_date makes every visit
// in a series agree, and agrees with lib/suggestions, which already resolves
// the season end from the series START.
const seriesStart = '2026-06-19'
const seriesLawnEnd = seasonEndDateFor(seriesStart, DEFAULT_SEASONS.lawn)
check('the series resolves to this season\'s end', seriesLawnEnd, '2026-10-31')
check('every visit in the series agrees when anchored on the series start',
  ['2026-08-14', '2026-10-31', '2026-11-06', '2026-12-18']
    .map(() => seasonEndDateFor(seriesStart, DEFAULT_SEASONS.lawn)),
  ['2026-10-31', '2026-10-31', '2026-10-31', '2026-10-31'])
check('the OLD visit-anchored reading disagreed past the end (why this exists)',
  seasonEndDateFor('2026-11-25', DEFAULT_SEASONS.lawn), '2027-10-31')
check('…and that reading left the series with no 2026 cutoff whatsoever',
  generateOccurrences(seriesStart, 'week', 1, seasonEndDateFor('2026-11-25', DEFAULT_SEASONS.lawn), null).length > 60, true)
check('the series-anchored end DOES cut the series at the season',
  generateOccurrences(seriesStart, 'week', 1, lawnEnd, null).slice(-1), ['2026-10-30'])

// ═══════════════════════════════════════════════════════════════════════════
H('13. AN UNLOADED SERIES IS NOT AN EMPTY ONE (Session 39 incident)')
// The schedule page opens its editor from a ?focus= deep link as soon as `jobs`
// arrives, which can beat the `recurrences` read. JobForm seeds its Repeat
// controls from initialRecurrence in useState initializers — read ONCE — so a
// recurring job rendered as "Does not repeat" and stayed that way. Saving that
// took the form at its word: removeRecurrence(scope 'all') deleted every
// sibling visit and the series row. It destroyed 67 real visits before this
// guard existed. Both halves are pinned: the page must not treat a missing
// snapshot as "no recurrence", and recurrenceToUi must round-trip a real one.
const loadedSeries: Record<string, unknown> = { r1: { unit: 'week', count: 1 } }
check('a job whose series HAS loaded may be un-recurred', mayRemoveRecurrence('r1', loadedSeries), true)
check('a job whose series has NOT loaded may not — silence is not consent',
  mayRemoveRecurrence('r-not-loaded', loadedSeries), false)
check('a genuinely one-time job is always safe to save', mayRemoveRecurrence(null, loadedSeries), true)
// The round-trip the late re-seed depends on: a loaded series must map back to
// a repeating preset, never to 'none'.
check('a weekly series maps back to a REPEATING preset, never "none"',
  recurrenceToUi({ unit: 'week', count: 1, endDate: null, endCount: null }).preset, 'w1')
check('a biweekly series too', recurrenceToUi({ unit: 'week', count: 2, endDate: null, endCount: null }).preset, 'w2')
check('a season-ended series round-trips its end date',
  recurrenceToUi({ unit: 'week', count: 1, endDate: '2026-10-31', endCount: null }).endDate, '2026-10-31')
check('only a genuinely absent series reads as "does not repeat"',
  recurrenceToUi(undefined).preset, 'none')

// ═══════════════════════════════════════════════════════════════════════════
H('14. THE SLOW-LOAD SEQUENCE, REPLAYED STEP BY STEP (Session 56)')
// The production failure was not a wrong value, it was an ORDER of events. So
// this replays that order against the real functions the editor and the save
// path use, and asserts what each of them answers at each step. Every step is
// deterministic: no clock, no network, no DOM.
//
//   t0  the job arrives and the editor opens (?focus= deep link)
//   t1  the owner changes something unrelated — a price, a crew size — and
//       saves. They have not been near the Repeat control.
//   t2  the series snapshot finally arrives
//   t3  the editor re-seeds and now shows the truth
//
// The series being destroyed: a weekly mow, the shape of the one that lost 67
// visits.
const lateSeries = { unit: 'week' as const, count: 1, endDate: '2026-10-31', endCount: null }

// t0 — the editor seeds from a prop that is not there yet.
const t0 = recurrenceToUi(undefined)
check('t0: with no series loaded the control reads "Does not repeat"', t0.preset, 'none')
check('t0: nothing has been touched, so nothing is asserted',
  reseedRepeatUi(undefined, { repeat: false, end: false }), {})

// t1 — THE MOMENT THAT DESTROYED THE DATA. The form says "does not repeat" and
// means nothing by it. Two independent refusals, either of which is enough.
const t1 = planRecurrenceRemoval('rec-weekly', {}, /* repeatAsserted */ false)
check('t1: an untouched save cannot remove a series that never loaded',
  t1, { kind: 'refuse', reason: 'series-not-loaded' })
check('t1: …and it still cannot once the snapshot IS there — untouched is not intent',
  planRecurrenceRemoval('rec-weekly', { 'rec-weekly': lateSeries }, false),
  { kind: 'refuse', reason: 'repeat-untouched' })
check('t1: the reason is reported, so the page can say the right thing',
  t1.kind === 'refuse' && t1.reason, 'series-not-loaded')

// t2/t3 — the snapshot lands and the untouched controls follow it.
const t3 = reseedRepeatUi(lateSeries, { repeat: false, end: false })
check('t3: the control re-seeds to the TRUE cadence, not "Does not repeat"', t3.repeat?.preset, 'w1')
check('t3: and to the series\' own end date', t3.end?.endDate, '2026-10-31')
check('t3: which is a specific-date end mode, not "never"', t3.end?.endMode, 'on')
// The whole point of the touched flags: a deliberate choice outranks a late prop.
check('a deliberate "Does not repeat" is NEVER overwritten by a late series',
  reseedRepeatUi(lateSeries, { repeat: true, end: false }).repeat, undefined)
check('…and a hand-picked end date is not overwritten either',
  reseedRepeatUi(lateSeries, { repeat: false, end: true }).end, undefined)
check('an owner who DID choose "does not repeat" is obeyed',
  planRecurrenceRemoval('rec-weekly', { 'rec-weekly': lateSeries }, true), { kind: 'remove' })
check('a one-time job needs no permission slip',
  planRecurrenceRemoval(null, {}, false), { kind: 'remove' })

// ═══════════════════════════════════════════════════════════════════════════
H('15. WHAT A RECURRENCE EDIT MAY DESTROY — one predicate, history-safe')
// Deleting a visit is not a soft act: job_work_sessions, crew_media,
// job_line_items and change_orders CASCADE away with it, and its invoice,
// photos, expenses and time entries are orphaned. So only a bare future
// placeholder is replaceable. The series below is the incident's own shape —
// history, today's work, and ghosts, all in one series.
const TODAY = '2026-08-14'
const mixed = [
  { id: 'anchor', scheduled_date: '2026-08-14', status: 'scheduled' },
  { id: 'past-done', scheduled_date: '2026-07-02', status: 'completed' },
  { id: 'past-open', scheduled_date: '2026-07-09', status: 'scheduled' },   // never worked, still the past
  { id: 'live', scheduled_date: '2026-08-14', status: 'in_progress' },
  { id: 'called-off', scheduled_date: '2026-08-21', status: 'cancelled' },
  { id: 'billed', scheduled_date: '2026-08-28', status: 'scheduled' },      // invoice-linked
  { id: 'worked', scheduled_date: '2026-09-04', status: 'scheduled', actual_minutes: 45 },
  { id: 'ghost-1', scheduled_date: '2026-11-06', status: 'scheduled' },
  { id: 'ghost-2', scheduled_date: '2026-11-14', status: 'scheduled' },
]
const part = partitionSeriesVisits(mixed, {
  anchorId: 'anchor', protectedIds: new Set(['billed']), todayISO: TODAY,
})
check('only the bare future placeholders are replaceable',
  part.replaceable.map(j => j.id), ['ghost-1', 'ghost-2'])
check('completed, in-progress and cancelled visits are spared',
  part.preserved.map(j => j.id).filter(id => ['live', 'called-off'].includes(id)), ['live', 'called-off'])
check('an invoice-linked visit is spared', part.preserved.some(j => j.id === 'billed'), true)
check('a visit carrying logged time is spared — status alone is not the test',
  part.preserved.some(j => j.id === 'worked'), true)
check('the past is out of the window entirely, worked or not',
  part.untouched.map(j => j.id), ['past-done', 'past-open'])
check('the anchor under the editor is in neither list',
  [...part.replaceable, ...part.preserved, ...part.untouched].some(j => j.id === 'anchor'), false)
check('nothing is lost between the three groups',
  part.replaceable.length + part.preserved.length + part.untouched.length, mixed.length - 1)
// Zero minutes is not "some time logged" — an untouched placeholder still is one.
check('actual_minutes 0 / null does not protect a placeholder',
  partitionSeriesVisits([
    { id: 'z', scheduled_date: '2026-11-06', status: 'scheduled', actual_minutes: 0 },
    { id: 'n', scheduled_date: '2026-11-07', status: 'scheduled', actual_minutes: null },
  ], { todayISO: TODAY }).replaceable.map(j => j.id), ['z', 'n'])
// The end-date predicate is the same engine, so it inherits every protection.
check('visitsBeyondEnd names only the ghosts past the end',
  visitsBeyondEnd(mixed, '2026-10-31', { anchorId: 'anchor', protectedIds: new Set(['billed']) }),
  ['ghost-1', 'ghost-2'])
check('…and it inherits the logged-time protection from the same engine',
  visitsBeyondEnd([{ id: 'w', scheduled_date: '2026-11-06', status: 'scheduled', actual_minutes: 30 }], '2026-10-31'),
  [])
check('a series with no end has no ghosts, by construction', visitsBeyondEnd(mixed, null), [])

// ═══════════════════════════════════════════════════════════════════════════
H('16. THE PROTECTIONS ARE ACTUALLY WIRED IN (not just importable)')
// §14 and §15 pin the rules; these pin that the surfaces still CALL them. A
// mutation that deletes the re-seed effect, or the removal guard, or the
// row-count checks leaves every pure test above green. Comments are stripped
// first — a rule must not be satisfiable by a sentence about the rule.
const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
const formSrc = strip(readFileSync(new URL('../src/components/schedule/JobForm.tsx', import.meta.url), 'utf8'))
const pageSrc = strip(readFileSync(new URL('../src/app/dashboard/schedule/page.tsx', import.meta.url), 'utf8'))
const histSrc = strip(readFileSync(new URL('../src/lib/seriesHistory.ts', import.meta.url), 'utf8'))

check('the editor re-seeds through reseedRepeatUi', /reseedRepeatUi\(/.test(formSrc), true)
check('…inside an effect, so a LATE series still reaches the controls',
  /useEffect\(\(\)\s*=>\s*\{[\s\S]{0,400}?reseedRepeatUi\(/.test(formSrc), true)
// Both branches of buildRecurrence, because the destructive one is the `unit:
// null` return — a flag hard-coded true THERE is the whole guard undone.
check('…and it reports whether Repeat was touched this session, on both branches',
  (formSrc.match(/repeatAsserted:\s*repeatTouched\.current/g) || []).length >= 2, true)
check('…never as a constant the save cannot disbelieve',
  /repeatAsserted:\s*(true|false)/.test(formSrc), false)
// S81 centralized the marking: every control calls markRepeatTouched(), and the
// helper is the ONE place the intent ref and the dirty state flip together (so
// the save's repeatAsserted and the discard guard can never disagree). The rule
// is unchanged — five control sites must mark — the pin just follows the calls.
check('every Repeat control marks the flag (select, custom count, custom unit, chips, one-time)',
  (formSrc.match(/(?<!function )markRepeatTouched\(\)/g) || []).length >= 5, true)
check('…and the helper actually sets the intent ref the save reads',
  /function markRepeatTouched\(\) \{ repeatTouched\.current = true; setRecDirty\(true\) \}/.test(formSrc), true)
check('Season End anchors on the SERIES start, falling back to the visit',
  /seriesStartDate\s*\|\|\s*scheduledDate/.test(formSrc), true)
check('the save routes removal through planRecurrenceRemoval', /planRecurrenceRemoval\(/.test(pageSrc), true)
check('…passing the owner-intent flag, not a constant',
  /planRecurrenceRemoval\([^)]*recurrence\.repeatAsserted/.test(pageSrc), true)
check('…and refuses on either answer', /decision\.kind === 'refuse'/.test(pageSrc), true)
check('the destructive paths partition the series instead of taking all siblings',
  (pageSrc.match(/partitionSeriesVisits\(/g) || []).length >= 2, true)
check('…from a FRESH read, not the page\'s in-memory jobs',
  /readSeriesForEdit\([^)]*\)/.test(pageSrc) && /from\('jobs'\)\s*\n?\s*\.select\('id, scheduled_date, status, actual_minutes'\)/.test(pageSrc), true)
check('…with history read from the database first',
  /loadVisitEncumbrances\(/.test(pageSrc), true)
check('an incomplete history read blocks the edit', /if \(!enc\.complete\)/.test(pageSrc), true)
check('every history table a delete would cascade or orphan is checked',
  HISTORY_TABLES.length >= 8 && ['invoices', 'job_work_sessions', 'crew_media', 'job_photos', 'job_line_items', 'change_orders', 'expenses', 'time_entries']
    .every(t => (HISTORY_TABLES as readonly string[]).includes(t)), true)
check('…and the reader fails CLOSED on a failed table read',
  /complete:\s*failed\.size === 0/.test(histSrc), true)
// Write honesty. Ending a series takes up to four writes and each one must
// prove it landed — asserted PER WRITE, by count, because a single "somewhere
// in this file there is a row check" is satisfied by a sibling block while the
// mutated one sails through. That is exactly how mutation 6 first survived.
check('every write in the removal path asks for its rows back',
  (pageSrc.match(/\.select\('id'\)/g) || []).length >= 4, true)
check('both single-row detaches treat zero rows as failure (this AND future scope)',
  (pageSrc.match(/\|\| !data \|\| data\.length === 0/g) || []).length >= 2, true)
check('the placeholder delete is counted against the ids it asked for',
  /!==\s*removeIds\.length/.test(pageSrc), true)
check('…so is the bulk detach, which the FK would otherwise do silently',
  /!==\s*detachIds\.length/.test(pageSrc), true)
check('…and dropping the rule itself is not assumed either',
  /!recGone \|\| recGone\.length === 0/.test(pageSrc), true)
H('17. PLAN STATUS — four situations that used to be one word')
// `paused` was a single boolean over a delivered package, an out-of-season
// series, an exhausted horizon and a deliberately-cleared schedule. Every
// surface rendered them identically ("Paused · schedule it again to resume"),
// and the portal told the customer "No visits booked" for all four — including
// the one where the truth is "your plan is complete". Each must now say WHY,
// and dormancy must come from signals/lifecycle rather than a second rule.
const PLAN_TODAY = '2026-08-13' // in lawn season, out of snow season
const planOf = (r: JobRecurrence, js: Job[]) => buildServicePlans([r], js, DEFAULT_SEASONS, PLAN_TODAY)[0]

const endedPlan = planOf(
  rec({ id: 'e', start_date: '2026-05-06', end_date: '2026-07-08' }),
  ['2026-05-06', '2026-06-10', '2026-07-08'].map((d, i) =>
    job({ id: 'e' + i, recurrence_id: 'e', scheduled_date: d, status: 'completed', service_type: 'Weekly Mowing' })))
check('end date passed → ended (not "paused")', endedPlan.status, 'ended')

const dormantPlan = planOf(
  rec({ id: 'd', start_date: '2026-01-07' }),
  ['2026-01-07', '2026-03-04'].map((d, i) =>
    job({ id: 'd' + i, recurrence_id: 'd', scheduled_date: d, status: 'completed', service_type: 'Snow Removal' })))
check('snow series in August → dormant, via the lifecycle detector', dormantPlan.status, 'dormant')

const ranDryPlan = planOf(
  rec({ id: 'x', start_date: '2026-02-11' }), // open-ended: no end_date, no end_count
  ['2026-07-29', '2026-08-12'].map((d, i) =>
    job({ id: 'x' + i, recurrence_id: 'x', scheduled_date: d, status: 'completed', service_type: 'Weekly Cleaning' })))
check('open-ended series with nothing left → ran_dry', ranDryPlan.status, 'ran_dry')

const cancelledPlan = planOf(
  rec({ id: 'c', start_date: '2026-06-03' }),
  [job({ id: 'c0', recurrence_id: 'c', scheduled_date: '2026-08-05', status: 'completed', service_type: 'Weekly Cleaning' }),
   job({ id: 'c1', recurrence_id: 'c', scheduled_date: '2026-08-19', status: 'cancelled', service_type: 'Weekly Cleaning' })])
check('upcoming visits cancelled → cancelled_ahead', cancelledPlan.status, 'cancelled_ahead')

const activePlan = planOf(
  rec({ id: 'a', start_date: '2026-06-03' }),
  [job({ id: 'a0', recurrence_id: 'a', scheduled_date: '2026-08-05', status: 'completed', service_type: 'Weekly Cleaning' }),
   job({ id: 'a1', recurrence_id: 'a', scheduled_date: '2026-08-19', status: 'scheduled', service_type: 'Weekly Cleaning' })])
check('a future visit booked → active', activePlan.status, 'active')

// A count-limited package that delivered every visit is ended, not ran_dry —
// the rule, not the empty calendar, is what says so.
const countDone = planOf(
  rec({ id: 'n', start_date: '2026-06-03', end_count: 2 }),
  ['2026-06-03', '2026-06-10'].map((d, i) =>
    job({ id: 'n' + i, recurrence_id: 'n', scheduled_date: d, status: 'completed', service_type: 'Weekly Cleaning' })))
check('all N of an end_count package delivered → ended', countDone.status, 'ended')

// The alias every un-migrated caller still reads must stay exactly "not active".
check('paused is the alias of "not active" — for all five statuses',
  [activePlan, endedPlan, dormantPlan, cancelledPlan, ranDryPlan].map(p => p.paused === (p.status !== 'active')),
  [true, true, true, true, true])
check('an active plan is never paused', activePlan.paused, false)

// ═══════════════════════════════════════════════════════════════════════════
H('18. SCOPE IMPACT — what the chooser must say before it is obeyed')
// "All visits" was a bare label on a mutation that hard-deletes completed work.
// The counts come from jobsInScope — THE predicate the mutation runs — so a
// label can never promise a different reach than the write.
const season: Job[] = []
for (let i = 0; i < 23; i++) {
  const d = format(addDays(parseISO('2026-05-06'), i * 7), 'yyyy-MM-dd')
  season.push(job({ id: `s${i}`, recurrence_id: 'r1', scheduled_date: d, status: d < PLAN_TODAY ? 'completed' : 'scheduled' }))
}
const seasonAnchor = season.find(j => j.scheduled_date >= PLAN_TODAY)!
const impacts = scopeImpacts(seasonAnchor, season)
const byScope = (s: string) => impacts.find(i => i.scope === s)!
check('15 completed + 8 booked is the fixture we reason about',
  { done: season.filter(j => j.status === 'completed').length, booked: season.filter(j => j.status === 'scheduled').length },
  { done: 15, booked: 8 })
check('this → one visit, no history touched',
  { label: byScope('this').label, total: byScope('this').total, note: byScope('this').historyNote },
  { label: 'This visit only', total: 1, note: null })
check('future → names the number of later visits, and touches no history',
  { label: byScope('future').label, total: byScope('future').total, note: byScope('future').historyNote },
  { label: 'This and 7 later visits', total: 8, note: null })
check('all → names the total AND the completed work it destroys',
  { label: byScope('all').label, total: byScope('all').total, note: byScope('all').historyNote },
  { label: 'All 23 visits', total: 23, note: 'includes 15 completed' })
// The counts must track jobsInScope exactly — this is the whole safety property.
check('every impact total equals jobsInScope for that scope',
  impacts.map(i => i.total === jobsInScope(seasonAnchor, season, i.scope).length), [true, true, true])
// Deleting a single completed visit is still destroying history — the anchor counts.
const doneAnchor = season[0]
check('a completed anchor reports its own history under "this"',
  scopeImpacts(doneAnchor, season).find(i => i.scope === 'this')!.historyNote, 'includes 1 completed')
// In-progress work is history too, and is named separately from completed.
const withLive = [
  job({ id: 'L1', recurrence_id: 'r2', scheduled_date: '2026-08-05', status: 'completed' }),
  job({ id: 'L2', recurrence_id: 'r2', scheduled_date: '2026-08-13', status: 'in_progress' }),
  job({ id: 'L3', recurrence_id: 'r2', scheduled_date: '2026-08-20', status: 'scheduled' }),
]
check('completed AND in-progress are both named',
  scopeImpacts(withLive[0], withLive).find(i => i.scope === 'all')!.historyNote,
  'includes 1 completed and 1 in progress')
// A one-time job has no series: every scope is itself, and "all" must not claim more.
check('a non-recurring job reports one visit under every scope',
  scopeImpacts(job({ id: 'solo', recurrence_id: null, scheduled_date: '2026-08-20' }), season).map(i => i.total),
  [1, 1, 1])
// A series with no later visits must not offer "This and 0 later visits".
const lastOne = [job({ id: 'z', recurrence_id: 'r3', scheduled_date: '2026-08-20', status: 'scheduled' })]
check('no later visits → the future option says so plainly',
  scopeImpacts(lastOne[0], lastOne).find(i => i.scope === 'future')!.label, 'This visit — none later')

// ═══════════════════════════════════════════════════════════════════════════
H('19. THE OPEN-ENDED HORIZON IS A NUMBER THE FORM MUST SAY')
// "no end date (kept rolling on your calendar)" promised a top-up that does not
// exist: the series materialises this many visits ONCE and then goes quiet.
check('the horizon constant is exported for the copy to read', OPEN_ENDED_HORIZON, 26)
check('an open-ended series generates exactly the horizon, and no more',
  generateOccurrences('2026-04-15', 'week', 1, null, null).length, OPEN_ENDED_HORIZON)

console.log(`\n${'═'.repeat(60)}\n  PASS ${pass}   FAIL ${fail}`)
if (fail > 0) process.exit(1)
