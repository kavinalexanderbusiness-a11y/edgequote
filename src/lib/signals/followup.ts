import { FOLLOW_UP_DAYS } from './constants'

// ── Follow-up eligibility — THE "is this quote worth chasing" engine ─────────
// lib/followup.ts anchored to Date.now(), so suggestions.ts deliberately
// re-implemented it against its own `ctx.today` (its comment at the old site was
// right: a wall-clock read makes the count drift by one at night, and disagree
// with every other surface). Fixed here instead of forked: `today` is injectable
// and defaults to the local day.

const DAY_MS = 86_400_000

export interface FollowUpQuote {
  status: string
  sent_at?: string | null
  last_followed_up_at?: string | null
  total?: number | string | null
}

/** Local YYYY-MM-DD (never UTC — an 8pm MDT read must not roll to tomorrow). */
export function localToday(): string {
  const d = new Date()
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

/** The clock a follow-up resets: the later of "when sent" and "last nudged". */
export function followUpAnchor(q: FollowUpQuote): string | null {
  return q.last_followed_up_at || q.sent_at || null
}

/** Whole days between an ISO timestamp/date and a YYYY-MM-DD day. */
export function daysSinceOn(dateStr: string | null | undefined, today: string): number | null {
  if (!dateStr) return null
  const then = new Date(dateStr).getTime()
  const now = new Date(today + 'T23:59:59').getTime()
  return Math.floor((now - then) / DAY_MS)
}

/** A sent quote that's gone quiet long enough to chase again. */
export function needsFollowUp(q: FollowUpQuote, today: string = localToday()): boolean {
  if (q.status !== 'sent') return false
  const anchor = followUpAnchor(q)
  if (!anchor) return true // sent but never timestamped → surface it
  return (daysSinceOn(anchor, today) ?? 0) >= FOLLOW_UP_DAYS
}

/** Oldest first; ties broken by highest value (chase the stale money first). */
export function compareFollowUp(a: FollowUpQuote, b: FollowUpQuote): number {
  const aa = followUpAnchor(a) ? new Date(followUpAnchor(a)!).getTime() : 0
  const bb = followUpAnchor(b) ? new Date(followUpAnchor(b)!).getTime() : 0
  if (aa !== bb) return aa - bb
  return Number(b.total ?? 0) - Number(a.total ?? 0)
}
