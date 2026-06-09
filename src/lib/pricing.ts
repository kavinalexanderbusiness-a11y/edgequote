// ── Centralized pricing engine ──────────────────────────────────────────────
// The ONE place pricing math lives. Measurement Tool, Quote Builder, suggested
// pricing, travel discounting and confidence scoring all call through here so
// the numbers never diverge.

import type { PricingConfidence } from '@/types'

// Recommended sits ABOVE market on purpose — we prioritise profitability and
// never aim to be the cheapest. Premium is the upsell anchor.
export const TIER_MULTIPLIERS = { budget: 0.9, market: 1.0, recommended: 1.15, premium: 1.3 } as const
export type PriceTier = keyof typeof TIER_MULTIPLIERS

export const TIER_LABELS: Record<PriceTier, string> = {
  budget: 'Budget',
  market: 'Market',
  recommended: 'Recommended',
  premium: 'Premium',
}

// Sensible starting rate so a measured lawn prices itself with zero typing.
// Overridable in the UI (and remembered locally).
export const DEFAULT_RATE_PER_1000 = 20

// Always round UP to a clean number ($58 → $60, $63 → $65). Confident pricing.
export function roundUpToNice(n: number, step = 5): number {
  if (n <= 0) return 0
  return Math.ceil(n / step) * step
}

// Round to the nearest clean step.
export function roundToStep(n: number, step = 5): number {
  if (n <= 0) return 0
  return Math.round(n / step) * step
}

// Round DOWN to a clean step — used for the travel discount so the advertised
// discount is always at least honoured (never silently eroded by rounding up).
export function roundDownToStep(n: number, step = 5): number {
  if (n <= 0) return 0
  return Math.floor(n / step) * step
}

export interface AreaPriceInput {
  sqft: number
  ratePer1000: number
  overgrowth?: number // multiplier (1 = normal)
  travelFee?: number  // accepted for backward-compat; tiers are JOB-only and ignore it
}

export interface TierPrice {
  tier: PriceTier
  label: string
  amount: number      // JOB price only — travel is shown & added separately
  recommended: boolean
}

// Labour-equivalent base before tiers: area × rate × condition.
export function areaBase(input: AreaPriceInput): number {
  const og = input.overgrowth && input.overgrowth > 0 ? input.overgrowth : 1
  return (Math.max(0, input.sqft) / 1000) * Math.max(0, input.ratePer1000) * og
}

// Full tier set for a measured area, each rounded up. JOB price only — travel is
// computed and presented as its own line so the customer sees an honest split.
export function priceTiers(input: AreaPriceInput): TierPrice[] {
  const base = areaBase(input)
  return (Object.keys(TIER_MULTIPLIERS) as PriceTier[]).map(tier => ({
    tier,
    label: TIER_LABELS[tier],
    recommended: tier === 'recommended',
    amount: roundUpToNice(base * TIER_MULTIPLIERS[tier]),
  }))
}

// Recommended JOB price only (no travel).
export function recommendedJobPrice(input: AreaPriceInput): number {
  return roundUpToNice(areaBase(input) * TIER_MULTIPLIERS.recommended)
}

// ── Travel ──────────────────────────────────────────────────────────────────
// Reward route density: the more existing jobs already near a property, the
// cheaper its travel — the truck is in the area anyway. One rule, used wherever
// travel is suggested so the discount can never drift between screens.
export interface TravelComputation {
  baseFee: number      // tier fee from Settings, before any discount
  discountPct: number  // 0..1 route-density discount actually applied
  fee: number          // effective fee after the density discount (clean $5 step)
  nearbyCount: number  // existing nearby jobs that drove the discount
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
// How sure are we about a suggested price? High when we measured AND have
// comparable nearby jobs; low when we have neither.
export function pricingConfidence(opts: { hasMeasurement: boolean; nearbyComparables: number }): PricingConfidence {
  const m = opts.hasMeasurement
  const n = Math.max(0, opts.nearbyComparables || 0)
  if (m && n >= 1) return 'high'
  if (m || n >= 1) return 'medium'
  return 'low'
}

// Labour-based suggestion (Quote Builder) — same rounding for consistency.
export function laborSuggestion(hours: number, crew: number, ratePerHour: number, overgrowth = 1): number {
  const og = overgrowth > 0 ? overgrowth : 1
  return roundUpToNice(Math.max(0, hours) * Math.max(0, crew) * Math.max(0, ratePerHour) * og)
}
