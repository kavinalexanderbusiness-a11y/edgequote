// ── Account recovery: THE contract ───────────────────────────────────────────
// One owner, one password, and no support desk. If somebody locked out of their
// own business cannot get back in without a human editing Supabase by hand, the
// private beta has a hole in it. This file is the whole rule set — what a link
// is, what a password has to be, and what each server answer is allowed to make
// the screen say — so the request page, the reset page and the guard cannot
// drift apart.
//
// Pure. No Supabase import, no React, no DOM: every rule below is asserted in
// scripts/verify-account-recovery.ts without a browser or a network.
//
// ⚠️ WE DO NOT MINT TOKENS. Supabase already owns the recovery token — it
// generates it, hashes it, expires it and burns it on use. Inventing a second
// one would mean a second expiry, a second replay window and a second way to be
// wrong. Everything here is about which of ITS answers reaches the screen.

/** Where someone asks for a link. */
export const FORGOT_PATH = '/forgot-password'
/** Where they choose a new password, holding a token. */
export const RESET_PATH = '/reset-password'

/** Where the browser asks for a link. Our own server route — NOT Supabase's
 *  /recover, which leaks account existence through its rate-limit status (see
 *  classifyRecoverySend). */
export const RESET_REQUEST_ENDPOINT = '/api/public/password-reset'

// ── The link ─────────────────────────────────────────────────────────────────
// Supabase's `hashed_token` in PATH SEGMENTS. Not action_link, not the PKCE
// `?code=`, and — since 2026-08-13 — not a query string either.
//
//  1. action_link's `redirect_to` must be on the project's Redirect URLs
//     allow-list or it silently falls back to SITE_URL, which on this project
//     was http://localhost:3000 in production.
//  2. action_link lands with the session in the URL FRAGMENT, which no server
//     can read — and @supabase/ssr pins flowType to pkce, so supabase-js ignores
//     an implicit fragment entirely (measured; see readRecoveryFragment).
//  3. PKCE (`?code=`) stores its verifier in the browser that ASKED. Requesting
//     on a phone and opening the link on a laptop — the normal way a locked-out
//     person behaves — cannot work. `verifyOtp({ token_hash })` has no such tie.
//  4. The token is only spent when OUR page runs JavaScript. Mail scanners that
//     GET every URL in a message would burn a Supabase `/verify` link before the
//     owner ever clicked it; against this one they do nothing.
//  5. ⭐ PATH SEGMENTS, because `=` belongs to quoted-printable. Beta signup
//     measured a query-form link losing bytes on the way to a real inbox: `=73`
//     is a valid QP escape, so a transport that re-encodes the body can eat part
//     of `?token=…`. A path-segment URL carries no `=` and no `?`, so there is
//     nothing for a QP decoder to misread. Same shape as buildBetaConfirmUrl.
export function buildResetUrl(appOrigin: string, hashedToken: string): string {
  return `${appOrigin.replace(/\/$/, '')}${RESET_PATH}/${encodeURIComponent(hashedToken)}`
}

/** Query spellings still accepted on the way IN, though nothing we send uses
 *  them: `token` is the shape this feature shipped with, `token_hash` is what
 *  Supabase's own documented template snippet emits. Reading both costs nothing
 *  and means a link from either source still opens. */
export const RESET_TOKEN_PARAMS = ['token', 'token_hash'] as const

export function readResetToken(get: (k: string) => string | null): string | null {
  for (const k of RESET_TOKEN_PARAMS) {
    const v = get(k)
    if (v && v.trim()) return v.trim()
  }
  return null
}

/**
 * THE canonical read: the token as a path segment, from Next's optional
 * catch-all (`/reset-password/[[...link]]`). Next has already decoded each
 * segment, so what arrives is the raw hashed_token.
 *
 * Exactly one segment is accepted. A deeper path is not a link we built, and
 * quietly picking one segment out of several would make the route guess.
 */
export function readResetPathToken(segments: string[] | undefined): string | null {
  if (!segments || segments.length !== 1) return null
  const v = segments[0]?.trim()
  return v ? v : null
}

