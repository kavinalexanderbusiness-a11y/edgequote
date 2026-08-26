// ── THE field-write idempotency engine ───────────────────────────────────────
// One question, asked after every field write whose answer never arrived:
//
//     "Did my write land, or not?"
//
// A phone at the edge of coverage produces a third outcome that neither the
// happy path nor the error path describes: the request reached the server, the
// server committed it, and the RESPONSE died on the way back. The worker sees a
// failure. They tap Retry. Without an answer to the question above, that retry
// starts a SECOND work session, files a SECOND completion, banks the clock
// twice — or, just as bad, reports "this visit changed, refresh" about a change
// the worker themselves had just made a moment earlier.
//
// ⭐⭐ THE ANSWER IS A RE-READ, NOT A RETRY. Before replaying anything we ask the
// server what it holds and compare it to what we asked for. Three verdicts, and
// collapsing any two of them is a bug with a name:
//
//   applied     the server already holds our end state → REPORT SUCCESS. The
//               write landed; only the receipt was lost. Retrying would double it.
//   unapplied   the server still holds the version we started from → the write
//               genuinely never happened, so replaying it is safe.
//   superseded  the server holds something that is neither → somebody else moved
//               this visit. A machine cannot know whether the driveway or the
//               office is right, so a human is told. ⛔ NEVER auto-replay.
//
// ⭐ WHY THIS NEEDS NO NEW COLUMN AND NO MIGRATION.
// Two of the four transitions already carry a CLIENT-MINTED identifier, and it
// is exact: `started_at` and `completed_at` are ISO strings minted on the phone
// (crewStartVisit; lib/jobStatus.completionPatch) at millisecond resolution and
// written verbatim by the RPC. No other actor produces that exact string, so
// finding it on the server is proof OUR write is the one that landed — the same
// guarantee crew_messages.client_token buys for a send, using a value the schema
// already stores. The remaining two transitions are identified by END STATE
// instead (see stop_for_day below), which is weaker in principle and sufficient
// in fact, because their end states are not reachable by any other actor's
// ordinary move.
//
// ⛔ This module is PURE. It performs no I/O, so every verdict above is
// exhaustively testable — and mutation-testable — without a database, a network
// or a browser. That is deliberate: it is the one piece of the offline layer
// whose failure silently duplicates a worker's day.

import type { VisitState } from '@/lib/crewJob'

/** The four transitions a worker can drive. Named for what the WORKER did, not
 *  for the column that moves — 'stop_for_day' and 'complete' both leave
 *  `started_at` null and only intent tells them apart. */
export type VisitIntentKind = 'start' | 'stop_for_day' | 'complete' | 'revert'

export interface VisitIntent {
  kind: VisitIntentKind
  jobId: string
  /** The row version this intent was built against — the optimistic-concurrency
   *  base the RPC checks. Its presence on the server is what proves the write
   *  did NOT land. */
  baseUpdatedAt: string
  /** The COMPLETE four-field end state being asked for. All four every time,
   *  because the RPC writes all four every time (crewJob.VisitState) — a partial
   *  intent could not be compared against a server row. */
  next: VisitState
  /** Minted when the worker tapped, carried verbatim through every retry, and
   *  used only for logs and the human-facing label. ⛔ Never regenerate it on
   *  retry: that is the exact mistake crewMessages.newClientToken warns about. */
  token: string
}

/** What a re-read of the visit tells us. Deliberately the narrow slice this
 *  engine compares — a caller may pass a whole CrewStop; extra fields are
 *  ignored rather than accidentally becoming part of the identity test. */
export interface VisitFacts {
  status: 'scheduled' | 'in_progress' | 'completed' | 'cancelled'
  started_at: string | null
  completed_at: string | null
  updated_at: string
}

