import { createServerClient } from '@supabase/ssr'
import { NextResponse, type NextRequest } from 'next/server'
import { resolveAppRole, routeFor, isOwnerPath, isCrewPath, isJoinPath } from '@/lib/crewAccess'
import { readUser } from '@/lib/authState'
import { sessionCookieOptions } from './cookieSecurity'

/**
 * A redirect that KEEPS whatever the session write-back put on the response.
 *
 * ⚠️ This is the bug that signed people out, and it is invisible by inspection.
 * `supabase.auth.getUser()` silently refreshes an expired access token, and the
 * new token pair comes back through the `setAll` hook below — which writes it
 * onto `supabaseResponse`. `NextResponse.redirect()` builds a BRAND NEW response
 * that carries none of it. So on any request that both refreshed AND redirected,
 * the browser was sent away holding the OLD refresh token.
 *
 * Measured against production before the fix, same stale token, two paths:
 * `/dashboard` (no redirect) answered with a fresh `sb-…-auth-token`; `/login`
 * (redirect) answered with NO Set-Cookie at all — having rotated the token
 * server-side regardless.
 *
 * What that costs, stated precisely, because the failure is a drift rather than
 * a bang. Rotation IS on: every refresh mints a new token. A rotated-away token
 * was measured as still ACCEPTED afterwards, and replaying one did NOT revoke
 * the session — so a single dropped rotation does not sign anyone out on the
 * spot. The damage is that the browser never ADVANCES: it re-presents the same
 * ageing token on every subsequent request, refreshing again and again into a
 * response nobody keeps. The session stops being renewed while appearing to be,
 * and is stranded the moment that stale token finally stops being honoured —
 * with no way back but the login form.
 *
 * Every redirect out of this file must go through here. verify:auth-session
 * fails the build if a bare `NextResponse.redirect(` reappears.
 */
export function redirectPreservingSession(url: URL, carrying: NextResponse): NextResponse {
  const redirected = NextResponse.redirect(url)
  for (const cookie of carrying.cookies.getAll()) redirected.cookies.set(cookie)
  return redirected
}

export async function updateSession(request: NextRequest) {
  let supabaseResponse = NextResponse.next({ request })

  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      // ⭐ Every refresh this middleware performs rewrites the session cookie, so
      // it is one of the places the Secure flag has to be set — omit it here and a
      // token rotation quietly downgrades a cookie the callback wrote correctly.
      cookieOptions: sessionCookieOptions(request.nextUrl.origin),
      cookies: {
        getAll() {
          return request.cookies.getAll()
        },
        setAll(cookiesToSet: { name: string; value: string; options?: Record<string, unknown> }[]) {
          cookiesToSet.forEach(({ name, value }) =>
            request.cookies.set(name, value)
          )
          supabaseResponse = NextResponse.next({ request })
          cookiesToSet.forEach(({ name, value, options }) =>
            supabaseResponse.cookies.set(name, value, options)
          )
        },
      },
    }
  )

  // THREE answers, not two — see lib/authState. `unavailable` means the auth
  // server could not be reached or would not answer; it is NOT a sign-out, and
  // the one thing this middleware must never do is turn a dropped connection
  // into a login screen.
  const auth = await readUser(supabase)
  const user = auth.kind === 'signed-in' ? auth.user : null
  const pathname = request.nextUrl.pathname

  // Could not ASK. Pass the request through untouched, carrying the session
  // cookies exactly as they arrived. The page's own server gate makes the same
  // three-way distinction and renders "couldn't reach the server, try again"
  // rather than either the dashboard or the login form — so an unverifiable
  // request still reads no data, and a legitimate session still survives.
  if (auth.kind === 'unavailable') return supabaseResponse

  // ── Which half of the app? ─────────────────────────────────────────────────
  // The owner's CRM (/dashboard) and Crew Mode (/crew) are different products
  // for different people. The role comes from the database — current_app_role()
  // — never from a cookie or a claim we could be handed.
  //
  // The extra round-trip is paid ONLY on the two private trees plus /login, and
  // only for a signed-in user. Everything else (the customer portal, public
  // booking, the marketing pages, static assets) skips it entirely, so the
  // token-based surfaces are exactly as fast and exactly as unauthenticated as
  // they were.
  //
  // ⚠️ This is routing, not security. A crew session that reached /dashboard
  // anyway would render an empty CRM: RLS returns them no customers, no quotes,
  // no invoices, no settings. The redirect is so nobody has to find that out.
  const gated = isOwnerPath(pathname) || isCrewPath(pathname) || pathname === '/login'
  if (gated) {
    const role = user ? await resolveAppRole(supabase) : 'none'
    const target = routeFor(role, pathname, !!user)
    if (target && target !== pathname) {
      const url = request.nextUrl.clone()
      url.pathname = target
      url.search = ''
      // Sending someone to sign in must not lose where they were going. A crew
      // member follows a join link, gets bounced to /login, and would otherwise
      // land on the owner's dashboard afterwards — which, for an account with no
      // business yet, means the first-run /setup flow and an accidental empty
      // business. Carry the destination so sign-in returns them to it.
      if (target === '/login' && pathname !== '/login') url.searchParams.set('next', pathname)
      return redirectPreservingSession(url, supabaseResponse)
    }
    // A signed-in user who is not linked yet may only be at /crew/join; every
    // other crew path already redirected there above.
    if (user && isJoinPath(pathname)) return supabaseResponse
  }

  return supabaseResponse
}
