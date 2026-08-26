// ── Day sequence — THE canonical "what ORDER should this day be driven in?" ──
// Session 82.
//
// Every other scheduling engine in this product already owns a different
// question, and none of them owns this one:
//
//   lib/route      → the SHORTEST driving order, by geography alone. It has
//                    never seen a promised time, and by design it still does
//                    not: `nnOrder` is a distance function, not a planner.
//   lib/dayPlan    → given an order, is the day REAL? It times the order and
//                    reports what it had to assume. It receives an order and
//                    has always refused to choose one (Session 60).
//   lib/dayFit     → does a CANDIDATE visit fit on a day?
//   lib/optimizer  → which DAY should a visit move to? (cross-day; it moves
//                    work between dates and never sequences within one)
//
// The gap is the question an owner actually asks on the morning of: the work
// is booked, the people are known, one customer was promised 9 AM — **what
// order should we drive it in?** Before this module the honest answers on that
// screen were "geographically shortest" (which cheerfully routes a 9 AM
// promise last) and a single narrow repair that only swapped already-timed
// visits among their own slots.
//
// ══ IT SEARCHES; IT DOES NOT MEASURE ════════════════════════════════════════
// This module proposes ORDERS and asks a better-qualified engine to judge them.
// It contains no clock, no distance model and no capacity arithmetic:
//
//   • timing + realism → lib/dayPlan planDay(). EVERY candidate, including the
//     day exactly as it stands, is timed by that ONE engine. That is what makes
//     "Current vs Suggested" an honest comparison rather than two engines
//     talking past each other: both columns are the same function's output.
//   • distance         → lib/route sequenceRoute() / nearestNeighborRoute(),
//     with the caller's cached road distances. No third distance path.
//   • travel wording   → lib/dayPlan travelFigureLabel(). The word "driving"
//     is earned in THAT engine or not at all; a saving is described with the
//     weakest evidence present, never upgraded here.
//
// ══ IT PROPOSES; IT NEVER APPLIES ═══════════════════════════════════════════
// ⛔ Nothing in this file writes. It returns a PROPOSAL — the current plan, the
// suggested plan, and what changed between them — and the owner approves it.
// A schedule that rearranges itself is a schedule the field stops trusting.
//
// ══ THE HONESTY RULES THE GUARD EXISTS TO HOLD ══════════════════════════════
// 1. LOCKED WORK DOES NOT MOVE. Completed, in-progress and billed stops keep
//    their exact position. So does an estimate appointment — `schedule_items`
//    has no `route_order` column, so its position CANNOT be persisted, and
//    proposing one would be a promise the database cannot keep.
// 2. A PROMISE IS A CONSTRAINT, NOT A POSITION. A timed visit may be re-ordered
//    — that is the whole point — but lateness against its promise is scored
//    ahead of distance, so the optimizer can never buy kilometres with a missed
//    appointment.
// 3. A SUGGESTION MUST BE STRICTLY BETTER, or it is not offered. `accepted` is
//    false when the search cannot beat the day as booked.
// 4. UNKNOWN STAYS UNKNOWN. Unknown duration, unmeasured travel and an
//    unreadable roster all keep planDay's own disclosures; this module adds no
//    confidence its inputs do not have.
// 5. ⛔ NO MONEY. Not a price, not a revenue total. An order is possible or it
//    is not; what the stops are worth cannot argue with that. (Same structural
//    promise as lib/dayPlan honesty rule 5 — the engine cannot SEE revenue.)
// 6. ⛔ NO INDUSTRY KEYWORDS. Nothing here inspects what the work is CALLED.
// 7. ⛔ BREAKS ARE NOT MODELLED. There is no break primitive in this product's
//    planning data (`break_minutes` exists only on payroll time entries), so
//    this module never inserts idle time and never calls a gap a break. A gap
//    between two stops is drive time. Where the order relies on arriving before
//    a promised time, that is DISCLOSED (`earlyArrivals`) rather than dressed
//    up as a scheduled pause.