export type IntentVerdict =
  /** The server holds our end state. The write landed; report success. */
  | { kind: 'applied' }
  /** The server still holds our base version. Safe to (re)play. */
  | { kind: 'unapplied' }
  /** Someone else moved it. A human decides; never auto-replay. */
  | { kind: 'superseded'; because: string }
  /** The visit is no longer readable by this worker (unassigned, cancelled,
   *  deleted, access revoked). Not retryable, and not the worker's fault. */
  | { kind: 'gone' }

/**
 * ⭐⭐ COMPARE INSTANTS, NEVER STRINGS. This one line is the difference between
 * the engine working and the engine being confidently wrong.
 *
 * The client mints `new Date().toISOString()` → `2026-08-24T05:13:10.745Z`.
 * Postgres stores it in a `timestamptz` and hands it back as
 * `2026-08-24T05:13:10.745+00:00`. Identical instant, DIFFERENT TEXT — so a
 * strict `===` never matches, and every landed write looked like somebody
 * else's edit. In production that meant an ambiguous Start told the worker
 * "somebody already started this visit" about their own tap. (Only the
 * database's `on conflict (job_id, started_at)` index stopped it becoming a
 * duplicate work session; the engine was doing the wrong thing regardless.)
 *
 * ⚠️ Caught ONLY by running against the real database — the unit guard feeds
 * hand-written facts, so both sides were JS-minted there and matched happily.
 * That is the whole reason the authenticated proof exists.
 *
 * Millisecond precision is deliberate and sufficient: the value ORIGINATES as a
 * JS millisecond timestamp, so Postgres's extra microsecond digits are always
 * zero for the values this compares. `Date.parse` truncates to ms on both sides.
 */
function sameStamp(a: string | null, b: string | null): boolean {
  if (a === null || b === null) return a === b     // null is a real state, not "unknown"
  const ta = Date.parse(a), tb = Date.parse(b)
  if (Number.isNaN(ta) || Number.isNaN(tb)) return a === b   // unparseable → fall back to text
  return ta === tb
}

/**
 * Does the server row show OUR intent already applied?
 *
 * Each kind names its own distinguishing evidence. The rule throughout: a field
 * the CLIENT minted is identity (only we could have written that value); a field
 * the SERVER derives is not. `actual_minutes` is therefore never compared — the
 * database recomputes it from banked work sessions
 * ([[work-sessions-multi-day-v1]]), so it legitimately differs from what we sent
 * and testing it would turn every successful write into a false conflict.
 */
function isApplied(intent: VisitIntent, facts: VisitFacts): boolean {
  switch (intent.kind) {
    // Client-minted `started_at` IS the idempotency key. Status must agree, or
    // this is a different event that merely shares a timestamp.
    case 'start':
      return facts.status === 'in_progress'
        && facts.started_at != null
        && sameStamp(facts.started_at, intent.next.started_at)

    // Client-minted `completed_at`, same reasoning. ⚠️ A row that is `completed`
    // with a DIFFERENT stamp is not ours — it is somebody else's completion, and
    // reporting success for it would tell this worker their finish saved when a
    // different one did. That falls through to `superseded`, on purpose.
    case 'complete':
      return facts.status === 'completed'
        && facts.completed_at != null
        && sameStamp(facts.completed_at, intent.next.completed_at)

    // ⭐ No minted stamp exists here — stopping CLEARS the clock rather than
    // setting anything. So the end state itself is the evidence: in_progress
    // with no clock running is precisely "started earlier, stopped for today"
    // ([[work-sessions-multi-day-v1]]: `in_progress` + `started_at NULL` = the
    // stopped-for-day shape). Reachable no other way — the office pausing a
    // visit produces the same row, and treating that as our write is harmless
    // because the end state the worker asked for is the end state that holds.
    case 'stop_for_day':
      return facts.status === 'in_progress' && facts.started_at == null

    // Undo restores a remembered state, so compare the whole lifecycle shape.
    // Undo restores a remembered state, so compare the whole lifecycle shape —
    // instants, not text, for the same reason as above.
    case 'revert':
      return facts.status === intent.next.status
        && sameStamp(facts.started_at, intent.next.started_at)
        && sameStamp(facts.completed_at, intent.next.completed_at)
  }
}

