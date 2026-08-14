// ── Loading what one visit cost ──────────────────────────────────────────────
// lib/jobCost.ts is pure and I/O-free; this is the ONE place that knows which
// tables those rows come from. Same three-way split as lib/estimateVsActual +
// lib/estimateVsActualData: engine · loader · UI, so the arithmetic can never
// acquire a database and the database can never acquire an opinion about
// arithmetic.
//
// ══ WHY THE RESULT HAS THREE OUTCOMES, NOT TWO ═══════════════════════════════
// "I could not read your costs" and "this visit has no costs recorded" are
// different facts that lead to opposite actions, and the entire class of bug this
// lane exists to prevent is the first quietly rendering as the second. A failed
// read that falls through to an empty list produces "No costs recorded", which is
// a claim about the BUSINESS made on the strength of a network error.
//
// So `unavailable` is a separate branch a UI must handle explicitly, and it is
// also fed back into the engine as `readFailed` so that even a caller who ignores
// the outcome gets `unknown` in every category rather than a zero. Two
// independent defences, because this is the failure mode that keeps recurring
// across this codebase (the crew day, the portal read, the learning load).
//
// ══ TENANCY ══════════════════════════════════════════════════════════════════
// `expenses`, `time_entries` and `jobs` are all RLS own-row, so a session client
// physically cannot read another business's rows. The explicit
// `.eq('user_id', userId)` on every query is NOT redundant theatre — it is the
// only thing standing if this loader is ever handed a service-role client, which
// bypasses RLS entirely.
//
// Underneath both, since 2026-08-11, all three job pointers carry a COMPOSITE
// foreign key `(job_id, user_id) → jobs(id, user_id)`
// (supabase/archive/run/RUN-2026-08-11c-job-cost-tenancy.sql). Before it, RLS proved who
// owned the EXPENSE and the foreign key proved the job EXISTED, and nothing
// proved they were the same business — so a cost could be attached to another
// tenant's visit. That is now a row that cannot exist, enforced by the storage
// engine for every writer including service-role and DEFINER functions.

import type { SupabaseClient } from '@supabase/supabase-js'
import type { BusinessSettings, ExpenseWithRelations, TimeEntry } from '@/types'
import { isGstRegistrant } from '@/lib/accounting/report'
import { serviceKey } from '@/lib/serviceKey'
import { readJobActualCost, type JobActualCost } from '@/lib/jobCost'

/**
 * Receipts on one visit. A cap, not a window — and far above any plausible
 * number of receipts for a single job, so it exists only to bound a runaway
 * query rather than to sample.
 */
export const JOB_EXPENSE_LIMIT = 200

// `kind` is NOT optional: lib/accounting/expenses.isOwnerDraw reads it, and a
// join that omits it returns undefined — which reads as "not a draw", quietly
// putting an owner's drawings back in as a cost of the job. `name` carries the
// materials split. Both are load-bearing; neither may be trimmed to save bytes.
const EXPENSE_SELECT =
  '*, vendors(id, name), expense_categories(id, name, tax_deductible, kind, external_account)'

export interface JobCostLoad {
  outcome: 'ok' | 'unavailable'
  /**
   * ALWAYS present. On `unavailable` it is the engine's all-unknown read, so a
   * surface that forgets to branch still cannot print a zero.
   */
  cost: JobActualCost
  expenses: ExpenseWithRelations[]
  /** Completed visits of the SAME service that already carry recorded spend. */
  pricedPeers: number
  reason?: string
}

export interface JobCostTarget {
  id: string
  status?: string | null
  service_type?: string | null
  actual_minutes?: number | null
  crew_size?: number | null
}

/**
 * ⭐ What did this visit cost? Everything the panel needs, in one call.
 *
 * `pricedPeers` is loaded here rather than by the caller because the data-quality
 * prompt must never be assembled from a partial read: a peer count that silently
 * came back 0 because a query failed would suppress a prompt that should fire (or,
 * inverted, fire one that should not). It travels with the cost or not at all.
 */
