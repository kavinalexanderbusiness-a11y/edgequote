// ── Signal constants — THE thresholds ────────────────────────────────────────
// One definition each. These were previously hardcoded in 4+ places apiece, so a
// customer could be a VIP on one screen and not on another.

/** Lifetime revenue at which a customer is a VIP. Was duplicated in suggestions,
 *  reactivation, customerHealth and revenueIntelligence. */
export const VIP_LTV = 1500

// FOLLOW_UP_DAYS deliberately lives in lib/followup.ts, next to the chase policy
// that clamps against it — not mirrored here. One home per rule.

/** How far past its own cadence a series must drift before it reads as at-risk.
 *  `warn` and `high` were the 1.25 / 1.6 ratios repeated across four engines. */
export const CHURN_RATIO_WARN = 1.25
export const CHURN_RATIO_HIGH = 1.6

/** A ran-out series stays "urgently re-bookable" for this long before it ages into
 *  the ordinary lapse buckets. `max(RANOUT_URGENT_MIN_DAYS, cadenceDays * N)`. */
export const RANOUT_URGENT_MIN_DAYS = 21
export const RANOUT_URGENT_CADENCES = 3

/** Lapse buckets (days since last service) used by the reactivation queue. */
export const LAPSE_BUCKET_DAYS = { '3+': 90, '6+': 180, '12+': 365 } as const
