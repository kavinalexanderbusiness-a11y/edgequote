// ── Labour cost rollups + utilization ────────────────────────────────────────
// What the clock ACTUALLY cost, sliced by job / customer / month / crew, plus
// per-technician utilization. Pure data; no React, no supabase (mirrors
// lib/payroll, lib/timeTracking, lib/crews).
//
// THIS IS NOT A SECOND PAYROLL CALCULATOR.
// It never computes overtime. It never reads an overtime rule. Every minute comes
// from lib/timeTracking.entryMinutes and every dollar from
// lib/timeTracking.entryCost (minutes x the shift's own snapshot rate). Payroll —
// what a person is PAID, including the OT premium — is lib/payroll's job and only
// lib/payroll's job.
//
// THREE NUMBERS THAT LOOK ALIKE AND ARE NOT THE SAME. Keeping them apart is the
// whole point of this file:
//   1. lib/profitability  -> MODELLED cost: estimated minutes x crew_cost_per_hour.
//      A forecast. Answers "is this route/area worth it".
//   2. lib/laborCost (here) -> ACTUAL DIRECT cost: clocked minutes x snapshot rate.
//      Answers "what did this job really cost me in wages".
//   3. lib/payroll        -> ACTUAL PAY: direct cost + the overtime premium.
//      Answers "what do I owe on payday".
//
// WHY THE OT PREMIUM IS NOT ALLOCATED TO JOBS
// Overtime is caused by the shape of someone's WEEK, not by any one job. The 9th
// hour of a Tuesday is only expensive because of the eight before it — charging
// that premium to whichever customer happened to be 9th would be arbitrary, and
// would make the same job cost different amounts depending on scheduling order.
// So job/customer/month/crew costs are DIRECT labour, and the premium is reported
// once, at the period level, by reconcileToPayroll(). The identity below always
// holds, which is what makes these numbers trustworthy rather than merely close:
//
//     direct cost (here)  +  OT premium  ==  payroll total (lib/payroll)
//
// OPEN SHIFTS ARE EXCLUDED, exactly as payroll excludes them: an unfinished shift
// has no duration yet, so it has no cost yet. Same rule, same reason, so the two
// engines can never disagree about which shifts count.

import { format, startOfDay } from 'date-fns'
import type { Crew, Technician, TimeEntry } from '@/types'
import { entryCost, entryMinutes, isOpen } from '@/lib/timeTracking'

const round2 = (n: number) => Math.round(n * 100) / 100

/** The slice of a job this engine needs. Kept minimal so callers select narrowly. */
export interface LaborJobInfo {
  id: string
  customer_id: string | null
  scheduled_date: string | null
  service_type: string | null
  price: number | null
  /** Estimated on-site minutes, for estimate-vs-actual. null = never estimated. */
  duration_minutes?: number | null
}

export interface LaborContext {
  jobs: Map<string, LaborJobInfo>
  customerNames: Map<string, string>
  technicians: Map<string, Technician>
  crewNames: Map<string, string>
}

export function buildLaborContext(args: {
  jobs: LaborJobInfo[]
  customers: { id: string; name: string }[]
  technicians: Technician[]
  crews: Crew[]
}): LaborContext {
  return {
    jobs: new Map(args.jobs.map(j => [j.id, j])),
    customerNames: new Map(args.customers.map(c => [c.id, c.name])),
    technicians: new Map(args.technicians.map(t => [t.id, t])),
    crewNames: new Map(args.crews.map(c => [c.id, c.name])),
  }
}

/** Only closed shifts have a cost — see header. */
export function costable(entries: TimeEntry[]): TimeEntry[] {
  return entries.filter(e => !isOpen(e))
}

export interface LaborBucket {
  key: string
  label: string
  sub?: string
  minutes: number
  cost: number
  entries: number
  /** Job/customer revenue where known — null when there is nothing to compare to. */
  revenue: number | null
}

interface Acc { minutes: number; cost: number; entries: number; revenue: number | null }

function emptyAcc(): Acc { return { minutes: 0, cost: 0, entries: 0, revenue: null } }

