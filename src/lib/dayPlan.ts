// ── Day plan — THE "is this day, as booked, realistic?" engine ───────────────
// Session 60. Every scheduling engine in this product answers a question about
// work that is NOT yet on the calendar:
//
//   lib/route          → what ORDER should today's stops be driven in?
//   lib/dayFit         → does this CANDIDATE fit on that day?          (S46)
//   lib/optimizer      → which day should this job MOVE to?
//
// Nothing answered the question an owner actually asks the night before: the
// work is already booked — is tomorrow real? The day board had the parts (a
// route, a load pill, an ETA chain) and drew a confident conclusion from them:
// "Room for ~2h · 71%", "Est. finish 3:10 PM". Measured against production on
// 2026-08-14, three of the inputs behind those numbers were assumptions the
// screen never disclosed:
//
//   • 19 visits ask for a crew of 2+ while the business has 1 active
//     technician. The load pill is a SERIAL CLOCK — it has no idea, and says
//     "room" for days that cannot be staffed.
//   • 12 visits have no duration at all. They are silently counted as 45
//     minutes and the finish time is stated to the minute anyway.
//   • Drive time was modelled as `overhead + km × minPerKm` for every leg,
//     including the 1,282 legs Google had already TIMED in road_distance_cache
//     (see lib/distance) — and, when no road distance was cached, from
//     straight-line kilometres, which is a grouping signal and not a drive.
//
// ══ WHAT THIS MODULE IS FOR ═════════════════════════════════════════════════
// It states the day's shape AND the evidence behind it, so nothing on the
// screen is more confident than its inputs. It is pure — no I/O, no React — so
// scripts/verify-day-plan.ts pins every rule by running it.
//
// ══ IT COMPOSES; IT DOES NOT RIVAL ══════════════════════════════════════════
//   • ordering        → lib/route (optimizeRoute / sequenceRoute). This module
//                       receives an ORDER and never computes one. There is no
//                       second route algorithm here, and there must not be:
//                       the owner's drag order and the optimizer's output
//                       already reconcile in exactly one place.
//   • clock + labour  → lib/dayFit dayCommitment(). ONE labour formula for
//                       "does X fit?" and "is this day real?".
//   • drive minutes   → measured seconds when the leg has them, else lib/route
//                       legMinutes() with the learned SpeedModel. No third
//                       distance→time conversion.
//   • grouping        → lib/route routeStats().clusters.
//
// ══ THE HONESTY RULES THE GUARD EXISTS TO HOLD ══════════════════════════════
// 1. A MODELLED DRIVE IS NOT A MEASURED ONE. Every leg carries its source, and
//    the day's travel basis is the WEAKEST source present — one straight-line
//    leg is enough to stop the day claiming measured drive time. With no road
//    data at all the honest statement is that stops are GROUPED BY LOCATION,
//    which is a different and much weaker claim than a drive time.
// 2. AN ASSUMED DURATION IS COUNTED BUT DISCLOSED. A booked visit with no
//    duration still occupies the day, so it is totalled at DEFAULT_JOB_MIN
//    (dayFit honesty rule 5 — that IS the load the owner already sees). What
//    changes here is that the count of assumed stops rides along with the
//    finish time, so the estimate can never present itself as better evidenced
//    than it is.
// 3. A DAY IS TWO CONSTRAINTS, NOT ONE. The serial clock AND the labour pool.
//    A day can finish on time and still be impossible to staff.
// 4. A FAILED WORKFORCE READ IS NOT A STAFFED DAY. workers === null suppresses
//    every labour claim and raises its own warning; it never reads as "fine".
// 5. ⛔ NOTHING HERE READS MONEY. Not a price, not a revenue total, not a
//    margin. A day is over capacity or it is not; what it is worth cannot
//    argue with that. (The brief for this session put it as: do not optimize
//    by revenue at the expense of capacity. The structural version of that
//    promise is that the capacity engine cannot SEE revenue.)
// 6. ⛔ NO INDUSTRY KEYWORDS. Nothing inspects what the work is CALLED. Route
//    days and project days are told apart by structure — stop count and the
//    shape of the durations — never by service name.

