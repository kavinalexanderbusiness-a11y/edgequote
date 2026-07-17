import { NextRequest } from 'next/server'
import { createClient, type SupabaseClient } from '@supabase/supabase-js'

// ── Cron guards — THE preamble every scheduled route opens with ──────────────
// Seven cron routes each re-typed the same two things: compare the bearer token
// against CRON_SECRET, then build a service-role client. Same code seven times
// means a fix has to be remembered seven times — so the constant-time compare
// below lives here once instead of being a thing six routes forgot.
//
// The RESPONSES stay with each route: they word their own no-op notes ("Comms
// disabled…", "Set SUPABASE_SERVICE_ROLE_KEY…") and those are part of each
// cron's contract. This only owns the decision, not the reply.

/** Length-safe constant-time compare — a bearer check shouldn't leak the secret
 *  one byte at a time through response timing. */
function timingSafeEqual(a: string, b: string): boolean {
  // Compare a fixed number of bytes regardless of input, so an early mismatch
  // costs the same as a late one. Length is compared without short-circuiting.
  let diff = a.length ^ b.length
  const n = Math.max(a.length, b.length)
  for (let i = 0; i < n; i++) diff |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0)
  return diff === 0
}

/** The bearer token a cron request carries, from either supported place. */
export function cronToken(req: NextRequest): string {
  return req.headers.get('authorization')?.replace('Bearer ', '') || new URL(req.url).searchParams.get('secret') || ''
}

/** Is this a genuine cron invocation? False when CRON_SECRET is unset, so an
 *  unconfigured deploy can never be triggered by a stranger. */
export function cronSecretOk(req: NextRequest): boolean {
  const expected = process.env.CRON_SECRET
  if (!expected) return false
  return timingSafeEqual(cronToken(req), expected)
}

/** A service-role client for reading across every owner. Null when the key isn't
 *  configured — each route decides what to say about that. */
export function serviceClient(): SupabaseClient | null {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const svc = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!url || !svc) return null
  return createClient(url, svc)
}
