// ── Read EVERY row, not the first 1000 ──────────────────────────────────────
// PostgREST caps a response at 1000 rows and does NOT raise an error — the query
// just quietly returns less than you asked for. Any figure summed from an
// unbounded select is therefore silently wrong the moment a table crosses the
// cap, with no symptom to notice.
//
// This is THE shared paged read. It existed before as a useCallback locked
// inside the Schedule page (the fix for that exact bug), so nothing else could
// reuse it and the dashboard reintroduced the truncation. One helper now.
//
// `orderBy` is not optional on purpose: without a deterministic ORDER BY,
// PostgREST returns rows in unspecified heap order, so a truncated read keeps an
// ARBITRARY 1000 rows — worse than dropping a predictable slice, because the
// numbers become non-reproducible.

import type { PostgrestFilterBuilder } from '@supabase/postgrest-js'

const PAGE_ROWS = 1000

/**
 * Drain a PostgREST query page by page.
 *
 * @param build   Called per page — must return a FRESH query each time (a
 *                PostgrestFilterBuilder is a one-shot thenable; reusing one
 *                across pages re-sends the first page forever).
 * @param orderBy A stable, unique-enough column to page by (`id` is always safe).
 */
export async function pageAll<T>(
  build: () => PostgrestFilterBuilder<any, any, any, any, any>,
  orderBy = 'id',
): Promise<{ rows: T[]; error: string | null }> {
  const out: T[] = []
  for (let from = 0; ; from += PAGE_ROWS) {
    const { data, error } = await build()
      .order(orderBy, { ascending: true })
      .range(from, from + PAGE_ROWS - 1)
    if (error) return { rows: out, error: error.message }
    const batch = (data as T[]) || []
    out.push(...batch)
    // A short page means we've reached the end. A full page might be the end
    // too — the next loop returns 0 rows and stops.
    if (batch.length < PAGE_ROWS) return { rows: out, error: null }
  }
}
