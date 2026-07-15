// ── The ONE home for letter grades ───────────────────────────────────────────
// Grade + its colour ramp lived in two places (lib/profitability, lib/dataQuality)
// with byte-identical values. Both now re-export from here under their original
// names, so no caller had to change.

export type Grade = 'A' | 'B' | 'C' | 'D' | 'F'

// Hex, not tokens, on purpose: these feed Google Maps marker styling, where CSS
// custom properties don't resolve.
export const GRADE_COLORS: Record<Grade, string> = {
  A: '#10B981', B: '#34D399', C: '#F59E0B', D: '#F97316', F: '#EF4444',
}
