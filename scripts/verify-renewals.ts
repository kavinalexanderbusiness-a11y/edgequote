// ── Renewals & reactivation verification — npm run verify:renewals ───────────
//
// This feature's whole value is a REFUSAL: when a customer's plan ends, EdgeQuote
// offers to renew it and does NOT quietly put next year on the calendar. That
// refusal is invisible to tsc, to lint and to a screenshot — a regression here
// looks like a working feature right up until an owner discovers 26 visits and a
// season of draft invoices for a customer who never agreed to any of it.
//
// So this guard pins the six claims the feature makes:
//
//   1. Historical plans remain intact — a renewal writes NEW rows and never
//      edits, ends or deletes the plan it renews.
//   2. No recurrence without approval — every visit-creating path is behind an
//      explicit owner action, and the renewal path additionally requires an
//      ACCEPTED quote that names the plan.
//   3. Dormant ≠ lost — a customer between seasons or on a finished plan is
//      reported with a reason and is NOT counted as at-risk.
//   4. Intentionally ended ≠ urgent — cancelled or term-completed work never
//      enters the red re-book queue.
//   5. Universal semantics — nothing in the engines names a trade.
//   6. Tenant isolation — every read is user-scoped and the renewal link is a
//      COMPOSITE foreign key, so a plan id from another tenant is refused by
//      the database rather than by a component.
//
// Pure + deterministic: fixtures in memory, source read from disk, no network,
// no database, no clock (today is passed in everywhere by design).

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import type { RenewalStage } from '../src/lib/renewals'

// createElement rather than JSX, and React on the global BEFORE the component is
// required: this file runs under the app's tsconfig (`jsx: preserve`), so tsx
// leaves the component's JSX as bare `React.createElement(...)` with no import.
// Next supplies that scope; a plain tsx process does not. Same preamble
// verify:team and verify:mobile-shell use.
const React = require('react') as typeof import('react')
;(globalThis as Record<string, unknown>).React = React
const { renderToStaticMarkup } = require('react-dom/server') as typeof import('react-dom/server')
const { RowAction } = require('../src/components/grow/RenewalQueue') as typeof import('../src/components/grow/RenewalQueue')
import { computeRenewals, loadRenewals, renewalStageFor, type RnJob, type RnQuote, type RnRecurrence } from '../src/lib/renewals'
import { computeReactivation, loadReactivation, type RJob, type RQuote, type RRecurrence } from '../src/lib/reactivation'
import { planRenewal, ranOut, renewalDue, renewalLeadDays } from '../src/lib/signals'
import { DEFAULT_SEASONS, type ServiceSeasons, SEASON_NONE } from '../src/lib/seasons'

let pass = 0
let fail = 0
function H(t: string) { console.log(`\n═══ ${t} ═══`) }
function check(name: string, actual: unknown, expected: unknown) {
  const a = JSON.stringify(actual); const e = JSON.stringify(expected)
  if (a === e) { pass++; console.log(`  ✅ ${name}`) }
  else { fail++; console.log(`  ❌ ${name}\n     expected: ${e}\n     actual:   ${a}`) }
}
function ok(name: string, cond: boolean, detail = '') {
  if (cond) { pass++; console.log(`  ✅ ${name}`) }
  else { fail++; console.log(`  ❌ ${name}${detail ? `\n     ${detail}` : ''}`) }
}

const ROOT = process.cwd()
const read = (p: string) => readFileSync(join(ROOT, p), 'utf8')
// CRLF disarms `.*$` strippers — `.` does not match `\r`. Normalise first.
const src = (p: string) => read(p).replace(/\r\n/g, '\n')
const stripComments = (s: string) =>
  s.replace(/\{\/\*[\s\S]*?\*\/\}/g, '').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')

// ═══════════════════════════════════════════════════════════════════════════
H('1. THE ASKING WINDOW — a fraction of the cycle, clamped to human bounds')
// One sixth of a cycle, never under a week, never over two months. Same number
// either side of the rollover.
check('a year-long cycle asks two months out (clamped from 61)', renewalLeadDays(365), 60)
check('a season is the same', renewalLeadDays(365), renewalLeadDays(366 - 1))
check('a 90-day quarterly round asks 15 days out', renewalLeadDays(90), 15)
check('a 28-day block asks a week out (clamped up from 5)', renewalLeadDays(28), 7)
check('a 7-day cycle still asks a week out — the floor', renewalLeadDays(7), 7)
check('a nonsense cycle of 0 falls to the floor, never 0', renewalLeadDays(0), 7)

// ═══════════════════════════════════════════════════════════════════════════
H('2. RENEWAL DUE — the seven verdicts')
const base = {
  servedVisits: 20,
  planEndDate: '2026-10-31',
  hasPlannedEnd: true,
  customerHasFutureVisit: false,
  endedByCancellation: false,
  nextCycleStart: '2027-04-15',
  cycleDays: 365,
} as const

check('60 days before the next cycle → DUE (the edge is inclusive)',
  renewalDue({ ...base, today: '2027-02-14' }).reason, 'renewal_due')
check('61 days before → too early, and it says how far off',
  renewalDue({ ...base, today: '2027-02-13' }).isDue, false)
check('61 days before names the reason',
  renewalDue({ ...base, today: '2027-02-13' }).reason, 'too_early')
check('60 days AFTER the cycle started → still due (symmetric window)',
  renewalDue({ ...base, today: '2027-06-14' }).reason, 'renewal_due')
