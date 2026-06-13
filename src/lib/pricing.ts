// ── Centralized pricing engine ──────────────────────────────────────────────
// The ONE place pricing math lives. Measurement Tool, Quote Builder, suggested
// pricing, travel and confidence all call through here so numbers never diverge.
//
// Residential lawn pricing is NOT linear-from-zero — it's a base service charge
// (the minimum to show up) plus a per-area rate. Defaults below are fit to real
// Calgary mow+trim+edge pricing:
//   ~500–1,000 ft²  → $35–45
//   ~1,000–2,000 ft²→ $45–60
//   ~2,000–3,500 ft²→ $60–80
//   3,500+ ft²      → $80+
// Recommended (the everyday quote) = base × 1.0, deliberately NOT inflated.

import type { PricingConfidence, SavedRecommendation, MeasurementSnapshot } from '@/types'

export type PriceTier = 'budget' | 'market' | 'recommended' | 'premium'

export const TIER_LABELS: Record<PriceTier, string> = {
  budget: 'Budget',
  market: 'Market',
  recommended: 'Recommended',
  premium: 'Premium',
}

// Everything tunable from Settings without code changes.
export interface PricingConfig {
  baseCharge: number       // minimum / show-up charge ($)
  mowRatePer1000: number   // $ per 1,000 ft² above the base
  budgetMult: number
  marketMult: number
  recommendedMult: number  // Recommended = base × this (1.0 = the realistic going rate)
  premiumMult: number
  travelRatePerKm: number  // $ per km of driving distance
}

export const DEFAULT_PRICING: PricingConfig = {
  baseCharge: 28,
  mowRatePer1000: 15,
  budgetMult: 0.8,
  marketMult: 0.92,
  recommendedMult: 1.0,
  premiumMult: 1.2,
  travelRatePerKm: 1.5,
}

// Loose shape so business_settings rows (which may have nulls) map cleanly.
export interface PricingSettingsInput {
  pricing_base_charge?: number | null
  pricing_mow_rate?: number | null
  pricing_recommended_mult?: number | null
  pricing_premium_mult?: number | null
  pricing_travel_rate?: number | null
}

function pos(v: unknown, fallback: number): number {
  const n = Number(v)
  return Number.isFinite(n) && n > 0 ? n : fallback
}

// Build the active config from saved settings, falling back to sensible defaults.
export function pricingConfigFromSettings(s?: PricingSettingsInput | null): PricingConfig {
  return {
    baseCharge: pos(s?.pricing_base_charge, DEFAULT_PRICING.baseCharge),
    mowRatePer1000: pos(s?.pricing_mow_rate, DEFAULT_PRICING.mowRatePer1000),
    budgetMult: DEFAULT_PRICING.budgetMult,
    marketMult: DEFAULT_PRICING.marketMult,
    recommendedMult: pos(s?.pricing_recommended_mult, DEFAULT_PRICING.recommendedMult),
    premiumMult: pos(s?.pricing_premium_mult, DEFAULT_PRICING.premiumMult),
    travelRatePerKm: pos(s?.pricing_travel_rate, DEFAULT_PRICING.travelRatePerKm),
  }
}

// ── Rounding ──────────────────────────────────────────────────────────────────
// Tiers round to the NEAREST clean $5 (realistic, never inflated). Labour
// suggestions round UP. Travel discount rounds DOWN (so an advertised % holds).
export function roundToStep(n: number, step = 5): number {
  if (n <= 0) return 0
  return Math.round(n / step) * step
}
export function roundUpToNice(n: number, step = 5): number {
  if (n <= 0) return 0
  return Math.ceil(n / step) * step
}
export function roundDownToStep(n: number, step = 5): number {
  if (n <= 0) return 0
  return Math.floor(n / step) * step
}

