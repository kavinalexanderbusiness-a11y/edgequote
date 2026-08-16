// ── Field replay handlers ────────────────────────────────────────────────────
// How a queued crew write performs itself when the signal comes back.
//
// ⭐ ONE QUEUE FOR THE APP. These register on lib/offline/outbox — the same
// engine the owner's dashboard uses — rather than standing up a crew queue
// beside it. That engine already owns the hard parts and has paid for them:
// strict FIFO with per-entity blocking (so Start can never replay after the Undo
// that cancelled it), a durable IndexedDB commit, cross-tab Web Locks, network
// failures that cost no attempt, and a poison-drop that TELLS the person. A
// second queue would have to re-earn all of it, and the two would race on the
// same rows. (ONE ENGINE PER RESPONSIBILITY — the standing rule.)
//
// ⭐⭐ EVERY HANDLER RECONCILES BEFORE IT WRITES. Replay runs at reconnect, which
// is exactly when the previous attempt is most likely to have half-happened: the
// server committed, the response died. So no handler here retries blind. Each
// one re-reads the visit, asks lib/field/visitIntent what actually holds, and
// only then decides — and the verdict, not the HTTP status, is what the worker
// is told. That is what makes "Retry" safe to press.
//
// ⛔ Handlers do not invent mutations. Each calls the SAME function the online
// path calls (the crew RPC, /api/crew/complete, crew_post_message), so a visit
// finished from the queue and one finished with four bars are the same write.

import { createClient } from '@/lib/supabase/client'
import { loadCrewDay } from '@/lib/crewAccess'
import { crewStartVisit, crewStopForToday, crewCompleteVisit, crewRevertVisit, crewSaveCompletionRecord } from '@/lib/crewJob'
import { postCrewMessage } from '@/lib/crewMessages'
import { registerHandler, ConflictError } from '@/lib/offline/outbox'
import { reconcileVisitIntent, type VisitIntent, type VisitFacts } from './visitIntent'
import type { CrewStop } from '@/lib/crewAccess'

let registered = false

/** The queue kinds this module owns. Exported so the guard can prove every
 *  queueable write in lib/field/writeClass has somewhere to land — a classified
 *  write with no handler would sit in the queue forever, which reads to a worker
 *  as "it saved" and is the quietest possible loss. */
export const FIELD_OUTBOX_KINDS = ['field.visit', 'field.record', 'field.message'] as const

export interface VisitOpPayload {
  /** ⭐ MUST be the job id: lib/offline/outbox.entityKey reads `payload.id` to
   *  order and block per record. Named `id` rather than `jobId` for that reason
   *  — a rename here silently turns FIFO-per-visit back into global ordering. */
  id: string
  /** Which day's board to re-read when reconciling. */
  date: string
  intent: VisitIntent
  /** The stop as the phone last knew it, so a replay can rebuild the exact call
   *  the online path would have made. */
  stop: CrewStop
}

/** The narrow slice the reconciliation engine compares, taken from a live board
 *  read. Returns null when the visit is not on the worker's board at all — which
 *  the engine reads as `gone`. */
async function readVisitFacts(
  supabase: ReturnType<typeof createClient>, date: string, jobId: string,
): Promise<{ facts: VisitFacts | null; reachable: boolean }> {
  const res = await loadCrewDay(supabase, date)
  // ⚠️ THREE OUTCOMES, kept apart (crewAccess's rule). A read that FAILED must
  // not be reported as "the visit is gone" — that would drop a queued completion
  // and tell the worker their finished job vanished, when in fact we simply
  // could not ask. `reachable: false` makes the caller throw a retryable error
  // instead, leaving the op safely queued.
  if (res.kind === 'error') return { facts: null, reachable: false }
  if (res.kind === 'revoked') return { facts: null, reachable: true }
  const stop = res.day.stops.find(s => s.id === jobId)
  if (!stop) return { facts: null, reachable: true }
  return {
    facts: {
      status: stop.status,
      started_at: stop.started_at,
      completed_at: stop.completed_at,
      updated_at: stop.updated_at,
    },
    reachable: true,
  }
}

/** A verdict of `superseded`/`gone` is terminal — replaying can only overwrite
 *  somebody's newer decision. Raised as the outbox's own ConflictError so it
 *  takes the established path: the op leaves the queue and the human is told
 *  exactly what did not apply, in their own words. */
function conflict(intent: VisitIntent, because: string, kind: 'changed' | 'gone'): ConflictError {
  return new ConflictError(because, { action: intent.kind.replace(/_/g, ' '), visit: intent.jobId }, kind)
}

