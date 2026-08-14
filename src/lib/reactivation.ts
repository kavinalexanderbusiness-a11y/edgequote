// ── THE customer-reactivation engine ─────────────────────────────────────────
// ONE definition of "this customer is slipping away", shared by the Reactivation
// page, Today's Priorities and the dashboard. Before this existed the same idea
// was re-derived in four places with four different rules (a cadence-ratio score,
// this page's ran-out rule, a looser no-season/no-cadence variant on the
// dashboard, and a churn heuristic in the suggestions engine) — so the same
// business could be told "3 at risk" and "8 at risk" on two screens.
//
// A REPORT, not a detector. Every threshold and every verdict comes from
// lib/signals; this file decides only how to present them. It owns no numbers.
//
// FOUR STATES, deliberately kept apart, because the difference between them is
// the difference between an emergency and a normal Tuesday:
//
//   RAN OUT  — a recurring series stopped WITHOUT an ending. Urgent regardless of
//              days-since: a weekly customer is overdue at 7 days, not 90.
//   LAPSED   — a one-off or finished customer with real history and no visit for
//              90+ days, bucketed 3+/6+/12+ months.
//   DORMANT  — ⭐ NOT LOST. Their season is over, their plan ran its agreed term,
//              or somebody cancelled the rest on purpose. Reported with the
//              reason and no urgency at all. These used to be silently dropped,
//              which is why the page could show "everything is fine" while a
//              third of the book sat unaccounted for.
//   RENEWING — the plan ended as agreed and its renewal is live. lib/renewals
//              owns them; they are excluded here so one customer is never two
//              rows saying two different things.

// Generic SupabaseClient (like lib/crm/radar) so server callers work too.
import type { SupabaseClient } from '@supabase/supabase-js'
import type { Customer } from '@/types'
import { jobVisitValue, effectiveFreq } from '@/lib/visitValue'
import {
  LAPSE_BUCKET_DAYS, VIP_LTV, cadenceDays, daysBetween as signalDaysBetween,
  isSeasonallyDormant, isVip, lifetimeValue, planRenewal, ranOut, visitValue,
  type ValueRec,
} from '@/lib/signals'
import { settingsToSeasons, type ServiceSeasons } from '@/lib/seasons'
import { localTodayISO } from '@/lib/utils'

type Supa = SupabaseClient

export interface RJob {
  customer_id: string | null; scheduled_date: string; status: string
  service_type: string | null; quote_id: string | null; recurrence_id: string | null; price: number | null
  is_initial_visit?: boolean | null
}
export interface RQuote {
  id: string; customer_id: string | null; status: string; total: number | null; service_type: string
  created_at: string; initial_price: number | null; weekly_price: number | null
  biweekly_price: number | null; monthly_price: number | null
}
/** Widened with the series' own dates: "did this plan reach the ending it was
 *  given?" cannot be answered without them, and answering it wrong is what made
 *  a finished contract read as an emergency. */
export interface RRecurrence {
  id: string; freq: string | null; interval_unit: string | null; interval_count: number | null
  start_date?: string | null; end_date?: string | null; end_count?: number | null
}

export type Bucket = '12+' | '6+' | '3+'

// Lifetime revenue at/above this marks a VIP — losing one is worth more than many
// one-off lapses, so VIPs sort to the top of every at-risk list. Re-exported from
// signals so nobody has to import two modules to agree on one line.
export const VIP_THRESHOLD = VIP_LTV

// Generic over the customer row so a caller that only needs COUNTS (the dashboard)
// can pass `{ id }` and skip fetching full customer records, while the Reactivation
// page passes real Customers and gets them back to render. Defaults to Customer,
// so existing call sites read unchanged.
export interface RiskCustomer<C = Customer> {
  customer: C
  lastServiceDate: string
  daysSince: number
  jobsCompleted: number
  lifetimeRevenue: number
  lastQuoteAmount: number
  lastServiceType: string
  potentialRecovery: number
  bucket: Bucket
  isVip: boolean
  /** The dated facts that put them here. Never a score, never a prediction. */
  evidence: string[]
}

