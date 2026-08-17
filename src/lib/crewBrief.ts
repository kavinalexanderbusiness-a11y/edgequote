import type { CrewDay, CrewStop } from '@/lib/crewAccess'

// ── What changed since I last looked ─────────────────────────────────────────
//
// Crew Mode already answers six of a worker's seven morning questions: where am
// I going, when, what am I doing, what do I need to know, who am I with, what
// action do I take. It had no answer at all for the seventh — WHAT CHANGED —
// and that is the one a phone is uniquely able to answer, because the office
// changes the day after the worker has already read it.
//
// The failure this module prevents is specific. The board re-reads `crew_day`
// on focus, on reconnect and every five minutes (CrewToday's liveness loop).
// So the office moving a stop, rewriting a gate code or cancelling a visit lands
// on the phone SILENTLY: the card list simply re-renders in its new shape. A
// worker who read the screen at 7am and glances at it at 9am sees a different
// day and no indication that it is different. In the field that is a drive to
// an address nobody is expecting them at.
//
// ══ WHAT COUNTS AS A CHANGE ═════════════════════════════════════════════════
// ⛔ NOT every mutation. `jobs.updated_at` moves when the crew taps Start, when
// a photo lands, when the office touches anything at all. Reporting row versions
// would produce a feed that is technically complete and practically unreadable,
// and a change list nobody reads is worse than none — it teaches the worker to
// dismiss the one that mattered.
//
// A change is reported only when a field THE WORKER ACTS ON differs:
//
//   removed / cancelled  → don't drive there
//   added                → drive somewhere new
//   time                 → be there at a different hour
//   moved                → do them in a different sequence
//   crew                 → the people you're working with changed
//   instruction          → the standing fact about the site changed (jobs.notes)
//   day_note / crew_note → the office wrote to the whole day
//   message              → somebody said something and is waiting on a reply
//
// ⛔ DELIBERATELY EXCLUDED, and this list is the point of the module:
//   · status → in_progress / completed. That is the worker's OWN tap arriving
//     back from the server. Reporting it would mean every Start produced a
//     "changed" banner about the thing just done.
//   · started_at, completed_at, actual_minutes, on_my_way_at — the same tap's
//     side effects.
//   · completion_summary / completion_issue — the worker wrote those.
//   · updated_at — a row version is not an event.
//
// ══ THE HONESTY RULES ═══════════════════════════════════════════════════════
// 1. ⭐ NO BASELINE ⇒ NO CLAIMS. A first open has nothing to compare against, so
//    it reports nothing. It must never read as "all of this is new" — on a phone
//    that has just cleared its storage, that would mark a totally ordinary day
//    as eight changes and destroy the signal permanently.
// 2. A baseline for ANOTHER DAY, or another TECHNICIAN, is not a baseline. Both
//    are in the storage key, so a shared phone and tomorrow morning both start
//    from "no claims" rather than from somebody else's day.
// 3. ⭐ ONLY AN ACKNOWLEDGEMENT ADVANCES THE BASELINE — never a render, never
//    the 5-minute poll. Otherwise a phone face-up on the truck seat auto-reads
//    the schedule change and the worker never learns of it. See markCrewDaySeen.
// 4. A FAILED LOAD IS NOT A DAY. Only a `kind:'ok'` payload may become a
//    baseline; the stale/offline branches leave the previous one exactly where
//    it was, so a change is still waiting when signal comes back.
// 5. ⭐ A MOVE IS MEASURED OVER THE STOPS BOTH DAYS SHARE. Adding one stop at
//    the top shifts every index below it; comparing raw positions would report
//    "moved" for stops nobody touched. So the sequence is compared over the
//    common ids only — a stop moved when it changed places relative to the
//    stops the worker already knew about, which is the claim being made.
//
// Pure — no React, no Supabase, no storage — so scripts/verify-field-home.ts
// pins every rule above by running it.

