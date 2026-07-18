import { PricingConfig, recommendedJobPrice, estimateVisitMinutes, SEASON_VISITS, cadenceMultipliers, roundToStep } from '@/lib/pricing'
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

// A private `CADENCE_MULT = {weekly:0.75, biweekly:0.85, monthly:1.1}` used to sit
// here, commented "mirrors lib/pricing CADENCE_MULT". "Mirrors" was the admission:
// it was a hand-copy, under a header promising "no new pricing math", and it
// mirrored only the NEUTRAL half of the engine. pricingPackage() swaps to the
// value-graded curve whenever a customer has a grade, so for every graded customer
// this file judged prices against a curve the engine had not used — see the
// evaluatePrice() note below. The multipliers now come from the engine's own
// cadenceMultipliers() seam; this file holds no pricing constants at all.

export interface PriceGuardrail {
  level: 'ok' | 'warn'
  cadence: Cadence
  enteredPrice: number
  recommended: number        // cadence-appropriate recommended price (0 if not computable)
  revPerHour: number | null
  reasons: string[]          // WHY — always populated when level === 'warn'
}

export function cadenceLabel(c: Cadence): string { return c === 'one_time' ? 'one-time' : c }

// The recommended price for THIS cadence — the engine's own recommendation ×
// the engine's own cadence multiplier, $5-rounded. 0 when there's no measurement.
//
// `ctx` must carry the SAME context the price on screen was built with:
//   valueGrade  — pricingPackage() prices a graded customer on the value curve.
//                 Judging that price on the neutral curve is what made the app
//                 warn about its own recommendation.
//   overgrowth  — recommendedJobPrice() multiplies the base by it. Omitting it
//                 made the guardrail bless a heavily-overgrown job at ~half the
//                 engine's price, silently, on exactly the visits where
//                 underpricing costs the most.
// Both are optional and default to the neutral/×1 case, so existing callers keep
// their exact behaviour — but a caller that HAS this context must pass it.
export function recommendedForCadence(
  sqft: number,
  cadence: Cadence,
  cfg: PricingConfig,
  ctx?: { valueGrade?: string | null; overgrowth?: number },
): number {
  if (sqft <= 0) return 0
  const base = recommendedJobPrice(sqft, cfg, ctx?.overgrowth ?? 1)
  const mult = cadence === 'one_time' ? 1 : cadenceMultipliers(ctx?.valueGrade)[cadence]
  return roundToStep(base * mult)
}

export function evaluatePrice(input: {
  cadence: Cadence
  price: number
  sqft: number                 // measured lawn (0 = unknown → density/crew-cost checks only)
  cfg: PricingConfig
  crewCost: number
  densityTier?: DensityTier | null
  driveMin?: number            // attributed one-way drive, when known (for rev/hr)
  /** The customer's strategic grade — pricingPackage() prices a graded customer
   *  on the value curve, and a guardrail judging that price on the neutral curve
   *  warns about the engine's own recommendation. REQUIRED (pass null when the
   *  caller prices neutrally) so the compiler forces every caller to state it —
   *  optional-and-defaulted is how this silently judged on the wrong curve. */
  valueGrade: string | null
  /** Condition multiplier — the engine folds it into the base, so omitting it
   *  judges an overgrown job against a normal-condition price. REQUIRED (pass 1
   *  when unknown) for the same reason. */
  overgrowth: number
}): PriceGuardrail {
  const { cadence, price, sqft, cfg, crewCost } = input
  const recommended = recommendedForCadence(sqft, cadence, cfg, {
    valueGrade: input.valueGrade ?? null,
    overgrowth: input.overgrowth ?? 1,
  })
  const reasons: string[] = []

  // No measurement → no on-site estimate → NO $/hr. Substituting 0 minutes here
  // used to collapse `hours` to drive time alone and report a wildly flattering
  // rate: a $150 stop with a 15-minute drive read $600/hr. Worse than wrong, it
  // muted check (3) below — an inflated rate never trips the crew-cost floor, so
  // the one guardrail that would have caught it was switched off by the very
  // number it was meant to judge.
  // Where on-site time IS known, it scales with the work — overgrowth belongs
  // here too: a ×2 cut is twice the visit, and charging the same $/hr for it is
  // the point.
  const onSiteBase = estimateVisitMinutes(sqft)
  const onSite = onSiteBase != null ? onSiteBase * (input.overgrowth ?? 1) : null
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
