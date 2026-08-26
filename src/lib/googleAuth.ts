// ── Continue with Google: the shared contract ────────────────────────────────
// Pure helpers only. The service role, the invite lookup and the code exchange
// live in the server routes (src/app/api/auth/google/start, src/app/auth/callback)
// — the same split as crewInvite.ts and betaInvite.ts, and for the same reason:
// nothing in this file can pull an admin credential into a client bundle, and
// every rule below can be asserted by verify:google-auth without a browser, a
// session or a database.
//
// WHAT SIGNING IN WITH GOOGLE MEANS HERE — and what it does not.
//
// Google proves ONE thing: that the person controls a mailbox. It does not make
// them an EdgeHQ owner, it does not grant beta access, it does not create a
// business, and it does not make them anybody's employee. Every one of those
// remains a DATABASE decision keyed on auth.uid():
//
//   · a business needs can_provision_business() — current_app_role() = 'owner'
//     OR a beta_invites row already redeemed_by THIS uid. A brand-new Google
//     account satisfies neither, so the business_settings INSERT policy refuses
//     it. That is not a check this feature adds; it is a check this feature is
//     careful not to weaken.
//   · crew access needs technicians.auth_user_id = THIS uid, written only by
//     crew_redeem_invite() (a code the owner handed out) or by the owner's own
//     invite route. A Google identity cannot write it.
//
// ⭐ THE CONSEQUENCE WORTH STATING OUTRIGHT: an unknown Google account that
// signs in successfully lands with role 'none' and reads nothing. Authentication
// succeeded and authorization gave it nothing, which is exactly the split this
// codebase already enforces everywhere else.

/** The one provider in V1. A second entry here is a product decision, not a
 *  refactor — the login screen deliberately does not carry a social-login list. */
export const GOOGLE_PROVIDER = 'google' as const

/** Where Google (via Supabase) sends the browser back. Must be reachable
 *  signed-out, and must be on the project's Redirect URL allow list. */
export const AUTH_CALLBACK_PATH = '/auth/callback'

/** The server route that BEGINS the flow. A plain link, not client JS: it runs
 *  server-side so the PKCE verifier cookie and the invite cookie are written by
 *  the same response that redirects to Google, and so the button works on a
 *  phone that never finished executing the page's JavaScript. */
export const OAUTH_START_PATH = '/api/auth/google/start'

/**
 * The scopes asked for, and the one deliberately NOT asked for.
 *
 * `openid email profile` is the minimum that answers "who is this and which
 * mailbox do they control". Supabase sends email+profile by default; openid is
 * added explicitly because the id_token is what carries the verified-email claim
 * this module refuses to proceed without.
 *
 * ⛔ `access_type=offline` is deliberately absent. It is what makes Google issue
 * a REFRESH token, and a refresh token is a standing key to the person's Google
 * account that we would then be storing. EdgeHQ reads nothing from Google after
 * sign-in — no calendar, no contacts, no mail — so requesting offline access
 * would be collecting a credential with no use for it. Adding it is a decision
 * that needs its own reason; verify:google-auth fails if it appears.
 */
export const GOOGLE_SCOPES = 'openid email profile'

/** How long the invite handshake cookie may live. Long enough for a Google
 *  consent screen and a password prompt, short enough that a shared machine does
 *  not carry an entitlement around. */
export const OAUTH_INVITE_TTL_SECONDS = 600

/** httpOnly, so no script — ours or anybody's — can read the invite token back
 *  out of the browser. SameSite=Lax is REQUIRED, not incidental: the return trip
 *  from Google is a top-level GET navigation, which Lax permits and Strict would
 *  silently drop, leaving a legitimate invited owner unbindable. */
export const OAUTH_INVITE_COOKIE = 'eq-oauth-invite'