// ── The order's basis ────────────────────────────────────────────────────────
//
// ⭐⭐ WHOSE PLAN IS THE NUMBERED LIST? `crew_day` sorts the day by
//
//     coalesce(route_order, 999999), coalesce(start_time, '99:99'), created_at
//
// and a crew session cannot re-order it (no table access — RPCs only), which is
// correct: the phone must not invent a route. But `jobs.route_order` is written
// ONLY when the owner hand-drags a day, and `start_time` only when a visit is
// committed to an hour. Measured on production 2026-08-14: **7 of 175 jobs carry
// a route_order and 1 of 175 a start_time.** On every other day both leading
// keys are ties for every row and the sort falls through to `created_at` — the
// order the visits happened to be BOOKED in.
//
// That order is still a sequence a worker can drive, and the numbers are still
// useful ("stop 3 of 5"). What is not true is that anybody CHOSE it. Saying so
// costs one line and stops the crew from treating booking order as the office's
// route — the exact mismatch Session 60 found between this list and the owner's
// optimised board.
//
// ⚠️ THIS READS THE ORDER; IT NEVER COMPUTES ONE. There is no sequencing
// algorithm in this file and there must not be: lib/route owns ordering for the
// owner's board, the RPC owns it for the phone, and a third would be a third
// answer to "what is stop one?".

/** Where the sequence the crew is looking at came from. */
export type CrewOrderBasis =
  /** At least one stop carries a position or an hour the office committed to. */
  | 'planned'
  /** Nothing does — the list is the order the visits were booked in. */
  | 'booked'
  /** Fewer than two stops: there is no sequence to have a basis. */
  | 'none'

export function crewOrderBasis(stops: readonly CrewStop[]): CrewOrderBasis {
  const live = stops.filter(s => s.status !== 'cancelled')
  if (live.length < 2) return 'none'
  const chosen = live.some(s => s.route_order != null || (s.start_time ?? '') !== '')
  return chosen ? 'planned' : 'booked'
}

// ── The snapshot ─────────────────────────────────────────────────────────────
// Small enough for localStorage on a cheap phone, and carrying ONLY the fields
// whose change is reportable. Instructions are stored as a hash rather than
// text: the claim being made is "this changed", never "it used to say", and a
// day of long site instructions would otherwise be tens of kilobytes per day
// per worker.

/** djb2. Stable across reloads, which is all a change detector needs. */
export function textMark(s: string | null | undefined): number {
  const t = (s ?? '').trim()
  let h = 5381
  for (let i = 0; i < t.length; i++) h = (((h << 5) + h) ^ t.charCodeAt(i)) >>> 0
  return h
}

export interface CrewStopMark {
  /** Who/where, kept so a REMOVED stop can still be named — it is gone from the
   *  day being rendered, so the sentence about it has no other source. */
  label: string
  start_time: string | null
  /** Hash of jobs.notes — the standing instruction. */
  notes: number
  cancelled: boolean
  /** Unread messages on this visit when the worker last acknowledged. */
  unread: number
}

export interface CrewDaySnapshot {
  /** Bumped when the shape changes; an unrecognised version is discarded rather
   *  than migrated, which costs one silent morning and cannot mis-report. */
  v: 1
  date: string
  /** Whose day this was. A different worker on the same handset gets no claims. */
  techId: string | null
  /** ACTIVE stop ids, in the order the RPC returned them. Cancelled stops leave
   *  this list (they render in their own section) but stay in `stops`, so
   *  "cancelled" is reported once and never again as "removed". */
  order: string[]
  stops: Record<string, CrewStopMark>
  dayNote: number
  crewNote: number
  /** Which crew this worker was on. OPTIONAL — a baseline saved by a build that
   *  did not record it makes NO crew claims (absent ≠ "no crew"), the same
   *  missing-baseline rule the whole module runs on. Not a version bump: v2
   *  would discard every phone's baseline for a field it can simply skip. */
  crewId?: string | null
  /** Teammate ids, SORTED — identity, not display. A renamed teammate is not a
   *  crew change; a different set of people is. */
  mateIds?: string[]
  /** Teammate names in display order, kept so the sentence about a crew change
   *  can name who the worker is with NOW without re-reading the day. */
  mateNames?: string[]
  savedAt: number
}

