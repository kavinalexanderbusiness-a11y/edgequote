// ── Day fit — THE "does this work realistically fit here?" engine ────────────
// Session 46. Day Suggestions used to answer a different question — "is there an
// empty-looking space near this address?" — and the gap between the two is how a
// 5-hour, 3-worker project got recommended into a route day with 50 spare
// minutes (measured live: the suggested placement put 11 planned hours on an
// 8-hour day, and capacity was never consulted by any suggester).
//
// This module is the ONE place a candidate piece of work is compared against a
// day's realistic remaining capacity. It is pure — no I/O, no React — so the
// verify guard can pin every rule. lib/dayFitLoad.ts owns the reads.
//
// ══ WHAT "CAPACITY" MEANS HERE (and where each number comes from) ════════════
// It COMPOSES the canonical primitives rather than inventing rivals:
//   • clock load        → lib/route estimateDayLoad — THE day-load definition
//                         the calendar workload bar and rain-delay check already
//                         use (labour minutes + 10 min/stop allowance, explicit
//                         0-hour day = blocked, "room" needs ≥ 60 spare min).
//   • learned duration  → lib/estimateVsActual serviceHistory — THE estimate-vs-
//                         actual primitive (serviceKey buckets, established only
//                         at n ≥ MIN_SERVICE_SAMPLE). Day fit does not define its
//                         own thresholds; it asks the canonical one.
//   • workers available → technicians + pto_entries (lib/dayFitLoad), the same
//                         three-facts join lib/workforce reads today.
//
// ══ THE HONESTY RULES ════════════════════════════════════════════════════════
// 1. UNKNOWN IS NOT 45 MINUTES. A candidate with no duration estimate and no
//    established history gets verdict 'unknown' — never a "fits" claim. (The
//    forms used to coerce unknown to 45 on the way into the suggesters.)
// 2. PRICE IS NOT DURATION. Nothing here reads a dollar amount. A $1,500 job
//    may be 45 minutes or 24 labour-hours; only minutes and crew decide fit.
// 3. CREW MULTIPLIES. 3h × 1 worker and 3h × 4 workers are different days.
//    Labour demand = minutes × crew; labour capacity = day hours × workers.
// 4. A FAILED READ IS NOT FREE CAPACITY. Workers unknown + a multi-worker
//    candidate → 'unknown', with the reason named — never a clock-only "fits".
// 5. EXISTING visits on the day keep the calendar bar's own assumption
//    (duration → learned median → DEFAULT_JOB_MIN) because that is the load the
//    owner already sees; only the CANDIDATE's claim is held to rule 1 — the
//    candidate is where "Fits Tuesday" gets asserted.
//
// ⛔ No industry keywords. Nothing in this file inspects a service NAME — the
// learned lookup goes through serviceHistory's canonical buckets, and route-vs-
// project phrasing is derived from the day's structure (stop count), never from
// what the work is called.

import { DEFAULT_JOB_MIN, estimateDayLoad } from '@/lib/route'
import type { ServiceVariance } from '@/lib/estimateVsActual'

// Same per-stop drive/setup allowance estimateDayLoad charges. Named here for
// the candidate's own stop; the existing day's stops are charged by
// estimateDayLoad itself so the two can never drift.
const STOP_OVERHEAD_MIN = 10

// The safety buffer: a day counts as a comfortable fit only when the binding
// dimension keeps at least this much slack — the SAME 60-minute line dayLoad has
// always used for "room". Not a new number; the one the schedule already lives by.
export const FIT_BUFFER_MIN = 60

// ── Duration precedence ──────────────────────────────────────────────────────

export type DurationSource = 'estimate' | 'learned' | 'unknown'

export interface ResolvedDuration {
  /** On-site minutes, or null — null means UNKNOWN, and stays unknown. */
  minutes: number | null
  source: DurationSource
  /** For 'learned': how many completed visits back the number. */
  sampleSize: number | null
}

/**
 * THE precedence: the job's own estimate → the service's established history →
 * unknown. Nothing is invented at the bottom.
 *
 * `history` is a lib/estimateVsActual serviceHistory() rollup for this service.
 * Its `established` flag (n ≥ MIN_SERVICE_SAMPLE) is the reliability contract —
 * day fit deliberately has no threshold of its own, so the learning primitive
 * and the scheduler can never disagree about when history is trustworthy.
 */
