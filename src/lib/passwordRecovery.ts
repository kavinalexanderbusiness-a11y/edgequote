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

// ── The link ─────────────────────────────────────────────────────────────────
// Built around Supabase's `hashed_token` in the QUERY STRING, not around its
// `action_link` and not around the PKCE `?code=`. The same three reasons crew
// invites already chose this shape (see lib/crewInvite), and one more that only
// matters when the link travels by email:
//
//  1. action_link's `redirect_to` must be on the project's Redirect URLs
//     allow-list or it silently falls back to SITE_URL. On this project that
//     list is EMPTY and SITE_URL is http://localhost:3000 — a production owner
//     would be sent to their own machine.
//  2. action_link lands with the session in the URL FRAGMENT, which no server
//     can read.
//  3. PKCE (`?code=`) stores its verifier in the browser that ASKED. Requesting
//     on a phone and opening the link on a laptop — the normal way a locked-out
//     person behaves — cannot work. `verifyOtp({ token_hash })` has no such tie.
//  4. A token in our query string is only spent when OUR page runs JavaScript.
//     Corporate mail scanners and link previewers that GET every URL in an email
//     would burn a Supabase `/verify` link before the owner ever clicked it;
//     against this one they do nothing.
export function buildResetUrl(appOrigin: string, hashedToken: string): string {
  return `${appOrigin.replace(/\/$/, '')}${RESET_PATH}?token=${encodeURIComponent(hashedToken)}`
}

/** Both spellings are accepted on the way in: `token` is what we build and what
 *  crew invites already use, `token_hash` is what Supabase's own documented
 *  template snippet emits. A link that works is worth more than a tidy name. */
export const RESET_TOKEN_PARAMS = ['token', 'token_hash'] as const

export function readResetToken(get: (k: string) => string | null): string | null {
  for (const k of RESET_TOKEN_PARAMS) {
    const v = get(k)
    if (v && v.trim()) return v.trim()
  }
  return null
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
  | { kind: 'unavailable' }

/** Shape of the error supabase-js hands back. Narrowed here so the classifier
 *  can be exercised with plain objects in the guard. */
export interface RecoveryError { status?: number; code?: string; name?: string; message?: string }

/**
 * THE predicate. Same three-answer discipline as loadCrewDay: a request that
 * never landed must never be reported as an answer.
 *
 *   no error            → accepted
 *   4xx (incl. 429/400) → accepted   — the server answered; which answer it gave
 *                                      is account-existence information, so it
 *                                      does not reach the screen
 *   5xx                 → unavailable — includes error_sending_recovery_email,
 *                                      i.e. the mailer is down. Nothing was sent.
 *   no status at all    → unavailable — a fetch that never completed
 *
 * ⚠️ The default is `unavailable`, not `accepted`. An unrecognised failure must
 * degrade into "we don't know that it worked", never into "it worked".
 */
export function classifyRecoverySend(error: RecoveryError | null | undefined): RecoveryRequestOutcome {
  if (!error) return { kind: 'accepted' }
  const status = typeof error.status === 'number' ? error.status : 0
  if (status >= 400 && status < 500) return { kind: 'accepted' }
  return { kind: 'unavailable' }
}

/** The one sentence an anonymous visitor may be shown after a request the server
 *  accepted. Never says "sent", never says "delivered", never repeats whether
 *  the address is known — and the address is echoed so a typo is visible. */
export function acceptedMessage(email: string): string {
  return `If ${email} has an EdgeQuote account, a link to choose a new password is on its way. It expires in an hour.`
}

/** What we say when nothing was sent and we know it. No account is named. */
export const UNAVAILABLE_MESSAGE =
  'We couldn’t send a reset link just now — nothing has gone out. Check your connection and try again in a minute.'

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
