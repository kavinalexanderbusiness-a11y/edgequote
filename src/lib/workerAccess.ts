// ── Worker access: ONE server-side answer to "may this worker touch this?" ───
//
// THE PROBLEM THIS SOLVES. Session 65 made a visit assignable two ways —
// `jobs.crew_id` (a whole crew) XOR `jobs.technician_id` (one named person) —
// and taught the database ONE predicate for it, `crew_assignment_covers`, which
// every crew RPC now calls. The server routes did not follow. Four of them
// (`/api/crew/complete`, `/api/crew/media`, `/api/crew/photos`) still asked the
// PRE-S65 question — `.eq('crew_id', tech.crew_id)`, after refusing outright any
// worker whose `crew_id` was null — and three database functions written for
// job forms (`crew_job_forms`, `crew_save_form_response`, `ensure_job_forms`)
// did the same. So the person S65 exists to support — somebody assigned BY NAME
// — could see the stop on their board (the RPCs knew) and then could not
// complete it, could not open its instructions, could not upload proof and could
// not answer its checklist (the routes did not). Two models, one product.
//
// The fix is not a fifth copy of the check. It is this module: the predicate,
// the identity, and the refusal vocabulary, written ONCE on the server, in the
// same shape the database enforces — so that a door either calls this or is
// visibly not a worker door.
//
// ⭐ WHAT THIS MODULE IS NOT. It is not a permission matrix, a role table, or a
// feature-flag surface. There are no toggles here and none are coming. A worker
// gets exactly what performing assigned work requires; everything else is the
// owner's, and the way a worker is refused the rest is that no door exists —
// not that a switch is off.
//
// ⛔ THIS DOES NOT REPLACE THE DATABASE'S CHECKS, and must never be read as
// permission to relax them. `crew_assignment_covers` still runs inside every
// DEFINER RPC, RLS still scopes every table to its owner, and the storage bucket
// is still owner-keyed. This module is the SERVER's copy of the same question,
// needed because a route holding the service role runs past all of that. Defence
// in depth means both, agreeing — never one trusting the other.
//
// ⛔ AND IT IS NOT A CLIENT-SIDE CHECK. Nothing here may be imported into a
// component to hide a button. Hidden buttons are not security; this module is
// the thing that makes hiding them merely polite.
//
// Related: lib/crewAssignment (the owner-side vocabulary for the same columns),
// lib/crewAccess (which HALF of the app a session belongs in — routing, not
// authorisation), lib/noteScope (which audience a written field is for).

import type { SupabaseClient } from '@supabase/supabase-js'

// ── The verified worker ──────────────────────────────────────────────────────
// Everything downstream derives from this row and NOTHING from the request. The
// employer id in particular is read HERE, off the roster row the session's own
// uid resolves to, so a body that names an `employer_id`, a `user_id` or a
// `technician_id` is naming a field this code never reads.

export interface WorkerIdentity {
  /** `technicians.id` — the roster row. The subject of every grant. */
  technicianId: string
  /** `technicians.user_id` — the OWNER whose business this worker works for.
   *  The tenant predicate for every query made on this worker's behalf. */
  employerId: string
  /** `technicians.crew_id` — the worker's crew, or null. ⭐ NULL IS LEGAL: a
   *  worker can be assigned by name without belonging to any crew, and refusing
   *  those workers at the door was the exact pre-S66 defect. */
  crewId: string | null
}

/** Why a worker was refused. One closed set, so every door refuses in the same
 *  words and no door has to invent a sentence — or leak a database one. */
export type WorkerDenial =
  /** No session at all. */
  | 'signed-out'
  /** Signed in, but not an active worker: an owner, somebody never invited, or
   *  somebody switched off. ⭐ DELIBERATELY ONE ANSWER — telling a caller which
   *  of those they are tells a stranger whether an account exists. The honest,
   *  specific version of this question is `/api/crew/access-status`, which
   *  answers about the CALLER'S OWN standing and nobody else's. */
  | 'not-a-worker'
  /** The visit is not this worker's to touch — unassigned, another crew's,
   *  another person's, another tenant's, or not a visit at all. ⭐ ALSO ONE
   *  ANSWER, and it must stay one: distinguishing "exists but not yours" from
   *  "does not exist" turns any id field into an existence oracle. */
  | 'not-assigned'
  /** A read failed. ⭐ FAILS CLOSED — "couldn't check" is never "checked out
   *  fine". This is the answer that keeps a dead database from opening doors. */
  | 'lookup-failed'
  /** The server cannot answer right now (no service role configured). */
  | 'unavailable'

