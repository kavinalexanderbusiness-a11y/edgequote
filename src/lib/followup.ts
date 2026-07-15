import type { Quote } from '@/types'
import {
  compareFollowUp as compareFollowUpOn,
  daysElapsed,
  followUpAnchor as followUpAnchorOn,
  needsFollowUp as needsFollowUpOn,
} from '@/lib/signals'

// Quote-shaped façade over the signals/followup engine (which owns the rule and
// takes an injectable `today`), plus the DB patch builders the quote screens use.

// Fixed for v1 — intentionally not configurable yet (use it in the real world
// first, then decide if a Settings knob is worth the dev time).
export { FOLLOW_UP_DAYS } from '@/lib/signals'

// The clock a follow-up resets: the later of "when sent" and "last nudged".
export function followUpAnchor(q: Quote): string | null {
  return followUpAnchorOn(q)
}

// Wall-clock days elapsed — the quote screens' clock, and the same counter
// needsFollowUp uses here, so the displayed age and the queue never disagree.
export function daysSince(dateStr: string | null): number | null {
  return daysElapsed(dateStr)
}

// A sent quote that's gone quiet long enough to chase again.
export function needsFollowUp(q: Quote): boolean {
  return needsFollowUpOn(q)
}

// Oldest first; ties broken by highest quote value (chase the stale money first).
export function compareFollowUp(a: Quote, b: Quote): number {
  return compareFollowUpOn(a, b)
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
