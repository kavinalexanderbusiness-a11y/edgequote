// ── Estimated vs Actual — THE learning comparison primitive ──────────────────
// One question, one answer: "what did I think this visit would take, and what
// did it actually take?" Pure arithmetic over visits that are already complete.
// No I/O, no React, no supabase — so job detail, reporting, quoting intelligence
// and pricing calibration can all read the SAME comparison later without any of
// them re-deriving it.
//
// ══ WHY THIS IS MINUTES AND NOT DOLLARS ══════════════════════════════════════
// Measured against production before a line was written:
//   * time_entries        — 0 rows. There is no wage clock, so actual LABOUR COST
//                           does not exist anywhere in the product.
//   * expenses            — 0 rows. No receipt is tagged to any job, so actual
//                           MATERIALS and actual JOB COST do not exist either.
//   * business_settings.crew_cost_per_hour — a LOADED planning rate (labour +
//                           overhead, see lib/economics). It is an ESTIMATE.
//
// So the only honest dollar figure available would be `actual_minutes × an
// estimated rate`, which is not an actual cost — it is the same estimate wearing
// a different unit. Worse, since both sides would be multiplied by that one
// constant, a "cost variance" computed that way carries EXACTLY the information
// already in the minute variance, while looking like independent evidence that
// the business lost money. That is the fake-precision trap this module exists to
// avoid, so nothing here returns a currency amount. When receipts and a wage
// clock have real rows, cost belongs in lib/accounting/jobCosting (ACTUAL) — not
// here, and never blended with lib/economics (ESTIMATED). See the header of
// jobCosting.ts for why those two are never summed.
//
// ══ THE HONESTY RULES ════════════════════════════════════════════════════════
// 1. UNKNOWN IS NOT ZERO. No estimate, or no actual, → `null` and a `reason`.
//    Returning 0 would report a perfect estimate on every untimed visit, which
//    is the flattering direction and the one that gets believed.
// 2. A FAILED OR EMPTY READ IS NOT ZERO VARIANCE. Every aggregate carries its own
//    `sampleSize`; an empty set yields `variancePct: null`, never 0.
// 3. THE DENOMINATOR IS THE ESTIMATE. "How wrong was the plan" is measured
//    against the plan: (actual − estimated) / estimated. Positive = ran long =
//    underestimated. This matches how an owner states it ("8h became 11h — I was
//    37.5% under") and it is the only denominator under which the sign means
//    what the words say.
//    ⚠️ Two OTHER modules already measure estimate error and they disagree with
//    each other on this: lib/labor.buildLaborInsights divides by ACTUAL, while
//    lib/businessIntelligence divides by ESTIMATE — and both then take an
//    absolute value, so neither can say which DIRECTION the owner is wrong in.
//    They answer "how accurate am I" (a magnitude). This module answers "which
//    way am I wrong, and by how much" (a signed bias) — the question nothing
//    answered before. They are deliberately left alone rather than quietly
//    re-pointed; unifying that denominator is a follow-up with its own surfaces.
// 4. ONLY COMPLETED VISITS. A cancelled visit never happened and an in-progress
//    one is not finished. This matters concretely: the trigger that records a
//    labour observation (trg_capture_labor) fires on ANY change to
//    jobs.actual_minutes and does NOT check status, and re-opening a completed
//    visit keeps its banked minutes — so an observation can outlive the
//    completion that justified it. Status is re-checked here, at read time.
// 5. ONE ROW PER VISIT. Deduplicated by job id, so a visit that appears twice in
//    a query (a join fan-out, a merged page of results) cannot be counted twice.

import { serviceKey, serviceLabel } from '@/lib/serviceKey'

const round1 = (n: number) => Math.round(n * 10) / 10

