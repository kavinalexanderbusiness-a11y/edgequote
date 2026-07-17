// ── Payroll engine ───────────────────────────────────────────────────────────
// THE one place "what pay period is this, and what do these hours cost once
// overtime is applied" is answered. The timesheet, the payroll summary and any
// future export all read from here so no two screens can disagree about a
// paycheque.
//
// Sits ON TOP of lib/timeTracking (duration) — it never re-derives a shift's
// length. Pure data + date maths; no React, no supabase (mirrors lib/crews,
// lib/dayStatus, lib/timeTracking).
//
// FOUR RULES THIS ENCODES, EACH BECAUSE THE NAIVE VERSION IS WRONG
//
//  1. OT IS THE GREATER OF DAILY OR WEEKLY — NEVER THE SUM.
//     Alberta's 8/44 rule (and most of Canada) pays the greater of daily OT or
//     weekly OT, precisely so the same hour is not paid twice. Adding them
//     double-counts: 5 x 10h days = 10h daily OT and 6h weekly OT; the answer is
//     10, not 16.
//
//  2. PAY COMES FROM THE SNAPSHOT RATE, NEVER technicians.hourly_wage.
//     Each entry carries the rate it was clocked in at. Pricing history off the
//     live wage would rewrite every past shift the moment someone gets a raise.
//
//  3. MIXED RATES IN ONE WEEK USE A BLENDED (WEIGHTED-AVERAGE) RATE.
//     If a week has hours at two rates, "the" OT rate is ambiguous. Payroll
//     practice — and the only defensible answer — is the weighted average of the
//     rates actually worked that week. With one rate (the normal case) the
//     blended rate IS that rate, so this costs nothing and is right in both.
//
//  4. OPEN SHIFTS ARE NEVER PAID.
//     A shift with no clock_out has no duration (the DB's minutes_worked is NULL
//     for exactly this reason). Paying a guess would be inventing money; open
//     shifts are counted and surfaced so the owner can close them, not silently
//     dropped and not silently paid.
//
// WORK WEEK vs PAY PERIOD are different things and are kept apart. The work week
// (pay_week_starts_on) is the legal OT boundary. The pay period is how often you
// cut cheques. A biweekly period contains two OT weeks, each judged on its own.
//
// KNOWN LIMIT — semimonthly/monthly: those periods do not align to work weeks, so
// a week straddling the boundary has its OT judged on the slice inside each
// period. Weekly/biweekly align to week starts and are exact. periodSplitsWeeks()
// reports this so the UI can say so out loud rather than quietly be approximate.

import {
  startOfDay, startOfWeek, addDays, addWeeks, startOfMonth, endOfMonth,
  differenceInCalendarWeeks, format,
} from 'date-fns'
import type { BusinessSettings, PayPeriodKind, Technician, TimeEntry } from '@/types'
import { entryMinutes, isOpen } from '@/lib/timeTracking'

export type WeekDay = 0 | 1 | 2 | 3 | 4 | 5 | 6

export interface OvertimeRules {
  /** Hours per DAY after which OT applies. null = no daily rule. */
  dailyHours: number | null
  /** Hours per WORK WEEK after which OT applies. null = no weekly rule. */
  weeklyHours: number | null
  /** OT pay multiplier (1.5 = time-and-a-half). */
  multiplier: number
  /** Work-week boundary — the OT week, not the pay period. */
  weekStartsOn: WeekDay
  kind: PayPeriodKind
  /** Any known period start (ISO date) — biweekly needs it. */
  anchorISO: string | null
}

/** Settings → rules, with the same conservative defaults the DB uses. */
export function payrollRules(s: Pick<BusinessSettings,
  'ot_daily_hours' | 'ot_weekly_hours' | 'ot_multiplier' | 'pay_period' | 'pay_period_anchor' | 'pay_week_starts_on'
> | null): OvertimeRules {
  const wk = Number(s?.pay_week_starts_on ?? 1)
  return {
    dailyHours: s?.ot_daily_hours != null ? Number(s.ot_daily_hours) : null,
    weeklyHours: s?.ot_weekly_hours != null ? Number(s.ot_weekly_hours) : null,
    // Never below 1: a multiplier under 1 would make overtime a pay CUT.
    multiplier: Math.max(1, Number(s?.ot_multiplier ?? 1.5)),
    weekStartsOn: (wk >= 0 && wk <= 6 ? wk : 1) as WeekDay,
    kind: (s?.pay_period ?? 'biweekly') as PayPeriodKind,
    anchorISO: s?.pay_period_anchor ?? null,
  }
}

/** True when NO overtime rule is configured — every minute is regular time. */
export function overtimeOff(r: OvertimeRules): boolean {
  return r.dailyHours == null && r.weeklyHours == null
}

// ── Pay periods ──────────────────────────────────────────────────────────────

export interface PayPeriod {
  kind: PayPeriodKind
  /** Local start-of-day, inclusive. */
  start: Date
  /** Local start-of-day of the LAST day, inclusive. Compare with endOfDay(end). */
  end: Date
  label: string
}

