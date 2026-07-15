// ── Data-quality scoring ─────────────────────────────────────────────────────
// Pure helpers for the Data Quality dashboard. Coverage = the share of records
// that are clean (linked / priced). Reused so the score is computed one way.

import type { Grade } from './grade'

export interface CoverageRow {
  key: string
  label: string
  covered: number
  total: number
  pct: number
  hint: string
}

export function coveragePct(covered: number, total: number): number {
  if (total <= 0) return 100
  return Math.round((covered / total) * 100)
}

// Aliases of the shared lib/grade types — kept under the DQ* names so this
// module's importers are unchanged.
export type DQGrade = Grade

// Overall score = the average of every coverage dimension that actually has
// records (empty dimensions are 100% and excluded so they don't mask real gaps).
export function overallScore(rows: CoverageRow[]): number {
  const real = rows.filter(r => r.total > 0)
  if (!real.length) return 100
  return Math.round(real.reduce((s, r) => s + r.pct, 0) / real.length)
}

export function scoreGrade(score: number): DQGrade {
  return score >= 95 ? 'A' : score >= 85 ? 'B' : score >= 70 ? 'C' : score >= 50 ? 'D' : 'F'
}

export { GRADE_COLORS as DQ_GRADE_COLORS } from './grade'

export function scoreLabel(score: number): string {
  return score >= 95 ? 'Trustworthy' : score >= 85 ? 'Mostly clean' : score >= 70 ? 'Some gaps' : score >= 50 ? 'Major gaps' : 'Unreliable'
}
