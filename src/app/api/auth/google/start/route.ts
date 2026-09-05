import { NextRequest, NextResponse } from 'next/server'
import { createServerClient } from '@supabase/ssr'
import { sessionCookieOptions } from '@/lib/supabase/cookieSecurity'
import { appOrigin } from '@/lib/appOrigin'
import { BETA_TOKEN_RE } from '@/lib/betaInvite'
import { INTENT_PARAM, REGISTER_INTENT } from '@/lib/registration'
import {
  GOOGLE_PROVIDER, GOOGLE_SCOPES, AUTH_ERROR_PARAM,
  OAUTH_INVITE_COOKIE, OAUTH_INVITE_TTL_SECONDS, OAUTH_START_PATH, OAUTH_REGISTER_COOKIE,
  buildCallbackUrl, safeReturnPath,
} from '@/lib/googleAuth'

// PKCE writes a verifier cookie; a cached redirect would hand the next visitor
// somebody else's half-finished handshake.
export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

// ── GET /api/auth/google/start ───────────────────────────────────────────────
// Begins the Google round trip. A plain link points here, so the button works
// before (or without) the page's JavaScript, and so the two cookies this flow
// needs — the PKCE verifier and the invite handshake — are written by the very
// response that redirects to Google.
//
//   ?next=/crew        where to land afterwards. Validated HERE and again on the
//                      way back; it is attacker-controllable at both ends.
//   ?invite=eqb_…      an in-flight private-beta invite. Moved OUT of the URL
//                      into an httpOnly cookie immediately — see below.
//
// ⭐ WHY THE INVITE TOKEN BECOMES A COOKIE. It cannot ride the Google round trip
// in the URL: `redirectTo` must sit on Supabase's Redirect URL allow list, the
// token would land in Google's logs, in the browser's history and in any
// referrer header on the way back, and the brief for this feature says plainly
// that entitlements do not travel in URLs. httpOnly means no script of ours or
// anybody else's can read it back out; SameSite=Lax is what lets it survive the
// top-level GET navigation home from Google (Strict would drop it and quietly
// break every legitimate invited owner).
//
// ⭐ THE TOKEN IS NOT VALIDATED HERE, only shape-checked. Validating an invite at
// the START of a round trip proves nothing about its state at the END of one —
// it can expire, be revoked or be redeemed by somebody else while the person is
// looking at Google's consent screen. The authoritative check happens at binding
// time in the callback, against the row, atomically. Checking here as well would
// be a second answer to a settled question, and the wrong one to trust.

