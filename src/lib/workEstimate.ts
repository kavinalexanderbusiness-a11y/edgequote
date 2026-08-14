// ── Smart time estimates — THE answer a duration field is offered ────────────
// Session 48. One question — "how long does this kind of work take us?" — and
// one answer shaped so it is equally honest about a 20-minute repeat visit and a
// three-day project.
//
// ══ IT IS NOT A SECOND LEARNER ═══════════════════════════════════════════════
// Everything here is composed, not re-derived:
//   • the history        → lib/estimateVsActual serviceHistory() — the Session 15
//                          engine, serviceKey buckets, MIN_SERVICE_SAMPLE.
//   • the duration rule  → lib/dayFit resolveDuration(), called with a null own
//                          estimate. Literally the same function Day Suggestions
//                          resolves a candidate with, so the card in the job form
//                          and the "Fits Tuesday" claim cannot disagree about
//                          when history may be leaned on.
//   • the working day    → lib/route DEFAULT_CAPACITY_HOURS + the owner's own
//                          business_settings.daily_capacity_hours.
// There is no threshold, no median and no sample rule of its own. Adding one
// would create exactly the second brain this module exists to avoid.
//
// ══ THE TWO NUMBERS ARE TWO QUESTIONS ════════════════════════════════════════
// ELAPSED answers "how much of a day does this block?" — it is what goes on a
// calendar, what Day Suggestions fits, and what an owner tells a customer.
// LABOUR answers "how much work is in it?" — person-hours, what a cost or a
// capacity plan is built from.
//
//   3 workers × 5 hours  =  5 hours elapsed  AND  15 labour-hours.
//
// Neither is a scaled version of the other, and swapping them is silent and
// expensive in both directions: labour on a calendar triples the job, elapsed in
// a cost divides it by three. They are separate fields with separate sample
// sizes all the way to the screen, and this module never multiplies one into the
// other at a call site.
//
// ══ BIG WORK IS DETECTED STRUCTURALLY ════════════════════════════════════════
// ⛔ PRICE IS NOT DURATION. Nothing here reads a dollar amount — `WorkEstimate`
// has no money in it and the input type has no price field to read. A $4,000
// tree removal can be 90 minutes and a $180 gutter clean can take a crew all
// morning; a price threshold would classify the invoice, not the work.
// ⛔ NO SERVICE-NAME RULES. Nothing here inspects what the work is CALLED. The
// bucket arrives already resolved by serviceKey; scale comes from time and
// people. "if it says mulch" is how a universal CRM becomes a lawn-care app.
// What decides the shape is: measured elapsed time against the owner's own
// working day, and the crew the work is planned for.
//
// ══ IT SUGGESTS, IT NEVER WRITES ═════════════════════════════════════════════
// Nothing here is persisted, so a learned number can never overwrite what the
// owner typed and can never rewrite a historical estimate. jobs.duration_minutes
// stays THE owner's figure at all times; the suggestion is derived at read time
// from completed work and lives only as long as the screen does. That is why
// there is no "learned estimate" column and no migration — the separation the
// feedback loop needs is structural, not stored.

import { resolveDuration, type DurationSource } from '@/lib/dayFit'
import { DEFAULT_CAPACITY_HOURS } from '@/lib/route'
import {
  MIN_SERVICE_SAMPLE, formatMinutes, type ServiceVariance,
} from '@/lib/estimateVsActual'

/** Minutes in the owner's working day; the unit "~2 workdays" is counted in. */
export function workdayMinutes(capacityHours: number | null | undefined): number {
  const h = Number(capacityHours)
  // An explicit 0 means a blocked DAY on the schedule (lib/route dayLoad's rule)
  // — it is not a statement that a working day is zero minutes long. As a UNIT
  // of measurement, 0 would make "workdays" a division by zero, so the shared
  // default stands in. This is a scale, not a capacity check.
  return (Number.isFinite(h) && h > 0 ? h : DEFAULT_CAPACITY_HOURS) * 60
}

