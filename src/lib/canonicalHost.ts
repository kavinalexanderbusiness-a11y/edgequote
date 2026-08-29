// ── THE host the session lives on ────────────────────────────────────────────
// A cookie belongs to ONE host. Supabase's session cookie is written with no
// Domain attribute — deliberately, and correctly — so it is HOST-ONLY: written
// on app.edgehq.ca, it is invisible to every other hostname in the world,
// including edgehq.ca.
//
// That is only safe if the app is reachable at exactly one hostname. It is not.
// Measured on production 2026-08-26, in ONE browser profile, seconds apart:
//
//   https://app.edgehq.ca/dashboard → dashboard, 2 auth cookies present
//   https://edgehq.ca/dashboard     → /login?next=%2Fdashboard, ZERO cookies
//   https://app.edgehq.ca/dashboard → dashboard again, still signed in
//
// The apex is not a redirect and not a marketing page: it serves a BYTE-IDENTICAL
// copy of the application (same md5 for /login, same deployment), and its `/`
// sends you to /dashboard just like the canonical host does. So it is a fully
// working second front door to the same product that structurally cannot hold a
// session.
//
// ⭐⭐ THAT IS THE BUG THE OWNER REPORTED. "Every time I reopen EdgeHQ on desktop
// it makes me sign in with Google again" is not a session expiring — the session
// was measured surviving a genuine browser quit and relaunch, 400-day cookie
// intact. It is a person whose shortcut, bookmark or address-bar autocomplete
// resolves to edgehq.ca, being shown a login form by a host that never had their
// cookie. Sign-in then finishes on app.edgehq.ca (the OAuth redirectTo is built
// from NEXT_PUBLIC_APP_URL, so it always does), which deposits the session on the
// OTHER host — so the next reopen is signed out again, forever. The loop is
// structural, which is exactly why it happens EVERY time rather than sometimes.
//
// ⛔ WHY NOT `Domain=.edgehq.ca`. It would "fix" this in one line and is the wrong
// answer: it hands the owner's access token to every hostname under the apex,
// forever, including the marketing site and every subdomain nobody has created
// yet. A stolen session on a future blog.edgehq.ca would be a stolen CRM. The
// session stays host-only and pinned to ONE host; what moves is the person.
//
// ⭐ SO: canonicalise the REQUEST, not the cookie. Anything arriving on another
// hostname is sent to the configured origin with its path and query intact,
// before a single byte of auth state is read or written.

import { cleanOrigin, isUsableOrigin } from './appOrigin'

/**
 * Paths that must never be canonicalised.
 *
 * ⚠️⚠️ `/api/` is here because a redirect is invisible to the senders that live
 * there. Stripe, Twilio and Resend are configured with a literal URL in someone's
 * console, they POST to it, and they do not follow 307s — a canonicalised webhook
 * endpoint is a SILENTLY DROPPED webhook, which is a missed payment record rather
 * than a broken page. This repo has already lost webhooks to a domain move once
 * (see the app-origin incident); it will not lose them to this.
 *
 * The OAuth start route lives under /api/ too, and it does its own hop for its own
 * reason — it must canonicalise BEFORE writing PKCE state, which is a stricter
 * requirement than this one and cannot be delegated upward.
 *
 * `/monitoring` is the Sentry tunnel. Machine traffic, same argument.
 */
export const CANONICAL_EXEMPT_PREFIXES = ['/api/', '/monitoring'] as const

/**
 * Hosts where the hostname IS the deployment, so canonicalising is the same as
 * deleting it. A preview deploy redirected to production is a preview deploy you
 * can no longer test; a dev machine redirected to production is worse.
 */
/**
 * Hostnames this product used to live on, and that real customers still hold
 * links to.
 *
 * ⭐ EVIDENCE, not recollection. Measured 2026-08-28 by reading every URL in all
 * 236 rows of `messages.body` on production: 21 sent messages point at
 * `app.edgepropertyservicesyyc.ca`, all of them the SAME shape,
 * `/portal/<token>`. Two more point at the apex `edgehq.ca`, which is attached
 * and already canonicalises correctly. No other retired host, and no other path
 * shape, has ever been sent.
 *
 * ⚠️ THIS LIST CHANGES NOTHING AT RUNTIME, and that is the point.
 * `canonicalRedirectTarget` already moves EVERY non-canonical host, so a retired
 * one needs no special case — a special case is exactly how you end up with two
 * rules that disagree. The list exists so the guard can drive these specific,
 * historically-real hostnames through the real rule and prove a legacy link
 * still lands on its resource with its token intact, and so that reintroducing
 * one into a link builder is a test failure rather than a discovery.
 *
 * ⛔ A host here is NOT trusted, NOT redirected differently, and NEVER a source
 * for a destination — the destination is always the configured origin.
 */
export const RETIRED_APP_HOSTS = [
  // Measured in production message history (21 links).
  'app.edgepropertyservicesyyc.ca',
  // Same retired family. No sent link was found on the bare apex, but it is the
  // parent of a host that WAS used, so naming it keeps it out of link builders.
  'edgepropertyservicesyyc.ca',
] as const

