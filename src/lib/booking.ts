import type { SupabaseClient } from '@supabase/supabase-js'

// ── Online booking link ──────────────────────────────────────────────────────
// One stable per-owner token powers the public /book/<token> instant-quote page.
// Minted on demand (like the portal token) and shareable / embeddable anywhere.

export async function ensureBookingToken(supabase: SupabaseClient, userId: string): Promise<string | null> {
  const { data } = await supabase.from('business_settings').select('booking_token').eq('user_id', userId).maybeSingle()
  const existing = (data as { booking_token: string | null } | null)?.booking_token
  if (existing) return existing
  const token = `${crypto.randomUUID()}${crypto.randomUUID()}`.replace(/-/g, '')
  // UPSERT, not update: an owner with no business_settings row yet would get a
  // zero-row update — which reports no error — and we'd hand back a token that was
  // never stored. The owner then publishes a /book/<token> link that can never
  // resolve, and every lead through it is lost silently. Keyed on unique(user_id).
  const { error } = await supabase.from('business_settings')
    .upsert({ user_id: userId, booking_token: token }, { onConflict: 'user_id' })
  return error ? null : token
}

export function bookingUrl(token: string): string {
  const base = (process.env.NEXT_PUBLIC_APP_URL || (typeof window !== 'undefined' ? window.location.origin : '')).replace(/\/$/, '')
  return `${base}/book/${token}`
}
