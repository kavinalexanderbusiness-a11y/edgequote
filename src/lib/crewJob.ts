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

/** ▶ Check in, or pick the clock back up on a job stopped earlier. Both are the
 *  same write and the same sentence to a worker — "start working on this" — so
 *  they are one function. The guard is on the CLOCK, not the status: a visit
 *  with `started_at` set already has somebody on it. A visit that is
 *  `in_progress` with no clock is one that was stopped for the day, and
 *  refusing to start it (which the old `status !== 'scheduled'` check did) would
 *  strand a multi-day job on the crew's phone with no way to work it again.
 *
 *  Minutes already banked are passed straight back untouched. */
export async function crewStartVisit(supabase: SupabaseClient, stop: CrewStop): Promise<CrewWriteResult> {
  if (stop.started_at) return { ok: false, error: 'That visit is already underway.' }
  if (stop.status === 'completed') return { ok: false, error: 'That visit is already finished.' }
  return write(supabase, stop, {
    status: 'in_progress',
    started_at: new Date().toISOString(),
    completed_at: null,
    actual_minutes: stop.actual_minutes,
  }, 'start it')
}

/** ⏸ Stop for today — the day ends, the visit does not.
 *
 *  ⛔ NOT a completion, and this is the whole reason it exists on the crew's
 *  phone. Completing runs the invoice handoff and can text the customer that the
 *  work is done; a worker who is coming back tomorrow must have a way out of the
 *  day that does neither. It writes the same four lifecycle fields through the
 *  same RPC — status stays `in_progress`, the clock clears — and the DATABASE
 *  banks the time worked as a dated work session, so a day stopped from a phone
 *  and a day stopped from the office produce the identical record.
 *
 *  The visit's DATE is deliberately not changed here: which day the crew comes
 *  back is the office's call, and `crew_set_visit_status` cannot write
 *  scheduled_date anyway (the crew field guard refuses it). */
export async function crewStopForToday(supabase: SupabaseClient, stop: CrewStop): Promise<CrewWriteResult> {
  if (stop.status === 'completed') return { ok: false, error: 'That visit is already finished.' }
  if (!stop.started_at) return { ok: false, error: 'That visit isn’t started.' }
  return write(supabase, stop, {
    status: 'in_progress',
    started_at: null,
    completed_at: null,
    // Passed back as held. The database recomputes the total from the sessions
    // once this clock is banked — the phone never has to work it out.
    actual_minutes: stop.actual_minutes,
  }, 'stop for today')
}

/** ✓ Check out — through /api/crew/complete, NOT the bare RPC, because on every
 *  owner door completing is status + the draft-invoice handoff, and the billing
 *  outcome of finished work must not depend on who pressed the button. The
 *  route runs the SAME RPC for the status (assignment + version re-checked
 *  server-side) and then the SAME invoice engine with the owner's authority.
 *  The stamp is still completionPatch — one definition of "done", every door.
 *  Online-only like every crew write: a dead zone fails visibly, never queues. */
export async function crewCompleteVisit(supabase: SupabaseClient, stop: CrewStop): Promise<CrewWriteResult> {
  if (stop.status === 'completed') return { ok: false, error: 'That visit is already finished.' }
  const stamp = completionPatch(stop)
  try {
    const res = await fetch('/api/crew/complete', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jobId: stop.id, action: 'complete', baseUpdatedAt: stop.updated_at,
        next: {
          status: stamp.status,
          started_at: stop.started_at,      // the check-in stands; only the finish is new
          completed_at: stamp.completed_at,
          actual_minutes: stamp.actual_minutes,
        },
      }),
    })
    const d = await res.json().catch(() => ({}))
    if (res.status === 409) return { ok: false, error: 'Couldn’t finish it — this visit changed. Refresh and try again.' }
    if (!res.ok || !d.ok) return { ok: false, error: d.error || 'That didn’t save. Try again.' }
    return { ok: true, nextUpdatedAt: d.updatedAt }
  } catch {
    return { ok: false, error: 'That didn’t save — check your signal and try again.' }
  }
}

/** Undo a COMPLETION. Not the plain revert below: completing drafted an
 *  invoice, so un-completing must remove that draft too — and only the server
 *  may touch invoices. The route deletes the draft FIRST, then reverts the
 *  status through the same RPC; a sent/paid invoice is left alone and the
 *  OWNER is notified (money owing on un-done work is their call). */
export async function crewUncompleteVisit(
  supabase: SupabaseClient, stop: CrewStop, prev: VisitState,
): Promise<CrewWriteResult> {
  try {
    const res = await fetch('/api/crew/complete', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jobId: stop.id, action: 'undo', baseUpdatedAt: stop.updated_at, prev }),
    })
    const d = await res.json().catch(() => ({}))
    if (!res.ok || !d.ok) return { ok: false, error: d.error || 'Couldn’t undo that.' }
    return { ok: true }
  } catch {
    return { ok: false, error: 'Couldn’t undo that — check your signal and try again.' }
  }
}

/** Record what was done (customer-visible) and what needs attention (internal)
 *  on an assigned visit — the crew half of lib/completion.
 *
 *  ⛔ NOT a completion, and never a substitute for one. This writes exactly two
 *  text columns; status, completed_at, actual_minutes and the invoice are the
 *  business of crewCompleteVisit above. A visit can therefore carry a note
 *  before it is finished, and adding a photo caption to a visit finished last
 *  Tuesday cannot re-bill it.
 *
 *  Through the typed DEFINER RPC, not a table write, for the founding crew-mode
 *  reason: a crew session holds no table grants at all, and a jsonb patch would
 *  be a hole a client could stuff `price` into. The RPC re-checks employer +
 *  crew + not-cancelled itself.
 *
 *  Online-only like every crew write, and it REPORTS ITS WRITE: a note that
 *  silently didn't save is the same lie as a status that didn't. */
export async function crewSaveCompletionRecord(
  supabase: SupabaseClient,
  jobId: string,
  record: { completion_summary: string | null; completion_issue: string | null },
): Promise<CrewWriteResult> {
  try {
    const { data, error } = await supabase.rpc('crew_set_completion_record', {
      p_job_id: jobId,
      p_summary: record.completion_summary,
      p_issue: record.completion_issue,
    })
    if (error) return { ok: false, error: 'That didn’t save — check your signal and try again.' }
    const res = data as { ok?: boolean; reason?: string } | null
    if (!res?.ok) {
      return { ok: false, error: 'Couldn’t save that — this visit is no longer on your board. Refresh and try again.' }
    }
    return { ok: true }
  } catch {
    return { ok: false, error: 'That didn’t save — check your signal and try again.' }
  }
}

/** Undo, for the mis-tap: put the four fields back exactly as they were. */
export async function crewRevertVisit(
  supabase: SupabaseClient, stop: CrewStop, prev: VisitState,
): Promise<CrewWriteResult> {
  return write(supabase, stop, prev, 'undo that')
}
