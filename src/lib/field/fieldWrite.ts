// ── The three answers a field write may give ─────────────────────────────────
//
//     saved    the server has it
//     pending  it is on disk and will go when there is signal
//     failed   it did not happen, and here is what to do
//
// ⛔⛔ THERE IS NO FOURTH. In particular there is no "probably" and no cheerful
// default: the app must never tell a worker something saved when it did not.
// Every call site in Crew Mode routes through this file so that promise is kept
// in ONE place rather than re-argued per button.
//
// ⭐⭐ THE RULE THIS FILE ENFORCES: never report `failed` without reconciling.
//
// A failure that arrives from the network is not evidence the write failed — it
// is evidence the RECEIPT failed. The two are indistinguishable from the phone,
// and the server's own "this visit changed" answer is the strongest tell that
// our own earlier attempt is what changed it. So before anything is called
// failed, we go and look: re-read the visit, ask lib/field/visitIntent what
// holds, and let the VERDICT decide the word. Without this step the honest-
// looking error path becomes its own lie — "that didn't save" about work that
// did — and the worker's Retry is what duplicates it.

import type { SupabaseClient } from '@supabase/supabase-js'
import { loadCrewDay, type CrewStop } from '@/lib/crewAccess'
import {
  crewStartVisit, crewStopForToday, crewCompleteVisit, crewRevertVisit,
  crewSaveCompletionRecord, type CrewWriteResult, type VisitState,
} from '@/lib/crewJob'
import { postCrewMessage } from '@/lib/crewMessages'
import { enqueue, isNetworkError } from '@/lib/offline/outbox'
import { completionPatch } from '@/lib/jobStatus'
import {
  reconcileVisitIntent, freezeIntent, newIntentToken, intentLabel,
  type VisitIntent, type VisitIntentKind, type VisitFacts,
} from './visitIntent'
import type { VisitOpPayload } from './handlers'

export type FieldSaveState = 'saved' | 'pending' | 'failed'

export interface FieldSaveResult {
  state: FieldSaveState
  /** Present for `pending` and `failed`; already a sentence a worker can act on. */
  message?: string
  /** The row version after a `saved` write, so an immediate undo carries a live
   *  guard rather than the version it just replaced. */
  nextUpdatedAt?: string
  /**
   * ⭐ The completion gate's refusal, carried through intact: the required
   * checklist items still open (crewJob.CrewWriteResult.checklist).
   *
   * ⛔ This must NOT be flattened into `message`. It is a refusal with a
   * REMEDY — a list the worker can go and complete — and the card renders it
   * beside the checklist itself, which a toast-sized apology cannot do. A
   * resilience layer that swallowed it would turn "three items left" into
   * "that didn't save", which is true and useless.
   *
   * It is also unambiguous by construction: a deterministic 422 leaves the row
   * untouched, so reconciliation returns `unapplied` and we know this is a real
   * server refusal rather than a lost response.
   */
  checklist?: { form: string; label: string; field_id: string }[]
}

const SAVED: FieldSaveResult = { state: 'saved' }

function offline(): boolean {
  return typeof navigator !== 'undefined' && navigator.onLine === false
}

// ── Building the intent ──────────────────────────────────────────────────────
// ⭐ Timestamps are minted HERE, once, at the tap — and then carried, frozen,
// through every retry and every replay. That single decision is what makes the
// whole layer idempotent: the value on the server is proof of whose write landed.
// ⛔ Never mint inside a retry.

export function buildVisitIntent(kind: VisitIntentKind, stop: CrewStop, prev?: VisitState): VisitIntent {
  const now = new Date().toISOString()
  const next: VisitState =
    kind === 'start' ? { status: 'in_progress', started_at: now, completed_at: null, actual_minutes: stop.actual_minutes }
    : kind === 'stop_for_day' ? { status: 'in_progress', started_at: null, completed_at: null, actual_minutes: stop.actual_minutes }
    : kind === 'complete' ? (() => {
        // ⭐ The SAME stamp engine every other door uses (lib/jobStatus). One
        // definition of "done" — a visit finished from a queue must be
        // indistinguishable from one finished at the kitchen table.
        // ⛔ EVERY field comes from the stamp, `status` included: writing
        // 'completed' literally here would be a second composer of a completed
        // row, which is exactly what the one-stamp rule forbids (and what
        // verify:job-completion caught). The check-in is carried across
        // unchanged — only the finish is new.
        const stamp = completionPatch(stop, { now })
        return { status: stamp.status, started_at: stop.started_at, completed_at: stamp.completed_at, actual_minutes: stamp.actual_minutes }
      })()
    : (prev ?? { status: 'scheduled', started_at: null, completed_at: null, actual_minutes: stop.actual_minutes })

  return freezeIntent({ kind, jobId: stop.id, baseUpdatedAt: stop.updated_at, next, token: newIntentToken() })
}