// Fixed, deterministic fallback when no anchor is set: the week containing the
// epoch, aligned to the owner's week start. Same input → same periods, forever.
function defaultAnchor(weekStartsOn: WeekDay): Date {
  return startOfWeek(new Date(1970, 0, 1), { weekStartsOn })
}

function labelFor(kind: PayPeriodKind, start: Date, end: Date): string {
  const sameMonth = start.getMonth() === end.getMonth() && start.getFullYear() === end.getFullYear()
  if (kind === 'monthly') return format(start, 'MMMM yyyy')
  return sameMonth
    ? `${format(start, 'MMM d')} – ${format(end, 'd, yyyy')}`
    : `${format(start, 'MMM d')} – ${format(end, 'MMM d, yyyy')}`
}

/** The pay period containing `date`. */
export function payPeriodFor(date: Date, r: OvertimeRules): PayPeriod {
  const d = startOfDay(date)
  switch (r.kind) {
    case 'weekly': {
      const start = startOfWeek(d, { weekStartsOn: r.weekStartsOn })
      const end = addDays(start, 6)
      return { kind: r.kind, start, end, label: labelFor(r.kind, start, end) }
    }
    case 'biweekly': {
      const anchor = r.anchorISO
        ? startOfWeek(parseDateOnly(r.anchorISO), { weekStartsOn: r.weekStartsOn })
        : defaultAnchor(r.weekStartsOn)
      const thisWeek = startOfWeek(d, { weekStartsOn: r.weekStartsOn })
      // Math.floor (not trunc) so dates BEFORE the anchor land in the right
      // period too — trunc would round -1.5 toward zero and shift them a period.
      const weeks = differenceInCalendarWeeks(thisWeek, anchor, { weekStartsOn: r.weekStartsOn })
      const start = addWeeks(anchor, Math.floor(weeks / 2) * 2)
      const end = addDays(start, 13)
      return { kind: r.kind, start, end, label: labelFor(r.kind, start, end) }
    }
    case 'semimonthly': {
      const first = d.getDate() <= 15
      const start = first ? startOfMonth(d) : new Date(d.getFullYear(), d.getMonth(), 16)
      const end = first ? new Date(d.getFullYear(), d.getMonth(), 15) : endOfMonth(d)
      return { kind: r.kind, start: startOfDay(start), end: startOfDay(end), label: labelFor(r.kind, start, end) }
    }
    case 'monthly':
    default: {
      const start = startOfMonth(d)
      const end = startOfDay(endOfMonth(d))
      return { kind: 'monthly', start, end, label: labelFor('monthly', start, end) }
    }
  }
}

/** Step `delta` whole periods from `p` (-1 = previous, +1 = next). */
export function shiftPayPeriod(p: PayPeriod, delta: number, r: OvertimeRules): PayPeriod {
  if (delta === 0) return p
  // Walk one period at a time off a date that is unambiguously inside the
  // neighbour. Semimonthly/monthly have uneven lengths, so arithmetic on a fixed
  // day count would drift.
  let cur = p
  for (let i = 0; i < Math.abs(delta); i++) {
    const probe = delta > 0 ? addDays(cur.end, 1) : addDays(cur.start, -1)
    cur = payPeriodFor(probe, r)
  }
  return cur
}

/** Whether this period's boundaries can split an OT work week (see header). */
export function periodSplitsWeeks(r: OvertimeRules): boolean {
  return (r.kind === 'semimonthly' || r.kind === 'monthly') && !overtimeOff(r)
}

/** 'YYYY-MM-DD' → local midnight (never UTC — that shifts a day in Calgary). */
function parseDateOnly(iso: string): Date {
  const [y, m, d] = iso.slice(0, 10).split('-').map(Number)
  return new Date(y, (m || 1) - 1, d || 1)
}

export function inPeriod(e: TimeEntry, p: PayPeriod): boolean {
  const t = new Date(e.clock_in).getTime()
  return t >= p.start.getTime() && t < addDays(p.end, 1).getTime()
}

// ── The split ────────────────────────────────────────────────────────────────

export interface TechPayrollRow {
  technicianId: string
  name: string
  regularMinutes: number
  otMinutes: number
  totalMinutes: number
  /** Weighted-average rate actually worked this period (display + audit). */
  blendedRate: number
  regularPay: number
  otPay: number
  totalPay: number
  /** Closed shifts that were paid. */
  shifts: number
  /** Open shifts in range — counted, never paid. */
  openShifts: number
  /** Paid minutes carrying no rate — worked but worth $0 until a wage is set. */
  unratedMinutes: number
}

export interface PayrollSummary {
  period: PayPeriod
  rows: TechPayrollRow[]
  regularMinutes: number
  otMinutes: number
  totalMinutes: number
  totalPay: number
  openShifts: number
  unratedMinutes: number
  /** OT judged on a partial week — see periodSplitsWeeks(). */
  approximate: boolean
}

const round2 = (n: number) => Math.round(n * 100) / 100

/**
 * Regular vs OT minutes for ONE technician's closed entries, judged per work
 * week. Exported for verification and reuse; the summary below is the caller.
 */