// A recurring customer whose visit series has run dry (no future visit booked).
export interface RanOutCustomer<C = Customer> {
  customer: C
  lastServiceDate: string
  daysSince: number
  cadence: string
  perVisit: number
  lifetimeRevenue: number
  isVip: boolean
  evidence: string[]
}

/** ⭐ Quiet on purpose, and SAID so. A customer whose season is over, whose plan
 *  ran its agreed term, or whose remaining visits somebody cancelled is not a
 *  problem to solve — but they are also not nothing, and dropping them silently
 *  is how a page shows an all-clear over a book full of unanswered customers. */
export type DormantReason = 'between_seasons' | 'plan_completed' | 'ended_deliberately' | 'renewal_open'
export interface DormantCustomer<C = Customer> {
  customer: C
  reason: DormantReason
  lastServiceDate: string | null
  /** One line stating the reason as a fact. */
  note: string
}

export interface ReactivationReport<C = Customer> {
  risks: RiskCustomer<C>[]
  ranOuts: RanOutCustomer<C>[]
  /** Quiet for a stated reason. NEVER added to `atRisk`. */
  dormant: DormantCustomer<C>[]
  /** risks + ranOuts — THE "at risk" count every surface must quote. */
  atRisk: number
  potential: number
  reactivationRate: number
  revenueRecovered: number
}

export function daysBetween(aISO: string, bISO: string): number {
  return signalDaysBetween(aISO, bISO)
}

export interface ReactivationInput<C extends { id: string } = Customer> {
  customers: C[]
  jobs: RJob[]
  quotes: RQuote[]
  recById: Record<string, RRecurrence>
  seasons: ServiceSeasons
  today: string
}