// Plausibility bounds for a stopwatch reading — a mis-tap or a timer left
// running is not evidence about estimating. Production contains exactly one such
// row today: a "General Landscaping" visit recorded at 1 minute against a
// 15-minute estimate, which alone would read as −93%.
//
// The LOWER bound is lib/duration.ts's, unchanged: under 5 minutes nobody did
// the work. The UPPER bound is deliberately WIDER than duration.ts's 600, and
// the difference is not an oversight — the two filters serve different jobs.
// duration.ts learns a MEDIAN for scheduling, where a long tail drags the centre
// and a tight cap is right. This module reports a SPECIFIC visit back to the
// owner who just recorded it, so discarding a real 11-hour landscaping day as a
// "mis-tap" would be its own dishonesty — silently dropping true data. 16 hours
// is past any single visit a crew can actually work and still catches the timer
// left running overnight, which is the failure this bound exists for.
export const MIN_PLAUSIBLE_MINUTES = 5
export const MAX_PLAUSIBLE_MINUTES = 960

// How many comparable visits before a per-service claim is presented as an
// established finding rather than an observation.
//
// WHY 5, when the estimators nearby use 3: those thresholds gate a GUESS that
// gets silently corrected by the next data point. This one gates a SENTENCE
// shown to an owner ("mowing runs 18% long"), which is acted on. At n=3 a single
// bad row is a third of the evidence and can flip the sign of the answer; at n=5
// it cannot. Buckets under the threshold are still returned, with `established:
// false` and their real sampleSize — dropping them would make the list read as
// "these are your services", a different and much stronger claim than the data
// supports.
export const MIN_SERVICE_SAMPLE = 5

/** The slice of a visit this engine needs. Callers select narrowly. */
export interface VisitLike {
  id: string
  status: string | null | undefined
  service_type?: string | null
  scheduled_date?: string | null
  /** The plan: estimated on-site minutes (jobs.duration_minutes). */
  duration_minutes?: number | null
  /** What happened: recorded ELAPSED on-site minutes (jobs.actual_minutes). */
  actual_minutes?: number | null
  /**
   * How many people the visit was PLANNED for (jobs.crew_size).
   *
   * ⚠️ THE PLAN, NOT THE ATTENDANCE. Nothing in the product records who actually
   * turned up; crew_size is what was typed when the visit was made. So anything
   * derived from it is a planned-crew figure and carries that label all the way
   * to the screen — and per lib/jobCost it may never be priced. A null here is
   * NOT a one-person crew: it is a visit that never said, and it is excluded from
   * every crew figure rather than counted as 1.
   */
  crew_size?: number | null
}

/** Why a visit yields no comparison. Never collapsed into a zero. */
export type NotComparable =
  | 'not_completed'
  | 'no_estimate'
  | 'no_actual'
  | 'implausible_actual'

export interface LaborComparison {
  jobId: string
  serviceKey: string
  serviceLabel: string
  serviceDate: string | null
  estimatedMinutes: number
  /** ELAPSED minutes on site — the stopwatch, not the person-hours. */
  actualMinutes: number
  /** actual − estimated. Positive = ran long. */
  varianceMinutes: number
  /** (actual − estimated) / estimated × 100, signed, 1dp. */
  variancePct: number
  /** Planned crew. NULL when the visit did not state one — never defaulted to 1. */
  crewSize: number | null
  /**
   * PERSON-minutes: elapsed × planned crew. NULL exactly when `crewSize` is.
   *
   * ⚠️ A DIFFERENT QUESTION FROM `actualMinutes`, NOT A BIGGER VERSION OF IT.
   * Elapsed answers "how long is this day blocked" (scheduling); labour answers
   * "how much work is in it" (costing/capacity). 3 people for 5 hours is 5 hours
   * elapsed and 15 labour-hours, and the two are never interchangeable: putting
   * labour into a calendar triples the job, putting elapsed into a cost divides
   * it by three. Both figures travel together so no consumer has to multiply —
   * multiplying at the call site is how the confusion starts.
   */
  laborMinutes: number | null
}

export interface VisitLaborRead {
  estimatedMinutes: number | null
  actualMinutes: number | null
  /** Null whenever the two cannot be honestly compared — see `reason`. */
  comparison: LaborComparison | null
  /** Null exactly when `comparison` is non-null. */
  reason: NotComparable | null
}

