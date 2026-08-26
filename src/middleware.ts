import { NextResponse, type NextRequest } from 'next/server'
import { updateSession } from '@/lib/supabase/middleware'
import { appOrigin } from '@/lib/appOrigin'
import {
  canonicalRedirectTarget, CANON_HOP_COOKIE, CANON_HOP_TTL_SECONDS,
} from '@/lib/canonicalHost'

export async function middleware(request: NextRequest) {
  // ⭐⭐ THE HOST DECISION COMES FIRST — before the session is read, and before
  // anything is written back to the browser.
  //
  // Order is the whole point. The session cookie is host-only, so on a
  // non-canonical host there is nothing to read and nowhere useful to write: an
  // auth read here can only ever answer "signed-out", and acting on that answer
  // is precisely how the owner was shown a login form while holding a perfectly
  // good session on the other hostname. Move the person first; ask who they are
  // once they are somewhere their credentials exist.
  //
  // It also means this redirect has no session to preserve, which is why it does
  // not go through redirectPreservingSession — nothing has refreshed yet. That
  // helper guards the OTHER direction (a redirect issued AFTER a token rotation),
  // and lib/supabase/middleware.ts still holds the only permitted redirect there.
  const requestHost = request.headers.get('x-forwarded-host') ?? request.headers.get('host')
  const target = canonicalRedirectTarget({
    requestHost,
    method: request.method,
    pathname: request.nextUrl.pathname,
    search: request.nextUrl.search,
    // ⚠️ NO request fallback, deliberately. appOrigin(req.origin) would answer
    // with the caller's own host when NEXT_PUBLIC_APP_URL is unset, and a
    // canonical host derived from the request can never disagree with it — the
    // check would silently become a no-op that looks configured. Unset means
    // "this deploy has no canonical host", and the honest response is to serve
    // the request where it landed.
    canonicalOrigin: appOrigin(),
    alreadyHopped: request.cookies.get(CANON_HOP_COOKIE)?.value === '1',
  })

  if (target) {
    const res = NextResponse.redirect(target, { headers: { 'Cache-Control': 'no-store' } })
    // The one-hop cap, written on the host being redirected AWAY from — which is
    // the only host that can present it back to us if this ever redirects in a
    // circle. Ten seconds is long enough to survive the round trip it caps and
    // short enough that it can never suppress a real redirect later.
    res.cookies.set(CANON_HOP_COOKIE, '1', {
      path: '/',
      maxAge: CANON_HOP_TTL_SECONDS,
      httpOnly: true,
      sameSite: 'lax',
      secure: (request.headers.get('x-forwarded-proto') ?? 'https') === 'https',
    })
    return res
  }

  return await updateSession(request)
}

export const config = {
  matcher: [
    '/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp)$).*)',
  ],
}
