import type { SupabaseClient } from '@supabase/supabase-js'
import { localTodayISO } from '@/lib/utils'
import { effectiveFreq, jobVisitValue } from '@/lib/visitValue'
import { jobPriceState, jobAmountOrNull } from '@/lib/pricingState'
import { SEASON_VISITS } from '@/lib/pricing'
import { serviceCategory, seasonForService, isWithinSeason, settingsToSeasons, ServiceSeasons } from '@/lib/seasons'
import { densityFor, locatedStops, DensityTier } from '@/lib/routeDensity'
import { normalizeServiceKey } from '@/lib/jobPricing'
import { Coord } from '@/lib/geo'
import { neighborhoodKey, ProfitJob, ProfitContext, ProfitQuote, RecInfo } from '@/lib/profitability'
import { VIP_LTV, cadenceDays, churnRisk, daysBetween, lifetimeValue, type ChurnRisk } from '@/lib/signals'
import {
  assessEvidence, declaredCadence, mayShowAnnual, INSUFFICIENT_LABEL,
  type Evidence, type DeclaredCadence,
} from '@/lib/growthEvidence'
import { assessConcentration, type ConcentrationEntry, type ConcentrationResult } from '@/lib/growthConcentration'

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
  // ⭐⭐ A HEURISTIC PRIORITIZATION SCORE, NOT A CALIBRATED PROBABILITY. Every
  // predictor below builds it the same way: start at a fixed base (e.g. 55 for
  // renewal), add or subtract fixed point deltas for signals like tenure,
  // completed-visit count and churn level, then clamp to [0, 100]. Nothing here
  // is fit to observed outcomes or measured against actual conversion — a score
  // of 61 is "55 base + 6 for 3+ completed visits", not "61% of similar
  // customers convert". It orders opportunities correctly relative to each
  // other (that ordering is real and is what drives ranking); it must never be
  // rendered as "X% likely" or "X% likelihood" — see PRIORITY_SCORE_LABEL /
  // the "Priority score N/100" wording on the page, which is the honest framing.
  score: number         // 0..100, higher = higher priority
  confidence: Confidence
  expectedValue: number // $ (annual unless oneTime)
  oneTime: boolean
  rankValue: number     // expectedValue × confidence × one-time penalty — the business ranking
  /**
   * ⭐⭐ THE EVIDENCE THE FIGURE STANDS ON — travels WITH the number, never beside
   * it. Sample size, the statistic used, what was excluded and why, the cadence
   * assumption, and the annualization formula in full.
   *
   * ⛔ An opportunity whose evidence is `insufficient` carries expectedValue 0
   * and MUST be rendered as "Not enough reliable data". The ACTION is still
   * worth showing — "ask for a referral" is good advice regardless — but the
   * projection has to earn its place separately.
   */
  evidence: Evidence
  why: string[]
  action: string        // recommended action (one line)
  actionHref: string    // where the owner goes to do it
  offer?: string        // recommended offer (upsell/cross-sell)
}

/**
 * ⭐⭐ THE ONE HONEST SENTENCE FOR `score`, said the same way everywhere it is
 * shown (the top-action hero line and every OppCard's tooltip). Two independent
 * copies of "how do we describe this number" is exactly how one of them keeps
 * the old "% likely" framing while the other gets fixed. The compact meter
 * chip on each OppCard renders the bare `${score}/100` inline (no room for a
 * sentence there) but uses `priorityScoreTooltip` for its title, so the ONE
 * place a reader who wants the explanation finds it says the same thing.
 *
 * ⛔ Never say "likely", "likelihood", "chance" or "probability" here. The
 * field comment on `Opportunity.score` explains why: it is a fixed-point
 * heuristic (a base plus signal deltas), not a number fit to observed outcomes.
 */
export function priorityScoreLabel(score: number): string {
  return `Priority score ${score}/100`
}

