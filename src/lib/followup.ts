import type { Quote } from '@/types'
import { type ChasePolicy, resolveChasePolicy } from '@/lib/automation/policy'

// ── Follow-up — THE "has this quote gone quiet?" engine ──────────────────────
// One home for the rule, the owner's policy, and the DB patches. The automatic
// chaser (cron/quote-followup), the dashboard queue, the quote list, the weekly
// review and the Suggestions Center all decide staleness here, so they can never
// disagree about which quotes are stale — only about the cadence the owner chose.

// The default cadence — still what every manual surface (dashboard queue, quote
// list, weekly review) uses when no policy is passed.
export const FOLLOW_UP_DAYS = 3
// Chase twice, then stop. A third unanswered nudge reads as pestering, not service.
export const FOLLOW_UP_MAX = 2

const DAY_MS = 86_400_000

// ── Follow-up policy ─────────────────────────────────────────────────────────
// The owner's tuning for the AUTOMATIC chaser. Stored on the same
// business_settings.automations jsonb the on/off toggles already live on, so
// there's no migration and an unset key simply falls back to the defaults above.
// Same shape every chaser uses — the parse + clamps live in automation/policy.
export type FollowUpPolicy = ChasePolicy

export const DEFAULT_FOLLOW_UP_POLICY: FollowUpPolicy = { delayDays: FOLLOW_UP_DAYS, maxCount: FOLLOW_UP_MAX }

// Which jsonb keys this chaser reads is the only thing that's genuinely its own;
// the tolerance and the clamps are shared with the invoice chaser.
export function resolveFollowUpPolicy(raw: unknown): FollowUpPolicy {
  return resolveChasePolicy(raw, { delayKey: 'quote_followup_delay_days', maxKey: 'quote_followup_max' }, DEFAULT_FOLLOW_UP_POLICY)
}

// The clock a follow-up resets: the later of "when sent" and "last nudged".
export function followUpAnchor(q: Quote): string | null {
  return q.last_followed_up_at || q.sent_at
}

// Midnight-at-the-start of a YYYY-MM-DD day, as epoch ms. The Suggestions Center
// measures against this instead of the wall clock so a feed built in the morning
// can't change its mind at 11pm.
export function startOfDayMs(day: string): number {
  return new Date(day + 'T00:00:00').getTime()
}

export function daysSince(dateStr: string | null): number | null {
  if (!dateStr) return null
  return Math.floor((Date.now() - new Date(dateStr).getTime()) / DAY_MS)
}

// THE staleness rule — the only place "has this quote gone quiet?" is decided.
// `status !== 'sent'` is the terminal guard the whole system leans on: accepted,
// declined, scheduled, completed and paid all leave 'sent', so a quote stops
// being chased the moment it's answered — no separate stop list to keep in sync.
//
// `refMs` is the clock to measure against. It defaults to the wall clock (what
// the quote screens and the cron use); the Suggestions Center passes
// startOfDayMs(ctx.today). Injecting it is also what lets a server job evaluate
// this rule without a browser.
export function quoteIsQuiet(q: Quote, delayDays: number, refMs: number = Date.now()): boolean {
  if (q.status !== 'sent') return false
  const anchor = followUpAnchor(q)
  if (!anchor) return true // sent but never timestamped → surface it
  return Math.floor((refMs - new Date(anchor).getTime()) / DAY_MS) >= delayDays
}

// A sent quote that's gone quiet long enough to chase again, at the default
// cadence. Deliberately ONE argument: every caller passes this straight to
// `quotes.filter(needsFollowUp)`, and an optional second parameter would quietly
// receive filter's index instead.
export function needsFollowUp(q: Quote): boolean {
  return quoteIsQuiet(q, FOLLOW_UP_DAYS)
}

// Already chased as often as the owner allows.
export function followUpsExhausted(q: Quote, policy: FollowUpPolicy): boolean {
  return (q.follow_up_count ?? 0) >= policy.maxCount
}

// THE gate for the automatic chaser: quiet long enough (on the owner's cadence),
// and attempts left. Composed from the same quoteIsQuiet the manual queue uses
// rather than re-deriving staleness — the cron and the owner's follow-up queue
// can never disagree about which quotes are stale, only about the cadence the
// owner deliberately chose.
export function dueForAutoFollowUp(q: Quote, policy: FollowUpPolicy): boolean {
  return quoteIsQuiet(q, policy.delayDays) && !followUpsExhausted(q, policy)
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