export function resolveDuration(
  ownEstimateMinutes: number | null | undefined,
  history: ServiceVariance | null | undefined,
): ResolvedDuration {
  const own = Number(ownEstimateMinutes)
  if (Number.isFinite(own) && own > 0) {
    return { minutes: Math.round(own), source: 'estimate', sampleSize: null }
  }
  if (history?.established && history.medianActualMinutes != null && history.medianActualMinutes > 0) {
    return { minutes: Math.round(history.medianActualMinutes), source: 'learned', sampleSize: history.sampleSize }
  }
  return { minutes: null, source: 'unknown', sampleSize: null }
}

// ── The candidate and the day ────────────────────────────────────────────────

export interface CandidateWork {
  /** Resolved on-site minutes (resolveDuration). null = unknown. */
  minutes: number | null
  source: DurationSource
  /** Workers this job needs at once. null = not stated — treated as AT LEAST 1
   *  for arithmetic (the floor, not an invention) and never displayed as a claim. */
  crewSize: number | null
}

/** The slice of an existing scheduled visit the day model reads. */
export interface DayVisitLike {
  duration_minutes?: number | null
  status?: string | null
  crew_size?: number | null
  service_type?: string | null
}

export interface DayFitInput {
  /** The day's visits (cancelled rows are ignored, as estimateDayLoad does). */
  visits: DayVisitLike[]
  /** business_settings.daily_capacity_hours. null/undefined → the 8h default;
   *  an EXPLICIT 0 is a blocked day (dayLoad's own rule). */
  capacityHours: number | null | undefined
  /** Workers available that day (technicians minus time off; solo owner = 1).
   *  null = the workforce read failed or was not attempted — NOT zero. */
  workers: number | null
  /** Established learned minutes for a service (existing visits with no typed
   *  duration). Return null when history isn't established — the visit then
   *  falls to DEFAULT_JOB_MIN exactly as the calendar bar assumes today. */
  learnedFor?: (serviceType: string | null | undefined) => number | null
}

export type FitVerdict =
  | 'fits'      // demand ≤ spare with ≥ FIT_BUFFER_MIN slack left
  | 'tight'     // demand ≤ spare, but the buffer would be consumed
  | 'over'      // demand exceeds realistic remaining capacity
  | 'unknown'   // duration unknown, or workforce unknown for a crew job

export interface DayFit {
  verdict: FitVerdict
  /** Why, when verdict is 'unknown'. */
  unknownReason: 'duration_unknown' | 'workforce_unknown' | null
  /** Existing clock load (estimateDayLoad): minutes committed incl. per-stop allowance. */
  usedClockMin: number
  /** Clock minutes still open before the candidate. */
  spareClockMin: number
  /** Labour-minutes still open before the candidate. null = workers unknown. */
  spareLaborMin: number | null
  /** The candidate's demand. null when duration unknown. */
  candidateClockMin: number | null
  candidateLaborMin: number | null
  /** Workers used for the labour dimension. null = unknown. */
  workers: number | null
  /** How many active (non-cancelled) visits already sit on the day. */
  stops: number
}

const crewOf = (n: number | null | undefined) => Math.max(1, Number(n) || 1)

/**
 * Compare one candidate against one day. TWO dimensions, both must pass:
 *
 *   CLOCK — the serial day the owner's capacity setting describes, computed by
 *   estimateDayLoad (so this and the calendar bar are one calculation). For a
 *   solo operation this IS the whole answer.
 *
 *   LABOUR — person-minutes: Σ(visit minutes × visit crew) + per-stop allowance
 *   against capacityHours × workers. This is what stops "a 4h gap on the
 *   calendar" from swallowing a 4h × 3-worker job when one person is available,
 *   and what lets a 3-person crew absorb work a serial clock could not.
 *
 * With one worker and single-crew visits the two dimensions are the same
 * numbers, so existing solo behaviour is exactly estimateDayLoad's.
 *
 * V1 limitation, stated: labour capacity treats the day as one pool; it does not
 * simulate parallel route packing per worker. That is a scheduling-theory
 * problem, and the pool is the smallest model that cannot claim a fit which is
 * physically impossible in person-hours.
 */
