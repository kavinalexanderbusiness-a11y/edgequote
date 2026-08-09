// ── Crew Mode writes ─────────────────────────────────────────────────────────
// A worker moves a visit through exactly two transitions — ▶ start and ✓ complete
// — and both write the SAME canonical `jobs` row the owner's board writes, with
// the SAME stamp (lib/jobStatus.completionPatch). There is no crew copy of the
// job model, no shadow status table, and no second definition of what "done"
// means. That was the requirement: one set of records, two audiences.
//
// The write goes through `crew_set_visit_status`, a SECURITY DEFINER RPC, rather
// than a direct table update — for one reason. A crew session has NO direct
// table grants at all, because RLS is ROW-level: any policy that let a worker
// PATCH `jobs` would also let them read every COLUMN of those rows, `price`
// included, and a column GRANT can't help (it is role-wide, so restricting
// `authenticated` would restrict the owner too). The RPC takes the stamp as
// TYPED PARAMETERS — never a blob a client could stuff extra columns into —
// re-checks the assignment, and enforces the same optimistic version guard the
// owner's queued patches use.
//
// The VALUES still come from the shared engine. `completionPatch` computes them
// here, in TypeScript, exactly as the schedule page and the dispatch board do;
// the RPC only applies them. So a visit finished by a worker carries the same
// completed_at and the same ACCUMULATED actual_minutes (including time banked by
// an earlier day's session) as one finished by the owner.
//
// What is deliberately NOT here, and why:
//   • the draft invoice and the job-complete text. Completing on the OWNER's
//     board runs `completeVisit` — patch + invoice + customer message — because
//     an owner may touch invoices. A crew session may not, and that is the
//     correct boundary rather than an oversight.
//     ⚠️ CONSEQUENCE, stated plainly: a visit completed by a worker is NOT
//     invoiced by that act. The owner still bills it. Closing that loop (an
//     owner-side sweep over completed-and-uninvoiced visits, or a server route
//     holding the owner's privileges) is the first follow-up this foundation
//     needs — see the session report.
//   • the offline outbox. Crew writes are online-only in V1 and say so out loud
//     when they fail; queueing them means registering the replay handlers in the
//     crew shell, which is real work and belongs with the offline pass.
//
// Every function here REPORTS ITS WRITE. A status that silently didn't save is
// the worst outcome in the field: the worker drives away certain it is done.

import type { SupabaseClient } from '@supabase/supabase-js'
import { completionPatch } from '@/lib/jobStatus'
import type { CrewStop } from '@/lib/crewAccess'

export interface CrewWriteResult {
  ok: boolean
  error?: string
  /** The row version AFTER the write, so an immediate undo carries a live guard
   *  instead of the version it just replaced (which would match nothing). */
  nextUpdatedAt?: string
}

/** The complete intended state of the four lifecycle fields. The RPC writes all
 *  four every time, so the caller states them all — that is what stops a start
 *  from quietly clearing minutes banked by an earlier day's session. */
export interface VisitState {
  status: 'scheduled' | 'in_progress' | 'completed'
  started_at: string | null
  completed_at: string | null
  actual_minutes: number | null
}

async function write(
  supabase: SupabaseClient, stop: CrewStop, next: VisitState, what: string,
): Promise<CrewWriteResult> {
  const { data, error } = await supabase.rpc('crew_set_visit_status', {
    p_job_id: stop.id,
    p_status: next.status,
    p_base_updated_at: stop.updated_at,
    p_started_at: next.started_at,
    p_completed_at: next.completed_at,
    p_actual_minutes: next.actual_minutes,
  })
  if (error) return { ok: false, error: error.message }
  const res = data as { ok?: boolean; reason?: string; updated_at?: string } | null
  if (!res?.ok) {
    // 'stale' covers both real cases: the office moved the visit while the phone
    // held an old copy, OR this worker is no longer assigned to it. Both mean
    // "look again" — and neither may be reported as success.
    return { ok: false, error: `Couldn’t ${what} — this visit changed. Refresh and try again.` }
  }
  return { ok: true, nextUpdatedAt: res.updated_at }
}

/** ▶ Check in. Keeps any minutes already banked on the visit. */
export async function crewStartVisit(supabase: SupabaseClient, stop: CrewStop): Promise<CrewWriteResult> {
  if (stop.status !== 'scheduled') return { ok: false, error: 'That visit is already underway.' }
  return write(supabase, stop, {
    status: 'in_progress',
    started_at: new Date().toISOString(),
    completed_at: null,
    actual_minutes: stop.actual_minutes,
  }, 'start it')
}

/** ✓ Check out, through the shared stamp. */
export async function crewCompleteVisit(supabase: SupabaseClient, stop: CrewStop): Promise<CrewWriteResult> {
  if (stop.status === 'completed') return { ok: false, error: 'That visit is already finished.' }
  const stamp = completionPatch(stop)
  return write(supabase, stop, {
    status: stamp.status,
    started_at: stop.started_at,          // the check-in stands; only the finish is new
    completed_at: stamp.completed_at,
    actual_minutes: stamp.actual_minutes,
  }, 'finish it')
}

/** Undo, for the mis-tap: put the four fields back exactly as they were. */
export async function crewRevertVisit(
  supabase: SupabaseClient, stop: CrewStop, prev: VisitState,
): Promise<CrewWriteResult> {
  return write(supabase, stop, prev, 'undo that')
}