check('61 days after → too late; the lapse buckets describe them better',
  renewalDue({ ...base, today: '2027-06-15' }).reason, 'too_late')
check('a plan that never delivered anything is not a renewal',
  renewalDue({ ...base, servedVisits: 0, today: '2027-03-01' }).reason, 'never_served')
check('⛔ cancelled remainder = a DECISION, never an opportunity',
  renewalDue({ ...base, endedByCancellation: true, today: '2027-03-01' }).reason, 'ended_deliberately')
check('already booked → the question is answered',
  renewalDue({ ...base, customerHasFutureVisit: true, today: '2027-03-01' }).reason, 'already_booked')
check('no ending given → ranOut’s question, not this one',
  renewalDue({ ...base, hasPlannedEnd: false, today: '2027-03-01' }).reason, 'no_planned_end')
check('before its last visit it reads as ENDING, not ended',
  renewalDue({ ...base, planEndDate: '2027-05-01', nextCycleStart: '2027-05-02', cycleDays: 365, today: '2027-04-01' }).stage, 'ending')
check('after its last visit it reads as ENDED',
  renewalDue({ ...base, today: '2027-03-01' }).stage, 'ended')

// ═══════════════════════════════════════════════════════════════════════════
H('3. UNIVERSAL SEMANTICS — the same shape, six trades, one verdict')
// A plan that ran a season and stopped, in six businesses that share no
// vocabulary. Each owner declares their own season through the SAME jsonb the
// settings screen writes. If any of these disagreed, the engine would be
// encoding an industry.
const seasonsFor = (label: string, match: string[], sm: number, sd: number, em: number, ed: number): ServiceSeasons => ({
  ...DEFAULT_SEASONS,
  [label.toLowerCase()]: { startMonth: sm, startDay: sd, endMonth: em, endDay: ed, label, match },
});

{
  // Each plan runs INSIDE its own trade's season and stops when that season
  // closes — the shape this feature is about. `today` sits in the asking window
  // before the next opening, wherever that falls on the calendar. Two of these
  // seasons WRAP the new year (a snow season, a lighting season), which is the
  // case a naive month comparison gets wrong.
  // ⭐⭐ EACH TRADE DECLARES A SEASON KEY (S110). `service` is now a LABEL for the
  // test output only — the engine is handed `key`, the season the series declares.
  // `seasonsFor(label,…)` stores the season under label.toLowerCase(), so that is
  // the key. Feeding the service NAME here is precisely the defect this lane
  // removed, and verify:season-recurrence fails if any src/ call site does it.
  const trades: {
    service: string; key: string; seasons: ServiceSeasons
    visits: string[]; today: string; nextStart: string
  }[] = [
    { service: 'Weekly Mowing', key: 'lawn', seasons: DEFAULT_SEASONS,
      visits: ['2026-05-01', '2026-06-01', '2026-10-20'], today: '2027-03-01', nextStart: '2027-04-15' },
    { service: 'Snow Clearing', key: 'snow', seasons: DEFAULT_SEASONS,
      visits: ['2025-12-01', '2026-01-15', '2026-03-20'], today: '2026-10-01', nextStart: '2026-11-01' },
    { service: 'Pool Opening', key: 'pool', seasons: seasonsFor('Pool', ['pool'], 5, 1, 9, 30),
      visits: ['2026-05-10', '2026-07-01', '2026-09-20'], today: '2027-04-01', nextStart: '2027-05-01' },
    { service: 'Pest Control Round', key: 'pest', seasons: seasonsFor('Pest', ['pest'], 4, 1, 9, 15),
      visits: ['2026-04-10', '2026-06-10', '2026-09-10'], today: '2027-03-05', nextStart: '2027-04-01' },
    { service: 'Holiday Lighting', key: 'lights', seasons: seasonsFor('Lights', ['holiday', 'light'], 11, 1, 1, 15),
      visits: ['2025-11-10', '2025-12-10', '2026-01-10'], today: '2026-10-05', nextStart: '2026-11-01' },
    { service: 'Furnace Tune-Up', key: 'heating', seasons: seasonsFor('Heating', ['furnace', 'heating'], 9, 1, 2, 28),
      visits: ['2025-09-15', '2025-11-15', '2026-02-01'], today: '2026-08-01', nextStart: '2026-09-01' },
  ]
  for (const t of trades) {
    const p = planRenewal({
      planStart: t.visits[0],
      liveDates: t.visits,
      cancelledDates: [],
      completedCount: t.visits.length,
      endDate: null,
      endCount: null,
      seasonKey: t.key,
      cadence: null,
      interval: { interval_unit: 'month', interval_count: 2 },
      customerHasFutureVisit: false,
    }, t.seasons, t.today)
    ok(`${t.service}: the owner's own season gives the plan its ending`, !!p?.hasPlannedEnd,
      `endedBySeason=${p?.endedBySeason}, planEnd=${p?.planEnd}`)
    ok(`${t.service}: next cycle resolves to that season's next opening`, p?.nextCycleStart === t.nextStart,
      `got ${p?.nextCycleStart}, expected ${t.nextStart}`)
    ok(`${t.service}: the cycle is a YEAR, not the gap between two visits`, p?.cycleDays === 365)
    ok(`${t.service}: it is DUE — same verdict, no trade named`, p?.signal.reason === 'renewal_due',
      `got ${p?.signal.reason}`)
  }
}