export function dayFit(candidate: CandidateWork, input: DayFitInput): DayFit {
  const active = input.visits.filter(v => v.status !== 'cancelled')

  // CLOCK — the canonical day-load calc, with learned durations filling untyped
  // visits before the shared fallback (same precedence the candidate gets, minus
  // the unknown-honesty: an existing visit is already committed either way).
  const clockVisits = active.map(v => ({
    duration_minutes: (Number(v.duration_minutes) > 0
      ? Number(v.duration_minutes)
      : input.learnedFor?.(v.service_type) ?? null) ?? DEFAULT_JOB_MIN,
    status: v.status,
  }))
  const clock = estimateDayLoad(clockVisits, input.capacityHours)
  const spareClockMin = Math.max(0, clock.spareMin)

  // LABOUR — the same visits, crew-weighted. Per-stop allowance is crew-weighted
  // too: the whole crew rides the leg.
  const workers = input.workers != null && input.workers > 0 ? Math.floor(input.workers) : input.workers === 0 ? 0 : null
  let spareLaborMin: number | null = null
  if (workers != null) {
    const capMinPerWorker = (input.capacityHours == null || Number(input.capacityHours) < 0 ? 8 : Number(input.capacityHours)) * 60
    const laborCap = capMinPerWorker * workers
    const laborUsed = active.reduce((s, v, i) =>
      s + (clockVisits[i].duration_minutes + STOP_OVERHEAD_MIN) * crewOf(v.crew_size), 0)
    spareLaborMin = Math.max(0, Math.round(laborCap - laborUsed))
  }

  const base = {
    usedClockMin: clock.usedMin,
    spareClockMin,
    spareLaborMin,
    workers,
    stops: active.length,
  }

  // Rule 1: no duration, no claim.
  if (candidate.minutes == null || !(candidate.minutes > 0)) {
    return { ...base, verdict: 'unknown', unknownReason: 'duration_unknown', candidateClockMin: null, candidateLaborMin: null }
  }

  const crew = crewOf(candidate.crewSize)
  const candidateClockMin = candidate.minutes + STOP_OVERHEAD_MIN
  const candidateLaborMin = (candidate.minutes + STOP_OVERHEAD_MIN) * crew

  // Rule 4: a crew job cannot be vouched for by a clock alone. (A solo-sized
  // candidate still gets the honest clock answer — that IS today's canonical
  // model — but multiplying workers we don't know would be inventing them.)
  if (workers == null && crew > 1) {
    return { ...base, verdict: 'unknown', unknownReason: 'workforce_unknown', candidateClockMin, candidateLaborMin }
  }

  // BOTH dimensions must pass when the workforce is known:
  //   WINDOW — an 11h job does not fit an 8h day however many people show up;
  //            its crew works those hours together.
  //   LABOUR — person-minutes vs the pool. This binds a 4-person job on a
  //            1-person day even though the serial clock looks open (a 3h gap
  //            on a calendar is not 4 people).
  //   CLOCK  — with exactly one worker the day is genuinely serial, so the
  //            committed route's clock spare binds too.
  // Unknown workforce with a solo-sized candidate falls back to the serial
  // clock alone — that IS today's canonical single-crew model.
  const capWindowMin = (input.capacityHours == null || Number(input.capacityHours) < 0 ? 8 : Number(input.capacityHours)) * 60
  let spare: number
  let demand: number
  if (workers != null) {
    // A 0-worker day (everyone booked off) has no labour at all: nothing fits.
    if (workers === 0
      || candidateClockMin > capWindowMin
      || candidateLaborMin > (spareLaborMin ?? 0)
      || (workers === 1 && candidateClockMin > spareClockMin)) {
      return { ...base, verdict: 'over', unknownReason: null, candidateClockMin, candidateLaborMin }
    }
    // Tightness is judged on the binding dimension: the labour pool for a real
    // crew, the serial clock for one worker.
    spare = workers > 1 ? (spareLaborMin ?? 0) : Math.min(spareClockMin, spareLaborMin ?? spareClockMin)
    demand = workers > 1 ? candidateLaborMin : Math.max(candidateClockMin, candidateLaborMin)
  } else {
    spare = spareClockMin
    demand = candidateClockMin
  }

  const verdict: FitVerdict = demand > spare ? 'over'
    : (spare - demand) < FIT_BUFFER_MIN * (workers != null && workers > 1 ? workers : 1) ? 'tight'
    : 'fits'
  return { ...base, verdict, unknownReason: null, candidateClockMin, candidateLaborMin }
}