import {
  computeDayEtas, DEFAULT_JOB_MIN, FALLBACK_LEG_MIN, legMinutes, routeStats,
  minutesToTime12, type SpeedModel,
} from '@/lib/route'
import { dayCommitment, FIT_BUFFER_MIN, type DayFitInput, type DayCommitment } from '@/lib/dayFit'
import { canWork, type WorkerDayDetail } from '@/lib/workerAvailability'

// The allowance the ETA chain already applies to a stop it cannot locate — the
// same constant, not a matching one, so the minutes charged and the minutes
// disclosed as "unplaced" can never come apart.
export const UNLOCATED_LEG_MIN = FALLBACK_LEG_MIN

// ── Travel evidence ──────────────────────────────────────────────────────────

/**
 * Where one leg's drive minutes came from, strongest first.
 *
 *  measured  — a recorded road duration for this exact pair (lib/distance
 *              seconds()). This is a drive time.
 *  road      — a recorded road DISTANCE, minutes modelled from it.
 *  estimated — straight-line distance, minutes modelled from it. Says the stops
 *              are near each other; says very little about the drive.
 *  unknown   — the stop has no coordinates, so there is no leg at all and the
 *              chain advances by a flat allowance.
 */
export type LegSource = 'measured' | 'road' | 'estimated' | 'unknown'

/** Weakest-first, so `basis` is a min over the legs present. */
const SOURCE_RANK: Record<LegSource, number> = { unknown: 0, estimated: 1, road: 2, measured: 3 }

/**
 * What the whole day's travel time is worth as evidence: the weakest leg
 * source present. One un-measured leg means the day's drive total is not a
 * measured figure, and saying otherwise would be the exact overstatement this
 * module exists to stop. 'none' = there is no route to speak of.
 */
export type TravelBasis = LegSource | 'none'

export interface PlannedLeg {
  /** The stop this leg arrives at. */
  jobId: string
  /** Kilometres for the leg, or null when the stop could not be located. */
  km: number | null
  /** Drive minutes actually used in the chain. */
  minutes: number
  source: LegSource
}

export interface PlannedStop {
  jobId: string
  /** Minutes on site, and where that number came from. */
  minutes: number
  durationSource: 'stated' | 'learned' | 'assumed'
  /** Workers this visit asks for at once (1 when not stated). */
  crewSize: number
  /** Clock minute of arrival, and the same as a 12-hour label. */
  arrivalMin: number
  arrival: string
  /** True when the stop has no coordinates — not in the route or the km total. */
  unlocated: boolean
  leg: PlannedLeg
}

// ── Warnings ─────────────────────────────────────────────────────────────────

/**
 * Why a day is not what it looks like. Ordered by severity when emitted, so a
 * surface can render them in order and truncate from the bottom without
 * dropping the worst one.
 *
 *  blocking — the day as booked cannot happen (labour, staffing, a blocked day)
 *  warning  — it can happen but will overrun or is on the edge
 *  caveat   — it may be fine; the EVIDENCE is thin and you should know
 */
export type WarningSeverity = 'blocking' | 'warning' | 'caveat'

export type DayPlanWarningKind =
  | 'day_blocked'            // capacity is an explicit 0 — nothing can be worked
  | 'crew_short'             // a visit needs more people than are available
  | 'crew_understaffed'      // a crew with work here has people off/unavailable
  | 'worker_unavailable'     // a named worker on a working crew cannot work today
  | 'availability_assumed'   // nobody has a recorded week — availability is a guess
  | 'labour_over'            // person-minutes booked exceed the people available
  | 'runs_past_capacity'     // the route finishes after the day's hours end
  | 'no_room_left'           // fits, but with less than the buffer to spare
  | 'workforce_unknown'      // the roster could not be read — no labour claim
  | 'durations_assumed'      // N stops counted at the default, not estimated
  | 'travel_estimated'       // drive time modelled from straight-line distance
  | 'travel_modelled'        // real distances, but the MINUTES are modelled
  | 'unlocated_stops'        // N stops are not in the route or the drive time
  | 'no_base'                // no base address — no route can be ordered at all
  | 'carried_over'           // N stops are finishing work banked on an earlier day