// The realistic going-rate base for a measured lawn (before tier multipliers).
export function lawnBasePrice(sqft: number, cfg: PricingConfig, overgrowth = 1): number {
  if (sqft <= 0) return 0
  const og = overgrowth > 0 ? overgrowth : 1
  return (cfg.baseCharge + (Math.max(0, sqft) / 1000) * cfg.mowRatePer1000) * og
}

function tierMult(cfg: PricingConfig, tier: PriceTier): number {
  switch (tier) {
    case 'budget': return cfg.budgetMult
    case 'market': return cfg.marketMult
    case 'recommended': return cfg.recommendedMult
    case 'premium': return cfg.premiumMult
  }
}

export interface TierPrice {
  tier: PriceTier
  label: string
  amount: number      // JOB price only — travel is shown & added separately
  recommended: boolean
}

// Job-only tier prices for a measured area, each rounded to a clean $5.
export function priceTiers(sqft: number, cfg: PricingConfig, overgrowth = 1): TierPrice[] {
  const base = lawnBasePrice(sqft, cfg, overgrowth)
  return (['budget', 'market', 'recommended', 'premium'] as PriceTier[]).map(tier => ({
    tier,
    label: TIER_LABELS[tier],
    recommended: tier === 'recommended',
    amount: roundToStep(base * tierMult(cfg, tier)),
  }))
}

// The everyday Recommended job price (no travel).
export function recommendedJobPrice(sqft: number, cfg: PricingConfig, overgrowth = 1): number {
  return roundToStep(lawnBasePrice(sqft, cfg, overgrowth) * cfg.recommendedMult)
}

// ── Travel ──────────────────────────────────────────────────────────────────
// Configurable per-km travel rate, then a route-density discount (the truck is
// already in the area). One rule, used everywhere travel is suggested.
export function travelFeeForDistance(km: number | null | undefined, cfg: PricingConfig): number {
  if (!km || km <= 0) return 0
  return roundToStep(km * cfg.travelRatePerKm)
}

export interface TravelComputation {
  baseFee: number      // tier/rate fee before any discount
  discountPct: number  // 0..1 route-density discount actually applied
  fee: number          // effective fee after the density discount (clean $5)
  nearbyCount: number
}

export function routeDensityTravel(baseFee: number, nearbyCount: number): TravelComputation {
  const base = Math.max(0, baseFee || 0)
  let discountPct = 0
  if (nearbyCount >= 3) discountPct = 1          // already a dense run → travel waived
  else if (nearbyCount >= 1) discountPct = 0.5   // partway there → half travel
  // Round DOWN so a displayed "−50%" is always at least a 50% discount.
  return { baseFee: base, discountPct, fee: roundDownToStep(base * (1 - discountPct)), nearbyCount }
}

// ── Confidence ────────────────────────────────────────────────────────────────
export function pricingConfidence(opts: { hasMeasurement: boolean; nearbyComparables: number }): PricingConfidence {
  const m = opts.hasMeasurement
  const n = Math.max(0, opts.nearbyComparables || 0)
  if (m && n >= 1) return 'high'
  if (m || n >= 1) return 'medium'
  return 'low'
}

// Labour-based suggestion (Quote Builder) — rounds UP for a confident floor.
export function laborSuggestion(hours: number, crew: number, ratePerHour: number, overgrowth = 1): number {
  const og = overgrowth > 0 ? overgrowth : 1
  return roundUpToNice(Math.max(0, hours) * Math.max(0, crew) * Math.max(0, ratePerHour) * og)
}

// ── Pricing recommendation package ───────────────────────────────────────────
// One measurement → the complete answer: what to charge per cadence, what each
// option is worth per season, which one to push, whether the property is worth
// pursuing, and how low is too low. All derived from the SAME recommended price
// + tier multipliers above — never a second pricing system.

export type CadenceKey = 'one_time' | 'weekly' | 'biweekly' | 'monthly'

