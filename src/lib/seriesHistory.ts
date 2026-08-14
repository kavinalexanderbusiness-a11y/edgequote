import type { createClient } from '@/lib/supabase/client'

type Supa = ReturnType<typeof createClient>

// ── Which visits carry history a delete would destroy ────────────────────────
//
// `jobs.status` is not enough to answer "is this visit safe to remove". The
// foreign keys pointing AT jobs decide what a delete actually costs, and several
// of them CASCADE — deleting a visit takes its work sessions, crew media, priced
// extras and change orders with it, and orphans its invoice, photos, expenses
// and time entries. None of that is visible on the job row, and a merely
// `scheduled` visit can carry all of it (a completed visit that was reopened
// keeps every session it logged).
//
// So a recurrence edit asks the database first. The answer is the set of visit
// ids that are ENCUMBERED — carrying at least one record worth more than the
// placeholder itself.
//
// `complete` is the honesty flag. A read that failed is not an empty answer:
// treating "I could not check" as "nothing to protect" is the whole family of
// bugs this module exists to stop, so callers must refuse to delete when it is
// false rather than fall through to a bare status check.
//
// The `job_id` here is not a soft link. Every table below either loses its rows
// or loses its subject when the visit goes, which is what makes each one a veto.
export const HISTORY_TABLES = [
  'invoices',          // money — SET NULL orphans the bill from the work
  'job_work_sessions', // actual time — CASCADE (and the source of actual_minutes)
  'crew_media',        // proof of work — CASCADE
  'job_photos',        // before/after photos — SET NULL
  'job_line_items',    // priced extras added on the day — CASCADE
  'change_orders',     // agreed scope changes — CASCADE
  'expenses',          // job costs — SET NULL
  'time_entries',      // payroll-grade labour — SET NULL
] as const

export interface VisitEncumbrances {
  /** Visit ids carrying at least one history record. */
  ids: Set<string>
  /** False when ANY read failed — the answer is unknown, not empty. */
  complete: boolean
  /** The tables that could not be read, for an honest message. */
  failed: string[]
}

// PostgREST puts `.in()` lists in the query string, so a long series would build
// a URL the server rejects — and a rejected read is exactly the silent "nothing
// found" this module must never produce. Chunked well under that limit.
const CHUNK = 100

export async function loadVisitEncumbrances(supabase: Supa, jobIds: string[]): Promise<VisitEncumbrances> {
  const ids = Array.from(new Set(jobIds.filter(Boolean)))
  if (ids.length === 0) return { ids: new Set(), complete: true, failed: [] }

  const chunks: string[][] = []
  for (let i = 0; i < ids.length; i += CHUNK) chunks.push(ids.slice(i, i + CHUNK))

  const found = new Set<string>()
  const failed = new Set<string>()
  await Promise.all(HISTORY_TABLES.flatMap(table => chunks.map(async chunk => {
    const { data, error } = await supabase.from(table).select('job_id').in('job_id', chunk)
    if (error || !data) { failed.add(table); return }
    for (const row of data as { job_id: string | null }[]) if (row.job_id) found.add(row.job_id)
  })))

  return { ids: found, complete: failed.size === 0, failed: Array.from(failed) }
}