import type { Coord } from '@/lib/geo'
import {
  nearestNeighborRoute, sequenceRoute, timeToMinutes, minutesToTime12,
  type DistFn, type RouteStop, type SpeedModel,
} from '@/lib/route'
import {
  planDay, travelFigureLabel, travelIsEstimated,
  type DayPlan, type DayPlanStopInput,
} from '@/lib/dayPlan'
import type { WorkerDayDetail } from '@/lib/workerAvailability'

// ── The promise grace ────────────────────────────────────────────────────────
/**
 * How far past a promised time an arrival may slip before it counts as late.
 *
 * ⭐ THE one definition. The dispatch board's conflict detector and this
 * optimizer used to carry their own copies of this number; a board that flags a
 * visit as late while the optimizer scores it as fine is two engines arguing
 * about one customer. Both now read this.
 */
export const PROMISE_GRACE_MIN = 15

// ── Why a stop cannot be moved ───────────────────────────────────────────────

/**
 * A stop whose position is fixed, and the reason — the reason is shown to the
 * owner, because "we left three stops alone" is only reassuring if it says why.
 *
 *  completed    — already done. It happened in that position.
 *  in_progress  — happening now, including a multi-day visit being finished.
 *  billed       — an invoice exists; the same immutability lib/optimizer honours.
 *  appointment  — an estimate appointment (schedule_items). It holds time and
 *                 is driven to, but it has no route_order column, so its place
 *                 in the order cannot be saved. It anchors; it never moves.
 */
export type LockReason = 'completed' | 'in_progress' | 'billed' | 'appointment'

/**
 * The lock a stop carries purely from its own row.
 *
 * ⭐ ONE definition, so the day board and the dispatch board cannot disagree
 * about what may be re-ordered. Work that is finished or under way happened in
 * the position it happened in; a billed visit is immutable for the same reason
 * lib/optimizer refuses to move one. `billed` is opt-in because not every
 * surface knows which visits have an invoice — a caller that does not know must
 * not silently assert that none do.
 */
export function lockFromStatus(
  status: string | null | undefined,
  opts?: { billed?: boolean },
): LockReason | null {
  if (status === 'completed') return 'completed'
  if (status === 'in_progress') return 'in_progress'
  if (opts?.billed) return 'billed'
  return null
}

export const LOCK_LABEL: Record<LockReason, string> = {
  completed: 'already done',
  in_progress: 'under way',
  billed: 'already billed',
  appointment: 'an estimate appointment — its order cannot be saved',
}

// ── Input ────────────────────────────────────────────────────────────────────

/**
 * One stop the day has to make. Everything lib/dayPlan needs to TIME it, plus
 * the three things ORDERING needs: where it is, when it was promised, and
 * whether it may move at all.
 *
 * ⛔ Deliberately absent: anything about money, and anything about what the
 * work is called beyond the `serviceType` token lib/dayPlan hands untouched to
 * the learned-duration lookup.
 */
export interface SequenceStop {
  /** Opaque key. A `jobs.id`, or a `schedule_items.id` for an estimate
   *  appointment — lib/route's RouteStop calls the field `jobId` for the same
   *  historical reason and never dereferences it either. */
  id: string
  /** How this stop is named to the owner in a change sentence. */
  label: string
  /** Where it is, or null when the address could not be placed. */
  coord: Coord | null
  /** Street address, for the route stop shape. */
  address?: string | null
  propertyId?: string | null
  /** A committed appointment time (jobs.start_time / schedule_items.start_time)
   *  as minutes since midnight, or null when nothing was promised. */
  promiseMin: number | null
  /** Set when this stop's position is fixed. Null = free to move. */
  lock: LockReason | null

  // ── Handed straight to lib/dayPlan, unchanged ──
  durationMinutes?: number | null
  crewSize?: number | null
  serviceType?: string | null
  status?: string | null
  crewId?: string | null
  technicianId?: string | null
  workedMinutes?: number | null
}

/**
 * Everything planDay needs that is a property of the DAY rather than of a stop.
 * Passed through verbatim — this module reads none of it except `startTime`,
 * which it needs to say what time a stop is reached.
 */
export interface DayContext {
  startTime: string | null | undefined
  capacityHours: number | null | undefined
  workers: number | null
  learnedFor?: (serviceType: string | null | undefined) => number | null
  speed?: SpeedModel
  hasBase: boolean
  staffing?: WorkerDayDetail[] | null
  crewNames?: Record<string, string>
  availabilityRecorded?: boolean
}