export async function loadJobCost(
  supabase: SupabaseClient,
  userId: string,
  job: JobCostTarget,
): Promise<JobCostLoad> {
  const failed = (reason: string): JobCostLoad => ({
    outcome: 'unavailable',
    // readFailed makes every category `unknown` with reason 'read_failed'.
    cost: readJobActualCost({ job, expenses: [], timeEntries: [], registrant: false, readFailed: true }),
    expenses: [],
    pricedPeers: 0,
    reason,
  })

  // An unscoped read is the tenancy bug itself, so no user is a failure, not an
  // empty result.
  if (!userId) return failed('not_signed_in')
  if (!job?.id) return failed('no_job')

  const [expenseRes, timeRes, settingsRes, peerRes] = await Promise.all([
    supabase
      .from('expenses')
      .select(EXPENSE_SELECT)
      .eq('user_id', userId)
      .eq('job_id', job.id)
      .is('archived_at', null)
      .order('bill_date', { ascending: false })
      .limit(JOB_EXPENSE_LIMIT),
    supabase
      .from('time_entries')
      .select('*')
      .eq('user_id', userId)
      .eq('job_id', job.id),
    supabase
      .from('business_settings')
      .select('*')
      .eq('user_id', userId)
      .maybeSingle(),
    // Peers: every OTHER visit of this business that has spend tagged to it,
    // with the service it was. `!inner` keeps it to rows whose job still exists.
    supabase
      .from('expenses')
      .select('job_id, jobs!inner(service_type, status)')
      .eq('user_id', userId)
      .not('job_id', 'is', null)
      .is('archived_at', null)
      .limit(1000),
  ])

  // Any read that did not demonstrably succeed. A null payload with no error is
  // included deliberately: PostgREST can produce it, and it is otherwise
  // indistinguishable from "this visit has no receipts".
  if (expenseRes.error) return failed(expenseRes.error.message || 'expenses_read_failed')
  if (!Array.isArray(expenseRes.data)) return failed('expenses_no_rows_returned')
  if (timeRes.error) return failed(timeRes.error.message || 'time_read_failed')
  if (!Array.isArray(timeRes.data)) return failed('time_no_rows_returned')
  // Settings decides gross vs net. Guessing `registrant` would move every figure
  // by the tax, so a failed settings read is a failed cost read.
  if (settingsRes.error) return failed(settingsRes.error.message || 'settings_read_failed')
  if (peerRes.error) return failed(peerRes.error.message || 'peers_read_failed')

  const expenses = expenseRes.data as unknown as ExpenseWithRelations[]
  const timeEntries = timeRes.data as unknown as TimeEntry[]

  return {
    outcome: 'ok',
    cost: readJobActualCost({
      job,
      expenses,
      timeEntries,
      registrant: isGstRegistrant(settingsRes.data as BusinessSettings | null),
    }),
    expenses,
    pricedPeers: countPricedPeers(peerRes.data, job),
  }
}

/**
 * How many OTHER completed visits of the same service already carry spend.
 *
 * Grouped by `serviceKey`, the canonical normalizer the labour and pricing
 * learners already share — production carries "Lawn Mowing", "Weekly Mowing" and
 * "Lawn mowing" as three strings for one service, and matching raw text would
 * make the prompt fire or stay silent depending on how a job was typed.
 *
 * DISTINCT BY JOB: three receipts on one visit are one peer, not three. Without
 * that, a single well-documented job would be enough to start nagging every
 * other visit of that service.
 */
function countPricedPeers(rows: unknown, job: JobCostTarget): number {
  if (!Array.isArray(rows)) return 0
  const key = serviceKey(job.service_type)
  const peers = new Set<string>()
  for (const r of rows as { job_id: string | null; jobs?: { service_type?: string | null; status?: string | null } | null }[]) {
    const j = r?.jobs
    if (!r?.job_id || !j) continue
    // The visit being looked at is not evidence about itself.
    if (r.job_id === job.id) continue
    if (j.status !== 'completed') continue
    if (serviceKey(j.service_type) !== key) continue
    peers.add(r.job_id)
  }
  return peers.size
}
