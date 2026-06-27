import type { VisionAnalysis } from './types'

// ── AI Vision — ordinal scales ────────────────────────────────────────────────
// Shared "worst → best" orderings so trend, change detection and forecasting all
// agree on what "better" means for a categorical attribute. Higher index = better.
// Attributes where more is WORSE (weeds, overgrowth) put the bad end first so the
// same "up = better" rule holds everywhere.

export const ORDINALS: Record<string, string[]> = {
  lawn_health:     ['poor', 'fair', 'good', 'excellent'],
  mulch_condition: ['bare', 'faded', 'aging', 'good', 'fresh'],
  hedge_condition: ['overgrown', 'slightly_overgrown', 'tidy'],
  // fewer weeds/overgrowth is better → 'none' is the best (highest) rank.
  weeds:           ['high', 'medium', 'low', 'none'],
  overgrowth:      ['high', 'medium', 'low', 'none'],
  edging:          ['none', 'low', 'medium', 'high'],
}

// Rank of a categorical value on its scale, or null when it carries no good/bad
// meaning here (e.g. mulch "none" = no beds, hedge "none" = no hedges, "unknown").
export function ordinalRank(attribute: string, value: string | number | null | undefined): number | null {
  if (value == null) return null
  const scale = ORDINALS[attribute]
  if (!scale) return null
  const i = scale.indexOf(String(value))
  return i < 0 ? null : i
}

// Coverage as a 0-3 number (for weeds/overgrowth severity math). Internal — read
// it through coverageRank() below.
const COVERAGE_RANK: Record<string, number> = { none: 0, low: 1, medium: 2, high: 3 }

// A detection's coverage as a 0-3 rank (0 when absent). THE shared reader — the
// change, opportunity, forecast and marketing engines all used to hand-roll this
// same `det.get(key)…COVERAGE_RANK[…]` lookup; now they share one.
export function coverageRank(analysis: VisionAnalysis, key: string): number {
  const d = analysis.detections?.find(x => x.key === key)
  return d?.present ? (COVERAGE_RANK[d.coverage] ?? 0) : 0
}
