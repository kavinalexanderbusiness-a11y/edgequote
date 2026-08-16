// ── Reading the audit trail ──────────────────────────────────────────────────
//
// ONE event source, filtered/projected per entity. Customer → History, Job →
// History, Quote → History and the business-wide feed are the SAME query with a
// different filter — there is no second engine, and no surface derives its own
// history from business rows.
//
// This module is I/O-shaped on purpose (the pure phrasing lives in phrase.ts), and
// it obeys two rules the rest of this codebase learned the hard way:
//
//  ⭐ A DROPPED READ IS NOT AN EMPTY HISTORY. supabase-js RESOLVES a failure with
//    `{data: null, error}`, so `data || []` renders a dead connection as "nothing
//    ever happened here" — a claim about the business the data never made. Every
//    load returns { events, failed, reason } and the UI says which it got.
//
//  ⭐ NEVER FETCH EVERY AUDIT RECORD EVER. Reads are keyset-paginated on `seq`
//    (indexed as (user_id, seq desc)), never OFFSET — offset pagination re-scans
//    and, worse, shifts rows between pages as new events arrive.

import type { SupabaseClient } from '@supabase/supabase-js'

/** One row as stored. `before`/`after`/`meta` are curated, never whole rows. */
export interface AuditEvent {
  id: string
  occurred_at: string
  seq: number
  txid: number
  user_id: string
  actor_type: 'owner' | 'worker' | 'customer' | 'system'
  actor_id: string | null
  actor_label: string | null
  action: string
  entity_type: string
  entity_id: string | null
  entity_label: string | null
  customer_id: string | null
  source: string
  before: Record<string, unknown> | null
  after: Record<string, unknown> | null
  meta: Record<string, unknown> | null
}

/**
 * The result of a history read.
 *
 * `failed` is the honest branch: it distinguishes "this record has no history"
 * from "we could not read the history", which are opposite messages.
 */
export interface HistoryLoad {
  events: AuditEvent[]
  /** True when the read itself failed — NOT when the history is genuinely empty. */
  failed: boolean
  /** Human-readable cause, when failed. */
  reason?: string
  /** Cursor for the next page; null when the last page has been reached. */
  nextCursor: number | null
}

export const HISTORY_PAGE = 25

const COLUMNS =
  'id, occurred_at, seq, txid, user_id, actor_type, actor_id, actor_label, action, ' +
  'entity_type, entity_id, entity_label, customer_id, source, before, after, meta'

export interface HistoryFilter {
  /** Scope to one record: a visit, quote, invoice, worker… */
  entity?: { type: string; id: string }
  /** Scope to one customer's whole relationship. */
  customerId?: string
  /** Business feed filters. */
  actorType?: AuditEvent['actor_type']
  actions?: string[]
  /** ISO dates (inclusive from, exclusive to). */
  from?: string
  to?: string
  /** Keyset cursor: return events with seq strictly below this. */
  before?: number
  limit?: number
}

/**
 * Load one page of history.
 *
 * Every filter is applied server-side. RLS scopes rows to the caller's tenant, so
 * the tenant is never a parameter here — a client that could name the tenant is a
 * client that could name someone else's.
 */
export async function loadHistory(
  supabase: SupabaseClient,
  filter: HistoryFilter = {},
): Promise<HistoryLoad> {
  const limit = filter.limit ?? HISTORY_PAGE
  let q = supabase.from('audit_events').select(COLUMNS)

  if (filter.entity) q = q.eq('entity_type', filter.entity.type).eq('entity_id', filter.entity.id)
  if (filter.customerId) q = q.eq('customer_id', filter.customerId)
  if (filter.actorType) q = q.eq('actor_type', filter.actorType)
  if (filter.actions?.length) q = q.in('action', filter.actions)
  if (filter.from) q = q.gte('occurred_at', filter.from)
  if (filter.to) q = q.lt('occurred_at', filter.to)
  if (filter.before != null) q = q.lt('seq', filter.before)

  // One extra row is the cheapest possible "is there more?" — no count, no scan.
  const { data, error } = await q.order('seq', { ascending: false }).limit(limit + 1)

  if (error) {
    return {
      events: [], failed: true, nextCursor: null,
      reason: /does not exist|schema cache/i.test(error.message)
        ? 'The history table is not available on this deployment yet.'
        : error.message,
    }
  }

  const rows = (data ?? []) as unknown as AuditEvent[]
  const page = rows.slice(0, limit)
  return {
    events: page,
    failed: false,
    nextCursor: rows.length > limit ? page[page.length - 1].seq : null,
  }
}

/**
 * Group consecutive events that ONE write produced.
 *
 * ⭐ THE DEDUPLICATION CONTRACT, made structural. The customer timeline had to
 * infer this from a 120-second window because nothing recorded causation; a
 * payment landing and the trigger that flipped its invoice to paid looked like two
 * separate acts, and 56 of 59 paid invoices told the same money twice.
 *
 * `txid` records causation directly, so grouping is exact rather than heuristic:
 * same transaction = one act and its consequences. Two acts a second apart keep
 * their own groups, which is the half a time window always got wrong.
 */
export interface HistoryGroup {
  /** The act itself — the first event of the transaction. */
  lead: AuditEvent
  /** Its mechanical consequences, in order. Often empty. */
  consequences: AuditEvent[]
}

export function groupByWrite(events: AuditEvent[]): HistoryGroup[] {
  const groups: HistoryGroup[] = []
  for (const e of events) {
    const open = groups[groups.length - 1]
    // Events arrive newest-first, so within a transaction the LAST one seen is
    // the act and the earlier-listed ones are its consequences.
    if (open && String(open.lead.txid) === String(e.txid)) {
      open.consequences.unshift(open.lead)
      open.lead = e
      continue
    }
    groups.push({ lead: e, consequences: [] })
  }
  return groups
}
