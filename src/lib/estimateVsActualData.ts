// ── Loading the visits the estimate-vs-actual engine learns from ─────────────
// lib/estimateVsActual.ts is pure and I/O-free; this is the ONE place that knows
// which table those rows come from. Same split as lib/timeline + lib/timelineData:
// engine · loader · UI, so the arithmetic can never acquire a database and the
// database can never acquire an opinion about arithmetic.
//
// ══ WHY THE RESULT HAS THREE OUTCOMES, NOT TWO ═══════════════════════════════
// "I could not read your history" and "you have no history" are different facts
// that lead to opposite actions, and the whole class of bug this module exists
// to prevent is the first quietly rendering as the second. A caller that gets a
// bare `LaborLearning` back has no way to tell them apart — an empty array reads
// as "no similar jobs", which is a claim about the business rather than about
// the request. So failure is a SEPARATE branch a UI must handle explicitly; it
// cannot fall through to the empty state by forgetting.
//
// This is the same contract as the crew day (an UNKNOWN day is never an OPEN
// day) and the portal read ("couldn't reach the server" is not an answer).
//
// ══ TENANCY ══════════════════════════════════════════════════════════════════
// `jobs` is RLS own-row (enabled, 4 policies — verified live), so a session
// client physically cannot see another business's visits. The explicit
// `.eq('user_id', userId)` is NOT redundant belt-and-braces theatre: it is the
// only thing standing if this loader is ever handed a service-role client, which
// bypasses RLS entirely. One business's completed work must never influence
// another's estimating, and that guarantee should not rest on which client a
// future caller happens to pass.

import type { SupabaseClient } from '@supabase/supabase-js'
import {
  learnFromCompletedVisits,
  type LaborLearning, type VisitLike, type VisitSessionFacts,
} from '@/lib/estimateVsActual'
import { loadWorkSessionsForJobs, sessionTotals } from '@/lib/workSession'
import type { WorkSession } from '@/types'

/**
 * The most recent completed visits to learn from. Deliberately a cap and not a
 * date window: a seasonal business can go months without work, and a window
 * would silently empty its history in the off-season.
 *
 * When it bites, `truncated` says so rather than letting the surface imply it
 * read everything — a sample size is only evidence if the reader knows what it
 * was drawn from.
 */
export const HISTORY_LIMIT = 400

export type LearningLoad =
  /** Read succeeded and at least one visit is comparable. */
  | { outcome: 'ok'; learning: LaborLearning; truncated: boolean }
  /** Read succeeded; nothing to learn from yet. A fact about the business. */
  | { outcome: 'no_history'; learning: LaborLearning; truncated: boolean }
  /** The read did not happen. NOT an empty history — say so, show no figures. */
  | { outcome: 'unavailable'; reason: string }

/**
 * Completed visits for ONE business, turned into learning.
 *
 * Returns `unavailable` on any read that did not demonstrably succeed —
 * including a null payload with no error, which PostgREST can produce and which
 * would otherwise be indistinguishable from "you have never finished a job".
 */