// A trade with NO season at all — a twelve-month agreement. Same engine, and the
// cycle is the plan's own term.
{
  const p = planRenewal({
    planStart: '2025-09-01',
    liveDates: ['2025-09-01', '2026-03-01', '2026-08-31'],
    cancelledDates: [],
    completedCount: 3,
    endDate: '2026-08-31',
    endCount: null,
    // ⭐ A DECLARED year-round trade. 'none' is a decision the owner made; it is
    // NOT the same fact as null (nobody has said yet) — see verify:season-recurrence.
    seasonKey: SEASON_NONE,
    cadence: null,
    interval: { interval_unit: 'month', interval_count: 6 },
    customerHasFutureVisit: false,
  }, DEFAULT_SEASONS, '2026-08-13')
  check('a year-long agreement: the cycle is its own term', p?.cycleDays, 365)
  check('a year-long agreement: the next cycle starts the day after it ends', p?.nextCycleStart, '2026-09-01')
  check('a year-long agreement: due 19 days out, and still RUNNING', p?.signal.stage, 'ending')
  check('a year-long agreement: the renewed term is the same length again', p?.renewedEndDate, '2027-08-31')
}

// ═══════════════════════════════════════════════════════════════════════════
H('4. ⛔ INTENTIONALLY ENDED ≠ URGENT — ranOut refuses the red queue')
const ranBase = {
  hasRecurring: true, hasUpcoming: false, lastServiceDate: '2026-08-01',
  cadenceDays: 7, seasonallyDormant: false, today: '2026-08-13',
} as const
check('a series that just STOPPED is urgent — nothing changed there',
  ranOut({ ...ranBase }).isUrgent, true)
check('a plan that reached its given end is NOT a ran-out',
  ranOut({ ...ranBase, plannedEnd: true }).isRanOut, false)
check('…and it says so by name',
  ranOut({ ...ranBase, plannedEnd: true }).reason, 'plan_completed')
check('…and it is not urgent either',
  ranOut({ ...ranBase, plannedEnd: true }).isUrgent, false)
check('the flag is OPT-IN — every existing caller is unchanged',
  JSON.stringify(ranOut({ ...ranBase })), JSON.stringify(ranOut({ ...ranBase, plannedEnd: false })))
check('out of season still wins first — dormancy is checked before the term',
  ranOut({ ...ranBase, seasonallyDormant: true, plannedEnd: true }).reason, 'seasonally_dormant')

// ═══════════════════════════════════════════════════════════════════════════
H('5. THE QUEUE — one plan, one row, one action')
const TODAY = '2027-03-01'
const cust = (id: string, name: string) => ({ id, name, phone: null, email: null } as unknown as { id: string; name: string });

// A seasonal weekly plan that ran Apr–Oct 2026 and ended with its season.
const REC: RnRecurrence = {
  id: 'r1', customer_id: 'c1', freq: 'weekly', interval_unit: 'week', interval_count: 1,
  start_date: '2026-04-15', end_date: '2026-10-31', end_count: null,
  // ⭐ The series DECLARES lawn. Before S110 this was inferred from the visits'
  // service_type ('Weekly Mowing'); the queue now reads the declaration, so a
  // renamed series keeps its season and an undeclared one claims none.
  season_key: 'lawn',
}
const visit = (d: string, o: Partial<RnJob> = {}): RnJob => ({
  id: 'j' + d, customer_id: 'c1', recurrence_id: 'r1', property_id: 'p1', scheduled_date: d,
  status: 'completed', service_type: 'Weekly Mowing', title: 'Mow', quote_id: 'q0', price: null,
  crew_size: 1, duration_minutes: 45, is_initial_visit: false, ...o,
})
const OLD_QUOTE: RnQuote = {
  id: 'q0', quote_number: 'Q-1', customer_id: 'c1', status: 'completed', total: 60, created_at: '2026-04-01T00:00:00Z',
  sent_at: null, valid_until: null, service_type: 'Weekly Mowing', initial_price: 90,
  weekly_price: 60, biweekly_price: null, monthly_price: null, renewal_of_recurrence_id: null,
}
// Weekly visits that actually run to the season's close — the shape a plan has
// when it finishes rather than falls over. The last one is Oct 28, three days
// short of the Oct 31 end, which is where a weekly rule always lands.
const VISIT_DATES = [
  '2026-04-15', '2026-05-13', '2026-06-10', '2026-07-08', '2026-08-05', '2026-09-30', '2026-10-28',
]
const VISITS = VISIT_DATES.map(d => visit(d))
const rows = (over: Partial<{ jobs: RnJob[]; quotes: RnQuote[]; recurrences: RnRecurrence[] }> = {}) => ({
  customers: [cust('c1', 'Dana Fields')],
  jobs: over.jobs ?? VISITS,
  quotes: over.quotes ?? [OLD_QUOTE],
  recurrences: over.recurrences ?? [REC],
  seasons: DEFAULT_SEASONS,
  today: TODAY,
});

{
  const r = computeRenewals(rows())
  check('the ended seasonal plan is on the queue', r.opportunities.length, 1)
  check('…as DUE — nothing offered yet', r.opportunities[0].stage, 'due')
  check('…priced at the plan’s own per-visit rate, not the setup price', r.opportunities[0].perVisit, 60)
  check('…last cycle’s value is visits × per-visit, a fact not a forecast', r.opportunities[0].cycleValue, 7 * 60)
  check('…and it counts as needing the owner', r.actionable, 1)
  ok('…the reason is one plain line', /Season ended/.test(r.opportunities[0].reason), r.opportunities[0].reason)
  ok('…the evidence is dated facts', r.opportunities[0].evidence.length >= 3)
}