/**
 * Does this browser still hold the PKCE verifier that STARTED the flow?
 *
 * ⭐ WHY THIS IS ASKED SEPARATELY rather than left to the exchange to discover.
 * "No verifier" and "bad code" both come back from exchangeCodeForSession as one
 * indistinguishable error, and they mean opposite things to the person reading
 * the screen: one is "finish where you started", the other is "that link is
 * spent". Collapsing them is what made a real production failure unreadable on
 * 2026-08-26 — the message said the link could not be completed when the truth
 * was that the round trip had begun on a different host.
 *
 * Matched by SUFFIX, deliberately. @supabase/ssr names the cookie
 * `sb-<project-ref>-auth-token-code-verifier`, built from a storageKey this file
 * does not own and must not duplicate — a hard-coded copy would silently stop
 * matching the day the key changes, and a check that never matches is a check
 * that always reports "missing".
 *
 * ⛔ Presence only. The VALUE is never read, compared, logged or returned: it is
 * the secret half of the handshake, and this question does not need it.
 */
export const PKCE_VERIFIER_COOKIE_SUFFIX = '-code-verifier'

export function hasPkceVerifier(cookieNames: readonly string[]): boolean {
  return cookieNames.some(n => n.endsWith(PKCE_VERIFIER_COOKIE_SUFFIX))
}

// ── The return destination ───────────────────────────────────────────────────
// THE open-redirect gate, in one place, because there are now three callers (the
// login form, the OAuth start route and the callback) and three copies of a
// security predicate is three chances to fix two of them.
//
// The rule is deliberately narrow: a path on THIS origin, nothing else. Not a
// hostname allow-list, not "same origin if you squint" — a leading single slash
// and no scheme. Everything below is a real bypass of a naive
// `startsWith('/')` check:
//
//   '//evil.tld/x'      protocol-relative — the browser reads it as absolute
//   '/\\evil.tld/x'     backslash; browsers normalise \ to / in authority
//   'https://evil.tld'  plainly absolute
//   'javascript:...'    not a navigation at all
//   '/%09/evil.tld'     a tab that some parsers strip before the authority
//
// Returning null (never a rewritten guess) keeps the failure obvious: the caller
// falls back to the role's own landing page, which is always safe.
export function safeReturnPath(raw: string | null | undefined): string | null {
  if (!raw) return null
  const v = raw.trim()
  if (!v) return null
  // Must be a rooted path. This also rejects 'javascript:', 'data:' and any
  // absolute URL in one move, since none of them begins with '/'.
  if (!v.startsWith('/')) return null
  // Everything below is decided on the DECODED value, and there is deliberately
  // no pre-decode copy of these checks. Decoding only ever rewrites %XX escapes,
  // so a raw '//evil.tld' is still '//evil.tld' afterwards, which made a second
  // check before this point DEAD CODE. Mutation testing is what proved it:
  // removing that line changed no outcome for any of the sixteen hostile shapes
  // the guard drives. Same lesson lib/appOrigin records about its BOM replace —
  // a line that looks load-bearing is exactly the kind that gets trusted.
  let decoded = v
  try { decoded = decodeURIComponent(v) } catch { return null }
  // Control characters, tab, newline and space: the bytes some parsers strip
  // BEFORE reading the authority, which is what makes '/%09/evil.tld' work.
  if (/[\u0000-\u0020\u007f]/.test(decoded)) return null
  // Protocol-relative, in both spellings the URL parser accepts. THE check that
  // stops '//evil.tld' and its encoded spelling '/%2f/evil.tld' alike.
  if (decoded.startsWith('//') || decoded.startsWith('/\\')) return null
  return v
}

/** Where the browser is sent after Google, as an absolute URL on OUR origin.
 *  `next` is carried through the provider round trip as a query parameter and is
 *  re-validated on the way back — it is attacker-controllable at both ends, so
 *  being clean on the way out proves nothing about the way back. */
export function buildCallbackUrl(appOrigin: string, next?: string | null): string {
  const base = appOrigin.replace(/\/$/, '')
  const safe = safeReturnPath(next)
  return safe
    ? `${base}${AUTH_CALLBACK_PATH}?next=${encodeURIComponent(safe)}`
    : `${base}${AUTH_CALLBACK_PATH}`
}