export async function loadCompletedVisitLearning(
  supabase: SupabaseClient,
  userId: string,
): Promise<LearningLoad> {
  // No signed-in user is not an empty history either — it is a read that cannot
  // be scoped, and an unscoped learning read is the tenancy bug itself.
  if (!userId) return { outcome: 'unavailable', reason: 'not_signed_in' }

  const { data, error } = await supabase
    .from('jobs')
    // crew_size rides along because elapsed time alone cannot answer a
    // costing question: 5 hours with 3 people is 15 labour-hours, and the
    // engine cannot derive that from a column it never read. It is the PLANNED
    // crew (nothing records attendance), and lib/estimateVsActual labels it so.
    .select('id, status, service_type, scheduled_date, duration_minutes, actual_minutes, crew_size')
    .eq('user_id', userId)
    .eq('status', 'completed')
    .order('scheduled_date', { ascending: false })
    .limit(HISTORY_LIMIT)

  if (error) return { outcome: 'unavailable', reason: error.message || 'read_failed' }
  if (!Array.isArray(data)) return { outcome: 'unavailable', reason: 'no_rows_returned' }

  // Status is filtered here AND re-checked inside the engine. The engine's check
  // is the load-bearing one: the labour-capture trigger fires on any
  // actual_minutes change without checking status, so a re-opened visit can keep
  // minutes banked against a completion that no longer holds.
  const visits = data as VisitLike[]

  // ── Session 47's work sessions, for the LABOUR half ────────────────────────
  // Elapsed learning needs nothing from here: jobs.actual_minutes IS the sum of
  // these sessions' minutes, enforced by a database trigger, so the column
  // already carries the multi-day total. What only the sessions can say is how
  // many people were on site on each of those days.
  //
  // A FAILED SESSIONS READ IS NOT "NO SESSIONS", and it does not darken the
  // card either: the visits simply arrive without session facts, every labour
  // figure falls to the planned-crew derivation, and it is LABELLED as that.
  // Degrading to a weaker but correctly-named claim keeps the estimate working
  // while refusing to call the plan a measurement.
  const byJob = await loadSessionFacts(supabase, userId, visits.map(v => v.id))

  const learning = learnFromCompletedVisits(
    visits.map(v => (byJob.has(v.id) ? { ...v, sessions: byJob.get(v.id) } : v)),
  )
  const truncated = data.length >= HISTORY_LIMIT

  return learning.coverage.comparable > 0
    ? { outcome: 'ok', learning, truncated }
    : { outcome: 'no_history', learning, truncated }
}

/**
 * One visit's worth of work-session facts, per job id.
 *
 * The read goes through Session 47's own `loadWorkSessionsForJobs` and the
 * totals through its own `sessionTotals`, so person-minutes have exactly one
 * arithmetic in the product and this module owns none of it. What is decided
 * here is only which facts the learner needs.
 *
 * TENANCY: `job_work_sessions` is RLS own-row AND carries the composite FK
 * `(job_id, user_id) → jobs(id, user_id)`, so a foreign session cannot even
 * point at one of these jobs. The explicit `user_id` filter below is still not
 * redundant — it is what stands if a service-role client is ever passed, exactly
 * as the visits read above carries one.
 */
async function loadSessionFacts(
  supabase: SupabaseClient,
  userId: string,
  jobIds: string[],
): Promise<Map<string, VisitSessionFacts>> {
  const out = new Map<string, VisitSessionFacts>()
  if (!userId || jobIds.length === 0) return out

  // ⚠️ CAUGHT, not just checked. `loadWorkSessionsForJobs` turns a PostgREST
  // error into `failed`, but a THROW — an offline client, a stub that does not
  // implement the query, a transport fault — would otherwise take the entire
  // estimate down with it. The labour half is an enhancement to a card whose
  // elapsed half needs nothing from here, so a session read that explodes must
  // cost exactly the labour claim and nothing else. Every visit then falls to
  // the planned-crew derivation and is LABELLED as that.
  let sessions: WorkSession[]
  try {
    const load = await loadWorkSessionsForJobs(supabase, jobIds)
    if (load.failed) return out
    sessions = load.sessions
  } catch {
    return out
  }

  const byJob = new Map<string, WorkSession[]>()
  for (const s of sessions) {
    if (s.user_id !== userId) continue
    const list = byJob.get(s.job_id)
    if (list) list.push(s)
    else byJob.set(s.job_id, [s])
  }

  for (const [jobId, rows] of byJob) {
    const t = sessionTotals(rows)
    out.set(jobId, {
      count: t.count,
      elapsedMinutes: t.elapsedMinutes,
      laborMinutes: t.labourMinutes,
      // A stretch that started and has not ended is still being written.
      open: rows.some(r => r.started_at != null && r.ended_at == null),
      // ⭐ Only a hand-logged session's worker count came from a person. The
      // clock and carry-forward triggers copy jobs.crew_size into `workers`, so
      // a 'clock' or 'carried' session's labour is the PLAN multiplied by real
      // minutes — true, and not a statement about who turned up.
      attendanceStated: rows.every(r => r.source === 'manual'),
      // `workersVaried` is Session 47's own answer to "was this one crew?".
      workers: t.workersVaried ? null : Math.max(1, Number(rows[0]?.workers) || 1),
    })
  }
  return out
}
