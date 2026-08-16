import { NextRequest, NextResponse } from 'next/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { commsEnabled, sendEmail } from '@/lib/comms/send'
import { normalizeInviteEmail, isPlausibleEmail } from '@/lib/crewInvite'
import { appOrigin } from '@/lib/appOrigin'
import {
  BETA_TOKEN_RE, MIN_PASSWORD, buildBetaConfirmUrl,
  type BetaInviteState, type BetaSignupFailureReason, type BetaSignupResponse,
} from '@/lib/betaInvite'
import {
  hashBetaToken, betaVerifyEmail, allowBetaAttempt,
  RESEND_MIN_INTERVAL_MS, MAX_VERIFICATION_SENDS,
} from '@/lib/betaInviteServer'

// The service role must never run at the edge, and an invite check must never
// be cached.
export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

// ── The invite-only front door ───────────────────────────────────────────────
//
//   GET  /api/beta/signup?token=eqb_…      what state is this invite in?
//   POST /api/beta/signup { token, email, password }
//
// POST creates the auth account (email_confirm:false — signInWithPassword is
// REFUSED until the address is proven), binds the invite to it (reserved_by),
// mints a confirmation link with generateLink({type:'signup'}) and emails it
// through Resend ourselves — the crew-invite pattern; Supabase's rate-limited
// mailer is never involved. Redemption (and with it the licence to create the
// business_settings row) happens later, in claim_beta_invite(), only after
// verifyOtp has proven the email.
//
// THE CONTRACT
// · The raw token is looked up by sha256 only; a miss is one uniform 'invalid'
//   — nothing distinguishes "never existed" from "wrong by one character".
// · The confirmation link travels ONLY inside the email. Returning it in the
//   response would hand email-ownership proof to whoever holds the invite URL,
//   which is exactly what verification exists to test.
// · Retrying with the SAME email is idempotent: the account already reserved
//   this invite, so a fresh link is sent ('resent'). A different email on a
//   reserved invite is refused — one invite, one account.
// · Deleting a reserved account (admin cleanup) frees the invite by itself:
//   reserved_by is ON DELETE SET NULL.
// · No console.* in this file: a logged confirmation link is a session sitting
//   in a log aggregator.

function fail(reason: BetaSignupFailureReason, message: string, status: number) {
  return NextResponse.json<BetaSignupResponse>(
    { ok: false, reason, message },
    { status, headers: { 'Cache-Control': 'no-store' } },
  )
}

function appOrigin(req: NextRequest): string {
  return appOrigin(req.nextUrl.origin)
}

function clientIp(req: NextRequest): string {
  return req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() || 'unknown'
}

type InviteRow = {
  id: string
  email: string | null
  expires_at: string
  revoked_at: string | null
  reserved_by: string | null
  redeemed_at: string | null
  send_count: number
  last_sent_at: string | null
}

const INVITE_COLS = 'id, email, expires_at, revoked_at, reserved_by, redeemed_at, send_count, last_sent_at'

// ── GET: invite state, for the /signup page to render honestly ───────────────
export async function GET(req: NextRequest): Promise<NextResponse> {
  const token = req.nextUrl.searchParams.get('token') ?? ''
  const state = await inviteState(token)
  return NextResponse.json({ state }, { headers: { 'Cache-Control': 'no-store' } })
}

async function inviteState(token: string): Promise<BetaInviteState> {
  if (!BETA_TOKEN_RE.test(token)) return 'invalid'
  const admin = createAdminClient()
  if (!admin) return 'invalid'
  const { data, error } = await admin.from('beta_invites')
    .select(INVITE_COLS).eq('token_hash', hashBetaToken(token)).maybeSingle()
  if (error || !data) return 'invalid'
  const inv = data as InviteRow
  if (inv.revoked_at) return 'revoked'
  if (inv.redeemed_at) return 'used'
  if (inv.reserved_by) {
    // An account exists for this invite. Confirmed already? Then the next step
    // is signing in, not another email.
    const { data: u } = await admin.auth.admin.getUserById(inv.reserved_by)
    if (u?.user) return u.user.email_confirmed_at ? 'verified' : 'reserved'
  }
  if (new Date(inv.expires_at).getTime() <= Date.now()) return 'expired'
  return 'ok'
}

