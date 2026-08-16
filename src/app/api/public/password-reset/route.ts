import { NextRequest, NextResponse } from 'next/server'
import { createHash } from 'node:crypto'
import { serviceClient } from '@/lib/cron/guard'
import { commsEnabled, sendEmail } from '@/lib/comms/send'
import { buildResetUrl } from '@/lib/passwordRecovery'
import { normalizeEmail } from '@/lib/portalAccess'
import { passwordResetEmail, PER_EMAIL_HOURLY, GLOBAL_HOURLY } from '@/lib/passwordRecoveryServer'
import { configuredAppOrigin } from '@/lib/appOrigin'

export const runtime = 'nodejs'          // the service role must never run at the edge
export const dynamic = 'force-dynamic'

// POST /api/public/password-reset   { email }
//
// "Email me a link to choose a new password." The recovery path for a business
// owner locked out of their own account, with no support desk to call.
//
// ── WHY THIS ROUTE EXISTS AT ALL ─────────────────────────────────────────────
// Supabase can send this itself. It is not used, for two measured reasons:
//
//   1. DELIVERY. No custom SMTP is configured, so Supabase's own mailer is the
//      shared development one: 2 emails an hour for the whole project, and it
//      silently drops mail. A real send on 2026-08-13 returned 200, logged
//      `mail.send` with no error, stamped recovery_sent_at — and never arrived.
//      Resend is what this application already uses for every other email, and
//      it is what beta signup uses for exactly this kind of link.
//   2. ENUMERATION. POST /auth/v1/recover answers 200 for an address with no
//      account, 429 for one that has an account and asked twice inside a minute,
//      and 400 for one whose address its mailer rejects. Two requests a minute
//      apart therefore identify an EdgeQuote owner. Nothing a page can do closes
//      that, because the endpoint is reachable with the public anon key — so the
//      browser stops calling it, and asks this instead.
//
// ── THE SECURITY CONTRACT ────────────────────────────────────────────────────
// Modelled directly on /api/public/portal-access, which solved the same problem
// for customers:
//  1. The 200 body is byte-identical whether we matched an account, matched
//     nothing, or matched and failed to send. Every OTHER status (400/429/503)
//     is decided BEFORE any lookup, so no status code is an oracle either.
//  2. Nothing from generateLink reaches the browser. The link goes into the
//     email and nowhere else — not the body, not a header, not a redirect.
//  3. Nothing identifying is logged: a reason, never the address, never the
//     link, never a user id.
//  4. Rate limits count EVERY attempt, matched or not — a sweep is made of
//     misses, so limiting only the hits would leave the door wide open.
//  5. The service role is constructed here and never leaves. It is used for
//     exactly two things: counting/recording attempts, and minting the link.
//
// No CORS block, unlike portal-access: this is posted only by our own login
// screen, never by the marketing site.

// The one neutral sentence. Deliberately a constant so there is exactly one
// success shape and it cannot drift into two.
const NEUTRAL = 'If that address has an EdgeQuote account, a link to choose a new password is on its way.'
const ok = () => NextResponse.json({ ok: true, message: NEUTRAL }, { headers: { 'Cache-Control': 'no-store' } })
const unavailable = () => NextResponse.json(
  { error: 'We can’t send reset links right now. Please try again shortly.' },
  { status: 503, headers: { 'Cache-Control': 'no-store' } },
)

export async function POST(req: NextRequest): Promise<NextResponse> {
  const body = (await req.json().catch(() => null)) as Record<string, unknown> | null
  const email = normalizeEmail(body?.email)
  // Match-independent: a malformed address is rejected without touching the
  // database, so this branch reveals nothing about who exists.
  if (!email) {
    return NextResponse.json({ error: 'Please enter a valid email address.' }, { status: 400 })
  }

  // Also match-independent. Failing CLOSED is deliberate: answering with the
  // neutral success while no email can possibly be sent would be the one lie
  // this endpoint must not tell.
  const sb = serviceClient()
  if (!sb || !commsEnabled().email) {
    console.error('[password-reset] unavailable:',
      !sb ? 'no service-role key' : 'email provider not configured')
    return unavailable()
  }

  // The rate-limit bucket. A hash, never the address — see the migration's note.
  const emailKey = createHash('sha256').update(email).digest('hex')
  const since = new Date(Date.now() - 60 * 60 * 1000).toISOString()

  const [{ count: perEmail }, { count: global }] = await Promise.all([
    sb.from('password_reset_requests').select('id', { count: 'exact', head: true })
      .eq('email_key', emailKey).gt('created_at', since),
    sb.from('password_reset_requests').select('id', { count: 'exact', head: true })
      .gt('created_at', since),
  ])
  if ((perEmail ?? 0) >= PER_EMAIL_HOURLY || (global ?? 0) >= GLOBAL_HOURLY) {
    // Counted over attempts, not matches, so this fires identically for an
    // address that has an account and one that does not. That is what makes it
    // safe to say out loud.
    return NextResponse.json(
      { error: 'Too many reset requests. Wait a few minutes and try again.' },
      { status: 429 },
    )
  }

  // Record the attempt BEFORE doing the work: a sweep that crashes us mid-lookup
  // must still have spent its slot.
  const { data: attemptRow, error: attemptErr } = await sb
    .from('password_reset_requests').insert({ email_key: emailKey }).select('id').single()
  if (attemptErr) {
    console.error('[password-reset] could not record attempt:', attemptErr.message)
    return unavailable()
  }
  const attemptId = (attemptRow as { id: string }).id

  // ── Mint the link ──────────────────────────────────────────────────────────
  // generateLink RETURNS a link; it sends nothing, so Supabase's mailer is never
  // involved. Its `hashed_token` is what our own URL is built around — the same
  // choice crew invites and beta signup already made, and for the same reasons
  // (no Redirect-URL allow-list dependency, no URL fragment, works in whatever
  // browser the email is opened in).
  //
  // ⚠️ For an address with no account this fails, and that failure is the ONLY
  // thing separating the two branches. It must not change the response, the
  // status, or the timing in any way an observer can use — so it falls straight
  // through to the same neutral answer below.
  const { data: link, error: linkErr } = await sb.auth.admin.generateLink({
    type: 'recovery',
    email,
  })
  const hashed = link?.properties?.hashed_token

  if (linkErr || !hashed) {
    // No account, or Supabase would not mint. Reason only — never the address.
    // `matched` stays false, which is the honest record.
    if (linkErr && !/user not found|not found/i.test(linkErr.message)) {
      console.error('[password-reset] generateLink failed:', linkErr.message)
    }
    return ok()
  }

  const origin = configuredAppOrigin() || req.nextUrl.origin
  const msg = passwordResetEmail(buildResetUrl(origin, hashed))
  const res = await sendEmail(email, msg.subject, msg.html, msg.text)

  // The truth about the send lives in the ledger, never in the reply. Marking a
  // failed send as `sent` would be the internal lie — nobody would know an owner
  // asked and got nothing.
  await sb.from('password_reset_requests')
    .update({ matched: true, sent: res.sent })
    .eq('id', attemptId)
  if (!res.sent) {
    console.error('[password-reset] provider rejected the send:', res.reason, res.error ?? '')
  }

  // Neutral either way. A provider outage must not become the oracle that tells
  // an attacker which addresses are owners, and the owner can simply ask again.
  return ok()
}