export async function GET(req: NextRequest): Promise<NextResponse> {
  const origin = appOrigin(req.nextUrl.origin)
  const next = safeReturnPath(req.nextUrl.searchParams.get('next'))
  const rawInvite = req.nextUrl.searchParams.get('invite') ?? ''
  const invite = BETA_TOKEN_RE.test(rawInvite) ? rawInvite : null
  // The sign-up page's stated intent to register. Shape-checked only, like the
  // invite: it authorizes nothing — the callback still asks the database.
  const registerIntent = req.nextUrl.searchParams.get(INTENT_PARAM) === REGISTER_INTENT

  const failure = (code: string) =>
    NextResponse.redirect(`${origin}/login?${AUTH_ERROR_PARAM}=${code}`, {
      headers: { 'Cache-Control': 'no-store' },
    })

  // ⭐⭐ THE ROUND TRIP MUST BEGIN ON THE HOST IT WILL END ON.
  //
  // PKCE's verifier is written below as a cookie with NO Domain attribute, so it
  // is HOST-ONLY. `redirectTo` is built from appOrigin(), which deliberately
  // prefers the configured NEXT_PUBLIC_APP_URL over the request — correct for
  // every emailed link, and correct for keeping one canonical origin.
  //
  // Those two facts fight each other the moment somebody starts here on an alias
  // host. edgehq.ca is a live alias that serves /login, so this is a route a real
  // person takes: the verifier is stored on edgehq.ca, the provider returns to
  // app.edgehq.ca/auth/callback, the browser sends no verifier to a host that
  // never received one, and the exchange fails with nothing to exchange against.
  // Measured on production 2026-08-26 — it is the "sign-in could not be
  // completed" a real owner hit after the Site URL repair.
  //
  // ⭐ The fix is to move BEFORE writing any state, not to loosen redirectTo.
  // Sending the browser to the canonical host first means cookie and callback
  // agree by construction, and appOrigin keeps its contract — the request's Host
  // still never decides where the provider returns to.
  //
  // ⚠️⚠️ COMPARED ON THE HOST HEADER, NOT `req.nextUrl.origin`. The obvious
  // version of this check used nextUrl.origin and LOOPED FOREVER — measured, not
  // feared: a request whose Host already WAS the configured origin still compared
  // unequal and redirected to itself, indefinitely. nextUrl.origin is normalised
  // by the framework and is not the address the browser used. An infinite
  // redirect on the sign-in door is far worse than the bug being fixed.
  //
  // ⭐ AND CAPPED AT ONE HOP by `canon`, so a loop is structurally impossible even
  // if the host comparison is wrong on some platform. Worst case then is a single
  // wasted redirect and the original cross-host failure — never a hang.
  const canonicalHost = (() => { try { return new URL(origin).host.toLowerCase() } catch { return '' } })()
  const requestHost = (req.headers.get('x-forwarded-host') ?? req.headers.get('host') ?? '')
    .trim().toLowerCase()
  const alreadyHopped = req.nextUrl.searchParams.get('canon') === '1'
  if (canonicalHost && requestHost && requestHost !== canonicalHost && !alreadyHopped) {
    const canonical = new URL(`${origin}${OAUTH_START_PATH}`)
    canonical.search = req.nextUrl.search
    canonical.searchParams.set('canon', '1')
    return NextResponse.redirect(canonical, { headers: { 'Cache-Control': 'no-store' } })
  }

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const key = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY
  if (!url || !key) return failure('unavailable')

  // The cookie jar pattern from lib/supabase/middleware: collect what the client
  // wants to write, then put it on the response WE return. Letting the adapter
  // write straight through and then building a fresh NextResponse.redirect is
  // exactly how this codebase lost refreshed sessions once already — a redirect
  // is a NEW response and carries none of it.
  const jar: { name: string; value: string; options?: Record<string, unknown> }[] = []
  const supabase = createServerClient(url, key, {
    // The PKCE verifier is a secret half of a handshake and gets the same
    // treatment as the session itself.
    cookieOptions: sessionCookieOptions(req.nextUrl.origin),
    // PKCE is @supabase/ssr's default; stated outright because it is the thing
    // that makes a stolen or replayed authorization code useless without the
    // verifier cookie that only this browser holds.
    auth: { flowType: 'pkce' },
    cookies: {
      getAll: () => req.cookies.getAll(),
      setAll: (toSet: { name: string; value: string; options?: Record<string, unknown> }[]) => {
        jar.push(...toSet)
      },
    },
  })

  const { data, error } = await supabase.auth.signInWithOAuth({
    provider: GOOGLE_PROVIDER,
    options: {
      redirectTo: buildCallbackUrl(origin, next),
      scopes: GOOGLE_SCOPES,
    },
  })
  // No console.* in this file: the URL below carries the PKCE challenge, and a
  // logged handshake is a handshake in a log aggregator.
  if (error || !data?.url) return failure('unavailable')

  const res = NextResponse.redirect(data.url, { headers: { 'Cache-Control': 'no-store' } })
  for (const c of jar) res.cookies.set(c.name, c.value, c.options)
  if (invite) {
    res.cookies.set(OAUTH_INVITE_COOKIE, invite, {
      httpOnly: true,
      sameSite: 'lax',
      secure: origin.startsWith('https://'),
      path: '/',
      maxAge: OAUTH_INVITE_TTL_SECONDS,
    })
  }
  if (registerIntent) {
    res.cookies.set(OAUTH_REGISTER_COOKIE, '1', {
      httpOnly: true,
      sameSite: 'lax',
      secure: origin.startsWith('https://'),
      path: '/',
      maxAge: OAUTH_INVITE_TTL_SECONDS,
    })
  }
  return res
}
