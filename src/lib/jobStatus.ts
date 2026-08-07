// ── Visit check-in / check-out seam ──────────────────────────────────────────
// THE composition of "start a visit" and "complete a visit", shared so a status
// tap means the same thing on every surface:
//   ▶ start    = status→in_progress + started_at stamp
//   ✓ complete = status→completed + completed_at + actual_minutes derived from
//                check-in→check-out, PLUS the draft invoice and the (opt-in,
//                deduped) job-complete message — completing is never just a
//                status write; a completed visit with no invoice is money that
//                silently never gets billed.
//
// Both run through lib/offline's queueOrRun with the SAME op kinds the offline
// handlers replay ('job.update' / 'job.complete'), so the offline path and the
// online path are one set of business rules: the invoice draft de-dupes on
// job_id, and /api/comms/send enforces its own opt-in + dedupe — a retried op
// is a no-op. No new rules live here; this file only composes existing seams.
//
// Every queued op carries `baseUpdatedAt` — the row version the tap was based
// on — so a replay goes through the outbox's guardedPatch and can never
// silently revert an edit the office made while the field was offline
// (the same optimistic-concurrency contract every schedule call site passes).
//
// NOTE: the schedule page carries a pre-existing inline copy of this FLOW from
// before it was frozen (scheduling freeze @ 1d4ef66) — when that page unfreezes
// it should adopt this seam wholesale. It already shares the piece that was
// actually drifting: `completionPatch` below is imported by all three of its
// completion doors, so what "completed" WRITES has one definition even while the
// orchestration around it stays duplicated.

import type { SupabaseClient } from '@supabase/supabase-js'
import { Job } from '@/types'
import { queueOrRun } from '@/lib/offline/outbox'
import { createDraftInvoiceForCompletedJob, AutoInvoiceResult } from '@/lib/invoicing'
import { minutesBetween } from '@/lib/utils'

// ── THE completion stamp ─────────────────────────────────────────────────────
// "status → completed" is never just a status. The row must also carry WHEN it
// finished and HOW LONG it took, because both are read as canonical downstream:
//   • lib/dispatchOps buildActivityFeed emits a "completed" event ONLY when
//     completed_at is set — a completion without it never reaches the manager's
//     board at all;
//   • the customer portal's visit history and lib/timeline date the completion
//     from it (timeline falls back to updated_at, so an unstamped visit re-dates
//     itself every time anyone edits the row months later);
//   • the job.completed integration event ships completed_at/actual_minutes
//     straight from NEW.* to every connected webhook;
//   • actual_minutes is THE timing value profitability, route learning and
//     pricing calibration read.
//
// It was being composed by hand at four call sites, and only two of them wrote
// the timestamp: completing from the Day Ops quick-edit dropdown or from the job
// form set the status alone. Production carried 7 of 72 completed visits with
// completed_at NULL. So the stamp lives here, once, and every door uses it.
//
// actual_minutes ACCUMULATES rather than overwrites: a visit continued onto
// another day banks that session's minutes and clears started_at
// (continueJobAnotherDay), so the final check-out must ADD the last session to
// the banked total or the earlier day's hours are silently destroyed. A
// single-day visit is unchanged — actual_minutes is null from Start until here,
// so (null || 0) + this session == this session.
export interface CompletionStamp {
  status: 'completed'
  completed_at: string
  actual_minutes: number | null
}

export function completionPatch(
  job: Pick<Job, 'started_at' | 'actual_minutes'>,
  opts?: {
    /** Test seam / caller-supplied clock. Defaults to now. */
    now?: string
    /** An explicit figure the owner typed (the job form's "actual" field). When
     *  given it wins — a human correcting the clock outranks the derived value.
     *  Blank/0 means "not stated", so the derivation below still applies. */
    actualMinutes?: number | null
  },
): CompletionStamp {
  const now = opts?.now ?? new Date().toISOString()
  const stated = opts?.actualMinutes
  const actual = stated != null && stated > 0
    ? stated
    : job.started_at
      ? (job.actual_minutes || 0) + minutesBetween(job.started_at, now)
      : job.actual_minutes ?? null
  return { status: 'completed', completed_at: now, actual_minutes: actual }
}

