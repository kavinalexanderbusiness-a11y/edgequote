'use client'

import { useEffect, useState } from 'react'

export interface PaymentsStatus {
  /** STRIPE_SECRET_KEY is present — we can create checkouts and save cards. */
  enabled: boolean
  /** STRIPE_WEBHOOK_SECRET is present — money that moves actually gets recorded. */
  webhook: boolean
}

// ── THE payments-availability read ───────────────────────────────────────────
// /api/payments/status has always returned BOTH booleans, but all three callers
// were the same copy-pasted line that kept `enabled` and dropped `webhook` on the
// floor. That discard is why a half-configured Stripe looked identical to a
// working one: the webhook is the single writer of paid-state (it records the
// payment and flips the invoice), so without it a customer can pay in full and
// the invoice stays outstanding forever, with no signal to the owner.
//
// One hook, both facts, so a surface has to actively choose to ignore the gap
// rather than never learn about it.
export function usePaymentsStatus(): PaymentsStatus {
  const [status, setStatus] = useState<PaymentsStatus>({ enabled: false, webhook: false })
  useEffect(() => {
    let active = true
    fetch('/api/payments/status')
      .then(r => r.json())
      .then(d => { if (active) setStatus({ enabled: !!d.enabled, webhook: !!d.webhook }) })
      .catch(() => {})   // unreachable → stay pessimistic; never claim payments work
    return () => { active = false }
  }, [])
  return status
}
