import { NextRequest, NextResponse } from 'next/server'
import { createServerClient } from '@supabase/ssr'
import { sessionCookieOptions } from '@/lib/supabase/cookieSecurity'
import { appOrigin } from '@/lib/appOrigin'
import { landingFor, OWNER_ROOT, type AppRole } from '@/lib/crewAccess'
import { readUser } from '@/lib/authState'
import { bindBetaInviteToGoogleUser } from '@/lib/googleAuthServer'
import { SETUP_REGISTER_PATH, parseProvisioningStatus } from '@/lib/registration'
import {
  AUTH_ERROR_PARAM, OAUTH_INVITE_COOKIE, OAUTH_REGISTER_COOKIE,
  classifyProviderError, safeReturnPath, hasPkceVerifier, type GoogleAuthError,
} from '@/lib/googleAuth'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

// ── GET /auth/callback — where Google sends the browser back ─────────────────
// The PKCE code exchange, and then exactly one question: what is this account
// actually allowed to do? Authentication is finished by the time this route
// runs; everything below is authorization, and all of it is asked of the
// DATABASE about auth.uid() — never of the browser, never of Google's profile
// payload, never of a query parameter.
//
// THE CONTRACT
// · The session cookies written by the exchange ride on EVERY response out of
//   here. NextResponse.redirect() builds a new response carrying none of them,
//   which is precisely how this codebase stranded sessions once before
//   (lib/supabase/middleware.redirectPreservingSession). One jar, applied last.
// · A failure NEVER leaves a half-made account behind. Where the account has no
//   entitlement at all, the session is signed out — LOCALLY, scope:'local',
//   because a global sign-out would revoke this person's other devices, and a
//   verify script doing exactly that is what caused the 2026-08-12 sign-out
//   incident.
// · "Could not ask" is not "no". A failed RPC produces 'unavailable' and KEEPS
//   the session, the same three-answer discipline as lib/authState.
// · No console.* in this file. The URL carries an authorization code.
//
// ⛔ WHAT THIS ROUTE CANNOT DO: it cannot create a business, it cannot link a
// technician, and it cannot grant platform capability. The single write it is
// capable of is redeeming ONE beta invite that the person already held the token
// for, onto the uid the provider just proved.

const CLEARED = { maxAge: 0, path: '/' }