// ⭐⭐ AN END DATE IS NOT AN ENDING. The same plan, the same Oct 31 end date, but
// its visits stopped in August — it ran DRY twelve weeks early. Found in the live
// book: two real mowing customers were being filed as "ran its full term and
// finished" while one of them was six days without a mow.
const DRY = ['2026-04-15', '2026-05-13', '2026-06-10', '2026-07-08', '2026-08-05']
{
  const r = computeRenewals({ ...rows({ jobs: DRY.map(d => visit(d)) }), today: '2026-08-14' })
  check('a plan that stopped 12 weeks short of its end date is NOT a renewal', r.opportunities.length, 0)
}

// A short BLOCK booked inside a season is not a season. Its cycle is its own
// fifteen days, so it renews now — not next April.
{
  const block: RnRecurrence = { ...REC, start_date: '2026-07-24', end_date: '2026-08-07' }
  const jobs = ['2026-07-24', '2026-07-31', '2026-08-07'].map(d => visit(d))
  const r = computeRenewals({ ...rows({ jobs, recurrences: [block] }), today: '2026-08-14' })
  check('a 3-visit block that finished last week is due NOW', r.opportunities.length, 1)
  check('…its next cycle is the day after it ended, not next season',
    r.opportunities[0]?.nextCycleStart, '2026-08-08')
  ok('…and the reason says the plan ended, not the season',
    /Plan ended/.test(r.opportunities[0]?.reason ?? ''), r.opportunities[0]?.reason)
}

// The anchor visit's setup price must not become the renewal figure.
{
  const withAnchor = [visit('2026-04-15', { is_initial_visit: true }), ...VISITS.slice(1)]
  const r = computeRenewals(rows({ jobs: withAnchor }))
  check('the FIRST visit’s setup price never becomes the per-visit figure', r.opportunities[0].perVisit, 60)
}

// Offer lifecycle.
const offer = (status: string, extra: Partial<RnQuote> = {}): RnQuote => ({
  id: 'q1', quote_number: 'Q-2', customer_id: 'c1', status, total: 1800,
  created_at: '2027-02-20T00:00:00Z', sent_at: '2027-02-21T00:00:00Z', valid_until: '2027-03-23',
  service_type: 'Weekly Mowing', initial_price: null, weekly_price: 65, biweekly_price: null,
  monthly_price: null, renewal_of_recurrence_id: 'r1', ...extra,
});

{
  for (const [status, stage] of [['draft', 'drafted'], ['sent', 'sent'], ['accepted', 'accepted']] as const) {
    const r = computeRenewals(rows({ quotes: [OLD_QUOTE, offer(status)] }))
    check(`a ${status} renewal quote shows as ${stage}`, r.opportunities[0].stage, stage)
  }
  const declined = computeRenewals(rows({ quotes: [OLD_QUOTE, offer('declined')] }))
  check('⭐ DECLINED is an ANSWER — the row leaves the queue', declined.opportunities.length, 0)
  const booked = computeRenewals(rows({ quotes: [OLD_QUOTE, offer('scheduled')] }))
  check('⭐ once the plan exists the row leaves the queue', booked.opportunities.length, 0)
  const expired = computeRenewals(rows({ quotes: [OLD_QUOTE, offer('sent', { valid_until: '2027-02-28' })] }))
  check('a lapsed offer says "expired", not "waiting"', expired.opportunities[0].stage, 'expired')
  check('…and expired is the OWNER’s move again', expired.actionable, 1)
  const sent = computeRenewals(rows({ quotes: [OLD_QUOTE, offer('sent')] }))
  check('a live sent offer is NOT something to do', sent.actionable, 0)
}

// A quote for the same customer that is NOT this plan's renewal must not silence it.
{
  const unrelated = offer('sent', { id: 'q9', quote_number: 'Q-9', renewal_of_recurrence_id: null })
  const r = computeRenewals(rows({ quotes: [OLD_QUOTE, unrelated] }))
  check('an unrelated quote for the same customer does not close the renewal', r.opportunities[0].stage, 'due')
}

// Booked again by any route → gone.
{
  const rebooked = [...VISITS, visit('2027-04-20', { id: 'jf', status: 'scheduled', recurrence_id: 'r2' })]
  const r = computeRenewals(rows({ jobs: rebooked }))
  check('already re-booked → nothing to ask', r.opportunities.length, 0)
}

// Cancelled remainder → never offered. The plan's live visits stop on Oct 7 and
// the two that would have followed were cancelled: somebody stopped this.
{
  const stopped = [
    ...VISIT_DATES.slice(0, 5).map(d => visit(d)),
    visit('2026-10-14', { id: 'jx1', status: 'cancelled' }),
    visit('2026-10-21', { id: 'jx2', status: 'cancelled' }),
  ]
  const r = computeRenewals(rows({ jobs: stopped }))
  check('⛔ a plan somebody cancelled out of is never offered back', r.opportunities.length, 0)
}

// Too early: the same plan, seen in November.
{
  const r = computeRenewals({ ...rows(), today: '2026-11-15' })
  check('in November, four months out, the queue is silent', r.opportunities.length, 0)
}

check('renewalStageFor: a sent quote past its date is expired',
  renewalStageFor('sent', '2027-02-28', TODAY), 'expired')