/**
 * Read one visit. This is the ONE place the comparability rules live, so a UI
 * can render "—" and say why without inventing its own idea of "usable".
 */
export function readVisitLabor(v: VisitLike): VisitLaborRead {
  const estRaw = Number(v.duration_minutes)
  const actRaw = Number(v.actual_minutes)
  const estimatedMinutes = Number.isFinite(estRaw) && estRaw > 0 ? estRaw : null
  const actualMinutes = Number.isFinite(actRaw) && actRaw > 0 ? actRaw : null
  const bare = { estimatedMinutes, actualMinutes, comparison: null }

  // Status first: a cancelled or unfinished visit is not evidence about
  // estimating, however much time is banked against it.
  if (v.status !== 'completed') return { ...bare, reason: 'not_completed' }
  if (estimatedMinutes == null) return { ...bare, reason: 'no_estimate' }
  if (actualMinutes == null) return { ...bare, reason: 'no_actual' }
  if (actualMinutes < MIN_PLAUSIBLE_MINUTES || actualMinutes > MAX_PLAUSIBLE_MINUTES) {
    return { ...bare, reason: 'implausible_actual' }
  }

  const key = serviceKey(v.service_type)
  // A visit that never stated a crew contributes NO crew evidence and NO labour
  // evidence. Coercing the null to 1 would manufacture a "typical crew of 1"
  // out of silence, and then manufacture person-hours from it.
  const crewRaw = Number(v.crew_size)
  const crewSize = Number.isFinite(crewRaw) && crewRaw >= 1 ? Math.round(crewRaw) : null
  return {
    estimatedMinutes,
    actualMinutes,
    reason: null,
    comparison: {
      jobId: v.id,
      serviceKey: key,
      serviceLabel: serviceLabel(key),
      serviceDate: v.scheduled_date ?? null,
      estimatedMinutes,
      actualMinutes,
      varianceMinutes: actualMinutes - estimatedMinutes,
      variancePct: round1(((actualMinutes - estimatedMinutes) / estimatedMinutes) * 100),
      crewSize,
      laborMinutes: crewSize == null ? null : actualMinutes * crewSize,
    },
  }
}

export interface VarianceRollup {
  /** Comparable visits behind these figures. 0 means unknown, not "on target". */
  sampleSize: number
  totalEstimatedMinutes: number
  totalActualMinutes: number
  /** Total actual − total estimated, in minutes. */
  varianceMinutes: number
  /**
   * Bias across the sample, as a %. NULL when there is nothing to divide.
   *
   * RATIO OF SUMS, not the mean of the per-visit percentages. Averaging
   * percentages weights a 15-minute visit that ran 15 minutes over (+100%) five
   * times as heavily as a 120-minute visit that ran 60 over (+50%), so the
   * headline stops describing the hours the business actually loses. The ratio
   * of sums answers the question an owner is really asking: across this work,
   * how much more time did it take than I planned.
   */
  variancePct: number | null
  /** The TYPICAL visit, immune to one big job dominating. Null when empty. */
  medianVariancePct: number | null
  /**
   * ⚠️ THREE INDEPENDENT MEDIANS — they do NOT subtract.
   *
   * `medianVarianceMinutes` is the median of the PER-VISIT differences (a paired
   * statistic), not `medianActualMinutes − medianEstimatedMinutes`. Those two are
   * different numbers whenever the biggest plans are not also the biggest misses,
   * which is the normal case.
   *
   * The paired one is the honest answer to "how far off is a typical visit",
   * because every comparable visit contributes its own estimate AND its own
   * actual; unpairing them would compare the plan of one visit to the outcome of
   * another. The other two exist only to give that number context, so any UI
   * showing all three must word them as three facts and never stack them in a
   * column that invites the reader to do the subtraction.
   */
  medianEstimatedMinutes: number | null
  medianActualMinutes: number | null
  medianVarianceMinutes: number | null
  /** sampleSize >= MIN_SERVICE_SAMPLE — is this a finding or an observation? */
  established: boolean