export interface DayPlanWarning {
  kind: DayPlanWarningKind
  severity: WarningSeverity
  /** One plain sentence. Every number in it comes from this result. */
  message: string
  /** How many stops it concerns, when that is the point of the warning. */
  count?: number
}

const SEVERITY_RANK: Record<WarningSeverity, number> = { blocking: 0, warning: 1, caveat: 2 }

// ── Input ────────────────────────────────────────────────────────────────────

export interface DayPlanStopInput {
  jobId: string
  /** jobs.duration_minutes — null/0 means not stated. */
  durationMinutes?: number | null
  /** jobs.crew_size. */
  crewSize?: number | null
  /** jobs.service_type — passed ONLY to the learned-duration lookup, which
   *  buckets it canonically (lib/estimateVsActual). ⛔ Never string-matched. */
  serviceType?: string | null
  /** jobs.status — 'cancelled' stops are dropped, as everywhere else. */
  status?: string | null
  /** jobs.crew_id — which crew is expected to work it, when a crew is. */
  crewId?: string | null
  /** jobs.technician_id — set when the visit belongs to ONE named person
   *  instead of a crew (Session 65; the two are mutually exclusive in the
   *  database). Staffing is judged per crew for crew work and per person for
   *  personal work, because a crew's spare member cannot cover a visit that was
   *  given to somebody by name. */
  technicianId?: string | null
  /** Route distance from the PREVIOUS point (base, or the stop before), or null
   *  when this stop has no coordinates. From lib/route's ordered output. */
  legKm?: number | null
  /** Measured road seconds for that same leg, when the pair has been timed. */
  legSeconds?: number | null
  /** True when the leg's kilometres are real-road rather than straight-line. */
  legIsRoad?: boolean
  /** Whether the stop has coordinates at all. */
  located: boolean
  /**
   * jobs.actual_minutes — the DB-enforced sum of this visit's work sessions
   * (Session 47). Read ONLY for a visit that is already `in_progress`: that
   * work was banked on an earlier day, so planning the whole estimate again
   * would book time twice. See `carriedOverStops`.
   */
  workedMinutes?: number | null
}

export interface DayPlanInput {
  /** The day's stops IN DRIVING ORDER. This module never reorders them. */
  stops: DayPlanStopInput[]
  /** Work start (HH:mm) — the day's own start after any day-status override. */
  startTime: string | null | undefined
  /** Labour hours the day is worth. Explicit 0 = blocked (dayLoad's own rule). */
  capacityHours: number | null | undefined
  /** Workers available. null = the roster could not be read — NOT zero. */
  workers: number | null
  /** Established learned minutes for a service, else null (lib/dayFitLoad). */
  learnedFor?: (serviceType: string | null | undefined) => number | null
  /** Learned drive speed + per-stop overhead (lib/travelLearning). */
  speed?: SpeedModel
  /** Coordinates of the LOCATED stops, for the geographic grouping count. Empty
   *  or absent → grouping is reported as unknown rather than as 1 area. */
  locatedCoords?: { lat: number; lng: number }[]
  /** False when there is no base address, so no route could be ordered. */
  hasBase: boolean
  /**
   * Per-worker states for this date (lib/workerAvailability.workerDayStates,
   * threaded by lib/dayFitLoad.staffingByDate). Null/absent = the roster could
   * not be read, or this surface does not have it — either way NO staffing
   * claim is made, exactly as `workers: null` makes no labour claim.
   *
   * ⛔ This never CHANGES an assignment. A visit stays on the crew the owner
   * put it on; what it can do is say the crew is short and let the owner
   * decide. Silently moving work is how a plan stops matching the field.
   */
  staffing?: WorkerDayDetail[] | null
  /** Crew id → name, so a warning can say "Crew A" instead of a uuid. */
  crewNames?: Record<string, string>
  /** False when NO worker has a recorded weekly pattern, so every "available"
   *  in `staffing` is an assumption. Undefined = don't raise the point (the
   *  caller has not established it either way). */
  availabilityRecorded?: boolean
}

