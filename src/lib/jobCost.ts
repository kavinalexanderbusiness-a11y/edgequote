// ── Actual job cost — THE completeness contract ──────────────────────────────
// One question, one answer: "what did this visit ACTUALLY cost me, and how much
// of that do I genuinely know?" Pure arithmetic over rows that already exist. No
// I/O, no React, no supabase — so job detail, reporting and (later) profit
// intelligence can read the SAME answer without any of them re-deriving it.
//
// ══ WHAT WAS MEASURED IN PRODUCTION BEFORE THIS WAS WRITTEN ══════════════════
//   jobs                 223 rows · 79 completed · 36 with actual_minutes
//   time_entries           0 rows
//   expenses               0 rows   (expense_categories: 30 rows, seeded)
//   job_line_items         0 rows
//   technicians            2 rows — BOTH with hourly_wage NULL
//
// So on the day this shipped the honest answer for every visit in the book was
// "unknown", and this module's entire job was to say so without flinching. A
// costing engine that cannot say "I don't know" is not a costing engine; it is a
// generator of confident zeroes. Every branch below exists to keep one specific
// unknown from becoming a 0.
//
// ══ THE THREE THINGS THIS IS NOT ═════════════════════════════════════════════
// 1. NOT lib/economics (visitEconomics) — that is an ESTIMATE: crew-hours ×
//    crew_cost_per_hour, a LOADED planning rate (labour + overhead) available for
//    every job. This module reports only what receipts and clocks can PROVE.
//    The two are never summed: crew_cost_per_hour already contains fuel and
//    vehicle wear, so adding a receipted fuel bill on top double-counts it. See
//    the header of lib/accounting/jobCosting.ts, which states the same rule.
// 2. NOT lib/payroll — that answers "what do I owe on payday", including the
//    overtime premium. The premium belongs to the shape of a WEEK, not to any one
//    visit (the 9th hour of a Tuesday is only expensive because of the eight
//    before it), so it is never allocated here. Labour cost here is DIRECT cost,
//    exactly as lib/laborCost defines it.
// 3. NOT a second margin calculator. lib/margin.ts owns (price − cost) / price
//    and is asked, never re-implemented.
//
// ══ THE HONESTY RULES ════════════════════════════════════════════════════════
// 1. UNKNOWN IS NOT ZERO, PER CATEGORY. Labour, materials and other spend are
//    answered independently. A visit with a $185 mulch receipt and no clocked
//    time does NOT cost $185 — it costs "at least $185, labour unknown". The
//    total is `incomplete`, and `amount` is null. Only `knownAmount` carries the
//    subtotal, and it is named so a caller cannot mistake it for the total.
// 2. NO RECEIPT IN A CATEGORY ≠ NOTHING SPENT IN IT. "No materials receipt" does
//    not license "materials: $0" — nobody recorded it, that is all we know. This
//    is the difference between a fact and an absence of evidence, and it is the
//    single easiest way for a job-cost screen to lie.
// 3. A PARTLY-PRICED CLOCK IS NOT A LABOUR COST. If ANY closed shift on the visit
//    carries no snapshot rate, labour is `unknown` with reason `no_rate` — the
//    priced shifts are NOT summed on their own. lib/timeTracking.entryCost
//    deliberately returns 0 for a rateless shift (correct for a timesheet, where
//    0 means "no wage set"), and summing that here would report a labour cost
//    that is short by exactly the hours nobody priced, with nothing on screen
//    saying so. This module branches on the null instead of inheriting the 0.
// 4. LABOUR COST MAY ONLY COME FROM THE CLOCK. `actual_minutes × crew_size` is a
//    perfectly good estimate of labour HOURS and is reported as such — but it is
//    derived from a PLANNED crew size, and there is no per-person rate behind it.
//    It can never become a labour COST. See `LabourTime.source`.
// 5. HISTORICAL RATES ONLY. Every dollar of labour comes from
//    `time_entries.hourly_rate`, the rate SNAPSHOT at clock-in. The live
//    `technicians.hourly_wage` is never read here — pricing a March visit off a
//    July raise would silently rewrite history, which is the exact reason the
//    snapshot column exists.
// 6. A FAILED READ IS NOT A ZERO. Callers pass `readFailed` when a query errored;
//    every category becomes `unknown` with reason `read_failed`, never an empty
//    list summing to 0. An outage must not print "this visit cost nothing".
// 7. CANCELLED WORK STILL COSTS MONEY. Money spent on a visit that never happened
//    is still money spent, so costs are reported — but `comparableToRevenue` is
//    false and no profit may be derived. A cancelled visit has no revenue to
//    compare against, and dividing by it would manufacture a −100% margin.

