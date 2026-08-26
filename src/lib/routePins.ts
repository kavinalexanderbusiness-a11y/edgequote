// ── Route pins — "keep THIS stop in THIS position while optimizing the rest" ──
// Session 110.
//
// The owner's day is mostly a routing problem and partly a promise problem, and
// before this module there was no way to say the third thing: **I want this one
// here, and I do not want to argue about it.** The only tools were
//
//   • drag it, and have the next optimize run put it back, or
//   • give the customer a committed time they were never actually promised,
//
// the second of which puts a lie in the record that the product then texts to
// a real person.
//
// ══ WHAT A PIN IS, AND THE FOUR THINGS IT IS NOT ════════════════════════════
// A pin means exactly one thing:
//
//     "Keep this stop at this position while the rest is re-ordered."
//
// It is deliberately NOT:
//   ⛔ an appointment time     — that is `jobs.start_time` / `schedule_items.
//                                start_time`, which the product texts to the
//                                customer. A pin is never shown to a customer
//                                and never becomes one.
//   ⛔ a customer promise      — lib/daySequence scores lateness against the
//                                committed time, not against a pin. Pinning a
//                                stop first does not promise anybody a morning.
//   ⛔ jobs.route_order        — that is where a stop CURRENTLY sits, which is
//                                true of every stop on every day. A pin is the
//                                separate fact that the owner CHOSE that seat
//                                and wants it held. Collapsing the two would
//                                mean every optimize run silently pinned the
//                                whole day.
//   ⛔ an assignment           — who is going is `crew_id` / `technician_id`.
//
// ══ IT RECORDS; IT NEVER INVENTS ════════════════════════════════════════════
// Every pin in this module came from the owner putting a stop somewhere. No
// function here derives a position, guesses one, or upgrades a stop's current
// index into a pin. That is the property that lets the day board show a lock
// icon and mean it.
//
// ══ HONESTY RULES THE GUARD EXISTS TO HOLD ══════════════════════════════════
// 1. A pin whose stop has LEFT the day is dropped, never re-pointed at a
//    neighbour. A cancelled visit's pin does not silently become the pin of
//    whoever now sits at that index — that would move a stop the owner never
//    touched. `reconcile` returns what it dropped so the surface can say so.
// 2. A pin never changes the SET of stops, only their order. `orderWithPins`
//    returns a permutation of its input — same ids, same count.
// 3. Positions are clamped into the day, never dropped for being out of range:
//    a day that shrank from six stops to four still honours "keep this last".
// 4. ⛔ NO MONEY and ⛔ NO INDUSTRY KEYWORDS. A pin cannot know what the work is
//    worth or what it is called; the same structural promise lib/daySequence
//    and lib/dayPlan make.
// 5. Pure. No React, no Supabase, no storage. WHERE pins live is a question for
//    the caller — see `PinStore` in the day board — so this rule set can be
//    pinned directly by scripts/verify-pinned-route.ts.

/**
 * What kind of record a pinned stop is.
 *
 * The distinction is load-bearing rather than decorative: a `job` has a
 * `jobs.route_order` column and so its position can be WRITTEN, while an
 * `appointment` (an estimate on `schedule_items`) has no such column. Both can
 * be pinned inside a planning session; only one of them can be persisted by
 * today's schema. Keeping the kind on the pin is what lets the surface tell the
 * owner which is which instead of promising both.
 */
export type RouteStopKind = 'job' | 'appointment'

/** One owner-declared position hold. */
export interface RoutePin {
  stopId: string
  kind: RouteStopKind
  /** 1-based position in the day's driving order, as the owner placed it. */
  position: number
}

/**
 * What reconciling a pin set against the day it belongs to actually did.
 *
 * The two lists exist so the surface can be specific. "Some of your pins are no
 * longer valid" is the kind of sentence that makes an owner distrust the whole
 * feature; "Rosa's visit moved to Thursday, so its pin was removed" is one they
 * can act on.
 */
export interface PinReconciliation {
  /** The pins that still refer to a stop on this day, position-clamped. */
  pins: RoutePin[]
  /** Pins whose stop is no longer on this day — cancelled, moved, deleted. */
  dropped: RoutePin[]
  /** Pins whose position had to be clamped because the day got shorter. */
  clamped: RoutePin[]
}

/** The pinned ids, for the optimizer's locked set. */
export function pinnedIdSet(pins: readonly RoutePin[]): Set<string> {
  return new Set(pins.map(p => p.stopId))
}

/** Is this stop pinned? */
export function isPinned(pins: readonly RoutePin[], stopId: string): boolean {
  return pins.some(p => p.stopId === stopId)
}

/** The pin on a stop, if any. */
export function pinFor(pins: readonly RoutePin[], stopId: string): RoutePin | null {
  return pins.find(p => p.stopId === stopId) ?? null
}

/**
 * Bring a pin set back into agreement with the day as it now stands.
 *
 * Called on every read of the day, because the day changes underneath a pin in
 * ways nobody announces: a visit is cancelled, moved to Thursday, or reassigned
 * to a crew whose lane this board is not showing. Honesty rule 1 — a pin whose
 * stop is gone is DROPPED and reported, never quietly re-aimed at whichever
 * stop now occupies that index.
 */
