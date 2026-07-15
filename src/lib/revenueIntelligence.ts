import type { SupabaseClient } from '@supabase/supabase-js'
import { localTodayISO } from '@/lib/utils'
import { effectiveFreq, jobVisitValue } from '@/lib/invoicing'
import { SEASON_VISITS } from '@/lib/pricing'
import { serviceCategory, seasonForService, isWithinSeason, settingsToSeasons, ServiceSeasons } from '@/lib/seasons'
import { densityFor, locatedStops, DensityTier } from '@/lib/routeDensity'
import { normalizeServiceKey, isRecurringProgramService } from '@/lib/jobPricing'
import { Coord } from '@/lib/geo'
import { neighborhoodKey, ProfitJob, ProfitContext, ProfitQuote, RecInfo } from '@/lib/profitability'
import { VIP_LTV, cadenceDays, churnRisk, daysBetween, lifetimeValue, type ChurnRisk } from '@/lib/signals'

// ── Revenue Intelligence engine (Growth) ────────────────────────────────────────
// Predictive + prescriptive layer on top of the BI dashboard. Scores every
// customer for the moves that grow revenue — renewal, upsell, cross-sell,
// membership conversion, referral — and forecasts lifetime value. Each prediction
// is an ACTION (why + recommended action + expected $ + confidence), and the whole
// book is ranked by expected revenue impact so the owner sees the top moves first.
// COMPOSITION ONLY — reuses the valuation, seasons, density and line-item engines;
// no new pricing/valuation math. A feedback table closes the loop (recommendation
// → action → result) so the ranking learns what actually converts.

export type OppKind = 'renewal' | 'upsell' | 'cross_sell' | 'membership' | 'referral' | 'reactivation'
export type Confidence = 'high' | 'medium' | 'low'
export const OPP_META: Record<OppKind, { label: string; emoji: string }> = {
  renewal: { label: 'Renewal', emoji: '🔄' },
  upsell: { label: 'Upsell', emoji: '➕' },
  cross_sell: { label: 'Cross-sell', emoji: '🔁' },
  membership: { label: 'Membership', emoji: '⭐' },
  referral: { label: 'Referral', emoji: '🤝' },
  reactivation: { label: 'Win-back', emoji: '🎯' },
}
const CONF_WEIGHT: Record<Confidence, number> = { high: 1, medium: 0.7, low: 0.45 }

export interface Opportunity {
  key: string           // `${kind}:${customerId}` — stable, also the feedback key
  kind: OppKind
  customerId: string
  customerName: string
  score: number         // 0..100 likelihood
  confidence: Confidence
  expectedValue: number // $ (annual unless oneTime)
  oneTime: boolean
  rankValue: number     // expectedValue × confidence × one-time penalty — the business ranking
  why: string[]
  action: string        // recommended action (one line)
  actionHref: string    // where the owner goes to do it
  offer?: string        // recommended offer (upsell/cross-sell)
}

export interface LtvForecast {
  customerId: string
  customerName: string
  currentLtv: number
  forecastLtv: number
  revenueRemaining: number
  churnRiskImpact: number // annual recurring × churn probability
  churnRisk: Confidence   // high = most at risk
}

// Reserved hooks so the future Smart Labor Calculator / forecasting / crew &
// capacity planning can plug in without reshaping this engine.
export interface LaborContext {
  capacityHoursPerDay: number
  preferredDays: number[]
  bookedHoursNext2wk: number
  estimatedHoursPerWeek: number
}

export interface RevenueIntelReport {
  opportunities: Opportunity[]   // ranked by rankValue desc
  ltvForecast: LtvForecast[]     // ranked by revenueRemaining / churn risk
  summary: {
    totalOpportunity: number       // Σ recurring expected value
    totalOneTime: number
    byKind: Record<OppKind, { count: number; value: number }>
    topAction: Opportunity | null
  }
  labor: LaborContext
}

