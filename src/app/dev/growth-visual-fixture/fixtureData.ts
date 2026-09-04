// ── Synthetic rows for the Growth visual fixture ─────────────────────────────
//
// ⛔ ROWS, NOT A REPORT. Nothing here hand-builds an Opportunity, a score, a
// share or a sentence. These are raw jobs / customers / recurrences of exactly
// the shape `loadRevenueIntel` hands the engine, and `buildFixture()` runs the
// REAL `computeRevenueIntel` over them — so every figure the fixture shows was
// produced by the shipping engine and the shipping evidence gate, not typed in.
//
// ⛔ NEVER PERSISTED. This module has no database client, and nothing imports
// it outside the dev-only route (src/app/dev/growth-visual-fixture) and its
// guard. That is also why the names carry NO `ZZ` / `fixture` marker: the
// evidence gate (lib/growthEvidence.looksLikeFixture, and lib/fixtureData once
// S114 lands) EXCLUDES marker-named visits from every figure — correctly —
// which would leave this book with nothing to show. Marker names exist so
// persisted rows can be found and deleted; nothing here is ever written.
//
// The four things the browser proof must see, and which rows produce each:
//   1. CONCENTRATION — `ANCHOR` at $1,900 bi-weekly dominates a book of small
//      customers ⇒ the disclosure banner fires through the real threshold with
//      the real multi-customer sentence ("… across N customers").
//   2. UNQUANTIFIED — `THIN` has a live weekly series but only two priced
//      visits ⇒ the gate refuses a figure ("Not enough reliable data") and the
//      headline caveat "… without enough data" renders on the Recurring tile.
//   3. LONG NAMES — `ANCHOR` is a long spaced name (must wrap); `UNBROKEN` is a
//      long single token with no break opportunity (imported-record style),
//      the shape most likely to overflow a 375px column.
//   4. PRIORITY SCORE — `UNBROKEN` is built to score exactly 61 (55 base + 6
//      for 3+ visits, nothing else): the audited value the honesty fix was
//      about, so the chip under test reads "61/100".

import { computeRevenueIntel, type RevenueIntelReport, type FeedbackRow } from '@/lib/revenueIntelligence'
import type { ProfitJob, ProfitQuote, RecInfo } from '@/lib/profitability'
import { DEFAULT_SEASONS } from '@/lib/seasons'

/** Pinned, so the engine's tenure / churn / season arithmetic is deterministic. */
export const FIXTURE_TODAY = '2026-09-04'

export const ANCHOR = { id: 'fx-anchor', name: 'Northgate Commercial Property Management Group Ltd.' } as const
export const UNBROKEN = { id: 'fx-unbroken', name: 'Riverbend_Property_Services_Imported_Account_000042' } as const
export const SLIPPING = { id: 'fx-slipping', name: 'Westbrook Lane Residence' } as const
export const THIN = { id: 'fx-thin', name: 'Maple & Birch Household' } as const

/** The audited case: 55 (renewal base) + 6 (3+ completed visits). */
export const AUDITED_SCORE = 61

function job(id: string, customer_id: string, scheduled_date: string, price: number, recurrence_id: string, status = 'completed'): ProfitJob {
  return {
    id, scheduled_date, status, service_type: 'Lawn Mowing', quote_id: null, recurrence_id,
    duration_minutes: 45, actual_minutes: null, price, lat: null, lng: null, city: null, postal_code: null,
    neighborhood: null, customer_id,
  }
}

const weekly: RecInfo = { freq: 'weekly', interval_unit: 'week', interval_count: 1 }
const biweekly: RecInfo = { freq: 'biweekly', interval_unit: 'week', interval_count: 2 }

