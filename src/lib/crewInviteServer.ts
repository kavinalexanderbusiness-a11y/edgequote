// ── The crew invitation email: server-only ───────────────────────────────────
// NEVER import this from client code. The split is the same one
// passwordRecoveryServer.ts and betaInviteServer.ts make, and it is what keeps
// the emailed link and the service-role path out of every browser bundle.
// scripts/verify-crew-auth.ts fails the build if a 'use client' file names it.
//
// There is deliberately NO mail engine here. sendEmail() (lib/comms/send) is the
// one place this application talks to Resend; this file only builds the message
// it hands over — exactly as passwordResetEmail and betaVerifyEmail do.
//
// ── WHY THIS IS PLATFORM MAIL, NOT TENANT MAIL ───────────────────────────────
// It is addressed to somebody about their EdgeHQ LOGIN — an account matter,
// not a message the business is sending its customer. So it goes straight
// through sendEmail(): no consent check (the recipient is not a customer), no
// governor (that is customer-cadence machinery), no notification_log (that
// ledger is keyed on a tenant's customer), and no outbound_email capability
// grant — gating it on one would mean "can this business text its customers"
// decides whether its own crew can be given a login. Same class as
// password-reset and beta signup, and it joins them on verify:capabilities'
// SEND_ALLOWLIST for the same stated reason.
//
// The business NAME travels with it because the recipient needs to know which
// employer is asking — a worker may be on two rosters. Nothing else about the
// tenant does: no address, no phone, no customer, no money.

/** Escape the interpolated values. The business name is owner-supplied text and
 *  lands inside an HTML document; the URL is ours but is escaped on the same
 *  principle — never hand-build markup around unescaped input. */
function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

/**
 * The invitation. One link, one action, and an explicit "ignore this" path.
 *
 * The "didn't expect this" line is load-bearing exactly as it is for signup: an
 * owner can type any address into the invite box, so the message must read
 * correctly to somebody who never asked — and ignoring it must be both safe and
 * sufficient. It is: the account exists but has no password, the link is
 * single-use and short-lived, and nothing about it can reach the business's
 * customers, money or records.
 */
export function crewInviteEmail(setupUrl: string, businessName: string | null, workerName: string | null): {
  subject: string; html: string; text: string
} {
  const business = (businessName || '').trim()
  const who = (workerName || '').trim()
  // The subject names the employer when we know it: in an inbox, "Set up your
  // EdgeHQ login" from an unknown sender is indistinguishable from phishing.
  const subject = business ? `${business}: set up your work login` : 'Set up your work login'
  const greeting = who ? `Hi ${who},` : 'Hi,'
  const opener = business
    ? `${business} has set up a login for you in EdgeHQ, the app the crew uses for the day's work.`
    : 'Your employer has set up a login for you in EdgeHQ, the app the crew uses for the day\'s work.'

  const html = `<div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;max-width:520px;margin:0 auto;padding:28px 22px;color:#111827">
  <p style="margin:0 0 14px;font-size:16px">${esc(greeting)}</p>
  <p style="margin:0;font-size:15px;line-height:1.55;color:#374151">${esc(opener)} Choose a password below and you are in — there is no sign-up form and nothing to wait for.</p>
  <p style="margin:24px 0 0">
    <a href="${esc(setupUrl)}" style="display:inline-block;background:#111827;color:#ffffff;text-decoration:none;padding:12px 22px;border-radius:10px;font-weight:600;font-size:15px">Set up my login</a>
  </p>
  <p style="margin:22px 0 0;font-size:13px;line-height:1.5;color:#6b7280">
    This link works once and expires within the hour. If it has already run out, ask ${business ? esc(business) : 'your employer'} to send a new one — it is one tap for them.
  </p>
  <p style="margin:14px 0 0;font-size:13px;line-height:1.5;color:#6b7280">
    You will see your own schedule, the addresses you are going to and the notes from the office. You will not see customer billing, pricing or anyone's pay.
  </p>
  <p style="margin:14px 0 0;font-size:13px;line-height:1.5;color:#6b7280">
    If you weren’t expecting this, ignore it — the link is the only way in, and it stops working on its own.
  </p>
  <p style="margin:18px 0 0;font-size:13px;color:#9ca3af">— EdgeHQ</p>
</div>`

  const text = [
    greeting,
    '',
    `${opener} Choose a password using the link below and you are in — there is no sign-up form and nothing to wait for.`,
    '',
    setupUrl,
    '',
    `This link works once and expires within the hour. If it has already run out, ask ${business || 'your employer'} to send a new one.`,
    '',
    'You will see your own schedule, the addresses you are going to and the notes from the office. You will not see customer billing, pricing or anyone\'s pay.',
    '',
    'If you weren’t expecting this, ignore it — the link is the only way in, and it stops working on its own.',
    '',
    '— EdgeHQ',
  ].join('\n')

  return { subject, html, text }
}