export function splitRegularOvertime(
  closed: TimeEntry[],
  r: OvertimeRules,
): { regularMinutes: number; otMinutes: number; regularPay: number; otPay: number; unratedMinutes: number } {
  const byWeek = new Map<string, TimeEntry[]>()
  for (const e of closed) {
    const k = format(startOfWeek(new Date(e.clock_in), { weekStartsOn: r.weekStartsOn }), 'yyyy-MM-dd')
    const list = byWeek.get(k)
    if (list) list.push(e); else byWeek.set(k, [e])
  }

  let regularMinutes = 0, otMinutes = 0, regularPay = 0, otPay = 0, unratedMinutes = 0

  for (const week of byWeek.values()) {
    // Minutes per calendar day — the daily rule's unit.
    const byDay = new Map<string, number>()
    let weekMinutes = 0, ratedMinutes = 0, ratedCost = 0

    for (const e of week) {
      const m = entryMinutes(e)
      const k = format(startOfDay(new Date(e.clock_in)), 'yyyy-MM-dd')
      byDay.set(k, (byDay.get(k) ?? 0) + m)
      weekMinutes += m
      if (e.hourly_rate == null) unratedMinutes += m
      else { ratedMinutes += m; ratedCost += m * Number(e.hourly_rate) }
    }

    const dailyOt = r.dailyHours == null
      ? 0
      : Array.from(byDay.values()).reduce((s, m) => s + Math.max(0, m - r.dailyHours! * 60), 0)
    const weeklyOt = r.weeklyHours == null
      ? 0
      : Math.max(0, weekMinutes - r.weeklyHours * 60)

    // GREATER of, never the sum — see header rule 1.
    const ot = Math.min(weekMinutes, Math.max(dailyOt, weeklyOt))
    const reg = weekMinutes - ot

    // Weighted average over RATED minutes only: unrated minutes are worth $0 and
    // must not drag the rate of the hours that do have one.
    const blended = ratedMinutes > 0 ? ratedCost / ratedMinutes : 0
    // Pay only the rated share; scale by how much of the week carried a rate.
    const ratedShare = weekMinutes > 0 ? ratedMinutes / weekMinutes : 0

    regularMinutes += reg
    otMinutes += ot
    regularPay += (reg * ratedShare / 60) * blended
    otPay += (ot * ratedShare / 60) * blended * r.multiplier
  }

  return {
    regularMinutes, otMinutes,
    regularPay: round2(regularPay),
    otPay: round2(otPay),
    unratedMinutes,
  }
}

/** The payroll summary for a period: one row per technician with hours worked. */
export function payrollSummary(
  entries: TimeEntry[],
  technicians: Technician[],
  r: OvertimeRules,
  period: PayPeriod,
): PayrollSummary {
  const scoped = entries.filter(e => inPeriod(e, period))
  const byTech = new Map<string, TimeEntry[]>()
  for (const e of scoped) {
    const list = byTech.get(e.technician_id)
    if (list) list.push(e); else byTech.set(e.technician_id, [e])
  }

  const nameOf = new Map(technicians.map(t => [t.id, t.name]))
  const rows: TechPayrollRow[] = []

  for (const [technicianId, all] of byTech) {
    const closed = all.filter(e => !isOpen(e))
    const openShifts = all.length - closed.length
    // A tech with only an open shift still belongs on the sheet — otherwise the
    // owner cannot see WHY their hours are missing.
    if (!closed.length && !openShifts) continue

    const s = splitRegularOvertime(closed, r)
    const totalMinutes = s.regularMinutes + s.otMinutes
    // Weighted by minutes: sum(minutes x rate) / sum(minutes) IS already a
    // per-hour rate (the minutes cancel), so it must NOT be scaled by 60 again.
    let ratedMinutes = 0, weighted = 0
    for (const e of closed) {
      if (e.hourly_rate == null) continue
      const m = entryMinutes(e)
      ratedMinutes += m
      weighted += m * Number(e.hourly_rate)
    }

    rows.push({
      technicianId,
      name: nameOf.get(technicianId) ?? 'Removed technician',
      regularMinutes: s.regularMinutes,
      otMinutes: s.otMinutes,
      totalMinutes,
      blendedRate: ratedMinutes > 0 ? round2(weighted / ratedMinutes) : 0,
      regularPay: s.regularPay,
      otPay: s.otPay,
      totalPay: round2(s.regularPay + s.otPay),
      shifts: closed.length,
      openShifts,
      unratedMinutes: s.unratedMinutes,
    })
  }

  rows.sort((a, b) => b.totalPay - a.totalPay || a.name.localeCompare(b.name))

  return {
    period,
    rows,
    regularMinutes: rows.reduce((s, x) => s + x.regularMinutes, 0),
    otMinutes: rows.reduce((s, x) => s + x.otMinutes, 0),
    totalMinutes: rows.reduce((s, x) => s + x.totalMinutes, 0),
    totalPay: round2(rows.reduce((s, x) => s + x.totalPay, 0)),
    openShifts: rows.reduce((s, x) => s + x.openShifts, 0),
    unratedMinutes: rows.reduce((s, x) => s + x.unratedMinutes, 0),
    approximate: periodSplitsWeeks(r),
  }
}