// On-site time estimate from lawn size (mow+trim+edge, solo): ~20 min setup/
// minimum plus ~1 min per 150 ft². Feeds the prospect $/hr estimate.
// When the owner's OWN check-in/check-out data exists (observed minutes per
// 1,000 ft² from completed timed jobs), it replaces the generic model — every
// completed job makes future estimates more accurate.
export function estimateVisitMinutes(sqft: number, observedMinPer1000?: number | null): number {
  if (sqft <= 0) return 45
  if (observedMinPer1000 && observedMinPer1000 > 0) {
    return Math.round(Math.min(90, Math.max(15, (sqft / 1000) * observedMinPer1000)))
  }
  return Math.round(Math.min(75, Math.max(20, 20 + sqft / 150)))
}

// Calgary mowing season ≈ April–October.
export const SEASON_VISITS: Record<Exclude<CadenceKey, 'one_time'>, number> = {
  weekly: 28,
  biweekly: 14,
  monthly: 7,
}

// Cadence price vs the one-time price: weekly earns a loyalty discount (easy,
// regular cuts), bi-weekly a smaller one, monthly costs MORE per visit (a month
// of growth is a harder cut). This is the NEUTRAL baseline used when the
// customer's strategic value is unknown.
const CADENCE_MULT: Record<Exclude<CadenceKey, 'one_time'>, number> = {
  weekly: 0.75,
  biweekly: 0.85,
  monthly: 1.1,
}

// ── Value-based recurring pricing ─────────────────────────────────────────────
// The recurring discount should reflect the customer's BUSINESS value, not just
// lawn size. A strategically valuable customer (A+ route asset — dense route,
// strong neighborhood, recurring opportunity) earns competitive recurring
// pricing because route density absorbs travel. A route liability (F — isolated,
// long drive, weak area) should hold or raise pricing to offset the inefficiency.
//
// The grade is the EXISTING prospect score (route grading + ownership). We don't
// re-grade here — we map it to how aggressive the recurring discount should be.

// 0 = protective (hold/raise price), 1 = aggressive (competitive recurring).
export function gradeAggressiveness(grade: string | null | undefined): number {
  switch (grade) {
    case 'A+': return 1.0
    case 'A': return 0.85
    case 'B': return 0.65
    case 'C': return 0.45
    case 'D': return 0.2
    case 'F': return 0.0
    default: return 0.5
  }
}

// Confidence label per the owner's grade scale — reuses the grade, no new system.
export function gradeConfidenceLabel(grade: string | null | undefined): string {
  if (grade === 'A+' || grade === 'A') return 'Route Asset'
  if (grade === 'B') return 'Good Customer'
  if (grade === 'C') return 'Neutral'
  if (grade === 'D') return 'Weak Customer'
  if (grade === 'F') return 'Route Liability'
  return 'Customer'
}

// Recurring multipliers slid by strategic value. Endpoints chosen so a $75
// one-time lawn yields ≈$50–55 weekly for an A+ (aggressive) and ≈$70–75 for an
// F (protective) — matching the owner's intent.
//
// IMPORTANT: computed INLINE with no nested closure, and the parameter is named
// distinctly from the caller's `agg`. A previous version used a `lerp` closure
// that captured this parameter (`agg`); when the production minifier inlined
// this function into pricingPackage (which also has a `const agg`), it mis-
// renamed the captured variable and emitted a stale free `agg` reference →
// "ReferenceError: agg is not defined" at runtime (3rd measurement point). Do
// NOT reintroduce a closure that captures a parameter sharing the caller's name.
function valueCadenceMult(aggression: number): Record<Exclude<CadenceKey, 'one_time'>, number> {
  return {
    weekly: 0.95 + (0.68 - 0.95) * aggression,
    biweekly: 0.98 + (0.80 - 0.98) * aggression,
    monthly: 1.15 + (1.05 - 1.15) * aggression,
  }
}

export interface ValuePricingInfo {
  grade: string
  confidence: string                                   // "A+ Route Asset"
  aggressiveness: 'aggressive' | 'standard' | 'protective'
  reasons: string[]                                    // route-aware WHY
}