check('renewalStageFor: paid/completed count as planned, not as an open offer',
  [renewalStageFor('paid', null, TODAY), renewalStageFor('completed', null, TODAY)], ['planned', 'planned'])

// ═══════════════════════════════════════════════════════════════════════════
H('6. ⭐ DORMANT ≠ LOST, and one customer is never two rows')
const rj = (d: string, o: Partial<RJob> = {}): RJob => ({
  customer_id: 'c1', scheduled_date: d, status: 'completed', service_type: 'Weekly Mowing',
  quote_id: 'q0', recurrence_id: 'r1', price: null, is_initial_visit: false, ...o,
})
const rq: RQuote = {
  id: 'q0', customer_id: 'c1', status: 'completed', total: 60, service_type: 'Weekly Mowing',
  created_at: '2026-04-01T00:00:00Z', initial_price: 90, weekly_price: 60, biweekly_price: null, monthly_price: null,
}
const rrec: RRecurrence = {
  id: 'r1', freq: 'weekly', interval_unit: 'week', interval_count: 1,
  start_date: '2026-04-15', end_date: '2026-10-31', end_count: null,
  // The series DECLARES lawn. Reactivation reads the declaration now, so 'their
  // season ended' stays distinguishable from 'we lost them' after a rename.
  season_key: 'lawn',
}
const reactRows = (today: string, jobs: RJob[] = VISITS.map(v => rj(v.scheduled_date))) => ({
  customers: [cust('c1', 'Dana Fields')],
  jobs,
  quotes: [rq],
  recById: { r1: rrec },
  seasons: DEFAULT_SEASONS,
  today,
});

{
  // March: their season is over, the renewal is live, and this page must be quiet.
  const r = computeReactivation(reactRows(TODAY))
  check('a customer whose renewal is live is NOT at risk', r.atRisk, 0)
  check('…they are not in the urgent queue', r.ranOuts.length, 0)
  check('…and not in a lapse bucket either — the renewal queue has them', r.risks.length, 0)
  check('…they are REPORTED as dormant, with a reason', r.dormant.length, 1)
  check('…named as an open renewal', r.dormant[0].reason, 'renewal_open')
  ok('…and the note says it in plain words', /renewal/i.test(r.dormant[0].note), r.dormant[0].note)
}

{
  // November: out of season, renewal not due yet. Dormant, still not at risk.
  const r = computeReactivation(reactRows('2026-11-15'))
  check('between seasons: not at risk', r.atRisk, 0)
  check('between seasons: reported, not dropped', r.dormant.length, 1)
  check('between seasons: named as such', r.dormant[0].reason, 'between_seasons')
}

{
  // August the following year: the renewal window closed unanswered. Now they
  // are genuinely a lapsed customer — quiet, not urgent.
  const r = computeReactivation(reactRows('2027-08-01'))
  check('a year on, they age into the lapse buckets', r.risks.length, 1)
  check('…as a nudge, never as an emergency', r.ranOuts.length, 0)
  check('…in the 6+ month bucket', r.risks[0].bucket, '6+')
  ok('…carrying the dated facts that put them there', r.risks[0].evidence.length >= 3)
}

{
  // ⭐ THE OVERLAP THAT WOULD OTHERWISE PRINT ONE CUSTOMER TWICE. Their season
  // plan ended last Oct 31, it is now late April — so their season is BACK (no
  // dormancy to hide behind), it is 171 days since their last visit (deep in the
  // 6+ month bucket), and their renewal window is open. Exactly one queue may
  // claim them, and it is the one with a price and a button.
  const r = computeReactivation(reactRows('2027-04-20'))
  check('renewal window open, in season, 171 days quiet → not in a lapse bucket', r.risks.length, 0)
  check('…not in the urgent queue either', r.ranOuts.length, 0)
  check('…not counted as at risk', r.atRisk, 0)
  check('…reported once, pointing at the renewals list', r.dormant.map(d => d.reason), ['renewal_open'])
  // And the renewal queue is the one holding them.
  const q = computeRenewals({ ...rows(), today: '2027-04-20' })
  check('…and the renewal queue does hold them', q.opportunities.length, 1)
}

{
  // ⭐⭐ The live-book case, from the other side. Same Oct 31 end date, visits
  // stopped Aug 5: this customer must stay in the URGENT queue and must not be
  // described as finished.
  const r = computeReactivation(reactRows('2026-08-14', DRY.map(d => rj(d))))
  check('a plan that ran dry short of its end date is still urgent', r.ranOuts.length, 1)
  check('…and is NOT filed as "ran its full term"', r.dormant.length, 0)
  check('…so the at-risk count still counts them', r.atRisk, 1)
}

{
  // The SAME dates with no end date on the series: this plan fell over, and that
  // IS urgent. The distinction the whole feature rests on.
  // ⭐ NON-SEASONAL IS NOW A DECLARATION, not the absence of a keyword match.
  // This used to be non-seasonal only because 'Office Cleaning' matched no hint;
  // it must say so, or it inherits rrec’s lawn season and a February plan that
  // fell over reads as "dormant until spring" instead of urgent.
  const noEnd = { ...rrec, end_date: null, season_key: SEASON_NONE }
  const jobs = ['2027-02-01', '2027-02-08', '2027-02-15'].map(d => rj(d, { service_type: 'Office Cleaning' }))
  const urgent = computeReactivation({
    ...reactRows('2027-03-01', jobs), recById: { r1: { ...noEnd, start_date: '2027-02-01' } },
  })
  const planned = computeReactivation({
    ...reactRows('2027-03-01', jobs), recById: { r1: { ...noEnd, start_date: '2027-02-01', end_date: '2027-02-15' } },
  })
  check('a non-seasonal plan that just STOPPED is urgent', urgent.ranOuts.length, 1)
  check('the identical plan WITH an agreed end is not', planned.ranOuts.length, 0)
  check('…and is not silently dropped', planned.dormant.length, 1)
  ok('…the only difference between the two is the end date', true)
}

