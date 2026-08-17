// ── Binding a beta invite to a Google-authenticated owner ────────────────────
// Server-only. NEVER import this from client code: it reaches for the service
// role and it is the one function in the codebase that can write
// beta_invites.redeemed_by, which is precisely what can_provision_business()
// reads. verify:google-auth fails the build if a 'use client' file names it.
//
// WHY THIS EXISTS AT ALL. The password signup path binds the invite at account
// CREATION time (POST /api/beta/signup sets reserved_by on a user it just made),
// and claim_beta_invite() promotes that reservation to a redemption once the
// address is verified. A Google-authenticated owner arrives with neither half:
// Supabase created their auth user during the OAuth exchange, so nothing ever
// reserved the invite for them, and claim_beta_invite() — which only looks for
// an invite already carrying THIS uid — correctly answers 'no-invite'.
//
// So this closes exactly that gap and nothing more. The licence still comes from
// a real invite token; all this does is bind it to a uid that was established by
// the provider round trip instead of by a password form.
//
// ⭐ WHAT IT DELIBERATELY DOES NOT DO: it does not create a business, it does not
// touch business_settings, it does not grant crew access, and it does not write
// platform_operators or platform_capabilities. It sets redeemed_by on one invite
// row. The tenant is still created by /setup, still subject to the
// business_settings INSERT policy, still carrying can_provision_business().

import { createHash } from 'crypto'
import type { SupabaseClient, User } from '@supabase/supabase-js'
import { normalizeInviteEmail } from './crewInvite'
import { googleEmailVerified, type GoogleAuthError } from './googleAuth'

/** sha256 hex — the ONLY form of an invite token the database ever sees.
 *  Same construction as betaInviteServer.hashBetaToken; duplicated here rather
 *  than imported so this module does not drag the beta signup route's email
 *  machinery along with it. verify:google-auth asserts the two agree. */
export function hashInviteToken(rawToken: string): string {
  return createHash('sha256').update(rawToken, 'utf8').digest('hex')
}

export type BindOutcome =
  | { ok: true; alreadyBound: boolean }
  | { ok: false; reason: GoogleAuthError }

interface InviteRow {
  id: string
  email: string | null
  expires_at: string
  revoked_at: string | null
  reserved_by: string | null
  redeemed_by: string | null
  redeemed_at: string | null
}

const COLS = 'id, email, expires_at, revoked_at, reserved_by, redeemed_by, redeemed_at'

/**
 * Bind one invite to one authenticated user, atomically.
 *
 * `user` comes from exchangeCodeForSession — the server's own read of the
 * session it just established. ⚠️ The caller must never pass a uid or an email
 * taken from the request body, the query string or a cookie: the whole safety
 * argument is that the identity here was proven by the provider round trip, not
 * asserted by the browser.
 */
export async function bindBetaInviteToGoogleUser(
  admin: SupabaseClient,
  rawToken: string,
  user: User,
): Promise<BindOutcome> {
  // ── Gate 1: Google must vouch for the address ──────────────────────────────
  // Both halves, and both for a reason. googleEmailVerified reads the PROVIDER's
  // claim (a Workspace admin can mint an account whose email claim is false, and
  // that is the documented takeover shape). email_confirmed_at is what
  // claim_beta_invite() itself requires, restated here so this path can never be
  // laxer than the path it parallels.
  if (!googleEmailVerified(user) || !user.email_confirmed_at) {
    return { ok: false, reason: 'unverified' }
  }
  const email = normalizeInviteEmail(user.email ?? '')
  if (!email) return { ok: false, reason: 'unverified' }

  const { data, error } = await admin.from('beta_invites')
    .select(COLS).eq('token_hash', hashInviteToken(rawToken)).maybeSingle()
  // Could not ASK. Never a verdict — the caller keeps the session and says so.
  if (error) return { ok: false, reason: 'unavailable' }
  // A miss is ONE uniform answer. Nothing distinguishes "never existed" from
  // "wrong by one character", so a token cannot be probed for near-misses.
  if (!data) return { ok: false, reason: 'invite-invalid' }
  const invite = data as InviteRow

  // ── Gate 2: already spent? ────────────────────────────────────────────────
  // Idempotent for the rightful holder: a replayed callback, a double-clicked
  // button or a refreshed tab must not turn a successful binding into an error
  // that tells a legitimate owner their invite is gone.
  if (invite.redeemed_at) {
    return invite.redeemed_by === user.id
      ? { ok: true, alreadyBound: true }
      : { ok: false, reason: 'invite-invalid' }
  }
  if (invite.revoked_at) return { ok: false, reason: 'invite-invalid' }
  if (new Date(invite.expires_at).getTime() <= Date.now()) {
    return { ok: false, reason: 'invite-invalid' }
  }

  // ── Gate 3: is this invite addressed to somebody else? ────────────────────
  // ⭐ THE check that stops a stranger's Google account from claiming an invite
  // that was emailed to a named business. Compared against the PROVIDER-verified
  // address, normalised the same way the rest of the codebase normalises an
  // invite email, so "Sam@Example.com" and "sam@example.com" are one person.
  if (invite.email && normalizeInviteEmail(invite.email) !== email) {
    return { ok: false, reason: 'invite-mismatch' }
  }

  // ── Gate 4: somebody else already started on it ───────────────────────────
  // One invite, one account — the same rule POST /api/beta/signup enforces. A
  // reservation held by a DIFFERENT uid is respected unless that account has
  // since been deleted (reserved_by is ON DELETE SET NULL, so a live non-null
  // value means a live holder).
  if (invite.reserved_by && invite.reserved_by !== user.id) {
    return { ok: false, reason: 'invite-taken' }
  }

  // ── The write ─────────────────────────────────────────────────────────────
  // Every eligibility condition is RESTATED in the WHERE clause. The reads above
  // are for producing a good error message; THIS is what makes the decision, so
  // two callbacks racing on one invite cannot both win. The loser sees zero rows
  // and is told the invite is taken rather than silently sharing it.
  const now = new Date().toISOString()
  const { data: won, error: wErr } = await admin.from('beta_invites')
    .update({ reserved_by: user.id, reserved_at: now, redeemed_by: user.id, redeemed_at: now })
    .eq('id', invite.id)
    .is('redeemed_at', null)
    .is('revoked_at', null)
    .gt('expires_at', now)
    .or(`reserved_by.is.null,reserved_by.eq.${user.id}`)
    .select('id')
  if (wErr) return { ok: false, reason: 'unavailable' }
  if (!won || won.length === 0) return { ok: false, reason: 'invite-taken' }

  return { ok: true, alreadyBound: false }
}
