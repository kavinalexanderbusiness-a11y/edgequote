// ── Account recovery: the server-only parts ──────────────────────────────────
// The recovery email and the limiter's numbers. NEVER import this from client
// code — the split is the same one betaInviteServer.ts and crewInvite.ts make,
// and it is what keeps the service-role path and the emailed link out of any
// browser bundle. scripts/verify-account-recovery.ts fails the build if a
// 'use client' file names it.
//
// There is deliberately NO mail engine here. sendEmail() (lib/comms/send) is the
// one place this application talks to Resend, and this file only builds the
// message it hands over — exactly as betaVerifyEmail and portalAccessEmail do.

// ── The limiter ──────────────────────────────────────────────────────────────
// DB-backed, in password_reset_requests, for the same reason portal-access is:
// the threat here is EMAIL ENUMERATION, and an in-memory map would reset on
// every cold start and be per-instance besides — a sweep would barely notice it.
// (betaInviteServer's per-IP map is fine for its job, which is hygiene around a
// 256-bit token nobody can guess. This is not that job.)
//
// Both windows count EVERY attempt, matched or not. Limiting only the hits would
// leave exactly the door the neutral response exists to close.

/** Per address, per hour. Enough for a real person who mistypes and retries;
 *  few enough that one inbox cannot be mail-bombed through this route. */
export const PER_EMAIL_HOURLY = 4

/** Everyone, per hour. A locked-out owner is rare — this is a private beta with
 *  a handful of accounts — and a sweep is not. Lower than portal-access's 60
 *  because the population is smaller by orders of magnitude: portal links serve
 *  every customer of every tenant, this serves the owners themselves. */
export const GLOBAL_HOURLY = 20

// ── The email ────────────────────────────────────────────────────────────────
// Transactional, and the direct answer to something the recipient just did —
// same class as betaVerifyEmail and portalAccessEmail, and like them sent
// straight through sendEmail(): no governor (that is customer-cadence
// machinery, and this recipient is not a customer) and no notification_log
// (that ledger is keyed on a tenant's customer; this recipient is an owner).
// password_reset_requests records the attempt instead.
//
// The reset URL is the only secret-bearing content. No business data travels
// with it. The "didn't ask for this" line is load-bearing in the same way it is
// for signup: anyone can type a stranger's address into the form, so the message
// must read correctly to someone who never asked — and ignoring it must be both
// safe and sufficient, which it is, because nothing changes until the link is
// opened AND a new password is chosen.
export function passwordResetEmail(resetUrl: string): { subject: string; html: string; text: string } {
  const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
  const subject = 'Reset your EdgeQuote password'
  const html = `<div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;max-width:520px;margin:0 auto;padding:28px 22px;color:#111827">
  <p style="margin:0 0 14px;font-size:16px">Reset your EdgeQuote password</p>
  <p style="margin:0;font-size:15px;line-height:1.55;color:#374151">Choose a new password using the link below. It works once and expires in an hour.</p>
  <p style="margin:24px 0 0">
    <a href="${esc(resetUrl)}" style="display:inline-block;background:#111827;color:#ffffff;text-decoration:none;padding:12px 22px;border-radius:10px;font-weight:600;font-size:15px">Choose a new password</a>
  </p>
  <p style="margin:22px 0 0;font-size:13px;line-height:1.5;color:#6b7280">
    Setting a new password signs you out on every other device.
  </p>
  <p style="margin:14px 0 0;font-size:13px;line-height:1.5;color:#6b7280">
    If you didn’t ask to reset your password, ignore this message — your password stays as it is and nothing happens without this link.
  </p>
  <p style="margin:18px 0 0;font-size:13px;color:#9ca3af">— EdgeQuote</p>
</div>`
  const text = [
    'Reset your EdgeQuote password',
    '',
    'Choose a new password using the link below. It works once and expires in an hour.',
    '',
    resetUrl,
    '',
    'Setting a new password signs you out on every other device.',
    '',
    'If you didn’t ask to reset your password, ignore this message — your password stays as it is and nothing happens without this link.',
    '',
    '— EdgeQuote',
  ].join('\n')
  return { subject, html, text }
}
