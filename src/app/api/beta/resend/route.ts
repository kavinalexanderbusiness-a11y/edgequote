import { NextRequest, NextResponse } from 'next/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { commsEnabled, sendEmail } from '@/lib/comms/send'
import { appOrigin } from '@/lib/appOrigin'
import {
  BETA_TOKEN_RE, buildBetaConfirmUrl,
  type BetaSignupFailureReason, type BetaSignupResponse,
} from '@/lib/betaInvite'
import {
  hashBetaToken, betaVerifyEmail, allowBetaAttempt,
  RESEND_MIN_INTERVAL_MS, MAX_VERIFICATION_SENDS,
} from '@/lib/betaInviteServer'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

// POST /api/beta/resend { token }
//
// "The email didn't arrive." Holding the raw invite token IS the authorisation
// — the same proof the signup itself required — so this can never be aimed at
// an arbitrary inbox: the only address it can ever mail is the one already
// bound to this invite. Regenerating invalidates the previous link (proven
// live), and the throttle lives on the invite ROW (last_sent_at / send_count),
// so it holds across serverless instances and cold starts.
// No console.* here either — a logged link is a session in a log aggregator.

function fail(reason: BetaSignupFailureReason, message: string, status: number) {
  return NextResponse.json<BetaSignupResponse>(
    { ok: false, reason, message },
    { status, headers: { 'Cache-Control': 'no-store' } },
  )
}

export async function POST(req: NextRequest): Promise<NextResponse> {
  const body = (await req.json().catch(() => null)) as Record<string, unknown> | null
  const token = typeof body?.token === 'string' ? body.token : ''
  if (!BETA_TOKEN_RE.test(token)) return fail('invalid', 'This invite link isn’t valid.', 404)

  const ip = req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() || 'unknown'
  if (!allowBetaAttempt(ip)) {
    return fail('rate-limited', 'Too many attempts. Please wait a few minutes and try again.', 429)
  }

  if (!commsEnabled().email) {
    return fail('not-configured', 'Resending needs the email provider configured (RESEND_API_KEY / RESEND_FROM on the deployment).', 503)
  }
  const admin = createAdminClient()
  if (!admin) {
    return fail('not-configured', 'Resending needs SUPABASE_SERVICE_ROLE_KEY set on the deployment.', 503)
  }

  const { data: invite, error: invErr } = await admin.from('beta_invites')
    .select('id, revoked_at, redeemed_at, reserved_by, send_count, last_sent_at')
    .eq('token_hash', hashBetaToken(token)).maybeSingle()
  if (invErr) return fail('error', 'Couldn’t check that invite — try again.', 502)
  if (!invite) return fail('invalid', 'This invite link isn’t valid.', 404)

  if (invite.revoked_at) return fail('revoked', 'This invite has been revoked. Contact EdgeQuote for a new one.', 410)
  if (invite.redeemed_at) return fail('used', 'This invite has already been used to create a business.', 410)
  if (!invite.reserved_by) return fail('not-started', 'No signup has been started for this invite yet — fill in the form first.', 409)

  const { data: u } = await admin.auth.admin.getUserById(invite.reserved_by)
  const holder = u?.user ?? null
  if (!holder || !holder.email) return fail('not-started', 'No signup has been started for this invite yet — fill in the form first.', 409)
  if (holder.email_confirmed_at) {
    return fail('verified', 'This email is already confirmed — sign in to finish setting up.', 409)
  }

  if (invite.send_count >= MAX_VERIFICATION_SENDS) {
    return fail('send-limit', 'Too many emails have been sent for this invite. Contact EdgeQuote.', 429)
  }
  if (invite.last_sent_at && Date.now() - new Date(invite.last_sent_at).getTime() < RESEND_MIN_INTERVAL_MS) {
    return fail('slow-down', 'A confirmation email just went out — give it a minute, and check spam.', 429)
  }

  // generateLink ignores the password for an existing account (proven live
  // 2026-08-13); the parameter only satisfies type:'signup'. Never a credential.
  const { data: link, error: linkErr } = await admin.auth.admin.generateLink({
    type: 'signup', email: holder.email, password: hashBetaToken(`${invite.id}:${Date.now()}`),
  })
  const hashed = link?.properties?.hashed_token
  const vtype = link?.properties?.verification_type || 'signup'
  if (linkErr || !hashed) return fail('email-failed', 'Couldn’t prepare a new confirmation email — try again shortly.', 502)

  const origin = appOrigin(req.nextUrl.origin)
  const message = betaVerifyEmail(buildBetaConfirmUrl(origin, hashed, vtype))
  const sent = await sendEmail(holder.email, message.subject, message.html, message.text)
  if (!sent.sent) return fail('email-failed', 'The confirmation email didn’t send — try again shortly.', 502)

  await admin.from('beta_invites')
    .update({ send_count: invite.send_count + 1, last_sent_at: new Date().toISOString() })
    .eq('id', invite.id)

  return NextResponse.json<BetaSignupResponse>(
    { ok: true, state: 'resent', email: holder.email },
    { headers: { 'Cache-Control': 'no-store' } },
  )
}
