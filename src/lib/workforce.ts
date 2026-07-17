// ── Workforce intelligence ───────────────────────────────────────────────────
// The questions an owner asks ABOUT their people, as opposed to the arithmetic of
// paying them. Pure data; no React, no supabase.
//
// THIS ADDS NO PAYROLL MATHS AND NO EMPLOYEE MODEL. It is a reader:
//   overtime / regular split  <- lib/payroll   (THE overtime engine)
//   gross incl. time off      <- lib/payRun    (THE pay composition)
//   cost / utilization / crews<- lib/laborCost
//   balances + leave          <- lib/pto
//   who exists                <- technicians
// Every number below is one of those, re-sliced or differenced. If a figure here
// disagrees with the Payroll page, this file is wrong — not lib/payroll.
//
// THE HONESTY RULE THAT SHAPES THIS FILE
// Intelligence over a 1–3 person crew is intelligence over a tiny sample. Two
// weeks of data cannot support a trend, and a "forecast" from three shifts is a
// guess wearing a suit. So every output here carries its own evidence — a sample
// count, a confidence, or an explicit null — and the UI is expected to show it.
// Refusing to answer is a valid answer and is used liberally below.

import { addDays, differenceInCalendarDays, format, startOfDay } from 'date-fns'
import type { PayRun, PtoEntry, Technician, TimeEntry, WageHistoryEntry } from '@/types'
import { entryCost, entryMinutes, isOpen } from '@/lib/timeTracking'
import {
  payPeriodFor, shiftPayPeriod, splitRegularOvertime, type OvertimeRules, type PayPeriod,
} from '@/lib/payroll'
import { buildDraftPayRun } from '@/lib/payRun'
import { costable, type LaborContext } from '@/lib/laborCost'
import { parseDateOnly } from '@/lib/pto'

const round2 = (n: number) => Math.round(n * 100) / 100
const round1 = (n: number) => Math.round(n * 10) / 10
const iso = (d: Date) => format(d, 'yyyy-MM-dd')

/** Below this many observations, a trend is noise. Small crews, small samples. */
export const MIN_PERIODS_FOR_TREND = 3
/** Below this, a forecast is a guess. Deliberately higher than the trend floor. */
export const MIN_PERIODS_FOR_FORECAST = 4

// ── Availability ─────────────────────────────────────────────────────────────
// "Can this person work today" is THREE facts that already exist and never spoke
// to each other:
//   1. technicians.status  -> where they are right now (dispatch)
//   2. pto_entries         -> booked off (payroll)
//   3. time_entries        -> actually on the clock
// The timesheet used to show someone on booked vacation identically to someone
// who overslept. Joining them is the whole value here — no new state, no new
// table, just the three read together.
export type AvailabilityState = 'on_clock' | 'time_off' | 'available' | 'inactive'

export interface TechAvailability {
  technicianId: string
  name: string
  crewName: string | null
  state: AvailabilityState
  /** One plain sentence for the UI. Never a code. */
  detail: string
  /** Set when they're on the clock — minutes so far today. */
  onClockMinutes: number | null
  /** Set when off: the leave kind + hours. */
  timeOffKind: string | null
  timeOffHours: number | null
}