export interface CadenceOption {
  cadence: Exclude<CadenceKey, 'one_time'>
  price: number
  visits: number
  annual: number
}

export interface PricingGuidance {
  suggested: number
  rangeLow: number     // market tier
  rangeHigh: number
  minimum: number      // don't quote below this
  avoidBelow: number   // budget tier — walking-away territory
}

export interface RouteValueVerdict {
  verdict: 'excellent' | 'good' | 'marginal'
  bullets: string[]
}

export interface PricingPackage {
  oneTime: number
  options: CadenceOption[]          // weekly / biweekly / monthly
  recommended: { cadence: CadenceKey; reasons: string[] }
  routeValue: RouteValueVerdict
  guidance: PricingGuidance         // for the recommended cadence's price
  valuePricing?: ValuePricingInfo   // present when a customer grade was supplied
}

export function pricingGuidance(price: number, cfg: PricingConfig): PricingGuidance {
  return {
    suggested: price,
    rangeLow: roundToStep(price * cfg.marketMult),
    rangeHigh: roundToStep(price * 1.1),
    minimum: roundToStep(price * cfg.marketMult),
    avoidBelow: roundToStep(price * cfg.budgetMult),
  }
}

export function pricingPackage(
  sqft: number,
  cfg: PricingConfig,
  ctx: { overgrowth?: number; nearbyCount: number; neighborhoodName?: string | null; valueGrade?: string | null },
): PricingPackage {
  const oneTime = recommendedJobPrice(sqft, cfg, ctx.overgrowth ?? 1)
  // Recurring multipliers reflect strategic value when a grade is supplied;
  // otherwise the neutral baseline (backward compatible for callers without it).
  const grade = ctx.valueGrade ?? null
  const agg = gradeAggressiveness(grade)
  const mult = grade ? valueCadenceMult(agg) : CADENCE_MULT
  const options: CadenceOption[] = (['weekly', 'biweekly', 'monthly'] as const).map(c => {
    const price = roundToStep(oneTime * mult[c])
    return { cadence: c, price, visits: SEASON_VISITS[c], annual: price * SEASON_VISITS[c] }
  })
  const weekly = options[0]

  // Which cadence to push: weekly always carries the highest season revenue, so
  // it wins whenever the stop fits the route. An isolated property gets the
  // bi-weekly pitch — easier yes, less commitment to a lone stop.
  const nearby = Math.max(0, ctx.nearbyCount || 0)
  const recommended = nearby >= 1
    ? {
        cadence: 'weekly' as CadenceKey,
        reasons: [
          `Highest season revenue — $${weekly.annual.toLocaleString()} vs $${options[1].annual.toLocaleString()} bi-weekly`,
          `Fits your existing route (${nearby} job${nearby !== 1 ? 's' : ''} nearby)`,
          'Strong recurring value — easy, regular cuts',
        ],
      }
    : {
        cadence: 'biweekly' as CadenceKey,
        reasons: [
          'Better price acceptance for a new area',
          `Strong season revenue — $${options[1].annual.toLocaleString()}`,
          'Lower commitment to an isolated stop while the route grows',
        ],
      }

  // Is this property worth pursuing? Same signals as the travel-density rule.
  const hood = ctx.neighborhoodName?.trim()
  const routeValue: RouteValueVerdict = nearby >= 3
    ? {
        verdict: 'excellent',
        bullets: [
          `${nearby} jobs already nearby — strong route density`,
          hood ? `${hood} is an active area for you` : 'The truck is already in this area',
          `Weekly value: $${weekly.annual.toLocaleString()}/season`,
        ],
      }
    : nearby >= 1
      ? {
          verdict: 'good',
          bullets: [
            `${nearby} job${nearby !== 1 ? 's' : ''} nearby — builds route density`,
            `Weekly value: $${weekly.annual.toLocaleString()}/season`,
            hood ? `Grows your ${hood} cluster` : 'Helps anchor a route in this area',
          ],
        }
      : {
          verdict: 'marginal',
          bullets: [
            'Isolated — no nearby jobs on the schedule',
            `Weekly value: $${weekly.annual.toLocaleString()}/season`,
            'Worth it at full price + travel, or as a beachhead for door-knocking',
          ],
        }

  const recPrice = recommended.cadence === 'weekly' ? weekly.price : options[1].price

  // Value-based explanation — only when a grade is known.
  let valuePricing: ValuePricingInfo | undefined
  if (grade) {
    const reasons: string[] = []
    if (nearby >= 3) reasons.push(`Travel absorbed by your existing ${hood ?? 'route'} — strong cluster.`)
    else if (nearby >= 1) reasons.push(`Builds density${hood ? ` in ${hood}` : ''} — partial travel absorption.`)
    else reasons.push(hood ? `First customer in ${hood} — beachhead pricing.` : 'Creates an isolated stop — price holds to cover the extra drive.')
    if (agg >= 0.85) reasons.push('Strategically valuable — competitive recurring pricing to win and keep them.')
    else if (agg <= 0.2) reasons.push('Low route value — maintain or raise pricing to offset route inefficiency.')
    else reasons.push('Solid customer — standard recurring discount.')
    valuePricing = {
      grade,
      confidence: `${grade} ${gradeConfidenceLabel(grade)}`,
      aggressiveness: agg >= 0.85 ? 'aggressive' : agg <= 0.2 ? 'protective' : 'standard',
      reasons,
    }
  }

  return { oneTime, options, recommended, routeValue, guidance: pricingGuidance(recPrice, cfg), valuePricing }
}

