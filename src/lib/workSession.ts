// ── Work sessions: stopping without finishing ────────────────────────────────
//
// THE THING THIS MAKES POSSIBLE, in one sentence: a business can say "worked
// three hours today, back Thursday" without EdgeHQ hearing "job complete".
//
// Before this, a job had two honest states — not started, and finished — plus a
// running clock in between. The only way to record partial work was to complete
// the visit (which drafts an invoice and can text the customer that you're done)
// or to hand-edit a single accumulating integer. A plumber returning tomorrow
// and a painter on a four-day project had the same non-answer.
//
// ⭐⭐ THE STATE THAT WAS ALREADY EXPRESSIBLE AND NEVER USED:
//
//        status === 'in_progress' && started_at === null
//
// The job is underway; nobody is on the clock right now. No new status was
// added — `jobs_status_check` still allows exactly the four it always has, and
// every list, filter, board, portal mapping and report that already treats
// in_progress as active continues to be right without being touched. What
// changed is that the pair is now REACHABLE (Stop for today) and READABLE
// (Resume work), and that the time worked up to that moment is banked as a row
// with a date on it instead of disappearing into a total.
//
// ⛔ NOT A PROGRESS MODEL. There is no percent-complete column and no fourth
// status, because neither would be true. A cleaning business is not 40% done; it
// is in progress, and it has worked 3 of an estimated 8 hours. `workProgress`
// below reports exactly that — sessions worked, time against estimate — all of
// it DERIVED from records that exist. Nothing is invented, and no trade is asked
// to type a percentage it does not know.
//
// ⛔ NOT PAYROLL AND NOT SURVEILLANCE. A session records how many people were on
// site, never who. There is no wage here, no per-person attribution, and no
// route back to one: `time_entries` remains the payroll clock and this file
// never reads, writes or prices it.
//
// ⭐ HISTORY IS IMMUTABLE BY DEFAULT. Sessions are never rewritten as a side
// effect of anything — completing a job, editing its price, moving its date and
// re-opening it all leave every session exactly as recorded. They change only
// through `updateWorkSession` / `deleteWorkSession`, which exist because a
// mis-tap is real, and both are deliberate acts behind a confirm.

import type { SupabaseClient } from '@supabase/supabase-js'
import type { Job, WorkSession } from '@/types'
import { formatWorked } from '@/lib/workDuration'

/** Short, optional, about the work — the same 280 the column enforces. */
export const WORK_SESSION_NOTE_MAX = 280

export const WORK_SESSION_COLUMNS =
  'id, user_id, job_id, worked_on, started_at, ended_at, minutes, workers, labour_minutes, note, source, created_at, updated_at'

// ── Reading ──────────────────────────────────────────────────────────────────

export interface WorkSessionLoad {
  sessions: WorkSession[]
  /** ⭐ A failed read is NOT an empty history. Every surface must branch on this
   *  before it says "no work recorded" — the [portal-redesign] rule: "couldn't
   *  reach the server" is not an answer. */
  failed: boolean
}

export async function loadWorkSessions(
  supabase: SupabaseClient, jobId: string,
): Promise<WorkSessionLoad> {
  const { data, error } = await supabase
    .from('job_work_sessions')
    .select(WORK_SESSION_COLUMNS)
    .eq('job_id', jobId)
    .order('worked_on', { ascending: true })
    .order('created_at', { ascending: true })
  if (error) return { sessions: [], failed: true }
  return { sessions: (data ?? []) as WorkSession[], failed: false }
}

/** Every session for a set of jobs, in one round trip — for the timeline and
 *  any list that would otherwise fetch per row. */
export async function loadWorkSessionsForJobs(
  supabase: SupabaseClient, jobIds: string[],
): Promise<WorkSessionLoad> {
  if (jobIds.length === 0) return { sessions: [], failed: false }
  const { data, error } = await supabase
    .from('job_work_sessions')
    .select(WORK_SESSION_COLUMNS)
    .in('job_id', jobIds)
    .order('worked_on', { ascending: true })
  if (error) return { sessions: [], failed: true }
  return { sessions: (data ?? []) as WorkSession[], failed: false }
}

// ── Pure arithmetic ──────────────────────────────────────────────────────────

