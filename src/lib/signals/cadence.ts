// ── Cadence — THE "how many days between visits" engine ──────────────────────
// Previously four byte-identical copies: suggestions.cadenceIntervalDays,
// customerHealth.intervalDaysFor, revenueIntelligence.intervalDays and an inline
// block in the reactivation page. Same logic, four homes, easy to drift apart.

export interface CadenceRecLike {
  interval_unit?: string | null
  interval_count?: number | null
}

/** Days between visits: the standard cadence when known, else derived from the
 *  recurrence interval. Falls back to 14 (biweekly) when nothing is knowable —
 *  the historical default in every copy this replaces. */
export function cadenceDays(cadence: string | null, rec?: CadenceRecLike | null): number {
  if (cadence === 'weekly') return 7
  if (cadence === 'biweekly') return 14
  if (cadence === 'monthly') return 30
  if (!rec) return 14
  const c = Math.max(1, rec.interval_count ?? 1)
  return rec.interval_unit === 'day' ? c
    : rec.interval_unit === 'week' ? 7 * c
    : rec.interval_unit === 'month' ? 30 * c
    : 14
}