// Pure — the caller supplies already-loaded rows.
export function computeReactivation<C extends { id: string } = Customer>(i: ReactivationInput<C>): ReactivationReport<C> {
  const { customers, jobs, quotes, recById, seasons, today } = i

  const jobsByCust: Record<string, RJob[]> = {}
  for (const j of jobs) if (j.customer_id) (jobsByCust[j.customer_id] ||= []).push(j)
  const quotesByCust: Record<string, RQuote[]> = {}
  for (const q of quotes) if (q.customer_id) (quotesByCust[q.customer_id] ||= []).push(q)
  const quotesById: Record<string, RQuote> = {}
  for (const q of quotes) quotesById[q.id] = q
  const valueRecs = recById as Record<string, ValueRec>

  // Reuse the ONE valuation engine for "what is this visit worth" — the same one
  // lifetimeValue uses, so an initial visit is never valued two ways on one screen.
  const jobValue = (j: RJob): number => visitValue(
    { price: j.price, quote_id: j.quote_id, recurrence_id: j.recurrence_id, is_initial_visit: !!j.is_initial_visit },
    quotesById as unknown as Record<string, unknown>,
    valueRecs,
  )

  const risks: RiskCustomer<C>[] = []
  const ranOuts: RanOutCustomer<C>[] = []
  const dormant: DormantCustomer<C>[] = []
  let reactivated = 0
  let revenueRecovered = 0

  for (const c of customers) {
    const cj = jobsByCust[c.id] || []
    const completed = cj.filter(j => j.status === 'completed').sort((a, b) => a.scheduled_date.localeCompare(b.scheduled_date))
    const upcoming = cj.some(j => j.scheduled_date >= today && (j.status === 'scheduled' || j.status === 'in_progress'))
    // Most RECENT recurring activity — find() returns arbitrary DB order and
    // can pick a dead 2024 series over the customer's current cadence.
    const recJob = cj.filter(j => j.recurrence_id).sort((a, b) => b.scheduled_date.localeCompare(a.scheduled_date))[0]
    const lifetimeRevenue = lifetimeValue(
      completed.map(j => ({ price: j.price, quote_id: j.quote_id, recurrence_id: j.recurrence_id, is_initial_visit: !!j.is_initial_visit })),
      quotesById as unknown as Record<string, unknown>,
      valueRecs,
    )
    const vip = isVip(lifetimeRevenue)

    // "Comeback" history: a gap >= 90 days then another completed job = a
    // reactivation. Runs for EVERY customer with history — including recurring
    // ran-outs below — so the Recovered metric never drops their win-backs.
    let hadComeback = false
    for (let k = 1; k < completed.length; k++) {
      if (daysBetween(completed[k - 1].scheduled_date, completed[k].scheduled_date) >= LAPSE_BUCKET_DAYS['3+']) {
        hadComeback = true
        if (daysBetween(completed[k].scheduled_date, today) <= 365) revenueRecovered += jobValue(completed[k])
      }
    }
    if (hadComeback) reactivated++

    // Last date they were ACTUALLY serviced: a completed visit, else any
    // non-cancelled, non-future one. A series cancelled before any service isn't
    // a re-book candidate.
    const pastReal = cj
      .filter(j => j.status !== 'cancelled' && j.scheduled_date <= today)
      .map(j => j.scheduled_date).sort()
    const lastDate = completed.length ? completed[completed.length - 1].scheduled_date
      : (pastReal.length ? pastReal[pastReal.length - 1] : null)
    const recService = recJob?.service_type ?? completed[completed.length - 1]?.service_type ?? null
    const rec = recJob?.recurrence_id ? recById[recJob.recurrence_id] : null
    const freq = rec ? effectiveFreq(rec.freq, rec.interval_unit, rec.interval_count) : null

    // ── Did their most recent plan reach the ending it was GIVEN? ────────────
    // ⭐ Resolved by lib/signals' planRenewal — the SAME call lib/renewals makes,
    // with the same inputs. Two engines each deciding "was this plan finished or
    // did it fall over" is how one customer ends up urgent on one screen and
    // calm on another; there is one answer and this is where it comes from.
    const series = recJob?.recurrence_id ? cj.filter(j => j.recurrence_id === recJob.recurrence_id) : []
    const seriesLive = series.filter(j => j.status !== 'cancelled')
    const plan = rec && seriesLive.length
      ? planRenewal({
          planStart: rec.start_date || [...seriesLive.map(j => j.scheduled_date)].sort()[0],
          liveDates: seriesLive.map(j => j.scheduled_date),
          cancelledDates: series.filter(j => j.status === 'cancelled').map(j => j.scheduled_date),
          completedCount: series.filter(j => j.status === 'completed').length,
          endDate: rec.end_date ?? null,
          endCount: rec.end_count ?? null,
          serviceType: recService,
          cadence: freq,
          interval: rec,
          customerHasFutureVisit: upcoming,
        }, seasons, today)
      : null

    // THE ran-out detector — one rule, shared with the dashboard and the weekly
    // review, so the same customer can't read as adrift on one screen and
    // dormant on another.
    const signal = ranOut({
      hasRecurring: !!recJob,
      hasUpcoming: upcoming,
      lastServiceDate: lastDate,
      cadenceDays: cadenceDays(freq, rec),
      seasonallyDormant: isSeasonallyDormant(recService, seasons, today),
      // ⭐ A plan that finished as agreed is not a plan that fell over.
      plannedEnd: !!plan?.hasPlannedEnd || !!plan?.endedByCancellation,
      today,
    })

    // ── Quiet for a stated reason ───────────────────────────────────────────
    // Every one of these used to be a bare `continue`. Silence is what an
    // all-clear is made of, so each now leaves a row that says why.
    //
    // ⛔ INTENTIONALLY ENDED ≠ URGENT. A finished season, an agreed term, and a
    // cancelled remainder are three ways of saying "this stopped on purpose" —
    // none of them is a lost customer.
    //
    // The reasons are ordered by what is most USEFUL to read, not by which
    // suppression happened to fire first. "Their renewal is on the renewals
    // list" tells the owner where to look; "they're between seasons" would be
    // true at the same moment and would send them nowhere.
    if (signal.reason === 'never_serviced') continue // never a customer of this plan — nothing true to say
    if (signal.reason === 'seasonally_dormant' || signal.reason === 'plan_completed') {
      const renewalOpen = !!plan?.signal.isDue
      const reason: DormantReason = renewalOpen ? 'renewal_open'
        : plan?.endedByCancellation ? 'ended_deliberately'
        : signal.reason === 'seasonally_dormant' ? 'between_seasons'
        : 'plan_completed'
      dormant.push({ customer: c, reason, lastServiceDate: lastDate, note: dormantNote(reason, recService) })
      // Out of season, or renewing: either way there is nothing to chase. A
      // live renewal in particular means lib/renewals is already showing this
      // customer with a price and an action — falling through to the lapse
      // buckets would print them twice, in two tones, on one page.
      if (renewalOpen || signal.reason === 'seasonally_dormant') continue
    }

    // RAN-OUT (urgent): a recurring customer with no future visit booked. Caught
    // regardless of days-since, so it can't slip through the 90-day buckets. Past
    // ~3 cadences the series isn't plausibly active — those fall through to the
    // normal buckets instead of sitting in the red queue forever.
    if (signal.isRanOut && signal.isUrgent && lastDate && recJob) {
      // Per-visit at stake = the CURRENT quote cadence price (source of truth),
      // never an arbitrary visit's frozen historical override.
      const q = recJob.quote_id ? quotesById[recJob.quote_id] : null
      const perVisit = q
        ? Math.round(jobVisitValue(null, q as unknown as Record<string, unknown>, freq))
        : Math.round(jobValue(recJob))
      ranOuts.push({
        customer: c, lastServiceDate: lastDate, daysSince: signal.daysSince ?? 0,
        cadence: freq || 'recurring', perVisit, lifetimeRevenue, isVip: vip,
        evidence: [
          `${freq || 'Recurring'} plan, last served ${lastDate}`,
          'No visit booked today or later, and the plan was never given an end date',
          `Still inside ${cadenceDays(freq, rec)}-day cadence × 3 — a re-book, not a lapse`,
        ],
      })
      continue
    }

    if (completed.length === 0) continue // only customers with real service history
    const lastServiceDate = completed[completed.length - 1].scheduled_date
    const days = daysBetween(lastServiceDate, today)

    if (!upcoming && days >= LAPSE_BUCKET_DAYS['3+']) {
      // A DECLINED quote is not recoverable revenue — don't let a rejected
      // $4,000 hedge job inflate "Potential recovery".
      const cq = (quotesByCust[c.id] || []).filter(q => q.status !== 'declined').sort((a, b) => b.created_at.localeCompare(a.created_at))
      const lastQuoteAmount = cq.length ? Number(cq[0].total) || 0 : 0
      const avgValue = completed.length ? lifetimeRevenue / completed.length : 0
      risks.push({
        customer: c,
        lastServiceDate,
        daysSince: days,
        jobsCompleted: completed.length,
        lifetimeRevenue,
        lastQuoteAmount,
        lastServiceType: completed[completed.length - 1].service_type || cq[0]?.service_type || 'their usual service',
        potentialRecovery: lastQuoteAmount || Math.round(avgValue),
        bucket: days >= LAPSE_BUCKET_DAYS['12+'] ? '12+' : days >= LAPSE_BUCKET_DAYS['6+'] ? '6+' : '3+',
        isVip: vip,
        evidence: [
          `Last served ${lastServiceDate} — ${days} days ago`,
          `${completed.length} visit${completed.length !== 1 ? 's' : ''} delivered, so this is a customer, not a lead`,
          'Nothing booked today or later',
        ],
      })
    }
  }

  const order: Record<Bucket, number> = { '12+': 0, '6+': 1, '3+': 2 }
  // VIPs first within each bucket, then most-lapsed.
  risks.sort((a, b) => order[a.bucket] - order[b.bucket] || Number(b.isVip) - Number(a.isVip) || b.daysSince - a.daysSince)
  ranOuts.sort((a, b) => Number(b.isVip) - Number(a.isVip) || b.perVisit - a.perVisit || b.daysSince - a.daysSince)
  // Headline metrics include the urgent ran-out queue — 5 ran-dry recurring
  // customers with "At risk: 0" above them reads as a broken page. `dormant` is
  // deliberately NOT counted: they are quiet for a reason, and a count that
  // inflates itself with them is the false alarm this whole file guards against.
  const potential = risks.reduce((s, r) => s + r.potentialRecovery, 0) + ranOuts.reduce((s, r) => s + r.perVisit, 0)
  const atRisk = risks.length + ranOuts.length
  const reactivationRate = (reactivated + atRisk) > 0 ? Math.round((reactivated / (reactivated + atRisk)) * 100) : 0

  return { risks, ranOuts, dormant, atRisk, potential, reactivationRate, revenueRecovered }
}