const jobs: ProfitJob[] = [
  // ANCHOR — six bi-weekly visits at $1,900, the next one booked. Six completed
  // ⇒ +12 on the renewal score; a 2024 start ⇒ +15; on cadence ⇒ no churn penalty.
  job('a1', ANCHOR.id, '2026-06-19', 1900, 'rec-anchor'),
  job('a2', ANCHOR.id, '2026-07-03', 1900, 'rec-anchor'),
  job('a3', ANCHOR.id, '2026-07-17', 1900, 'rec-anchor'),
  job('a4', ANCHOR.id, '2026-07-31', 1900, 'rec-anchor'),
  job('a5', ANCHOR.id, '2026-08-14', 1900, 'rec-anchor'),
  job('a6', ANCHOR.id, '2026-08-28', 1900, 'rec-anchor'),
  job('a7', ANCHOR.id, '2026-09-11', 1900, 'rec-anchor', 'scheduled'),
  // UNBROKEN — four weekly $70 visits, on cadence, next one booked, three
  // months' tenure. Renewal score: 55 + 6 (3+ visits) and nothing else = 61.
  job('u1', UNBROKEN.id, '2026-08-07', 70, 'rec-unbroken'),
  job('u2', UNBROKEN.id, '2026-08-14', 70, 'rec-unbroken'),
  job('u3', UNBROKEN.id, '2026-08-21', 70, 'rec-unbroken'),
  job('u4', UNBROKEN.id, '2026-08-28', 70, 'rec-unbroken'),
  job('u5', UNBROKEN.id, '2026-09-05', 70, 'rec-unbroken', 'scheduled'),
  // SLIPPING — weekly at $120, three visits, then five weeks with nothing
  // completed although a visit is booked: 35 days ÷ 7 ⇒ churn "high". Feeds
  // the "Revenue at churn risk" tile and the at-risk pill in the LTV forecast.
  job('s1', SLIPPING.id, '2026-07-17', 120, 'rec-slipping'),
  job('s2', SLIPPING.id, '2026-07-24', 120, 'rec-slipping'),
  job('s3', SLIPPING.id, '2026-07-31', 120, 'rec-slipping'),
  job('s4', SLIPPING.id, '2026-09-12', 120, 'rec-slipping', 'scheduled'),
  // THIN — a live weekly series with only TWO priced visits: below
  // MIN_VISITS_FOR_VALUE, so the evidence gate refuses to put a figure on it.
  job('t1', THIN.id, '2026-08-21', 90, 'rec-thin'),
  job('t2', THIN.id, '2026-08-28', 90, 'rec-thin'),
  job('t3', THIN.id, '2026-09-05', 90, 'rec-thin', 'scheduled'),
]

const customers = [
  { id: ANCHOR.id, name: ANCHOR.name, created_at: '2024-03-01', referred_by_customer_id: null },
  { id: UNBROKEN.id, name: UNBROKEN.name, created_at: '2026-06-01', referred_by_customer_id: null },
  { id: SLIPPING.id, name: SLIPPING.name, created_at: '2026-04-01', referred_by_customer_id: null },
  { id: THIN.id, name: THIN.name, created_at: '2026-08-01', referred_by_customer_id: null },
]

const recurrences: Record<string, RecInfo> = {
  'rec-anchor': biweekly, 'rec-unbroken': weekly, 'rec-slipping': weekly, 'rec-thin': weekly,
}

export interface GrowthFixture {
  report: RevenueIntelReport
  feedback: Record<string, FeedbackRow>
}

/** The REAL engine over the rows above, plus two recorded decisions. */
export function buildFixture(): GrowthFixture {
  const report = computeRevenueIntel({
    jobs,
    pctx: { quotesById: {} as Record<string, ProfitQuote>, recById: recurrences, base: null, today: FIXTURE_TODAY },
    customers, properties: [], recurrences, invoices: [], lineItems: [], jobCustomerById: {},
    seasons: DEFAULT_SEASONS, capacityHours: 8, preferredDays: [1, 2, 3, 4, 5], today: FIXTURE_TODAY,
  })

  // Two recorded decisions, keyed exactly as the page keys them, so the
  // "Value marked won" tile, the won-styled card and the Acted state all
  // render. ⭐ The won row's `result_value` IS the forecast — that is the seam
  // the "marked won, not collected" label fix was about, reproduced faithfully.
  const won = report.opportunities.find(o => o.key === `referral:${UNBROKEN.id}`)
  const acted = report.opportunities.find(o => o.key === `renewal:${SLIPPING.id}`)
  const feedback: Record<string, FeedbackRow> = {}
  if (won) feedback[won.key] = { opportunity_key: won.key, kind: won.kind, status: 'won', expected_value: won.expectedValue, result_value: won.expectedValue }
  if (acted) feedback[acted.key] = { opportunity_key: acted.key, kind: acted.kind, status: 'acted', expected_value: acted.expectedValue, result_value: null }
  return { report, feedback }
}

/** What a reviewer should see, in the order the screen shows it. */
export const SCENARIOS: readonly { id: string; expect: string }[] = [
  { id: 'caveat', expect: 'Recurring opportunity tile: the "… without enough data" caveat is fully visible at 375px, not clipped to "…".' },
  { id: 'concentration', expect: `Warning banner names ${ANCHOR.name} as the dominant share of the projection and wraps cleanly.` },
  { id: 'score', expect: `Top move and every card show "Priority score N/100" / "N/100" — never "N%" or "likely". One card scores exactly ${AUDITED_SCORE}.` },
  { id: 'refusal', expect: `${THIN.name} shows "Not enough reliable data" instead of a figure; its Why? panel says why.` },
  { id: 'unbroken', expect: `${UNBROKEN.name} (no spaces) must not push the card or page wider than the viewport.` },
  { id: 'won', expect: 'One card is marked Won and one Acted; the "Value marked won" tile equals the won card\'s forecast, and says "marked won", not revenue.' },
]