// ── Saved measurement recommendations ─────────────────────────────────────────
// The package above, flattened for storage in a property's measurement_history
// snapshot — so quotes/jobs can suggest measured prices without re-measuring.

export function buildSavedRecommendation(
  pkg: PricingPackage,
  estMinutes: number,
  extras?: { score?: string | null; hood?: string | null },
): SavedRecommendation {
  return {
    one_time: pkg.oneTime,
    weekly: pkg.options[0].price,
    biweekly: pkg.options[1].price,
    monthly: pkg.options[2].price,
    cadence: pkg.recommended.cadence,
    season_weekly: pkg.options[0].annual,
    season_biweekly: pkg.options[1].annual,
    season_monthly: pkg.options[2].annual,
    est_minutes: estMinutes,
    score: extras?.score ?? null,
    hood: extras?.hood ?? null,
  }
}

// Latest snapshot that carries a recommendation (newest wins).
export function latestSavedRecommendation(history: MeasurementSnapshot[] | null | undefined):
  { rec: SavedRecommendation; sqft: number; date: string } | null {
  if (!Array.isArray(history)) return null
  for (let i = history.length - 1; i >= 0; i--) {
    const h = history[i]
    if (h?.recommendation) return { rec: h.recommendation, sqft: h.total_sqft ?? h.lawn_sqft ?? 0, date: h.date }
  }
  return null
}

// Is a saved recommendation stale? Pricing/rates drift, so anything older than
// a season cycle (12 months) should prompt a recalculation. nowMs is injected so
// callers (and tests) control "now" — pass Date.now() at the call site.
export function recommendationIsStale(dateISO: string, nowMs: number): boolean {
  const TWELVE_MONTHS_MS = 365 * 24 * 60 * 60 * 1000
  return nowMs - new Date(dateISO).getTime() > TWELVE_MONTHS_MS
}

// Saved price for a cadence key ('one_time' | 'weekly' | 'biweekly' | 'monthly').
export function savedPriceFor(rec: SavedRecommendation, cadence: CadenceKey): number {
  return cadence === 'weekly' ? rec.weekly : cadence === 'biweekly' ? rec.biweekly : cadence === 'monthly' ? rec.monthly : rec.one_time
}
