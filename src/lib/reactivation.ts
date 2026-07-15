// ── THE customer-reactivation engine ─────────────────────────────────────────
// ONE definition of "this customer is slipping away", shared by the Reactivation
// page, Today's Priorities and the dashboard. Before this existed the same idea
// was re-derived in four places with four different rules (a cadence-ratio score,
// this page's ran-out rule, a looser no-season/no-cadence variant on the
// dashboard, and a churn heuristic in the suggestions engine) — so the same
// business could be told "3 at risk" and "8 at risk" on two screens.
//
// Two distinct states, deliberately kept apart:
//   RAN OUT — a RECURRING series with no future visit booked. Urgent regardless
//             of days-since: a weekly customer is overdue at 7 days, not 90.
//   LAPSED  — a one-off/ended customer with real history and no visit for 90+
//             days, bucketed 3+/6+/12+ months.
//
// Pure core + loader, mirroring lib/customerHealth.ts. Valuation always defers to
// the ONE pricing engine (jobVisitValue/effectiveFreq) — no money math lives here.

// Generic SupabaseClient (like lib/crm/radar) so server callers work too.
import type { SupabaseClient } from '@supabase/supabase-js'
import type { Customer } from '@/types'
import { jobVisitValue, effectiveFreq } from '@/lib/invoicing'
import { seasonForService, isWithinSeason, settingsToSeasons, type ServiceSeasons } from '@/lib/seasons'
import { localTodayISO } from '@/lib/utils'

type Supa = SupabaseClient

export interface RJob {
  customer_id: string | null; scheduled_date: string; status: string
  service_type: string | null; quote_id: string | null; recurrence_id: string | null; price: number | null
}
export interface RQuote {
  id: string; customer_id: string | null; status: string; total: number | null; service_type: string
  created_at: string; initial_price: number | null; weekly_price: number | null
  biweekly_price: number | null; monthly_price: number | null
}
export interface RRecurrence { id: string; freq: string | null; interval_unit: string | null; interval_count: number | null }

export type Bucket = '12+' | '6+' | '3+'

// Lifetime revenue at/above this marks a VIP — losing one is worth more than many
// one-off lapses, so VIPs sort to the top of every at-risk list.
export const VIP_THRESHOLD = 1500

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
}

export interface ReactivationReport<C = Customer> {
  risks: RiskCustomer<C>[]
  ranOuts: RanOutCustomer<C>[]
  /** risks + ranOuts — THE "at risk" count every surface must quote. */
  atRisk: number
  potential: number
  reactivationRate: number
  revenueRecovered: number
}

export function daysBetween(aISO: string, bISO: string): number {
  return Math.floor((new Date(bISO + 'T00:00:00').getTime() - new Date(aISO + 'T00:00:00').getTime()) / 86400000)
}

export interface ReactivationInput<C extends { id: string } = Customer> {
  customers: C[]
  jobs: RJob[]
  quotes: RQuote[]
  recById: Record<string, RRecurrence>
  seasons: ServiceSeasons
  today: string
}