import type { ExpenseWithRelations, TimeEntry } from '@/types'
import { isCapital, isOwnerDraw } from '@/lib/accounting/expenses'
import { expenseCost } from '@/lib/accounting/report'
import { entryMinutes, isOpen } from '@/lib/timeTracking'

const round2 = (n: number) => Math.round(n * 100) / 100

// ── The categories ───────────────────────────────────────────────────────────
// Three, deliberately. Not "the chart of accounts" — an owner standing at a truck
// wants to know whether the time or the stuff is what cost them, and a fourth
// bucket buys nothing that the receipt list underneath does not already show.
export type CostCategory = 'labour' | 'materials' | 'other'
export const COST_CATEGORIES: CostCategory[] = ['labour', 'materials', 'other']

export const CATEGORY_LABEL: Record<CostCategory, string> = {
  labour: 'Labour',
  materials: 'Materials',
  other: 'Other costs',
}

/**
 * The name of the seeded category that means "stuff consumed doing the work".
 *
 * Materials are split out by the category the OWNER already chose — read back,
 * never inferred from the vendor, the amount or the description. If they rename
 * or delete that category, its receipts land in `other`: the TOTAL is unchanged
 * and only the breakdown shifts, which is the safe direction to be wrong in.
 * Uncategorised spend also lands in `other` — never in materials, because
 * guessing a receipt into the materials bucket would invent evidence about the
 * one thing an owner is most likely to check.
 */
export const MATERIALS_CATEGORY_NAME = 'materials'

export function isMaterialsExpense(e: ExpenseWithRelations): boolean {
  const name = e.expense_categories?.name
  return typeof name === 'string' && name.trim().toLowerCase() === MATERIALS_CATEGORY_NAME
}

/**
 * Is this row a cost OF THIS VISIT?
 *
 * Two kinds of tagged spend are excluded, and both would be badly wrong to count:
 *   • CAPITAL — a $4,000 mower bought on the way to a job is an asset the
 *     business keeps, not what that hour of mowing cost. Charging it to one visit
 *     would report a catastrophic loss on a profitable job.
 *   • OWNER DRAW — a distribution of profit, not a cost of earning it. This is
 *     what `expense_categories.kind` exists for.
 *
 * UNPAID BILLS ARE INCLUDED, and that is a deliberate difference from the
 * cash-basis P&L. The mulch was spread on the lawn whether or not the supplier
 * has been paid; a job cost that flips the moment a cheque clears would tell the
 * owner the same visit cost two different amounts in two different weeks. Job
 * costing asks what the work consumed, not when the bank moved. lib/accounting's
 * period reports keep their cash-basis rule untouched.
 *
 * Nothing excluded here disappears silently — `excluded` on the read reports the
 * count and amount, so a screen can say why a receipt it can see is not in the
 * figure.
 */
export function countsAsJobCost(e: ExpenseWithRelations): boolean {
  return !isCapital(e) && !isOwnerDraw(e)
}

// ── The contract ─────────────────────────────────────────────────────────────

/** Why a category has no figure. Never collapsed into a zero. */
export type UnknownReason =
  /** Nothing was recorded in this category. Not evidence that nothing was spent. */
  | 'nothing_recorded'
  /** Time was clocked, but at least one shift carries no rate — see rule 3. */
  | 'no_rate'
  /** The query behind this failed. Never a 0 — see rule 6. */
  | 'read_failed'

export interface CostLine {
  category: CostCategory
  state: 'known' | 'unknown'
  /** Null EXACTLY when state is 'unknown'. */
  amount: number | null
  /** Receipts (or closed shifts) behind the figure. 0 means unknown, not zero. */
  sources: number
  /** Null EXACTLY when state is 'known'. */
  reason: UnknownReason | null
}

