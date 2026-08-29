import type { SupabaseClient } from '@supabase/supabase-js'
import { appOrigin, cleanOrigin, isUsableOrigin } from '@/lib/appOrigin'

// Owner-side helper: get (or mint) the magic-link token for a customer's portal.
// EXISTING tokens are always reused, so links you've already sent keep working
// forever. NEW tokens use a friendly, readable format — <name-slug>-<random
// suffix>, e.g. "john-smith-A7K4P3MX" — short enough to share, with a random
// suffix so they can't be guessed. The slug part is public-knowable (it's the
// customer's name), so the SUFFIX carries all the security. Same table / column /
// RPC / route as before: get_portal_data(p_token) matches the string.
//
// ── Suffix length, and why it moved (2026-08-10 public-edge audit) ───────────
// The randomness was never the weak part: this uses crypto.getRandomValues, not
// Math.random. But 8 chars of a 31-char alphabet is ~2^40, and this token is a
// PERMANENT bearer credential — no password, no expiry — for everything the
// portal shows. 2^40 is not brute-forceable over HTTP (at 1,000 guesses/second
// it is ~35 years), so the audit found nothing exploitable and nothing here is
// urgent. It is simply thinner than a credential of that lifetime deserves, and
// widening it is free.
//
// 12 chars ≈ 2^59, which is ~500,000× the work for four more characters. This is
// FORWARD-SAFE ONLY: `ensurePortalToken` returns any existing row untouched, so
// every link already texted to a customer keeps working. Nobody is locked out,
// and no re-send is triggered.
const SUFFIX_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'
const SUFFIX_LEN = 12

function randomSuffix(len = SUFFIX_LEN): string {
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
    const token = `${slug}-${randomSuffix()}`
    const { error } = await supabase.from('customer_portal_tokens').insert({ token, user_id: userId, customer_id: customerId })
    if (!error) return token
    // 23505 = unique_violation (slug+suffix already taken) → retry a fresh suffix.
    if ((error as { code?: string }).code !== '23505') return null
  }
  return null
}

// ── Turning a portal link off ────────────────────────────────────────────────
// `revoked` has been enforced everywhere for a long time — get_portal_data won't
// match a revoked token, and /api/public/portal-access skips revoked rows — but
// until now NOTHING in the app ever set it. The capability existed and was
// unreachable, so an owner whose customer forwarded their link, or who lost a
// phone, had no answer at all. That, not the token's length, was the real gap the
// 2026-08-10 public-edge audit found.
//
// This is deliberately narrow: revoke the links for ONE customer, then mint a
// fresh one on the next `ensurePortalToken`. It is scoped by user_id so it can
// only ever affect the caller's own customer, and it is an UPDATE — the row stays
// for the audit trail rather than being deleted.
//
// Returns false if the write failed, so a caller can tell the owner the truth
// instead of showing a success toast over a link that is still live. (⚠️ the
// house rule from the undo audit: naming the error is not checking it.)
export async function revokePortalAccess(supabase: SupabaseClient, userId: string, customerId: string): Promise<boolean> {
  const { error } = await supabase
    .from('customer_portal_tokens')
    .update({ revoked: true })
    .eq('user_id', userId).eq('customer_id', customerId).eq('revoked', false)
  return !error
}

/** Revoke, then immediately issue a replacement — "reset this customer's link".
 *  Returns the NEW token, or null if either half failed (never the old one). */
export async function rotatePortalToken(supabase: SupabaseClient, userId: string, customerId: string): Promise<string | null> {
  if (!(await revokePortalAccess(supabase, userId, customerId))) return null
  return ensurePortalToken(supabase, userId, customerId)
}

/**
 * Query values a portal link may carry.
 *
 * ⭐ EVERY customer-facing view this product has — a quote, an invoice, a
 * receipt, a payment result, a saved card — is a VIEW OF THE PORTAL reached by
 * a query parameter on this one path, not a route of its own. That is why the
 * production message history contains exactly one link shape. Anything that
 * needs to point a customer at one of those views belongs here, so the shape
 * stays one shape.
 */
export type PortalLinkParams = Record<string, string | number | boolean | null | undefined>

/**
 * THE customer link. Absolute, canonical, token intact.
 *
 * ORIGIN, in order: an explicit `base` the caller trusts, then the browser's own
 * origin on the client, then `appOrigin()` — the configured value. Server code
 * that has a request should pass `appOrigin(req.origin)` rather than the raw
 * request origin, so a customer who arrives on an alias or retired hostname is
 * still sent a link on the canonical one. A link is not a redirect: it gets
 * stored, forwarded and re-opened months later, so it must name the host we
 * intend to be reachable at, not the one this particular request happened to
 * land on.
 *
 * ⭐ THE TOKEN IS ENCODED. Every one of the 69 tokens in production is already
 * URL-safe (measured: the only non-alphanumeric character in use is `-`), so
 * this changes no existing link — which is exactly why it is safe to add. What
 * it closes is the shape where a token containing `/`, `?` or `#` would silently
 * become a different path, a different resource, or a lost credential.
 *
 * If no origin resolves at all we return a RELATIVE path rather than a
 * silently-broken "//portal/…", which a browser reads as protocol-relative and
 * would send to a host named by the token.
 */
export function portalUrl(token: string, base?: string, params?: PortalLinkParams): string {
  // ⛔ A BASE IS NOT A STRING WE CONCATENATE. cleanOrigin tidies a value; it does
  // not judge one, so `//evil.example` or `javascript:alert(1)` used to sail
  // through and become the front of a link posted to a customer's phone.
  // isUsableOrigin is the question cleaning cannot answer, and it is asked of
  // every candidate — including the configured one — before anything is built.
  // ⭐ THE PARSED ORIGIN, not the string. `https://evil.example\@app.edgehq.ca`
  // is a perfectly valid https URL — isUsableOrigin says so, correctly — but
  // concatenating it kept the backslash authority in a link a customer reads,
  // which is the shape a look-alike link is built from. Taking `.origin` throws
  // away everything that is not scheme+host+port, so whatever a caller hands
  // over, what comes back is an origin and a path this module chose.
  const usable = (v: string) => {
    const c = cleanOrigin(v)
    if (!isUsableOrigin(c)) return ''
    try { return new URL(c).origin } catch { return '' }
  }
  const origin = usable(cleanOrigin(base))
    || usable(typeof window !== 'undefined' ? window.location.origin : '')
    || usable(appOrigin())
  const path = `/portal/${encodeURIComponent(token)}`
  const qs = portalQuery(params)
  return `${origin}${path}${qs}`
}

/** The query half, so "?paid=1" is spelled once rather than at each call site. */
function portalQuery(params?: PortalLinkParams): string {
  if (!params) return ''
  const usp = new URLSearchParams()
  for (const [k, v] of Object.entries(params)) {
    // Absent is absent. An empty value would put a bare `?k=` on a customer's
    // link, which reads as a broken link even when it works.
    if (v === undefined || v === null || v === '') continue
    usp.set(k, String(v))
  }
  const s = usp.toString()
  return s ? `?${s}` : ''
}
