'use client'

import { useEffect, useState } from 'react'

export interface PaymentsStatus {
  /** May THIS business take online payments: deployment key AND its platform grant. */
  enabled: boolean
  /** STRIPE_WEBHOOK_SECRET is present — money that moves actually gets recorded. */
  webhook: boolean
  /** Why `enabled` is false, for honest copy: the deployment has no Stripe key
   *  ('not-configured') vs the key exists but this business holds no
   *  online_payments grant ('not-enabled'). Purely informational — every server
   *  door re-checks; see lib/capabilities. */
  reason: 'ok' | 'not-configured' | 'not-enabled'
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
  const [status, setStatus] = useState<PaymentsStatus>({ enabled: false, webhook: false, reason: 'not-configured' })
  useEffect(() => {
    let active = true
    fetch('/api/payments/status')
      .then(r => r.json())
      .then(d => {
        if (!active) return
        setStatus({
          enabled: !!d.enabled,
          webhook: !!d.webhook,
          reason: d.reason === 'not-enabled' ? 'not-enabled' : d.enabled ? 'ok' : 'not-configured',
        })
      })
      .catch(() => {})   // unreachable → stay pessimistic; never claim payments work
    return () => { active = false }
  }, [])
  return status
}
