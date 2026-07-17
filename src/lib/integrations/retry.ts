// Delivery retry policy — the numbers the worker, the docs page and the
// verify script all read. Pure module.
//
// A delivery gets MAX_ATTEMPTS tries; after attempt n fails, the next one
// waits BACKOFF_MINUTES[n-1]. The pg_net nudge makes the first attempt nearly
// instant; the /api/cron/integrations sweep (every 10 minutes) picks up
// retries, so early steps land on the next sweep in practice.

export const BACKOFF_MINUTES = [1, 5, 30, 120, 480, 1440] as const

/** Total tries per delivery (first attempt + one per backoff step). */
export const MAX_ATTEMPTS = BACKOFF_MINUTES.length + 1

/** Consecutive failed attempts before an endpoint is auto-paused. */
export const AUTO_DISABLE_AFTER = 10

/** Claimed-but-never-finished deliveries are re-queued after this long. */
export const STUCK_PROCESSING_MINUTES = 10

/** How long delivery logs / outbox rows / inbound receipts are kept. */
export const RETENTION_DAYS = 30

/**
 * Delay before the next try, given how many attempts have now happened.
 * Returns null when the delivery is out of attempts (→ dead).
 */
export function backoffDelayMinutes(attempts: number): number | null {
  if (attempts >= MAX_ATTEMPTS) return null
  const idx = Math.max(0, attempts - 1)
  return BACKOFF_MINUTES[Math.min(idx, BACKOFF_MINUTES.length - 1)]
}