export function reconcilePins(pins: readonly RoutePin[], order: readonly string[]): PinReconciliation {
  const live = new Set(order)
  const n = order.length
  const kept: RoutePin[] = []
  const dropped: RoutePin[] = []
  const clamped: RoutePin[] = []
  const seen = new Set<string>()

  for (const p of pins) {
    if (!live.has(p.stopId)) { dropped.push(p); continue }
    // A duplicate pin on one stop is not a state the owner can reach through
    // the UI, but a store that merged two sessions could produce one. The first
    // wins, so the result is deterministic rather than order-of-insertion luck.
    if (seen.has(p.stopId)) continue
    seen.add(p.stopId)
    const bounded = Math.min(Math.max(1, Math.trunc(p.position)), Math.max(1, n))
    if (bounded !== p.position) clamped.push({ ...p, position: bounded })
    kept.push({ ...p, position: bounded })
  }

  kept.sort((a, b) => a.position - b.position || a.stopId.localeCompare(b.stopId))
  return { pins: kept, dropped, clamped }
}

/**
 * The day's order with every pin sitting where the owner put it.
 *
 * This is what makes a pin survive anything at all. lib/daySequence reserves a
 * locked stop's CURRENT index by construction, so the pinned stop has to
 * already BE at its pinned position before the search runs — otherwise the
 * engine would faithfully hold the wrong seat.
 *
 * Unpinned stops keep their relative order and fill the seats that are left,
 * which is what "the optimizer may change every unpinned stop" means before any
 * optimizing happens: nothing is re-ordered here, only displaced.
 *
 * Honesty rule 2: the result is a permutation of `order` — same ids, same
 * count, nothing invented and nothing lost.
 */
export function orderWithPins(order: readonly string[], pins: readonly RoutePin[]): string[] {
  const n = order.length
  if (n === 0) return []

  const { pins: live } = reconcilePins(pins, order)
  if (live.length === 0) return [...order]

  const seats = new Array<string | null>(n).fill(null)
  const placed = new Set<string>()

  for (const p of live) {
    const want = Math.min(Math.max(1, p.position), n) - 1
    let at = want
    if (seats[at] !== null) {
      // Two pins want one seat (the day shrank, or both were clamped to the
      // end). Take the nearest free seat AFTER the request, then before it —
      // the later pin yields, which keeps the earlier one exactly where the
      // owner put it.
      let f = want
      while (f < n && seats[f] !== null) f++
      if (f >= n) { f = want; while (f >= 0 && seats[f] !== null) f-- }
      if (f < 0 || f >= n) continue
      at = f
    }
    seats[at] = p.stopId
    placed.add(p.stopId)
  }

  const rest = order.filter(id => !placed.has(id))
  let k = 0
  for (let i = 0; i < n; i++) if (seats[i] === null) seats[i] = rest[k++] ?? null

  return seats.filter((id): id is string => id !== null)
}

/**
 * Pin a stop at the position it currently occupies in `order`.
 *
 * ⭐ The position is READ from the order, never passed in. That is honesty
 * rule "it records; it never invents" expressed as an API: the only position a
 * stop can be pinned at is the one the owner has already dragged it to, so a
 * caller cannot accidentally pin a stop somewhere the owner never put it.
 */
export function pinAtCurrentPosition(
  pins: readonly RoutePin[],
  order: readonly string[],
  stopId: string,
  kind: RouteStopKind,
): RoutePin[] {
  const at = order.indexOf(stopId)
  if (at < 0) return [...pins]
  const next = pins.filter(p => p.stopId !== stopId)
  next.push({ stopId, kind, position: at + 1 })
  return next.sort((a, b) => a.position - b.position || a.stopId.localeCompare(b.stopId))
}

/** Release one pin. The stop keeps its seat until something re-orders it. */
export function unpin(pins: readonly RoutePin[], stopId: string): RoutePin[] {
  return pins.filter(p => p.stopId !== stopId)
}

/**
 * Re-read every pin's position from the order as it now stands.
 *
 * Used after a drag: the owner moved one stop, which shifts the index of
 * everything between its old and new seat. Without this the untouched pins
 * would still claim their OLD numbers and `orderWithPins` would drag them back.
 */
export function repositionPins(pins: readonly RoutePin[], order: readonly string[]): RoutePin[] {
  const rank = new Map(order.map((id, i) => [id, i + 1]))
  return pins
    .filter(p => rank.has(p.stopId))
    .map(p => ({ ...p, position: rank.get(p.stopId) as number }))
    .sort((a, b) => a.position - b.position || a.stopId.localeCompare(b.stopId))
}

/**
 * How a pin set is described to the owner in one line.
 *
 * Lives here so the day board and the optimize panel cannot word it
 * differently — the same reason lib/daySequence owns PROMISE_GRACE_MIN.
 */
export function pinSummary(pins: readonly RoutePin[]): string {
  const n = pins.length
  if (n === 0) return 'No pinned stops'
  return `${n} pinned stop${n === 1 ? '' : 's'}`
}