const round = (n: number) => Math.round(n)
const round5 = (n: number) => Math.round(n / 5) * 5
const clamp = (n: number, lo = 0, hi = 100) => Math.max(lo, Math.min(hi, n))
const SEASON_VISITS_BIWEEKLY = SEASON_VISITS.biweekly

// NOTE: jobs here deliberately do NOT carry `is_initial_visit`, so lifetimeValue
// prices a first visit at the recurring rate — this engine's long-standing
// behaviour. customerHealth DOES carry it and prices the initial rate, so the two
// disagree on LTV for any customer whose first visit was priced differently.
// Aligning them is a pending product decision (it moves LTV, the VIP gate and
// every ltv-derived figure), so nothing here supplies the field yet.
type RIJob = ProfitJob

interface RIInput {
  jobs: RIJob[]
  pctx: ProfitContext
  customers: { id: string; name: string; created_at: string; referred_by_customer_id: string | null }[]
  properties: { id: string; customer_id: string; lat: number | null; lng: number | null; postal_code: string | null; city: string | null; neighborhood: string | null }[]
  recurrences: Record<string, RecInfo>
  invoices: { status: string; amount: number | null; customer_id: string | null }[]
  lineItems: { job_id: string; description: string; amount: number | null; service_key: string | null }[]
  jobCustomerById: Record<string, string | null> // job_id → customer_id (for line items)
  seasons: ServiceSeasons
  capacityHours: number
  preferredDays: number[]
  today: string
}

// Per-customer rollup — one pass, the basis for every predictor.
interface Agg {
  id: string
  name: string
  tenureDays: number
  completedCount: number
  lastCompleted: string | null
  ltv: number
  cats: Set<string>            // service categories ever serviced
  hasActiveRecurring: boolean
  cadence: string | null
  perVisit: number             // representative recurring per-visit value
  annualRecurring: number
  recServiceType: string | null
  futureBooked: boolean
  unpaidCount: number
  isReferrer: boolean
  prop?: { lat: number | null; lng: number | null; postal_code: string | null; city: string | null; neighborhood: string | null }
  addOns: Set<string>          // normalized add-on keys this customer buys
  churn: ChurnRisk             // how far past their own cadence (recurring only)
  inSeason: boolean
}

function visitsPerSeason(cadence: string | null): number {
  if (cadence === 'weekly') return SEASON_VISITS.weekly
  if (cadence === 'biweekly') return SEASON_VISITS.biweekly
  if (cadence === 'monthly') return SEASON_VISITS.monthly
  return SEASON_VISITS_BIWEEKLY
}