export function availabilityToday(args: {
  technicians: Technician[]
  entries: TimeEntry[]
  ptoEntries: PtoEntry[]
  ctx: Pick<LaborContext, 'crewNames'>
  now?: Date
}): TechAvailability[] {
  const now = args.now ?? new Date()
  const today = iso(now)

  const openByTech = new Map<string, TimeEntry>()
  for (const e of args.entries) if (isOpen(e)) openByTech.set(e.technician_id, e)

  const offByTech = new Map<string, PtoEntry>()
  for (const p of args.ptoEntries) {
    if (p.date.slice(0, 10) === today) offByTech.set(p.technician_id, p)
  }

  return args.technicians.map(t => {
    const crewName = t.crew_id ? args.ctx.crewNames.get(t.crew_id) ?? null : null
    const open = openByTech.get(t.id)
    const off = offByTech.get(t.id)

    // Order matters: someone can be clocked in ON a day they booked off (it
    // happens — they came in anyway). The clock is what's true, so it wins, and
    // the detail says both rather than hiding the contradiction.
    if (open) {
      const mins = entryMinutes(open, now)
      return {
        technicianId: t.id, name: t.name, crewName,
        state: 'on_clock' as const,
        detail: off
          ? `On the clock since ${format(new Date(open.clock_in), 'h:mm a')} — despite ${off.kind} booked today`
          : `On the clock since ${format(new Date(open.clock_in), 'h:mm a')}`,
        onClockMinutes: mins, timeOffKind: off?.kind ?? null,
        timeOffHours: off ? Number(off.hours) : null,
      }
    }
    if (!t.is_active) {
      return {
        technicianId: t.id, name: t.name, crewName, state: 'inactive' as const,
        detail: t.ended_on ? `Left ${format(parseDateOnly(t.ended_on), 'MMM d, yyyy')}` : 'Not active',
        onClockMinutes: null, timeOffKind: null, timeOffHours: null,
      }
    }
    if (off) {
      return {
        technicianId: t.id, name: t.name, crewName, state: 'time_off' as const,
        detail: `${off.kind[0].toUpperCase()}${off.kind.slice(1)} — ${Number(off.hours)} h${off.is_paid ? '' : ' (unpaid)'}`,
        onClockMinutes: null, timeOffKind: off.kind, timeOffHours: Number(off.hours),
      }
    }
    return {
      technicianId: t.id, name: t.name, crewName, state: 'available' as const,
      detail: 'Not clocked in', onClockMinutes: null, timeOffKind: null, timeOffHours: null,
    }
  }).sort((a, b) => {
    const order: AvailabilityState[] = ['on_clock', 'available', 'time_off', 'inactive']
    return order.indexOf(a.state) - order.indexOf(b.state) || a.name.localeCompare(b.name)
  })
}

// ── Overtime insight ─────────────────────────────────────────────────────────
// OT is only actionable BEFORE it's earned. Once the week is over, the premium is
// owed and this is just a receipt. So this projects the CURRENT week: hours so
// far, hours to the threshold, and — only when the week isn't over — whether
// today's pace lands over it.
export interface OvertimeWatch {
  technicianId: string
  name: string
  /** Worked minutes in the current OT week so far. */
  minutesSoFar: number
  /** Minutes already over the weekly threshold. */
  otMinutesSoFar: number
  /** Minutes left before OT starts. null when no weekly rule is set. */
  minutesToThreshold: number | null
  /** Cost of the OT premium already incurred this week. */
  premiumSoFar: number
  /** true once any OT exists this week. */
  inOvertime: boolean
}

export interface OvertimeInsight {
  /** null when no weekly OT rule is configured — nothing to watch. */
  weeklyThresholdHours: number | null
  watch: OvertimeWatch[]
  otMinutesThisWeek: number
  premiumThisWeek: number
}

/**
 * Current-week OT exposure, per person.
 *
 * Uses lib/payroll.splitRegularOvertime for the split — the same function payroll
 * itself calls — so a warning here can never contradict the cheque later.
 */
export function overtimeInsight(args: {
  technicians: Technician[]
  entries: TimeEntry[]
  rules: OvertimeRules
  weekStart: Date
  weekEnd: Date
}): OvertimeInsight {
  const { technicians, entries, rules, weekStart, weekEnd } = args
  const from = weekStart.getTime(), to = addDays(weekEnd, 1).getTime()

  const byTech = new Map<string, TimeEntry[]>()
  for (const e of entries) {
    const t = new Date(e.clock_in).getTime()
    if (t < from || t >= to || isOpen(e)) continue
    const l = byTech.get(e.technician_id)
    if (l) l.push(e); else byTech.set(e.technician_id, [e])
  }

  const nameOf = new Map(technicians.map(t => [t.id, t.name]))
  const watch: OvertimeWatch[] = []

  for (const [technicianId, week] of byTech) {
    // THE engine. Not a local reimplementation of "hours > 44".
    const split = splitRegularOvertime(week, rules)
    const minutesSoFar = split.regularMinutes + split.otMinutes
    const thresholdMin = rules.weeklyHours == null ? null : rules.weeklyHours * 60
    watch.push({
      technicianId,
      name: nameOf.get(technicianId) ?? 'Removed technician',
      minutesSoFar,
      otMinutesSoFar: split.otMinutes,
      minutesToThreshold: thresholdMin == null ? null : Math.max(0, thresholdMin - minutesSoFar),
      // The premium is the EXTRA over straight time — otPay already includes the
      // base hour, so the marginal cost is otPay x (1 - 1/multiplier).
      premiumSoFar: rules.multiplier > 0
        ? round2(split.otPay * (1 - 1 / rules.multiplier))
        : 0,
      inOvertime: split.otMinutes > 0,
    })
  }

  watch.sort((a, b) => b.otMinutesSoFar - a.otMinutesSoFar || b.minutesSoFar - a.minutesSoFar)

  return {
    weeklyThresholdHours: rules.weeklyHours,
    watch,
    otMinutesThisWeek: watch.reduce((s, w) => s + w.otMinutesSoFar, 0),
    premiumThisWeek: round2(watch.reduce((s, w) => s + w.premiumSoFar, 0)),
  }
}

