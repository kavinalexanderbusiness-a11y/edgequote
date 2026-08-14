// ── Beta invites: the shared contract ────────────────────────────────────────
// Pure helpers only — token generation/hashing and the email need Node crypto
// and the service role, and live in src/lib/betaInviteServer.ts + the server
// routes (src/app/api/beta/*). Splitting them the same way crewInvite.ts does
// means nothing here can ever pull an admin credential or the 124 kB crypto
// polyfill into a client bundle.
//
// The flow this file describes (invite-only private beta — there is no open
// registration):
//
//   operator mints invite (scripts/beta-invite.ts)
//     → /signup?invite=eqb_…          the invited owner creates email+password
//     → verification email (Resend)   built by us around generateLink's
//                                     hashed_token — the crew-welcome pattern;
//                                     Supabase's own mailer is never involved
//     → /signup/confirm?token_hash=…  verifyOtp proves the address, then
//                                     claim_beta_invite() redeems the invite
//     → /setup                        the existing first-run screen creates the
//                                     business_settings row — the ONE tenant
//                                     door, now licensed by the redemption
//
// The raw invite token exists in exactly two places: the URL the operator hands
// out, and the signup page's requests. The database stores only its sha256.

/** Matches src/lib/integrations/keys.ts (32 random bytes as hex) with a
 *  distinct prefix so an invite can never be mistaken for an API key. */
export const BETA_TOKEN_RE = /^eqb_[0-9a-f]{64}$/

/**
 * THE application-wide password minimum, re-exported so this module's callers
 * keep their import and the number lives in exactly one file.
 *
 * ⚠️ This was a local `8`, described as "the shortest password Supabase accepts
 * by default". That was never true — the project default was 6 — and it became
 * actively wrong on 2026-08-13, when the project's enforced `password_min_length`
 * was raised to 10. A signup screen promising 8 accepts a 9-character password
 * and is then refused BY THE SERVER with "Password should be at least 10
 * characters", after telling the person 9 was fine. See lib/passwordRecovery:
 * the stated number and the enforced number have to be the same number.
 */
export { MIN_PASSWORD } from './passwordRecovery'

export const SIGNUP_PATH = '/signup'
export const SIGNUP_CONFIRM_PATH = '/signup/confirm'

/** The invite page URL an operator hands to a beta business. */
export function buildBetaSignupUrl(appOrigin: string, rawToken: string): string {
  return `${appOrigin.replace(/\/$/, '')}${SIGNUP_PATH}?invite=${encodeURIComponent(rawToken)}`
}

/** The link inside the verification email. Built around `hashed_token`, never
 *  `action_link` — same two reasons as crewInvite.buildSetupUrl: no Redirect-URL
 *  allow-list dependency, and the page (not a URL fragment) establishes the
 *  session, so it works in whatever browser the email opens in.
 *
 *  PATH segments, deliberately no query string: an emailed `?token_hash=…` is
 *  at the mercy of every quoted-printable decoder between the sender and the
 *  click — `=73` is a valid QP escape, so a hash beginning `73…` had its
 *  leading bytes eaten in transit (observed live 2026-08-13 against Gmail).
 *  Both segments are URL-safe by construction ([a-z_] type, hex/pkce_ hash). */
export function buildBetaConfirmUrl(appOrigin: string, hashedToken: string, verificationType: string): string {
  const base = appOrigin.replace(/\/$/, '')
  return `${base}${SIGNUP_CONFIRM_PATH}/${encodeURIComponent(verificationType)}/${encodeURIComponent(hashedToken)}`
}

/** What GET /api/beta/signup?token=… says about an invite. `reserved` means an
 *  account was already created for it and is waiting on email verification;
 *  `verified` means that account confirmed but hasn't finished at /setup yet. */
export type BetaInviteState =
  | 'ok' | 'reserved' | 'verified'
  | 'invalid' | 'expired' | 'revoked' | 'used'

/** Stable failure codes for the two POST routes; `message` is what a human
 *  reads. Mirrors CrewInviteFailure. */
export type BetaSignupFailureReason =
  | 'invalid' | 'expired' | 'revoked' | 'used'
  | 'in-progress' | 'wrong-email' | 'email-exists' | 'verified' | 'not-started'
  | 'bad-email' | 'weak-password'
  | 'rate-limited' | 'slow-down' | 'send-limit'
  | 'not-configured' | 'email-failed' | 'error'

export interface BetaSignupSuccess {
  ok: true
  /** 'sent' = account created and verification email sent; 'resent' = the
   *  account already existed for this invite+email and got a fresh link. */
  state: 'sent' | 'resent'
  email: string
}

export interface BetaSignupFailure {
  ok: false
  reason: BetaSignupFailureReason
  message: string
}

export type BetaSignupResponse = BetaSignupSuccess | BetaSignupFailure

/** What claim_beta_invite() can answer. Everything non-error is calm: the RPC
 *  runs on every /setup load as the self-heal, so re-entry is the normal case. */
export type BetaClaimStatus =
  | 'claimed' | 'already-claimed' | 'already-owner'
  | 'no-invite' | 'revoked' | 'email-unverified' | 'not-signed-in'