function finish(map: Map<string, Acc>, label: (k: string) => string, sub?: (k: string) => string | undefined): LaborBucket[] {
  return Array.from(map.entries())
    .map(([key, a]) => ({
      key, label: label(key), sub: sub?.(key),
      minutes: a.minutes, cost: round2(a.cost), entries: a.entries,
      revenue: a.revenue == null ? null : round2(a.revenue),
    }))
    .sort((x, y) => y.cost - x.cost || y.minutes - x.minutes || x.label.localeCompare(y.label))
}

// ── By job ───────────────────────────────────────────────────────────────────
// Entries with no job_id are general time (yard, travel, shop) — they belong to
// the business, not to a job, so they are bucketed honestly rather than dropped
// or smeared across jobs.
export const UNASSIGNED_KEY = '__unassigned__'

export function laborByJob(entries: TimeEntry[], ctx: LaborContext): LaborBucket[] {
  const map = new Map<string, Acc>()
  const seenJob = new Set<string>()
  for (const e of costable(entries)) {
    const key = e.job_id ?? UNASSIGNED_KEY
    const a = map.get(key) ?? emptyAcc()
    a.minutes += entryMinutes(e)
    a.cost += entryCost(e)
    a.entries += 1
    // Revenue is a property of the JOB, not of each shift on it — count it once
    // or two people on one job would double the job's price.
    if (e.job_id && !seenJob.has(e.job_id)) {
      seenJob.add(e.job_id)
      const price = ctx.jobs.get(e.job_id)?.price
      if (price != null) a.revenue = (a.revenue ?? 0) + Number(price)
    }
    map.set(key, a)
  }
  return finish(
    map,
    k => {
      if (k === UNASSIGNED_KEY) return 'General time (no job)'
      const j = ctx.jobs.get(k)
      if (!j) return 'Deleted job'
      const who = j.customer_id ? ctx.customerNames.get(j.customer_id) : null
      return who ?? j.service_type ?? 'Job'
    },
    k => {
      if (k === UNASSIGNED_KEY) return 'Yard, travel, shop'
      const j = ctx.jobs.get(k)
      if (!j) return undefined
      return [j.service_type, j.scheduled_date ? format(new Date(j.scheduled_date + 'T00:00:00'), 'MMM d, yyyy') : null]
        .filter(Boolean).join(' · ') || undefined
    },
  )
}

// ── By customer ──────────────────────────────────────────────────────────────
export function laborByCustomer(entries: TimeEntry[], ctx: LaborContext): LaborBucket[] {
  const map = new Map<string, Acc>()
  const seenJob = new Set<string>()
  for (const e of costable(entries)) {
    const job = e.job_id ? ctx.jobs.get(e.job_id) : undefined
    const key = job?.customer_id ?? UNASSIGNED_KEY
    const a = map.get(key) ?? emptyAcc()
    a.minutes += entryMinutes(e)
    a.cost += entryCost(e)
    a.entries += 1
    if (e.job_id && job?.customer_id && !seenJob.has(e.job_id)) {
      seenJob.add(e.job_id)
      if (job.price != null) a.revenue = (a.revenue ?? 0) + Number(job.price)
    }
    map.set(key, a)
  }
  return finish(
    map,
    k => (k === UNASSIGNED_KEY ? 'General time (no customer)' : ctx.customerNames.get(k) ?? 'Deleted customer'),
  )
}

// ── By month ─────────────────────────────────────────────────────────────────
// Bucketed by the LOCAL month the shift started in (a shift is worked where the
// owner is, not in UTC — a 6pm Calgary clock-in is not next month).
export function laborByMonth(entries: TimeEntry[]): LaborBucket[] {
  const map = new Map<string, Acc>()
  for (const e of costable(entries)) {
    const key = format(startOfDay(new Date(e.clock_in)), 'yyyy-MM')
    const a = map.get(key) ?? emptyAcc()
    a.minutes += entryMinutes(e)
    a.cost += entryCost(e)
    a.entries += 1
    map.set(key, a)
  }
  // Chronological, not by cost — a trend read out of order is not a trend.
  return finish(map, k => format(new Date(`${k}-01T00:00:00`), 'MMMM yyyy'))
    .sort((a, b) => a.key.localeCompare(b.key))
}