export interface DaySequenceInput {
  /** The day's stops, in the order it is CURRENTLY set to be driven. */
  stops: SequenceStop[]
  base: Coord | null
  day: DayContext
  /** Cached real-road distance, when the caller has one (lib/distance). Absent
   *  → straight-line, and planDay will say so. */
  dist?: DistFn
  /** Measured road seconds for a pair, when it has been timed. */
  seconds?: (a: Coord, b: Coord) => number | null
  /** Whether a pair's kilometres are real-road rather than straight-line. */
  hasRoad?: (a: Coord, b: Coord) => boolean
}

// ── Output ───────────────────────────────────────────────────────────────────

export interface SequenceMove {
  id: string
  label: string
  /** 1-based position before and after. */
  from: number
  to: number
  /** Arrival time in the suggested order, as a 12-hour label. */
  arrival: string
  /** True when this stop had a promise that the current order misses and the
   *  suggested one keeps. */
  fixesPromise: boolean
}

export interface PromiseNote {
  id: string
  label: string
  /** The promised time, as a 12-hour label. */
  promise: string
  /** What the plan says the arrival is. */
  arrival: string
  lateMin: number
}

export interface LockedNote {
  id: string
  label: string
  reason: LockReason
}

export interface DaySequenceProposal {
  /** The day exactly as booked, timed by lib/dayPlan. */
  current: DayPlan
  /** The proposed order, timed by the SAME function. */
  suggested: DayPlan
  /** The proposed order, as stop ids. */
  order: string[]
  /** The ids whose order can actually be PERSISTED (locked appointments and
   *  every estimate are excluded) — what a caller may write as route_order. */
  persistableOrder: string[]

  /** What moved, worst-first by distance travelled in the list. */
  moves: SequenceMove[]
  /** Stops left exactly where they were, and why. */
  locked: LockedNote[]

  /** Promises the SUGGESTED order still misses. Empty is the good case. */
  latePromises: PromiseNote[]
  /** …and how many the current order misses, so the gain can be stated. */
  lateBefore: number
  lateAfter: number

  /** Travel minutes saved (current − suggested). Negative means the suggestion
   *  drives MORE, which is legitimate when it buys a kept promise. */
  travelSavedMin: number
  /** What that figure may be CALLED — lib/dayPlan's own word, never upgraded. */
  travelLabel: 'driving' | 'route overhead'
  /** True when the travel figure must carry an "estimated" qualifier. */
  travelEstimated: boolean
  /** Minutes earlier the day finishes (current − suggested). */
  finishEarlierMin: number

  /**
   * Stops the suggested order reaches BEFORE their promised time. The finish
   * time assumes work starts on arrival — this product's ETA chain has always
   * worked that way — so if the crew actually waits, the day ends later than
   * stated. Disclosed rather than modelled: inventing a wait would be a second
   * timing model, and calling it a break would be a scheduling primitive this
   * product does not have.
   */
  earlyArrivals: number

  /** True when the suggestion is strictly better than the day as booked. When
   *  false there is nothing to offer and the caller must say so plainly. */
  accepted: boolean
  /** Why it is better, in the owner's words. Empty when accepted is false. */
  reasons: string[]
}

// ── Scoring ──────────────────────────────────────────────────────────────────

/**
 * What "better" means, in priority order. Compared lexicographically, so a
 * lower-ranked term can NEVER buy a higher-ranked one — the optimizer cannot
 * trade a missed appointment for shorter driving, because lateness is compared
 * before travel and the comparison stops at the first difference.
 *
 *   1. blocking   — verdicts that say the day cannot happen at all (staffing,
 *                   labour, a blocked day). From planDay; not re-derived here.
 *   2. late       — promised times missed by more than the grace.
 *   3. overrun    — minutes past the hours the day is set to.
 *   4. finish     — when the day ends.
 *   5. travel     — minutes spent moving between stops.
 *
 * ⛔ There is no revenue term and there must not be one. See honesty rule 5.
 */
type Score = [blocking: number, late: number, overrun: number, finish: number, travel: number]

