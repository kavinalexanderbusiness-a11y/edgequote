import 'server-only'
import type { SupabaseClient } from '@supabase/supabase-js'

// ── AI Vision — cost / abuse protection ───────────────────────────────────────
// Guards the BILLED analyze path (an actual model call). The route only calls
// this AFTER the cache-hit early-return, so free re-opens / unchanged re-analyses
// are never limited. No extra table: every billed analysis inserts exactly one
// property_intelligence row, so its created_at IS the usage ledger.
//
// Two checks, mapping to the two goals:
//   • per-property cooldown  → stops "Re-analyze" spam / accidental double-submit.
//   • per-tenant hourly cap  → bounds an accidental or abusive cost spike.
// Both are generous enough that normal (even onboarding) use never trips them.

export const PER_PROPERTY_COOLDOWN_SEC = 30
export const TENANT_HOURLY_CAP = 60

export interface RateDecision {
  allowed: boolean
  message?: string   // human, shown verbatim in the UI when blocked
}

export async function checkAnalyzeAllowed(
  supabase: SupabaseClient,
  userId: string,
  propertyId: string,
): Promise<RateDecision> {
  const now = Date.now()

  // 1) Per-property cooldown — has THIS property been analyzed in the last window?
  const cooldownSince = new Date(now - PER_PROPERTY_COOLDOWN_SEC * 1000).toISOString()
  const { data: recent } = await supabase
    .from('property_intelligence')
    .select('created_at')
    .eq('user_id', userId)
    .eq('property_id', propertyId)
    .gte('created_at', cooldownSince)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle()
  if (recent?.created_at) {
    const elapsed = (now - new Date(recent.created_at as string).getTime()) / 1000
    const wait = Math.max(1, Math.ceil(PER_PROPERTY_COOLDOWN_SEC - elapsed))
    return { allowed: false, message: `You just analyzed this property — give it about ${wait}s before analyzing again.` }
  }

  // 2) Per-tenant hourly cap — how many analyses across all properties this hour?
  const hourAgo = new Date(now - 3_600_000).toISOString()
  const { count } = await supabase
    .from('property_intelligence')
    .select('id', { count: 'exact', head: true })
    .eq('user_id', userId)
    .gte('created_at', hourAgo)
  if ((count ?? 0) >= TENANT_HOURLY_CAP) {
    return { allowed: false, message: `You've reached the limit of ${TENANT_HOURLY_CAP} analyses in an hour. Please try again a little later — this protects against accidental AI cost spikes.` }
  }

  return { allowed: true }
}
