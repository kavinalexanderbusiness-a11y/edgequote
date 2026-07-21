import type { ExpenseWithRelations } from '@/types'
import { marginPct, unitProfit, marginTone, formatPct, type MarginTone } from '@/lib/margin'
import { expenseCost } from '@/lib/accounting/report'

// ── Job costing — what a visit REALLY cost ───────────────────────────────────
// Falls out of expenses.job_id: no second table, no second engine. This module
// only groups rows and asks lib/margin.ts the arithmetic questions — it does not
// own a formula.
//
// ══ WHY THIS DOES NOT ADD LABOUR, and why that is not an omission ════════════
// lib/economics.ts (visitEconomics) already answers "was this visit worth the
// drive": revenue − crew-hours × crew_cost_per_hour. That rate is LOADED — its own
// docs say "labour + overhead" — so it ALREADY has fuel, vehicle wear and admin
// baked into it as an estimate.
//
// Adding receipted fuel on top of a loaded labour rate counts the same fuel twice
// and reports a loss the business never had. So these are two DIFFERENT questions
// and this module answers only the second:
//
//   economics.ts  → ESTIMATED. Is this visit worth doing? (a planning number,
//                   available for every job, from a rate the owner set once)
//   this module   → ACTUAL. What did we provably spend on it? (a receipts number,
//                   available only for jobs with expenses tagged)
//
// They are not summed, not averaged, and never shown as one figure. If a combined
// "true job profit" is ever wanted, it needs the owner to split crew_cost_per_hour
// into labour-only vs overhead first — otherwise the double count is unavoidable.
// That is a product decision, not something to quietly infer here.
//
// ══ THE HONESTY RULE (inherited from lib/margin.ts) ══════════════════════════
// A job with NO expenses tagged has an UNKNOWN cost — not a zero cost. Returning 0
// would report 100% margin on every job in the business, since almost no job will
// have a receipt attached. That is the exact trap margin.ts exists to prevent, so
// `directCost` is null until at least one expense points at the job, and every
// figure derived from it is null too. The UI renders "—", not a number.

export interface JobCosting {
  jobId: string
  /** What the job bills. */
  revenue: number | null
  /** Provable direct cost from receipts — NULL when nothing is tagged (unknown ≠ 0). */
  directCost: number | null
  /** Gross spend tagged to the job (tax included) — ties to the bank. */
  directCostGross: number | null
  /** revenue − directCost. Null when either is unknown. */
  profit: number | null
  /** Share of revenue kept, 0..100. Null when unknown. */
  marginPercent: number | null
  tone: MarginTone
  /** How many receipts back this. 0 means the cost is unknown, not zero. */
  expenseCount: number
  expenses: ExpenseWithRelations[]
}

/**
 * Cost one job from the expenses tagged to it.
 *
 * `registrant` decides gross vs net exactly as the P&L does — via the shared
 * expenseCost(), so a job's cost and the P&L's cost can never use different rules.
 */
export function costJob(
  p: { jobId: string; revenue: number | null | undefined; expenses: ExpenseWithRelations[]; registrant: boolean },
): JobCosting {
  const mine = p.expenses.filter(e => e.job_id === p.jobId)
  const revenue = p.revenue == null ? null : Number(p.revenue) || 0

  // The honesty rule, in one line: nothing tagged → unknown, never 0.
  const directCost = mine.length
    ? round2(mine.reduce((s, e) => s + expenseCost(e, p.registrant), 0))
    : null
  const directCostGross = mine.length
    ? round2(mine.reduce((s, e) => s + (Number(e.amount) || 0), 0))
    : null

  // margin.ts is THE calculator — this module never writes (price − cost) / price.
  const marginPercent = marginPct(revenue, directCost)

  return {
    jobId: p.jobId,
    revenue,
    directCost,
    directCostGross,
    profit: unitProfit(revenue, directCost),
    marginPercent,
    tone: marginTone(marginPercent),
    expenseCount: mine.length,
    expenses: mine,
  }
}

export interface JobLike {
  id: string
  /**
   * What the visit is worth, from THE valuation seam (lib/invoicing
   * jobVisitValue, applied in lib/accounting/data.ts). NULL = genuinely unknown.
   *
   * Costing used to read `price` directly, which is only the manual OVERRIDE —
   * most jobs carry none, so most of the book valued at $0 and every margin
   * derived from it was computed against revenue the business had actually
   * earned. `price` is still accepted below as a fallback for callers that
   * haven't been through the loader, but it is not the answer.
   */
  value?: number | null
  price?: number | null
}

/**
 * Cost many jobs at once — one pass over the expenses, not one pass per job.
 *
 * Jobs with nothing tagged are still returned, with a null cost. Dropping them
 * would make the list read as "these are the jobs with costs", which is a subtly
 * different and much more flattering claim than "these are the jobs".
 */
export function costJobs(
  p: { jobs: JobLike[]; expenses: ExpenseWithRelations[]; registrant: boolean },
): JobCosting[] {
  const byJob = new Map<string, ExpenseWithRelations[]>()
  for (const e of p.expenses) {
    if (!e.job_id) continue
    const list = byJob.get(e.job_id)
    if (list) list.push(e)
    else byJob.set(e.job_id, [e])
  }
  return p.jobs.map(j =>
    costJob({
      jobId: j.id,
      // The seam's answer first; `price` only for callers that bypassed the loader.
      revenue: j.value ?? j.price ?? null,
      expenses: byJob.get(j.id) || [],
      registrant: p.registrant,
    }),
  )
}

export interface JobCostingRollup {
  /** Jobs that have at least one receipt tagged — the only ones with a knowable cost. */
  costedJobs: number
  totalJobs: number
  /** Revenue of the COSTED jobs only. Mixing in uncosted jobs' revenue would inflate margin. */
  revenue: number
  cost: number
  profit: number
  /** Share of revenue kept across costed jobs, 0..100. Null when they billed nothing. */
  marginPercent: number | null
  /** Spend tagged to no job at all — overhead, or a receipt someone forgot to link. */
  untaggedCost: number
}

/**
 * Roll many costed jobs into one line.
 *
 * Only jobs WITH receipts contribute. Including a job with no tagged cost would add
 * its revenue and no cost, quietly lifting the blended margin toward 100% — which
 * is the aggregate version of the very trap costJob() avoids per row.
 */
export function rollupJobCosting(
  costings: JobCosting[],
  allExpenses: ExpenseWithRelations[],
  registrant: boolean,
): JobCostingRollup {
  const costed = costings.filter(c => c.directCost != null)
  const revenue = round2(costed.reduce((s, c) => s + (c.revenue || 0), 0))
  const cost = round2(costed.reduce((s, c) => s + (c.directCost || 0), 0))
  return {
    costedJobs: costed.length,
    totalJobs: costings.length,
    revenue,
    cost,
    profit: round2(revenue - cost),
    marginPercent: marginPct(revenue, cost),
    untaggedCost: round2(
      allExpenses.filter(e => !e.job_id).reduce((s, e) => s + expenseCost(e, registrant), 0),
    ),
  }
}

/** Re-exported so a component never reaches past this module for the same question. */
export { formatPct }

const round2 = (n: number) => Math.round(n * 100) / 100