function scoreOf(plan: DayPlan, promises: Map<string, number>): Score {
  return [
    plan.warnings.filter(w => w.severity === 'blocking').length,
    countLate(plan, promises),
    Math.max(0, plan.overrunMin),
    plan.finishMin,
    plan.driveMin,
  ]
}

/** Strictly-better test. Ties are NOT better — rule 3. */
function isBetter(a: Score, b: Score): boolean {
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return a[i] < b[i]
  }
  return false
}

/** How many promised arrivals this plan misses by more than the grace. */
function countLate(plan: DayPlan, promises: Map<string, number>): number {
  let late = 0
  for (const s of plan.stops) {
    const p = promises.get(s.jobId)
    if (p != null && s.arrivalMin > p + PROMISE_GRACE_MIN) late++
  }
  return late
}

// ── Timing a candidate ───────────────────────────────────────────────────────

/**
 * Turn one candidate ORDER into lib/dayPlan's verdict on it.
 *
 * The legs are rebuilt for the candidate's own sequence — walking the
 * coordinates forward exactly as the day board does, so each leg's measured
 * duration is looked up for ITS OWN pair rather than inherited from the order
 * the day happened to be in. Distances come from lib/route; nothing is
 * re-derived here.
 */
function planOrder(input: DaySequenceInput, order: string[]): DayPlan {
  const byId = new Map(input.stops.map(s => [s.id, s]))
  const seq = order.map(id => byId.get(id)).filter((s): s is SequenceStop => !!s)

  // Kilometres for this exact sequence, through the ONE route engine.
  const routeStops: RouteStop[] = seq.map(s => ({
    jobId: s.id,
    title: s.label,
    address: s.address ?? '',
    propertyId: s.propertyId ?? null,
    lat: s.coord?.lat ?? null,
    lng: s.coord?.lng ?? null,
  }))
  const legKmById = new Map<string, number | null>()
  if (input.base) {
    const r = sequenceRoute(input.base, routeStops, seq.map(s => s.id), input.dist)
    for (const o of r.ordered) legKmById.set(o.jobId, o.legKm)
  }

  // Measured seconds + road-ness are per PAIR, so walk the coordinates forward.
  const planStops: DayPlanStopInput[] = []
  let prev: Coord | null = input.base
  for (const s of seq) {
    const here = s.coord
    planStops.push({
      jobId: s.id,
      durationMinutes: s.durationMinutes,
      crewSize: s.crewSize,
      serviceType: s.serviceType,
      status: s.status,
      crewId: s.crewId ?? null,
      technicianId: s.technicianId ?? null,
      workedMinutes: s.workedMinutes,
      legKm: legKmById.get(s.id) ?? null,
      legSeconds: prev && here && input.seconds ? input.seconds(prev, here) : null,
      legIsRoad: !!(prev && here && input.hasRoad?.(prev, here)),
      located: here != null,
    })
    if (here) prev = here
  }

  return planDay({
    stops: planStops,
    startTime: input.day.startTime,
    capacityHours: input.day.capacityHours,
    workers: input.day.workers,
    learnedFor: input.day.learnedFor,
    speed: input.day.speed,
    locatedCoords: seq.map(s => s.coord).filter((c): c is Coord => !!c),
    hasBase: input.day.hasBase,
    staffing: input.day.staffing ?? null,
    crewNames: input.day.crewNames,
    availabilityRecorded: input.day.availabilityRecorded,
  })
}

// ── Candidate generation ─────────────────────────────────────────────────────

/**
 * Rebuild a full order from a proposed sequence of the MOVABLE stops.
 *
 * Locked stops keep their exact index; the movable ones are dealt back into the
 * slots the movable stops currently occupy. This is the mechanism behind
 * honesty rule 1 — a locked stop cannot be displaced by construction, not by a
 * later check that someone might forget to run.
 */
function intoMovableSlots(currentOrder: string[], lockedIds: Set<string>, movableSeq: string[]): string[] {
  const slots: number[] = []
  currentOrder.forEach((id, i) => { if (!lockedIds.has(id)) slots.push(i) })
  const out = [...currentOrder]
  slots.forEach((slot, k) => { if (movableSeq[k] != null) out[slot] = movableSeq[k] })
  return out
}