// ── Provider-verified email ──────────────────────────────────────────────────
// ⚠️⚠️ THE claim this whole feature's safety rests on, and the one that is easy
// to assume rather than check.
//
// "Signed in with Google" does NOT imply "Google verified this address". A
// Google Workspace administrator controls the mailboxes on their own domain and
// can mint an account whose email claim is unverified; historically that is the
// exact shape of the Sign-in-with-Google account-takeover writeups. If EdgeHQ
// bound an invite to an address on the strength of "Google said so" alone,
// anyone who could stand up a Workspace domain could claim an invite addressed
// to someone at that domain.
//
// So: the verified flag is read from the identity Supabase stores for the
// PROVIDER, server-side, after the code exchange. It is never read from the
// client, never from a query parameter, and never inferred from the fact that a
// session exists.
//
// Both spellings are checked because Google's own payload uses `email_verified`
// and Supabase mirrors it into user_metadata, where older rows carry
// `verified_email` instead. A missing flag is FALSE — absent is not verified.
export interface ProviderIdentityLike {
  provider?: string | null
  identity_data?: Record<string, unknown> | null
}

export interface ProviderUserLike {
  email?: string | null
  email_confirmed_at?: string | null
  user_metadata?: Record<string, unknown> | null
  identities?: ProviderIdentityLike[] | null
}

function truthyFlag(bag: Record<string, unknown> | null | undefined): boolean {
  if (!bag) return false
  return bag.email_verified === true || bag.verified_email === true
}

/**
 * Did GOOGLE vouch for this address?
 *
 * Reads the google identity's own claim first — that is the provider speaking.
 * user_metadata is accepted as a fallback because Supabase populates it from the
 * same id_token, but ONLY together with email_confirmed_at, so a metadata bag
 * (which a user can write to via updateUser) can never on its own promote an
 * unverified address. That combination is what stops "I set email_verified:true
 * on myself" from being an attack.
 */
export function googleEmailVerified(user: ProviderUserLike | null | undefined): boolean {
  if (!user) return false
  const google = (user.identities ?? []).find(i => i?.provider === GOOGLE_PROVIDER)
  if (google && truthyFlag(google.identity_data)) return true
  return !!user.email_confirmed_at && truthyFlag(user.user_metadata)
}

// ── Failure, in words a person can act on ────────────────────────────────────
// Every one of these is reachable by a real human on a bad day, so none of them
// may render as a stack trace, a provider error code, or a blank screen. They
// travel as a short stable code in the query string — never a message, never a
// token, never an email address — and the login page renders the text.
export type GoogleAuthError =
  | 'cancelled'        // they closed Google's consent screen, or denied it
  | 'exchange'         // the code would not exchange: replayed, expired, forged
  | 'no-verifier'      // this browser holds no PKCE verifier — see below
  | 'provider-config'  // the provider refused OUR credentials — see below
  | 'unverified'       // Google would not vouch for the address
  | 'no-invite'        // authenticated fine; holds no licence to create a business
  | 'invite-invalid'   // the invite is expired, revoked or already used
  | 'invite-mismatch'  // the invite names a different address than Google returned
  | 'invite-taken'     // that invite is already being redeemed by another account
  | 'link-ambiguous'   // a different Google identity on an account that has one
  | 'unavailable'      // we could not ask — NOT a verdict about this person

