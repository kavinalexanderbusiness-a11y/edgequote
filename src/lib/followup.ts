import type { Quote } from '@/types'

// Fixed for v1 — intentionally not configurable yet (use it in the real world
// first, then decide if a Settings knob is worth the dev time).
export const FOLLOW_UP_DAYS = 3

const DAY_MS = 86_400_000

// The clock a follow-up resets: the later of "when sent" and "last nudged".
export function followUpAnchor(q: Quote): string | null {
  return q.last_followed_up_at || q.sent_at
}

export function daysSince(dateStr: string | null): number | null {
  if (!dateStr) return null
  return Math.floor((Date.now() - new Date(dateStr).getTime()) / DAY_MS)
}

// A sent quote that's gone quiet long enough to chase again.
export function needsFollowUp(q: Quote): boolean {
  if (q.status !== 'sent') return false
  const anchor = followUpAnchor(q)
  if (!anchor) return true // sent but never timestamped → surface it
  return (daysSince(anchor) ?? 0) >= FOLLOW_UP_DAYS
}

// Oldest first; ties broken by highest quote value (chase the stale money first).
export function compareFollowUp(a: Quote, b: Quote): number {
  const aa = followUpAnchor(a) ? new Date(followUpAnchor(a)!).getTime() : 0
  const bb = followUpAnchor(b) ? new Date(followUpAnchor(b)!).getTime() : 0
  if (aa !== bb) return aa - bb
  return Number(b.total) - Number(a.total)
}

// DB patch to log a manual follow-up (snoozes the quote another FOLLOW_UP_DAYS).
export function logFollowUpPatch(q: Quote) {
  return {
    last_followed_up_at: new Date().toISOString(),
    follow_up_count: (q.follow_up_count ?? 0) + 1,
  }
}

// DB patch when a quote is won — captures whether follow-ups drove the win.
export function markWonPatch(followUpCount: number) {
  return {
    status: 'accepted' as const,
    accepted_after_followup: (followUpCount ?? 0) > 0,
    follow_up_count_at_acceptance: followUpCount ?? 0,
  }
}
