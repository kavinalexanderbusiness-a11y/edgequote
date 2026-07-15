import { FOLLOW_UP_DAYS } from './constants'

// ── Follow-up eligibility — THE "is this quote worth chasing" rule ───────────
// ONE rule: whole days elapsed from the anchor to a REFERENCE INSTANT, compared
// against FOLLOW_UP_DAYS. The rule is shared; the clock is the caller's, because
// the two original copies deliberately used different ones and both are correct
// for their surface:
//   • the quote screens read the wall clock (Date.now()) — "3×24h have passed"
//   • the Suggestions Center reads the start of ctx.today — stable for a whole
//     day, so a card can't change its mind at 11pm
// Injecting the instant (rather than reading the clock in here) is also what lets
// a server job evaluate this rule later without a browser.

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

/** Midnight-at-the-start of a YYYY-MM-DD day, as epoch ms. */
export function startOfDayMs(today: string): number {
  return new Date(today + 'T00:00:00').getTime()
}

/** The clock a follow-up resets: the later of "when sent" and "last nudged". */
export function followUpAnchor(q: FollowUpQuote): string | null {
  return q.last_followed_up_at || q.sent_at || null
}

/** Whole days elapsed from `dateStr` to `refMs`. */
export function daysElapsed(dateStr: string | null | undefined, refMs: number = Date.now()): number | null {
  if (!dateStr) return null
  return Math.floor((refMs - new Date(dateStr).getTime()) / DAY_MS)
}

/** A sent quote that's gone quiet long enough to chase again. */
export function needsFollowUp(q: FollowUpQuote, refMs: number = Date.now()): boolean {
  if (q.status !== 'sent') return false
  const anchor = followUpAnchor(q)
  if (!anchor) return true // sent but never timestamped → surface it
  return (daysElapsed(anchor, refMs) ?? 0) >= FOLLOW_UP_DAYS
}

/** Oldest first; ties broken by highest value (chase the stale money first). */
export function compareFollowUp(a: FollowUpQuote, b: FollowUpQuote): number {
  const aa = followUpAnchor(a) ? new Date(followUpAnchor(a)!).getTime() : 0
  const bb = followUpAnchor(b) ? new Date(followUpAnchor(b)!).getTime() : 0
  if (aa !== bb) return aa - bb
  return Number(b.total ?? 0) - Number(a.total ?? 0)
}