// ── Workload balance ─────────────────────────────────────────────────────────
// Who is carrying the week. Reported as a share of the TEAM's hours against an
// even split, because "Dave did 44 hours" means nothing without knowing there are
// three of them.
//
// Deliberately no "overworked" verdict: a 2-person crew where one is part-time is
// SUPPOSED to be uneven, and calling that an imbalance would be noise every week.
// The spread is reported; the owner knows their roster.
export interface WorkloadShare {
  technicianId: string
  name: string
  crewName: string | null
  minutes: number
  /** % of all worked minutes across the team. */
  sharePct: number
  /** Percentage points above/below an even split. +12 = 12pp more than even. */
  vsEvenPct: number
}

export interface WorkloadBalance {
  shares: WorkloadShare[]
  totalMinutes: number
  people: number
  /** Highest minus lowest share, in percentage points. null with <2 people. */
  spreadPct: number | null
  /** Even share, for the UI to draw a reference line. */
  evenSharePct: number | null
}

export function workloadBalance(entries: TimeEntry[], technicians: Technician[], ctx: Pick<LaborContext, 'crewNames'>): WorkloadBalance {
  const byTech = new Map<string, number>()
  for (const e of costable(entries)) {
    byTech.set(e.technician_id, (byTech.get(e.technician_id) ?? 0) + entryMinutes(e))
  }
  const totalMinutes = Array.from(byTech.values()).reduce((s, m) => s + m, 0)
  const active = technicians.filter(t => t.is_active)
  // Only people who actually worked can hold a share of the work.
  const participants = active.filter(t => (byTech.get(t.id) ?? 0) > 0)
  const people = participants.length
  const evenSharePct = people > 0 ? round1(100 / people) : null

  const shares: WorkloadShare[] = participants.map(t => {
    const minutes = byTech.get(t.id) ?? 0
    const sharePct = totalMinutes > 0 ? round1((minutes / totalMinutes) * 100) : 0
    return {
      technicianId: t.id,
      name: t.name,
      crewName: t.crew_id ? ctx.crewNames.get(t.crew_id) ?? null : null,
      minutes,
      sharePct,
      vsEvenPct: evenSharePct == null ? 0 : round1(sharePct - evenSharePct),
    }
  }).sort((a, b) => b.minutes - a.minutes || a.name.localeCompare(b.name))

  return {
    shares,
    totalMinutes,
    people,
    spreadPct: shares.length >= 2 ? round1(shares[0].sharePct - shares[shares.length - 1].sharePct) : null,
    evenSharePct,
  }
}

// ── Crew utilization ─────────────────────────────────────────────────────────
// Distinct from technicianUtilization (lib/laborCost), which is per PERSON. This
// is per CREW: of everything the crew was paid for, how much reached a job.
export interface CrewUtilization {
  crewId: string
  name: string
  totalMinutes: number
  jobMinutes: number
  utilizationPct: number | null
  people: number
  cost: number
}

export function crewUtilization(entries: TimeEntry[], ctx: LaborContext): CrewUtilization[] {
  const map = new Map<string, { total: number; job: number; cost: number; techs: Set<string> }>()
  for (const e of costable(entries)) {
    const crewId = ctx.technicians.get(e.technician_id)?.crew_id ?? '__none__'
    const a = map.get(crewId) ?? { total: 0, job: 0, cost: 0, techs: new Set<string>() }
    const m = entryMinutes(e)
    a.total += m
    a.cost += entryCost(e)
    a.techs.add(e.technician_id)
    if (e.job_id) a.job += m
    map.set(crewId, a)
  }
  return Array.from(map.entries()).map(([crewId, a]) => ({
    crewId,
    name: crewId === '__none__' ? 'No crew' : ctx.crewNames.get(crewId) ?? 'Deleted crew',
    totalMinutes: a.total,
    jobMinutes: a.job,
    utilizationPct: a.total > 0 ? round1((a.job / a.total) * 100) : null,
    people: a.techs.size,
    cost: round2(a.cost),
  })).sort((x, y) => (y.utilizationPct ?? -1) - (x.utilizationPct ?? -1))
}

