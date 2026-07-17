import type { SupabaseClient } from '@supabase/supabase-js'
import { JobLineItem, RecurrenceScope } from '@/types'
import { serviceCategory } from '@/lib/seasons'

// ── Job add-ons + price-change history ────────────────────────────────────────
// Composition only — no new pricing math. The base price stays on the job/quote
// (lib/invoicing is the single per-visit value); add-ons are ADDITIVE rows, and
// price changes are logged for the audit trail / future BI.

export function addonsTotal(items: JobLineItem[] | undefined | null): number {
  if (!items) return 0
  return items.reduce((s, i) => s + (Number(i.amount) || 0), 0)
}

// A service that's normally billed every visit (mowing, fertilizer/weed-control
// programs, monthly bed maintenance…) → the add-on scope chooser pre-selects a
// recurring option and shows a "Recommended" badge. Everything else defaults to
// this-visit-only so the owner never accidentally bills an add-on forever.
export function isRecurringProgramService(name: string | null | undefined): boolean {
  const s = (name || '').toLowerCase()
  if (!s) return false
  if (/\bprogram\b/.test(s)) return true
  if (/mow|grass cut|lawn care/.test(s)) return true
  if (/fertiliz|weed control|bed maintenance/.test(s)) return true
  return false
}

// Stable BI key from a free-text add-on description ("Weed Control" → "weed_control").
export function normalizeServiceKey(label: string): string {
  return label.trim().toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '') || 'custom'
}

// Record one price change (always — increase or decrease). Reason is only passed
// on an increase. Non-fatal: a failed log never blocks the price write.
export async function recordPriceChange(
  supabase: SupabaseClient,
  opts: {
    userId: string
    jobId: string | null
    quoteId?: string | null
    scope: RecurrenceScope | null
    oldAmount: number | null
    newAmount: number | null
    reason?: string | null
    changedByEmail?: string | null
  },
): Promise<void> {
  try {
    await supabase.from('job_price_changes').insert({
      user_id: opts.userId,
      job_id: opts.jobId,
      quote_id: opts.quoteId ?? null,
      scope: opts.scope,
      old_amount: opts.oldAmount,
      new_amount: opts.newAmount,
      reason: opts.reason?.trim() || null,
      changed_by_email: opts.changedByEmail ?? null,
    })
  } catch { /* audit log is best-effort */ }
}

// Add an extra service to a set of visits. The caller resolves the scope to the
// concrete target visit ids (this / future-non-completed / all-non-completed);
// when more than one visit is affected the rows share a group_id so the whole
// add-on can later be edited or removed together. Returns the inserted rows.
// THROWS on failure. This is load-bearing, not stylistic: the offline outbox's only
// success signal is "the handler didn't throw" (lib/offline/outbox.ts doFlush), so
// while this swallowed its insert error and returned [], a queued add-on replayed,
// failed, and was deleted from the queue as a success — the contractor sold the work
// and it was never billed, with no trace. An online caller that refetches could
// survive that; a replay engine cannot. Every caller must let this throw or handle it.
export async function addLineItems(
  supabase: SupabaseClient,
  opts: {
    userId: string
    targetJobIds: string[]
    description: string
    amount: number
    serviceKey?: string | null
    serviceType?: string | null
    recurring: boolean
    /** Stable key for a REPLAYED add. See the idempotency note below. */
    groupId?: string | null
  },
): Promise<JobLineItem[]> {
  const ids = [...new Set(opts.targetJobIds.filter(Boolean))]
  if (!ids.length) return []

  // Idempotency for replay. A queued add-on that inserts, then fails its draft
  // re-price, must be retryable — but a retry that mints a NEW group_id looks like a
  // second, distinct add-on and bills the customer twice. So a caller that may be
  // replayed passes a groupId minted ONCE at enqueue time; if rows already carry it,
  // the insert already landed and we return them instead of adding more.
  // (Single-visit adds keep group_id null when no key is supplied, preserving the
  // "grouped == spans multiple visits" meaning the delete/snapshot paths rely on.)
  const groupId = opts.groupId
    ?? (ids.length > 1 && typeof crypto !== 'undefined' && crypto.randomUUID ? crypto.randomUUID() : null)
  if (opts.groupId) {
    const { data: already, error: checkErr } = await supabase
      .from('job_line_items').select('*').eq('group_id', opts.groupId)
    if (checkErr) throw new Error(checkErr.message)
    if (already?.length) return already as JobLineItem[]   // this add already landed
  }

  const rows = ids.map(jobId => ({
    user_id: opts.userId,
    job_id: jobId,
    description: opts.description.trim(),
    amount: Number(opts.amount) || 0,
    service_key: opts.serviceKey ?? normalizeServiceKey(opts.description),
    service_category: serviceCategory(opts.serviceType ?? opts.description),
    group_id: groupId,
    recurring: opts.recurring,
  }))
  const { data, error } = await supabase.from('job_line_items').insert(rows).select('*')
  if (error) throw new Error(error.message)
  return (data as JobLineItem[]) || []
}

// THROWS on failure — same reason as addLineItems. This returned void while reading
// no error, so its caller fired "Removed …" with an Undo button over a row that was
// still there; tapping that Undo then re-inserted a row that had never been deleted.
// (Deleting is naturally idempotent: removing an already-gone row succeeds.)
export async function deleteLineItem(supabase: SupabaseClient, item: JobLineItem): Promise<void> {
  // A grouped (plan-wide) add-on deletes the whole group; a single one deletes itself.
  const { error } = item.group_id
    ? await supabase.from('job_line_items').delete().eq('group_id', item.group_id)
    : await supabase.from('job_line_items').delete().eq('id', item.id)
  if (error) throw new Error(error.message)
}

// Load add-ons for many visits at once, grouped by job_id (newest first within a job).
export async function listLineItemsByJob(
  supabase: SupabaseClient,
  userId: string,
  jobIds: string[],
): Promise<Record<string, JobLineItem[]>> {
  const ids = [...new Set(jobIds.filter(Boolean))]
  const out: Record<string, JobLineItem[]> = {}
  if (!ids.length) return out
  // Chunk the id list. The caller passes EVERY job it loaded, and a season of
  // recurring visits is thousands of uuids — one `in(...)` that long overflows the
  // request URL (HTTP 414) and the whole call fails, which here would silently
  // return {} : every add-on disappears from the day board AND from the draft
  // invoice it should have been billed on. Chunks keep each URL short, and each
  // chunk stays far below PostgREST's silent 1000-row response cap.
  const CHUNK = 200
  const chunks: string[][] = []
  for (let i = 0; i < ids.length; i += CHUNK) chunks.push(ids.slice(i, i + CHUNK))
  const results = await Promise.all(chunks.map(chunk =>
    supabase.from('job_line_items').select('*').eq('user_id', userId).in('job_id', chunk).order('created_at', { ascending: true }),
  ))
  for (const r of results) {
    for (const it of (r.data as JobLineItem[]) || []) (out[it.job_id] ||= []).push(it)
  }
  return out
}