/**
 * How much the history may be leaned on. Three states because there are three
 * distinct situations, mapped onto the thresholds that already exist rather than
 * onto a new ladder:
 *
 *   'none'        — nothing comparable. Say so; suggest nothing.
 *   'limited'     — real visits, below MIN_SERVICE_SAMPLE. Shown as context,
 *                   never offered as a value to apply.
 *   'established' — MIN_SERVICE_SAMPLE or more; the canonical `established` flag.
 *
 * ⚠️ Deliberately TWO thresholds (n > 0 and n ≥ MIN_SERVICE_SAMPLE), both
 * pre-existing. A middle "developing" band would need a third number that no
 * engine in the product owns, and inventing one here would put the smart
 * estimate and Day Suggestions on different definitions of trustworthy — the
 * exact drift lib/dayFit's header refuses. No percentage is produced anywhere:
 * "87% confident" reads as a measurement and is a formatting choice.
 */
export type EstimateConfidence = 'none' | 'limited' | 'established'

/**
 * Structural size class. Derived from measured time against the owner's own
 * working day — never from price, never from what the service is called.
 */
export type WorkScale = 'unknown' | 'within_day' | 'multi_day'

export interface WorkEstimate {
  /** The canonical bucket this answer is about, and its evidence count. */
  serviceKey: string
  serviceLabel: string
  sampleSize: number
  confidence: EstimateConfidence

  /**
   * ⭐ THE APPLIABLE FIGURE: elapsed on-site minutes the owner may accept into
   * the duration field. NON-NULL ONLY at 'established' — resolveDuration's own
   * rule, unchanged. Null means "we are not going to fill your field with a
   * guess", not "zero".
   */
  suggestedElapsedMinutes: number | null
  /** Provenance of the above: 'learned' when suggested, 'unknown' when not. */
  suggestedSource: DurationSource

  /**
   * What the history literally shows, at ANY sample size ≥ 1. Context only —
   * displayed with its count so a thin sample reads as thin. A caller must not
   * apply this; that is what `suggestedElapsedMinutes` is for, and the two are
   * separate fields precisely so a surface cannot use the loose one by accident.
   */
  observedElapsedMinutes: number | null

  // ── Labour, with its OWN evidence ──────────────────────────────────────────
  /** Visits behind the crew figures — ≤ sampleSize, because a visit may not
   *  have stated a crew. The crew claim is worth THIS number, not sampleSize. */
  crewSampleSize: number
  /** Typical planned crew. Null when too few visits stated one. */
  typicalCrewSize: number | null
  /** Typical person-minutes. Null when too few visits stated a crew. */
  suggestedLaborMinutes: number | null
  /**
   * Where the person-minutes came from. 'planned_crew' = elapsed × the crew the
   * visit was PLANNED for, because nothing in the product records attendance.
   * ⛔ A planned-crew labour figure may never be priced (lib/jobCost's rule for
   * the identical derivation). When real work sessions land, a 'work_sessions'
   * source slots in here and every consumer keeps compiling.
   */
  laborSource: 'planned_crew' | 'none'

  // ── Shape ──────────────────────────────────────────────────────────────────
  scale: WorkScale
  /** Minutes in the working day the scale was judged against. */
  workdayMinutes: number
  /** True when the work needs more than one person — the crew line is worth
   *  showing, and elapsed alone no longer describes the commitment. */
  needsCrew: boolean
}

/**
 * ⭐ THE ENTRY POINT — one service's history in, one estimate out.
 *
 * Always returns an estimate, never null: a service with no history comes back
 * `confidence: 'none'` with every figure null, so a caller cannot render absence
 * as agreement. Pure — no I/O, no React.
 *
 * `history` is a lib/estimateVsActual serviceHistory() rollup, which the caller
 * builds from ITS OWN tenant's completed visits. This function has no idea who
 * the owner is and learns from exactly the rows it is handed; one business's
 * work must never estimate another's, and that is the loader's guarantee.
 */