/**
 * How long the work took in PERSON-minutes, and where that came from.
 *
 * `source` is the whole point of this type:
 *   'clock' — summed from closed time_entries. An attendance record: it knows who
 *             was there and for how long. The ONLY source labour cost may use.
 *   'visit' — actual_minutes × crew_size. A sound estimate of effort, but
 *             crew_size is the PLAN (who was scheduled), not a record of who
 *             turned up, and no rate attaches to it. Reported, never priced.
 *   null    — neither is available.
 */
export interface LabourTime {
  personMinutes: number | null
  source: 'clock' | 'visit' | null
  /** Wall-clock minutes on site (jobs.actual_minutes) when known. */
  visitMinutes: number | null
  /** Planned crew size behind a 'visit' figure. Null when the source is the clock. */
  crewSize: number | null
  /** Closed shifts behind a 'clock' figure. */
  shifts: number
}

export interface CostTotal {
  /**
   * 'known'      — every category is answered; `amount` is the real total.
   * 'incomplete' — some categories are answered and some are not.
   * 'unknown'    — nothing is answered.
   */
  state: 'known' | 'incomplete' | 'unknown'
  /** The total. NON-NULL ONLY when state is 'known'. */
  amount: number | null
  /**
   * Sum of the categories that ARE known. A floor, not a total.
   *
   * Named `knownAmount` and never `amount` on purpose: this is the number a UI is
   * tempted to print as the cost, and the name is the last line of defence
   * against it being labelled "Total". Word it "at least $X".
   */
  knownAmount: number
  knownCategories: CostCategory[]
  unknownCategories: CostCategory[]
}

export interface ExcludedSpend {
  /** Tagged to this visit but not a cost of it — see countsAsJobCost. */
  count: number
  amount: number
}

export interface JobActualCost {
  jobId: string
  labour: CostLine
  materials: CostLine
  other: CostLine
  labourTime: LabourTime
  total: CostTotal
  /** 'none' — nothing known · 'partial' — some · 'complete' — all three. */
  completeness: 'none' | 'partial' | 'complete'
  /**
   * May a profit or margin be derived from this?
   *
   * False unless the visit actually happened AND the cost is complete. A partial
   * cost against a full price is not a margin, it is an overstatement of profit
   * by exactly the categories nobody recorded.
   */
  comparableToRevenue: boolean
  excluded: ExcludedSpend
}

export interface JobCostInput {
  job: {
    id: string
    status?: string | null
    actual_minutes?: number | null
    crew_size?: number | null
  }
  /** Expenses. MUST already be scoped to the owner — see TENANCY below. */
  expenses: ExpenseWithRelations[]
  /** Time entries. MUST already be scoped to the owner — see TENANCY below. */
  timeEntries: TimeEntry[]
  /** GST-registered? Decides gross vs net, via the shared expenseCost(). */
  registrant: boolean
  /** True when a query behind these rows errored — see honesty rule 6. */
  readFailed?: boolean
}

const unknownLine = (category: CostCategory, reason: UnknownReason): CostLine =>
  ({ category, state: 'unknown', amount: null, sources: 0, reason })

const knownLine = (category: CostCategory, amount: number, sources: number): CostLine =>
  ({ category, state: 'known', amount: round2(amount), sources, reason: null })

/**
 * ⭐ THE READ. One visit in, one completeness-carrying answer out.
 *
 * ══ TENANCY ══════════════════════════════════════════════════════════════════
 * This function is pure and holds no idea of who the owner is. It costs exactly
 * the rows it is handed, so the CALLER must scope every read server-side.
 * `expenses`, `time_entries` and `jobs` are all RLS own-row, and since
 * 2026-08-11 all three job pointers carry a COMPOSITE foreign key
 * `(job_id, user_id) → jobs(id, user_id)` (see
 * supabase/archive/run/RUN-2026-08-11c-job-cost-tenancy.sql), so a row from another business
 * cannot name this job in the first place. Never hand this rows from a
 * service-role query without a user_id filter.
 */