// ── Result ───────────────────────────────────────────────────────────────────

export interface DayPlan {
  stops: PlannedStop[]
  /** Active stops (cancelled dropped) and how many of them could be located. */
  stopCount: number
  locatedStops: number
  unlocatedStops: number

  /** On-site minutes across the day (crew NOT multiplied — this is the clock). */
  workMin: number
  /** Drive minutes across every leg. */
  driveMin: number
  /** Route kilometres, or null when no leg had a distance. */
  km: number | null

  startMin: number
  finishMin: number
  finish: string
  /** Work start + the day's labour hours: when the day is meant to be over. */
  capacityEndMin: number
  /** finishMin − capacityEndMin, positive when the day runs long. */
  overrunMin: number

  /** The clock dimension, from dayFit's shared arithmetic. */
  usedClockMin: number
  spareClockMin: number
  capacityMin: number

  /** The labour dimension. All null when the workforce is unknown. */
  workers: number | null
  laborUsedMin: number | null
  laborCapMin: number | null
  spareLaborMin: number | null
  /** The largest crew any single visit asks for. */
  maxCrewSize: number

  /** How many separate places the day touches (stops within 1 km group), or
   *  null when nothing could be located. NOT a drive time — a grouping. */
  areas: number | null

  travel: {
    basis: TravelBasis
    measuredLegs: number
    roadLegs: number
    estimatedLegs: number
    unknownLegs: number
    totalLegs: number
  }

  /** Stops whose minutes came from the shared default rather than evidence. */
  assumedDurationStops: number
  /** …and from established history. */
  learnedDurationStops: number
  /** Stops already part-worked on an earlier day — only the remainder is planned. */
  carriedOverStops: number

  /** Worst first. */
  warnings: DayPlanWarning[]
  /** True when any warning is blocking or a warning-level overrun exists. */
  realistic: boolean
}

const fmtH = (min: number) => {
  const m = Math.max(0, Math.round(min))
  if (m < 60) return `${m}m`
  const h = Math.floor(m / 60), r = m % 60
  return r ? `${h}h ${r}m` : `${h}h`
}
const plural = (n: number, one: string, many = one + 's') => `${n} ${n === 1 ? one : many}`

/**
 * Plan one day.
 *
 * The ORDER is given, not chosen: `input.stops` arrives in the sequence the
 * route engine resolved (the owner's manual order when there is one, the
 * optimizer's otherwise). This function walks that order, times it, measures it
 * against both constraints, and reports what it had to assume to do so.
 */
