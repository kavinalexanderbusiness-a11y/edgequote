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
export async function loadTenantZones(
  sb: SupabaseClient,
  userIds?: string[],
): Promise<Map<string, string>> {
  let q = sb.from('business_settings').select('user_id, timezone')
  if (userIds && userIds.length) q = q.in('user_id', userIds)
  const { data, error } = await q
  const out = new Map<string, string>()
  if (error) return out   // caller decides; an empty map means "ask again", not "UTC"
  for (const r of (data as { user_id: string; timezone: string | null }[]) || []) {
    out.set(r.user_id, safeTimeZone(r.timezone))
  }
  return out
}

/** The date for one tenant out of a zone map, with the shared fallback. */
export function todayForTenant(zones: Map<string, string>, userId: string, now = new Date()): string {
  return tenantTodayISO(zones.get(userId) ?? FALLBACK_TIME_ZONE, now)
}