export function readJobActualCost(input: JobCostInput): JobActualCost {
  const { job, registrant } = input
  const jobId = job.id

  if (input.readFailed) {
    return assemble({
      jobId,
      labour: unknownLine('labour', 'read_failed'),
      materials: unknownLine('materials', 'read_failed'),
      other: unknownLine('other', 'read_failed'),
      labourTime: { personMinutes: null, source: null, visitMinutes: null, crewSize: null, shifts: 0 },
      excluded: { count: 0, amount: 0 },
      status: job.status,
    })
  }

  // ── Spend ──────────────────────────────────────────────────────────────────
  // Tagged to THIS visit. A row with no job_id is general overhead and belongs to
  // the business, not smeared across visits; a row tagged elsewhere is not ours.
  const tagged = input.expenses.filter(e => e.job_id === jobId)
  const counted = tagged.filter(countsAsJobCost)
  const excludedRows = tagged.filter(e => !countsAsJobCost(e))

  const materialRows = counted.filter(isMaterialsExpense)
  const otherRows = counted.filter(e => !isMaterialsExpense(e))

  // Honesty rule 2 in two lines: an empty bucket is unknown, never 0.
  const materials = materialRows.length
    ? knownLine('materials', sumCost(materialRows, registrant), materialRows.length)
    : unknownLine('materials', 'nothing_recorded')
  const other = otherRows.length
    ? knownLine('other', sumCost(otherRows, registrant), otherRows.length)
    : unknownLine('other', 'nothing_recorded')

  // ── Time ───────────────────────────────────────────────────────────────────
  // Only CLOSED shifts. An open shift has no duration yet, so it has no cost yet
  // — the same rule payroll and lib/laborCost already apply, so the three can
  // never disagree about which shifts count.
  const shifts = input.timeEntries.filter(e => e.job_id === jobId && !isOpen(e))
  const labourTime = readLabourTime(job, shifts)

  const labour = readLabour(shifts)

  return assemble({
    jobId, labour, materials, other, labourTime,
    excluded: {
      count: excludedRows.length,
      amount: round2(excludedRows.reduce((s, e) => s + expenseCost(e, registrant), 0)),
    },
    status: job.status,
  })
}

function sumCost(rows: ExpenseWithRelations[], registrant: boolean): number {
  return rows.reduce((s, e) => s + expenseCost(e, registrant), 0)
}

/**
 * Labour cost from the clock alone.
 *
 * The rate is read off the SHIFT (`hourly_rate`, snapshot at clock-in), never off
 * the technician. See honesty rules 3 and 5 — the `no_rate` branch is the one
 * that keeps a half-priced week from reading as a cheap job.
 */
function readLabour(shifts: TimeEntry[]): CostLine {
  if (!shifts.length) return unknownLine('labour', 'nothing_recorded')
  if (shifts.some(e => e.hourly_rate == null)) return unknownLine('labour', 'no_rate')
  const cost = shifts.reduce(
    (s, e) => s + (entryMinutes(e) / 60) * Number(e.hourly_rate),
    0,
  )
  return knownLine('labour', cost, shifts.length)
}

/**
 * Person-minutes, preferring the record over the derivation.
 *
 * The clock wins whenever it has anything to say: it knows who was actually
 * there. `actual_minutes × crew_size` is the fallback — honest about effort,
 * but built on the PLANNED crew size, so it is surfaced with `source: 'visit'`
 * and can never reach the cost side.
 */
function readLabourTime(job: JobCostInput['job'], shifts: TimeEntry[]): LabourTime {
  const visitRaw = Number(job.actual_minutes)
  const visitMinutes = Number.isFinite(visitRaw) && visitRaw > 0 ? visitRaw : null

  if (shifts.length) {
    return {
      personMinutes: shifts.reduce((s, e) => s + entryMinutes(e), 0),
      source: 'clock',
      visitMinutes,
      crewSize: null,
      shifts: shifts.length,
    }
  }
  if (visitMinutes != null) {
    // crew_size is NOT NULL DEFAULT 1 in the schema, but a caller may select it
    // away; a missing crew size falls back to one person rather than to zero,
    // because zero would report that a completed visit took no human effort.
    const crewRaw = Number(job.crew_size)
    const crewSize = Number.isFinite(crewRaw) && crewRaw > 0 ? Math.round(crewRaw) : 1
    return { personMinutes: visitMinutes * crewSize, source: 'visit', visitMinutes, crewSize, shifts: 0 }
  }
  return { personMinutes: null, source: null, visitMinutes, crewSize: null, shifts: 0 }
}