// ── By crew ──────────────────────────────────────────────────────────────────
// A shift belongs to the crew its TECHNICIAN is on. Someone not on a crew is
// reported as such rather than silently dropped from the totals.
export function laborByCrew(entries: TimeEntry[], ctx: LaborContext): LaborBucket[] {
  const map = new Map<string, Acc>()
  for (const e of costable(entries)) {
    const crewId = ctx.technicians.get(e.technician_id)?.crew_id ?? null
    const key = crewId ?? UNASSIGNED_KEY
    const a = map.get(key) ?? emptyAcc()
    a.minutes += entryMinutes(e)
    a.cost += entryCost(e)
    a.entries += 1
    map.set(key, a)
  }
  return finish(map, k => (k === UNASSIGNED_KEY ? 'No crew' : ctx.crewNames.get(k) ?? 'Deleted crew'))
}

// ── Utilization ──────────────────────────────────────────────────────────────
// utilization = time on jobs / total paid time.
//
// It is NOT "how busy someone looks" and NOT derived from technicians.status.
// job-linked minutes are the numerator; everything else paid (yard, travel,
// shop) is the denominator's remainder. 100% would mean every paid minute was
// booked to a job, which is neither expected nor a target — the number is only
// meaningful next to the general time it excludes.
export interface TechUtilization {
  technicianId: string
  name: string
  crewName: string | null
  totalMinutes: number
  jobMinutes: number
  generalMinutes: number
  /** 0–100, rounded to 1dp. null when nothing was worked (0/0 is not 0%). */
  utilizationPct: number | null
  cost: number
  jobCost: number
}

export function technicianUtilization(entries: TimeEntry[], ctx: LaborContext): TechUtilization[] {
  const map = new Map<string, { total: number; job: number; cost: number; jobCost: number }>()
  for (const e of costable(entries)) {
    const a = map.get(e.technician_id) ?? { total: 0, job: 0, cost: 0, jobCost: 0 }
    const m = entryMinutes(e)
    const c = entryCost(e)
    a.total += m
    a.cost += c
    if (e.job_id) { a.job += m; a.jobCost += c }
    map.set(e.technician_id, a)
  }
  return Array.from(map.entries())
    .map(([technicianId, a]) => {
      const t = ctx.technicians.get(technicianId)
      const crewId = t?.crew_id ?? null
      return {
        technicianId,
        name: t?.name ?? 'Removed technician',
        crewName: crewId ? ctx.crewNames.get(crewId) ?? null : null,
        totalMinutes: a.total,
        jobMinutes: a.job,
        generalMinutes: a.total - a.job,
        utilizationPct: a.total > 0 ? Math.round((a.job / a.total) * 1000) / 10 : null,
        cost: round2(a.cost),
        jobCost: round2(a.jobCost),
      }
    })
    .sort((x, y) => (y.utilizationPct ?? -1) - (x.utilizationPct ?? -1) || y.totalMinutes - x.totalMinutes)
}

// ── Crew profitability ───────────────────────────────────────────────────────
// Cost is easy (the clock says who worked). Revenue is the hard part, because a
// job's price is ONE number and two crews can touch it.
//
// Revenue is SPLIT PROPORTIONALLY by clocked minutes on that job. The
// alternatives are both wrong in ways that matter:
//   * count the full price for every crew that touched it -> revenue is
//     double-counted and the totals no longer sum to what you actually billed;
//   * give it all to the job's assigned crew_id -> the crew that did the work
//     carries the cost while another carries the revenue, and both are wrong.
// Splitting by minutes keeps revenue conserved (the parts sum to the whole) and
// consistent with how cost is attributed — both follow the clock.
//
// NOTE this uses the technician's crew, not jobs.crew_id: the assignment is the
// plan, the clock is what happened. Cost follows the clock, so revenue must too.
export interface CrewProfit {
  crewId: string
  name: string
  minutes: number
  cost: number
  revenue: number
  profit: number
  /** profit / revenue as a %. null when there is no revenue to divide by. */
  marginPct: number | null
  /** Revenue per clocked labour hour — comparable across crews of any size. */
  revPerHour: number | null
  jobs: number
  technicians: number
}