// ── POST: create the account, send the verification email ────────────────────
export async function POST(req: NextRequest): Promise<NextResponse> {
  const body = (await req.json().catch(() => null)) as Record<string, unknown> | null
  const token = typeof body?.token === 'string' ? body.token : ''
  const rawEmail = typeof body?.email === 'string' ? body.email : ''
  const password = typeof body?.password === 'string' ? body.password : ''

  const email = normalizeInviteEmail(rawEmail)
  if (!isPlausibleEmail(email)) return fail('bad-email', 'That doesn’t look like an email address.', 400)
  if (password.length < MIN_PASSWORD) return fail('weak-password', `Use at least ${MIN_PASSWORD} characters.`, 400)
  if (!BETA_TOKEN_RE.test(token)) return fail('invalid', 'This invite link isn’t valid.', 404)

  if (!allowBetaAttempt(clientIp(req))) {
    return fail('rate-limited', 'Too many attempts. Please wait a few minutes and try again.', 429)
  }

  // Fail closed BEFORE creating anything: an account whose verification email
  // can never be sent is a person locked out on day one.
  if (!commsEnabled().email) {
    return fail('not-configured', 'Signup needs the email provider configured (RESEND_API_KEY / RESEND_FROM on the deployment).', 503)
  }
  const admin = createAdminClient()
  if (!admin) {
    return fail('not-configured', 'Signup needs SUPABASE_SERVICE_ROLE_KEY set on the deployment.', 503)
  }

  const { data: found, error: invErr } = await admin.from('beta_invites')
    .select(INVITE_COLS).eq('token_hash', hashBetaToken(token)).maybeSingle()
  if (invErr) return fail('error', 'Couldn’t check that invite — try again.', 502)
  if (!found) return fail('invalid', 'This invite link isn’t valid.', 404)
  const invite = found as InviteRow

  if (invite.revoked_at) return fail('revoked', 'This invite has been revoked. Contact EdgeQuote for a new one.', 410)
  if (invite.redeemed_at) return fail('used', 'This invite has already been used to create a business.', 410)
  if (invite.email && invite.email !== email) {
    return fail('wrong-email', `This invite was issued for a specific address. Use that address, or ask for a new invite.`, 403)
  }

  // Already reserved: the only path forward is the SAME address finishing what
  // it started. That keeps retry/reload idempotent without ever letting a
  // second person ride an invite that someone has begun redeeming.
  if (invite.reserved_by) {
    const { data: u } = await admin.auth.admin.getUserById(invite.reserved_by)
    const holder = u?.user ?? null
    if (holder) {
      if (normalizeInviteEmail(holder.email ?? '') !== email) {
        return fail('in-progress', 'This invite already has a signup in progress under a different email.', 409)
      }
      if (holder.email_confirmed_at) {
        return fail('verified', 'This email is already confirmed — sign in to finish setting up.', 409)
      }
      return resendVerification(admin, invite, email, appOrigin(req))
    }
    // Holder was deleted; ON DELETE SET NULL freed the invite. Fall through.
  }

  if (new Date(invite.expires_at).getTime() <= Date.now()) {
    return fail('expired', 'This invite has expired. Ask for a new one.', 410)
  }

  // Create the account UNVERIFIED. Proven live (2026-08-13): password sign-in
  // refuses with email_not_confirmed until verifyOtp runs, so verification is a
  // hard gate, not a courtesy.
  const { data: createdUser, error: createErr } = await admin.auth.admin.createUser({
    email, password, email_confirm: false,
  })
  if (createErr || !createdUser?.user) {
    const msg = createErr?.message ?? ''
    if (/already.*registered|email_exists/i.test(msg) || createErr?.code === 'email_exists') {
      return fail('email-exists', 'That email already has an EdgeQuote account.', 409)
    }
    if (/invalid/i.test(msg)) return fail('bad-email', 'That email address was refused — check it for typos.', 400)
    return fail('error', 'Couldn’t create the account — try again.', 502)
  }
  const userId = createdUser.user.id

  // Bind the invite to this account — atomically, with every eligibility
  // condition restated in the WHERE so a concurrent signup racing on the same
  // invite cannot both win. Losing the race compensates by deleting the account
  // we just made: no half-created signup survives.
  const { data: reserved, error: resErr } = await admin.from('beta_invites')
    .update({ reserved_by: userId, reserved_at: new Date().toISOString() })
    .eq('id', invite.id)
    .is('reserved_by', null)
    .is('redeemed_at', null)
    .is('revoked_at', null)
    .gt('expires_at', new Date().toISOString())
    .select('id')
  if (resErr || !reserved || reserved.length === 0) {
    await admin.auth.admin.deleteUser(userId).catch(() => {})
    return fail('invalid', 'This invite is no longer available.', 409)
  }

  return sendVerification(admin, invite, email, password, appOrigin(req), 'sent')
}

