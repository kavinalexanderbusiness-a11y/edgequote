import type { SupabaseClient } from '@supabase/supabase-js'

// Owner-side helper: get (or mint) the magic-link token for a customer's portal.
// EXISTING tokens are always reused, so links you've already sent keep working
// forever. NEW tokens use a friendly, readable format — <name-slug>-<random
// suffix>, e.g. "john-smith-A7K4P3MX" — short enough to share, with a random
// suffix so they can't be guessed. The slug part is public-knowable (it's the
// customer's name), so the SUFFIX carries all the security: 8 chars from a
// 30-char alphabet ≈ 6.6×10^11 possibilities — a brute-force is infeasible, and
// this is the only secret protecting the (login-less) portal's data. Same table /
// column / RPC / route as before: get_portal_data(p_token) matches the string.

// Readable suffix alphabet — excludes 0/O/1/I/L to avoid ambiguity when read aloud.
const SUFFIX_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'

function randomSuffix(len = 8): string {
  const bytes = new Uint8Array(len)
  crypto.getRandomValues(bytes)
  let out = ''
  for (let i = 0; i < len; i++) out += SUFFIX_ALPHABET[bytes[i] % SUFFIX_ALPHABET.length]
  return out
}

// "John Smith" → "john-smith". Accent-stripped, lowercased, hyphenated, capped so
// the URL stays short. Falls back to "customer" when the name is empty.
function slugifyName(name: string | null | undefined): string {
  const s = (name || '')
    .normalize('NFKD').replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 32)
    .replace(/-+$/g, '')
  return s || 'customer'
}

export async function ensurePortalToken(supabase: SupabaseClient, userId: string, customerId: string): Promise<string | null> {
  const { data: existing } = await supabase
    .from('customer_portal_tokens')
    .select('token')
    .eq('user_id', userId).eq('customer_id', customerId).eq('revoked', false)
    .limit(1).maybeSingle()
  if (existing?.token) return existing.token as string

  // New token: friendly slug from the customer's name + a random suffix.
  const { data: cust } = await supabase.from('customers').select('name').eq('id', customerId).maybeSingle()
  const slug = slugifyName((cust as { name: string | null } | null)?.name)
  for (let attempt = 0; attempt < 6; attempt++) {
    const token = `${slug}-${randomSuffix(8)}`
    const { error } = await supabase.from('customer_portal_tokens').insert({ token, user_id: userId, customer_id: customerId })
    if (!error) return token
    // 23505 = unique_violation (slug+suffix already taken) → retry a fresh suffix.
    if ((error as { code?: string }).code !== '23505') return null
  }
  return null
}

// Build the absolute portal URL. ALWAYS needs a real origin so links sent by SMS/
// email work — pass the request origin from API routes (most reliable); falls back
// to the browser origin (client) or NEXT_PUBLIC_APP_URL. If none resolve we return
// a relative path rather than a silently-broken "//portal/…".
export function portalUrl(token: string, base?: string): string {
  const origin = (base
    || (typeof window !== 'undefined' ? window.location.origin : '')
    || process.env.NEXT_PUBLIC_APP_URL
    || '').replace(/\/$/, '')
  return `${origin}/portal/${token}`
}