export function crewProfitability(entries: TimeEntry[], ctx: LaborContext): CrewProfit[] {
  // Pass 1: total clocked minutes per job, the denominator of every split.
  const jobTotalMinutes = new Map<string, number>()
  for (const e of costable(entries)) {
    if (!e.job_id) continue
    jobTotalMinutes.set(e.job_id, (jobTotalMinutes.get(e.job_id) ?? 0) + entryMinutes(e))
  }

  interface CrewAcc { minutes: number; cost: number; revenue: number; jobs: Set<string>; techs: Set<string> }
  const map = new Map<string, CrewAcc>()

  for (const e of costable(entries)) {
    const crewId = ctx.technicians.get(e.technician_id)?.crew_id ?? null
    const key = crewId ?? UNASSIGNED_KEY
    const a = map.get(key) ?? { minutes: 0, cost: 0, revenue: 0, jobs: new Set(), techs: new Set() }
    const m = entryMinutes(e)
    a.minutes += m
    a.cost += entryCost(e)
    a.techs.add(e.technician_id)
    if (e.job_id) {
      a.jobs.add(e.job_id)
      const price = ctx.jobs.get(e.job_id)?.price
      const total = jobTotalMinutes.get(e.job_id) ?? 0
      // Proportional share. total>0 is guaranteed here (this entry contributed to
      // it), but the guard keeps a 0-minute shift from dividing by zero.
      if (price != null && total > 0) a.revenue += Number(price) * (m / total)
    }
    map.set(key, a)
  }

  return Array.from(map.entries())
    .map(([crewId, a]) => {
      const revenue = round2(a.revenue)
      const cost = round2(a.cost)
      const profit = round2(revenue - cost)
      return {
        crewId,
        name: crewId === UNASSIGNED_KEY ? 'No crew' : ctx.crewNames.get(crewId) ?? 'Deleted crew',
        minutes: a.minutes,
        cost,
        revenue,
        profit,
        marginPct: revenue > 0 ? Math.round((profit / revenue) * 1000) / 10 : null,
        revPerHour: a.minutes > 0 ? round2(revenue / (a.minutes / 60)) : null,
        jobs: a.jobs.size,
        technicians: a.techs.size,
      }
    })
    .sort((x, y) => y.profit - x.profit || y.revenue - x.revenue || x.name.localeCompare(y.name))
}

// ── Technician performance ───────────────────────────────────────────────────
// DELIBERATELY NOT A SCORE, AND DELIBERATELY NOT RANKED BY ONE.
//
// It would be easy to blend utilization, revenue/hour and estimate variance into
// a single number and sort people by it. It would also be misleading: whoever is
// handed the awkward jobs, the callbacks and the training of new hires would come
// out "worst", and the number would look objective while being an artifact of who
// got assigned what. These figures get used in real conversations about real
// people's pay and jobs, so this returns FACTS with their context attached and
// lets a human read them.
//
// Every figure here is confounded in a way worth stating out loud:
//   * revPerHour   -> a property of the JOBS someone was assigned, not their speed.
//   * estimateVar  -> measures the ESTIMATE as much as the person; a job with two
//                     techs shares one estimate, so it can't be pinned on either.
//   * utilization  -> low means unbooked time, which is usually the schedule's
//                     doing, not the person's.
export interface TechPerformance {
  technicianId: string
  name: string
  crewName: string | null
  totalMinutes: number
  jobMinutes: number
  utilizationPct: number | null
  cost: number
  /** Distinct jobs they clocked any time against. */
  jobsTouched: number
  /** Revenue of jobs they worked, split by their share of the clocked minutes. */
  revenueShare: number
  /** revenueShare per clocked hour. null when nothing was clocked. */
  revPerHour: number | null
  /** Actual vs estimated minutes on the jobs they touched, as a %: +20 = those
   *  jobs ran 20% long. null when none of them was ever estimated. Job-level. */
  estimateVariancePct: number | null
}

