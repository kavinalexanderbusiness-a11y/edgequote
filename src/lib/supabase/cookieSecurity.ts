// ── THE Secure flag on every session cookie this app writes ──────────────────
// Measured on production 2026-08-26, on the live `sb-…-auth-token` chunks:
//
//   secure=false  httpOnly=false  sameSite=Lax  path=/  Max-Age=400d
//
// `secure=false` is @supabase/ssr's default (DEFAULT_COOKIE_OPTIONS names path,
// sameSite, httpOnly and maxAge, and says nothing about Secure), not a decision
// anybody made here. On a site that serves invoices and holds a CRM session it is
// the wrong default, and it is ours to override.
//
// ⚠️ WHAT THIS IS AND IS NOT WORTH. edgehq.ca is HSTS-preloaded with
// includeSubDomains, so a conforming browser will not send these cookies over
// plaintext to app.edgehq.ca in the first place — the practical exposure today is
// small. Secure is what makes that a PROPERTY OF THE COOKIE rather than a
// property of one header staying correct forever: it survives the preload list
// changing, an HSTS max-age lapsing, and a future hostname that never got the
// header. Defence that does not depend on remembering.
//
// ⭐ DERIVED FROM THE CANONICAL ORIGIN, NOT FROM A REQUEST HEADER. The obvious
// implementation reads `x-forwarded-proto`, and that is a header — something an
// attacker can propose. `x-forwarded-proto: http` on a genuine HTTPS request
// would talk this code into writing a NON-Secure session cookie, which is a
// downgrade handed over on request. NEXT_PUBLIC_APP_URL is configuration: it is
// https in production and nothing a caller sends can change it.
//
// This is not a new idea in this codebase — the OAuth start route already writes
// its invite cookie with `secure: origin.startsWith('https://')`. This is that
// same rule, named once, for the cookies that actually hold the session.
//
// ⛔ AND IT MUST STAY FALSE ON PLAIN HTTP. A Secure cookie is simply dropped by
// the browser over http://, so hard-coding `true` would make local development
// and LAN testing on a real phone (http://10.0.0.x:3159 — how the 375/390/430
// checks get run on actual hardware) unable to sign in at all. The scheme of the
// origin the deploy answers on is exactly the right question.

import { appOrigin } from '@/lib/appOrigin'

/**
 * Is this an origin whose cookies can carry the Secure attribute?
 *
 * Case-insensitive because a hand-typed `HTTPS://` is a value a human can enter,
 * and cleaning is already appOrigin's job by the time this is asked.
 */
export function secureForOrigin(origin: string | null | undefined): boolean {
  return typeof origin === 'string' && origin.trim().toLowerCase().startsWith('https://')
}

/**
 * The cookie options every Supabase client in this app is constructed with.
 *
 * Passed as `cookieOptions`, which @supabase/ssr spreads OVER its own defaults
 * and under its forced `maxAge` — so this adds Secure without touching the
 * 400-day lifetime that is what survives a browser restart. Anything else this
 * returns would silently become part of the session cookie's identity, so it
 * returns exactly one thing.
 *
 * @param requestOrigin the caller's own origin, where one is in hand. Used only
 *   as appOrigin's fallback — correct for local dev and preview deploys, where
 *   NEXT_PUBLIC_APP_URL is typically unset.
 */
export function sessionCookieOptions(requestOrigin?: string | null): { secure: boolean } {
  return { secure: secureForOrigin(appOrigin(requestOrigin)) }
}
