import { PricingConfig, recommendedJobPrice, estimateVisitMinutes, SEASON_VISITS } from '@/lib/pricing'
import { DensityTier } from '@/lib/routeDensity'

// ── Smart Price Guardrails — live, NEVER-BLOCK pricing warnings ─────────────────
// Evaluates a price for a SPECIFIC cadence (weekly / biweekly / monthly / one-time
// are judged differently) against the recommended price for the measured lawn,
// the route density, and the crew cost. Returns a warning + the WHY — it never
// blocks saving, it just shows the owner what they're leaving on the table.
//
// Same engine as the Suggestions Center price-raise logic, so the live form and
// the advisor agree. Pure composition of lib/pricing — no new pricing math.

export type Cadence = 'one_time' | 'weekly' | 'biweekly' | 'monthly'

// Cadence price vs the one-time base (mirrors lib/pricing CADENCE_MULT): weekly
// earns a loyalty discount, monthly costs more per visit.
const CADENCE_MULT: Record<Exclude<Cadence, 'one_time'>, number> = { weekly: 0.75, biweekly: 0.85, monthly: 1.1 }

export interface PriceGuardrail {
  level: 'ok' | 'warn'
  cadence: Cadence
  enteredPrice: number
  recommended: number        // cadence-appropriate recommended price (0 if not computable)
  revPerHour: number | null
  reasons: string[]          // WHY — always populated when level === 'warn'
}

export function cadenceLabel(c: Cadence): string { return c === 'one_time' ? 'one-time' : c }

// The recommended price for THIS cadence — base recommendation × the cadence
// multiplier, $5-rounded. 0 when there's no measurement to trust.
export function recommendedForCadence(sqft: number, cadence: Cadence, cfg: PricingConfig): number {
  if (sqft <= 0) return 0
  const base = recommendedJobPrice(sqft, cfg)
  const mult = cadence === 'one_time' ? 1 : CADENCE_MULT[cadence]
  return Math.round((base * mult) / 5) * 5
}

export function evaluatePrice(input: {
  cadence: Cadence
  price: number
  sqft: number                 // measured lawn (0 = unknown → density/crew-cost checks only)
  cfg: PricingConfig
  crewCost: number
  densityTier?: DensityTier | null
  driveMin?: number            // attributed one-way drive, when known (for rev/hr)
}): PriceGuardrail {
  const { cadence, price, sqft, cfg, crewCost } = input
  const recommended = recommendedForCadence(sqft, cadence, cfg)
  const reasons: string[] = []

  // No measurement → no on-site estimate → NO $/hr. This used to substitute 0
  // minutes on site, so `hours` collapsed to drive time alone and the job reported a
  // wildly flattering rate: a $150 stop with a 15-minute drive read $600/hr. Worse
  // than wrong, it was flattering AND it muted check (3) below — an inflated rate
  // never trips the crew-cost floor, so the one guardrail that would have caught it
  // was silently switched off by the very number it was meant to judge.
  // The floor stays fully active wherever on-site time IS known (sqft > 0), which is
  // every existing lawn caller — their behaviour is unchanged.
  const onSite = estimateVisitMinutes(sqft)
  const driveMin = input.driveMin ?? 0
  const hours = onSite != null ? (onSite + driveMin) / 60 : 0
  const revPerHour = hours > 0 && price > 0 ? Math.round(price / hours) : null

  let warn = false
  // (1) Below recommended for this cadence (only when we have a measurement).
  if (recommended > 0 && price > 0 && price < recommended * 0.9) {
    warn = true
    reasons.push(`Below the recommended ${cadenceLabel(cadence)} price of $${recommended} for this ${sqft.toLocaleString()} ft² lawn`)
    if (cadence !== 'one_time') {
      const visits = SEASON_VISITS[cadence]
      const gap = recommended - Math.round(price)
      if (gap > 0) reasons.push(`≈ $${gap * visits}/yr left on the table (${visits} visits/season at +$${gap})`)
    }
  }
  // (2) Isolated property underpriced — the detour isn't shared with neighbours.
  if (input.densityTier === 'isolated' && (recommended === 0 || price <= recommended)) {
    warn = true
    reasons.push('Isolated property — the full drive isn’t shared with neighbours, so price for the detour')
  }
  // (3) Thin against crew cost (revenue/hour floor).
  if (revPerHour != null && crewCost > 0 && revPerHour < Math.round(crewCost * 1.5)) {
    warn = true
    reasons.push(`At $${Math.round(price)} this earns ~$${revPerHour}/hr — thin against your $${crewCost}/hr crew cost`)
  }

  return { level: warn ? 'warn' : 'ok', cadence, enteredPrice: price, recommended, revPerHour, reasons }
}