export function planDay(input: DayPlanInput): DayPlan {
  const active = input.stops.filter(s => s.status !== 'cancelled')

  // ── The two capacity dimensions, from the ONE shared arithmetic ────────────
  const fitInput: DayFitInput = {
    visits: active.map(s => ({
      duration_minutes: s.durationMinutes ?? null,
      status: s.status ?? null,
      crew_size: s.crewSize ?? null,
      service_type: s.serviceType ?? null,
    })),
    capacityHours: input.capacityHours,
    workers: input.workers,
    learnedFor: input.learnedFor,
  }
  // ── Time each leg first ───────────────────────────────────────────────────
  // The legs are resolved BEFORE the capacity arithmetic so the day's real
  // travel — measured where it has been measured — is what capacity is judged
  // against, rather than the flat 10-min-per-stop allowance a surface without a
  // route has to assume. They go back into the ONE formula through
  // dayCommitment's legMinutes seam; nothing is re-totalled here.
  const legs: PlannedLeg[] = []
  let kmTotal = 0
  let anyKm = false
  const legCount: Record<LegSource, number> = { measured: 0, road: 0, estimated: 0, unknown: 0 }

  for (const s of active) {
    let source: LegSource
    let minutes: number
    let km: number | null = null

    if (!s.located || s.legKm == null) {
      // No coordinates → the ETA chain's flat allowance, and the stop is not in
      // the distance total at all. It is disclosed, never silently absorbed.
      source = 'unknown'
      minutes = UNLOCATED_LEG_MIN
    } else {
      km = s.legKm
      anyKm = true
      kmTotal += km
      if (s.legSeconds != null && s.legSeconds > 0) {
        source = 'measured'
        minutes = Math.round(s.legSeconds / 60)
      } else {
        source = s.legIsRoad ? 'road' : 'estimated'
        minutes = legMinutes(km, input.speed)
      }
    }
    legCount[source]++
    legs.push({ jobId: s.jobId, km, minutes, source })
  }

  // ── Work already banked (Session 47) ──────────────────────────────────────
  // A visit that is `in_progress` on this day was started on an earlier one and
  // stopped for the day; `jobs.actual_minutes` is the DB-enforced sum of its
  // work sessions. Planning its FULL estimate again would book the same hours
  // twice and quietly overstate tomorrow. Only what is still outstanding is
  // planned — and the fact that some was carried over is disclosed, because a
  // stop that reads "20m" when its estimate said "3h" needs explaining.
  const remainingOverride = active.map(s => {
    if (s.status !== 'in_progress') return null
    const worked = Number(s.workedMinutes)
    return Number.isFinite(worked) && worked > 0 ? worked : null
  })

  const day: DayCommitment = dayCommitment(fitInput, {
    legMinutes: legs.map(l => l.minutes),
    alreadyWorkedMinutes: remainingOverride,
  })
  const carriedOverStops = remainingOverride.filter(m => m != null).length

  // ── Walk the order ────────────────────────────────────────────────────────
  // Through lib/route's ETA chain, handed this day's own leg minutes. There is
  // no second walk here: the arrival times this panel shows and the ones the
  // route timeline draws are the same numbers from the same function.
  const durationByJob: Record<string, number> = {}
  active.forEach((s, i) => { durationByJob[s.jobId] = day.visitMinutes[i] })
  const etas = computeDayEtas(
    input.startTime,
    active.map((s, i) => ({ jobId: s.jobId, legKm: legs[i].km })),
    durationByJob,
    input.speed,
    legs.map(l => l.minutes),
  )

  const startMin = etas.startMin
  const driveMin = legs.reduce((s, l) => s + l.minutes, 0)
  const stops: PlannedStop[] = active.map((s, i) => ({
    jobId: s.jobId,
    minutes: day.visitMinutes[i],
    durationSource: day.visitSources[i],
    crewSize: Math.max(1, Number(s.crewSize) || 1),
    arrivalMin: etas.stops[i].arrivalMin,
    arrival: etas.stops[i].arrival,
    unlocated: !s.located,
    leg: legs[i],
  }))

  const finishMin = etas.finishMin
  const capacityEndMin = startMin + day.capWindowMin
  const overrunMin = finishMin - capacityEndMin

  // ── Travel basis: the weakest leg present ─────────────────────────────────
  const present = (Object.keys(legCount) as LegSource[]).filter(k => legCount[k] > 0)
  const basis: TravelBasis = !input.hasBase || present.length === 0
    ? 'none'
    : present.reduce((worst, k) => (SOURCE_RANK[k] < SOURCE_RANK[worst] ? k : worst), present[0])

  // ── Geographic grouping ───────────────────────────────────────────────────
  // routeStats owns the definition (connected components within 1 km). Nothing
  // located → null, because "1 area" would be a claim about places we cannot
  // place. The km handed in is the day's own total, so the two agree.
  const coords = input.locatedCoords ?? []
  const areas = coords.length > 0 ? routeStats(coords, anyKm ? kmTotal : 0, input.speed).clusters : null

  const workMin = day.visitMinutes.reduce((a, b) => a + b, 0)
  const assumedDurationStops = day.visitSources.filter(v => v === 'assumed').length
  const learnedDurationStops = day.visitSources.filter(v => v === 'learned').length
  const unlocatedStops = active.filter(s => !s.located).length
  const locatedStops = active.length - unlocatedStops

  // ── Warnings ──────────────────────────────────────────────────────────────
  const warnings: DayPlanWarning[] = []
  const push = (w: DayPlanWarning) => { warnings.push(w) }

  const blocked = input.capacityHours != null && Number(input.capacityHours) === 0
  if (blocked && active.length > 0) {
    push({
      kind: 'day_blocked', severity: 'blocking',
      count: active.length,
      message: `This day is set to no working hours, but ${plural(active.length, 'visit')} ${active.length === 1 ? 'is' : 'are'} booked on it.`,
    })
  }

  if (day.workers === 0 && active.length > 0) {
    push({
      kind: 'crew_short', severity: 'blocking',
      message: 'Nobody is available to work this day — everyone on the roster is booked off.',
    })
  } else if (day.workers != null && day.maxCrewSize > day.workers) {
    const short = day.workers === 1 ? '1 person is' : `${day.workers} people are`
    push({
      kind: 'crew_short', severity: 'blocking',
      message: `A visit here asks for ${day.maxCrewSize} people and only ${short} available.`,
    })
  }

  // ── Staffing: who, by name, cannot work a day their crew is booked on ─────
  // The labour pool above says HOW MANY. This says WHO — because "2 assigned,
  // 1 available" is the sentence an owner can act on, and because a shortfall
  // inside one crew can hide inside a business-wide total that still balances.
  //
  // ⛔ Nothing here reassigns anything. Warn, name, and let the owner decide.
  const staffing = input.staffing
  if (staffing && active.length > 0) {
    const crewsWithWork = new Set(active.map(s => s.crewId).filter((c): c is string => !!c))
    const nameOf = (id: string) => input.crewNames?.[id] ?? 'this crew'

    for (const crewId of crewsWithWork) {
      const members = staffing.filter(w => w.crewId === crewId)
      if (members.length === 0) continue
      const ready = members.filter(canWork)
      if (ready.length === members.length) continue

      const off = members.filter(w => w.state === 'off')
      const unavailable = members.filter(w => w.state === 'unavailable')
      const because = [
        off.length ? `${off.length} booked off` : '',
        unavailable.length ? `${unavailable.length} not working this day` : '',
      ].filter(Boolean).join(', ')
      push({
        kind: 'crew_understaffed',
        // Nobody at all is a blocking fact; a thinner crew is a judgment call.
        severity: ready.length === 0 ? 'blocking' : 'warning',
        count: ready.length,
        message: ready.length === 0
          ? `${nameOf(crewId)} has work booked here and nobody available — ${because}.`
          : `${nameOf(crewId)} has ${plural(members.length, 'worker')} assigned but only ${ready.length} available — ${because}.`,
      })

      // Name them. A count tells the owner there is a problem; a name tells
      // them which call to make.
      for (const w of [...off, ...unavailable]) {
        if (!w.name) continue
        push({
          kind: 'worker_unavailable', severity: 'warning',
          message: w.state === 'off'
            ? `${w.name} is on ${nameOf(crewId)}, which works this day, but is booked off${w.offHours != null ? ` (${w.offHours} h)` : ''}.`
            : `${w.name} is on ${nameOf(crewId)}, which works this day, but does not normally work this weekday.`,
        })
      }
    }

    // ── Work given to ONE person by name (Session 65) ────────────────────────
    // A crew being short is a crew problem; a personally-assigned visit is a
    // problem the moment THAT person cannot work, however free their crewmates
    // are. Judged per person for exactly that reason.
    const personalIds = new Set(active.map(s => s.technicianId).filter((t): t is string => !!t))
    for (const technicianId of personalIds) {
      const worker = staffing.find(w => w.technicianId === technicianId)
      if (!worker || canWork(worker)) continue
      const who = worker.name ?? 'The person this is assigned to'
      const n = active.filter(s => s.technicianId === technicianId).length
      push({
        kind: 'worker_unavailable',
        // Nobody else is expected, so this one blocks rather than warns.
        severity: 'blocking',
        count: n,
        message: worker.state === 'off'
          ? `${who} has ${plural(n, 'visit')} assigned personally but is booked off${worker.offHours != null ? ` (${worker.offHours} h)` : ''}.`
          : `${who} has ${plural(n, 'visit')} assigned personally but does not normally work this weekday.`,
      })
    }

    // Every "available" here rests on nobody having said otherwise. Say so
    // once, quietly, rather than letting the day imply a schedule exists.
    if (input.availabilityRecorded === false && staffing.some(w => w.state === 'assumed')) {
      push({
        kind: 'availability_assumed', severity: 'caveat',
        count: staffing.filter(w => w.state === 'assumed').length,
        message: 'No one has a weekly schedule set, so everyone is assumed available — set working days to plan against real availability.',
      })
    }
  }

  if (day.laborUsedMin != null && day.laborCapMin != null && day.laborUsedMin > day.laborCapMin) {
    push({
      kind: 'labour_over', severity: 'blocking',
      message: `Booked work needs ${fmtH(day.laborUsedMin)} of people's time and ${day.workers === 1 ? 'one person has' : `${day.workers} people have`} ${fmtH(day.laborCapMin)}.`,
    })
  }

  if (overrunMin > 0 && active.length > 0) {
    push({
      kind: 'runs_past_capacity', severity: 'warning',
      message: `The route finishes around ${minutesToTime12(finishMin)} — ${fmtH(overrunMin)} past the ${fmtH(day.capWindowMin)} this day is set to.`,
    })
  } else if (active.length > 0 && overrunMin <= 0 && -overrunMin < FIT_BUFFER_MIN) {
    push({
      kind: 'no_room_left', severity: 'warning',
      message: `Only ${fmtH(-overrunMin)} spare after the last stop — one overrun puts this day long.`,
    })
  }

  if (day.workers == null && active.length > 0) {
    push({
      kind: 'workforce_unknown', severity: 'caveat',
      message: 'Who is available could not be read, so this day is checked against the clock only — not against the people.',
    })
  }

  if (assumedDurationStops > 0) {
    push({
      kind: 'durations_assumed', severity: 'caveat', count: assumedDurationStops,
      message: `${plural(assumedDurationStops, 'stop')} ${assumedDurationStops === 1 ? 'has' : 'have'} no duration set — counted at ${DEFAULT_JOB_MIN} min each, so the finish time is a rough one.`,
    })
  }

  if (carriedOverStops > 0) {
    push({
      kind: 'carried_over', severity: 'caveat', count: carriedOverStops,
      message: `${plural(carriedOverStops, 'stop')} ${carriedOverStops === 1 ? 'is' : 'are'} finishing work started earlier — only the time still outstanding is counted here.`,
    })
  }

  if (unlocatedStops > 0) {
    push({
      kind: 'unlocated_stops', severity: 'caveat', count: unlocatedStops,
      message: `${plural(unlocatedStops, 'stop')} ${unlocatedStops === 1 ? 'has' : 'have'} no address on file — not placed in the route and not counted in the distance.`,
    })
  }

  if (!input.hasBase && active.length > 1) {
    push({
      kind: 'no_base', severity: 'caveat',
      message: 'No base address is set, so these stops have not been put in a driving order.',
    })
  } else if (basis === 'estimated' || basis === 'unknown') {
    push({
      kind: 'travel_estimated', severity: 'caveat',
      message: 'Drive times here are estimated from how far apart the stops are in a straight line — treat them as grouping, not as a drive.',
    })
  } else if (basis === 'road') {
    push({
      kind: 'travel_modelled', severity: 'caveat',
      message: 'Distances are real road distances; the minutes are still estimated from your typical driving speed.',
    })
  }

  warnings.sort((a, b) => SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity])

  return {
    stops,
    stopCount: active.length,
    locatedStops,
    unlocatedStops,
    workMin,
    driveMin,
    km: anyKm ? Math.round(kmTotal * 10) / 10 : null,
    startMin,
    finishMin,
    finish: etas.finish,
    capacityEndMin,
    overrunMin,
    usedClockMin: day.usedClockMin,
    spareClockMin: day.spareClockMin,
    capacityMin: day.capWindowMin,
    workers: day.workers,
    laborUsedMin: day.laborUsedMin,
    laborCapMin: day.laborCapMin,
    spareLaborMin: day.spareLaborMin,
    maxCrewSize: day.maxCrewSize,
    areas,
    travel: {
      basis,
      measuredLegs: legCount.measured,
      roadLegs: legCount.road,
      estimatedLegs: legCount.estimated,
      unknownLegs: legCount.unknown,
      totalLegs: active.length,
    },
    assumedDurationStops,
    learnedDurationStops,
    carriedOverStops,
    warnings,
    realistic: !warnings.some(w => w.severity === 'blocking' || w.kind === 'runs_past_capacity'),
  }
}