/** Is this a hostname the product has retired? Comparison-normalised. */
export function isRetiredAppHost(host: string | null | undefined): boolean {
  const bare = normalizeHost(host)
  return RETIRED_APP_HOSTS.some(h => bare === h)
}

export function isFixedHost(host: string): boolean {
  if (!host) return true
  const bare = host.replace(/:\d+$/, '')
  if (bare === 'localhost' || bare === '127.0.0.1' || bare === '[::1]' || bare === '::1') return true
  if (bare.endsWith('.localhost')) return true
  // Vercel's own deployment hostnames: every preview, and the project alias.
  if (bare.endsWith('.vercel.app')) return true
  return false
}

/**
 * One spelling of a hostname, so two of them can be COMPARED.
 *
 * Lowercased (Host is case-insensitive), trailing dot removed (the fully-qualified
 * form `app.edgehq.ca.` is the same host), and the default port dropped — a
 * comparison that says `app.edgehq.ca:443` differs from `app.edgehq.ca` produces
 * a redirect to itself, which is the loop this module is most afraid of.
 */
export function normalizeHost(raw: string | null | undefined): string {
  if (!raw) return ''
  return raw.trim().toLowerCase().replace(/\.$/, '').replace(/:(80|443)$/, '')
}

/** The host half of a configured origin, normalised the same way. */
export function canonicalHostOf(origin: string | null | undefined): string {
  const clean = cleanOrigin(origin)
  if (!isUsableOrigin(clean)) return ''
  try { return normalizeHost(new URL(clean).host) } catch { return '' }
}

export interface CanonicalInput {
  /** The address the BROWSER used — x-forwarded-host, else host. */
  requestHost: string | null | undefined
  method: string
  pathname: string
  search: string
  /** appOrigin() — the deploy's own answer for where it lives. */
  canonicalOrigin: string | null | undefined
  /** Has this request already been redirected here once? */
  alreadyHopped: boolean
}

/**
 * Where this request should be sent instead, or null to serve it where it landed.
 *
 * Pure and total, so the whole rule is testable without a server, a browser or a
 * deploy — and so the day somebody widens it, verify:auth-session fails instead of
 * production.
 *
 * ⚠️⚠️ COMPARED ON THE HOST HEADER, NEVER ON `nextUrl.origin`. S108 measured an
 * INFINITE REDIRECT from exactly that mistake: nextUrl.origin is normalised by the
 * framework and is not the address the browser used, so a request already on the
 * canonical host still compared unequal and redirected to itself, indefinitely. An
 * infinite redirect on the front door is far worse than the bug being fixed.
 */
export function canonicalRedirectTarget(input: CanonicalInput): string | null {
  const canonicalOrigin = cleanOrigin(input.canonicalOrigin)
  const canonicalHost = canonicalHostOf(canonicalOrigin)
  // Not configured, or configured with something unusable. Never invent an
  // origin to send a person to — serving them here is always better than
  // guessing a hostname.
  if (!canonicalHost) return null

  // Capped at ONE hop, structurally. Even if the host comparison below is wrong
  // on some platform, the worst case is a single wasted redirect and the original
  // cross-host behaviour — never a hang.
  if (input.alreadyHopped) return null

  const requestHost = normalizeHost(input.requestHost)
  // No Host at all: we cannot tell where this landed, so we do not move it.
  if (!requestHost) return null
  if (requestHost === canonicalHost) return null
  if (isFixedHost(requestHost)) return null

  // ⚠️ GET/HEAD only. A 307 preserves the method, but the senders that POST to
  // this app are machines with a URL in a console, and they do not follow
  // redirects. See CANONICAL_EXEMPT_PREFIXES.
  const method = (input.method || 'GET').toUpperCase()
  if (method !== 'GET' && method !== 'HEAD') return null

  const pathname = input.pathname || '/'
  if (CANONICAL_EXEMPT_PREFIXES.some(p => pathname === p || pathname.startsWith(p))) return null

  // ⛔ THE DESTINATION IS BUILT FROM THE CONFIGURED ORIGIN AND NOTHING ELSE. The
  // request contributes a path and a query string; it does not get a vote on the
  // host. The origin is then re-asserted, so a pathname crafted to look like an
  // authority (`//evil.example`, a scheme, a backslash) cannot walk the URL off
  // this origin — it comes back as a path on our own host or it is refused.
  try {
    const base = new URL(`${canonicalOrigin}/`)
    const target = new URL(`${pathname}${input.search || ''}`, base)
    if (target.origin !== base.origin) return null
    return target.toString()
  } catch {
    return null
  }
}

/**
 * The one-hop marker. A cookie rather than a query parameter: this fires on EVERY
 * navigation, and a `?canon=1` welded onto every URL in the app would be visible
 * in the address bar, carried into bookmarks and shared links, and eventually
 * pasted into a support ticket.
 *
 * Short-lived on purpose — it exists only to survive the single round trip it is
 * capping, and a stale one must never suppress a redirect a minute later.
 */
export const CANON_HOP_COOKIE = 'eq-canon-hop'
export const CANON_HOP_TTL_SECONDS = 10
