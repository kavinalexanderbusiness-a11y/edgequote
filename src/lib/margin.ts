// ── THE margin / markup calculator ───────────────────────────────────────────
// Pure arithmetic over a price and a cost. It is the ONLY place margin and markup
// are computed, so the quote builder, the templates editor and anything later
// (Price Books) can never disagree about what a margin is.
//
// It does NOT price anything. It judges a price that already exists. Nothing here
// is consulted while a price is being produced — lib/pricing.ts (lawn cadence) and
// serviceLineTotals (qty × unit_price) are untouched and never import this file.
//
// THE HONESTY RULE, and the whole reason this is a module and not two inline
// expressions: an UNKNOWN cost is not a zero cost.
//   cost NULL → margin NULL → the UI shows nothing.
//   cost 0    → margin 100% → the UI says 100%, because that is true.
// Treating NULL as 0 would have claimed 100% margin on every service that has
// never had a cost entered — a confident, wrong number on a money screen. Every
// function here returns `null` for "I don't know" and the callers render nothing.

import type { Tone } from './tone'

const round2 = (n: number) => Math.round(n * 100) / 100
const round1 = (n: number) => Math.round(n * 10) / 10

export interface CostBearing {
  unit_cost?: number | null
  material_cost?: number | null
}

// What one unit costs: labour/subcontract + materials.
// NULL when NEITHER is set — "unknown", never 0. If only one is set, the other is
// genuinely 0 (the owner told us about one and not the other), so it contributes 0
// while the total stays known.
export function totalUnitCost(s: CostBearing | null | undefined): number | null {
  if (!s) return null
  const u = s.unit_cost
  const m = s.material_cost
  if ((u == null || u === undefined) && (m == null || m === undefined)) return null
  return round2((Number(u) || 0) + (Number(m) || 0))
}

// Margin % — the share of the PRICE you keep: (price − cost) / price.
// This is the number that belongs next to a price; it can never exceed 100%.
// NEGATIVE IS A REAL ANSWER and is never clamped: a price under cost is the single
// most important thing this calculator can tell an owner.
export function marginPct(price: number | null | undefined, cost: number | null): number | null {
  if (cost == null) return null
  const p = Number(price) || 0
  if (p <= 0) return null   // no price → no margin to speak of (and no divide by zero)
  return round1(((p - cost) / p) * 100)
}

// Markup % — how far you marked the COST up: (price − cost) / cost.
// Unbounded above (a $0.10 part sold for $10 is 9,900% markup, correctly).
// NULL when cost is 0 or unknown: you cannot mark up nothing, and Infinity is not
// a number an owner can act on.
export function markupPct(price: number | null | undefined, cost: number | null): number | null {
  if (cost == null) return null
  const c = Number(cost) || 0
  if (c <= 0) return null
  return round1((((Number(price) || 0) - c) / c) * 100)
}

// Profit per unit in dollars — the plainest read of the same facts.
export function unitProfit(price: number | null | undefined, cost: number | null): number | null {
  if (cost == null) return null
  return round2((Number(price) || 0) - cost)
}

// ── Solving the other way ─────────────────────────────────────────────────────
// "What should I charge for a 40% margin?" — price = cost / (1 − margin).
// Undefined at 100%+ (you'd be dividing by zero or asking for a negative price).
export function priceForMargin(cost: number | null, targetMarginPct: number): number | null {
  if (cost == null) return null
  const m = Number(targetMarginPct) / 100
  if (!Number.isFinite(m) || m >= 1) return null
  return round2(cost / (1 - m))
}

// "What should I charge at a 50% markup?" — price = cost × (1 + markup).
export function priceForMarkup(cost: number | null, targetMarkupPct: number): number | null {
  if (cost == null) return null
  const m = Number(targetMarkupPct) / 100
  if (!Number.isFinite(m)) return null
  return round2(cost * (1 + m))
}

// ── Presentation helpers ──────────────────────────────────────────────────────
// Losing money is danger, thin is a warning, unknown is nothing at all — an
// absent cost must never look like a healthy one.
//
// This is a SUBSET of the app-wide Tone vocabulary rather than a new one, so a
// margin pill renders through the same toneText/toneSoft tokens (and the same
// <Badge>) as every other status in the product. Type-only import: no runtime
// dependency, this module stays pure arithmetic.
export type MarginTone = Extract<Tone, 'danger' | 'warn' | 'success' | 'neutral'>

export function marginTone(pct: number | null): MarginTone {
  if (pct == null) return 'neutral'
  if (pct < 0) return 'danger'      // priced below cost
  if (pct < 15) return 'warn'       // thin enough to be worth seeing
  return 'success'
}

// "42.5% margin" · "—" when unknown. Never invents a number.
export function formatPct(pct: number | null): string {
  return pct == null ? '—' : `${pct}%`
}
