import { createClient, type SupabaseClient } from '@supabase/supabase-js'

// Service-role client for trusted server-to-server work that must read across
// users (e.g. the push-send endpoint, fired by a DB trigger, loads any owner's
// subscriptions). NEVER import this into client code — the key bypasses RLS.
// Returns null when the key isn't configured so callers can degrade gracefully.
export function createAdminClient(): SupabaseClient | null {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!url || !key) return null
  return createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } })
}
