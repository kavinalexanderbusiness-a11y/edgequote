import type { SupabaseClient } from '@supabase/supabase-js'
import {
  PricingConfig, pricingConfigFromSettings, roundToStep, roundUpToNice,
  pricingGuidance, estimateVisitMinutes,
} from '@/lib/pricing'
import { recommendedForCadence, type Cadence } from '@/lib/priceGuardrails'
import { isWon, isLost } from '@/lib/winLoss'
import { serviceKey, serviceLabel, laborEconomics, type Confidence } from '@/lib/labor'
import { crewCostPerHour } from '@/lib/economics'
import { readCache, writeCache, CACHE_TTL } from '@/lib/clientCache'
import { clamp } from '@/lib/utils'

// ── Quote win-rate learning — the self-learning pricing intelligence layer ───────
//
// This is NOT a second pricing engine. lib/pricing.ts stays THE engine; this layer
// feeds it better data and explains the answer. It learns, from your own accepted
// vs declined quotes, WHERE you actually close deals relative to the engine's
// recommended price, then nudges that recommendation toward the win-rate-optimal
// price — while respecting every guardrail (lib/priceGuardrails). Every completed
// job, accepted/declined quote, measurement and learned visit-time makes the next
// recommendation slightly sharper, automatically. No new tables: it derives from
// `quotes` + `quote_outcomes` you already have.
//
// STRICT per-service (req): mowing learns only from mowing, mulch only from mulch,
// rock only from rock, spring cleanup only from spring cleanup — keyed by the shared
// serviceKey() (the SAME normalizer the labor engine uses). It NEVER borrows across
// services. If a service has no win history yet it does NOT guess — it falls back to
// the plain engine price and says so, until that service accrues its own evidence.
//
// One axis: the price RATIO = quote price ÷ the engine's recommended price for that
// lawn & cadence. Learning on the ratio (not the raw dollar) lets a $45 small-lawn
// quote and a $95 big-lawn quote inform the same "you win at ~1.05× recommended"
// signal. The recommendation is always anchored to the engine and clamped to the
// minimum — it can sharpen the engine, never undercut it.

// Mirror lib/pricing CADENCE_MULT (neutral baseline) by layering overgrowth on top
// of recommendedForCadence (priceGuardrails) — the canonical no-overgrowth engine
// price per cadence — so the learning denominator matches how the live quote prices.
function anchorForCadence(sqft: number, cadence: Cadence, cfg: PricingConfig, overgrowth = 1): number {
  const base = recommendedForCadence(sqft, cadence, cfg)
  if (base <= 0) return 0
  const og = overgrowth > 0 ? overgrowth : 1
  return og === 1 ? base : roundToStep(base * og)
}

// A decided quote distilled to what the learner needs.
interface QuoteRow {
  id: string
  status: string
  service_type: string | null
  measured_sqft: number | null
  initial_price: number | null
  weekly_price: number | null
  biweekly_price: number | null
  monthly_price: number | null
  total: number | null
  property_id: string | null
  customer_id: string | null
  overgrowth_multiplier: number | null
  created_at: string | null
}

// The price the customer actually decided on + its cadence. A recurring quote is
// decided on its recurring price; a one-off on its first-visit/total.
function repPriceAndCadence(q: QuoteRow): { cadence: Cadence; price: number } {
  const w = Number(q.weekly_price) || 0, b = Number(q.biweekly_price) || 0, m = Number(q.monthly_price) || 0
  if (w > 0) return { cadence: 'weekly', price: w }
  if (b > 0) return { cadence: 'biweekly', price: b }
  if (m > 0) return { cadence: 'monthly', price: m }
  const one = Number(q.initial_price) || 0
  return { cadence: 'one_time', price: one > 0 ? one : Number(q.total) || 0 }
}

function median(xs: number[]): number {
  if (!xs.length) return 0
  const s = [...xs].sort((a, b) => a - b)
  const i = Math.floor(s.length / 2)
  return s.length % 2 ? s[i] : (s[i - 1] + s[i]) / 2
}