/**
 * The earliest day the candidate genuinely fits, from a caller-built horizon
 * (each entry = one day's DayFitInput, in date order). A clean 'fits' wins over
 * any earlier 'tight'; 'tight' is returned only when nothing fits cleanly.
 * Null = nothing in the horizon has room (or the duration is unknown — an
 * unknown candidate fits nowhere by claim, everywhere by owner judgment).
 */
export function firstFittingDay(
  candidate: CandidateWork,
  days: { date: string; input: DayFitInput }[],
): { date: string; fit: DayFit } | null {
  let tight: { date: string; fit: DayFit } | null = null
  for (const d of days) {
    const fit = dayFit(candidate, d.input)
    if (fit.verdict === 'fits') return { date: d.date, fit }
    if (fit.verdict === 'tight' && !tight) tight = { date: d.date, fit }
  }
  return tight
}

// ── Workers available on a date ──────────────────────────────────────────────

export interface TechForAvailability {
  id: string
  is_active: boolean
  ended_on?: string | null
  archived_at?: string | null
}

/**
 * How many people can work a given date: active technicians not booked off.
 * A business with NO technician rows is the solo owner — 1, not 0. (What is NOT
 * modelled, stated honestly: whether the owner also works alongside a hired
 * crew. There is no column that says so; guessing would double-count.)
 */
export function workersAvailableOn(
  date: string,
  technicians: TechForAvailability[],
  ptoDates: { technician_id: string; date: string }[],
): number {
  const roster = technicians.filter(t =>
    t.is_active && !t.archived_at && (!t.ended_on || t.ended_on >= date))
  if (roster.length === 0) return 1
  const off = new Set(ptoDates.filter(p => p.date.slice(0, 10) === date).map(p => p.technician_id))
  return Math.max(0, roster.filter(t => !off.has(t.id)).length)
}

// ── The one sentence a suggestion shows ──────────────────────────────────────

const fmtH = (min: number) => {
  const m = Math.max(0, Math.round(min))
  if (m < 60) return `${m}m`
  const h = Math.floor(m / 60), r = m % 60
  return r ? `${h}h ${r}m` : `${h}h`
}

/**
 * One short, defensible reason per verdict. Every number in it comes from the
 * fit result — nothing re-derived, nothing invented.
 */
export function fitReason(fit: DayFit, candidate: CandidateWork): string {
  const crew = crewOf(candidate.crewSize)
  const est = candidate.minutes != null
    ? `~${fmtH(candidate.minutes)}${crew > 1 ? ` × ${crew} workers` : ''} ${candidate.source === 'learned' ? 'typical' : 'estimated'}`
    : null

  switch (fit.verdict) {
    case 'unknown':
      return fit.unknownReason === 'workforce_unknown'
        ? `${est} — worker availability unavailable, review before scheduling`
        : 'Duration unknown — review before scheduling'
    case 'over':
      return fit.workers != null && fit.workers > 1 && fit.spareLaborMin != null && fit.candidateLaborMin != null && fit.candidateClockMin != null && fit.candidateLaborMin > fit.spareLaborMin
        ? `Too large — needs ~${fmtH(fit.candidateLaborMin)} of labour, ~${fmtH(fit.spareLaborMin)} free`
        : fit.stops >= 3
          ? `Too large for this day's route — ${est}, ~${fmtH(fit.spareClockMin)} free`
          : `Too large for this day — ${est}, ~${fmtH(fit.spareClockMin)} free`
    case 'tight':
      return `Tight fit — ${est}, ~${fmtH(fit.workers != null && fit.workers > 1 ? (fit.spareLaborMin ?? 0) : fit.spareClockMin)} free`
    case 'fits':
      return fit.workers != null && fit.workers > 1
        ? `Fits — ${est}, ~${fmtH(fit.spareLaborMin ?? 0)} of labour free`
        : `Fits — ${est}, ~${fmtH(fit.spareClockMin)} free`
  }
}