// Mint a fresh confirmation link and email it. Regenerating INVALIDATES any
// earlier link for this account (proven live: the old token_hash answers
// otp_expired) — so "resend" also serves as revoke-the-old-link, and a replayed
// email link can never race a newer one.
async function sendVerification(
  admin: NonNullable<ReturnType<typeof createAdminClient>>,
  invite: InviteRow,
  email: string,
  password: string,
  origin: string,
  state: 'sent' | 'resent',
): Promise<NextResponse> {
  const { data: link, error: linkErr } = await admin.auth.admin.generateLink({
    // type:'signup' works for an existing unconfirmed user and does NOT change
    // their password (proven live 2026-08-13 — a different password in this
    // call left the original credential intact).
    type: 'signup', email, password,
  })
  const hashed = link?.properties?.hashed_token
  const vtype = link?.properties?.verification_type || 'signup'
  if (linkErr || !hashed) {
    return fail('email-failed', 'Your account was created but the confirmation email couldn’t be prepared — use “Resend email”.', 502)
  }

  const message = betaVerifyEmail(buildBetaConfirmUrl(origin, hashed, vtype))
  const sent = await sendEmail(email, message.subject, message.html, message.text)
  if (!sent.sent) {
    return fail('email-failed', 'Your account was created but the confirmation email didn’t send — use “Resend email”.', 502)
  }

  await admin.from('beta_invites')
    .update({ send_count: invite.send_count + 1, last_sent_at: new Date().toISOString() })
    .eq('id', invite.id)

  return NextResponse.json<BetaSignupResponse>(
    { ok: true, state, email },
    { headers: { 'Cache-Control': 'no-store' } },
  )
}

// The same-email retry path. Throttled against the invite row itself so it
// survives cold starts: at most one email a minute, MAX_VERIFICATION_SENDS ever.
async function resendVerification(
  admin: NonNullable<ReturnType<typeof createAdminClient>>,
  invite: InviteRow,
  email: string,
  origin: string,
): Promise<NextResponse> {
  if (invite.send_count >= MAX_VERIFICATION_SENDS) {
    return fail('send-limit', 'Too many emails have been sent for this invite. Contact EdgeQuote.', 429)
  }
  if (invite.last_sent_at && Date.now() - new Date(invite.last_sent_at).getTime() < RESEND_MIN_INTERVAL_MS) {
    return fail('slow-down', 'A confirmation email just went out — give it a minute, and check spam.', 429)
  }
  // generateLink ignores the password for an existing account (proven live), but
  // the parameter is required by type:'signup' — a throwaway satisfies it
  // without ever becoming a credential.
  const throwaway = hashBetaToken(`${invite.id}:${Date.now()}`)
  return sendVerification(admin, invite, email, throwaway, origin, 'resent')
}