// Enough decided quotes for a service before its win-ratio is trusted over the raw
// engine number. Conservative so thin data never swings price — it just holds at
// the engine recommendation until evidence accumulates.
const MIN_SERVICE_SAMPLES = 4
const RATIO_MIN = 0.9   // the learner never pulls below 0.9× recommended…
const RATIO_MAX = 1.25  // …nor past 1.25× (the engine + guardrails own the rest)

// ── the learned model (per service) ──────────────────────────────────────────────
export interface ServiceWinStats {
  won: number
  lost: number
  acceptance: number          // won / decided
  priceLossShare: number      // of losses, share tagged reason 'price'
  medianWinRatio: number      // median (price ÷ recommended) among WON quotes
  ratios: { ratio: number; won: boolean }[]  // every decided quote (for band acceptance)
  n: number                   // decided
}
export interface QuotePricingModel {
  byService: Record<string, ServiceWinStats>
  // Won prices keyed by property::service and customer::service, split by cadence —
  // the strongest, service-specific anchor ("this exact property accepted $X to mow").
  wonByPropertyService: Record<string, Partial<Record<Cadence, number[]>>>
  wonByCustomerService: Record<string, Partial<Record<Cadence, number[]>>>
  decidedQuotes: number
}

export function learnQuoteModel(
  quotes: QuoteRow[],
  cfg: PricingConfig,
  priceLossByQuote: Record<string, boolean>,
): QuotePricingModel {
  const agg: Record<string, { won: number; lost: number; priceLoss: number; winRatios: number[]; ratios: { ratio: number; won: boolean }[] }> = {}
  const wonByPropertyService: QuotePricingModel['wonByPropertyService'] = {}
  const wonByCustomerService: QuotePricingModel['wonByCustomerService'] = {}
  let decidedQuotes = 0

  for (const q of quotes) {
    const won = isWon(q.status), lost = isLost(q.status)
    if (!won && !lost) continue
    decidedQuotes++
    const svc = serviceKey(q.service_type)
    const { cadence, price } = repPriceAndCadence(q)
    const sqft = Number(q.measured_sqft) || 0
    const og = Number(q.overgrowth_multiplier) || 1
    const recommended = sqft > 0 ? anchorForCadence(sqft, cadence, cfg, og) : 0
    const ratio = recommended > 0 && price > 0 ? price / recommended : null

    const a = (agg[svc] ||= { won: 0, lost: 0, priceLoss: 0, winRatios: [], ratios: [] })
    if (won) {
      a.won++
      if (ratio != null) a.winRatios.push(ratio)
      if (price > 0) {
        if (q.property_id) ((wonByPropertyService[`${q.property_id}::${svc}`] ||= {})[cadence] ||= []).push(price)
        if (q.customer_id) ((wonByCustomerService[`${q.customer_id}::${svc}`] ||= {})[cadence] ||= []).push(price)
      }
    } else {
      a.lost++
      if (priceLossByQuote[q.id]) a.priceLoss++
    }
    if (ratio != null) a.ratios.push({ ratio, won })
  }

  const byService: Record<string, ServiceWinStats> = {}
  for (const [svc, a] of Object.entries(agg)) {
    const n = a.won + a.lost
    byService[svc] = {
      won: a.won, lost: a.lost, n,
      acceptance: n ? a.won / n : 0,
      priceLossShare: a.lost ? a.priceLoss / a.lost : 0,
      medianWinRatio: a.winRatios.length ? median(a.winRatios) : 1,
      ratios: a.ratios,
    }
  }
  return { byService, wonByPropertyService, wonByCustomerService, decidedQuotes }
}

