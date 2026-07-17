import type { Quote, QuoteStatus } from '@/types'
import { parseLocalDate } from '@/lib/utils'

// ── Quote expiry ─────────────────────────────────────────────────────────────
// THE single place "has this quote expired?" is decided — the exact shape
// lib/payments/ledger uses for invoices, where 'overdue' is a DISPLAY overlay
// derived from real state rather than a stored status. Same reasoning here:
// 'expired' is never written to quotes.status, so there is no second lifecycle to
// keep in sync, nothing to backfill, and a quote un-expires the instant the owner
// extends its date.
//
// Only a SENT quote can expire. A draft was never out there; accepted/declined/
// scheduled/completed/paid are already decided and their price is settled — an
// "expired" badge on a won job would be nonsense.

export type QuoteDisplayStatus = QuoteStatus | 'expired'

// How long a sent quote stands by default. Long enough to think it over, short
// enough that costs haven't moved under you.
export const DEFAULT_QUOTE_VALID_DAYS = 30
// Inside this window the owner is warned it's about to lapse — while there's
// still time to chase it.
export const EXPIRING_SOON_DAYS = 5

export type ExpirableQuote = Pick<Quote, 'status'> & { valid_until?: string | null }

// The stored status, overlaid with 'expired'. Date-only string compare (both are
// 'YYYY-MM-DD'), so there's no timezone to get wrong.
export function displayQuoteStatus(q: ExpirableQuote, todayISO: string): QuoteDisplayStatus {
  if (q.status === 'sent' && q.valid_until && q.valid_until < todayISO) return 'expired'
  return q.status
}

export function isQuoteExpired(q: ExpirableQuote, todayISO: string): boolean {
  return displayQuoteStatus(q, todayISO) === 'expired'
}

// Whole days until it lapses: 0 = today is the last day, negative = already
// expired, null = no expiry set (or not a live quote worth warning about).
export function daysUntilExpiry(q: ExpirableQuote, todayISO: string): number | null {
  if (q.status !== 'sent' || !q.valid_until) return null
  const ms = parseLocalDate(q.valid_until).getTime() - parseLocalDate(todayISO).getTime()
  return Math.round(ms / 86_400_000)
}

// Live, still valid, and lapsing soon — the only state worth nagging the owner about.
export function isExpiringSoon(q: ExpirableQuote, todayISO: string): boolean {
  const d = daysUntilExpiry(q, todayISO)
  return d != null && d >= 0 && d <= EXPIRING_SOON_DAYS
}

// The date a quote sent on `fromISO` should stand until.
export function defaultValidUntil(fromISO: string, days = DEFAULT_QUOTE_VALID_DAYS): string {
  const d = parseLocalDate(fromISO)
  d.setDate(d.getDate() + days)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

// ── THE "this quote went out" patch ──────────────────────────────────────────
// Quote V2 Phase 0. "A quote was sent" is ONE event that sets three things: the
// status, the chase anchor (sent_at) and the expiry clock (valid_until). It was
// written FOUR times, and each copy did something different:
//
//   quotes/[id] (PDF path)   status + sent_at + valid_until   ← the only complete one
//   QuoteStatusControl:52    sent_at only
//   QuoteList:131-132        status + sent_at, in TWO updates
//   SendMessageDialog:736    status + sent_at
//
// The cost of that, measured on the live book: 0 of 55 quotes have a `valid_until`,
// so the expiry feature shipped 2026-07-15 has never once fired — the "Expired"
// badge, the cron's expiry stop and the portal's lapse are all unreachable. And 33
// of 54 non-draft quotes have no `sent_at`, so the timeline shows no "Quote sent"
// event for any of them.
//
// This is the species the redesign exists to kill: one concept, four
// implementations, and the incomplete copies were the ones most paths used.
//
// PURE, and it OMITS rather than overwrites. `sent_at` is when it FIRST went out —
// the chase anchor — so re-sending must not reset it (the old writers expressed this
// as `.is('sent_at', null)`; the same rule now lives in one testable place).
// `valid_until` likewise stands from the first send; extending it deliberately is
// what `extendValidity` is for.
//
// It does NOT dispatch anything. Marking sent and actually sending are two different
// facts, and conflating them is exactly why 11 of 14 "sent" quotes have zero
// messages against them. This patch is the record; the sender is the sender.
export type SentPatchInput = Pick<Quote, 'sent_at'> & { valid_until?: string | null }

export function markSentPatch(
  q: SentPatchInput,
  todayISO: string,
  nowISO: string = new Date().toISOString(),
): Record<string, unknown> {
  return {
    status: 'sent' as const,
    ...(q.sent_at ? {} : { sent_at: nowISO }),
    ...(q.valid_until ? {} : { valid_until: defaultValidUntil(todayISO) }),
  }
}