{
  // Cancelled remainder, mid-season: a decision, not an emergency.
  const jobs = [
    ...['2026-04-15', '2026-04-22'].map(d => rj(d, { service_type: 'Office Cleaning' })),
    rj('2026-04-29', { status: 'cancelled', service_type: 'Office Cleaning' }),
  ]
  const r = computeReactivation({
    ...reactRows('2026-05-10', jobs),
    recById: { r1: { ...rrec, start_date: '2026-04-15', end_date: null } },
  })
  check('⛔ cancelled remainder → not urgent', r.ranOuts.length, 0)
  check('⛔ cancelled remainder → reported as ended on purpose', r.dormant[0].reason, 'ended_deliberately')
  check('⛔ …and not counted as at risk', r.atRisk, 0)
}

// ═══════════════════════════════════════════════════════════════════════════
// A FAILED READ IS NOT AN ANSWER.
// supabase-js RESOLVES with { data: null, error } on a dead connection, so a
// tolerant `|| []` turns a network blip into "no plans need renewing" and
// "every customer is booked or recently served" — a confident all-clear about
// next year's revenue, manufactured by a dropped socket. Asserted by CALLING the
// loaders against a client that fails, because the claim is about behaviour and
// a grep for the error branch would pass on a branch that returned the wrong thing.
//
// Declared here (beside the sections it belongs with) and awaited at the very
// end: tsx runs these guards as CommonJS, where top-level await is a syntax error.
async function honestyChecks() {
  H('11. A FAILED READ IS NOT AN ANSWER')
  // One chainable stub: every query shape the loaders use (.select().eq(),
  // .is(), .maybeSingle()) returns the same thenable.
  const client = (result: { data: unknown; error: { message: string } | null }) => {
    const chain: Record<string, unknown> = {}
    for (const m of ['select', 'eq', 'is', 'order', 'limit', 'maybeSingle']) chain[m] = () => chain
    chain.then = (res: (v: unknown) => void) => res(result)
    return {
      auth: { getSession: async () => ({ data: { session: { user: { id: 'u1' } } } }) },
      from: () => chain,
    } as never
  }

  const brokenRenewals = await loadRenewals(client({ data: null, error: { message: 'network down' } }))
  check('loadRenewals on a failed read does NOT report an empty queue', brokenRenewals.ok, false)
  ok('…and there is no report field to render an all-clear from',
    !('report' in brokenRenewals), JSON.stringify(brokenRenewals))
  ok('…it hands the caller the reason', !brokenRenewals.ok && /network down/.test(brokenRenewals.error))

  const brokenReact = await loadReactivation(client({ data: null, error: { message: 'network down' } }))
  check('loadReactivation on a failed read does NOT report "everyone is fine"', brokenReact.ok, false)
  ok('…with no report field either', !('report' in brokenReact))

  // The control: an EMPTY book is a real answer and must still succeed, or the
  // honesty fix would have turned every new business into an error page.
  const emptyRenewals = await loadRenewals(client({ data: [], error: null }))
  check('an genuinely empty book still answers', emptyRenewals.ok, true)
  check('…with an empty queue', emptyRenewals.ok && emptyRenewals.report.opportunities.length, 0)
  const emptyReact = await loadReactivation(client({ data: [], error: null }))
  check('…and reactivation says zero at risk, truthfully', emptyReact.ok && emptyReact.report.atRisk, 0)
}