/** The tooltip / title text — names what the score is FOR, not just what it is. */
export function priorityScoreTooltip(score: number): string {
  return `${priorityScoreLabel(score)} — ranks this play against this customer's own history. A heuristic for ordering, not a measured probability.`
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
    /**
     * ⭐⭐ THE HONESTY OF THE HEADLINE. A "$98,000/yr" tile is only trustworthy
     * if it says how much of the book it actually speaks for.
     *   quantified   — recommendations whose evidence supported a figure
     *   unquantified — real recommendations shown WITHOUT a projection
     * The tile must render both, so the number is never read as covering
     * everything the advisor found.
     */
    quantified: number
    unquantified: number
    /**
     * ⭐⭐ HOW MUCH OF THE RECURRING HEADLINE RESTS ON ONE CUSTOMER — a DIFFERENT
     * question from whether each figure was earned (that is lib/growthEvidence's
     * job, already done by the time an Opportunity reaches this summary). Its
     * denominator is exactly `totalOpportunity` (recurring, quantified); one-time
     * upsells belong to `totalOneTime` and are not in it. See
     * lib/growthConcentration for the full rationale and the threshold.
     * ⛔ `null` when there is nothing quantified to measure concentration over —
     * the caller must render nothing, not a "0%".
     */
    concentration: ConcentrationResult | null
  }
  labor: LaborContext
}

const round = (n: number) => Math.round(n)
const round5 = (n: number) => Math.round(n / 5) * 5
const clamp = (n: number, lo = 0, hi = 100) => Math.max(lo, Math.min(hi, n))
// ⛔ `SEASON_VISITS_BIWEEKLY` used to live here and was the universal fallback
// multiplier — four predictors reached for it when they had no cadence. It is
// deliberately GONE rather than left unused: a constant named "the default
// season length" is an invitation to annualize something that has not earned it.

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
  /** ⭐ What this customer's own visits actually support. Built once, read by
   *  every predictor, so no two of them can disagree about the same evidence. */
  evidence: Evidence
}

/**
 * ⭐⭐ THE SINGLE MOST EXPENSIVE LINE IN THIS FILE, NOW REMOVED.
 *
 * This function used to end `return SEASON_VISITS_BIWEEKLY` — so a cadence the
 * owner never declared was silently annualized as fortnightly. Measured on the
 * real book: 68.6% of customers with completed visits (35/51) have NO declared
 * cadence, and 28 of them alone contributed $138,144 of "annual opportunity"
 * derived from nothing at all.
 *
 * ⛔ NULL IS THE ANSWER when there is no declared cadence. Callers must render
 * the insufficient-evidence state; there is no fallback multiplier to reach for.
 */
function visitsPerSeason(cadence: string | null): number | null {
  const c = declaredCadence(cadence)
  return c ? SEASON_VISITS[c] : null
}

/** SEASON_VISITS for a cadence the gate has already confirmed is declared. */
const seasonVisitsFor = (c: DeclaredCadence): number => SEASON_VISITS[c]

