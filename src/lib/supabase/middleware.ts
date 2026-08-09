import { createServerClient } from '@supabase/ssr'
import { NextResponse, type NextRequest } from 'next/server'
import { resolveAppRole, routeFor, isOwnerPath, isCrewPath, isJoinPath } from '@/lib/crewAccess'

export async function updateSession(request: NextRequest) {
  let supabaseResponse = NextResponse.next({ request })

  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
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

  const { data: { user } } = await supabase.auth.getUser()
  const pathname = request.nextUrl.pathname

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
      return NextResponse.redirect(url)
    }
    // A signed-in user who is not linked yet may only be at /crew/join; every
    // other crew path already redirected there above.
    if (user && isJoinPath(pathname)) return supabaseResponse
  }

  return supabaseResponse
}