/**
 * What the worker is being shown right now, in comparable form.
 * `unreadByJob` comes from the crew inbox feed CrewToday already runs — the
 * unread counts are the server's, so "new message" means the server still
 * considers it unread, not that this device forgot seeing it.
 */
export function crewDaySnapshot(
  day: CrewDay,
  unreadByJob: Record<string, number> = {},
  now = Date.now(),
): CrewDaySnapshot {
  const stops: Record<string, CrewStopMark> = {}
  const order: string[] = []
  for (const s of day.stops) {
    const cancelled = s.status === 'cancelled'
    stops[s.id] = {
      label: s.customer?.name || s.title,
      start_time: s.start_time ?? null,
      notes: textMark(s.notes),
      cancelled,
      unread: unreadByJob[s.id] ?? 0,
    }
    if (!cancelled) order.push(s.id)
  }
  return {
    v: 1,
    date: day.date,
    techId: day.me?.id ?? null,
    order,
    stops,
    dayNote: textMark(day.day_note),
    crewNote: textMark(day.crew_note),
    crewId: day.crew?.id ?? null,
    mateIds: day.teammates.map(t => t.id).sort(),
    mateNames: day.teammates.map(t => t.name),
    savedAt: now,
  }
}

// ── The changes ──────────────────────────────────────────────────────────────

export type CrewChangeKind =
  | 'removed' | 'cancelled' | 'added' | 'time' | 'moved' | 'crew'
  | 'instruction' | 'day_note' | 'crew_note' | 'message'

export interface CrewChange {
  kind: CrewChangeKind
  /** The visit this is about; null for day-wide notes and a bulk reorder. */
  jobId: string | null
  /** Who/where — the subject of the sentence the UI writes. */
  label: string
  /** The specific of it, when there is one worth a few words. */
  detail?: string
}

/**
 * Severity order, and it is a driving order not a data order: what NOT to drive
 * to outranks what to drive to, which outranks when, which outranks reading
 * material. The UI truncates from the bottom, so a truncated list still leads
 * with the thing that would waste a trip.
 */
const SEVERITY: Record<CrewChangeKind, number> = {
  removed: 0, cancelled: 1, added: 2, time: 3, moved: 4, crew: 5,
  instruction: 6, crew_note: 7, day_note: 8, message: 9,
}

/** More than this many individual reorders and the list says so once instead. */
const MAX_INDIVIDUAL_MOVES = 2

function timeWords(t: string | null): string {
  if (!t) return 'no set time'
  const [h, m] = t.split(':')
  const hh = Number(h)
  if (!Number.isFinite(hh)) return 'no set time'
  return `${((hh + 11) % 12) + 1}:${m} ${hh < 12 ? 'am' : 'pm'}`
}

/**
 * What changed between the day the worker acknowledged and the day on screen.
 *
 * `prev` null — no baseline — returns EMPTY. Honesty rule 1: a first open has
 * nothing to compare against, and a day full of ordinary work must never
 * announce itself as a day full of changes.
 *
 * A baseline for a different date or a different technician is likewise no
 * baseline (rule 2) and returns empty rather than diffing across days.
 */