// Pure — the caller supplies already-loaded rows. Lifted verbatim from the
// Reactivation page (it was the canonical rule); behaviour intentionally unchanged.
export function computeReactivation<C extends { id: string } = Customer>(i: ReactivationInput<C>): ReactivationReport<C> {
  const { customers, jobs, quotes, recById, seasons, today } = i

  const jobsByCust: Record<string, RJob[]> = {}
  for (const j of jobs) if (j.customer_id) (jobsByCust[j.customer_id] ||= []).push(j)
  const quotesByCust: Record<string, RQuote[]> = {}
  for (const q of quotes) if (q.customer_id) (quotesByCust[q.customer_id] ||= []).push(q)
  const quotesById: Record<string, RQuote> = {}
  for (const q of quotes) quotesById[q.id] = q

  // Reuse the ONE valuation engine for "what is this visit worth".
  const jobValue = (j: RJob): number => {
    const q = j.quote_id ? quotesById[j.quote_id] : null
    const rec = j.recurrence_id ? recById[j.recurrence_id] : null
    const freq = rec ? effectiveFreq(rec.freq, rec.interval_unit, rec.interval_count) : null
    return jobVisitValue(j.price, q as unknown as Record<string, unknown>, freq)
  }

  const risks: RiskCustomer<C>[] = []
  const ranOuts: RanOutCustomer<C>[] = []
  let reactivated = 0
  let revenueRecovered = 0

  for (const c of customers) {
    const cj = jobsByCust[c.id] || []
    const completed = cj.filter(j => j.status === 'completed').sort((a, b) => a.scheduled_date.localeCompare(b.scheduled_date))
    const upcoming = cj.some(j => j.scheduled_date >= today && (j.status === 'scheduled' || j.status === 'in_progress'))
    // Most RECENT recurring activity — find() returns arbitrary DB order and
    // can pick a dead 2024 series over the customer's current cadence.
    const recJob = cj.filter(j => j.recurrence_id).sort((a, b) => b.scheduled_date.localeCompare(a.scheduled_date))[0]
    const lifetimeRevenue = completed.reduce((s, j) => s + jobValue(j), 0)
    const isVip = lifetimeRevenue >= VIP_THRESHOLD

    // "Comeback" history: a gap >= 90 days then another completed job = a
    // reactivation. Runs for EVERY customer with history — including recurring
    // ran-outs below — so the Recovered metric never drops their win-backs.
    let hadComeback = false
    for (let k = 1; k < completed.length; k++) {
      if (daysBetween(completed[k - 1].scheduled_date, completed[k].scheduled_date) >= 90) {
        hadComeback = true
        if (daysBetween(completed[k].scheduled_date, today) <= 365) revenueRecovered += jobValue(completed[k])
      }
    }
    if (hadComeback) reactivated++

    // SEASONAL DORMANCY: a recurring lawn/snow customer whose series ended
    // because the SEASON ended is not lost — they're dormant until next season.
    // Suppress them while we're OUT of their service season; they resurface once
    // the season returns and they STILL have no schedule.
    const recService = recJob?.service_type ?? completed[completed.length - 1]?.service_type ?? null
    const recSeason = recJob ? seasonForService(recService, seasons) : null
    const seasonallyDormant = !!recSeason && !isWithinSeason(today, recSeason)
    if (recJob && !upcoming && seasonallyDormant) {
      continue // off-season — don't treat a naturally-ended seasonal series as lost
    }

    // RAN-OUT (urgent): a recurring customer with no future visit booked. Caught
    // here regardless of days-since, so it can't slip through the 90-day buckets.
    // Only customers actually visited (a non-cancelled, non-future visit) — a
    // series cancelled before any service isn't a re-book.
    if (recJob && !upcoming) {
      const pastReal = cj
        .filter(j => j.status !== 'cancelled' && j.scheduled_date <= today)
        .map(j => j.scheduled_date).sort()
      const lastDate = completed.length ? completed[completed.length - 1].scheduled_date
        : (pastReal.length ? pastReal[pastReal.length - 1] : null)
      if (lastDate) {
        const rec = recJob.recurrence_id ? recById[recJob.recurrence_id] : null
        const freq = rec ? effectiveFreq(rec.freq, rec.interval_unit, rec.interval_count) : null
        // Urgent re-book ONLY while the series is plausibly still active — past
        // ~3 cadences they're a lapsed customer and age into the buckets below
        // instead of sitting in the red queue forever.
        const cadDays = rec?.interval_unit === 'day' ? Math.max(1, rec.interval_count ?? 1)
          : rec?.interval_unit === 'week' ? 7 * Math.max(1, rec.interval_count ?? 1)
          : rec?.interval_unit === 'month' ? 30 * Math.max(1, rec.interval_count ?? 1)
          : freq === 'weekly' ? 7 : freq === 'biweekly' ? 14 : freq === 'monthly' ? 30 : 14
        const daysSince = Math.max(0, daysBetween(lastDate, today))
        if (daysSince <= Math.max(21, cadDays * 3)) {
          // Per-visit at stake = the CURRENT quote cadence price (source of truth),
          // never an arbitrary visit's frozen historical override.
          const q = recJob.quote_id ? quotesById[recJob.quote_id] : null
          const perVisit = q
            ? Math.round(jobVisitValue(null, q as unknown as Record<string, unknown>, freq))
            : Math.round(jobValue(recJob))
          ranOuts.push({
            customer: c, lastServiceDate: lastDate, daysSince,
            cadence: freq || 'recurring', perVisit, lifetimeRevenue, isVip,
          })
          continue
        }
        // fall through: long-dead series → ordinary lapse buckets
      } else {
        continue // never actually serviced — not a re-book candidate
      }
    }

    if (completed.length === 0) continue // only customers with real service history
    const lastServiceDate = completed[completed.length - 1].scheduled_date
    const days = daysBetween(lastServiceDate, today)

    if (!upcoming && days >= 90) {
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
        lastServiceType: completed[completed.length - 1].service_type || cq[0]?.service_type || 'Lawn Mowing',
        potentialRecovery: lastQuoteAmount || Math.round(avgValue),
        bucket: days >= 365 ? '12+' : days >= 180 ? '6+' : '3+',
        isVip,
      })
    }
  }

  const order: Record<Bucket, number> = { '12+': 0, '6+': 1, '3+': 2 }
  // VIPs first within each bucket, then most-lapsed.
  risks.sort((a, b) => order[a.bucket] - order[b.bucket] || Number(b.isVip) - Number(a.isVip) || b.daysSince - a.daysSince)
  ranOuts.sort((a, b) => Number(b.isVip) - Number(a.isVip) || b.perVisit - a.perVisit || b.daysSince - a.daysSince)
  // Headline metrics include the urgent ran-out queue — 5 ran-dry recurring
  // customers with "At risk: 0" above them reads as a broken page.
  const potential = risks.reduce((s, r) => s + r.potentialRecovery, 0) + ranOuts.reduce((s, r) => s + r.perVisit, 0)
  const atRisk = risks.length + ranOuts.length
  const reactivationRate = (reactivated + atRisk) > 0 ? Math.round((reactivated / (reactivated + atRisk)) * 100) : 0

  return { risks, ranOuts, atRisk, potential, reactivationRate, revenueRecovered }
}

