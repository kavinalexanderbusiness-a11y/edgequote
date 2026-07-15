// ── THE saved-card expiry rule ───────────────────────────────────────────────
// Both card surfaces (the owner's PaymentMethodCard and the customer's portal
// AutoPayCard) rendered `exp_month`/`exp_year` as neutral grey text and stopped
// there. Nothing anywhere asked whether the date had passed — so a customer with
// an expired card still saw a green "AutoPay on" badge, and every AutoPay charge
// declined silently against a card the UI presented as fine.
//
// The rule lives here once because both surfaces must agree on it, and because
// "expired" is a fact about the card, not a detail of either page's markup.

export interface CardExpiry {
  exp_month: number | null
  exp_year: number | null
}

/** 'unknown' = the provider never gave us an expiry; say nothing rather than guess. */
export type CardExpiryState = 'ok' | 'expiring' | 'expired' | 'unknown'

/** "09/26", or null when the expiry is unknown. */
export function cardExpLabel(card: CardExpiry | null | undefined): string | null {
  if (!card?.exp_month || !card?.exp_year) return null
  return `${String(card.exp_month).padStart(2, '0')}/${String(card.exp_year).slice(-2)}`
}

/**
 * A card is good through the LAST day of its expiry month — 09/26 is valid until
 * 2026-09-30, not 2026-09-01. Getting that boundary wrong would call a perfectly
 * chargeable card dead for up to a month, so the comparison is month-granular.
 *
 * 'expiring' covers this month and next: enough runway for the owner to ask, or
 * for the customer to replace the card, before a charge actually declines.
 */
export function cardExpiryState(card: CardExpiry | null | undefined, now: Date = new Date()): CardExpiryState {
  if (!card?.exp_month || !card?.exp_year) return 'unknown'
  const months = (y: number, m: number) => y * 12 + (m - 1)
  const cardMonths = months(card.exp_year, card.exp_month)
  const nowMonths = months(now.getFullYear(), now.getMonth() + 1)
  if (cardMonths < nowMonths) return 'expired'
  if (cardMonths <= nowMonths + 1) return 'expiring'
  return 'ok'
}