export async function GET(req: NextRequest): Promise<NextResponse> {
  const origin = appOrigin(req.nextUrl.origin)
  const params = req.nextUrl.searchParams
  const next = safeReturnPath(params.get('next'))
  const inviteToken = req.cookies.get(OAUTH_INVITE_COOKIE)?.value ?? null
  // Did THIS round trip start from the public sign-up page? A sign-in never
  // carries it, and a sign-in never creates a business (S110 §4.1).
  const registerIntent = req.cookies.get(OAUTH_REGISTER_COOKIE)?.value === '1'

  const jar: { name: string; value: string; options?: Record<string, unknown> }[] = []
  const send = (path: string) => {
    const res = NextResponse.redirect(`${origin}${path}`, { headers: { 'Cache-Control': 'no-store' } })
    for (const c of jar) res.cookies.set(c.name, c.value, c.options)
    // The handshake cookie is single-use by construction: it is cleared on every
    // exit from this route, success or failure, so an abandoned attempt cannot
    // leave an entitlement sitting in the browser for the next person.
    res.cookies.set(OAUTH_INVITE_COOKIE, '', CLEARED)
    res.cookies.set(OAUTH_REGISTER_COOKIE, '', CLEARED)
    return res
  }
  const fail = (code: GoogleAuthError) => send(`/login?${AUTH_ERROR_PARAM}=${code}`)

  // ── The provider's own verdict ────────────────────────────────────────────
  // A cancelled consent screen comes back here as ?error=access_denied with no
  // code. It is the single most common non-happy path and it is not an error in
  // any sense the person needs explaining — they pressed Cancel.
  const providerError = params.get('error') ?? params.get('error_code')
  if (providerError) return fail(classifyProviderError(params.get('error')))

  const code = params.get('code')
  if (!code) return fail('exchange')

  // ⭐ ASKED BEFORE THE EXCHANGE, because afterwards it is unanswerable. A
  // missing verifier and a spent code are the SAME error out of
  // exchangeCodeForSession, and they need opposite advice: "finish in the browser
  // you started in" versus "that link is used up, start again". Distinguishing
  // them here is what turns the 2026-08-26 production failure from an
  // uninformative retry loop into a sentence that names what to do.
  //
  // The start route now canonicalises the host before writing this cookie, so a
  // legitimate flow always arrives holding one. Reaching this line therefore
  // means something genuinely unusual — a cleared jar, a cross-device paste, a
  // third-party-cookie policy — and none of those are helped by "try again".
  if (!hasPkceVerifier(req.cookies.getAll().map(c => c.name))) return fail('no-verifier')

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const key = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY
  if (!url || !key) return fail('unavailable')

  const supabase = createServerClient(url, key, {
    auth: { flowType: 'pkce' },
    // The exchange below WRITES the session. This is the single most important
    // place for the Secure flag, because it is where the cookie is born.
    cookieOptions: sessionCookieOptions(req.nextUrl.origin),
    cookies: {
      getAll: () => req.cookies.getAll(),
      setAll: (toSet: { name: string; value: string; options?: Record<string, unknown> }[]) => {
        jar.push(...toSet)
      },
    },
  })

  // ⭐ THE exchange. This is what a replayed callback fails on: an authorization
  // code is single-use at the provider, and the PKCE verifier lives in an
  // httpOnly cookie that only the browser which STARTED the flow holds. A forged
  // or copied `code` therefore has nothing to exchange with. No special-casing
  // is needed for replay or forgery — they arrive here as the same ordinary
  // error, and are told the same uninformative thing.
  const { error: exchangeError } = await supabase.auth.exchangeCodeForSession(code)
  if (exchangeError) return fail('exchange')

  // Who the session belongs to, read through lib/authState rather than off the
  // exchange payload — the same three-answer primitive every other gate in the
  // app uses. It matters here for the same reason it matters there: a dropped
  // connection immediately after a successful exchange must read as "could not
  // ask" and keep the session, not as "nobody" and throw the person away.
  const auth = await readUser(supabase)
  if (auth.kind === 'unavailable') return fail('unavailable')
  if (auth.kind === 'signed-out') return fail('exchange')
  const user = auth.user

  // Sign this session out and send them back with an explanation. LOCAL scope,
  // always: this person may legitimately be signed in elsewhere, and a failed
  // Google attempt is no reason to end those sessions.
  const abandon = async (reason: GoogleAuthError) => {
    await supabase.auth.signOut({ scope: 'local' }).catch(() => {})
    return fail(reason)
  }

  // ── Which half of the app does the DATABASE say this is? ──────────────────
  // current_app_role() — the same STABLE SECURITY DEFINER function the
  // middleware and the login form already use. Asked directly rather than
  // through resolveAppRole because that helper fails closed to 'none', and
  // 'none' is a state this route can act destructively on. A transient database
  // error must not be able to sign a real owner out of their own login.
  const { data: roleData, error: roleError } = await supabase.rpc('current_app_role')
  if (roleError) return fail('unavailable')
  const role: AppRole = roleData === 'owner' || roleData === 'crew' ? roleData : 'none'

  // ── The invited owner's binding ───────────────────────────────────────────
  // Only for an account that is not already an owner: somebody who has a
  // business does not need an invite redeemed, and quietly spending a second one
  // on them would consume a licence nobody asked to consume.
  let bound = false
  if (inviteToken && role !== 'owner') {
    const outcome = await bindBetaInviteToGoogleUser(inviteToken, user)
    if (outcome.ok) {
      bound = true
    } else if (outcome.reason === 'unavailable') {
      // Could not ask. Keep the session; the invite is untouched and a retry
      // from the same link works.
      return fail('unavailable')
    } else if (role === 'none') {
      // Nothing else entitles this account to anything, and the invite would not
      // bind. Leaving them signed in would drop them on /setup to be refused by
      // the business_settings policy with no explanation.
      return abandon(outcome.reason)
    }
    // role === 'crew' with a failed binding falls through: they already have
    // their own access, and the stray invite changes nothing about it.
  }

  // ── Destination ───────────────────────────────────────────────────────────
  if (role === 'crew' || role === 'owner') return send(next ?? landingFor(role))

  // role 'none'. Either a brand-new owner who just bound an invite (or bound one
  // on an earlier visit and never finished /setup), or an account with no
  // entitlement whatsoever.
  if (bound) return send(next ?? OWNER_ROOT)

  // ⭐ THE beta gate, asked of the database rather than inferred. This is the
  // same predicate the business_settings INSERT policy carries, so the answer
  // here and the answer at the moment of tenant creation cannot drift apart.
  const { data: canProvision, error: provisionError } = await supabase.rpc('can_provision_business')
  if (provisionError) return fail('unavailable')
  // ⭐ Licensed is not the same as registering. The word says WHICH licence:
  // an invite is a stated intent (they opened the link they were sent) and
  // lands on /setup as it always has; the self-service licence lands there
  // only when this round trip began on the sign-up page. A verified stranger
  // who pressed "Sign in with Google" is signed out and told how to sign up —
  // no business is created by a sign-in, ever.
  const { data: statusData, error: statusError } = await supabase.rpc('provisioning_status')
  if (statusError) return fail('unavailable')
  const status = parseProvisioningStatus(statusData)
  if (canProvision === true) {
    if (status === 'invited' || status === 'already-owner') return send(next ?? OWNER_ROOT)
    if (status === 'self-service' && registerIntent) return send(SETUP_REGISTER_PATH)
    return abandon('not-registered')
  }

  // Authenticated, and entitled to nothing. This is the ordinary outcome for a
  // stranger who found the login page, and it must stay ordinary: no business is
  // created, no invite is consumed, no capability is granted, and the account is
  // not left signed in to a product it has no place in.
  //
  // One case is nobody's fault and says so: public registration exists but is
  // switched off. The database names it; every other answer keeps the old word.
  if (registerIntent && status === 'closed') return abandon('closed')
  return abandon('no-invite')
}
