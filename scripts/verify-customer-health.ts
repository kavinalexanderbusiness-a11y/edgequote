// ── Customer-health verification — npm run verify:customer-health ───────────
//
// lib/customerHealth.ts is the lifecycle decision engine ONE LAYER ABOVE the
// signal detectors: computeCustomerHealth fuses ltv, tenure, recurring status,
// cadence adherence, churn risk, lapse and payment behaviour into the single
// 0–100 score, tier, flags and headline REASON the Growth screen sorts a whole
// book by. verify-signals pins the detectors; this pins their COMPOSITION — the
// score arithmetic, the flag set, the reason precedence and the value-weighted
// sort are all decisions that live only here, and every one of them fails as a
// wrong verdict on a real customer, not a type error. Nothing exercised it.
//
// CHARACTERIZATION tests: one book of seven customers, each built to hit a
// different branch, with every expected row captured from the module itself.
// Pure + deterministic — the engine takes `today` as a parameter by design.

import { computeCustomerHealth, type HealthRow } from '../src/lib/customerHealth'
import { DEFAULT_SEASONS } from '../src/lib/seasons'

let pass = 0
let fail = 0
function H(t: string) { console.log(`\n═══ ${t} ═══`) }
function check(name: string, actual: unknown, expected: unknown) {
  const a = JSON.stringify(actual); const e = JSON.stringify(expected)
  if (a === e) { pass++; console.log(`  ✅ ${name}`) }
  else { fail++; console.log(`  ❌ ${name}\n     expected: ${e}\n     actual:   ${a}`) }
}

// ── The book: seven customers, one branch each ───────────────────────────────
const TODAY = '2026-07-15' // mid lawn season, out of snow season
const cust = (id: string, name: string, created: string) => ({ id, name, created_at: created })
const mow = (cid: string, date: string, price = 60, over: object = {}) => ({
  customer_id: cid, status: 'completed', scheduled_date: date,
  service_type: 'Weekly Mowing', recurrence_id: null as string | null, quote_id: null, price, ...over,
})
// ⭐⭐ THE SERIES DECLARES ITS SEASON (S110). These used to carry no season at
// all: the season was guessed from each visit's service_type, so G read as snow
// only because a visit happened to be called "Snow Removal". The declaration is
// the series' own fact now, which is why G can be renamed and still be dormant
// in July rather than "at risk".
const weekly = { freq: 'weekly', interval_unit: null, interval_count: null, season_key: 'lawn' }
const weeklySnow = { ...weekly, season_key: 'snow' }
const RECS = { rB: weekly, rC: weekly, rD: weekly, rG: weeklySnow }