export function buildWorkEstimate(
  history: ServiceVariance,
  opts?: { capacityHours?: number | null },
): WorkEstimate {
  const dayMin = workdayMinutes(opts?.capacityHours)

  // THE duration rule, borrowed rather than restated: a null own-estimate makes
  // resolveDuration answer the pure question "what does history alone say?" —
  // and it answers null unless the history is established.
  const resolved = resolveDuration(null, history)

  // Crew and labour are held to the SAME canonical bar as duration, applied to
  // their OWN count. Six comparable visits of which two named a crew back a crew
  // claim with two — presenting that at the sample size of the duration claim is
  // how a thin figure inherits a thick one's credibility.
  const crewEstablished = history.crewSampleSize >= MIN_SERVICE_SAMPLE
  const typicalCrewSize = crewEstablished ? history.medianCrewSize : null
  const suggestedLaborMinutes = crewEstablished && history.medianLaborMinutes != null
    ? Math.round(history.medianLaborMinutes)
    : null

  const elapsed = resolved.minutes
  const scale: WorkScale = elapsed == null ? 'unknown'
    : elapsed > dayMin ? 'multi_day'
    : 'within_day'

  return {
    serviceKey: history.serviceKey,
    serviceLabel: history.serviceLabel,
    sampleSize: history.sampleSize,
    confidence: history.sampleSize === 0 ? 'none'
      : history.established ? 'established'
      : 'limited',

    suggestedElapsedMinutes: elapsed,
    suggestedSource: resolved.source,
    observedElapsedMinutes: history.medianActualMinutes,

    crewSampleSize: history.crewSampleSize,
    typicalCrewSize,
    suggestedLaborMinutes,
    laborSource: suggestedLaborMinutes == null ? 'none' : 'planned_crew',

    scale,
    workdayMinutes: dayMin,
    needsCrew: typicalCrewSize != null && typicalCrewSize > 1,
  }
}

// ── Saying a duration out loud ───────────────────────────────────────────────

/**
 * A duration in the units a person schedules in.
 *
 *   45m  ·  2h 30m  ·  ~1.5 workdays (9h)  ·  ~3 workdays (24h)
 *
 * Under a working day this IS lib/estimateVsActual's formatMinutes — the one
 * duration formatter the product already uses, not a rival with its own rounding.
 * Past a working day, minutes stop being a unit anyone can act on: "1,440
 * minutes" is a number an owner has to convert before it means anything, and
 * conversion at reading time is where a three-day job gets heard as a long
 * afternoon. The raw hours stay alongside the workday count so nothing is hidden
 * behind the friendlier unit.
 *
 * Workdays are CEILED to the half day. Rounding a commitment DOWN understates
 * it — 9 hours shown as "1 workday" is a promise the day cannot keep — and the
 * half-day granularity is a display grain, not a threshold that gates any claim.
 */
export function formatWorkDuration(minutes: number | null, dayMin: number): string {
  if (minutes == null || !Number.isFinite(minutes)) return '—'
  if (minutes <= dayMin || !(dayMin > 0)) return formatMinutes(minutes)
  const days = Math.ceil((minutes / dayMin) * 2) / 2
  const hours = Math.round((minutes / 60) * 10) / 10
  return `${days} workday${days === 1 ? '' : 's'} · ${hours}h`
}

/** "15 labour-hours" · "2.5 labour-hours" · "—". Person-hours, never elapsed. */
export function formatLaborHours(minutes: number | null): string {
  if (minutes == null || !Number.isFinite(minutes)) return '—'
  const h = Math.round((minutes / 60) * 10) / 10
  return `${h} labour-hour${h === 1 ? '' : 's'}`
}

/**
 * The one-line confidence wording. Plain words, no percentage — the sample size
 * is always shown next to it, and a count is a fact where a percentage is a
 * manufactured feeling.
 */
export function describeConfidence(e: WorkEstimate): string {
  switch (e.confidence) {
    case 'none':
      return 'Not enough history yet'
    case 'limited':
      return 'Limited history'
    case 'established':
      return 'Established estimate'
  }
}