  // ── The crew dimension ─────────────────────────────────────────────────────
  /**
   * How many of `sampleSize`'s visits actually STATED a crew. Its own number
   * because it is its own evidence: six comparable visits of which two named a
   * crew back the crew figures with two, not six, and a claim shown at n=6 that
   * really rests on n=2 is precisely the "unreliable sample presented as
   * established" failure. Consumers gate crew/labour on THIS count.
   */
  crewSampleSize: number
  /** Typical planned crew. Null when no visit stated one — never 1 by default. */
  medianCrewSize: number | null
  /**
   * Typical PERSON-minutes per visit — the median of each visit's own
   * elapsed × its own crew.
   *
   * ⚠️ PAIRED, and it does NOT equal `medianActualMinutes × medianCrewSize`.
   * Same rule as the three medians above: every visit contributes its own
   * elapsed AND its own crew, so unpairing them would multiply one visit's hours
   * by another visit's headcount. A surface showing elapsed, crew and labour
   * together must word them as three facts and must not invite the reader to
   * check the multiplication — it will not come out, and that is correct.
   */
  medianLaborMinutes: number | null
}

function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b)
  const m = Math.floor(s.length / 2)
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2
}

export function rollupLaborVariance(cs: LaborComparison[]): VarianceRollup {
  const totalEstimatedMinutes = cs.reduce((s, c) => s + c.estimatedMinutes, 0)
  const totalActualMinutes = cs.reduce((s, c) => s + c.actualMinutes, 0)
  // Only visits that stated a crew. Filtered, not defaulted — a visit with no
  // crew is missing evidence, and missing evidence must shrink the sample rather
  // than quietly join it as a one-person job.
  const crewed = cs.filter(c => c.crewSize != null && c.laborMinutes != null)
  return {
    sampleSize: cs.length,
    totalEstimatedMinutes,
    totalActualMinutes,
    varianceMinutes: totalActualMinutes - totalEstimatedMinutes,
    // Guarded, not assumed: an empty set has no bias to report, and reporting 0
    // would say "your estimates are perfect" on a business with no data at all.
    variancePct: totalEstimatedMinutes > 0
      ? round1(((totalActualMinutes - totalEstimatedMinutes) / totalEstimatedMinutes) * 100)
      : null,
    medianVariancePct: cs.length ? round1(median(cs.map(c => c.variancePct))) : null,
    // Each guarded on its own. An empty sample has no typical anything, and a 0
    // here would be read as "a typical visit lands exactly on plan".
    medianEstimatedMinutes: cs.length ? round1(median(cs.map(c => c.estimatedMinutes))) : null,
    medianActualMinutes: cs.length ? round1(median(cs.map(c => c.actualMinutes))) : null,
    medianVarianceMinutes: cs.length ? round1(median(cs.map(c => c.varianceMinutes))) : null,
    established: cs.length >= MIN_SERVICE_SAMPLE,
    crewSampleSize: crewed.length,
    medianCrewSize: crewed.length ? round1(median(crewed.map(c => c.crewSize as number))) : null,
    medianLaborMinutes: crewed.length ? round1(median(crewed.map(c => c.laborMinutes as number))) : null,
  }
}

export interface ServiceVariance extends VarianceRollup {
  serviceKey: string
  serviceLabel: string
}

/**
 * Group by CANONICAL service identity — lib/serviceKey, the one normalizer the
 * labour and pricing learners already share.
 *
 * This is a declared relationship, not a similarity guess: production carries
 * "Lawn Mowing", "Weekly Mowing", "Bi-Weekly Mowing" and "Lawn mowing" as four
 * distinct free-text strings for one service, and grouping on the raw string
 * would split 30 comparable visits into four buckets, none of which clears any
 * sample threshold. Nothing here infers that two differently-named services are
 * the same; serviceKey decides, and it never merges across its defined services.
 */