export interface WorkTotals {
  count: number
  /** Time ON SITE — the clock. This is what `jobs.actual_minutes` equals. */
  elapsedMinutes: number
  /** PERSON-minutes: Σ(minutes × workers). Three people for two hours is 120
   *  elapsed and 360 labour, and the difference is the whole point — capacity
   *  and costing need the second, a duration estimate needs the first. */
  labourMinutes: number
  /** Distinct days worked. Not the same as `count`: two sessions can share a day
   *  (a morning and an afternoon), and calling that "2 days" would overstate it. */
  days: number
  /** True when the job was not worked by the same number of people throughout,
   *  so a surface can avoid claiming a single crew size for the whole job. */
  workersVaried: boolean
  firstDay: string | null
  lastDay: string | null
}

export function sessionTotals(sessions: WorkSession[]): WorkTotals {
  const days = new Set<string>()
  let elapsed = 0
  let labour = 0
  let minW = Infinity
  let maxW = 0
  for (const s of sessions) {
    const m = Number(s.minutes) || 0
    const w = Math.max(1, Number(s.workers) || 1)
    elapsed += m
    // Recomputed rather than read from labour_minutes so a caller holding a
    // partially-selected row still gets the right answer; the database's
    // generated column remains the authority the guard checks against.
    labour += m * w
    days.add(s.worked_on)
    if (w < minW) minW = w
    if (w > maxW) maxW = w
  }
  const sorted = [...days].sort()
  return {
    count: sessions.length,
    elapsedMinutes: elapsed,
    labourMinutes: labour,
    days: days.size,
    workersVaried: sessions.length > 1 && maxW !== minW,
    firstDay: sorted[0] ?? null,
    lastDay: sorted[sorted.length - 1] ?? null,
  }
}

/** Sessions for one day, in the order they were recorded. */
export function sessionsByDay(sessions: WorkSession[]): { day: string; sessions: WorkSession[] }[] {
  const map = new Map<string, WorkSession[]>()
  for (const s of sessions) {
    const list = map.get(s.worked_on)
    if (list) list.push(s)
    else map.set(s.worked_on, [s])
  }
  return [...map.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([day, list]) => ({ day, sessions: list }))
}

// ── What state is this job in, really ────────────────────────────────────────

export type WorkStage = 'not_started' | 'in_progress' | 'complete' | 'cancelled'

export interface WorkProgress {
  stage: WorkStage
  /** Somebody is on the clock right now. */
  running: boolean
  /** Underway, but no clock running — stopped for the day, ready to resume.
   *  The state Stop for today produces. */
  paused: boolean
  totals: WorkTotals
  /** Planned elapsed minutes (jobs.duration_minutes). null = never sized. */
  estimateMinutes: number | null
  /**
   * Time worked ÷ time estimated, 0…n. **null whenever either side is unknown**
   * — an unsized job has no fraction, and neither does one with nothing
   * recorded. ⛔ Never rendered as a completion percentage: a job that has
   * burned 50% of its estimate is not 50% done, and no trade is being asked to
   * pretend otherwise. It exists to word "3h 20m of an estimated 8h", nothing
   * more.
   */
  estimateUsed: number | null
}

export function workProgress(
  job: Pick<Job, 'status' | 'started_at' | 'duration_minutes'>,
  sessions: WorkSession[],
): WorkProgress {
  const totals = sessionTotals(sessions)
  const running = job.status === 'in_progress' && !!job.started_at
  const stage: WorkStage =
    job.status === 'cancelled' ? 'cancelled'
      : job.status === 'completed' ? 'complete'
      : job.status === 'in_progress' || totals.count > 0 ? 'in_progress'
      : 'not_started'
  const estimate = Number(job.duration_minutes) > 0 ? Number(job.duration_minutes) : null
  return {
    stage,
    running,
    paused: stage === 'in_progress' && !running,
    totals,
    estimateMinutes: estimate,
    estimateUsed: estimate != null && totals.elapsedMinutes > 0
      ? totals.elapsedMinutes / estimate
      : null,
  }
}

/**
 * The one-line summary: "3 sessions over 2 days · 8h 30m". Empty string when
 * there is nothing true to say — never "0 sessions", which reads as an
 * accusation about a job that simply hasn't started.
 */