export function computeRevenueIntel(inp: RIInput): RevenueIntelReport {
  const { jobs, pctx, customers, properties, recurrences, invoices, lineItems, jobCustomerById, seasons, capacityHours, preferredDays, today } = inp
  const dDays = (iso: string) => daysBetween(iso, today)

  const propByCust: Record<string, RIInput['properties'][number]> = {}
  for (const p of properties) if (p.customer_id && !propByCust[p.customer_id]) propByCust[p.customer_id] = p
  const unpaidByCust: Record<string, number> = {}
  for (const inv of invoices) if (inv.customer_id && (inv.status === 'unpaid' || inv.status === 'sent')) unpaidByCust[inv.customer_id] = (unpaidByCust[inv.customer_id] || 0) + 1
  const referrers = new Set<string>()
  for (const c of customers) if (c.referred_by_customer_id) referrers.add(c.referred_by_customer_id)

  // Add-on penetration (lawn customers) — for upsell targeting.
  const addOnByCust: Record<string, Set<string>> = {}
  const addOnStats: Record<string, { label: string; custs: Set<string>; amounts: number[]; program: boolean }> = {}
  for (const li of lineItems) {
    const amt = Number(li.amount) || 0
    if (amt <= 0) continue
    const cid = jobCustomerById[li.job_id]
    if (!cid) continue
    const key = li.service_key || normalizeServiceKey(li.description)
    ;(addOnByCust[cid] ||= new Set()).add(key)
    const e = (addOnStats[key] ||= { label: li.description, custs: new Set(), amounts: [], program: isRecurringProgramService(li.description) })
    e.custs.add(cid); e.amounts.push(amt)
  }

  // Recurring series → representative cadence/value per customer.
  const byRec: Record<string, RIJob[]> = {}
  for (const j of jobs) if (j.recurrence_id) (byRec[j.recurrence_id] ||= []).push(j)
  const recByCust: Record<string, { cadence: string | null; perVisit: number; hasFuture: boolean; serviceType: string | null; lastCompleted: string | null; rec: RecInfo | null }> = {}
  for (const [rid, list] of Object.entries(byRec)) {
    const rec = recurrences[rid]
    if (!rec) continue
    const cid = list.find(j => j.customer_id)?.customer_id
    if (!cid) continue
    const sorted = [...list].sort((a, b) => a.scheduled_date.localeCompare(b.scheduled_date))
    const futureOpen = sorted.filter(j => j.scheduled_date >= today && j.status !== 'completed' && j.status !== 'cancelled')
    const rep = futureOpen[0] || sorted[sorted.length - 1]
    if (!rep) continue
    const cadence = effectiveFreq(rec.freq, rec.interval_unit, rec.interval_count)
    const q = rep.quote_id ? pctx.quotesById[rep.quote_id] : null
    const perVisit = jobVisitValue(rep.price, q as unknown as Record<string, unknown>, cadence)
    const lastCompleted = [...sorted].reverse().find(j => j.status === 'completed')?.scheduled_date ?? null
    const prev = recByCust[cid]
    // Prefer an active (has-future) series as the representative one.
    if (!prev || (futureOpen.length > 0 && !prev.hasFuture)) recByCust[cid] = { cadence, perVisit, hasFuture: futureOpen.length > 0, serviceType: rep.service_type, lastCompleted, rec }
  }

  const futureCust = new Set(jobs.filter(j => j.customer_id && j.scheduled_date >= today && j.status !== 'completed' && j.status !== 'cancelled').map(j => j.customer_id as string))

  // Build the per-customer aggregate.
  const aggs: Record<string, Agg> = {}
  for (const c of customers) {
    aggs[c.id] = {
      id: c.id, name: c.name,
      tenureDays: c.created_at ? Math.max(0, dDays(c.created_at.slice(0, 10))) : 0,
      completedCount: 0, lastCompleted: null, ltv: 0, cats: new Set(),
      hasActiveRecurring: false, cadence: null, perVisit: 0, annualRecurring: 0, recServiceType: null,
      futureBooked: futureCust.has(c.id), unpaidCount: unpaidByCust[c.id] || 0,
      isReferrer: referrers.has(c.id), prop: propByCust[c.id], addOns: addOnByCust[c.id] || new Set(),
      churn: churnRisk({ hasActiveRecurring: false, daysSinceLastService: null, cadenceDays: 0 }),
      inSeason: true,
    }
  }
  const completedByCust: Record<string, RIJob[]> = {}
  for (const j of jobs) {
    if (!j.customer_id) continue
    const a = aggs[j.customer_id]
    if (!a) continue
    if (j.status === 'cancelled') continue
    a.cats.add(serviceCategory(j.service_type))
    if (j.status === 'completed') {
      a.completedCount++
      ;(completedByCust[j.customer_id] ||= []).push(j)
      if (!a.lastCompleted || j.scheduled_date > a.lastCompleted) a.lastCompleted = j.scheduled_date
    }
  }
  for (const a of Object.values(aggs)) a.ltv = lifetimeValue(completedByCust[a.id] || [], pctx.quotesById, recurrences)
  for (const [cid, r] of Object.entries(recByCust)) {
    const a = aggs[cid]
    if (!a) continue
    a.cadence = r.cadence; a.perVisit = r.perVisit; a.recServiceType = r.serviceType
    a.hasActiveRecurring = r.hasFuture
    a.annualRecurring = round(r.perVisit * visitsPerSeason(r.cadence))
    const season = seasonForService(r.serviceType, seasons)
    a.inSeason = !season || isWithinSeason(today, season)
    a.churn = churnRisk({
      hasActiveRecurring: r.hasFuture,
      daysSinceLastService: r.lastCompleted ? dDays(r.lastCompleted) : null,
      cadenceDays: cadenceDays(r.cadence, r.rec),
    })
  }

  const allStops: Coord[] = locatedStops(jobs.map(j => ({ lat: j.lat, lng: j.lng })))
  const densityOf = (a: Agg): { tier: DensityTier; score: number; within2: number } => {
    if (!a.prop || a.prop.lat == null || a.prop.lng == null) return { tier: 'isolated', score: 0, within2: 0 }
    const d = densityFor({ lat: a.prop.lat, lng: a.prop.lng }, allStops)
    return { tier: d.tier, score: d.score, within2: d.within2km }
  }
  const hoodOf = (a: Agg) => a.prop ? neighborhoodKey(a.prop.postal_code, a.prop.city, a.prop.neighborhood) : 'Unknown'

  const opportunities: Opportunity[] = []
  const push = (o: Omit<Opportunity, 'rankValue'>) => {
    const rankValue = o.expectedValue * CONF_WEIGHT[o.confidence] * (o.oneTime ? 0.5 : 1)
    opportunities.push({ ...o, rankValue })
  }

  const lawnCustomers = Object.values(aggs).filter(a => a.cats.has('lawn'))

  for (const a of Object.values(aggs)) {
    const conf = (n: number): Confidence => n >= 4 ? 'high' : n >= 2 ? 'medium' : 'low'

    // 1) RENEWAL — recurring customers; risk-adjusted likelihood to renew next season.
    if (a.hasActiveRecurring && a.annualRecurring > 0) {
      let s = 55
      if (a.tenureDays >= 365) s += 15; else if (a.tenureDays >= 180) s += 8
      if (a.completedCount >= 6) s += 12; else if (a.completedCount >= 3) s += 6
      if (a.churn.level === 'high') s -= 25; else if (a.churn.level === 'watch') s -= 12
      if (a.unpaidCount > 0) s -= 10
      const score = clamp(s)
      push({
        key: `renewal:${a.id}`, kind: 'renewal', customerId: a.id, customerName: a.name,
        score, confidence: conf(a.completedCount), expectedValue: a.annualRecurring, oneTime: false,
        why: [
          `${a.cadence || 'recurring'} customer · ${a.completedCount} visits · ${a.tenureDays >= 365 ? '1+ yr' : Math.round(a.tenureDays / 30) + ' mo'} tenure`,
          a.churn.level !== 'none' ? 'Slipping behind cadence — renewal at risk' : 'On cadence — strong renewal candidate',
          `$${a.annualRecurring}/yr recurring at stake`,
        ],
        action: a.churn.level !== 'none' ? 'Reach out now and re-book the season' : 'Lock in next season before the gap',
        actionHref: `/dashboard/customers/${a.id}`,
      })
    }

    // 2) UPSELL — best add-on this lawn customer doesn't buy yet (peer penetration).
    if (a.cats.has('lawn') && a.completedCount >= 1) {
      let best: { key: string; label: string; pen: number; avg: number; program: boolean } | null = null
      for (const [key, e] of Object.entries(addOnStats)) {
        if (e.custs.size < 2) continue
        if (a.addOns.has(key)) continue
        const pen = e.custs.size / Math.max(1, lawnCustomers.length)
        if (pen > 0.7) continue
        const avg = round5(e.amounts.reduce((x, y) => x + y, 0) / e.amounts.length)
        if (avg <= 0) continue
        if (!best || pen > best.pen) best = { key, label: e.label, pen, avg, program: e.program }
      }
      if (best) {
        const appsPerYear = best.program ? 4 : 1
        const expected = round(best.avg * appsPerYear)
        let s = 40 + Math.round(best.pen * 60)
        if (a.hasActiveRecurring) s += 10
        if (a.ltv >= 1000) s += 8
        const score = clamp(s)
        push({
          key: `upsell:${a.id}`, kind: 'upsell', customerId: a.id, customerName: a.name,
          score, confidence: best.pen >= 0.3 ? 'medium' : 'low', expectedValue: expected, oneTime: !best.program,
          why: [
            `${Math.round(best.pen * 100)}% of your lawn customers buy ${best.label}`,
            `${a.name} doesn't have it yet`,
            best.program ? `~4×/season program at avg $${best.avg}` : `~$${best.avg} one-off`,
          ],
          action: `Offer ${best.label}`, offer: best.label,
          actionHref: `/dashboard/quotes/new?customer=${a.id}`,
        })
      }
    }

    // 3) CROSS-SELL — second season (lawn↔snow).
    const hasLawn = a.cats.has('lawn'), hasSnow = a.cats.has('snow')
    const active = a.hasActiveRecurring || a.completedCount >= 1
    if (active && (hasLawn !== hasSnow)) {
      const target = hasLawn ? 'snow' : 'lawn'
      const base = a.perVisit > 0 ? a.perVisit : (a.completedCount > 0 ? round(a.ltv / a.completedCount) : 0)
      if (base > 0) {
        const expected = round(base * SEASON_VISITS_BIWEEKLY)
        const dens = densityOf(a)
        let s = 45
        if (a.hasActiveRecurring) s += 15
        if (a.tenureDays >= 365) s += 10
        if (dens.tier === 'dense') s += 12; else if (dens.tier === 'moderate') s += 6
        const score = clamp(s)
        push({
          key: `cross_sell:${a.id}`, kind: 'cross_sell', customerId: a.id, customerName: a.name,
          score, confidence: a.hasActiveRecurring ? 'medium' : 'low', expectedValue: expected, oneTime: false,
          why: [
            `Active ${hasLawn ? 'lawn' : 'snow'} customer with no ${target} plan`,
            dens.tier !== 'isolated' ? `On a ${dens.tier} route — truck is already nearby` : 'Adds a second season at one address',
            `~$${expected}/yr second-season opportunity`,
          ],
          action: `Offer ${target === 'snow' ? 'snow removal' : 'lawn service'}`, offer: target === 'snow' ? 'Snow removal' : 'Lawn service',
          actionHref: `/dashboard/quotes/new?customer=${a.id}`,
        })
      }
    }

    // 4) MEMBERSHIP — repeat one-off customers who'd convert to a recurring plan.
    // Gated to ACTIVE repeaters (served ≤30d or booked) so it never overlaps the
    // win-back card below (which owns the lapsed ones).
    const recentlyServed = a.futureBooked || (a.lastCompleted ? dDays(a.lastCompleted) <= 30 : false)
    if (!a.hasActiveRecurring && a.completedCount >= 2 && recentlyServed) {
      const perVisit = round(a.ltv / a.completedCount)
      if (perVisit > 0) {
        const expected = round(perVisit * SEASON_VISITS_BIWEEKLY)
        let s = 40 + Math.min(30, a.completedCount * 6)
        if (a.unpaidCount === 0) s += 10
        if (a.tenureDays >= 180) s += 8
        const score = clamp(s)
        push({
          key: `membership:${a.id}`, kind: 'membership', customerId: a.id, customerName: a.name,
          score, confidence: a.completedCount >= 4 ? 'high' : 'medium', expectedValue: expected, oneTime: false,
          why: [
            `${a.completedCount} one-off visits but no recurring plan`,
            a.unpaidCount === 0 ? 'Pays reliably — a great auto-pay candidate' : 'Repeat customer — lock them in',
            `Converting ≈ $${expected}/yr predictable revenue`,
          ],
          action: 'Offer a recurring plan / membership',
          actionHref: `/dashboard/customers/${a.id}`,
        })
      }
    }

    // 5) REFERRAL — happy, high-value, loyal customers most likely to refer.
    if (a.completedCount >= 2 && (a.ltv >= 300 || a.hasActiveRecurring)) {
      const recentlyActive = a.hasActiveRecurring || (a.lastCompleted ? dDays(a.lastCompleted) <= 75 : false)
      if (recentlyActive) {
        const referredAnnual = a.hasActiveRecurring && a.annualRecurring > 0 ? a.annualRecurring : round((a.ltv / a.completedCount) * SEASON_VISITS_BIWEEKLY)
        const expected = round(referredAnnual * 0.5)
        if (expected >= 150) {
          let s = 45
          if (a.isReferrer) s += 25
          if (a.hasActiveRecurring) s += 12
          if (a.tenureDays >= 365) s += 10
          if (a.ltv >= VIP_LTV) s += 8
          const score = clamp(s)
          push({
            key: `referral:${a.id}`, kind: 'referral', customerId: a.id, customerName: a.name,
            score, confidence: a.isReferrer || a.ltv >= VIP_LTV ? 'high' : 'medium', expectedValue: expected, oneTime: false,
            why: [
              `$${round(a.ltv)} lifetime · ${a.completedCount} visits${a.isReferrer ? ' · proven referrer' : ''}`,
              hoodOf(a) !== 'Unknown' ? `A referral in ${hoodOf(a)} adds route density` : 'Warm referrals close cheap',
              `≈ $${expected}/yr from one referral`,
            ],
            action: 'Ask for a referral', actionHref: `/dashboard/customers/${a.id}`,
          })
        }
      }
    }

    // 6) WIN-BACK — customers not serviced in 30+ days with nothing booked (lost-
    // customer recovery). In-season only; recency drives the recovery likelihood.
    if (a.completedCount >= 1 && !a.futureBooked && a.lastCompleted && a.inSeason) {
      const daysSince = dDays(a.lastCompleted)
      if (daysSince >= 30) {
        const annual = a.hasActiveRecurring && a.annualRecurring > 0 ? a.annualRecurring
          : round((a.ltv / a.completedCount) * SEASON_VISITS_BIWEEKLY)
        if (annual >= 150) {
          const lost = daysSince >= 60
          const recovery = lost ? 0.3 : 0.5
          const expected = round(annual * recovery)
          let s = lost ? 38 : 56
          if (daysSince <= 45) s += 8
          if (a.ltv >= 1000) s += 8
          if (a.unpaidCount === 0) s += 4
          const score = clamp(s)
          push({
            key: `reactivation:${a.id}`, kind: 'reactivation', customerId: a.id, customerName: a.name,
            score, confidence: a.completedCount >= 3 ? 'medium' : 'low', expectedValue: expected, oneTime: false,
            why: [
              `Last serviced ${daysSince} days ago — ${lost ? 'a lost customer' : 'recently lapsed'}`,
              `${a.completedCount} completed visit${a.completedCount !== 1 ? 's' : ''} · $${round(a.ltv)} lifetime`,
              `~${Math.round(recovery * 100)}% win back when re-contacted → +$${expected}/yr`,
            ],
            action: lost ? 'Win back this lost customer' : 'Reach out — they’re overdue',
            actionHref: `/dashboard/customers/${a.id}`,
          })
        }
      }
    }
  }

  // De-dup to ONE opportunity per (kind, customer) keeping the highest score, then rank.
  const bestByKey: Record<string, Opportunity> = {}
  for (const o of opportunities) if (!bestByKey[o.key] || o.score > bestByKey[o.key].score) bestByKey[o.key] = o
  const ranked = Object.values(bestByKey).sort((a, b) => b.rankValue - a.rankValue)

  // ── LTV forecast ──
  const ltvForecast: LtvForecast[] = Object.values(aggs).filter(a => a.ltv > 0 || a.hasActiveRecurring).map(a => {
    const churnProb = a.churn.probability
    const remainingYears = a.hasActiveRecurring ? 3 * (1 - churnProb) : 0.5
    const forecast = round(a.ltv + a.annualRecurring * remainingYears)
    const churnRiskImpact = round(a.annualRecurring * churnProb)
    return {
      customerId: a.id, customerName: a.name, currentLtv: round(a.ltv), forecastLtv: forecast,
      revenueRemaining: Math.max(0, forecast - round(a.ltv)), churnRiskImpact,
      churnRisk: (churnProb >= 0.5 ? 'high' : churnProb >= 0.35 ? 'medium' : 'low') as Confidence,
    }
  }).sort((a, b) => b.churnRiskImpact - a.churnRiskImpact || b.revenueRemaining - a.revenueRemaining)

  // ── summary + labor context ──
  const byKind = { renewal: { count: 0, value: 0 }, upsell: { count: 0, value: 0 }, cross_sell: { count: 0, value: 0 }, membership: { count: 0, value: 0 }, referral: { count: 0, value: 0 }, reactivation: { count: 0, value: 0 } } as RevenueIntelReport['summary']['byKind']
  let totalOpportunity = 0, totalOneTime = 0
  for (const o of ranked) {
    byKind[o.kind].count++; byKind[o.kind].value += o.expectedValue
    if (o.oneTime) totalOneTime += o.expectedValue; else totalOpportunity += o.expectedValue
  }

  const bookedMin = jobs.filter(j => j.scheduled_date >= today && dDays(j.scheduled_date) >= -14 && j.scheduled_date <= addDaysISO(today, 14) && j.status !== 'cancelled' && j.status !== 'completed')
    .reduce((s, j) => s + (Number(j.duration_minutes) || 45), 0)
  const labor: LaborContext = {
    capacityHoursPerDay: capacityHours, preferredDays,
    bookedHoursNext2wk: round(bookedMin / 60),
    estimatedHoursPerWeek: round(bookedMin / 60 / 2),
  }

  return {
    opportunities: ranked,
    ltvForecast,
    summary: { totalOpportunity: round(totalOpportunity), totalOneTime: round(totalOneTime), byKind, topAction: ranked[0] || null },
    labor,
  }
}

