// ── THE auth read: three answers, never two ──────────────────────────────────
// "Is somebody signed in?" has THREE honest answers, and collapsing them into
// two is what randomly threw a working owner back to the login screen.
//
//   · signed-in   — the auth server verified this session. Proceed.
//   · signed-out  — the auth server ANSWERED, and the answer is no: there is no
//                   token, or the token it was handed is expired, revoked or
//                   forged. This is the ONLY state that may force a login.
//   · unavailable — we could not ASK. A dropped connection on a phone changing
//                   cell towers, a 5xx, a rate-limited burst, a timeout. We know
//                   nothing about this session, and "I don't know" is not "no".
//
// `supabase.auth.getUser()` RESOLVES with `{ data: { user: null }, error }` on a
// dead connection — it does not throw — so the two failures arrive in the same
// shape and the near-universal destructure
//
//     const { data: { user } } = await supabase.auth.getUser()
//     if (!user) redirect('/login')
//
// reads a network blip as a verdict. Every gate in the app was written that way.
// The signal was measured in production: 198 of the 24h `/auth/v1/user` calls
// came back 403 and every one of them was indistinguishable, at the call site,
// from "this person is a stranger".
//
// ⚠️ THIS IS NOT A SECURITY RELAXATION. `unavailable` never grants access to a
// single row. It only forbids DESTROYING a session we failed to read. A caller
// holding `unavailable` still has no `user.id`, so it can query nothing, and RLS
// — the real boundary — is untouched either way. The difference is only whether
// a contractor in a parkade gets their dashboard back when signal returns, or
// gets a login form and a lost session.
//
// Note that a request carrying NO cookie never reaches the network at all:
// supabase-js answers AuthSessionMissingError locally. So `unavailable` is
// reachable only for somebody who presented a credential we could not check —
// never for an anonymous visitor. (See classifyAuthError.)

import {
  isAuthRetryableFetchError,
  isAuthSessionMissingError,
  type AuthError,
  type SupabaseClient,
  type User,
} from '@supabase/supabase-js'

export type AuthRead =
  | { kind: 'signed-in'; user: User }
  | { kind: 'signed-out' }
  | { kind: 'unavailable'; reason: string }

export type AuthVerdict = 'signed-out' | 'unavailable'

/**
 * THE load-bearing predicate. Given whatever `getUser()` put on `error` when it
 * produced no user, decide whether the auth server ANSWERED "no" or failed to
 * answer at all.
 *
 * Pure and total, so the whole contract is testable without a browser, a session
 * or a network — and so a future edit that turns a transient failure back into a
 * sign-out fails scripts/verify-auth-session.ts instead of a customer's phone.
 *
 * The default is deliberately `unavailable`. An unrecognised failure is a failure
 * we cannot justify signing somebody out over, and choosing `unavailable` cannot
 * leak anything: it grants nothing, it only preserves a cookie we might still be
 * able to verify a second from now.
 */
export function classifyAuthError(error: AuthError | null | undefined): AuthVerdict {
  // No error and no user: the client resolved the question locally and the
  // answer is genuinely "nobody".
  if (!error) return 'signed-out'

  // No token was presented at all. Raised client-side, without a round trip.
  if (isAuthSessionMissingError(error)) return 'signed-out'

  // supabase-js's own name for "the request never completed" — DNS, TLS, abort,
  // offline. The single most common shape on mobile.
  if (isAuthRetryableFetchError(error)) return 'unavailable'

  const status = typeof error.status === 'number' ? error.status : 0
  switch (status) {
    // The auth server looked at the credential and REJECTED it: expired,
    // revoked, tampered with, or a refresh token that has already been rotated
    // away (400 `refresh_token_not_found`). A real sign-out. Password changes and
    // explicit global revocations land here, which is exactly how they must
    // continue to behave.
    case 400:
    case 401:
    case 403:
    case 422:
      return 'signed-out'
    default:
      // 0 (no transport), 408, 429, 5xx and anything unrecognised: we did not
      // get a verdict, so we do not invent one.
      return 'unavailable'
  }
}

/** A short, non-secret description for logs and the retry surface. Never
 *  includes a token, a cookie or an email. */
export function describeAuthFailure(error: AuthError | null | undefined): string {
  if (!error) return 'unknown'
  const status = typeof error.status === 'number' && error.status > 0 ? ` (${error.status})` : ''
  return `${error.name}${status}`
}

/**
 * Ask who this request belongs to, and keep the three answers apart.
 *
 * Every server gate should call THIS rather than destructuring `getUser()`, so
 * there is one place where the distinction is made and one place to get it
 * wrong. A throw is caught and reported as `unavailable` for the same reason a
 * fetch failure is: an exception is not a verdict either.
 */
export async function readUser(supabase: SupabaseClient): Promise<AuthRead> {
  try {
    const { data, error } = await supabase.auth.getUser()
    if (data?.user) return { kind: 'signed-in', user: data.user }
    return classifyAuthError(error) === 'signed-out'
      ? { kind: 'signed-out' }
      : { kind: 'unavailable', reason: describeAuthFailure(error) }
  } catch (e) {
    return { kind: 'unavailable', reason: e instanceof Error ? e.name : 'threw' }
  }
}
