// ── Canonical communication skip reasons ─────────────────────────────────────
// THE single place every automatic communication records WHY a send was skipped,
// written to notification_log.detail. One canonical value per reason (no
// "no email" / "missing email" / "email missing" drift). Values are kept
// human-readable AND backward-compatible with rows already in the table, and the
// resolver below also tolerates legacy/free-text details so the timeline stays
// truthful for historical entries. Server- AND client-safe (no React).
//
// IMPORTANT: this changes only the *reason string*, never a send decision or the
// consent source of truth (customers.sms_opt_in / customers.email_opt_in).

export const SKIP_REASON = {
  NO_OPT_IN: 'no opt-in',          // the customer is not opted in for this channel
  NO_EMAIL: 'no email',            // opted in (or transactional) but no email on file
  NO_PHONE: 'no phone',            // opted in but no phone number on file
  NO_CONTACT: 'no contact',        // neither email nor phone available
  UNSUBSCRIBED: 'unsubscribed',    // (future) inbound STOP / unsubscribe
} as const
export type SkipReason = typeof SKIP_REASON[keyof typeof SKIP_REASON]

export type SkipAction = 'add_email' | 'add_phone' | null
export interface SkipInfo { label: string; action: SkipAction }

// Map a stored notification_log.detail (canonical OR legacy free text) → the truthful
// label shown in the timeline + an optional next action. Order matters: opt-in and
// unsubscribe are checked before email/phone so a generic "email" match can't mask them.
export function describeSkip(detail: string | null | undefined): SkipInfo {
  const d = (detail || '').toLowerCase().trim()
  if (!d) return { label: 'skipped', action: null }
  if (d.includes('opt')) return { label: 'no opt-in', action: null }                 // "no opt-in", "opted out"
  if (d.includes('unsub')) return { label: 'customer unsubscribed', action: null }
  if (d.includes('email')) return { label: 'no email on file', action: 'add_email' } // "no email", "missing email"
  if (d.includes('phone')) return { label: 'no phone on file', action: 'add_phone' } // "no phone", "no phone number"
  if (d.includes('contact')) return { label: 'missing contact information', action: null }
  if (d.includes('disab')) return { label: 'delivery disabled', action: null }
  return { label: detail!, action: null }   // truthful fallback — show exactly what was recorded
}