export function laborVarianceByService(cs: LaborComparison[]): ServiceVariance[] {
  const byKey = new Map<string, LaborComparison[]>()
  for (const c of cs) {
    const list = byKey.get(c.serviceKey)
    if (list) list.push(c)
    else byKey.set(c.serviceKey, [c])
  }
  return Array.from(byKey.entries())
    .map(([key, list]) => ({
      ...rollupLaborVariance(list),
      serviceKey: key,
      serviceLabel: list[0].serviceLabel,
    }))
    // Established findings first, then by evidence. Never by "worst" — that would
    // manufacture a ranking out of buckets that may not be comparable at all.
    .sort((a, b) =>
      Number(b.established) - Number(a.established) ||
      b.sampleSize - a.sampleSize ||
      a.serviceLabel.localeCompare(b.serviceLabel))
}

/**
 * ⭐ THE CONSUMABLE PRIMITIVE — "what does history say about THIS service?"
 *
 * One service in, one evidence-carrying answer out. This is the shape every
 * later surface is meant to read (quote builder pricing help, job detail,
 * reporting, the service catalog) so none of them has to know how a bucket is
 * built, what a threshold is, or which statistic is the honest one.
 *
 * It ALWAYS returns a rollup, never null. A service with no history comes back
 * with `sampleSize: 0`, `established: false` and every figure `null` — so a
 * caller cannot accidentally render an absent history as agreement, and the
 * sample size is always available to display beside any claim.
 *
 * ⚠️ It is a REPORT, not an input to a price. Nothing here may be multiplied
 * into a quote, written back onto an estimate, or used to adjust a rate. The
 * owner reads it and decides; see the module header and [pricing-v2] — the
 * standing rule is that the system provides evidence and never re-prices on its
 * own.
 *
 * `excludeJobId` keeps a visit out of its own history. Without it, an owner
 * looking at a finished visit is shown a "typical" that includes the very row
 * on screen — self-reference that is invisible at n=30 and decisive at n=5.
 */
export function serviceHistory(
  serviceType: string | null | undefined,
  comparisons: LaborComparison[],
  opts?: { excludeJobId?: string },
): ServiceVariance {
  const key = serviceKey(serviceType)
  const exclude = opts?.excludeJobId
  const mine = comparisons.filter(c => c.serviceKey === key && c.jobId !== exclude)
  return { ...rollupLaborVariance(mine), serviceKey: key, serviceLabel: serviceLabel(key) }
}

export interface LaborCoverage {
  /** Visits considered (after de-duplication). */
  visits: number
  completed: number
  withEstimate: number
  withActual: number
  /** Completed visits that survive every rule — the real denominator. */
  comparable: number
  /** Why the rest dropped out. Sums with `comparable` to `visits`. */
  excluded: Record<NotComparable, number>
  /** comparable / completed as a %, 1dp. Null when nothing is completed. */
  comparablePctOfCompleted: number | null
}

export interface LaborLearning {
  comparisons: LaborComparison[]
  overall: VarianceRollup
  byService: ServiceVariance[]
  coverage: LaborCoverage
}

/**
 * THE entry point: completed visits in, learning out.
 *
 * `coverage` is not decoration — it is the number that decides whether any of
 * this may be shown as a fact. A business with 3 comparable visits out of 78
 * completed has a variance figure that is arithmetically fine and worthless, and
 * the only way a caller can know that is if the denominator travels with the
 * answer.
 *
 * TENANCY: this function is pure and holds no idea of who the owner is. It
 * learns from exactly the rows it is handed, so the caller MUST scope the read
 * server-side (labor_observations and jobs are both RLS own-row). Never feed it
 * rows from a service-role query without a user_id filter.
 */
