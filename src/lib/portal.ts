import type { SupabaseClient } from '@supabase/supabase-js'

// Owner-side helper: get (or mint) the magic-link token for a customer's portal.
// The token is the only secret — long + random so it can't be guessed. Reads go
// through the SECURITY DEFINER get_portal_data RPC, scoped to this customer.
export async function ensurePortalToken(supabase: SupabaseClient, userId: string, customerId: string): Promise<string | null> {
  const { data: existing } = await supabase
    .from('customer_portal_tokens')
    .select('token')
    .eq('user_id', userId).eq('customer_id', customerId).eq('revoked', false)
    .limit(1).maybeSingle()
  if (existing?.token) return existing.token as string
  const token = (crypto.randomUUID() + crypto.randomUUID()).replace(/-/g, '')
  const { error } = await supabase.from('customer_portal_tokens').insert({ token, user_id: userId, customer_id: customerId })
  if (error) return null
  return token
}

export function portalUrl(token: string): string {
  const base = typeof window !== 'undefined' ? window.location.origin : (process.env.NEXT_PUBLIC_APP_URL || '')
  return `${base}/portal/${token}`
}
