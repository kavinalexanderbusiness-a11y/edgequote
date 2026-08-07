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