// ── Trends over pay periods ──────────────────────────────────────────────────
// The last N periods, each costed with lib/payRun so a trend point and the
// Payroll page can never disagree.
export interface PeriodPoint {
  label: string
  startISO: string
  grossPay: number
  workedPay: number
  ptoPay: number
  regularMinutes: number
  otMinutes: number
  otSharePct: number
  people: number
}

export interface LaborTrend {
  points: PeriodPoint[]
  /** Change in gross from the previous period to the latest, as a %. */
  changePct: number | null
  /** Mean gross across the points — the run rate. */
  averageGross: number
  /** true once there are enough points to read direction at all. */
  hasTrend: boolean
}

export function laborTrend(args: {
  entries: TimeEntry[]
  ptoEntries: PtoEntry[]
  technicians: Technician[]
  rules: OvertimeRules
  /** Number of COMPLETED periods to include, newest last. */
  periods: number
  now?: Date
}): LaborTrend {
  const now = args.now ?? new Date()
  const current = payPeriodFor(now, args.rules)
  const points: PeriodPoint[] = []

  // Walk backwards from the last COMPLETE period: the in-progress one is always
  // short and would read as a cliff at the end of every chart.
  for (let i = args.periods; i >= 1; i--) {
    const p: PayPeriod = shiftPayPeriod(current, -i, args.rules)
    const draft = buildDraftPayRun({
      entries: args.entries, ptoEntries: args.ptoEntries,
      technicians: args.technicians, rules: args.rules, period: p,
    })
    const worked = draft.regularMinutes + draft.otMinutes
    points.push({
      label: p.label,
      startISO: iso(p.start),
      grossPay: draft.grossPay,
      workedPay: draft.workedPay,
      ptoPay: draft.ptoPay,
      regularMinutes: draft.regularMinutes,
      otMinutes: draft.otMinutes,
      otSharePct: worked > 0 ? round1((draft.otMinutes / worked) * 100) : 0,
      people: draft.employeeCount,
    })
  }

  // Only periods with actual activity count as evidence. Ten empty weeks before
  // the first hire are not ten data points.
  const active = points.filter(p => p.grossPay > 0 || p.people > 0)
  const hasTrend = active.length >= MIN_PERIODS_FOR_TREND
  const last = points[points.length - 1]
  const prev = points[points.length - 2]
  const changePct = hasTrend && last && prev && prev.grossPay > 0
    ? round1(((last.grossPay - prev.grossPay) / prev.grossPay) * 100)
    : null

  return {
    points,
    changePct,
    averageGross: active.length ? round2(active.reduce((s, p) => s + p.grossPay, 0) / active.length) : 0,
    hasTrend,
  }
}

// ── Forecast ─────────────────────────────────────────────────────────────────
// What next period's payroll looks like if nothing changes.
//
// THIS REFUSES TO ANSWER MORE OFTEN THAN IT ANSWERS, ON PURPOSE.
// A forecast is the most dangerous thing on this page: it looks authoritative and
// an owner may staff or bid against it. With three shifts of history, any number
// here is invention. So:
//   * below MIN_PERIODS_FOR_FORECAST periods WITH ACTIVITY -> null. No estimate.
//   * the method is a stated run rate (mean of complete periods), NOT a fitted
//     trend line: fitting a line to four noisy points produces confident-looking
//     nonsense, and extrapolating it produces worse.
//   * `low`/`high` come from the observed spread, so a volatile history yields an
//     honestly wide band instead of a false point estimate.
//   * `basis` is returned so the UI can state the reasoning verbatim.
export interface LaborForecast {
  /** null = not enough evidence. The UI must say so rather than show 0. */
  expected: number | null
  low: number | null
  high: number | null
  periodsUsed: number
  periodsNeeded: number
  /** Plain-English method + caveat, for display. */
  basis: string
  confidence: 'none' | 'low' | 'medium'
}