/** A live look at the visit, for reconciliation. Uses crew_day — the only read a
 *  crew session has — and keeps its three outcomes apart. */
async function reread(
  supabase: SupabaseClient, date: string, jobId: string,
): Promise<{ facts: VisitFacts | null; reachable: boolean }> {
  // ⭐⭐ A THROW HERE IS "COULDN'T ASK", NOT A CRASH — and this catch is
  // load-bearing rather than defensive habit. This function runs on the ambiguous
  // path, the one reached only when a write has already gone wrong; if it throws,
  // the throw escapes runVisitIntent, escapes the caller's try/finally, and the
  // worker gets NOTHING AT ALL — no toast, no state change, no queued op. The
  // single worst outcome in the product (work silently lost with a screen that
  // looks fine) would be produced by the very code meant to prevent it.
  //
  // loadCrewDay is documented to RESOLVE with { kind: 'error' } rather than
  // throw, so this should be unreachable — but "should be" is exactly the
  // assumption that costs a day's work, and a real browser run proved the shape:
  // any client that raises instead of resolving lands here. Unreachable →
  // queue it, which is always safe (the handler reconciles at replay).
  try {
    const res = await loadCrewDay(supabase, date)
    if (res.kind === 'error') return { facts: null, reachable: false }
    if (res.kind === 'revoked') return { facts: null, reachable: true }
    const s = res.day.stops.find(x => x.id === jobId)
    if (!s) return { facts: null, reachable: true }
    return {
      facts: { status: s.status, started_at: s.started_at, completed_at: s.completed_at, updated_at: s.updated_at },
      reachable: true,
    }
  } catch { return { facts: null, reachable: false } }
}

async function queueVisit(intent: VisitIntent, stop: CrewStop, date: string, why: string): Promise<FieldSaveResult> {
  const payload: VisitOpPayload = { id: stop.id, date, intent, stop }
  const op = await enqueue({ kind: 'field.visit', payload, label: intentLabel(intent.kind, stop.title) })
  // ⛔ enqueue returns null when there is no IndexedDB (private mode, a locked-
  // down webview). Nothing is on disk, so promising "it'll sync" would be the
  // exact lie this module exists to prevent — say it failed.
  if (!op) return { state: 'failed', message: 'That didn’t save and this phone can’t hold it — try again once you have signal.' }
  return { state: 'pending', message: why }
}

/**
 * Drive one visit transition, honestly.
 *
 * The shape below is the important part, and the order is not negotiable:
 *   offline        → queue it (nothing was sent; queueing is always safe)
 *   online, ok     → saved
 *   online, NOT ok → ⭐ RECONCILE. Only the verdict decides between saved,
 *                    pending and failed. A server that said "stale" may well
 *                    have been describing our own landed write.
 */