export function diffCrewDay(
  prev: CrewDaySnapshot | null,
  next: CrewDaySnapshot,
): CrewChange[] {
  if (!prev) return []
  if (prev.v !== next.v) return []
  if (prev.date !== next.date) return []
  if (prev.techId !== next.techId) return []

  const out: CrewChange[] = []

  // ── Per-stop ───────────────────────────────────────────────────────────────
  for (const [id, was] of Object.entries(prev.stops)) {
    const now = next.stops[id]
    if (!now) {
      // Gone from the payload entirely: rescheduled to another day, or handed
      // to another crew. Either way the worker must not drive there, and this
      // is the only surface that can say so — the card itself is already gone.
      out.push({ kind: 'removed', jobId: id, label: was.label, detail: 'no longer on your day' })
      continue
    }
    if (now.cancelled && !was.cancelled) {
      out.push({ kind: 'cancelled', jobId: id, label: now.label, detail: 'cancelled by the office' })
      continue   // a cancelled stop's hour and instructions are moot
    }
    if (now.cancelled) continue

    if ((was.start_time ?? null) !== (now.start_time ?? null)) {
      out.push({
        kind: 'time', jobId: id, label: now.label,
        detail: `${timeWords(was.start_time)} → ${timeWords(now.start_time)}`,
      })
    }
    if (was.notes !== now.notes) {
      out.push({ kind: 'instruction', jobId: id, label: now.label, detail: 'instructions changed' })
    }
    if (now.unread > was.unread) {
      const n = now.unread - was.unread
      out.push({
        kind: 'message', jobId: id, label: now.label,
        detail: n === 1 ? 'new message' : `${n} new messages`,
      })
    }
  }

  for (const id of next.order) {
    if (!prev.stops[id]) {
      out.push({ kind: 'added', jobId: id, label: next.stops[id].label, detail: 'added to your day' })
    }
  }

  // ── Sequence ───────────────────────────────────────────────────────────────
  // Honesty rule 5: compared over the stops BOTH days hold, so an addition or a
  // cancellation cannot manufacture a move for stops nobody touched.
  const inNext = new Set(next.order)
  const inPrev = new Set(prev.order)
  const prevCommon = prev.order.filter(id => inNext.has(id))
  const nextCommon = next.order.filter(id => inPrev.has(id))
  const movedIds: string[] = []
  for (let i = 0; i < nextCommon.length; i++) {
    if (prevCommon[i] !== nextCommon[i]) movedIds.push(nextCommon[i])
  }
  if (movedIds.length > 0 && movedIds.length <= MAX_INDIVIDUAL_MOVES) {
    for (const id of movedIds) {
      const at = nextCommon.indexOf(id)
      out.push({
        kind: 'moved', jobId: id, label: next.stops[id].label,
        detail: `now stop ${at + 1}`,
      })
    }
  } else if (movedIds.length > 0) {
    out.push({
      kind: 'moved', jobId: null, label: 'Your stop order changed',
      detail: next.order.length > 0 ? `${next.stops[next.order[0]].label} is first` : undefined,
    })
  }

  // ── Who the worker is with ─────────────────────────────────────────────────
  // A baseline that never recorded the crew makes no crew claims (the fields
  // arrived after v1 snapshots were already in the wild; absent ≠ "no crew").
  // Identity is the SET of teammate ids — a renamed teammate is not a change a
  // worker acts on; a different set of people, or a different crew, is.
  if (prev.mateIds !== undefined && prev.crewId !== undefined) {
    const was = prev.mateIds.join(',')
    const now = (next.mateIds ?? []).join(',')
    if (was !== now || prev.crewId !== (next.crewId ?? null)) {
      const names = next.mateNames ?? []
      out.push({
        kind: 'crew', jobId: null, label: 'Your crew changed',
        detail: names.length > 0 ? `now with ${names.join(', ')}` : 'working solo today',
      })
    }
  }

  // ── Day-wide writing ───────────────────────────────────────────────────────
  if (prev.crewNote !== next.crewNote) {
    out.push({ kind: 'crew_note', jobId: null, label: 'A note for your crew', detail: 'from the office' })
  }
  if (prev.dayNote !== next.dayNote) {
    out.push({ kind: 'day_note', jobId: null, label: 'A note for today', detail: 'from the office' })
  }

  return out.sort((a, b) => SEVERITY[a.kind] - SEVERITY[b.kind])
}