/**
 * The geographic candidate: the movable stops in the order lib/route would
 * drive them. Un-locatable movable stops cannot be sequenced, so they hold
 * their relative order at the back — the same refusal to invent a position that
 * lib/dayPlan makes when it declines to put an unplaced stop in the route.
 */
function geographicSeq(input: DaySequenceInput, movable: SequenceStop[]): string[] | null {
  if (!input.base) return null
  const located = movable.filter(s => s.coord)
  if (located.length < 2) return null
  const stops: RouteStop[] = located.map(s => ({
    jobId: s.id, title: s.label, address: s.address ?? '', propertyId: s.propertyId ?? null,
    lat: s.coord!.lat, lng: s.coord!.lng,
  }))
  const nn = nearestNeighborRoute(input.base, stops, input.dist)
  return [...nn.ordered.map(o => o.jobId), ...movable.filter(s => !s.coord).map(s => s.id)]
}

/**
 * ⭐ THE ABSORBED `suggestPromiseOrder` (was lib/dispatchOps).
 *
 * The cheapest honest repair: leave every SLOT of the current route where it
 * is, and let the TIMED stops swap among their own slots into promise order —
 * the 9 AM appointment stops queuing behind the 1 PM one. It survives here as
 * one candidate among several rather than as a second engine with its own
 * accept/reject rule, which is what it had become: a narrow optimizer that
 * could only ever fix one shape of problem and could not see capacity,
 * staffing or the day's finish while it did.
 */
function promiseSlotSwapSeq(movable: SequenceStop[]): string[] | null {
  const timed = movable.map((s, i) => ({ s, i })).filter(x => x.s.promiseMin != null)
  if (timed.length < 2) return null
  const byPromise = [...timed].sort((a, b) => (a.s.promiseMin as number) - (b.s.promiseMin as number))
  const seq = movable.map(s => s.id)
  timed.forEach((slot, k) => { seq[slot.i] = byPromise[k].s.id })
  return seq
}

/**
 * Promise-first: every timed stop in promise order, and the untimed ones filled
 * in around them in driving order. This is the candidate that actually rescues
 * a day whose promises were booked in one order and routed in another.
 */
function promiseFirstSeq(input: DaySequenceInput, movable: SequenceStop[]): string[] | null {
  const timed = movable.filter(s => s.promiseMin != null)
  if (timed.length === 0) return null
  const geo = geographicSeq(input, movable)
  const geoRank = new Map((geo ?? movable.map(s => s.id)).map((id, i) => [id, i]))
  const untimed = movable.filter(s => s.promiseMin == null)
    .sort((a, b) => (geoRank.get(a.id) ?? 0) - (geoRank.get(b.id) ?? 0))
  const inPromiseOrder = [...timed].sort((a, b) => (a.promiseMin as number) - (b.promiseMin as number))
  // Untimed work fills the gaps between promises, nearest-first; anything left
  // over runs after the last appointment.
  const out: string[] = []
  const remaining = [...untimed]
  for (const t of inPromiseOrder) {
    out.push(t.id)
    const next = remaining.shift()
    if (next) out.push(next.id)
  }
  out.push(...remaining.map(s => s.id))
  return out
}

/**
 * Local repair: try lifting each still-late stop one slot earlier, keeping any
 * move that scores better. A first-improvement hill climb over the candidate
 * that is already winning — bounded, so a big day cannot make the panel hang.
 */
function repair(input: DaySequenceInput, order: string[], lockedIds: Set<string>, promises: Map<string, number>, best: { order: string[]; plan: DayPlan; score: Score }): void {
  const MAX_PASSES = 4
  for (let pass = 0; pass < MAX_PASSES; pass++) {
    let improved = false
    const plan = best.plan
    const lateIds = plan.stops
      .filter(s => { const p = promises.get(s.jobId); return p != null && s.arrivalMin > p + PROMISE_GRACE_MIN })
      .map(s => s.jobId)
    for (const id of lateIds) {
      if (lockedIds.has(id)) continue
      const cur = [...best.order]
      const at = cur.indexOf(id)
      if (at <= 0) continue
      // Walk it forward past movable stops until it improves or reaches the front.
      for (let to = at - 1; to >= 0; to--) {
        if (lockedIds.has(cur[to])) continue
        const cand = [...best.order]
        cand.splice(at, 1)
        cand.splice(to, 0, id)
        const p = planOrder(input, cand)
        const sc = scoreOf(p, promises)
        if (isBetter(sc, best.score)) {
          best.order = cand; best.plan = p; best.score = sc
          improved = true
          break
        }
      }
    }
    if (!improved) break
  }
}