function addDaysISO(iso: string, n: number): string {
  const d = new Date(iso + 'T00:00:00'); d.setDate(d.getDate() + n)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

// ── feedback loop ───────────────────────────────────────────────────────────────
// Record what the owner DID with a recommendation (and, later, the result) so the
// system can learn which plays actually produce revenue. Upsert keyed by the
// opportunity's stable key (kind+customer) so re-acting updates one row.
export type FeedbackStatus = 'acted' | 'dismissed' | 'won' | 'lost'
export interface FeedbackRow { opportunity_key: string; kind: string; status: string; expected_value: number | null; result_value: number | null }

export async function recordRecommendation(
  supabase: SupabaseClient,
  o: { key: string; kind: OppKind; customerId: string; expectedValue: number },
  status: FeedbackStatus,
  resultValue?: number,
): Promise<{ ok: boolean; error?: string }> {
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return { ok: false, error: 'Not signed in' }
  const { error } = await supabase.from('revenue_recommendations').upsert({
    user_id: user.id, opportunity_key: o.key, kind: o.kind, customer_id: o.customerId,
    expected_value: o.expectedValue, status, result_value: resultValue ?? null,
    acted_at: new Date().toISOString(),
  }, { onConflict: 'user_id,opportunity_key' })
  return error ? { ok: false, error: error.message } : { ok: true }
}

// ── loader ──────────────────────────────────────────────────────────────────────
export interface RevenueIntelLoad { report: RevenueIntelReport; feedback: Record<string, FeedbackRow> }
export async function loadRevenueIntel(supabase: SupabaseClient): Promise<RevenueIntelLoad | null> {
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return null
  const uid = user.id
  const [jRes, qRes, rRes, pRes, cRes, iRes, liRes, sRes, fRes] = await Promise.all([
    supabase.from('jobs').select('id, scheduled_date, status, service_type, quote_id, recurrence_id, duration_minutes, actual_minutes, price, customer_id, property_id, properties(lat, lng, city, postal_code, neighborhood)').eq('user_id', uid),
    supabase.from('quotes').select('id, total, initial_price, weekly_price, biweekly_price, monthly_price').eq('user_id', uid),
    supabase.from('job_recurrences').select('id, freq, interval_unit, interval_count').eq('user_id', uid),
    supabase.from('properties').select('id, customer_id, lat, lng, postal_code, city, neighborhood').eq('user_id', uid),
    supabase.from('customers').select('id, name, created_at, referred_by_customer_id').eq('user_id', uid),
    supabase.from('invoices').select('status, amount, customer_id').eq('user_id', uid),
    supabase.from('job_line_items').select('job_id, description, amount, service_key').eq('user_id', uid),
    supabase.from('business_settings').select('crew_cost_per_hour, daily_capacity_hours, preferred_work_days, base_lat, base_lng, service_seasons').eq('user_id', uid).maybeSingle(),
    supabase.from('revenue_recommendations').select('opportunity_key, kind, status, expected_value, result_value').eq('user_id', uid),
  ])

  const settings = sRes.data as Record<string, unknown> | null
  const quotesById: Record<string, ProfitQuote> = {}
  for (const q of (qRes.data as (ProfitQuote & { id: string })[]) || []) quotesById[q.id] = q
  const recurrences: Record<string, RecInfo> = {}
  for (const r of (rRes.data as (RecInfo & { id: string })[]) || []) recurrences[r.id] = { freq: r.freq, interval_unit: r.interval_unit, interval_count: r.interval_count }
  const baseLat = settings?.base_lat as number | null | undefined
  const baseLng = settings?.base_lng as number | null | undefined
  const today = localTodayISO()
  const pctx: ProfitContext = { quotesById, recById: recurrences, base: baseLat != null && baseLng != null ? { lat: baseLat, lng: baseLng } : null, today }

  const rawJobs = (jRes.data as unknown as Array<Record<string, any>>) || []
  const jobs: RIJob[] = rawJobs.map(j => ({
    id: j.id, scheduled_date: j.scheduled_date, status: j.status, service_type: j.service_type,
    quote_id: j.quote_id, recurrence_id: j.recurrence_id, duration_minutes: j.duration_minutes,
    actual_minutes: j.actual_minutes, price: j.price,
    customer_id: j.customer_id,
    lat: j.properties?.lat ?? null, lng: j.properties?.lng ?? null,
    city: j.properties?.city ?? null, postal_code: j.properties?.postal_code ?? null, neighborhood: j.properties?.neighborhood ?? null,
  }))
  const jobCustomerById: Record<string, string | null> = {}
  for (const j of rawJobs) jobCustomerById[j.id] = j.customer_id ?? null

  const report = computeRevenueIntel({
    jobs, pctx,
    customers: (cRes.data as RIInput['customers']) || [],
    properties: (pRes.data as RIInput['properties']) || [],
    recurrences,
    invoices: (iRes.data as RIInput['invoices']) || [],
    lineItems: (liRes.data as RIInput['lineItems']) || [],
    jobCustomerById,
    seasons: settingsToSeasons(settings?.service_seasons),
    capacityHours: Number(settings?.daily_capacity_hours) > 0 ? Number(settings!.daily_capacity_hours) : 8,
    preferredDays: (settings?.preferred_work_days as number[] | null)?.length ? (settings!.preferred_work_days as number[]) : [5, 6, 0],
    today,
  })

  const feedback: Record<string, FeedbackRow> = {}
  for (const f of (fRes.data as FeedbackRow[]) || []) feedback[f.opportunity_key] = f
  return { report, feedback }
}