// ── How the day's travel evidence reads in one phrase ────────────────────────

/**
 * The label a surface puts on the drive figure. Deliberately a full clause and
 * not a single word: "Estimated" beside a number still reads as a drive time,
 * and the whole point of the straight-line case is that it is NOT one.
 */
export function travelBasisLabel(travel: DayPlan['travel']): string {
  switch (travel.basis) {
    case 'measured':
      return 'Measured drive time'
    case 'road':
      return 'Real road distances, estimated minutes'
    case 'estimated':
      return 'Straight-line grouping, estimated minutes'
    case 'unknown':
      return 'Some stops could not be placed'
    case 'none':
      return 'No route'
  }
}

/**
 * ⭐ WHAT THE TRAVEL NUMBER IS ALLOWED TO BE CALLED.
 *
 * "17 minutes of driving" is a claim about roads. EdgeHQ can make it only
 * for legs a routing provider actually timed — and those durations are already
 * in `road_distance_cache.seconds`; nothing new is called to get them. For
 * every other leg the number is an allowance derived from how far apart the
 * stops are, and calling that "driving" invents a precision the data has not
 * got. So it is named ROUTE OVERHEAD instead: honest about being the cost of
 * moving between stops without pretending to know the drive.
 *
 * The word is chosen here, in the engine, so no surface can quietly upgrade it.
 */