export function forecastNextPeriod(trend: LaborTrend): LaborForecast {
  const active = trend.points.filter(p => p.grossPay > 0)
  const n = active.length

  if (n < MIN_PERIODS_FOR_FORECAST) {
    return {
      expected: null, low: null, high: null,
      periodsUsed: n, periodsNeeded: MIN_PERIODS_FOR_FORECAST,
      basis: `Needs ${MIN_PERIODS_FOR_FORECAST} finished pay periods with hours in them — there ${n === 1 ? 'is' : 'are'} ${n}. A forecast from fewer would just be a guess.`,
      confidence: 'none',
    }
  }

  const values = active.map(p => p.grossPay)
  const mean = values.reduce((s, v) => s + v, 0) / n
  // Population SD over the periods we have — a spread, not an inference.
  const sd = Math.sqrt(values.reduce((s, v) => s + (v - mean) ** 2, 0) / n)
  const spreadPct = mean > 0 ? (sd / mean) * 100 : 0

  return {
    expected: round2(mean),
    low: round2(Math.max(0, mean - sd)),
    high: round2(mean + sd),
    periodsUsed: n,
    periodsNeeded: MIN_PERIODS_FOR_FORECAST,
    basis: `Average of your last ${n} finished pay periods${spreadPct > 25 ? ', which vary a lot — treat the range as the answer, not the middle' : ''}. Assumes the same people and the same amount of work.`,
    // Never better than 'medium': this is a run rate on a handful of periods, not
    // a model. Claiming 'high' would be the lie the whole gate exists to avoid.
    confidence: spreadPct > 25 ? 'low' : 'medium',
  }
}

// ── PTO analytics ────────────────────────────────────────────────────────────
export interface PtoAnalytics {
  paidHours: number
  unpaidHours: number
  cost: number
  byKind: { kind: string; hours: number; pct: number }[]
  /** People with an allowance who've used none of it — burnout risk, not a KPI. */
  neverTakenAny: string[]
  /** People over their allowance. */
  overAllowance: { name: string; overBy: number }[]
}

export function ptoAnalytics(entries: PtoEntry[], technicians: Technician[], year: number): PtoAnalytics {
  const mine = entries.filter(e => parseDateOnly(e.date).getFullYear() === year)
  const byKind = new Map<string, number>()
  let paidHours = 0, unpaidHours = 0, cost = 0

  for (const e of mine) {
    const h = Number(e.hours)
    byKind.set(e.kind, (byKind.get(e.kind) ?? 0) + h)
    if (e.is_paid) {
      paidHours += h
      if (e.hourly_rate != null) cost += h * Number(e.hourly_rate)
    } else unpaidHours += h
  }

  const totalHours = paidHours + unpaidHours
  const usedByTech = new Map<string, number>()
  for (const e of mine) {
    if (!e.is_paid || e.kind === 'holiday') continue
    usedByTech.set(e.technician_id, (usedByTech.get(e.technician_id) ?? 0) + Number(e.hours))
  }

  const active = technicians.filter(t => t.is_active)
  return {
    paidHours: round2(paidHours),
    unpaidHours: round2(unpaidHours),
    cost: round2(cost),
    byKind: Array.from(byKind.entries())
      .map(([kind, hours]) => ({ kind, hours: round2(hours), pct: totalHours > 0 ? round1((hours / totalHours) * 100) : 0 }))
      .sort((a, b) => b.hours - a.hours),
    neverTakenAny: active
      .filter(t => t.pto_annual_hours != null && Number(t.pto_annual_hours) > 0 && !(usedByTech.get(t.id) ?? 0))
      .map(t => t.name),
    overAllowance: active
      .filter(t => t.pto_annual_hours != null && (usedByTech.get(t.id) ?? 0) > Number(t.pto_annual_hours))
      .map(t => ({ name: t.name, overBy: round2((usedByTech.get(t.id) ?? 0) - Number(t.pto_annual_hours)) }))
      .sort((a, b) => b.overBy - a.overBy),
  }
}