/**
 * THE verdict. Order matters and is not arbitrary:
 *
 *  1. gone       — nothing else can be decided about a row we cannot see.
 *  2. cancelled  — the office pulled the visit. crew_set_visit_status refuses to
 *                  touch it, so replaying is guaranteed to fail forever; that is
 *                  a poison op, and it must leave the queue with a human told.
 *  3. applied    — checked BEFORE the base-version test, because both can be
 *                  true at once in the one case that matters most: a retry whose
 *                  first attempt landed. Test order is the difference between
 *                  "already done" and "do it twice".
 *  4. unapplied  — the base version still stands, so nothing has happened yet.
 *  5. superseded — everything else, with the reason in words a person can act on.
 */
export function reconcileVisitIntent(intent: VisitIntent, facts: VisitFacts | null): IntentVerdict {
  if (!facts) return { kind: 'gone' }

  if (facts.status === 'cancelled') {
    return { kind: 'superseded', because: 'the office cancelled this visit' }
  }

  if (isApplied(intent, facts)) return { kind: 'applied' }

  // The base version still standing proves no write has landed — ours or anyone
  // else's. ⚠️ This MUST come after the applied test: a successful write advances
  // updated_at, so a landed-but-unacknowledged write fails this check, and an
  // engine that asked it first would replay every ambiguous write exactly once
  // more. That is the duplicate-work-session bug, in one line of ordering.
  if (facts.updated_at === intent.baseUpdatedAt) return { kind: 'unapplied' }

  return { kind: 'superseded', because: describeSupersede(intent, facts) }
}

/** Why a human is being interrupted, in the words the visit's own state gives
 *  us. Generic "it changed" tells a worker nothing they can act on. */
function describeSupersede(intent: VisitIntent, facts: VisitFacts): string {
  if (intent.kind !== 'complete' && facts.status === 'completed') {
    return 'this visit was already finished'
  }
  if (intent.kind === 'start' && facts.started_at != null) {
    return 'somebody already started this visit'
  }
  if (intent.kind === 'complete' && facts.status === 'completed') {
    return 'somebody else finished this visit'
  }
  if (intent.kind === 'stop_for_day' && facts.started_at != null) {
    return 'this visit was started again'
  }
  return 'the office changed this visit'
}

// ── Building an intent ───────────────────────────────────────────────────────
// Constructed at the moment of the TAP and then frozen. Everything that makes a
// retry safe depends on this: mint the timestamps and the token once, reuse them
// for every attempt, forever. A builder that ran again on retry would produce a
// fresh `started_at`, the server comparison would find nothing matching, and the
// engine above would confidently report `unapplied` for a write that had already
// landed — reintroducing the precise duplicate this file exists to prevent.
// (crewMessages.newClientToken carries the same warning for the same reason.)

export function newIntentToken(): string {
  return typeof crypto !== 'undefined' && crypto.randomUUID
    ? crypto.randomUUID()
    : `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`
}

/** Freeze an intent so a later mutation cannot rewrite the identity a queued
 *  retry depends on. Cheap, and it turns a whole class of "why did it duplicate"
 *  into a TypeError at the call site. */
export function freezeIntent(intent: VisitIntent): VisitIntent {
  return Object.freeze({ ...intent, next: Object.freeze({ ...intent.next }) })
}

/** The human label for an intent — used by the queue's own reporting, so a
 *  dropped or conflicted op can name the work in the worker's words. */
export function intentLabel(kind: VisitIntentKind, title: string): string {
  const what = kind === 'start' ? 'Start'
    : kind === 'stop_for_day' ? 'Done for today on'
    : kind === 'complete' ? 'Finish'
    : 'Undo on'
  return `${what} ${title || 'a visit'}`
}