export function describeWork(totals: WorkTotals): string {
  if (totals.count === 0) return ''
  const parts: string[] = []
  parts.push(`${totals.count} session${totals.count === 1 ? '' : 's'}`)
  if (totals.days > 1) parts.push(`over ${totals.days} days`)
  return `${parts.join(' ')} · ${formatWorked(totals.elapsedMinutes)}`
}

/** "2 people · 6h of labour" — said only when there is a second person to
 *  distinguish, because for a solo operator elapsed and labour are one number
 *  and printing both twice is noise. */
export function describeLabour(totals: WorkTotals): string {
  if (totals.count === 0 || totals.labourMinutes === totals.elapsedMinutes) return ''
  return `${formatWorked(totals.labourMinutes)} of labour`
}

// ── Writing ──────────────────────────────────────────────────────────────────
//
// Every write REPORTS ITS WRITE. A session that silently didn't save is the
// worst outcome in the field — the crew drives away certain the day is recorded.
// `.select()` is not politeness: a PostgREST update matching zero rows returns
// success with no error, so a write RLS dropped would otherwise render "Saved".

export interface WorkSessionResult {
  ok: boolean
  error?: string
  session?: WorkSession
  /** The job's total after the write, as the DATABASE computed it — read back
   *  rather than predicted, because the trigger is the authority on it. */
  actualMinutes?: number | null
  /** The job row version after the write, for a caller holding an optimistic
   *  guard (banking a session bumps the job's updated_at). */
  jobUpdatedAt?: string | null
}

export interface LogWorkInput {
  /** The day the work happened — the CLIENT's local date, because the database
   *  does not know the business's timezone and must not guess it. */
  workedOn: string
  minutes: number
  workers?: number | null
  note?: string | null
}

function cleanNote(v: string | null | undefined): string | null {
  if (typeof v !== 'string') return null
  const t = v.trim()
  if (!t) return null
  return t.length > WORK_SESSION_NOTE_MAX ? t.slice(0, WORK_SESSION_NOTE_MAX).trimEnd() : t
}

/** Bounds mirrored from the column checks, so a bad figure is refused in words
 *  the field understands rather than as a Postgres constraint name. */
export function validateWorkInput(input: LogWorkInput): string | null {
  const m = Math.round(Number(input.minutes))
  if (!Number.isFinite(m) || m <= 0) return 'Enter how long the work took.'
  if (m > 10080) return 'That is more than a week — record it as separate days.'
  const w = input.workers == null ? 1 : Math.round(Number(input.workers))
  if (!Number.isFinite(w) || w < 1) return 'At least one person has to have been there.'
  if (w > 50) return 'That is more people than a session can record.'
  if (!/^\d{4}-\d{2}-\d{2}$/.test(input.workedOn)) return 'Pick the day the work happened.'
  return null
}

async function jobTotals(
  supabase: SupabaseClient, jobId: string,
): Promise<{ actualMinutes: number | null; jobUpdatedAt: string | null }> {
  const { data } = await supabase
    .from('jobs').select('actual_minutes, updated_at').eq('id', jobId).maybeSingle()
  const row = data as { actual_minutes: number | null; updated_at: string } | null
  return { actualMinutes: row?.actual_minutes ?? null, jobUpdatedAt: row?.updated_at ?? null }
}

/**
 * "Worked 2h 15m" — recorded by hand, with no clock involved and no completion
 * implied. THE door for a business that never presses Start: the timer is an
 * option here, not a requirement.
 */
export async function logWorkSession(
  supabase: SupabaseClient, job: Pick<Job, 'id' | 'user_id' | 'crew_size'>, input: LogWorkInput,
): Promise<WorkSessionResult> {
  const invalid = validateWorkInput(input)
  if (invalid) return { ok: false, error: invalid }
  const { data, error } = await supabase
    .from('job_work_sessions')
    .insert({
      user_id: job.user_id,
      job_id: job.id,
      worked_on: input.workedOn,
      minutes: Math.round(Number(input.minutes)),
      workers: Math.max(1, Math.round(Number(input.workers ?? job.crew_size ?? 1)) || 1),
      note: cleanNote(input.note),
      source: 'manual',
    })
    .select(WORK_SESSION_COLUMNS)
    .maybeSingle()
  if (error) return { ok: false, error: error.message }
  if (!data) return { ok: false, error: 'That work could not be saved — refresh and try again.' }
  const totals = await jobTotals(supabase, job.id)
  return { ok: true, session: data as WorkSession, ...totals }
}