export function learnFromCompletedVisits(visits: VisitLike[]): LaborLearning {
  // One row per visit. A join fan-out or a merged page must not let one visit
  // vote twice — which would also silently inflate every sample size.
  const seen = new Set<string>()
  const unique: VisitLike[] = []
  for (const v of visits) {
    if (!v?.id || seen.has(v.id)) continue
    seen.add(v.id)
    unique.push(v)
  }

  const comparisons: LaborComparison[] = []
  const excluded: Record<NotComparable, number> = {
    not_completed: 0, no_estimate: 0, no_actual: 0, implausible_actual: 0,
  }
  let completed = 0, withEstimate = 0, withActual = 0

  for (const v of unique) {
    const read = readVisitLabor(v)
    if (v.status === 'completed') {
      completed++
      if (read.estimatedMinutes != null) withEstimate++
      if (read.actualMinutes != null) withActual++
    }
    if (read.comparison) comparisons.push(read.comparison)
    else if (read.reason) excluded[read.reason]++
  }

  return {
    comparisons,
    overall: rollupLaborVariance(comparisons),
    byService: laborVarianceByService(comparisons),
    coverage: {
      visits: unique.length,
      completed,
      withEstimate,
      withActual,
      comparable: comparisons.length,
      excluded,
      comparablePctOfCompleted: completed > 0
        ? round1((comparisons.length / completed) * 100)
        : null,
    },
  }
}

// ── Presentation helpers ─────────────────────────────────────────────────────
// Shared so every surface words a variance the same way, and so "unknown" can
// never be formatted into a number.

/** "1h 45m" · "45m". Minutes are the unit; hours only when they help. */
export function formatMinutes(min: number | null): string {
  if (min == null || !Number.isFinite(min)) return '—'
  const sign = min < 0 ? '-' : ''
  const a = Math.abs(Math.round(min))
  if (a < 60) return `${sign}${a}m`
  const h = Math.floor(a / 60)
  const m = a % 60
  return m ? `${sign}${h}h ${m}m` : `${sign}${h}h`
}

/** "+21m" · "−9m" · "—". The sign is the point, so it is always shown. */
export function formatVarianceMinutes(min: number | null): string {
  if (min == null || !Number.isFinite(min)) return '—'
  const r = Math.round(min)
  if (r === 0) return 'exact'
  return r > 0 ? `+${formatMinutes(r)}` : `−${formatMinutes(Math.abs(r))}`
}

/** "+47%" · "−12%" · "—". Never invents a number. */
export function formatVariancePct(pct: number | null): string {
  if (pct == null || !Number.isFinite(pct)) return '—'
  const r = Math.round(pct)
  if (r === 0) return 'on target'
  return r > 0 ? `+${r}%` : `−${Math.abs(r)}%`
}

/**
 * The plain-English read. Direction in words so no one has to remember which
 * way the sign points.
 *
 * Deliberately NOT a verdict: running long is not a failure and running short is
 * not a win — both are the estimate being wrong, and an owner who consistently
 * overestimates is turning away work they had time for. The wording describes;
 * it does not grade.
 */
/**
 * The same read, for a GROUP of past visits rather than one.
 *
 * Separate from `describeVariance` because the claim is different and must not
 * borrow the singular's confidence: this sentence is about a tendency across a
 * sample, so it is hedged ("a typical visit"), and it refuses to say anything at
 * all when there is nothing to say. Null in, honest silence out — never
 * "typically on target", which is what a 0 would print.
 */
export function describeTypicalVariance(medianVarianceMinutes: number | null): string | null {
  if (medianVarianceMinutes == null || !Number.isFinite(medianVarianceMinutes)) return null
  const r = Math.round(medianVarianceMinutes)
  if (r === 0) return 'A typical visit lands on plan'
  return r > 0
    ? `A typical visit runs ${formatMinutes(r)} longer than planned`
    : `A typical visit finishes ${formatMinutes(Math.abs(r))} sooner than planned`
}

export function describeVariance(v: { varianceMinutes: number; variancePct: number | null }): string {
  const r = Math.round(v.varianceMinutes)
  if (r === 0) return 'Took exactly as long as planned'
  const pct = v.variancePct == null ? '' : ` (${formatVariancePct(v.variancePct)})`
  return r > 0
    ? `Ran ${formatMinutes(r)} longer than planned${pct}`
    : `Finished ${formatMinutes(Math.abs(r))} sooner than planned${pct}`
}