// ── The proposal ─────────────────────────────────────────────────────────────

/**
 * Propose an order for one day.
 *
 * `input.stops` arrives in the order the day is currently set to be driven.
 * Every candidate — including that one — is timed by lib/dayPlan, and the best
 * scoring order is returned alongside the current one so the owner can see both
 * and decide. Nothing is written.
 */
export function sequenceDay(input: DaySequenceInput): DaySequenceProposal {
  // Cancelled work is not driven to. lib/dayPlan drops it from the timing too;
  // dropping it here as well keeps the ORDER and the PLAN talking about the
  // same set of stops.
  const stops = input.stops.filter(s => s.status !== 'cancelled')
  const currentOrder = stops.map(s => s.id)
  const promises = new Map<string, number>()
  for (const s of stops) if (s.promiseMin != null) promises.set(s.id, s.promiseMin)

  const lockedIds = new Set(stops.filter(s => s.lock).map(s => s.id))
  const movable = stops.filter(s => !s.lock)

  const currentPlan = planOrder({ ...input, stops }, currentOrder)
  const currentScore = scoreOf(currentPlan, promises)

  const best = { order: currentOrder, plan: currentPlan, score: currentScore }

  // Only a day with at least two movable stops has an ordering question.
  if (movable.length >= 2) {
    const seqInput = { ...input, stops }
    const candidates = [
      geographicSeq(seqInput, movable),
      promiseSlotSwapSeq(movable),
      promiseFirstSeq(seqInput, movable),
    ].filter((s): s is string[] => !!s)

    for (const movableSeq of candidates) {
      const order = intoMovableSlots(currentOrder, lockedIds, movableSeq)
      if (order.join() === best.order.join()) continue
      const plan = planOrder(seqInput, order)
      const score = scoreOf(plan, promises)
      if (isBetter(score, best.score)) { best.order = order; best.plan = plan; best.score = score }
    }
    repair(seqInput, currentOrder, lockedIds, promises, best)
  }

  const accepted = isBetter(best.score, currentScore)
  const suggested = best.plan

  // ── What changed ──────────────────────────────────────────────────────────
  const posBefore = new Map(currentOrder.map((id, i) => [id, i + 1]))
  const posAfter = new Map(best.order.map((id, i) => [id, i + 1]))
  const labelOf = new Map(stops.map(s => [s.id, s.label]))
  const arrivalAfter = new Map(suggested.stops.map(s => [s.jobId, s.arrival]))
  const arrivalMinAfter = new Map(suggested.stops.map(s => [s.jobId, s.arrivalMin]))
  const arrivalMinBefore = new Map(currentPlan.stops.map(s => [s.jobId, s.arrivalMin]))

  const lateNow = (id: string, at: Map<string, number>) => {
    const p = promises.get(id)
    const a = at.get(id)
    return p != null && a != null && a > p + PROMISE_GRACE_MIN
  }

  const moves: SequenceMove[] = best.order
    .map(id => ({
      id,
      label: labelOf.get(id) ?? id,
      from: posBefore.get(id) ?? 0,
      to: posAfter.get(id) ?? 0,
      arrival: arrivalAfter.get(id) ?? '',
      fixesPromise: lateNow(id, arrivalMinBefore) && !lateNow(id, arrivalMinAfter),
    }))
    .filter(m => m.from !== m.to)
    .sort((a, b) => Math.abs(b.to - b.from) - Math.abs(a.to - a.from))

  const locked: LockedNote[] = stops
    .filter(s => s.lock)
    .map(s => ({ id: s.id, label: s.label, reason: s.lock as LockReason }))

  const latePromises: PromiseNote[] = suggested.stops
    .filter(s => lateNow(s.jobId, arrivalMinAfter))
    .map(s => ({
      id: s.jobId,
      label: labelOf.get(s.jobId) ?? s.jobId,
      promise: minutesToTime12(promises.get(s.jobId) as number),
      arrival: s.arrival,
      lateMin: s.arrivalMin - (promises.get(s.jobId) as number),
    }))

  const earlyArrivals = suggested.stops.filter(s => {
    const p = promises.get(s.jobId)
    return p != null && s.arrivalMin < p
  }).length

  const lateBefore = countLate(currentPlan, promises)
  const lateAfter = countLate(suggested, promises)
  const travelSavedMin = currentPlan.driveMin - suggested.driveMin
  const finishEarlierMin = currentPlan.finishMin - suggested.finishMin

  // ── Why it is better ──────────────────────────────────────────────────────
  // Every sentence quotes a number this result carries, and the travel sentence
  // uses lib/dayPlan's word for what the figure is worth.
  const travelLabel = travelFigureLabel(suggested.travel)
  const travelEstimated = travelIsEstimated(suggested.travel)
  const reasons: string[] = []
  if (accepted) {
    const blockingBefore = currentPlan.warnings.filter(w => w.severity === 'blocking').length
    const blockingAfter = suggested.warnings.filter(w => w.severity === 'blocking').length
    if (blockingAfter < blockingBefore) {
      reasons.push(`Clears ${blockingBefore - blockingAfter} blocking problem${blockingBefore - blockingAfter !== 1 ? 's' : ''} with the day.`)
    }
    if (lateAfter < lateBefore) {
      reasons.push(lateAfter === 0
        ? `Every promised time is met — ${lateBefore} ${lateBefore === 1 ? 'was' : 'were'} being missed.`
        : `${lateBefore - lateAfter} fewer promised time${lateBefore - lateAfter !== 1 ? 's' : ''} missed.`)
    }
    if (travelSavedMin > 0) {
      reasons.push(`About ${fmtMin(travelSavedMin)} less ${travelLabel}${travelEstimated ? ' (estimated)' : ''}.`)
    }
    if (finishEarlierMin > 0) {
      reasons.push(`The day finishes about ${fmtMin(finishEarlierMin)} earlier, around ${suggested.finish}.`)
    }
    if (suggested.overrunMin < currentPlan.overrunMin && currentPlan.overrunMin > 0) {
      reasons.push(`Runs ${fmtMin(currentPlan.overrunMin - Math.max(0, suggested.overrunMin))} less past the hours this day is set to.`)
    }
  }

  return {
    current: currentPlan,
    suggested,
    order: best.order,
    // ⛔ Only stops whose position can actually be SAVED. An estimate
    // appointment is driven to and timed, but `schedule_items` has no
    // route_order column — offering to persist its place would be a promise the
    // database cannot keep, so it is excluded from what a caller may write.
    persistableOrder: best.order.filter(id => {
      const s = stops.find(x => x.id === id)
      return !!s && s.lock !== 'appointment'
    }),
    moves,
    locked,
    latePromises,
    lateBefore,
    lateAfter,
    travelSavedMin,
    travelLabel,
    travelEstimated,
    finishEarlierMin,
    earlyArrivals,
    accepted,
    reasons,
  }
}

function fmtMin(min: number): string {
  const m = Math.max(0, Math.round(min))
  if (m < 60) return `${m} min`
  const h = Math.floor(m / 60), r = m % 60
  return r ? `${h}h ${r}m` : `${h}h`
}

// ── Reading a promise back ───────────────────────────────────────────────────

/**
 * A committed appointment time as minutes since midnight, or null.
 *
 * ⚠️ `jobs.end_time` is deliberately NOT read. It is written by the visit form
 * and no scheduling engine has ever consumed it, so nobody has established
 * whether it means "must be finished by", "expected to finish" or nothing at
 * all. Treating it as a hard constraint would invent a promise the owner never
 * knowingly made. Establish the semantics first; until then a promise is the
 * START time, which the product already texts to customers.
 */
export function promiseMinutes(startTime: string | null | undefined): number | null {
  return startTime ? timeToMinutes(startTime) : null
}
