import type { SupabaseClient } from '@supabase/supabase-js'
import { readCache, writeCache, clearCache, CACHE_TTL } from '@/lib/clientCache'

// ── Shared analytics dataset ─────────────────────────────────────────────────
// Profitability, Saturation, Neighbors, Weekly Review, Routes, Data Quality… each
// re-issued the SAME jobs(+property join) + quotes + job_recurrences fetch on every
// open. This loads that core ONCE and shares it: a cached, in-flight-deduped result
// so a cross-page hop (or a revisit within the TTL) skips the round-trips entirely.
// Per-page extras (business_settings columns, customers, properties) stay on the page.
// Columns are a SUPERSET of what any consumer needs, so each page reads its subset.

const JOBS_SELECT =
  'id, title, scheduled_date, status, service_type, quote_id, recurrence_id, duration_minutes, ' +
  'actual_minutes, price, customer_id, property_id, customers(name), ' +
  'properties(lat, lng, city, postal_code, neighborhood, lawn_sqft, address)'
const QUOTES_SELECT =
  'id, quote_number, customer_id, customer_name, address, property_id, service_type, status, ' +
  'created_at, total, initial_price, weekly_price, biweekly_price, monthly_price, measured_sqft'
const RECUR_SELECT = 'id, freq, interval_unit, interval_count'

// Loose row types — consumers cast to their own page-local shapes (as today).
export interface AnalyticsRecurrence { id: string; freq: string | null; interval_unit: string | null; interval_count: number | null }
export interface AnalyticsCore {
  jobs: Record<string, unknown>[]
  quotes: Record<string, unknown>[]
  recurrences: AnalyticsRecurrence[]
}

const CACHE_KEY = 'analytics-core'
let inFlight: Promise<AnalyticsCore | null> | null = null

async function fetchCore(supabase: SupabaseClient): Promise<AnalyticsCore | null> {
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return null
  const [jRes, qRes, rRes] = await Promise.all([
    supabase.from('jobs').select(JOBS_SELECT).eq('user_id', user.id),
    supabase.from('quotes').select(QUOTES_SELECT).eq('user_id', user.id),
    supabase.from('job_recurrences').select(RECUR_SELECT).eq('user_id', user.id),
  ])
  return {
    jobs: (jRes.data as unknown as Record<string, unknown>[]) || [],
    quotes: (qRes.data as unknown as Record<string, unknown>[]) || [],
    recurrences: (rRes.data as unknown as AnalyticsRecurrence[]) || [],
  }
}

// Shared cached loader. Returns the cached core when fresh; otherwise fetches once
// (concurrent callers share the single in-flight promise). force=true refetches
// after a mutation. Cache is per-tab session, short TTL so data stays fresh.
export async function loadAnalyticsCore(supabase: SupabaseClient, opts?: { force?: boolean }): Promise<AnalyticsCore | null> {
  if (!opts?.force) {
    const cached = readCache<AnalyticsCore>(CACHE_KEY, CACHE_TTL.short)
    if (cached) return cached
    if (inFlight) return inFlight
  }
  const p = fetchCore(supabase)
    .then(core => { if (core) writeCache(CACHE_KEY, core); return core })
    .finally(() => { if (inFlight === p) inFlight = null })
  if (!opts?.force) inFlight = p
  return p
}

// Call after a page mutates jobs/quotes/recurrences so the next read refetches.
export function invalidateAnalyticsCore() { clearCache(CACHE_KEY) }
