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
//   • the working day    → lib/workDuration (Session 47) — `workdayMinutes` and
//                          `formatDuration`, reading the owner's own
//                          business_settings.daily_capacity_hours. This module
//                          held its own copy of both for exactly one session,
//                          before Session 47 landed the canonical pair; they are
//                          gone rather than kept in step by hand.
//   • the labour figure  → lib/workSession `sessionTotals` (Session 47), via the
//                          loader. Person-minutes have ONE arithmetic.
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
// there is no "learned estimate" column and no migration.
//
// ⭐ AND THAT IS ALSO WHY THE LOOP CANNOT EAT ITSELF. Every figure offered here
// descends from `actual_minutes` — the stopwatch — and from nothing else. The
// suggestion is the median of what the work HAS TAKEN, never the median of what
// anyone PLANNED, so an owner who accepts a suggestion does not feed it back in:
// the next visit still contributes its own recorded time, measured against
// whatever plan it carried. A learner that suggested from past ESTIMATES would
// converge on its own opinion and call the agreement evidence. This one cannot
// reach its own output, which is a structural property rather than a stored
// flag — hence no "was this learned?" column that would have to be kept honest.

import { resolveDuration, type DurationSource } from '@/lib/dayFit'
import { workdayMinutes, formatDuration } from '@/lib/workDuration'
import {
  MIN_SERVICE_SAMPLE, type ServiceVariance, type LaborEvidence,
} from '@/lib/estimateVsActual'

// Re-exported so a consumer of the estimate does not have to know which module
// owns the working day — but it IS lib/workDuration's, not a copy.
export { workdayMinutes } from '@/lib/workDuration'

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
  /** Typical crew. Null when too few visits stated one. */
  typicalCrewSize: number | null
  /** Visits behind the LABOUR figure — its own count, not the crew one: a
   *  multi-day visit whose crew varied has honest labour and no single crew. */
  laborSampleSize: number
  /** Typical person-minutes. Null when too few visits have defensible labour. */
  suggestedLaborMinutes: number | null
  /**
   * Where the person-minutes came from — the claim, not just the number.
   *   'work_sessions' — Σ(each day's minutes × that day's stated worker count).
   *                     ACTUAL attendance, from Session 47's records.
   *   'planned_crew'  — elapsed × the crew the work was PLANNED for (the job's
   *                     crew_size, or a clock/carried session's copy of it).
   *                     ⛔ never priced, per lib/jobCost's rule for the identical
   *                     derivation, and never worded as what happened.
   */
  laborSource: LaborEvidence

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

  // Crew and labour are held to the SAME canonical bar as duration, each applied
  // to its OWN count. Six comparable visits of which two named a crew back a
  // crew claim with two — presenting that at the sample size of the duration
  // claim is how a thin figure inherits a thick one's credibility. Crew and
  // labour are gated SEPARATELY because they are separately knowable: a job
  // worked by one person on Monday and two on Tuesday has real labour and no
  // single crew size, and it must be able to contribute the fact it has.
  const typicalCrewSize = history.crewSampleSize >= MIN_SERVICE_SAMPLE
    ? history.medianCrewSize
    : null
  const laborEstablished = history.laborSampleSize >= MIN_SERVICE_SAMPLE
  const suggestedLaborMinutes = laborEstablished && history.medianLaborMinutes != null
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
    laborSampleSize: history.laborSampleSize,
    suggestedLaborMinutes,
    // The bucket's own verdict, carried through rather than re-decided here.
    laborSource: suggestedLaborMinutes == null ? 'none' : history.laborSource,

    scale,
    workdayMinutes: dayMin,
    needsCrew: typicalCrewSize != null && typicalCrewSize > 1,
  }
}

// ── Saying a duration out loud ───────────────────────────────────────────────

/**
 * A suggested duration in the units a person schedules in — "45m", "2h 30m",
 * "1 day 1h", "3 days".
 *
 * ⭐ This is Session 47's `formatDuration`, not a second opinion. That module
 * owns how a duration is SAID: days appear only at a whole working day, the
 * working day is the owner's own `daily_capacity_hours`, and the unit never
 * leaks into storage. This session shipped a rival for one commit — days ceiled
 * to the half, hours pinned alongside — and it is deleted rather than kept in
 * step by hand, because two formatters disagreeing about "9 hours" is precisely
 * the drift both modules exist to prevent.
 *
 * ⚠️ A SUGGESTION IS A PLAN, so `formatDuration` (which may speak in days) is
 * the right half of Session 47's pair. `formatWorked` is for time already
 * recorded and never says days — a measured 8 hours stays "8h" forever rather
 * than being re-stated through a setting that could change tomorrow.
 *
 * The em dash for null is this module's own: an absent estimate must render as
 * visibly absent, where `formatDuration` returns an empty string.
 */
export function formatEstimatedDuration(minutes: number | null, dayMin: number): string {
  if (minutes == null || !Number.isFinite(minutes)) return '—'
  return formatDuration(minutes, dayMin) || '—'
}

/** "15 labour-hours" · "2.5 labour-hours" · "—". Person-hours, never elapsed.
 *  ⭐ Never days: person-hours are not a working day, and "2 days of labour"
 *  would be read as elapsed by everyone who saw it. */
export function formatLaborHours(minutes: number | null): string {
  if (minutes == null || !Number.isFinite(minutes)) return '—'
  const h = Math.round((minutes / 60) * 10) / 10
  return `${h} labour-hour${h === 1 ? '' : 's'}`
}

/**
 * How the labour figure may be SPOKEN, given where it came from. The number is
 * the same; the claim is not, and the claim is the part that can be false.
 */
export function describeLaborBasis(e: WorkEstimate): string | null {
  if (e.suggestedLaborMinutes == null) return null
  return e.laborSource === 'work_sessions'
    ? 'actually worked'          // stated attendance, per day, from work sessions
    : 'at the planned crew size' // real minutes × the crew that was planned for
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