// ── The OTHER link shape ─────────────────────────────────────────────────────
// Supabase's stock recovery template sends {{ .ConfirmationURL }}, which points
// at the auth server's /verify endpoint and 302s to the app with the session in
// the URL FRAGMENT: #access_token=…&refresh_token=…&type=recovery
//
// ⚠️ supabase-js does NOT pick that up here, and this was measured, not assumed:
// @supabase/ssr's createBrowserClient hard-codes flowType "pkce" (it sets the
// field AFTER spreading the caller's options, so it cannot be overridden). PKCE
// looks for `?code=`; handed an implicit fragment it does nothing at all — the
// hash was still sitting in location.hash afterwards, with no session stored.
//
// So the fragment is parsed here and handed to setSession explicitly. That makes
// the reset page work under BOTH link shapes no matter what flowType the client
// is built with — which matters right now, because this project is on the free
// tier and Supabase refuses template edits without custom SMTP ("Email template
// modification is not available for free tier projects using the default email
// provider"). Until SMTP is configured, the stock fragment link is the ONLY link
// this project can send.
//
// `type=recovery` is required. A fragment is not a password-change permit just
// because it carries a token: this is the recovery door, and the type is what
// says the person proved they can read the account's email.
export type RecoveryFragment =
  | { kind: 'session'; accessToken: string; refreshToken: string }
  | { kind: 'error' }
  | { kind: 'none' }