/** HTTP status per refusal. 404 for `not-assigned` on purpose: a worker probing
 *  ids must not be able to tell a real visit from a fictional one. */
export const WORKER_DENIAL_STATUS: Record<WorkerDenial, number> = {
  'signed-out': 401,
  'not-a-worker': 403,
  'not-assigned': 404,
  'lookup-failed': 502,
  unavailable: 503,
}

/** What the worker READS. Plain, final, and free of database vocabulary — no
 *  table names, no column names, no ids, no error text from Postgres. A person
 *  holding a phone in somebody's garden gets a sentence, and where there is
 *  something they can do about it, that too. */
export const WORKER_DENIAL_MESSAGE: Record<WorkerDenial, string> = {
  'signed-out': 'Sign in to see your work.',
  'not-a-worker': 'You don’t have access to this.',
  'not-assigned': 'Not available — this isn’t one of your visits.',
  'lookup-failed': 'Couldn’t check that just now — try again.',
  unavailable: 'This isn’t available right now.',
}

export type WorkerResolution =
  | { ok: true; worker: WorkerIdentity }
  | { ok: false; denial: WorkerDenial }

/** The visit a worker proved they may act on. Deliberately NOT the whole row:
 *  callers that need columns re-read them with the employer id below, so that
 *  what a door projects stays that door's explicit decision (the rule
 *  lib/noteScope names — the audience is the column, and the column list is the
 *  door's). What travels here is identity and assignment, nothing else. */
export interface AuthorizedVisit {
  jobId: string
  employerId: string
  crewId: string | null
  technicianId: string | null
}

export type VisitAuthorization =
  | { ok: true; worker: WorkerIdentity; visit: AuthorizedVisit }
  | { ok: false; denial: WorkerDenial }

// ── The predicate ────────────────────────────────────────────────────────────

/** Shape-check an id before it reaches the database, so a malformed value is a
 *  refusal rather than a 500 from a failed cast. */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export function isUuid(value: unknown): value is string {
  return typeof value === 'string' && UUID.test(value)
}

/**
 * ⭐⭐ THE ONE PREDICATE — the exact mirror of SQL `crew_assignment_covers`:
 *
 *     select coalesce(j_crew = v_crew, false)
 *         or coalesce(j_technician = v_tech, false)
 *
 * A visit is covered when it is assigned to the worker's crew, OR to the worker
 * by name. Both halves are `coalesce`d to false so that NULL — a crewless
 * worker, an unassigned visit — is a plain NO and never a null that some caller
 * negates into a yes.
 *
 * ⚠️ TWO NULLS MUST NOT MATCH. An unassigned visit (`crew_id` null) and a
 * crewless worker (`crewId` null) would compare equal under a naive `===`, which
 * would hand every unassigned visit in the tenant to every crewless worker. The
 * explicit null guards below are the whole reason this is a function and not an
 * inline expression, and `verify:worker-access` attacks exactly that case.
 */
export function workerCoversVisit(
  worker: Pick<WorkerIdentity, 'technicianId' | 'crewId'>,
  visit: Pick<AuthorizedVisit, 'crewId' | 'technicianId'>,
): boolean {
  const byCrew = visit.crewId != null && worker.crewId != null && visit.crewId === worker.crewId
  const byName = visit.technicianId != null && visit.technicianId === worker.technicianId
  return byCrew || byName
}