// ── the recommendation ──────────────────────────────────────────────────────────
export interface QuotePriceInput {
  sqft: number
  serviceType: string | null
  cadence: Cadence
  overgrowth?: number
  crewCost: number
  propertyId?: string | null
  customerId?: string | null
  // Where available — supplied by callers that already loaded these models. Each is
  // optional; a missing factor simply drops its reason (never blocks the rec).
  nearbyCount?: number | null            // route density — located jobs within range
  nearbyRecurring?: number | null        // of those, how many are recurring customers
  visitMinutes?: number | null           // learned visit duration (lib/labor)
  driveMin?: number | null               // learned travel time to this stop (lib/travelLearning)
  date?: string | null                   // for the season reason
}
export interface QuotePriceRecommendation {
  cadence: Cadence
  price: number                 // the recommendation — always ≥ floor, ≤ engine cap
  enginePrice: number           // the unmodified engine recommendation (the anchor)
  floor: number                 // the guardrail minimum — the rec NEVER goes below this
  acceptancePct: number | null  // observed acceptance near the recommended price
  sampleSize: number            // similar decided quotes the rec leaned on
  confidence: Confidence
  confidencePct: number
  reasons: string[]             // the WHY (req #3)
  heldAtMinimum: boolean        // true when the win-rate wanted lower but the floor held
  enoughData: boolean           // false → no service history; just the engine price
  serviceLabel: string
  summary: string               // one-line "Recommended $X — Why: …"
}

const SEASON_OF = (dateISO?: string | null): string => {
  const m = dateISO ? Number(dateISO.slice(5, 7)) : new Date().getMonth() + 1
  if (m >= 4 && m <= 5) return 'Spring'
  if (m >= 6 && m <= 8) return 'Summer'
  if (m >= 9 && m <= 10) return 'Fall'
  return 'Winter'
}