export const GOOGLE_AUTH_ERROR_TEXT: Record<GoogleAuthError, string> = {
  cancelled: 'Google sign-in was cancelled. You can try again, or use your email and password.',
  exchange: 'That Google sign-in link could not be completed. Please try again.',
  'no-verifier': 'This browser didn’t keep the security key that finishes Google sign-in. Start again from this page — and if you began on a different address, use app.edgehq.ca.',
  'provider-config': 'Google sign-in isn’t working right now — that’s a problem on our side, not with your account or your Google password. Use your email and password for now; we’ve been told about it.',
  unverified: 'Google did not confirm that email address, so we can’t use it to sign in. Try email and password instead.',
  'no-invite': 'That Google account isn’t part of the EdgeHQ beta yet. Use the invite link you were sent, or sign in with the account you already have.',
  'invite-invalid': 'That invite is no longer valid — it may have expired or already been used. Ask EdgeHQ for a new one.',
  'invite-mismatch': 'This invite was issued for a different email address. Sign in with that address, or ask for a new invite.',
  'invite-taken': 'That invite already has a signup in progress under a different account.',
  'link-ambiguous': 'That Google account isn’t connected to this EdgeHQ account. Connecting a second sign-in method isn’t supported yet — sign in the way you normally do.',
  unavailable: 'We couldn’t reach the server to finish signing you in. Please try again.',
}

const ERROR_CODES = new Set<string>(Object.keys(GOOGLE_AUTH_ERROR_TEXT))

/** Read a code back off the URL without trusting it. An unknown value renders
 *  nothing rather than being echoed — a query parameter is attacker-controlled
 *  text, and reflecting it is how a login page becomes a phishing surface. */
export function readGoogleAuthError(raw: string | null | undefined): GoogleAuthError | null {
  return raw && ERROR_CODES.has(raw) ? (raw as GoogleAuthError) : null
}

/** THE query parameter the callback fails back with. */
export const AUTH_ERROR_PARAM = 'auth_error'

// ── The failure the SERVER cannot see ────────────────────────────────────────
// ⚠️⚠️ When gotrue itself fails on the return leg — it could not exchange the
// provider's code, its own credentials were refused, the provider 500'd — it does
// NOT put that on the query string. It redirects to
//
//   https://app.edgehq.ca/auth/callback#error=server_error&error_code=unexpected_failure&…
//
// and a URL FRAGMENT IS NEVER SENT TO A SERVER. So /auth/callback sees no `code`
// and no `error`, and its only honest reading is "no code" — which is how a real,
// specific, server-side configuration failure surfaced to an owner on 2026-08-26
// as "That Google sign-in link could not be completed. Please try again." Trying
// again could never have worked: Google was rejecting OUR client secret, and the
// evidence naming that sat only in Supabase's logs.
//
// The fragment does survive the hop to /login, so the LOGIN PAGE can read what
// the server could not. That is the only place this can be recovered.
//
// ⛔ THE PROVIDER'S OWN TEXT IS NEVER RENDERED. `error_description` is
// attacker-controllable — anyone can hand-craft a link to /login carrying any
// fragment they like — so echoing it turns the login page into a phishing
// surface. Known codes map to OUR sentences; everything else is 'exchange'.
const PROVIDER_FRAGMENT_ERRORS: Record<string, GoogleAuthError> = {
  access_denied: 'cancelled',
  server_error: 'provider-config',
  unexpected_failure: 'provider-config',
  temporarily_unavailable: 'provider-config',
}

/**
 * Read a provider failure out of a URL fragment, and nothing else out of it.
 *
 * Accepts the raw `location.hash` (with or without the leading '#'). Returns null
 * when there is no error there at all, so a normal sign-in is unaffected.
 */
export function readProviderFragmentError(hash: string | null | undefined): GoogleAuthError | null {
  if (!hash) return null
  const p = new URLSearchParams(hash.replace(/^#/, ''))
  const error = p.get('error')
  const code = p.get('error_code')
  if (!error && !code) return null
  // error_code is the more specific of the two, so it is consulted first.
  return PROVIDER_FRAGMENT_ERRORS[code ?? ''] ?? PROVIDER_FRAGMENT_ERRORS[error ?? ''] ?? 'exchange'
}

/**
 * How the provider's own failure maps onto ours.
 *
 * Google reports a denied consent as `access_denied`; everything else that comes
 * back on the error parameter is a configuration or transport problem the person
 * cannot fix and must not be shown verbatim.
 */
export function classifyProviderError(error: string | null | undefined): GoogleAuthError {
  return error === 'access_denied' ? 'cancelled' : 'exchange'
}
