import { isWithinSeason, seasonForService, ServiceSeasons } from '@/lib/seasons'
import { CHURN_RATIO_HIGH, CHURN_RATIO_WARN, RANOUT_URGENT_CADENCES, RANOUT_URGENT_MIN_DAYS } from './constants'

// ── Lifecycle — THE "where is this customer in their life" engine ────────────
// This replaces the worst duplication in the product. "Recurring series ran out"
// had SIX independent derivations (reactivation page, suggestions ×2,
// TodaysPriorities, weekly review, recurrence.paused) and churn/at-risk had FOUR
// different thresholds. The same snow customer in July was suppressed as dormant
// on one screen and flagged as lost on another.
//
// Inputs are PRIMITIVES, not any one engine's row type — every caller builds its
// own per-customer aggregates from a different shape, so normalising here would
// mean rewriting five loaders. Callers adapt; the RULES live here.

export function daysBetween(fromISODate: string, toISODate: string): number {
  return Math.round(
    (new Date(toISODate + 'T00:00:00').getTime() - new Date(fromISODate + 'T00:00:00').getTime()) / 86_400_000,
  )
}

// ── Seasonal dormancy ────────────────────────────────────────────────────────
// A recurring lawn/snow customer whose series ended because the SEASON ended is
// not lost — they're dormant until next season. They resurface automatically once
// their season returns and they still have nothing booked.
export function isSeasonallyDormant(
  serviceType: string | null,
  seasons: ServiceSeasons,
  today: string,
): boolean {
  const season = seasonForService(serviceType, seasons)
  return !!season && !isWithinSeason(today, season)
}

// ── Ran out ──────────────────────────────────────────────────────────────────
export interface RanOutInput {
  /** Customer has (or had) a recurring series. */
  hasRecurring: boolean
  /** A non-cancelled visit dated today-or-later exists (scheduled | in_progress). */
  hasUpcoming: boolean
  /** Last date they were ACTUALLY serviced. null = never → not a re-book. */
  lastServiceDate: string | null
  /** Days between visits for the series — from signals/cadence. */
  cadenceDays: number
  /** Out of season → dormant, not lost. */
  seasonallyDormant: boolean
  today: string
}

export interface RanOutSignal {
  /** The series has run dry and they're due to be re-booked. */
  isRanOut: boolean
  /** Still plausibly an active series → the urgent re-book queue. Past this they
   *  age into the ordinary lapse buckets instead of sitting red forever. */
  isUrgent: boolean
  daysSince: number | null
  /** Why it is NOT a ran-out, for surfaces that explain themselves. */
  reason: 'ran_out' | 'no_recurring' | 'has_upcoming' | 'never_serviced' | 'seasonally_dormant'
}

export function ranOut(input: RanOutInput): RanOutSignal {
  const { hasRecurring, hasUpcoming, lastServiceDate, cadenceDays, seasonallyDormant, today } = input
  const none = (reason: RanOutSignal['reason']): RanOutSignal => ({ isRanOut: false, isUrgent: false, daysSince: null, reason })

  if (!hasRecurring) return none('no_recurring')
  if (hasUpcoming) return none('has_upcoming')
  // Off-season first: a naturally-ended seasonal series is dormant, not lost.
  if (seasonallyDormant) return none('seasonally_dormant')
  // A series cancelled before any service isn't a re-book candidate.
  if (!lastServiceDate) return none('never_serviced')

  const daysSince = Math.max(0, daysBetween(lastServiceDate, today))
  const urgentWindow = Math.max(RANOUT_URGENT_MIN_DAYS, cadenceDays * RANOUT_URGENT_CADENCES)
  return { isRanOut: true, isUrgent: daysSince <= urgentWindow, daysSince, reason: 'ran_out' }
}

// ── Lapsed ───────────────────────────────────────────────────────────────────
// A customer with service history, nothing booked, and no active series.
export function isLapsed(input: { hasRecurring: boolean; hasUpcoming: boolean; completedVisits: number }): boolean {
  return !input.hasRecurring && !input.hasUpcoming && input.completedVisits >= 1
}

// ── Churn risk ───────────────────────────────────────────────────────────────
// How far past their own cadence has a recurring customer drifted. Replaces four
// engines that each picked their own thresholds (1.6/1.25 ratios, 0.6/0.4/0.2
// probabilities, and raw 90/180/365-day buckets that ignored cadence entirely).
export type ChurnLevel = 'none' | 'watch' | 'high'

export interface ChurnRisk {
  level: ChurnLevel
  /** days-since-last ÷ cadence interval. 0 when not applicable. */
  ratio: number
  /** Probability this customer is gone — the LTV-forecast weighting. */
  probability: number
  overdueDays: number | null
}

export function churnRisk(input: {
  hasActiveRecurring: boolean
  /** Days since their last completed visit. null when never serviced. */
  daysSinceLastService: number | null
  cadenceDays: number
  /** Out of season → not overdue; their rhythm is paused, not broken. */
  seasonallyDormant?: boolean
}): ChurnRisk {
  const { hasActiveRecurring, daysSinceLastService, cadenceDays, seasonallyDormant } = input

  // No active series → they aren't on a rhythm to fall behind; a flat risk.
  if (!hasActiveRecurring) return { level: 'none', ratio: 0, probability: 0.5, overdueDays: null }
  if (seasonallyDormant || daysSinceLastService == null || cadenceDays <= 0) {
    return { level: 'none', ratio: 0, probability: 0.2, overdueDays: null }
  }

  const ratio = daysSinceLastService / cadenceDays
  if (ratio >= CHURN_RATIO_HIGH) return { level: 'high', ratio, probability: 0.6, overdueDays: daysSinceLastService }
  if (ratio >= CHURN_RATIO_WARN) return { level: 'watch', ratio, probability: 0.4, overdueDays: daysSinceLastService }
  return { level: 'none', ratio, probability: 0.2, overdueDays: null }
}