export interface StopForTodayInput {
  /** The next day work is planned. null = not scheduled yet — the job stays on
   *  the day it is on and reads as unfinished, which is honest; inventing
   *  "tomorrow" would put work on a day nobody agreed to. */
  nextDate?: string | null
  /** How many people were actually here today, when that differs from the
   *  planned crew size the clock assumed. */
  workers?: number | null
  note?: string | null
}

export interface StopForTodayResult extends WorkSessionResult {
  /** Exactly the job fields that changed, for undo. */
  prev: Partial<Job>
  patch: Partial<Job>
}

/**
 * ⭐ STOP FOR TODAY — and NOT complete. The job stays `in_progress`; only the
 * clock stops. No invoice is drafted, no "we're done" message goes out, the
 * accepted quote value and every invoice and payment already attached stay
 * exactly where they are. The visit can be worked again tomorrow, or next week.
 *
 * The time worked is banked by the database as the check-in is cleared (one
 * trigger, every door) — this function does not compute minutes, which is why
 * a stop from the crew's phone, the dispatch board and the calendar can never
 * disagree about the day's total.
 */
export async function stopForToday(
  supabase: SupabaseClient,
  job: Pick<Job, 'id' | 'status' | 'started_at' | 'scheduled_date' | 'actual_minutes' | 'route_order'>,
  input: StopForTodayInput = {},
): Promise<StopForTodayResult> {
  const prev: Partial<Job> = {
    status: job.status,
    started_at: job.started_at,
    actual_minutes: job.actual_minutes,
    scheduled_date: job.scheduled_date,
    route_order: job.route_order ?? null,
  }
  const patch: Partial<Job> = {
    status: 'in_progress',
    started_at: null,
    ...(input.nextDate && input.nextDate !== job.scheduled_date
      ? { scheduled_date: input.nextDate }
      : {}),
  }
  const { data, error } = await supabase
    .from('jobs').update(patch).eq('id', job.id)
    .select('id, actual_minutes, updated_at').maybeSingle()
  if (error) return { ok: false, error: error.message, prev, patch }
  if (!data) {
    return { ok: false, error: 'That visit could not be found — refresh and try again.', prev, patch }
  }
  const row = data as { actual_minutes: number | null; updated_at: string }

  // The session the database just banked, found by the check-in it covers (one
  // per clock stretch, by unique index). Only touched when the owner actually
  // said something about it — an unremarked stop leaves the record as taken.
  let session: WorkSession | undefined
  if (job.started_at) {
    const { data: s } = await supabase
      .from('job_work_sessions').select(WORK_SESSION_COLUMNS)
      .eq('job_id', job.id).eq('started_at', job.started_at).maybeSingle()
    session = (s as WorkSession | null) ?? undefined
    const note = cleanNote(input.note)
    const workers = input.workers == null ? null : Math.max(1, Math.round(Number(input.workers)))
    if (session && (note !== null || (workers !== null && workers !== session.workers))) {
      const { data: upd } = await supabase
        .from('job_work_sessions')
        .update({
          ...(note !== null ? { note } : {}),
          ...(workers !== null ? { workers: Math.min(50, workers) } : {}),
        })
        .eq('id', session.id).select(WORK_SESSION_COLUMNS).maybeSingle()
      if (upd) session = upd as WorkSession
    }
  }
  return {
    ok: true, prev, patch, session,
    actualMinutes: row.actual_minutes, jobUpdatedAt: row.updated_at,
  }
}

/**
 * ▶ RESUME — start the clock again on a job already underway. Distinct from
 * `startVisit` only in that it does not assume the job is untouched: the banked
 * sessions and the total stay exactly as they are, and a fresh check-in begins.
 */
