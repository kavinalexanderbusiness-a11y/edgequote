import { effectiveFreq, jobVisitValue } from '@/lib/invoicing'
import { VIP_LTV } from './constants'

// ── Lifetime value — THE "what is this customer worth" engine ────────────────
// Previously recomputed in five places (suggestions, customerHealth,
// businessIntelligence, revenueIntelligence, reactivation). They disagreed: the
// reactivation page omitted `is_initial_visit`, so an initial visit was valued at
// the recurring rate there and at the initial rate on the customer page — and
// since LTV gates the VIP flag, the same customer could be a VIP on one screen
// and not on another. This honours is_initial_visit, matching the engine that had
// it right.

export interface ValuedJob {
  price?: number | null
  quote_id?: string | null
  recurrence_id?: string | null
  is_initial_visit?: boolean | null
}
export interface ValueRec {
  freq?: string | null
  interval_unit?: string | null
  interval_count?: number | null
}

/** Value of ONE visit: the job's own price when set, else the linked quote's
 *  cadence price (initial vs recurring aware). Thin wrapper over the existing
 *  jobVisitValue engine — no new money math. */
export function visitValue(
  job: ValuedJob,
  quotesById: Record<string, unknown>,
  recurrences: Record<string, ValueRec>,
): number {
  const q = job.quote_id ? quotesById[job.quote_id] : null
  const rec = job.recurrence_id ? recurrences[job.recurrence_id] : null
  const freq = rec ? effectiveFreq(rec.freq ?? null, rec.interval_unit ?? null, rec.interval_count ?? null) : null
  return jobVisitValue(job.price ?? null, q as Record<string, unknown> | null, freq, job.is_initial_visit ?? false)
}

/** Lifetime revenue = the value of every COMPLETED visit. Callers pass their own
 *  already-filtered completed list (each engine builds it differently). */
export function lifetimeValue(
  completedJobs: ValuedJob[],
  quotesById: Record<string, unknown>,
  recurrences: Record<string, ValueRec>,
): number {
  return Math.round(completedJobs.reduce((sum, j) => sum + visitValue(j, quotesById, recurrences), 0))
}

/** Is this customer a VIP by lifetime revenue? */
export function isVip(ltv: number): boolean {
  return ltv >= VIP_LTV
}