/**
 * ⭐ The SAME predicate, spelled for PostgREST, for the doors that must filter
 * MANY visits at once (a day's stops) rather than authorise one by id. Combine
 * it with `.eq('user_id', worker.employerId)` — the tenant predicate is separate
 * and stays separate, so widening one can never silently widen the other:
 *
 *     .eq('user_id', worker.employerId).or(assignedVisitFilter(worker))
 *
 * ⚠️⚠️ WHEN THE WORKER HAS NO CREW, THE CREW CLAUSE IS OMITTED ENTIRELY — it is
 * never written as `crew_id.is.null`. That spelling would match every UNASSIGNED
 * visit in the tenant and hand the lot to any crewless worker. The omission is
 * the whole point, and `verify:worker-access` attacks precisely this.
 */
export function assignedVisitFilter(
  worker: Pick<WorkerIdentity, 'technicianId' | 'crewId'>,
): string {
  const clauses: string[] = []
  if (worker.crewId != null) clauses.push(`crew_id.eq.${worker.crewId}`)
  clauses.push(`technician_id.eq.${worker.technicianId}`)
  return clauses.join(',')
}

// ── The identity ─────────────────────────────────────────────────────────────

/**
 * Resolve the signed-in account to an ACTIVE worker, with the same predicate
 * `crew_technician_id()` enforces in SQL: linked by `auth_user_id`, `is_active`,
 * and not archived.
 *
 * ⭐⭐ THE DISABLE IS ENFORCED HERE, NOT AT SIGN-IN. A worker switched off
 * mid-shift fails this call on their very next action, unexpired JWT and all,
 * because the roster switches ARE the access control and they are read every
 * time. Nothing is cached, so there is no window in which "already signed in"
 * means "still allowed".
 *
 * ⭐ And disabling is not deletion: this refuses the LIVE call while every row
 * the worker already wrote — work sessions, photos, messages, completions —
 * keeps their `technician_id` and stays attributable. Revoking access and
 * erasing history are different operations, and only one of them is this one.
 *
 * @param admin a service-role client — REQUIRED, because a crew session holds no
 *              table grants and so cannot read its own roster row.
 */
export async function resolveWorker(
  admin: SupabaseClient | null,
  authUserId: string | null | undefined,
): Promise<WorkerResolution> {
  if (!authUserId) return { ok: false, denial: 'signed-out' }
  if (!admin) return { ok: false, denial: 'unavailable' }

  const { data, error } = await admin
    .from('technicians')
    .select('id, user_id, crew_id')
    .eq('auth_user_id', authUserId)
    .eq('is_active', true)
    .is('archived_at', null)
    .maybeSingle()

  // A failed read is not an absent worker. Say so, and refuse.
  if (error) return { ok: false, denial: 'lookup-failed' }
  const row = data as { id: string; user_id: string; crew_id: string | null } | null
  if (!row) return { ok: false, denial: 'not-a-worker' }

  return {
    ok: true,
    worker: { technicianId: row.id, employerId: row.user_id, crewId: row.crew_id },
  }
}

// ── The door ─────────────────────────────────────────────────────────────────

/**
 * ⭐⭐ THE ONE DOOR every worker-reachable route goes through before it touches
 * a visit. It answers, in this order and with no way to skip a step:
 *
 *   1. Is there a session?                                        signed-out
 *   2. Is it an ACTIVE worker, per the roster switches?           not-a-worker
 *   3. Is the id even an id?                                      not-assigned
 *   4. Does a visit with that id exist IN THIS WORKER'S TENANT?   not-assigned
 *   5. Does the assignment cover this worker?                     not-assigned
 *
 * Steps 4 and 5 are what make a forged `job_id` useless: the tenant predicate
 * comes from the roster row (never the request), and the assignment predicate is
 * the same one the database applies. An id copied from another business fails at
 * 4; an id copied from a colleague's board fails at 5; both fail with the SAME
 * refusal, so neither can be used to learn that the other row exists.
 *
 * ⚠️ The caller may still name an id — that is unavoidable, a worker has to be
 * able to say WHICH visit. What matters is that naming it proves nothing: every
 * fact used to authorise the call is re-derived here from the session.
 */