export function readRecoveryFragment(hash: string): RecoveryFragment {
  const raw = (hash || '').replace(/^#/, '')
  if (!raw) return { kind: 'none' }
  const p = new URLSearchParams(raw)
  // Supabase reports a spent or expired link the same way — as an error in the
  // fragment — so this is the stock template's version of "this link is dead".
  if (p.get('error') || p.get('error_code')) return { kind: 'error' }
  if (p.get('type') !== 'recovery') return { kind: 'none' }
  const accessToken = p.get('access_token')
  const refreshToken = p.get('refresh_token')
  if (!accessToken || !refreshToken) return { kind: 'none' }
  return { kind: 'session', accessToken, refreshToken }
}

// ── Asking for a link ────────────────────────────────────────────────────────
// TWO outcomes reach the screen, and the split is a security decision, not an
// accident.
//
// `accepted` is deliberately AMBIGUOUS. Supabase only attempts a send for an
// address that HAS an account, so every signal about the send — 200 vs 429 vs
// "that address is invalid" — is a statement about whether the account exists.
// Measured on this project, 2026-08-13:
//
//     POST /recover  nobody@…        → 200 {}
//     POST /recover  nobody@…  again → 200 {}          ← no account
//     POST /recover  owner@…         → 200 {}
//     POST /recover  owner@…   again → 429 over_email_send_rate_limit
//     POST /recover  fixture@…invalid→ 400 email_address_invalid
//
// Two requests sixty seconds apart therefore tell an attacker whether an address
// is an EdgeQuote owner. That oracle lives in Supabase's endpoint, which is
// reachable with the public anon key — no page of ours can close it. What we CAN
// refuse to do is build a second one in our own UI, so every 4xx collapses into
// the one neutral sentence. (The project-level fix is Supabase's CAPTCHA, which
// is off today; see the session report.)
//
// `unavailable` is the honest half. It is only ever reached when we could not
// get an answer out of the server at all, or the server told us its own mail
// path broke — cases where NOTHING was sent and we know it. Saying "check your
// inbox" there would be the exact lie this split exists to prevent. It says so
// without naming an account, so it stays a failure report and not an oracle.
export type RecoveryRequestOutcome =
  | { kind: 'accepted' }
  | { kind: 'throttled' }
  | { kind: 'unavailable' }

/**
 * THE predicate, over OUR route's HTTP status.
 *
 * The route is built so that every status it can return is decided BEFORE any
 * account lookup happens — so none of them is a function of whether the address
 * exists, and each can be reported honestly:
 *
 *   200 → accepted     the one neutral answer, identical for an address with an
 *                      account, one without, and one whose send failed
 *   429 → throttled    the limiter counts EVERY attempt, matched or not, so this
 *                      fires the same way for a real owner and for a sweep. It is
 *                      not an oracle, and saying "wait a minute" is both true and
 *                      more useful than pretending a link is coming
 *   4xx → unavailable  a malformed body or a route that isn't there
 *   5xx → unavailable  no service-role key, no email provider, or the ledger
 *                      write failed. NOTHING WAS SENT and the route knows it
 *   ——  → unavailable  a fetch that never completed
 *
 * ⚠️ The default is `unavailable`, not `accepted`. An unrecognised failure must
 * degrade into "we don't know that it worked", never into "it worked".
 *
 * ⚠️ This deliberately no longer classifies Supabase's own /recover. That
 * endpoint answers 200 for an unknown address, 429 for a known one asked twice
 * inside a minute, and 400 for a known one whose address the mailer rejects —
 * measured 2026-08-13 — so two requests a minute apart identify an EdgeQuote
 * owner. The browser no longer calls it at all.
 */
export function classifyRecoverySend(status: number | null | undefined): RecoveryRequestOutcome {
  if (status === 200) return { kind: 'accepted' }
  if (status === 429) return { kind: 'throttled' }
  return { kind: 'unavailable' }
}

/** The one sentence an anonymous visitor may be shown after a request the server
 *  accepted. Never says "sent", never says "delivered", never repeats whether
 *  the address is known — and the address is echoed so a typo is visible. */
export function acceptedMessage(email: string): string {
  return `If ${email} has an EdgeHQ account, a link to choose a new password is on its way. It expires in an hour.`
}

/** What we say when nothing was sent and we know it. No account is named. */
export const UNAVAILABLE_MESSAGE =
  'We couldn’t send a reset link just now — nothing has gone out. Check your connection and try again in a minute.'

/** The limiter counts attempts, not matches, so this sentence is safe to show:
 *  it is true of any address, and reveals nothing about which ones have accounts. */
export const THROTTLED_MESSAGE =
  'Too many reset requests. Wait a few minutes and try again.'

// ── Holding a link ───────────────────────────────────────────────────────────
// THREE outcomes, and collapsing the last two is the bug this type exists to
// prevent. `dead` and `unavailable` look identical to a tired person on a phone
// and are opposites: one means ask for a new link, the other means try again in
// a moment. Folding a flaky connection into `dead` is how a legitimate owner
// gets told their link is broken when it is fine — the same failure the crew
// day read and the customer portal were both fixed for.
export type ResetTokenOutcome =
  | { kind: 'ready'; email: string | null }
  | { kind: 'dead' }
  | { kind: 'unavailable' }

/** Shape of the error supabase-js hands back from verifyOtp/setSession. Narrowed
 *  here so the classifier can be exercised with plain objects in the guard. */
export interface RecoveryError { status?: number; code?: string; name?: string; message?: string }

/**
 * Expired, already used, malformed, and never-existed all resolve to ONE answer.
 *
 * This is deliberate. "That link expired" and "that link was never valid" are
 * different facts, and handing the difference to whoever is holding the token
 * tells them whether they guessed a real one. There is no version of this screen
 * where the distinction helps the person who actually owns the account: their
 * next move is the same either way, and the page says what it is.
 *
 * As above, a request that never reached Supabase is NOT a dead token.
 */
export function classifyResetToken(error: RecoveryError | null | undefined, hasUser: boolean): ResetTokenOutcome {
  if (error) {
    const status = typeof error.status === 'number' ? error.status : 0
    if (status >= 400 && status < 500) return { kind: 'dead' }
    return { kind: 'unavailable' }
  }
  // No error and no user is not a shape Supabase should produce; treat the
  // token as spent rather than pretending we have somebody to act on.
  return hasUser ? { kind: 'ready', email: null } : { kind: 'dead' }
}

// ── The password ─────────────────────────────────────────────────────────────
// ONE minimum for the whole application. Two numbers in two files is how a
// policy quietly becomes a suggestion.
//
// ⚠️ This is the number we STATE, not the number that is ENFORCED. The floor
// that actually holds is the project's `password_min_length`, because anyone
// holding a valid recovery token can call Supabase directly and skip this file
// entirely. That floor is 6 today. Raising it is a project-config change, not a
// code change — it is written up in the session report with the exact call.
export const MIN_PASSWORD = 10

/**
 * The only password rule, as a message or null. Length only, on purpose:
 * composition rules ("one capital, one symbol") push people towards
 * Password1! and NIST has recommended against them since SP 800-63B. Length is
 * the part that survives contact with a real person setting this up one-handed
 * in a truck.
 */
export function passwordProblem(password: string, confirm: string): string | null {
  if (password.length < MIN_PASSWORD) return `Use at least ${MIN_PASSWORD} characters.`
  if (password !== confirm) return 'Those two don’t match.'
  return null
}

// ── After the password changes ───────────────────────────────────────────────
// A reset revokes every OTHER session and keeps this one.
//
// THE REASONING. "I forgot my password" and "somebody else may have my password"
// are the same event from the outside — a recovery is exactly when you cannot
// rule the second one out. A reset that left other sessions alive would hand a
// thief a working session on the account whose password was just changed to lock
// them out, which is the one outcome the owner believed they had prevented.
//
// So: scope 'others'. Not 'global' — signing the owner out of the very tab where
// they just proved themselves would end the recovery by making them log in
// again, and the phone in their hand is the device they trust most.
//
// ⚠️ EXPLICIT ON PURPOSE. supabase-js defaults signOut() to scope 'global', and
// a bare call is what revoked this owner's real sessions 214 times in a day.
// Every sign-out in this feature names its scope so it stays a decision.
export const RESET_SIGNOUT_SCOPE = 'others' as const

/** Where a finished reset lands. The middleware owns the real answer — an owner
 *  belongs at /dashboard, a crew member at /crew — so this only has to be a
 *  plausible destination for it to correct. */
export const RESET_DESTINATION = '/dashboard'