// ── Wage trends ──────────────────────────────────────────────────────────────
// Across the roster, from the wage_history audit trail. Ordered by seq, never
// created_at — see the migration: now() ties every row written in one transaction.
export interface WageTrend {
  /** Mean CURRENT wage across active people with one set. null if nobody has one. */
  averageWage: number | null
  /** Raises in the window (a change where the wage went up). */
  raises: number
  cuts: number
  /** Mean % change across those raises. null when there were none. */
  averageRaisePct: number | null
  lastChange: { name: string; from: number | null; to: number | null; at: string } | null
  /** Active people with no wage set — their hours can't be costed. */
  missingWage: string[]
}

export function wageTrends(args: {
  technicians: Technician[]
  history: WageHistoryEntry[]
  sinceISO?: string
}): WageTrend {
  const active = args.technicians.filter(t => t.is_active)
  const withWage = active.filter(t => t.hourly_wage != null)
  const since = args.sinceISO ? new Date(args.sinceISO).getTime() : null

  // Starting-wage rows (old_wage null) are not raises — excluding them keeps a new
  // hire from reading as a 100% pay rise.
  const changes = args.history
    .filter(h => h.old_wage != null && h.new_wage != null)
    .filter(h => (since == null ? true : new Date(h.created_at).getTime() >= since))

  const raises = changes.filter(h => Number(h.new_wage) > Number(h.old_wage!))
  const cuts = changes.filter(h => Number(h.new_wage) < Number(h.old_wage!))
  const raisePcts = raises
    .filter(h => Number(h.old_wage) > 0)
    .map(h => ((Number(h.new_wage) - Number(h.old_wage)) / Number(h.old_wage)) * 100)

  const nameOf = new Map(args.technicians.map(t => [t.id, t.name]))
  const newest = [...args.history].sort((a, b) => Number(b.seq) - Number(a.seq))[0]

  return {
    averageWage: withWage.length
      ? round2(withWage.reduce((s, t) => s + Number(t.hourly_wage), 0) / withWage.length)
      : null,
    raises: raises.length,
    cuts: cuts.length,
    averageRaisePct: raisePcts.length ? round1(raisePcts.reduce((s, v) => s + v, 0) / raisePcts.length) : null,
    lastChange: newest
      ? {
          name: nameOf.get(newest.technician_id) ?? 'Removed technician',
          from: newest.old_wage == null ? null : Number(newest.old_wage),
          to: newest.new_wage == null ? null : Number(newest.new_wage),
          at: newest.created_at,
        }
      : null,
    missingWage: active.filter(t => t.hourly_wage == null).map(t => t.name),
  }
}

// ── Pay run history rollup ───────────────────────────────────────────────────
export interface PayRunStats {
  runs: number
  ytdGross: number
  ytdOtMinutes: number
  /** OT as a share of worked minutes across YTD runs. */
  ytdOtSharePct: number | null
  lastRun: PayRun | null
  /** Periods since the last finalized run — a nudge, not an alarm. */
  periodsSinceLastRun: number | null
}

export function payRunStats(runs: PayRun[], rules: OvertimeRules, now = new Date()): PayRunStats {
  const year = now.getFullYear()
  const ytd = runs.filter(r => parseDateOnly(r.period_start).getFullYear() === year)
  const otMin = ytd.reduce((s, r) => s + r.ot_minutes, 0)
  const workedMin = ytd.reduce((s, r) => s + r.regular_minutes + r.ot_minutes, 0)
  const sorted = [...runs].sort((a, b) => b.period_start.localeCompare(a.period_start))
  const last = sorted[0] ?? null

  let periodsSince: number | null = null
  if (last) {
    // Count whole periods between the last run's end and today — how many
    // paydays have gone by unfinalized.
    const days = differenceInCalendarDays(startOfDay(now), parseDateOnly(last.period_end))
    let n = 0
    let p = payPeriodFor(parseDateOnly(last.period_end), rules)
    while (n < 60 && p.end.getTime() < startOfDay(now).getTime()) {
      p = shiftPayPeriod(p, 1, rules)
      if (p.end.getTime() < startOfDay(now).getTime()) n++
    }
    periodsSince = days > 0 ? n : 0
  }

  return {
    runs: runs.length,
    ytdGross: round2(ytd.reduce((s, r) => s + Number(r.gross_pay), 0)),
    ytdOtMinutes: otMin,
    ytdOtSharePct: workedMin > 0 ? round1((otMin / workedMin) * 100) : null,
    lastRun: last,
    periodsSinceLastRun: periodsSince,
  }
}