export function recommendQuotePrice(
  input: QuotePriceInput,
  model: QuotePricingModel,
  cfg: PricingConfig,
): QuotePriceRecommendation | null {
  const sqft = Math.max(0, input.sqft || 0)
  const cadence = input.cadence
  const og = input.overgrowth && input.overgrowth > 0 ? input.overgrowth : 1
  const enginePrice = anchorForCadence(sqft, cadence, cfg, og)
  if (enginePrice <= 0) return null // no measurement → nothing to anchor to; engine stays in charge

  const svc = serviceKey(input.serviceType)
  const svcLabel = serviceLabel(svc)
  const stats = model.byService[svc]
  const aggN = stats?.n ?? 0
  const aggEnough = aggN >= MIN_SERVICE_SAMPLES

  // Service-specific direct evidence: this exact property / customer for THIS service.
  const propWon = (input.propertyId && model.wonByPropertyService[`${input.propertyId}::${svc}`]?.[cadence]) || []
  const custWon = (input.customerId && model.wonByCustomerService[`${input.customerId}::${svc}`]?.[cadence]) || []
  // "Enough to be more than a guess" = aggregate win history OR direct property/customer
  // evidence for this exact service. No cross-service borrowing anywhere.
  const enoughData = aggEnough || propWon.length > 0 || custWon.length > 0

  const reasons: string[] = []
  let price = enginePrice

  // 1) Win-rate-optimal RATIO (only with enough SAME-service aggregate data),
  // confidence-weighted toward the engine (ratio 1.0). The more decided quotes,
  // the more we trust where you actually close.
  if (aggEnough && stats) {
    const confW = clamp(aggN / (aggN + 8), 0, 0.85)
    let targetRatio = 1 + (clamp(stats.medianWinRatio, RATIO_MIN, RATIO_MAX) - 1) * confW
    if (aggN >= 6 && stats.acceptance >= 0.85) targetRatio += Math.min(0.06, stats.acceptance - 0.85) // winning easily → room to raise
    if (aggN >= 4 && stats.acceptance < 0.55 && stats.priceLossShare >= 0.5) targetRatio -= 0.04        // losing on price → ease down
    targetRatio = clamp(targetRatio, RATIO_MIN, RATIO_MAX)
    price = roundToStep(enginePrice * targetRatio)
  }

  // 2) Strongest anchor: this exact property / customer already accepted a price for
  // THIS service. Always applies when present (direct, service-specific evidence).
  let propAnchorPrice = 0
  if (propWon.length) {
    propAnchorPrice = median(propWon)
    const w = clamp(propWon.length / (propWon.length + 1), 0, 0.6)
    price = roundToStep(w * propAnchorPrice + (1 - w) * price)
  } else if (custWon.length) {
    const cAnchor = median(custWon)
    const w = clamp(custWon.length / (custWon.length + 2), 0, 0.4)
    price = roundToStep(w * cAnchor + (1 - w) * price)
  }

  // 3) GUARDRAIL FLOOR — the recommendation can sharpen the engine, NEVER undercut
  // your minimums (req #4). Floor = the market-tier minimum for this cadence, and
  // the revenue/hour floor against crew cost when we know the visit time.
  const guidanceMin = pricingGuidance(enginePrice, cfg).minimum // enginePrice × marketMult
  const onSite = input.visitMinutes && input.visitMinutes > 0 ? input.visitMinutes : (sqft > 0 ? estimateVisitMinutes(sqft) : 0)
  const drive = input.driveMin && input.driveMin > 0 ? input.driveMin : 0
  const hours = (onSite + drive) / 60
  const revFloorPrice = input.crewCost > 0 && hours > 0 ? roundUpToNice(input.crewCost * 1.5 * hours) : 0
  const floor = Math.max(guidanceMin, revFloorPrice)
  const heldAtMinimum = price < floor
  if (heldAtMinimum) price = floor
  price = Math.min(price, roundToStep(enginePrice * 1.35)) // never an absurd premium
  price = Math.max(roundToStep(price), floor)

  // ── acceptance % to SHOW: observed acceptance near the recommended ratio band ──
  const recRatio = price / enginePrice
  const near = aggEnough && stats ? stats.ratios.filter(r => Math.abs(r.ratio - recRatio) <= 0.12) : []
  const acceptancePct = near.length >= 3
    ? Math.round((near.filter(r => r.won).length / near.length) * 100)
    : (aggEnough && stats && stats.n >= 2 ? Math.round(stats.acceptance * 100) : null)

  // ── confidence ──
  let confidence: Confidence, confidencePct: number
  if (aggN >= 12 || propWon.length >= 2) {
    confidence = 'high'; confidencePct = clamp(80 + Math.min(15, aggN * 0.5 + propWon.length * 4), 70, 96)
  } else if (aggEnough || propWon.length >= 1 || custWon.length >= 2) {
    confidence = 'medium'; confidencePct = clamp(55 + Math.min(16, aggN * 1.5 + propWon.length * 6), 45, 74)
  } else {
    confidence = 'low'; confidencePct = clamp(35 + aggN * 2, 25, 45)
  }

  // ── the WHY (req: explain every recommendation as a clear "Because" list) ──────
  // Built only from existing data + the existing learning systems, ordered so the
  // owner immediately sees what drove the number. Each factor is dropped when its
  // data is absent (never a hollow placeholder).
  // 1) Property size + the selected service (always present once measured).
  if (sqft > 0) reasons.push(`${sqft.toLocaleString()} ft² ${svcLabel} job`)
  // 2) Historical acceptance for THIS service (or the honest "still learning").
  if (aggEnough && stats) {
    reasons.push(`${aggN} similar ${svcLabel} quote${aggN !== 1 ? 's' : ''}${acceptancePct != null ? ` — ${acceptancePct}% accepted near this price` : ''}`)
  } else {
    reasons.push(`Not enough ${svcLabel} quote history yet — using your standard pricing. Learns as you log accepted/declined ${svcLabel} quotes.`)
  }
  // 3) Learned visit duration (lib/labor, service-specific).
  if (onSite > 0) reasons.push(`Historical visit duration ~${onSite} min`)
  // 4) Route density + 5) nearby recurring customers (existing route-density engine).
  if (input.nearbyCount != null) {
    if (input.nearbyCount >= 3) reasons.push(`Strong route density — ${input.nearbyCount} nearby jobs absorb travel`)
    else if (input.nearbyCount >= 1) reasons.push(`Builds route density — ${input.nearbyCount} nearby job${input.nearbyCount !== 1 ? 's' : ''}`)
    else reasons.push('Isolated stop — no nearby jobs, priced to cover the drive')
  }
  if (input.nearbyRecurring != null && input.nearbyRecurring > 0) reasons.push(`${input.nearbyRecurring} nearby recurring customer${input.nearbyRecurring !== 1 ? 's' : ''}`)
  // 6) Estimated profitability (reuses laborEconomics).
  const econ = onSite > 0 && input.crewCost > 0 ? laborEconomics(onSite + drive, price, input.crewCost) : null
  if (econ && econ.revPerLaborHour > 0) {
    const strong = econ.revPerLaborHour >= input.crewCost * 2.2
    reasons.push(`${strong ? 'Strong' : 'Healthy'} profitability — ~$${econ.revPerLaborHour}/hr, ${econ.marginPct}% margin`)
  }
  // 7) Direct same-service price evidence for this property / customer.
  if (propAnchorPrice > 0) reasons.push(`This property previously accepted $${Math.round(propAnchorPrice)} for ${svcLabel}`)
  else if (custWon.length) reasons.push(`This customer last accepted $${Math.round(median(custWon))} for ${svcLabel}`)
  if (og !== 1) reasons.push(`Overgrowth ×${og} applied`)
  const season = SEASON_OF(input.date)
  if (svc === 'mowing' && season === 'Spring') reasons.push('Spring — first cuts run heavier')
  if (heldAtMinimum) reasons.push(`Held at your $${floor} minimum for this lawn — won't go lower`)
  // 8) Current pricing confidence.
  reasons.push(`Pricing confidence: ${confidence[0].toUpperCase()}${confidence.slice(1)} (${confidencePct}%)`)

  const cadLabel = cadence === 'one_time' ? 'one-time' : cadence
  const summary = `Recommended: $${price}${cadence === 'one_time' ? '' : ` /${cadLabel}`} — ${reasons.slice(0, 3).join(' · ')}`

  return {
    cadence, price, enginePrice, floor,
    acceptancePct, sampleSize: aggN, confidence, confidencePct,
    reasons, heldAtMinimum, enoughData, serviceLabel: svcLabel, summary,
  }
}