export async function resumeWork(
  supabase: SupabaseClient, job: Pick<Job, 'id' | 'status' | 'started_at'>,
): Promise<WorkSessionResult & { prev: Partial<Job>; patch: Partial<Job> }> {
  const prev: Partial<Job> = { status: job.status, started_at: job.started_at }
  const patch: Partial<Job> = { status: 'in_progress', started_at: new Date().toISOString() }
  const { data, error } = await supabase
    .from('jobs').update(patch).eq('id', job.id)
    .select('id, actual_minutes, updated_at').maybeSingle()
  if (error) return { ok: false, error: error.message, prev, patch }
  if (!data) {
    return { ok: false, error: 'That visit could not be found — refresh and try again.', prev, patch }
  }
  const row = data as { actual_minutes: number | null; updated_at: string }
  return { ok: true, prev, patch, actualMinutes: row.actual_minutes, jobUpdatedAt: row.updated_at }
}

/**
 * A DELIBERATE correction to recorded history — the clock was left running, the
 * wrong day was picked, two people were logged as three. Never called as a side
 * effect of anything: no lifecycle transition rewrites a session.
 */
export async function updateWorkSession(
  supabase: SupabaseClient, session: Pick<WorkSession, 'id' | 'job_id'>,
  changes: { workedOn?: string; minutes?: number; workers?: number; note?: string | null },
): Promise<WorkSessionResult> {
  const patch: Record<string, unknown> = {}
  if (changes.workedOn !== undefined) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(changes.workedOn)) return { ok: false, error: 'Pick the day the work happened.' }
    patch.worked_on = changes.workedOn
  }
  if (changes.minutes !== undefined) {
    const m = Math.round(Number(changes.minutes))
    if (!Number.isFinite(m) || m <= 0) return { ok: false, error: 'Enter how long the work took.' }
    if (m > 10080) return { ok: false, error: 'That is more than a week — record it as separate days.' }
    patch.minutes = m
  }
  if (changes.workers !== undefined) {
    const w = Math.round(Number(changes.workers))
    if (!Number.isFinite(w) || w < 1) return { ok: false, error: 'At least one person has to have been there.' }
    if (w > 50) return { ok: false, error: 'That is more people than a session can record.' }
    patch.workers = w
  }
  if (changes.note !== undefined) patch.note = cleanNote(changes.note)
  if (Object.keys(patch).length === 0) return { ok: true }

  const { data, error } = await supabase
    .from('job_work_sessions').update(patch).eq('id', session.id)
    .select(WORK_SESSION_COLUMNS).maybeSingle()
  if (error) return { ok: false, error: error.message }
  if (!data) return { ok: false, error: 'That work session could not be found — refresh and try again.' }
  const totals = await jobTotals(supabase, session.job_id)
  return { ok: true, session: data as WorkSession, ...totals }
}

/** Remove a session that should never have existed. The job's total follows it
 *  down — and back to UNKNOWN, not zero, if it was the last one. */
export async function deleteWorkSession(
  supabase: SupabaseClient, session: Pick<WorkSession, 'id' | 'job_id'>,
): Promise<WorkSessionResult> {
  const { data, error } = await supabase
    .from('job_work_sessions').delete().eq('id', session.id).select('id')
  if (error) return { ok: false, error: error.message }
  if (!data || data.length === 0) {
    return { ok: false, error: 'That work session could not be found — refresh and try again.' }
  }
  const totals = await jobTotals(supabase, session.job_id)
  return { ok: true, ...totals }
}

/** Put a deleted session back, for undo. A new row with the same facts — the
 *  id is not preserved, because the row it names is gone. */
export async function restoreWorkSession(
  supabase: SupabaseClient, session: WorkSession,
): Promise<WorkSessionResult> {
  const { data, error } = await supabase
    .from('job_work_sessions')
    .insert({
      user_id: session.user_id, job_id: session.job_id, worked_on: session.worked_on,
      // The clock stretch is deliberately NOT restored: the unique index that
      // stops a check-in being banked twice would refuse it, and a restored
      // record of the same minutes on the same day is the fact that matters.
      minutes: session.minutes, workers: session.workers, note: session.note,
      source: session.source === 'clock' ? 'manual' : session.source,
    })
    .select(WORK_SESSION_COLUMNS).maybeSingle()
  if (error) return { ok: false, error: error.message }
  if (!data) return { ok: false, error: 'That could not be put back.' }
  const totals = await jobTotals(supabase, session.job_id)
  return { ok: true, session: data as WorkSession, ...totals }
}