export function registerFieldHandlers(): void {
  if (registered) return
  registered = true

  // ── The visit lifecycle: start · done for today · finish · undo ────────────
  // ⭐⭐ THE AMBIGUOUS-RESPONSE CASE, which is the whole reason this handler is
  // shaped like this. Tap Start, the server commits, the response dies in a dead
  // zone. The op is still queued. On reconnect a blind replay would send the same
  // RPC with the same base version — the version guard would reject it, and the
  // worker would be told "this visit changed, refresh and try again" about a
  // change they made themselves thirty seconds earlier. Worse, on the paths
  // where the guard cannot see it, a second work session would open.
  //
  // Reconciling first turns that into the truth: the server already holds our
  // client-minted `started_at`, so the verdict is `applied`, the op is removed,
  // and nothing is written twice.
  registerHandler('field.visit', async (payload) => {
    const p = payload as VisitOpPayload
    const supabase = createClient()
    const { facts, reachable } = await readVisitFacts(supabase, p.date, p.id)

    // Couldn't ask → not an answer. Stay queued; the outbox charges no attempt
    // for a network failure, so this waits as long as it needs to.
    if (!reachable) throw new Error('field.visit: could not re-read the visit')

    const verdict = reconcileVisitIntent(p.intent, facts)
    if (verdict.kind === 'applied') return              // it landed; the receipt was lost
    if (verdict.kind === 'gone') {
      throw conflict(p.intent, 'that visit is no longer on your board', 'gone')
    }
    if (verdict.kind === 'superseded') {
      throw conflict(p.intent, verdict.because, 'changed')
    }

    // `unapplied` — the server still holds the version we started from, so the
    // write genuinely never happened. Replay it through the SAME function the
    // online path uses, against the stop as it actually stands.
    const stop: CrewStop = { ...p.stop, updated_at: facts!.updated_at }
    const res = p.intent.kind === 'start' ? await crewStartVisit(supabase, stop)
      : p.intent.kind === 'stop_for_day' ? await crewStopForToday(supabase, stop)
      : p.intent.kind === 'complete' ? await crewCompleteVisit(supabase, stop)
      : await crewRevertVisit(supabase, stop, p.intent.next)

    // ⚠️ The online functions mint their own timestamps (crewStartVisit calls
    // new Date()), so a replayed start writes a NEW `started_at` — later than the
    // moment the worker actually tapped. That is a real inaccuracy and it is
    // bounded: it only ever happens on the `unapplied` branch, where by
    // definition nothing landed, so no duplicate can result. Recording the tap
    // time instead would need the RPC to accept it as a parameter; noted for the
    // work-session accuracy pass rather than papered over here.
    if (!res.ok) throw new Error(res.error || 'field.visit replay failed')
  })

  // ── Proof of work: what was done, and what needs attention ────────────────
  // Two text columns, and re-writing them is naturally idempotent — the same
  // words land on the same row. No reconciliation needed: there is no "second
  // note" a retry could create, and last-write-wins is correct for a field whose
  // only author is the worker replaying it.
  registerHandler('field.record', async (payload) => {
    const p = payload as { id: string; record: { completion_summary: string | null; completion_issue: string | null } }
    const supabase = createClient()
    const res = await crewSaveCompletionRecord(supabase, p.id, p.record)
    if (!res.ok) throw new Error(res.error || 'field.record replay failed')
  })

  // ── A message to the office ───────────────────────────────────────────────
  // ⭐ Already idempotent at the DATABASE: crew_post_message carries a
  // client-minted token and (job_id, created_by, client_token) is a partial
  // unique index, so a replay whose first attempt landed returns the existing
  // row instead of sending twice. The token is minted at the tap and carried
  // verbatim in the payload — ⛔ never regenerated here, which would make the
  // guarantee a no-op.
  registerHandler('field.message', async (payload) => {
    const p = payload as { id: string; body: string; clientToken: string }
    const supabase = createClient()
    const res = await postCrewMessage(supabase, p.id, p.body, p.clientToken)
    if (res.kind === 'ok') return
    if (res.kind === 'revoked') {
      throw conflict(
        { kind: 'start', jobId: p.id, baseUpdatedAt: '', next: { status: 'scheduled', started_at: null, completed_at: null, actual_minutes: null }, token: p.clientToken },
        'your crew access was turned off before this sent', 'gone',
      )
    }
    throw new Error(res.message || 'field.message replay failed')
  })
}
