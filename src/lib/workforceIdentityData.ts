// ── What is at stake behind a possible duplicate ─────────────────────────────
// Counts only. This module reads six tables and returns six numbers per person,
// so the warning surface can say what a merge WOULD have touched — which is
// exactly why this phase offers no merge.
//
// ⛔⛔ READ-ONLY BY CONSTRUCTION. No insert, update, upsert or delete, and
// verify:workforce-identity asserts that by reading this file. `pay_run_lines`,
// `wage_history` and `time_entries` are what somebody was paid; a tool that
// could move them would be rewriting a filed financial record.
//
// ⛔ EVERY read is scoped by BOTH `user_id` and `technician_id`. All six tables
// carry both columns (measured, not assumed), so tenant isolation is a predicate
// on the query rather than a filter applied to the result — there is no moment
// at which another tenant's row is in memory.

import type { SupabaseClient } from '@supabase/supabase-js'
import { EMPTY_HISTORY, type WorkerHistoryCounts } from '@/lib/workforceIdentity'

/** table → the key it is reported under. Kept as data so the tenant scoping
 *  below is written ONCE and cannot be forgotten on the seventh table. */
const HISTORY_TABLES: ReadonlyArray<{ table: string; key: keyof WorkerHistoryCounts }> = [
  { table: 'time_entries', key: 'timeEntries' },
  { table: 'pay_run_lines', key: 'payRunLines' },
  { table: 'wage_history', key: 'wageHistory' },
  { table: 'pto_entries', key: 'ptoEntries' },
  { table: 'jobs', key: 'jobs' },
  { table: 'technician_crew_history', key: 'crewHistory' },
]

export interface HistoryLoadResult {
  counts: Record<string, WorkerHistoryCounts>
  /**
   * ⚠️ Tables whose count could not be read. A failed count is NOT zero, and the
   * difference matters more here than almost anywhere: "nothing points at this
   * record" is the reading that would make a deletion look safe. The surface
   * must say "we could not check" instead of quietly showing 0.
   */
  unreadable: string[]
}

/**
 * History counts for a handful of technicians — the ones a finding actually
 * names, never the whole roster. A roster of forty people with no duplicates
 * costs zero queries, because nothing calls this.
 */
export async function loadWorkerHistoryCounts(
  supabase: SupabaseClient,
  userId: string,
  technicianIds: readonly string[],
): Promise<HistoryLoadResult> {
  const ids = [...new Set(technicianIds.filter(Boolean))]
  const counts: Record<string, WorkerHistoryCounts> = {}
  const unreadable = new Set<string>()
  if (!ids.length || !userId) return { counts, unreadable: [] }

  for (const id of ids) counts[id] = { ...EMPTY_HISTORY }

  // One HEAD count per (table, technician). Small by construction — a finding
  // names two people, so this is twelve cheap queries at the moment somebody
  // expands a warning, and none before.
  await Promise.all(HISTORY_TABLES.flatMap(({ table, key }) =>
    ids.map(async id => {
      const { count, error } = await supabase
        .from(table)
        .select('id', { count: 'exact', head: true })
        .eq('user_id', userId)          // ⛔ tenant
        .eq('technician_id', id)        // ⛔ person
      if (error) { unreadable.add(table); return }
      counts[id][key] = count ?? 0
    }),
  ))

  return { counts, unreadable: [...unreadable] }
}