export function technicianPerformance(entries: TimeEntry[], ctx: LaborContext): TechPerformance[] {
  const jobTotalMinutes = new Map<string, number>()
  for (const e of costable(entries)) {
    if (!e.job_id) continue
    jobTotalMinutes.set(e.job_id, (jobTotalMinutes.get(e.job_id) ?? 0) + entryMinutes(e))
  }

  interface Acc { total: number; job: number; cost: number; revenue: number; jobs: Set<string> }
  const map = new Map<string, Acc>()
  for (const e of costable(entries)) {
    const a = map.get(e.technician_id) ?? { total: 0, job: 0, cost: 0, revenue: 0, jobs: new Set<string>() }
    const m = entryMinutes(e)
    a.total += m
    a.cost += entryCost(e)
    if (e.job_id) {
      a.job += m
      a.jobs.add(e.job_id)
      const price = ctx.jobs.get(e.job_id)?.price
      const total = jobTotalMinutes.get(e.job_id) ?? 0
      if (price != null && total > 0) a.revenue += Number(price) * (m / total)
    }
    map.set(e.technician_id, a)
  }

  return Array.from(map.entries())
    .map(([technicianId, a]) => {
      const t = ctx.technicians.get(technicianId)
      const crewId = t?.crew_id ?? null

      // Estimate variance across the jobs they touched — computed on the JOB's
      // full clocked time vs the JOB's estimate, never on this person's slice.
      let estActual = 0, estPlanned = 0
      for (const jobId of a.jobs) {
        const est = ctx.jobs.get(jobId)?.duration_minutes
        if (est == null || est <= 0) continue
        estPlanned += Number(est)
        estActual += jobTotalMinutes.get(jobId) ?? 0
      }

      return {
        technicianId,
        name: t?.name ?? 'Removed technician',
        crewName: crewId ? ctx.crewNames.get(crewId) ?? null : null,
        totalMinutes: a.total,
        jobMinutes: a.job,
        utilizationPct: a.total > 0 ? Math.round((a.job / a.total) * 1000) / 10 : null,
        cost: round2(a.cost),
        jobsTouched: a.jobs.size,
        revenueShare: round2(a.revenue),
        revPerHour: a.total > 0 ? round2(a.revenue / (a.total / 60)) : null,
        estimateVariancePct: estPlanned > 0 ? Math.round(((estActual - estPlanned) / estPlanned) * 1000) / 10 : null,
      }
    })
    // Sorted by hours worked — a neutral fact, NOT by any performance measure.
    // Sorting by "best" would manufacture the ranking this type refuses to make.
    .sort((x, y) => y.totalMinutes - x.totalMinutes || x.name.localeCompare(y.name))
}

// ── Reconciliation to payroll ────────────────────────────────────────────────
/**
 * Proves these rollups and lib/payroll describe the same money.
 *
 * The premium is DERIVED by subtraction from payroll's own total — no overtime
 * rule is read or re-implemented here. If this ever fails to balance, the bug is
 * real and visible rather than hidden in a second calculator.
 */
export interface LaborReconciliation {
  /** Sum of every closed shift at its snapshot rate — what the rollups above total to. */
  directCost: number
  /** The extra that overtime adds on top. Belongs to the week, not to a job. */
  otPremium: number
  /** lib/payroll's figure — direct + premium. */
  payrollTotal: number
}

export function directLabourCost(entries: TimeEntry[]): number {
  return round2(costable(entries).reduce((s, e) => s + entryCost(e), 0))
}

export function reconcileToPayroll(entries: TimeEntry[], payrollTotal: number): LaborReconciliation {
  const directCost = directLabourCost(entries)
  return { directCost, otPremium: round2(payrollTotal - directCost), payrollTotal: round2(payrollTotal) }
}
