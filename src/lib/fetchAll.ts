// ── Read EVERY row, not the first thousand ───────────────────────────────────
// Supabase caps a select at 1000 rows. On a list that's a slow scroll; on a tax
// return or a P&L it's a figure that is quietly, confidently wrong — the missing
// rows look exactly like rows that never existed, so nothing on screen indicates
// the total is short.
//
// Page until a short batch comes back. Callers MUST order by a stable tiebreak
// (…, { referencedTable } aside, an `id` order works) or a row can repeat or be
// skipped at a page boundary while the count still looks plausible.
//
// This was the reports page's private helper. It moved here the moment a second
// money surface needed it: two copies of "how do we read all the rows" is how one
// report starts disagreeing with another.

const PAGE_ROWS = 1000

export async function fetchAllRows<T>(
  page: (from: number, to: number) => Promise<{ data: T[] | null; error: { message: string } | null }>,
): Promise<{ rows: T[]; error: string | null }> {
  const rows: T[] = []
  for (let from = 0; ; from += PAGE_ROWS) {
    const { data, error } = await page(from, from + PAGE_ROWS - 1)
    if (error) return { rows, error: error.message }
    const batch = data || []
    rows.push(...batch)
    if (batch.length < PAGE_ROWS) return { rows, error: null }
  }
}
