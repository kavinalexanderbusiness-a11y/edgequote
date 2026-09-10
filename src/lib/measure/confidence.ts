// ── How much to trust a measurement ──────────────────────────────────────────
// The audit's one-sentence finding was that "EdgeQuote invents numbers and then
// tells the owner they were confirmed." This file is the answer to that: every
// measurement carries how it was obtained and why we do or don't trust it, in
// words the owner can read.
//
// A confidence with no reason is decoration. Every level below ships a sentence,
// because "medium" alone tells an owner nothing about whether to go and look.
//
// THE RULE THAT MATTERS: WE REFUSE RATHER THAN GUESS.
// The old auto-measure multiplied a building footprint by DEFAULT_LAWN_RATIO=2.3
// and returned a number for anything asked of it. 2.3 is a Calgary lawn heuristic.
// It is meaningless for a driveway (unrelated to footprint), a roof (≈1.0), a
// hedge (a length, not an area) or a tree (a count). Returning 2.3 × footprint for
// those isn't a low-confidence measurement, it's a fabricated one — and the audit
// found the product then badged fabrications "✓ Applied".
//
// So: auto-measure is offered for LAWN ONLY (kinds.canAuto), and asking for
// anything else returns a refusal with a reason — not a number with a caveat.

import type { MeasurementKind, MeasurementSource } from './kinds'
import { kindDef } from './kinds'

export type Confidence = 'high' | 'medium' | 'low'

export interface ConfidenceAssessment {
  level: Confidence
  /** One sentence, shown to the owner. Never a code, never empty. */
  reason: string
  /** true when the owner should go and check before quoting off this. */
  needsReview: boolean
}

/** Evidence behind an auto-measure, for scoring. */
export interface AutoEvidence {
  /** Ratio actually used (footprint → lawn). */
  ratio: number
  /** Whether that ratio was LEARNED for this neighbourhood or is the fallback. */
  learned: boolean
  /** How many measured properties the learned ratio came from. */
  sampleCount: number
  /** Whether the imagery provider actually hit the property. */
  hitOnPoint: boolean
}

/** Below this many samples a neighbourhood ratio is an anecdote, not a rate. */
export const MIN_SAMPLES_FOR_LEARNED_RATIO = 5

/**
 * Score a measurement.
 *
 * Traced and manual are both HIGH, for different reasons, and neither is a guess
 * by EdgeQuote: traced means a human drew the shape against imagery; manual means
 * a human typed a number they are asserting. We record which, so nobody later
 * mistakes one for the other — but we don't second-guess the owner's own figure.
 * Auto is the only source EdgeQuote itself produces, so it's the only one that can
 * be less than trustworthy.
 */
export function assessConfidence(args: {
  source: MeasurementSource
  kind: MeasurementKind
  evidence?: AutoEvidence | null
}): ConfidenceAssessment {
  const { source, kind, evidence } = args
  const d = kindDef(kind)

  if (source === 'traced') {
    return {
      level: 'high',
      reason: `Traced on the map — ${d.unit === 'count' ? 'each one placed' : 'measured from the shape you drew'}.`,
      needsReview: false,
    }
  }

  if (source === 'manual') {
    return {
      level: 'high',
      reason: 'Entered by you. EdgeQuote is not estimating this — it is your number.',
      needsReview: false,
    }
  }

  // ── auto ──
  if (!d.canAuto) {
    // Should be unreachable: autoMeasureFor() refuses first. Kept because a wrong
    // answer here reaches a customer's quote, and "low" would imply we tried.
    return {
      level: 'low',
      reason: `EdgeQuote cannot estimate ${d.noun} from imagery — this needs tracing or entering.`,
      needsReview: true,
    }
  }

  if (!evidence) {
    return { level: 'low', reason: 'Estimated with no supporting data. Trace it to be sure.', needsReview: true }
  }

  if (!evidence.hitOnPoint) {
    return {
      level: 'low',
      reason: 'The building footprint for this address could not be found, so the estimate is from the area around the pin. Worth checking.',
      needsReview: true,
    }
  }

  if (evidence.learned && evidence.sampleCount >= MIN_SAMPLES_FOR_LEARNED_RATIO) {
    return {
      level: 'medium',
      reason: `Estimated from the building footprint, using a ratio learned from ${evidence.sampleCount} measured ${evidence.sampleCount === 1 ? 'property' : 'properties'} nearby.`,
      needsReview: false,
    }
  }

  if (evidence.learned) {
    return {
      level: 'low',
      reason: `Estimated from a ratio based on only ${evidence.sampleCount} nearby ${evidence.sampleCount === 1 ? 'property' : 'properties'} — not enough to rely on yet.`,
      needsReview: true,
    }
  }

  return {
    level: 'low',
    reason: 'Estimated from the building footprint using a default ratio — nobody has measured this neighbourhood yet. Trace it before quoting.',
    needsReview: true,
  }
}

export type AutoRefusal = { ok: false; reason: string }
export type AutoAllowed = { ok: true }

/**
 * May we auto-measure this kind at all?
 *
 * The gate that stops 2.3 × footprint being returned for a fence. Callers must
 * check this BEFORE estimating; the refusal carries a sentence the UI can show
 * verbatim, so the owner learns what to do instead of seeing a blank.
 */
export function canAutoMeasure(kind: MeasurementKind): AutoAllowed | AutoRefusal {
  const d = kindDef(kind)
  if (d.canAuto) return { ok: true }
  if (d.capture === 'line') {
    return { ok: false, reason: `A ${d.noun} run is a length — imagery can't tell EdgeQuote where it starts and stops. Trace it on the map.` }
  }
  if (d.capture === 'point') {
    return { ok: false, reason: `EdgeQuote can't count ${d.noun} from imagery reliably. Drop a pin on each one.` }
  }
  return { ok: false, reason: `EdgeQuote has no honest way to estimate ${d.noun} from imagery. Trace it, or enter the number if you already know it.` }
}

const ORDER: Record<Confidence, number> = { low: 0, medium: 1, high: 2 }

/**
 * Confidence of a set of measurements = the WEAKEST one.
 *
 * A property is only as measured as its least-known part: five traced lawns and
 * one guessed driveway is a guessed property, and averaging to "medium" would
 * hide exactly the number worth checking.
 */
export function weakestConfidence(levels: Confidence[]): Confidence | null {
  if (!levels.length) return null
  return levels.reduce((worst, l) => (ORDER[l] < ORDER[worst] ? l : worst), 'high' as Confidence)
}

export const CONFIDENCE_LABEL: Record<Confidence, string> = {
  high: 'Measured',
  medium: 'Estimated',
  low: 'Rough estimate',
}