export function computeRevenueIntel(inp: RIInput): RevenueIntelReport {
  const { jobs, pctx, customers, properties, recurrences, invoices, lineItems, jobCustomerById, seasons, capacityHours, preferredDays, today } = inp
  const dDays = (iso: string) => daysBetween(iso, today)

  const propByCust: Record<string, RIInput['properties'][number]> = {}
  for (const p of properties) if (p.customer_id && !propByCust[p.customer_id]) propByCust[p.customer_id] = p
  const unpaidByCust: Record<string, number> = {}
  // 'partial' counts: the trigger only lands there while a real balance remains
  // (v_paid + 0.01 < v_total), and deposits make partial the NORMAL state of a
  // big invoice. Without it, paying a deposit zeroed unpaidCount and scored the
  // customer "pays reliably — a great auto-pay candidate" while they owed money.
  for (const inv of invoices) if (inv.customer_id && (inv.status === 'unpaid' || inv.status === 'sent' || inv.status === 'partial')) unpaidByCust[inv.customer_id] = (unpaidByCust[inv.customer_id] || 0) + 1
  const referrers = new Set<string>()
  for (const c of customers) if (c.referred_by_customer_id) referrers.add(c.referred_by_customer_id)

  // Add-on penetration (lawn customers) — for upsell targeting.
  const addOnByCust: Record<string, Set<string>> = {}
  const addOnStats: Record<string, { label: string; custs: Set<string>; amounts: number[] }> = {}
  for (const li of lineItems) {
    const amt = Number(li.amount) || 0
    if (amt <= 0) continue
    const cid = jobCustomerById[li.job_id]
    if (!cid) continue
    const key = li.service_key || normalizeServiceKey(li.description)
    ;(addOnByCust[cid] ||= new Set()).add(key)
    const e = (addOnStats[key] ||= { label: li.description, custs: new Set(), amounts: [] })
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
      // Replaced below once this customer's completed visits are known.
      evidence: assessEvidence({ visits: [], declaredFreq: null, visitsPerSeason: seasonVisitsFor }),
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

  // ── ⭐⭐ THE EVIDENCE PASS — built ONCE per customer, before any predictor ──
  // Every predictor below used to reach for `a.ltv / a.completedCount`: a MEAN,
  // over a set that silently included unpriced visits valued at $0. On the real
  // book that mean is $276 against a median of $70, because one visit sits 89.9×
  // above the middle. Here the unpriced ones are EXCLUDED (and counted, so the
  // owner is told), and what survives is summarised by a median.
  for (const a of Object.values(aggs)) {
    const rec = recByCust[a.id]
    const jobsFor = completedByCust[a.id] || []
    a.evidence = assessEvidence({
      visits: jobsFor.map(j => {
        const q = j.quote_id ? pctx.quotesById[j.quote_id] : null
        const freq = j.recurrence_id ? effectiveFreq(recurrences[j.recurrence_id]?.freq ?? null, recurrences[j.recurrence_id]?.interval_unit ?? null, recurrences[j.recurrence_id]?.interval_count ?? null) : null
        const quote = q as unknown as Record<string, unknown>
        return {
          // ⭐⭐ THE CANONICAL PRICE VERDICT — lib/pricingState, the engine S114
          // landed for exactly this question. growthEvidence used to decide it
          // itself from `price === 0`, which could not see a DECLARED no-charge
          // and reported the owner's accountable write-off as a missing price.
          priceState: jobPriceState(j, quote, freq),
          amount: jobAmountOrNull(j, quote, freq),
          completed: true,
          // Any text that could betray a seeded record. ⛔ A FLAG, not a verdict —
          // every exclusion is counted and shown rather than applied silently.
          labels: [a.name, j.service_type],
        }
      }),
      // ⛔ ONLY a declared recurrence frequency. Never a service name, never a
      // guess from the gaps between visits.
      declaredFreq: rec?.cadence ?? null,
      visitsPerSeason: seasonVisitsFor,
    })
  }

  for (const [cid, r] of Object.entries(recByCust)) {
    const a = aggs[cid]
    if (!a) continue
    a.cadence = r.cadence; a.perVisit = r.perVisit; a.recServiceType = r.serviceType
    a.hasActiveRecurring = r.hasFuture
    // ⭐ Annualized ONLY through the gate. `visitsPerSeason` now returns null for
    // an undeclared cadence, so this is 0 — and 0 means every predicate below
    // (`a.annualRecurring > 0`) correctly refuses to speak.
    const vps = visitsPerSeason(r.cadence)
    a.annualRecurring = vps != null ? round(r.perVisit * vps) : 0
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

  /**
   * ⭐⭐ THE ONLY ANNUAL FIGURE A PREDICTOR MAY CLAIM.
   *
   * Four of the six predictors used `(a.ltv / a.completedCount) * SEASON_VISITS_BIWEEKLY`
   * — a mean over unpriced-inclusive visits, multiplied by a cadence nobody
   * declared. That single expression is where most of the headline came from.
   *
   * Now: a median over PRICED visits only, annualized only by a cadence the
   * owner actually declared. `null` means the recommendation still shows (the
   * ACTION is still good advice) but carries no dollar projection.
   */
  const annualFor = (a: Agg): number | null => mayShowAnnual(a.evidence) ? a.evidence.annual : null

  /** An unquantified opportunity: real advice, no fabricated number. */
  const noFigure = (a: Agg) => ({ expectedValue: 0, evidence: a.evidence })

  const lawnCustomers = Object.values(aggs).filter(a => a.cats.has('lawn'))

  for (const a of Object.values(aggs)) {
    const conf = (n: number): Confidence => n >= 4 ? 'high' : n >= 2 ? 'medium' : 'low'

    // 1) RENEWAL — recurring customers; risk-adjusted likelihood to renew next season.
    // ⭐ The CARD still requires a live recurring series; the FIGURE now comes
    // from the evidence pass, which is a median over priced visits rather than
    // the value of one representative job. "Do not let one huge or tiny visit
    // dominate a recommendation" — the representative job WAS one visit.
    if (a.hasActiveRecurring && a.annualRecurring > 0) {
      let s = 55
      if (a.tenureDays >= 365) s += 15; else if (a.tenureDays >= 180) s += 8
      if (a.completedCount >= 6) s += 12; else if (a.completedCount >= 3) s += 6
      if (a.churn.level === 'high') s -= 25; else if (a.churn.level === 'watch') s -= 12
      if (a.unpaidCount > 0) s -= 10
      const score = clamp(s)
      const annual = annualFor(a)
      push({
        key: `renewal:${a.id}`, kind: 'renewal', customerId: a.id, customerName: a.name,
        score, confidence: conf(a.evidence.sampleSize), oneTime: false,
        ...(annual != null ? { expectedValue: annual, evidence: a.evidence } : noFigure(a)),
        why: [
          `${a.cadence || 'recurring'} customer · ${a.completedCount} visits · ${a.tenureDays >= 365 ? '1+ yr' : Math.round(a.tenureDays / 30) + ' mo'} tenure`,
          a.churn.level !== 'none' ? 'Slipping behind cadence — renewal at risk' : 'On cadence — strong renewal candidate',
          annual != null ? `$${annual}/yr recurring at stake` : `${INSUFFICIENT_LABEL} to put a figure on the season`,
        ],
        action: a.churn.level !== 'none' ? 'Reach out now and re-book the season' : 'Lock in next season before the gap',
        actionHref: `/dashboard/customers/${a.id}`,
      })
    }

    // 2) UPSELL — best add-on this lawn customer doesn't buy yet (peer penetration).
    if (a.cats.has('lawn') && a.completedCount >= 1) {
      let best: { key: string; label: string; pen: number; typical: number; n: number; evidence: Evidence } | null = null
      for (const [key, e] of Object.entries(addOnStats)) {
        if (e.custs.size < 2) continue
        if (a.addOns.has(key)) continue
        const pen = e.custs.size / Math.max(1, lawnCustomers.length)
        if (pen > 0.7) continue
        // ⭐ MEDIAN, not mean. The add-on price list is drawn from the same
        // skewed population as everything else here (book-wide: median $70,
        // mean $276), so an average let one large sale set the expected value
        // of every future one.
        const ev = assessEvidence({
          // Add-on line items are already filtered to amt > 0 above, so each one
          // IS a recorded price. ⛔ Stated explicitly rather than inferred — this
          // seam takes a canonical verdict, and a line item is not a job, so
          // jobPriceState has nothing to say about it.
          visits: e.amounts.map(amt => ({ priceState: 'priced' as const, amount: amt, completed: true, labels: [e.label] })),
          declaredFreq: null, visitsPerSeason: seasonVisitsFor,
        })
        const typical = ev.perVisit
        if (typical == null || typical <= 0) continue
        if (!best || pen > best.pen) best = { key, label: e.label, pen, typical: round5(typical), n: ev.sampleSize, evidence: ev }
      }
      if (best) {
        // ⛔⛔ THE SERVICE-NAME CADENCE INFERENCE IS GONE.
        // This read `appsPerYear = isRecurringProgramService(description) ? 4 : 1`
        // — a regex on the add-on's NAME (/mow|grass cut|lawn care/,
        // /fertiliz|weed control|bed maintenance/) deciding whether to multiply
        // the price by four. A NAME IS NOT A CADENCE: two businesses doing
        // identical work would be annualized differently for calling it
        // different things, and a trade whose vocabulary isn't in that regex
        // matched nothing at all.
        //
        // There is no declared cadence for an add-on anywhere in the schema, so
        // the honest figure is ONE application. An owner who sells it as a
        // programme still sees a real number; it is simply not multiplied by a
        // frequency nobody recorded.
        const expected = best.typical
        let s = 40 + Math.round(best.pen * 60)
        if (a.hasActiveRecurring) s += 10
        if (a.ltv >= 1000) s += 8
        const score = clamp(s)
        push({
          key: `upsell:${a.id}`, kind: 'upsell', customerId: a.id, customerName: a.name,
          score, confidence: best.pen >= 0.3 ? 'medium' : 'low', expectedValue: expected, oneTime: true,
          evidence: best.evidence,
          why: [
            `${Math.round(best.pen * 100)}% of your lawn customers buy ${best.label}`,
            `${a.name} doesn't have it yet`,
            `~$${best.typical} typical (median of ${best.n} sale${best.n === 1 ? '' : 's'}) — one application`,
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
      // ⛔ WAS: `base × SEASON_VISITS_BIWEEKLY`, where base fell back to
      // `ltv / completedCount`. A customer with ONE completed visit had that one
      // visit multiplied into a fortnightly year — for a season they have never
      // bought, in a category they have never used.
      // ⭐ A second season has NO cadence evidence by definition: the plan is the
      // thing being proposed. So there is a per-visit figure and no annual one.
      const perVisit = a.evidence.perVisit
      if (perVisit != null && perVisit > 0) {
        const dens = densityOf(a)
        let s = 45
        if (a.hasActiveRecurring) s += 15
        if (a.tenureDays >= 365) s += 10
        if (dens.tier === 'dense') s += 12; else if (dens.tier === 'moderate') s += 6
        const score = clamp(s)
        push({
          key: `cross_sell:${a.id}`, kind: 'cross_sell', customerId: a.id, customerName: a.name,
          score, confidence: a.hasActiveRecurring ? 'medium' : 'low',
          ...noFigure(a), oneTime: false,
          why: [
            `Active ${hasLawn ? 'lawn' : 'snow'} customer with no ${target} plan`,
            dens.tier !== 'isolated' ? `On a ${dens.tier} route — truck is already nearby` : 'Adds a second season at one address',
            `Their typical visit is $${perVisit} — the season's value depends on the plan you offer`,
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
      // ⭐⭐ THE PUREST CASE OF ONE-OFF WORK BEING ANNUALIZED AS RECURRING.
      // This card exists precisely BECAUSE the customer has no recurring plan —
      // and it then multiplied their mean visit by a fortnightly season to
      // announce "$X/yr predictable revenue". The cadence is the thing being
      // SOLD; it cannot also be the evidence.
      const perVisit = a.evidence.perVisit
      if (perVisit != null && perVisit > 0) {
        let s = 40 + Math.min(30, a.completedCount * 6)
        if (a.unpaidCount === 0) s += 10
        if (a.tenureDays >= 180) s += 8
        const score = clamp(s)
        push({
          key: `membership:${a.id}`, kind: 'membership', customerId: a.id, customerName: a.name,
          score, confidence: a.evidence.strength === 'confident' ? 'high' : 'medium',
          ...noFigure(a), oneTime: false,
          why: [
            `${a.completedCount} one-off visits but no recurring plan`,
            a.unpaidCount === 0 ? 'Pays reliably — a great auto-pay candidate' : 'Repeat customer — lock them in',
            `Their typical visit is $${perVisit} — annual value depends on the cadence you sell`,
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
        // ⭐ A referral's value is a projection about a customer WHO DOES NOT
        // EXIST YET. The only defensible anchor is what THIS customer is worth
        // on evidence, halved — and only when that annual figure is itself
        // admissible (declared cadence, enough priced visits).
        const referredAnnual = annualFor(a)
        const expected = referredAnnual != null ? round(referredAnnual * 0.5) : 0
        if (referredAnnual != null && expected >= 150) {
          let s = 45
          if (a.isReferrer) s += 25
          if (a.hasActiveRecurring) s += 12
          if (a.tenureDays >= 365) s += 10
          if (a.ltv >= VIP_LTV) s += 8
          const score = clamp(s)
          push({
            key: `referral:${a.id}`, kind: 'referral', customerId: a.id, customerName: a.name,
            score, confidence: a.isReferrer || a.ltv >= VIP_LTV ? 'high' : 'medium', expectedValue: expected, oneTime: false,
            evidence: a.evidence,
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
        // ⭐ Win-back is worth what the customer was actually worth — on the
        // evidence, and only when a declared cadence makes an annual figure
        // admissible. A lapsed one-off customer still deserves the CARD; they
        // just do not come with a fabricated annual number attached.
        const annual = annualFor(a)
        if (annual != null && annual >= 150) {
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
            score, confidence: a.evidence.strength === 'confident' ? 'medium' : 'low', expectedValue: expected, oneTime: false,
            evidence: a.evidence,
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
  let totalOpportunity = 0, totalOneTime = 0, quantified = 0, unquantified = 0
  for (const o of ranked) {
    byKind[o.kind].count++; byKind[o.kind].value += o.expectedValue
    if (o.oneTime) totalOneTime += o.expectedValue; else totalOpportunity += o.expectedValue
    // ⭐ An expectedValue of 0 here is never "worth nothing" — it is "we would not
    // claim a number", which is a different fact and is counted as one.
    if (o.expectedValue > 0) quantified++; else unquantified++
  }

  // ⭐⭐ CONCENTRATION — a DISCLOSURE pass over the same `ranked` list, not a
  // second pricing or eligibility engine. lib/growthEvidence has already decided
  // which figures may exist; this only asks how the ones that survived are
  // distributed ACROSS customers. Every RECURRING opportunity is handed over
  // (unquantified ones included) — assessConcentration's own filter is the
  // single place that decides what counts, the same discipline growthEvidence
  // uses for exclusions, so this call site does not need to duplicate that.
  //
  // ⭐ THE SAME SET AS THE HEADLINE. The banner sits under the "Recurring
  // opportunity" tile, whose figure is `totalOpportunity` — the sum over
  // `!o.oneTime` in the loop above. One-time upsells are a different tile and a
  // different total, so they are excluded here for the same reason they are
  // excluded there: a share "of this projection" must divide the number the
  // owner is looking at. verify:growth-concentration §13 proves
  // `concentration.totalConsidered === summary.totalOpportunity`.
  const concentration = assessConcentration(
    ranked.filter(o => !o.oneTime).map((o): ConcentrationEntry => ({
      customerId: o.customerId, customerName: o.customerName, expectedValue: o.expectedValue,
    })),
  )

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
    summary: {
      totalOpportunity: round(totalOpportunity), totalOneTime: round(totalOneTime), byKind,
      // ⭐ The top action is the best QUANTIFIED play. An unquantified card can
      // still be excellent advice, but it must not headline a screen whose whole
      // subject is expected revenue.
      topAction: ranked.find(o => o.expectedValue > 0) || null,
      quantified, unquantified,
      concentration: concentration.hasData ? concentration : null,
    },
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
  // getSession (local read), not getUser (network hop): the id only scopes RLS-filtered reads.
  const { data: { session } } = await supabase.auth.getSession()
  const user = session?.user
  if (!user) return null
  const uid = user.id
  const [jRes, qRes, rRes, pRes, cRes, iRes, liRes, sRes, fRes] = await Promise.all([
    // ⭐ `no_charge_*` (S114) is selected because the Growth gate must be able to
    // tell an owner's DECLARED free visit from a price nobody recorded. Without
    // these three columns `isNoCharge()` is always false and a deliberate
    // write-off is reported to the owner as "no price recorded" — an accusation
    // of sloppy bookkeeping against someone who did the paperwork correctly.
    supabase.from('jobs').select('id, scheduled_date, status, service_type, quote_id, recurrence_id, duration_minutes, actual_minutes, price, customer_id, property_id, no_charge_at, no_charge_reason, no_charge_by, properties(lat, lng, city, postal_code, neighborhood)').eq('user_id', uid),
    supabase.from('quotes').select('id, total, initial_price, weekly_price, biweekly_price, monthly_price').eq('user_id', uid),
    supabase.from('job_recurrences').select('id, freq, interval_unit, interval_count').eq('user_id', uid),
    supabase.from('properties').select('id, customer_id, lat, lng, postal_code, city, neighborhood').eq('user_id', uid),
    supabase.from('customers').select('id, name, created_at, referred_by_customer_id').eq('user_id', uid),
    supabase.from('invoices').select('status, amount, customer_id').eq('user_id', uid),
    supabase.from('job_line_items').select('job_id, description, amount, service_key').eq('user_id', uid),
    supabase.from('business_settings').select('crew_cost_per_hour, daily_capacity_hours, preferred_work_days, base_lat, base_lng, service_seasons').eq('user_id', uid).maybeSingle(),
    supabase.from('revenue_recommendations').select('opportunity_key, kind, status, expected_value, result_value').eq('user_id', uid),
  ])

  // ── The honesty gate ──
  // "Who to call next" ranks every customer from these reads. Coerced with `|| []`
  // a failed read became a confident answer about the WRONG people:
  //   • customers/jobs fail → an empty ranking reads as "nobody worth calling".
  //   • invoices fail → unpaidByCust empties, so a customer who owes money scores
  //     as one who "pays reliably" — a great auto-pay candidate. That is the exact
  //     mistake the deposit-awareness fix above this function was written to stop,
  //     reachable again through a dropped connection.
  // The page already renders a proper "could not load — try again" state for null;
  // it simply never got one. Nothing partial is worth publishing here.
  if (jRes.error || qRes.error || rRes.error || pRes.error || cRes.error ||
      iRes.error || liRes.error || sRes.error || fRes.error) return null

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