function assemble(p: {
  jobId: string
  labour: CostLine
  materials: CostLine
  other: CostLine
  labourTime: LabourTime
  excluded: ExcludedSpend
  status?: string | null
}): JobActualCost {
  const lines = [p.labour, p.materials, p.other]
  const known = lines.filter(l => l.state === 'known')
  const unknown = lines.filter(l => l.state === 'unknown')

  const knownAmount = round2(known.reduce((s, l) => s + (l.amount || 0), 0))
  const state: CostTotal['state'] =
    unknown.length === 0 ? 'known' : known.length === 0 ? 'unknown' : 'incomplete'

  const completeness: JobActualCost['completeness'] =
    state === 'known' ? 'complete' : state === 'unknown' ? 'none' : 'partial'

  return {
    jobId: p.jobId,
    labour: p.labour,
    materials: p.materials,
    other: p.other,
    labourTime: p.labourTime,
    total: {
      state,
      // The one line the whole module is built around: a total exists ONLY when
      // nothing is missing. `knownAmount` carries the floor for every other case.
      amount: state === 'known' ? knownAmount : null,
      knownAmount,
      knownCategories: known.map(l => l.category),
      unknownCategories: unknown.map(l => l.category),
    },
    completeness,
    // Honesty rule 7: a visit that never happened has no revenue to compare
    // against, and an incomplete cost against a full price overstates profit.
    comparableToRevenue: p.status === 'completed' && state === 'known',
    excluded: p.excluded,
  }
}

// ── Presentation ─────────────────────────────────────────────────────────────
// Shared so every surface words a partial cost the same way, and so "unknown"
// can never be formatted into a number.

/** "$185.00" · "—" for unknown. Never invents a figure. */
export function formatCost(amount: number | null): string {
  if (amount == null || !Number.isFinite(amount)) return '—'
  return `$${amount.toFixed(2)}`
}

export const UNKNOWN_REASON_LABEL: Record<UnknownReason, string> = {
  nothing_recorded: 'Nothing recorded',
  no_rate: 'No pay rate on those hours',
  read_failed: "Couldn't load",
}

/**
 * The headline sentence. Deliberately refuses to name a total unless one exists.
 *
 * "At least $185" is the honest form of an incomplete cost: it states the floor,
 * and the wording itself tells the owner more is missing. Printing "$185" with a
 * small asterisk elsewhere on the screen is how a floor gets read as a total.
 */
export function describeCost(c: JobActualCost): string {
  if (c.total.state === 'known') return `Cost ${formatCost(c.total.amount)}`
  if (c.total.state === 'unknown') return 'No costs recorded for this visit'
  const missing = c.total.unknownCategories.map(k => CATEGORY_LABEL[k].toLowerCase())
  return `At least ${formatCost(c.total.knownAmount)} — ${listWords(missing)} not recorded`
}

/** "labour" · "labour and materials" · "labour, materials and other costs" */
function listWords(words: string[]): string {
  if (words.length <= 1) return words[0] ?? ''
  return `${words.slice(0, -1).join(', ')} and ${words[words.length - 1]}`
}

// ── The data-quality prompt ──────────────────────────────────────────────────

/**
 * Should this visit be nudged to record its costs?
 *
 * ⚠️ THE RULE IS LEARNED, NOT ASSUMED. A weekly mow genuinely has no materials
 * and no receipt, and a product that asks for one after every cut trains the
 * owner to dismiss the prompt — after which it cannot warn about anything. So
 * this never fires on a service the owner has never recorded a cost against.
 *
 * It fires only when THEIR OWN history says this service normally has costs:
 * `pricedPeers` is how many OTHER completed visits of the same service already
 * carry recorded spend. At zero, silence — which is also exactly the state of a
 * brand-new account, so nothing nags on day one.
 *
 * Returns null when there is nothing worth saying.
 */