const CUSTOMERS = [
  cust('A', 'Fresh', '2026-07-15'),          // brand new, nothing yet
  cust('B', 'VIP OnTrack', '2025-01-01'),    // the healthy ceiling
  cust('C', 'Drifted High', '2025-01-01'),   // 20 days past a 7-day cadence
  cust('D', 'Drifted Watch', '2025-01-01'),  // 9 days past a 7-day cadence
  cust('E', 'Unpaid Three', '2025-01-01'),   // on track but owes money
  cust('F', 'Lapsed', '2025-01-01'),         // history, no series, nothing booked
  cust('G', 'Snow July', '2025-01-01'),      // snow customer out of season
]
const JOBS = [
  // B: six on-rhythm $300 visits + one booked ahead → recurring, VIP, adherent.
  mow('B', '2026-06-03', 300, { recurrence_id: 'rB' }), mow('B', '2026-06-10', 300, { recurrence_id: 'rB' }),
  mow('B', '2026-06-17', 300, { recurrence_id: 'rB' }), mow('B', '2026-06-24', 300, { recurrence_id: 'rB' }),
  mow('B', '2026-07-01', 300, { recurrence_id: 'rB' }), mow('B', '2026-07-08', 300, { recurrence_id: 'rB' }),
  mow('B', '2026-07-22', 300, { recurrence_id: 'rB', status: 'scheduled' }),
  // C: 30-day gaps on a weekly cadence, last visit 20 days ago, nothing booked.
  mow('C', '2026-04-26', 60, { recurrence_id: 'rC' }), mow('C', '2026-05-26', 60, { recurrence_id: 'rC' }),
  mow('C', '2026-06-25', 60, { recurrence_id: 'rC' }),
  // D: weekly rhythm kept, but last visit 9 days ago and nothing booked.
  mow('D', '2026-06-22', 60, { recurrence_id: 'rD' }), mow('D', '2026-06-29', 60, { recurrence_id: 'rD' }),
  mow('D', '2026-07-06', 60, { recurrence_id: 'rD' }),
  // E: B's rhythm at $60, plus three unpaid invoices below.
  mow('E', '2026-06-03', 60, { recurrence_id: 'rB' }), mow('E', '2026-06-10', 60, { recurrence_id: 'rB' }),
  mow('E', '2026-06-17', 60, { recurrence_id: 'rB' }), mow('E', '2026-06-24', 60, { recurrence_id: 'rB' }),
  mow('E', '2026-07-01', 60, { recurrence_id: 'rB' }), mow('E', '2026-07-08', 60, { recurrence_id: 'rB' }),
  mow('E', '2026-07-22', 60, { recurrence_id: 'rB', status: 'scheduled' }),
  // F: two visits a year ago, no series.
  mow('F', '2025-07-01'), mow('F', '2025-07-08'),
  // G: a snow series whose last visit was March — July is off-season.
  mow('G', '2026-02-15', 80, { recurrence_id: 'rG', service_type: 'Snow Removal' }),
  mow('G', '2026-03-15', 80, { recurrence_id: 'rG', service_type: 'Snow Removal' }),
]
const INVOICES = [
  { customer_id: 'E', status: 'unpaid', amount: 100 },
  { customer_id: 'E', status: 'sent', amount: 50 },     // 'sent' counts as owed
  { customer_id: 'E', status: 'unpaid', amount: 75.4 }, // rounding lands in the row
  { customer_id: 'B', status: 'paid', amount: 300 },    // paid never counts
]

const rows = computeCustomerHealth(CUSTOMERS, JOBS, RECS as never, {}, INVOICES, DEFAULT_SEASONS, TODAY)
const by = Object.fromEntries(rows.map(r => [r.customerId, r])) as Record<string, HealthRow>

// ═══════════════════════════════════════════════════════════════════════════
H('1. THE SORT — worst health first, weighted by value (save the expensive ones)')
check('order is (100−score)×(1+ltv/1000), worst-weighted first',
  rows.map(r => r.customerId), ['C', 'D', 'G', 'F', 'A', 'E', 'B'])
check('the weighting is visible: G and F tie at 62, but G\'s higher LTV ranks it first',
  { g: by.G.score, f: by.F.score, gLtv: by.G.ltv, fLtv: by.F.ltv }, { g: 62, f: 62, gLtv: 160, fLtv: 120 })

// ═══════════════════════════════════════════════════════════════════════════
H('2. THE HEALTHY CEILING — loyalty, value and rhythm add up and clamp at 100')
check('a VIP on rhythm with a booked visit scores a clamped 100, healthy', by.B, {
  customerId: 'B', name: 'VIP OnTrack', score: 100, tier: 'healthy', ltv: 1800,
  tenureDays: 560, recurring: true, completedVisits: 6, overdueDays: null, intervalDays: 7,
  unpaidCount: 0, unpaidAmount: 0, flags: ['recurring', 'vip'],
  reason: 'Top customer — $1,800 lifetime',
})

// ═══════════════════════════════════════════════════════════════════════════
H('3. CADENCE DRIFT — the churn thresholds land as score, flags and the headline')
check('20 days past a 7-day cadence (ratio ≥1.6) → at_risk with the overdue headline', by.C, {
  customerId: 'C', name: 'Drifted High', score: 32, tier: 'at_risk', ltv: 180,
  tenureDays: 560, recurring: false, completedVisits: 3, overdueDays: 20, intervalDays: 7,
  unpaidCount: 0, unpaidAmount: 0, flags: ['at_risk', 'lapsed'],
  reason: 'Overdue 20 days vs 7-day cadence',
})
check('9 days past (watch band) → softer penalty, same honest headline',
  { score: by.D.score, tier: by.D.tier, overdue: by.D.overdueDays, reason: by.D.reason },
  { score: 60, tier: 'watch', overdue: 9, reason: 'Overdue 9 days vs 7-day cadence' })