export function travelFigureLabel(travel: DayPlan['travel']): 'driving' | 'route overhead' {
  return travel.basis === 'measured' ? 'driving' : 'route overhead'
}

/** True when the travel figure must carry an "estimated" qualifier. */
export function travelIsEstimated(travel: DayPlan['travel']): boolean {
  return travel.basis !== 'measured'
}

/** The one-line detail under it, when the legs are of mixed quality. */
export function travelBasisDetail(travel: DayPlan['travel']): string | null {
  const { measuredLegs, roadLegs, estimatedLegs, unknownLegs, totalLegs } = travel
  if (totalLegs === 0) return null
  const parts: string[] = []
  if (measuredLegs) parts.push(`${measuredLegs} measured`)
  if (roadLegs) parts.push(`${roadLegs} road distance`)
  if (estimatedLegs) parts.push(`${estimatedLegs} straight-line`)
  if (unknownLegs) parts.push(`${unknownLegs} unplaced`)
  return parts.length > 1 ? `${totalLegs} legs — ${parts.join(', ')}` : null
}

/**
 * How the day's geography reads. Honest about the difference between "we know
 * these are one cluster" and "we could not place them".
 */
export function areasLabel(plan: DayPlan): string {
  if (plan.areas == null) return 'Location unknown'
  if (plan.locatedStops <= 1) return 'One stop'
  if (plan.areas === 1) return 'All in one area'
  return `${plan.areas} separate areas`
}