export function costCapturePrompt(
  p: { cost: JobActualCost; status?: string | null; pricedPeers: number },
): string | null {
  // Only finished work. An unfinished visit has costs still to come, and a
  // cancelled one may legitimately have none.
  if (p.status !== 'completed') return null
  if (p.cost.completeness === 'complete') return null
  if (p.pricedPeers < 1) return null
  return p.cost.completeness === 'none'
    ? 'Actual costs not recorded — similar visits usually have some.'
    : 'Some costs are missing — similar visits usually record more.'
}

// ── The Session 15 seam ──────────────────────────────────────────────────────

/**
 * The shape lib/estimateVsActual's learning engine can consume LATER, unchanged.
 *
 * Its rule is "unknown stays unknown", and this hands it exactly that: three
 * independent known/unknown answers plus the figures, with no zero anywhere a
 * null belongs. It is deliberately a FLAT, primitive-only projection so the
 * learning side never has to import this module's types or know what a
 * `CostLine` is — the same reason `serviceHistory` returns a rollup rather than
 * a component.
 *
 * ⚠️ Nothing here may be multiplied into a price. It is evidence an owner reads;
 * the standing rule is that the system never re-prices on its own.
 */
export interface ActualCostFacts {
  jobId: string
  actualLabourCost: number | null
  actualLabourCostKnown: boolean
  actualMaterialCost: number | null
  actualMaterialCostKnown: boolean
  actualOtherCost: number | null
  actualOtherCostKnown: boolean
  actualTotalCost: number | null
  actualTotalCostKnown: boolean
  /** Person-minutes, and whether they were clocked or derived from the visit. */
  actualLabourMinutes: number | null
  actualLabourMinutesSource: 'clock' | 'visit' | null
}

export function toActualCostFacts(c: JobActualCost): ActualCostFacts {
  return {
    jobId: c.jobId,
    actualLabourCost: c.labour.amount,
    actualLabourCostKnown: c.labour.state === 'known',
    actualMaterialCost: c.materials.amount,
    actualMaterialCostKnown: c.materials.state === 'known',
    actualOtherCost: c.other.amount,
    actualOtherCostKnown: c.other.state === 'known',
    actualTotalCost: c.total.amount,
    actualTotalCostKnown: c.total.state === 'known',
    actualLabourMinutes: c.labourTime.personMinutes,
    actualLabourMinutesSource: c.labourTime.source,
  }
}

// ── Coverage ─────────────────────────────────────────────────────────────────

export interface CostCoverage {
  visits: number
  completed: number
  /** Completed visits with ANY category known. */
  withAnyCost: number
  /** Completed visits with ALL THREE known — the only ones that can carry a margin. */
  withCompleteCost: number
  /** withCompleteCost / completed, 1dp. Null when nothing is completed. */
  completePctOfCompleted: number | null
}

/**
 * How much of the book can actually be costed.
 *
 * Travels with any aggregate for the same reason `estimateVsActual.coverage`
 * does: a margin computed over 3 of 79 completed visits is arithmetically fine
 * and worthless, and the only way a caller can know that is if the denominator
 * comes with the answer. One row per visit — deduplicated, so a join fan-out
 * cannot inflate the denominator it is judged by.
 */
export function costCoverage(
  entries: { status?: string | null; cost: JobActualCost }[],
): CostCoverage {
  const seen = new Set<string>()
  const unique = entries.filter(e => {
    const id = e.cost?.jobId
    if (!id || seen.has(id)) return false
    seen.add(id)
    return true
  })
  const completed = unique.filter(e => e.status === 'completed')
  const withAnyCost = completed.filter(e => e.cost.completeness !== 'none').length
  const withCompleteCost = completed.filter(e => e.cost.completeness === 'complete').length
  return {
    visits: unique.length,
    completed: completed.length,
    withAnyCost,
    withCompleteCost,
    // Guarded, not assumed: 0/0 is unknown, and a 0% here would read as "none of
    // your visits can be costed" on a business with no completed work at all.
    completePctOfCompleted: completed.length
      ? Math.round((withCompleteCost / completed.length) * 1000) / 10
      : null,
  }
}