// Loader — the five reads the Reactivation page already issued, nothing new.
export async function loadReactivation(sb: Supa): Promise<ReactivationReport> {
  const { data: { session } } = await sb.auth.getSession()
  const user = session?.user
  if (!user) return { risks: [], ranOuts: [], atRisk: 0, potential: 0, reactivationRate: 0, revenueRecovered: 0 }

  const [cRes, jRes, qRes, rRes, sRes] = await Promise.all([
    // don't suggest re-engaging deliberately-archived customers
    sb.from('customers').select('*').eq('user_id', user.id).is('archived_at', null),
    sb.from('jobs').select('customer_id, scheduled_date, status, service_type, quote_id, recurrence_id, price').eq('user_id', user.id),
    sb.from('quotes').select('id, customer_id, status, total, service_type, created_at, initial_price, weekly_price, biweekly_price, monthly_price').eq('user_id', user.id),
    sb.from('job_recurrences').select('id, freq, interval_unit, interval_count').eq('user_id', user.id),
    sb.from('business_settings').select('service_seasons').eq('user_id', user.id).maybeSingle(),
  ])

  const recById: Record<string, RRecurrence> = {}
  for (const r of (rRes.data as RRecurrence[]) || []) recById[r.id] = r

  return computeReactivation({
    customers: (cRes.data as Customer[]) || [],
    jobs: (jRes.data as RJob[]) || [],
    quotes: (qRes.data as RQuote[]) || [],
    recById,
    seasons: settingsToSeasons((sRes.data as { service_seasons: unknown } | null)?.service_seasons),
    today: localTodayISO(),
  })
}