export async function runVisitIntent(
  supabase: SupabaseClient,
  args: { stop: CrewStop; intent: VisitIntent; date: string },
): Promise<FieldSaveResult> {
  const { stop, intent, date } = args

  if (offline()) {
    return queueVisit(intent, stop, date, 'No signal — saved on your phone. It’ll go when you’re back.')
  }

  let res: CrewWriteResult
  try {
    res = intent.kind === 'start' ? await crewStartVisit(supabase, stop)
      : intent.kind === 'stop_for_day' ? await crewStopForToday(supabase, stop)
      : intent.kind === 'complete' ? await crewCompleteVisit(supabase, stop)
      : await crewRevertVisit(supabase, stop, intent.next)
  } catch (e) {
    // The crew functions catch their own network errors, so reaching here means
    // something unexpected threw. Treat it as ambiguous — same as a bad answer.
    res = { ok: false, error: e instanceof Error ? e.message : 'That didn’t save.' }
  }

  if (res.ok) return { ...SAVED, nextUpdatedAt: res.nextUpdatedAt }

  // ── The ambiguous branch ───────────────────────────────────────────────────
  const { facts, reachable } = await reread(supabase, date, intent.jobId)
  if (!reachable) {
    // We could not even ask. The write may or may not have landed — and the one
    // thing we must not do is guess. Queue it: the handler reconciles at replay,
    // when an answer is actually available, so a landed write is recognised
    // rather than repeated.
    return queueVisit(intent, stop, date, 'No signal — saved on your phone. It’ll go when you’re back.')
  }

  const verdict = reconcileVisitIntent(intent, facts)
  switch (verdict.kind) {
    // ⭐ THE CASE THAT MATTERS: the server already holds our client-minted stamp.
    // The write landed and only the receipt was lost. Reporting the failure the
    // transport handed us would send the worker to press Retry on finished work.
    case 'applied':
      return { ...SAVED, nextUpdatedAt: facts?.updated_at }
    case 'unapplied':
      return { state: 'failed', message: res.error || 'That didn’t save. Try again.', checklist: res.checklist }
    case 'gone':
      return { state: 'failed', message: 'That visit is no longer on your board. Pull to refresh.' }
    case 'superseded':
      return { state: 'failed', message: `Couldn’t save that — ${verdict.because}. Refresh and take another look.` }
  }
}

// ── Proof of work ────────────────────────────────────────────────────────────
/**
 * The completion record (customer-visible summary + internal issue).
 *
 * Naturally idempotent — two text columns, one author, the same words — so there
 * is nothing to reconcile: a replay writes what a retry would. The caller keeps
 * the typed text in a durable draft (lib/field/drafts) until this returns
 * `saved`, which is what makes a `pending` here safe to walk away from.
 */
export async function runCompletionRecord(
  supabase: SupabaseClient,
  args: { jobId: string; title: string; record: { completion_summary: string | null; completion_issue: string | null } },
): Promise<FieldSaveResult> {
  const enqueueIt = async (why: string): Promise<FieldSaveResult> => {
    const op = await enqueue({
      kind: 'field.record',
      payload: { id: args.jobId, record: args.record },
      label: `Notes on ${args.title || 'a visit'}`,
    })
    if (!op) return { state: 'failed', message: 'That didn’t save and this phone can’t hold it — try again once you have signal.' }
    return { state: 'pending', message: why }
  }

  if (offline()) return enqueueIt('No signal — your notes are saved on this phone and will go when you’re back.')

  const res = await crewSaveCompletionRecord(supabase, args.jobId, args.record)
  if (res.ok) return SAVED
  // A crew write reports its own network failures as prose, so ask the shared
  // question rather than pattern-matching the sentence here.
  if (isNetworkError(new Error(res.error || ''))) {
    return enqueueIt('No signal — your notes are saved on this phone and will go when you’re back.')
  }
  return { state: 'failed', message: res.error || 'Those notes didn’t save. Try again.' }
}

// ── A message to the office ──────────────────────────────────────────────────
/**
 * ⭐ The token is minted by the CALLER, at the tap, and reused for every retry —
 * that is what the (job_id, created_by, client_token) unique index needs in
 * order to turn a replay into a no-op. ⛔ Minting one here would silently
 * disable the guarantee (crewMessages.newClientToken says the same).
 */
export async function runCrewMessage(
  supabase: SupabaseClient,
  args: { jobId: string; title: string; body: string; clientToken: string },
): Promise<FieldSaveResult> {
  const enqueueIt = async (why: string): Promise<FieldSaveResult> => {
    const op = await enqueue({
      kind: 'field.message',
      payload: { id: args.jobId, body: args.body, clientToken: args.clientToken },
      label: `Message about ${args.title || 'a visit'}`,
    })
    if (!op) return { state: 'failed', message: 'That didn’t send and this phone can’t hold it — try again once you have signal.' }
    return { state: 'pending', message: why }
  }

  if (offline()) return enqueueIt('No signal — your message is saved and will send when you’re back.')

  const res = await postCrewMessage(supabase, args.jobId, args.body, args.clientToken)
  if (res.kind === 'ok') return SAVED
  if (res.kind === 'revoked') {
    return { state: 'failed', message: 'Your crew access was turned off — that message didn’t send.' }
  }
  if (isNetworkError(new Error(res.message || ''))) {
    return enqueueIt('No signal — your message is saved and will send when you’re back.')
  }
  return { state: 'failed', message: res.message || 'That message didn’t send. Try again.' }
}
