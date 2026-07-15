// ── Review lifecycle (pure) ──────────────────────────────────────────────────
// Derives the review status from the customer columns added in migration
// 2026-06-25h. There is NO separate review table or flag — reviewed_at remains
// the single source of "they left a review", and these helpers layer the
// Not-requested → Requested → Reviewed / Declined lifecycle on top of it.

import type { Customer } from '@/types'

export type ReviewStatus = 'not_requested' | 'requested' | 'reviewed' | 'declined'

// Just the review-relevant fields, so callers (lists, panels) can pass a thin
// projection without the full Customer.
export interface ReviewFields {
  reviewed_at?: string | null
  review_requested_at?: string | null
  review_declined_at?: string | null
  review_source?: string | null
  review_rating?: number | null
}

// Precedence: a left review wins over everything; an explicit decline wins over a
// pending ask; an ask shows as Requested; otherwise Not requested.
export function reviewStatus(c: ReviewFields | Customer): ReviewStatus {
  if (c.reviewed_at) return 'reviewed'
  if (c.review_declined_at) return 'declined'
  if (c.review_requested_at) return 'requested'
  return 'not_requested'
}

export const REVIEW_STATUS_META: Record<ReviewStatus, { label: string; tone: string }> = {
  not_requested: { label: 'Not requested', tone: 'text-ink-muted border-border bg-surface' },
  requested:     { label: 'Requested',     tone: 'text-amber-400 border-amber-500/30 bg-amber-500/10' },
  reviewed:      { label: 'Reviewed',      tone: 'text-emerald-400 border-emerald-500/30 bg-emerald-500/10' },
  declined:      { label: 'Declined',      tone: 'text-ink-faint border-border bg-bg-tertiary' },
}

// Where the review landed. Matches what portal_mark_reviewed defaults to (Google).
export const REVIEW_SOURCES = ['Google', 'Facebook', 'Yelp', 'Nextdoor', 'Other'] as const
export type ReviewSource = (typeof REVIEW_SOURCES)[number]

// A customer is worth ASKING when nobody has asked yet and they haven't reviewed
// or declined — used by the review-pipeline rollup to surface ask candidates.
export function canAskForReview(c: ReviewFields): boolean {
  return reviewStatus(c) === 'not_requested'
}

// The columns canAskForReview() reads, expressed as a PostgREST filter.
//
// There are TWO review senders — the day-after automation (per completed job) and
// the `review` campaign (a periodic sweep) — and they dedupe in different ledgers:
// notification_log per job, crm_campaign_log per period. Neither can see the
// other, so the only thing that can stop a customer being asked by BOTH is the
// column they both write: customers.review_requested_at, stamped by
// trg_crm_stamp_review_requested on every successful ask.
//
// So both consult ONE rule — the cron via canAskForReview() on a loaded row, the
// campaign audience via this filter — and "already asked, by anyone" means
// nobody asks again.
export function applyCanAskForReview<Q extends { is(column: string, value: unknown): Q }>(q: Q): Q {
  return q.is('reviewed_at', null).is('review_declined_at', null).is('review_requested_at', null)
}
