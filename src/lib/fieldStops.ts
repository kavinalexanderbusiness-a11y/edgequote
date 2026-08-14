import type { JobStatus } from '@/types'

// ── THE driving order of a day's stops, and which one is next ────────────────
//
// Two surfaces answer "what am I doing next?" for the same day: the day board's
// card list (DayOpsPanel) and the phone-only field bar pinned in thumb reach
// (schedule/page.tsx). They each sorted the day themselves, from DIFFERENT
// inputs, and the field bar's comment claimed they "can never disagree":
//
//   board      → the RESOLVED route position (the owner's manual sequence when
//                one exists, else the optimizer's geographic order)
//   field bar  → jobs.route_order straight off the row
//
// jobs.route_order is only written when the owner manually drags stops. It is
// NULL on a day that has never been hand-ordered — which is nearly every day
// (230 of 236 jobs in production, and every multi-stop day in the book). With
// every route_order null AND every start_time null, the field bar's sort was a
// complete no-op: a stable sort over equal keys, so "next stop" fell through to
// the fetch order of the jobs array — `scheduled_date, id`, i.e. UUID order.
//
// So the bar named, and its one big button STARTED, a job picked essentially at
// random from the day, while the board's stop #1 was someone else. In the field
// that is the wrong customer's timer running and — on Complete — the wrong
// draft invoice.
//
// The rule lives here now, once, and both surfaces call it. Pure: no React, no
// Supabase, so scripts/verify-field-stops.ts can pin it directly.

/** A stop's rank when the route engine has no position for it (un-located). */
export const UNPLACED_STOP_RANK = 999

/**
 * The fields the ordering rule reads. Structural, so a `Job` satisfies it
 * without conversion and the engine stays independent of the row shape.
 */
export interface FieldStop {
  id: string
  status: JobStatus
  start_time?: string | null
  route_order?: number | null
}

/**
 * The day's stops in the order they are driven.
 *
 * `routeRank` is the RESOLVED route position by job id — what the route engine
 * produced for this day (`sequenceRoute` for a manual order, `optimizeRoute`
 * otherwise). Pass it whenever it is known; pass null before it resolves and
 * the fallback chain below still yields the same order the board shows at that
 * moment, so the two can't disagree even mid-load.
 *
 * Rank, in order of authority:
 *   1. the resolved route position          (the order the day is actually driven)
 *   2. jobs.route_order                     (a manual sequence, when no resolved
 *                                            position exists — e.g. an un-located
 *                                            stop the optimizer could not place)
 *   3. UNPLACED_STOP_RANK                   (un-located stops sink to the end)
 * Ties break on start_time, then hold input order (the sort is stable), so the
 * result is deterministic rather than dependent on fetch order.
 */
export function orderDayStops<T extends FieldStop>(
  stops: readonly T[],
  routeRank?: ReadonlyMap<string, number> | null,
): T[] {
  const rankOf = (s: T): number =>
    routeRank?.get(s.id) ?? s.route_order ?? UNPLACED_STOP_RANK
  return [...stops].sort((a, b) => {
    const ra = rankOf(a)
    const rb = rankOf(b)
    if (ra !== rb) return ra - rb
    return (a.start_time || '').localeCompare(b.start_time || '')
  })
}

// ── What the CREW's screen shows for the same day ────────────────────────────
//
// The rule above reconciles two surfaces inside the owner's app, which can
// share an engine. The crew cannot: a crew session has no table access at all,
// so its day arrives already sorted by the `crew_day` RPC and nothing on the
// phone can re-order it. The RPC sorts by:
//
//     coalesce(route_order, 999999), coalesce(start_time, '99:99'), created_at
//
// `jobs.route_order` is written ONLY when the owner hand-orders a day. Measured
// on production 2026-08-14: **7 of 174 jobs carry one, and 1 of 176 carries a
// start_time.** So on essentially every day the RPC's first two keys are ties
// and the crew's numbered list falls through to `created_at` — the order the
// visits happened to be booked in.
//
// Meanwhile the owner's board shows the optimizer's geographic order and
// numbers it 1, 2, 3. Neither screen is wrong on its own; together they are two
// confidently-numbered, DIFFERENT plans for one morning, and nothing anywhere
// said so.
//
// This mirrors the RPC's ORDER BY so the board can tell the owner what the crew
// would actually drive — and whether it is the plan on the screen.
// ⚠️ It is a MIRROR: if crew_day's ORDER BY changes, this changes with it.

/** The rank a stop with no saved position gets — crew_day's own 999999. */
export const UNORDERED_CREW_RANK = 999999
/** …and the start-time sentinel it sorts absent times under. */
export const NO_START_TIME_KEY = '99:99'

export interface CrewVisibleStop extends FieldStop {
  /** jobs.created_at — crew_day's final tiebreak. */
  created_at?: string | null
  /** jobs.crew_id — crew_day returns ONLY stops assigned to the caller's crew. */
  crew_id?: string | null
}

export interface CrewOrderStatus {
  /** The order a crew account would see, by job id. */
  crewOrder: string[]
  /** True when that is the same sequence the owner is looking at. */
  matchesPlan: boolean
  /** True when NO stop on the day carries a saved position — the crew's order
   *  is then purely booking order, which is not a plan anybody made. */
  unset: boolean
  /** Stops assigned to a crew. Only these can reach a crew screen AT ALL —
   *  crew_day filters on crew_id, so an unassigned visit is invisible there
   *  however well the day is ordered. (94 of the book's open visits, measured
   *  2026-08-14.) */
  assignedStops: number
  totalStops: number
}

/**
 * What the crew would see for a day the owner is looking at.
 *
 * `planned` must already be in the board's displayed order (orderDayStops), so
 * "matches" compares the crew's sequence against the plan on the screen rather
 * than against another derivation of it.
 */
export function crewOrderStatus<T extends CrewVisibleStop>(planned: readonly T[]): CrewOrderStatus {
  const live = planned.filter(s => s.status !== 'cancelled')
  const crewOrder = [...live]
    .sort((a, b) => {
      const ra = a.route_order ?? UNORDERED_CREW_RANK
      const rb = b.route_order ?? UNORDERED_CREW_RANK
      if (ra !== rb) return ra - rb
      const sa = a.start_time || NO_START_TIME_KEY
      const sb = b.start_time || NO_START_TIME_KEY
      if (sa !== sb) return sa.localeCompare(sb)
      return (a.created_at || '').localeCompare(b.created_at || '')
    })
    .map(s => s.id)
  const plannedIds = live.map(s => s.id)
  return {
    crewOrder,
    matchesPlan: crewOrder.length === plannedIds.length && crewOrder.every((id, i) => id === plannedIds[i]),
    unset: live.every(s => s.route_order == null),
    assignedStops: live.filter(s => !!s.crew_id).length,
    totalStops: live.length,
  }
}

/**
 * THE stop a field surface should be pointing at: whatever is on the clock now,
 * else the first one still to do. Completed and cancelled stops are never it.
 *
 * Takes an ALREADY-ORDERED list (from orderDayStops) so "next" is always read
 * off the same sequence the board renders — the whole point of this module.
 * Undefined once nothing is left, which is what hides the field bar.
 */
export function nextFieldStop<T extends FieldStop>(orderedStops: readonly T[]): T | undefined {
  const open = orderedStops.filter(s => s.status === 'in_progress' || s.status === 'scheduled')
  return open.find(s => s.status === 'in_progress') ?? open[0]
}