// The drift is measured against the series' rhythm even though nothing is booked —
// `recurring` (an ACTIVE plan) is false for both drifters, yet the cadence still judges.
check('drift is judged against the rhythm even when the series has no future visits',
  { c: by.C.recurring, d: by.D.recurring }, { c: false, d: false })

// ═══════════════════════════════════════════════════════════════════════════
H('4. THE SNOW CUSTOMER IN JULY — off-season is calm, not at risk')
// Last serviced in March, four months "overdue" by raw arithmetic — but the
// in-season gate keeps overdue NULL, churn stays quiet, and they read as a calm
// watch/lapsed instead of at_risk. This is the composition-layer half of the rule
// verify-signals pins at the detector layer.
check('out-of-season: overdue stays null and the tier stays watch', by.G, {
  customerId: 'G', name: 'Snow July', score: 62, tier: 'watch', ltv: 160,
  tenureDays: 560, recurring: false, completedVisits: 2, overdueDays: null, intervalDays: null,
  unpaidCount: 0, unpaidAmount: 0, flags: ['lapsed'],
  reason: 'No upcoming visit booked',
})

// ═══════════════════════════════════════════════════════════════════════════
H('5. LAPSED AND NEW — quiet flags, quiet reasons')
check('history + no series + nothing booked → lapsed, mild penalty',
  { score: by.F.score, tier: by.F.tier, flags: by.F.flags, reason: by.F.reason },
  { score: 62, tier: 'watch', flags: ['lapsed'], reason: 'No upcoming visit booked' })
check('a brand-new customer starts at the neutral 60, flagged new', by.A, {
  customerId: 'A', name: 'Fresh', score: 60, tier: 'watch', ltv: 0,
  tenureDays: 0, recurring: false, completedVisits: 0, overdueDays: null, intervalDays: null,
  unpaidCount: 0, unpaidAmount: 0, flags: ['new'], reason: 'New customer',
})

// ═══════════════════════════════════════════════════════════════════════════
H('6. MONEY OWED — sent counts, paid never does, and the penalty is capped')
check('three owed invoices (unpaid + sent) → capped −18, rounded amount in the headline', by.E, {
  customerId: 'E', name: 'Unpaid Three', score: 74, tier: 'watch', ltv: 360,
  tenureDays: 560, recurring: true, completedVisits: 6, overdueDays: null, intervalDays: 7,
  unpaidCount: 3, unpaidAmount: 225, flags: ['recurring', 'unpaid'],
  reason: '3 unpaid invoices ($225)',
})
check('B\'s PAID invoice never counted against them', { c: by.B.unpaidCount, a: by.B.unpaidAmount }, { c: 0, a: 0 })

// ═══════════════════════════════════════════════════════════════════════════
H('7. REASON PRECEDENCE — overdue beats unpaid when both are true')
const both = computeCustomerHealth(
  [{ id: 'X', name: 'Both', created_at: '2025-01-01' }],
  [
    { customer_id: 'X', status: 'completed', scheduled_date: '2026-06-25', service_type: 'Weekly Mowing', recurrence_id: 'r', quote_id: null, price: 60 },
    { customer_id: 'X', status: 'completed', scheduled_date: '2026-06-18', service_type: 'Weekly Mowing', recurrence_id: 'r', quote_id: null, price: 60 },
  ],
  { r: weekly } as never, {},
  [{ customer_id: 'X', status: 'unpaid', amount: 500 }],
  DEFAULT_SEASONS, TODAY)[0]
check('overdue headline wins; both flags still present; both penalties both land',
  { score: both.score, reason: both.reason, flags: both.flags },
  { score: 34, reason: 'Overdue 20 days vs 7-day cadence', flags: ['at_risk', 'lapsed', 'unpaid'] })

// ═══════════════════════════════════════════════════════════════════════════
console.log(`\n${'═'.repeat(60)}\n  PASS ${pass}   FAIL ${fail}`)
if (fail > 0) process.exit(1)