export async function authorizeWorkerVisit(
  admin: SupabaseClient | null,
  authUserId: string | null | undefined,
  jobId: unknown,
): Promise<VisitAuthorization> {
  const resolved = await resolveWorker(admin, authUserId)
  if (!resolved.ok) return resolved
  const { worker } = resolved

  if (!isUuid(jobId)) return { ok: false, denial: 'not-assigned' }

  const { data, error } = await admin!
    .from('jobs')
    .select('id, user_id, crew_id, technician_id')
    .eq('id', jobId)
    // The tenant predicate. From the roster row, never from the request.
    .eq('user_id', worker.employerId)
    .maybeSingle()

  if (error) return { ok: false, denial: 'lookup-failed' }
  const row = data as
    | { id: string; user_id: string; crew_id: string | null; technician_id: string | null }
    | null
  if (!row) return { ok: false, denial: 'not-assigned' }

  const visit: AuthorizedVisit = {
    jobId: row.id,
    employerId: row.user_id,
    crewId: row.crew_id,
    technicianId: row.technician_id,
  }
  if (!workerCoversVisit(worker, visit)) return { ok: false, denial: 'not-assigned' }

  return { ok: true, worker, visit }
}

// ── What a worker may write ──────────────────────────────────────────────────

/**
 * The visit states a worker may set, mirroring the allowlist inside
 * `crew_set_visit_status`. ⭐ `cancelled` is absent ON PURPOSE and is not an
 * oversight to be tidied up later: calling off a customer's booked work is a
 * business decision with money attached. A worker who cannot finish leaves the
 * visit open and tells the office; the office cancels.
 *
 * ⭐ Every other job column is refused by the `crew_job_field_guard` trigger,
 * which compares the whole row and raises unless only status and its timestamps
 * moved. That is what stops a worker re-pricing a visit, moving it to another
 * date, re-pointing it at another customer, or — the escalation that matters —
 * writing `crew_id`/`technician_id` to assign themselves more work.
 */
export const WORKER_VISIT_STATUSES = ['scheduled', 'in_progress', 'completed'] as const
export type WorkerVisitStatus = (typeof WORKER_VISIT_STATUSES)[number]

export function isWorkerVisitStatus(value: unknown): value is WorkerVisitStatus {
  return typeof value === 'string' && (WORKER_VISIT_STATUSES as readonly string[]).includes(value)
}

/**
 * The transitions a worker may make, as a graph rather than a set of endpoints.
 *
 *   scheduled   → in_progress          starting the stop
 *   in_progress → completed            finishing it
 *   in_progress → scheduled            stopping for today, and the undo of start
 *   completed   → in_progress          undo of a mis-tap, while still on site
 *
 * ⭐ `in_progress → scheduled` is the multi-day "done for today" case, and it is
 * the same edge as undo — the work-sessions engine, not this status, is what
 * records that the day happened ([[work-sessions-multi-day-v1]]: a stopped-for-
 * the-day visit is `in_progress` with a null `started_at`, and `actual_minutes`
 * is a DB-enforced sum). So the graph deliberately does not try to distinguish
 * them; inventing a fourth state here would put a second answer next to that
 * engine's.
 *
 * ⚠️ This is the transition rule the PRODUCT states. The database's allowlist is
 * the enforcement, and `verify:worker-access` pins the two together so this can
 * never drift into a more generous claim than the RPC will honour.
 */
export const WORKER_VISIT_TRANSITIONS: Record<WorkerVisitStatus, readonly WorkerVisitStatus[]> = {
  scheduled: ['in_progress'],
  in_progress: ['completed', 'scheduled'],
  completed: ['in_progress'],
}

/** Whether a worker may move a visit from `from` to `to`. A status the office
 *  owns (`cancelled`, and anything else the schema grows later) is not in the
 *  graph at all, so it is refused as an origin AND as a destination. */
export function workerMayTransition(from: unknown, to: unknown): boolean {
  if (!isWorkerVisitStatus(from) || !isWorkerVisitStatus(to)) return false
  return WORKER_VISIT_TRANSITIONS[from].includes(to)
}
