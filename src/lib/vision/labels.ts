// ── AI Vision — display vocabulary ────────────────────────────────────────────
// One source of truth for how detected features / difficulty / upsells are named
// and coloured, so the report, any future embed, and the context block never
// drift. Keys come from lib/vision/types.

import type { ConfidenceBand, Difficulty, FeatureKey } from './types'
import type { Tone } from '@/lib/tone'

// Confidence band → tone, defined ONCE so every chip agrees (these used to be
// re-declared inline in 4 components, and the 'low' value had drifted).
//   • CONFIDENCE_TONE — for an ANALYSIS's trust level: low = danger (shaky read).
//   • FORECAST_TONE   — for a PREDICTION's certainty: low = neutral (just rougher,
//     not "bad"), so a low-confidence forecast doesn't render alarmingly red.
export const CONFIDENCE_TONE: Record<ConfidenceBand, Tone> = { high: 'success', medium: 'warn', low: 'danger' }
export const FORECAST_TONE: Record<ConfidenceBand, Tone> = { high: 'success', medium: 'warn', low: 'neutral' }

// The short calendar date AI Vision shows everywhere ("2026-06-27"). One helper
// so the `(iso || '').slice(0, 10)` that was sprinkled across components + the
// context block lives in a single place.
export function shortDate(iso: string | null | undefined): string {
  return (iso || '').slice(0, 10)
}

export const FEATURE_LABELS: Record<FeatureKey, string> = {
  mowing_completed: 'Mowing completed',
  edging: 'Edging',
  trimming: 'Trimming',
  mulch: 'Mulch',
  rock: 'Rock',
  weeds: 'Weeds',
  overgrowth: 'Overgrowth',
  trees: 'Trees',
  fences: 'Fences',
  gardens: 'Gardens',
  driveways: 'Driveways',
  obstacles: 'Obstacles',
}

// A detected feature is "good" (work done / a clean asset), "watch" (a condition
// worth flagging), or neutral. Drives the chip colour — purely cosmetic, never a
// pricing signal.
const FEATURE_TONE: Record<FeatureKey, Tone> = {
  mowing_completed: 'success',
  edging: 'success',
  trimming: 'success',
  mulch: 'neutral',
  rock: 'neutral',
  weeds: 'warn',
  overgrowth: 'warn',
  trees: 'neutral',
  fences: 'neutral',
  gardens: 'neutral',
  driveways: 'neutral',
  obstacles: 'warn',
}
export function featureTone(key: FeatureKey): Tone {
  return FEATURE_TONE[key] ?? 'neutral'
}

export const DIFFICULTY_LABELS: Record<Difficulty, string> = {
  easy: 'Easy',
  moderate: 'Moderate',
  hard: 'Hard',
  severe: 'Severe',
}

export const DIFFICULTY_TONE: Record<Difficulty, Tone> = {
  easy: 'success',
  moderate: 'info',
  hard: 'warn',
  severe: 'danger',
}
