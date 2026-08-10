// ── Public portal-link recovery — the pure parts ─────────────────────────────
// Backs /portal-access and POST /api/public/portal-access. Everything here is
// pure (no I/O), so scripts/verify-portal-access.ts can pin the security-relevant
// behaviour — normalisation, the neutral message, and what the email may contain.
//
// The security contract this file exists to serve: the browser must not be able
// to tell a known address from an unknown one, and a portal token must never
// leave the server except inside the email itself.

/** THE public answer. Identical for a match and a miss — that is the whole point. */
export const NEUTRAL_RESULT =
  'If an account matches that email, we’ve sent a secure portal link. Please check your inbox.'

/**
 * Normalise an address for lookup: trim, lowercase, and collapse the whitespace
 * people paste in from a contact card. Returns null when it isn't plausibly an
 * address, so the caller answers 400 rather than burning a rate-limit slot.
 *
 * Deliberately permissive — this only decides whether to BOTHER looking, and a
 * wrong "that's not an email" on a real address would lock a customer out of
 * their own portal. The database comparison is the real gate.
 */
export function normalizeEmail(raw: unknown): string | null {
  if (typeof raw !== 'string') return null
  const e = raw.trim().replace(/\s+/g, '').toLowerCase()
  if (e.length < 5 || e.length > 254) return null
  // one @, something either side, a dot in the domain, no spaces (stripped above)
  if (!/^[^@\s]+@[^@\s.]+(\.[^@\s.]+)+$/.test(e)) return null
  return e
}

/** One portal the requesting address legitimately owns. */
export interface PortalLink {
  /** Absolute /portal/<token> URL. The token lives ONLY here and in the email. */
  url: string
  /** Whose portal it is — shown only when one address has several. */
  customerName: string | null
  /** The business the portal belongs to. */
  businessName: string | null
}

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

/**
 * The message itself.
 *
 * Transactional, not marketing: it is the direct answer to something the
 * recipient just asked for at that address, in the same class as a password
 * reset. It carries no offers and no unsubscribe-gated content.
 *
 * The token appears as an href and — in the plain-text part only, where a link
 * cannot be attached to words — as the URL. It is never printed as a standalone
 * "your code is …", and no customer data (balance, address, visit) travels with
 * it: the recipient learns nothing until they open the portal the link proves
 * they may open.
 */
export function portalAccessEmail(links: PortalLink[], fallbackBusiness?: string | null): { subject: string; html: string; text: string } {
  const business = links[0]?.businessName || fallbackBusiness || 'your service provider'
  const many = links.length > 1
  const subject = many
    ? 'Your customer portals'
    : `Your ${business} customer portal`

  const intro = many
    ? `This address is on file with more than one account, so every portal it belongs to is listed below.`
    : `Here is your secure link to view your visits, quotes and invoices.`

  const button = (l: PortalLink) => {
    // Label the button ONLY when there are several — a lone "Open Customer
    // Portal" is clearer than one captioned with the name of the only business.
    const label = many
      ? esc([l.customerName, l.businessName].filter(Boolean).join(' · ') || 'Customer portal')
      : null
    return `${label ? `<p style="margin:22px 0 6px;font-size:14px;color:#374151;font-weight:600">${label}</p>` : ''}
      <p style="margin:${label ? '0' : '24px'} 0 0">
        <a href="${esc(l.url)}" style="display:inline-block;background:#111827;color:#ffffff;text-decoration:none;padding:12px 22px;border-radius:10px;font-weight:600;font-size:15px">Open Customer Portal</a>
      </p>`
  }

  const html = `<div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;max-width:520px;margin:0 auto;padding:28px 22px;color:#111827">
  <p style="margin:0 0 14px;font-size:16px">Hi,</p>
  <p style="margin:0;font-size:15px;line-height:1.55;color:#374151">${esc(intro)}</p>
  ${links.map(button).join('')}
  <p style="margin:26px 0 0;font-size:13px;line-height:1.5;color:#6b7280">
    Keep this link private — anyone with it can see your account. If you didn’t ask for it, you can ignore this message and nothing will change.
  </p>
  <p style="margin:18px 0 0;font-size:13px;color:#9ca3af">— ${esc(business)}</p>
</div>`

  const text = [
    'Hi,',
    '',
    intro,
    '',
    ...links.map(l => {
      const label = many ? [l.customerName, l.businessName].filter(Boolean).join(' · ') : null
      return `${label ? `${label}\n` : ''}${l.url}`
    }),
    '',
    'Keep this link private — anyone with it can see your account. If you didn’t ask for it, you can ignore this message and nothing will change.',
    '',
    `— ${business}`,
  ].join('\n')

  return { subject, html, text }
}
