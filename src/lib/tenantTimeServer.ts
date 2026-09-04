import type { SupabaseClient } from '@supabase/supabase-js'
import { FALLBACK_TIME_ZONE, safeTimeZone, tenantTodayISO } from '@/lib/tenantTime'

// ── The tenant clock, on the server ──────────────────────────────────────────
//
// lib/tenantTime is pure and stays pure; this is its I/O half, the same split as
// lib/pipeline ↔ lib/pipelineData.
//
// ⭐⭐ WHY THE SERVER NEEDS THIS AT ALL. `localTodayISO()` reads the RUNTIME's
// zone — and on Vercel that is UTC, with no TZ set anywhere in next.config.ts or
// vercel.json (checked). So every server component and every cron computed
// "today" in UTC while the browser computed it in the DEVICE's zone. The
// Dashboard renders on the server; the Schedule renders on the client. That is
// the whole mechanism behind them showing different days: not a bug in either
// one, a bug in there being two clocks.
//
// ⛔ Do not "fix" this by setting TZ=America/Edmonton on the deployment. It
// would paper over today's single-market case and be wrong the moment a business
// in another zone signs up — and it would still leave the browser reading the
// device. The zone belongs to the TENANT, not to the process.

/** One tenant's IANA zone. Never throws; falls back rather than guessing wrong. */
export async function loadTenantTimeZone(
  sb: SupabaseClient,
  userId: string,
): Promise<{ timeZone: string; usingFallback: boolean }> {
  const { data, error } = await sb
    .from('business_settings').select('timezone').eq('user_id', userId).maybeSingle()
  // ⚠️ A FAILED READ IS NOT "no zone set". Both end up on the fallback — there is
  // nothing else to render with — but `usingFallback` keeps them distinguishable
  // for anything that wants to say so rather than assert a place.
  const stored = error ? null : (data as { timezone: string | null } | null)?.timezone ?? null
  const timeZone = safeTimeZone(stored)
  return { timeZone, usingFallback: timeZone !== stored }
}

/** THE server-side "what day is it for this business". */
export async function loadTenantToday(sb: SupabaseClient, userId: string): Promise<string> {
  const { timeZone } = await loadTenantTimeZone(sb, userId)
  return tenantTodayISO(timeZone)
}

/**
 * Every tenant's zone in one read — for the CRONS, which sweep all tenants and
 * must not issue a query per business.
 *
 * ⭐⭐ WHY THE CRONS NEED IT. Every cron computed one date, from the server's UTC
 * clock, and applied it to every tenant. `/api/cron/autopay` runs at 02:00 UTC —
 * which is 8pm the PREVIOUS DAY in Alberta — so its "today" was already the
 * owner's tomorrow. A due-date sweep run against tomorrow's date charges a day
 * early, and a "what is on today" digest describes the wrong day.
 */
/** PostgREST's default ceiling. A read that returns exactly this many rows is a
 *  PAGE, never the whole table — the difference is the 1001st tenant. */
export const ZONE_PAGE_ROWS = 1000

/** How many ids ride in one `in.(…)` list. That filter is serialised into the URL,
 *  so an unbounded list from a large sweep becomes a 414 rather than an answer —
 *  which used to surface as "no zones", i.e. every tenant on the fallback. */
export const ZONE_ID_BATCH = 200

export interface TenantZones {
  /** user_id → IANA zone, for every tenant the read actually returned. */
  zones: Map<string, string>
  /** ⛔ FALSE MEANS THE READ FAILED — not "these tenants have no zone". */
  ok: boolean
  error: string | null
}

/**
 * Every requested tenant's zone, paged and batched.
 *
 * ⭐⭐ TWO ABSENCES THAT MUST NEVER LOOK ALIKE.
 *   • A tenant with no `timezone` row/value is a DOCUMENTED FALLBACK: it is missing
 *     from the map, and `todayForTenant` dates it by FALLBACK_TIME_ZONE on purpose.
 *   • A FAILED READ is not that. It also yields tenants missing from the map — and
 *     the old signature could not tell a caller which had happened, so a single
 *     failed query silently moved EVERY tenant onto the fallback calendar day.
 *     Three of the four callers send customer messages off that date.
 * `ok` is the whole point: on false a caller must abort, not date anyone.
 *
 * ⭐ Paged, because the previous version issued one unranged query. PostgREST caps
 * at 1000 rows silently, so tenant 1001 onward resolved to the fallback zone —
 * the same 1001st-owner silent drop `cron/signals` already pages against.
 * `user_id` carries a UNIQUE constraint, so it is already a total order and needs
 * no tiebreak.
 */
export async function loadTenantZones(
  sb: SupabaseClient,
  userIds?: string[],
): Promise<TenantZones> {
  const zones = new Map<string, string>()
  // `null` means "every tenant" — the whole-table sweep two crons still want.
  const batches: (string[] | null)[] = []
  if (userIds) {
    // ⛔ ASKING FOR NOBODY IS NOT ASKING FOR EVERYONE. An empty list used to fall
    // through to the whole-table sweep, so on a quiet night — no signals, no
    // scheduled reports — both callers read every tenant in the book to date a set
    // of zero rows. The honest answer to "the zones of these nought tenants" is an
    // empty map, and it costs no query at all.
    if (userIds.length === 0) return { zones, ok: true, error: null }
    const unique = [...new Set(userIds)]
    for (let i = 0; i < unique.length; i += ZONE_ID_BATCH) batches.push(unique.slice(i, i + ZONE_ID_BATCH))
  } else {
    // `undefined` still means "every tenant" — the whole-table sweep two crons want.
    batches.push(null)
  }

  for (const ids of batches) {
    for (let from = 0; ; from += ZONE_PAGE_ROWS) {
      let q = sb.from('business_settings').select('user_id, timezone')
      if (ids) q = q.in('user_id', ids)
      const { data, error } = await q.order('user_id').range(from, from + ZONE_PAGE_ROWS - 1)
      // ⛔ Return what we have AND say it is partial. Callers must not proceed:
      // a half-read zone map dates the missing half wrong, silently.
      if (error) return { zones, ok: false, error: error.message }
      const rows = (data as { user_id: string; timezone: string | null }[] | null) ?? []
      for (const r of rows) zones.set(r.user_id, safeTimeZone(r.timezone))
      if (rows.length < ZONE_PAGE_ROWS) break
    }
  }
  return { zones, ok: true, error: null }
}

/** The date for one tenant out of a zone map, with the shared fallback. */
export function todayForTenant(zones: Map<string, string>, userId: string, now = new Date()): string {
  return tenantTodayISO(zones.get(userId) ?? FALLBACK_TIME_ZONE, now)
}
