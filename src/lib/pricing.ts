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

import type { PricingConfidence } from '@/types'

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
export function estimateVisitMinutes(sqft: number): number {
  if (sqft <= 0) return 45
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
// of growth is a harder cut).
const CADENCE_MULT: Record<Exclude<CadenceKey, 'one_time'>, number> = {
  weekly: 0.75,
  biweekly: 0.85,
  monthly: 1.1,
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
  ctx: { overgrowth?: number; nearbyCount: number; neighborhoodName?: string | null },
): PricingPackage {
  const oneTime = recommendedJobPrice(sqft, cfg, ctx.overgrowth ?? 1)
  const options: CadenceOption[] = (['weekly', 'biweekly', 'monthly'] as const).map(c => {
    const price = roundToStep(oneTime * CADENCE_MULT[c])
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
  return { oneTime, options, recommended, routeValue, guidance: pricingGuidance(recPrice, cfg) }
}