function dormantNote(reason: DormantReason, service: string | null): string {
  const svc = service || 'their service'
  if (reason === 'between_seasons') return `${svc} is out of season — they come back when it returns`
  if (reason === 'ended_deliberately') return `The rest of their ${svc} plan was cancelled — ended on purpose`
  if (reason === 'renewal_open') return `Their ${svc} plan finished — the renewal is on the renewals list`
  return `Their ${svc} plan ran its full term and finished`
}

// ── Loader ───────────────────────────────────────────────────────────────────
// A failed read is not an answer. supabase-js RESOLVES with { data: null, error }
// on a dead connection, so `|| []` turns a network blip into "every customer is
// booked or recently served" — a confident all-clear about churn, manufactured by
// a dropped socket. There is no `report` field on the failure branch, so a caller
// cannot render the reassuring empty state from one.
export type ReactivationLoad<C = Customer> =
  | { ok: true; report: ReactivationReport<C> }
  | { ok: false; error: string }

export async function loadReactivation(sb: Supa): Promise<ReactivationLoad> {
  const { data: { session } } = await sb.auth.getSession()
  const user = session?.user
  if (!user) return { ok: false, error: 'Not signed in' }

  const [cRes, jRes, qRes, rRes, sRes] = await Promise.all([
    // don't suggest re-engaging deliberately-archived customers
    sb.from('customers').select('*').eq('user_id', user.id).is('archived_at', null),
    sb.from('jobs').select('customer_id, scheduled_date, status, service_type, quote_id, recurrence_id, price, is_initial_visit').eq('user_id', user.id),
    sb.from('quotes').select('id, customer_id, status, total, service_type, created_at, initial_price, weekly_price, biweekly_price, monthly_price').eq('user_id', user.id),
    sb.from('job_recurrences').select('id, freq, interval_unit, interval_count, start_date, end_date, end_count').eq('user_id', user.id),
    sb.from('business_settings').select('service_seasons').eq('user_id', user.id).maybeSingle(),
  ])

  // Each of these changes the ANSWER rather than trimming it: no customers →
  // "all clear"; no jobs → everybody lapsed; no recurrences → every finished
  // plan reads as one that fell over; no seasons → the wrong season under every
  // verdict on the page.
  const failed = [cRes, jRes, qRes, rRes, sRes].find(r => r.error)
  if (failed?.error) return { ok: false, error: failed.error.message }

  const recById: Record<string, RRecurrence> = {}
  for (const r of (rRes.data as RRecurrence[]) || []) recById[r.id] = r

  return {
    ok: true,
    report: computeReactivation({
      customers: (cRes.data as Customer[]) || [],
      jobs: (jRes.data as RJob[]) || [],
      quotes: (qRes.data as RQuote[]) || [],
      recById,
      seasons: settingsToSeasons((sRes.data as { service_seasons: unknown } | null)?.service_seasons),
      today: localTodayISO(),
    }),
  }
}
