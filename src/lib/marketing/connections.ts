import type { SupabaseClient } from '@supabase/supabase-js'
import type { MarketingChannel, SocialConnection } from './types'

// ── Social account connections ────────────────────────────────────────────────────
// CRUD over public.social_connections. The client NEVER selects token columns — those
// are API-mode only and stay server-side. All reads are RLS-scoped to the owner. Every
// read is defensive: if the table hasn't been migrated yet, callers get an empty list
// instead of an error, so the Studio keeps working.

const SAFE_COLS = 'id, created_at, updated_at, user_id, platform, provider, mode, account_id, account_name, account_url, avatar_url, status, meta'

export async function listConnections(supabase: SupabaseClient, userId: string): Promise<SocialConnection[]> {
  try {
    const { data } = await supabase.from('social_connections').select(SAFE_COLS).eq('user_id', userId).order('created_at', { ascending: true })
    return (data as SocialConnection[] | null) || []
  } catch {
    return []
  }
}

// Connect an account manually (the working path today). Real OAuth connects would set
// mode 'api' + provider + account_id + tokens server-side; this is the honest fallback.
export async function connectManual(
  supabase: SupabaseClient,
  userId: string,
  input: { platform: MarketingChannel; accountName: string; accountUrl?: string | null },
): Promise<SocialConnection | null> {
  const { data } = await supabase.from('social_connections').insert({
    user_id: userId,
    platform: input.platform,
    provider: 'manual',
    mode: 'manual',
    account_name: input.accountName.trim() || input.platform,
    account_url: input.accountUrl?.trim() || null,
    status: 'connected',
  }).select(SAFE_COLS).maybeSingle()
  return (data as SocialConnection | null) ?? null
}

export async function disconnect(supabase: SupabaseClient, id: string): Promise<void> {
  await supabase.from('social_connections').delete().eq('id', id)
}

// Group connections by platform (a platform can have several accounts).
export function connectionsByPlatform(connections: SocialConnection[]): Record<MarketingChannel, SocialConnection[]> {
  const out = {} as Record<MarketingChannel, SocialConnection[]>
  for (const c of connections) (out[c.platform] ||= []).push(c)
  return out
}