// ── loader (cached, derives from existing tables — NO migration) ─────────────────
export interface LoadedQuoteModel { model: QuotePricingModel; cfg: PricingConfig; crewCost: number }

export async function loadQuotePricingModel(
  supabase: SupabaseClient,
  opts?: { force?: boolean },
): Promise<LoadedQuoteModel | null> {
  const cacheKey = 'quote-pricing-model'
  if (!opts?.force) {
    const cached = readCache<LoadedQuoteModel>(cacheKey, CACHE_TTL.medium)
    if (cached) return cached
  }
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return null
  const uid = user.id
  const [qRes, oRes, sRes] = await Promise.all([
    supabase.from('quotes').select('id, status, service_type, measured_sqft, initial_price, weekly_price, biweekly_price, monthly_price, total, property_id, customer_id, overgrowth_multiplier, created_at').eq('user_id', uid),
    supabase.from('quote_outcomes').select('quote_id, reason').eq('user_id', uid),
    supabase.from('business_settings').select('pricing_base_charge, pricing_mow_rate, pricing_recommended_mult, pricing_premium_mult, pricing_travel_rate, crew_cost_per_hour').eq('user_id', uid).maybeSingle(),
  ])
  const quotes = (qRes.data as QuoteRow[]) || []
  const priceLossByQuote: Record<string, boolean> = {}
  for (const o of (oRes.data as { quote_id: string; reason: string }[]) || []) if (o.reason === 'price') priceLossByQuote[o.quote_id] = true
  const s = sRes.data as (Parameters<typeof pricingConfigFromSettings>[0] & { crew_cost_per_hour?: number }) | null
  const cfg = pricingConfigFromSettings(s)
  const crewCost = crewCostPerHour(s?.crew_cost_per_hour)

  const result: LoadedQuoteModel = { model: learnQuoteModel(quotes, cfg, priceLossByQuote), cfg, crewCost }
  writeCache(cacheKey, result)
  return result
}

// Invalidate after a quote outcome changes (won/declined) so the next read relearns.
export function invalidateQuotePricingModel(): void {
  try { sessionStorage.removeItem('eq:quote-pricing-model') } catch { /* ignore */ }
}