// ═══════════════════════════════════════════════════════════════════════════
H('7. ⛔ NO RECURRENCE WITHOUT APPROVAL — every write path, enumerated')
// A grep with an allowlist, because the risk is a NEW path appearing, not the
// known ones changing. Anything that inserts into job_recurrences and is not
// listed here fails this guard on sight.
const WRITE_SITES: Record<string, string> = {
  'src/app/dashboard/schedule/page.tsx': 'the schedule editor — the owner is typing the plan',
  'src/lib/recurrence.ts': 'createRecurringPlan, THE plan-creation engine; every caller supplies the owner action',
}
{
  const files = execFiles()
  const inserts = files.filter(f => /from\('job_recurrences'\)[\s\S]{0,40}\.insert\(/.test(stripComments(src(f))))
  const rogue = inserts.filter(f => !(f in WRITE_SITES))
  ok('no unlisted code inserts a recurrence', rogue.length === 0,
    `${rogue.join(', ')} — add it to WRITE_SITES with the owner action behind it, or route it through lib/recurrence`)
  const stale = Object.keys(WRITE_SITES).filter(f => !inserts.includes(f))
  ok('the allowlist has no stale entries', stale.length === 0,
    `${stale.join(', ')} no longer insert a recurrence — drop the entry`)
}
{
  const renew = stripComments(src('src/lib/renewals.ts'))
  ok('the renewal write refuses anything but an accepted quote',
    /status\s*!==\s*'accepted'/.test(renew))
  ok('…and refuses a quote that is not THIS plan’s renewal',
    /renewal_of_recurrence_id\s*!==\s*o\.recurrenceId/.test(renew))
  ok('…re-reading the status from the database, not from a page-load snapshot',
    /from\('quotes'\)[\s\S]{0,200}\.eq\('id',\s*o\.quote\.id\)/.test(renew))
  ok('the renewal write is reached from the queue only after that check',
    renew.indexOf("status !== 'accepted'") < renew.indexOf('createRecurringPlan(sb'))
}
{
  // Nothing automatic. A cron, a webhook or an API route that can create a plan
  // is the exact failure this feature is defined against.
  const auto = execFiles().filter(f => /^src\/app\/api\//.test(f) || /^src\/lib\/cron\//.test(f) || /^src\/lib\/automation\//.test(f))
  const bad = auto.filter(f => /createRenewedPlan|createRecurringPlan/.test(stripComments(src(f))))
  ok('no cron, API route or automation can create a plan', bad.length === 0, bad.join(', '))
}
{
  const sug = stripComments(src('src/lib/suggestions.ts'))
  ok('⛔ the seasonal suggestion no longer books a season in one tap',
    !/id:\s*`renew-\$\{[\s\S]{0,600}kind:\s*'create-recurring'/.test(sug))
  ok('…it points at the renewal queue instead',
    /label:\s*'Review renewal'/.test(sug))
}

// ═══════════════════════════════════════════════════════════════════════════
H('8. ⭐ HISTORY IS NEVER TRADED FOR A RENEWAL')
{
  const renew = stripComments(src('src/lib/renewals.ts'))
  ok('lib/renewals never updates a recurrence', !/from\('job_recurrences'\)[\s\S]{0,60}\.update\(/.test(renew))
  ok('lib/renewals never deletes a recurrence', !/from\('job_recurrences'\)[\s\S]{0,60}\.delete\(/.test(renew))
  ok('lib/renewals never touches an existing visit', !/from\('jobs'\)[\s\S]{0,60}\.(update|delete)\(/.test(renew))
  // The one UPDATE it does make is the quote's own accepted → scheduled move.
  const updates = renew.match(/\.update\(/g) || []
  ok('it makes exactly ONE update, and that is the quote’s own status', updates.length === 1,
    `${updates.length} updates found`)
  ok('…which is the same transition scheduling any won quote makes',
    /from\('quotes'\)\.update\(\{\s*status:\s*'scheduled'\s*\}\)/.test(renew))
}
{
  const rec = stripComments(src('src/lib/recurrence.ts'))
  ok('the plan-creation engine INSERTS a new recurrence and never edits one',
    /from\('job_recurrences'\)\.insert\(/.test(rec) && !/from\('job_recurrences'\)\.update\(/.test(rec))
  ok('a failed visit insert rolls back the orphan recurrence',
    /from\('job_recurrences'\)\.delete\(\)\.eq\('id'/.test(rec))
  ok('it refuses to create a plan that would generate no visits',
    /future\.length === 0/.test(rec))
}

// ═══════════════════════════════════════════════════════════════════════════
H('9. TENANT ISOLATION — the schema refuses, not the component')
{
  const renew = stripComments(src('src/lib/renewals.ts'))
  const reads = renew.match(/sb\.from\('[a-z_]+'\)\.select\(/g) || []
  const scoped = renew.match(/\.eq\('user_id', user\.id\)/g) || []
  // Five reads in the loader; the sixth `from('quotes')` is the re-read by
  // primary key inside the write path, which RLS scopes on its own.
  ok('every loader read is user-scoped', reads.length >= 5 && scoped.length >= 5,
    `${reads.length} reads, ${scoped.length} user_id filters`)
}
{
  // The renewal link is a COMPOSITE foreign key. A single-column one would only
  // ask that the recurrence exist SOMEWHERE — which is how one tenant names
  // another tenant's plan as the thing their quote renews.
  //
  // Found by SHAPE, never by name: the baseline is regenerated from production
  // and its version moves every time. A hardcoded filename here would turn a
  // routine resync into a red guard about renewals.
  const baselines = readdirSync(join(ROOT, 'supabase', 'migrations')).filter(f => /_baseline\.sql$/.test(f))
  ok('exactly one generated baseline is in the apply path', baselines.length === 1, baselines.join(', '))
  const baseline = src(join('supabase', 'migrations', baselines[0]))
  ok('quotes.renewal_of_recurrence_id exists in the schema',
    /"renewal_of_recurrence_id"\s+uuid/.test(baseline))
  ok('⭐ the renewal FK is COMPOSITE — (user_id, plan) → (user_id, id)',
    /FOREIGN KEY \(user_id, renewal_of_recurrence_id\) REFERENCES job_recurrences\(user_id, id\)/.test(baseline))
  // `[^\n]*`, not `.*` with the /s flag: this project's TS target predates
  // dotAll, and `next build` typechecks scripts/ even though `tsc --noEmit` skips
  // them — a guard can be green under tsx and refuse to build.
  ok('…its target uniqueness is enforced', /job_recurrences[^\n]*UNIQUE \(user_id, id\)/.test(baseline))
  ok('…and deleting a plan nulls only the LINK, never the tenant column',
    /ON DELETE SET NULL \(renewal_of_recurrence_id\)/.test(baseline))
}
{
  // ⭐ THE LOADER↔ENGINE CONTRACT, made executable. "Did this plan reach the
  // ending it was given" cannot be answered without the series' own dates, and a
  // loader that stops selecting them does not fail — it quietly answers "no" for
  // every plan, and finished contracts start reading as emergencies again on the
  // dashboard. Nothing about that is visible to tsc, and the engine's own tests
  // pass either way because they are handed the rows directly.
  for (const f of ['src/lib/dashboard/data.ts', 'src/lib/reactivation.ts', 'src/lib/renewals.ts']) {
    const sel = stripComments(src(f)).match(/from\('job_recurrences'\)\s*\.select\('([^']*)'\)/)
    ok(`${f} selects the series' own dates`,
      !!sel && ['start_date', 'end_date', 'end_count'].every(c => sel[1].includes(c)),
      sel ? `selects: ${sel[1]}` : 'no job_recurrences select found')
  }
}
{
  const page = stripComments(src('src/app/dashboard/quotes/new/page.tsx'))
  ok('the quote door carries the plan id from the URL',
    /searchParams\.get\('renew'\)/.test(page))
  ok('…and writes it on the insert', /renewal_of_recurrence_id: renewalOfRecurrenceId/.test(page))
  ok('⭐ a stashed prefill for a DIFFERENT plan is discarded, never applied',
    /r\.recurrenceId === forPlan/.test(page) && /clearRenewalPrefill\(\)/.test(page))
}

// ═══════════════════════════════════════════════════════════════════════════
H('10. NO TRADE IS NAMED IN THE ENGINES')
// The seasons module is allowed its two built-in defaults (an owner's own season
// beats them, and that is tested in §3). The renewal engines are not.
{
  const WORDS = /\b(mow|mowing|lawn|snow|plow|grass|fertiliz|shovel|landscap|pool|hvac|furnace)\b/i
  for (const f of ['src/lib/signals/renewal.ts', 'src/lib/renewals.ts']) {
    const code = stripComments(src(f))
    const hit = code.match(WORDS)
    ok(`${f} names no trade`, !hit, hit ? `found "${hit[0]}"` : '')
  }
}

// ═══════════════════════════════════════════════════════════════════════════
H('12. MOBILE — four things per row, and one button')
// The owner reads this queue one-handed in a truck. The brief is literal about
// the shape: customer, what they used to buy, why it is here, and the button.
// The BUTTON is rendered for real (renderToStaticMarkup, the technique
// verify:team and verify:mobile-shell use) because a phone label that exists
// only in a class name is not a phone label. The row's text discipline is
// asserted against its source, which is stated plainly rather than dressed up as
// a render.
{
  const stages: RenewalStage[] = ['due', 'drafted', 'sent', 'expired', 'accepted']
  for (const stage of stages) {
    const html = renderToStaticMarkup(
      React.createElement(RowAction, {
        stage, busy: false, quoteId: 'q1', onReview: () => {}, onCreate: () => {},
      }),
    )
    // Exactly one interactive element: a queue where a row offers three things
    // is a queue that gets read as a menu instead of a track.
    const controls = (html.match(/<(button|a)\b/g) || []).length
    check(`${stage}: exactly one action in the row`, controls, 1)
    ok(`${stage}: a short label for the phone`, /class="[^"]*sm:hidden[^"]*"/.test(html), html.slice(0, 160))
    ok(`${stage}: and a full one from sm up`, /class="[^"]*hidden sm:inline[^"]*"/.test(html), html.slice(0, 160))
    ok(`${stage}: the label never wraps the row`, /whitespace-nowrap/.test(html))
    ok(`${stage}: a 36px-plus touch target`, /\bh-9\b|\bh-10\b|\bh-11\b/.test(html))
  }
  const accepted = renderToStaticMarkup(
    React.createElement(RowAction, { stage: 'accepted' as RenewalStage, busy: true, quoteId: 'q1', onReview: () => {}, onCreate: () => {} }),
  )
  ok('a plan being created cannot be created twice', /disabled/.test(accepted))
}
{
  const q = stripComments(src('src/components/grow/RenewalQueue.tsx'))
  // Long customer names and long service names are the normal case, not the edge
  // case, and a row that grows to fit them pushes the button off a 390px screen.
  ok('the text column can shrink', /min-w-0 flex-1/.test(q))
  ok('the action column cannot', /shrink-0 text-right/.test(q))
  const truncs = (q.match(/truncate/g) || []).length
  ok('all three text lines truncate', truncs >= 3, `${truncs} found`)
  ok('the customer name is capped on a phone', /max-w-\[60vw\]/.test(q))
  // The evidence is a tap away, not a paragraph in the row.
  ok('the reasoning is behind disclosure', /aria-expanded=\{open\}/.test(q))
}

// ═══════════════════════════════════════════════════════════════════════════
// Walk src/ once — used by §7's write-site scan.
function execFiles(): string[] {
  const out: string[] = []
  const walk = (dir: string) => {
    if (!existsSync(dir)) return
    for (const e of readdirSync(dir)) {
      const p = join(dir, e)
      if (statSync(p).isDirectory()) walk(p)
      else if (/\.(ts|tsx)$/.test(p)) out.push(p.slice(ROOT.length + 1).replace(/\\/g, '/'))
    }
  }
  walk(join(ROOT, 'src'))
  return out
}

// ═══════════════════════════════════════════════════════════════════════════
honestyChecks().then(() => {
  console.log(`\n${'═'.repeat(60)}\n  PASS ${pass}   FAIL ${fail}`)
  if (fail > 0) process.exit(1)
})