export interface VisitStatusResult {
  ok: boolean
  error?: string
  outcome?: 'ran' | 'queued'
  /** The exact fields changed — hand to revertVisit for undo. */
  prev: Partial<Job>
  patch: Partial<Job>
  /** complete only: what the auto-invoice did (null when the op was queued —
   *  the draft happens at replay). */
  invoice?: AutoInvoiceResult | null
}

// ▶ Check in. Queued when there's no signal — the caller paints the patch
// optimistically either way.
export async function startVisit(supabase: SupabaseClient, job: Job): Promise<VisitStatusResult> {
  const prev = { status: job.status, started_at: job.started_at }
  const patch = { status: 'in_progress' as const, started_at: new Date().toISOString() }
  try {
    const outcome = await queueOrRun(
      { kind: 'job.update', payload: { id: job.id, patch, baseUpdatedAt: job.updated_at }, label: `Start ${job.title || 'job'}` },
      async () => {
        const { error } = await supabase.from('jobs').update(patch).eq('id', job.id)
        if (error) throw new Error(error.message)
      },
    )
    return { ok: true, outcome, prev, patch }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : 'please try again', prev, patch }
  }
}

// ✓ Check out: patch + draft invoice + courtesy message as ONE op ('job.complete'),
// so a completion queued offline can never reconnect un-billed.
export async function completeVisit(
  supabase: SupabaseClient,
  job: Job,
  opts: { notify: boolean },
): Promise<VisitStatusResult> {
  const prev = { status: job.status, completed_at: job.completed_at, actual_minutes: job.actual_minutes }
  const patch = completionPatch(job)
  const completed = { ...job, ...patch }
  const notify = opts.notify && !!job.customer_id
  let invoice: AutoInvoiceResult | null = null
  try {
    const outcome = await queueOrRun(
      { kind: 'job.complete', payload: { id: job.id, patch, job: completed, notify, baseUpdatedAt: job.updated_at }, label: `Complete ${job.title || 'job'}` },
      async () => {
        const { error } = await supabase.from('jobs').update(patch).eq('id', job.id)
        if (error) throw new Error(error.message)
        // Invoice before message — same order as the offline handler: never tell
        // the customer we're done with nothing to bill them.
        invoice = await createDraftInvoiceForCompletedJob(supabase, completed)
        if (notify) {
          fetch('/api/comms/send', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ customerId: job.customer_id, template: 'job_complete', jobId: job.id, dedupe: true }),
          }).catch(() => {})   // a failed courtesy text must not fail the completion
        }
      },
    )
    return { ok: true, outcome, prev, patch, invoice }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : 'please try again', prev, patch, invoice }
  }
}

// Undo a start/complete: write the exact previous fields back (offline-safe,
// version-guarded like every other queued job op). `deleteDraftInvoice` mirrors
// the schedule's undo-complete: the draft THIS completion just created is
// removed rather than left as a stray bill for work now marked not-done (only
// drafts are ever touched, and only when the caller saw one get created).
export async function revertVisit(
  supabase: SupabaseClient,
  jobId: string,
  prev: Partial<Job>,
  label: string,
  opts?: { baseUpdatedAt?: string | null; deleteDraftInvoice?: boolean },
): Promise<void> {
  await queueOrRun(
    { kind: 'job.update', payload: { id: jobId, patch: prev, baseUpdatedAt: opts?.baseUpdatedAt ?? null }, label },
    async () => {
      const { error } = await supabase.from('jobs').update(prev).eq('id', jobId)
      if (error) throw new Error(error.message)
      if (opts?.deleteDraftInvoice) {
        await supabase.from('invoices').delete().eq('job_id', jobId).eq('status', 'draft')
      }
    },
  )
}
