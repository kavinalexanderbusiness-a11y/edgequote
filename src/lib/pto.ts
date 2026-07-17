// ── PTO + holidays ───────────────────────────────────────────────────────────
// THE paid-time-off ledger: vacation, sick, holiday, personal. Pure data; no
// React, no supabase (mirrors lib/payroll, lib/timeTracking, lib/laborCost).
//
// THE ONE RULE THIS FILE EXISTS TO ENFORCE
// PTO HOURS ARE NOT HOURS WORKED. They never reach an overtime threshold.
//
// Someone who works 40h and takes 8h of vacation in a week has worked 40 hours,
// not 48. Against a 44h weekly rule the naive reading invents 4h of overtime and
// overpays — every single week that contains a day off. That is why PtoEntry is a
// separate table from TimeEntry rather than a `kind` column on it: lib/payroll
// only ever sees TimeEntry, so it is structurally incapable of counting a
// vacation day as worked. The separation is the safeguard.
//
// This file therefore NEVER imports lib/payroll and never computes overtime. PTO
// pay is a flat hours x rate earning, added alongside worked pay in lib/payRun.
//
// WHY THE RATE IS SNAPSHOT ON THE ENTRY
// Same reason as TimeEntry.hourly_rate: a raise must not retroactively re-value
// vacation someone already took (and you may already have paid).
//
// WHAT THIS DELIBERATELY DOES NOT DO — STATUTORY HOLIDAY PAY
// Canadian statutory holiday pay is genuinely jurisdictional: the formula differs
// (Alberta's average-daily-wage over 4 weeks vs BC's over 30 days vs Ontario's
// own), and eligibility has its own tests (days worked in the last 12 months,
// the shift before and after, and so on). Computing it wrong means underpaying a
// person, which is a legal problem, not a rounding error. So EdgeQuote does not
// decide eligibility and does not invent the formula: a holiday is paid hours the
// OWNER sets, at the employee's own rate. averageDailyWage() below is offered as
// an INPUT to that decision, clearly labelled, never applied automatically.

import { format } from 'date-fns'
import type { Holiday, PtoEntry, PtoKind, Technician, TimeEntry } from '@/types'
import { entryMinutes, isOpen } from '@/lib/timeTracking'

const round2 = (n: number) => Math.round(n * 100) / 100

/** 'YYYY-MM-DD' → local midnight. Never `new Date(iso)`, which parses as UTC and
 *  can land a day off on the wrong side of midnight in Calgary. */
export function parseDateOnly(iso: string): Date {
  const [y, m, d] = iso.slice(0, 10).split('-').map(Number)
  return new Date(y, (m || 1) - 1, d || 1)
}

export function ptoPay(e: PtoEntry): number {
  if (!e.is_paid || e.hourly_rate == null) return 0
  return round2(Number(e.hours) * Number(e.hourly_rate))
}

export function inDateRange(e: PtoEntry, startISO: string, endISO: string): boolean {
  const d = e.date.slice(0, 10)
  return d >= startISO.slice(0, 10) && d <= endISO.slice(0, 10)
}

// ── Balances ─────────────────────────────────────────────────────────────────

export interface PtoBalance {
  technicianId: string
  name: string
  /** Allowance in hours; null = none configured (no balance is claimed). */
  allowanceHours: number | null
  /** Paid PTO hours taken in the year. Unpaid leave is absence, not drawdown. */
  usedHours: number
  /** Unpaid leave, reported separately so it isn't silently invisible. */
  unpaidHours: number
  /** allowance − used. null when no allowance is set. Can go negative — that's a
   *  real state (someone took more than they had), not an error to clamp away. */
  remainingHours: number | null
  byKind: Record<PtoKind, number>
}

const ZERO_BY_KIND = (): Record<PtoKind, number> =>
  ({ vacation: 0, sick: 0, holiday: 0, personal: 0, bereavement: 0 })

/**
 * Balances for one calendar year.
 *
 * Holiday hours are counted in `byKind` for visibility but do NOT draw down the
 * allowance: a statutory holiday is given by the employer, not taken out of
 * someone's vacation. Counting it as drawdown would quietly shrink everyone's
 * vacation by the number of holidays in the year.
 */
export function ptoBalances(entries: PtoEntry[], technicians: Technician[], year: number): PtoBalance[] {
  const byTech = new Map<string, PtoEntry[]>()
  for (const e of entries) {
    if (parseDateOnly(e.date).getFullYear() !== year) continue
    const list = byTech.get(e.technician_id)
    if (list) list.push(e); else byTech.set(e.technician_id, [e])
  }

  return technicians.map(t => {
    const mine = byTech.get(t.id) ?? []
    const byKind = ZERO_BY_KIND()
    let usedHours = 0, unpaidHours = 0
    for (const e of mine) {
      const h = Number(e.hours)
      byKind[e.kind] += h
      if (!e.is_paid) { unpaidHours += h; continue }
      if (e.kind !== 'holiday') usedHours += h
    }
    const allowanceHours = t.pto_annual_hours == null ? null : Number(t.pto_annual_hours)
    return {
      technicianId: t.id,
      name: t.name,
      allowanceHours,
      usedHours: round2(usedHours),
      unpaidHours: round2(unpaidHours),
      remainingHours: allowanceHours == null ? null : round2(allowanceHours - usedHours),
      byKind,
    }
  }).sort((a, b) => a.name.localeCompare(b.name))
}

// ── Holidays ─────────────────────────────────────────────────────────────────

/**
 * The PTO rows a holiday would create — computed, not written. The caller
 * decides whether to persist them, so "apply Canada Day" is previewable and the
 * owner sees the cost before it lands.
 *
 * Skips anyone already given that holiday (the DB's unique (technician, date,
 * kind) would reject a duplicate anyway — this makes it a no-op instead of an
 * error), anyone inactive, and anyone not yet hired / already departed.
 */
export function holidayPtoRows(
  holiday: Holiday,
  technicians: Technician[],
  existing: PtoEntry[],
): { technician_id: string; date: string; hours: number; kind: PtoKind; is_paid: boolean; hourly_rate: number | null; holiday_id: string }[] {
  const already = new Set(
    existing.filter(e => e.date.slice(0, 10) === holiday.date.slice(0, 10) && e.kind === 'holiday')
      .map(e => e.technician_id),
  )
  return technicians
    .filter(t => t.is_active && !already.has(t.id) && employedOn(t, holiday.date))
    .map(t => ({
      technician_id: t.id,
      date: holiday.date.slice(0, 10),
      hours: Number(holiday.default_hours),
      kind: 'holiday' as PtoKind,
      is_paid: holiday.is_paid,
      // Snapshot the wage NOW, exactly as clock-in does.
      hourly_rate: t.hourly_wage == null ? null : Number(t.hourly_wage),
      holiday_id: holiday.id,
    }))
}

/** Employed on a date — someone hired next month doesn't get last month's holiday. */
export function employedOn(t: Technician, dateISO: string): boolean {
  const d = dateISO.slice(0, 10)
  if (t.hired_on && d < t.hired_on.slice(0, 10)) return false
  if (t.ended_on && d > t.ended_on.slice(0, 10)) return false
  return true
}

/**
 * Average daily wage over the trailing `days` of WORKED time — an input to the
 * owner's holiday-pay decision, never applied on its own (see header).
 *
 * Denominator is DAYS ACTUALLY WORKED, not calendar days: averaging over calendar
 * days would divide a part-timer's wages across days they were never scheduled
 * and understate every one of their holidays.
 */
export function averageDailyWage(entries: TimeEntry[], technicianId: string, before: Date, days = 28): number | null {
  const from = new Date(before.getTime() - days * 86_400_000)
  const worked = new Map<string, number>()
  let total = 0
  for (const e of entries) {
    if (e.technician_id !== technicianId || isOpen(e) || e.hourly_rate == null) continue
    const at = new Date(e.clock_in)
    if (at < from || at >= before) continue
    const m = entryMinutes(e)
    total += (m / 60) * Number(e.hourly_rate)
    const k = format(at, 'yyyy-MM-dd')
    worked.set(k, (worked.get(k) ?? 0) + m)
  }
  const daysWorked = worked.size
  if (daysWorked === 0) return null
  return round2(total / daysWorked)
}

// ── Period rollup (consumed by lib/payRun) ───────────────────────────────────

export interface PtoPeriodTotals {
  hours: number
  paidHours: number
  unpaidHours: number
  pay: number
  byKind: Record<PtoKind, number>
}

export function ptoTotalsFor(entries: PtoEntry[], technicianId: string, startISO: string, endISO: string): PtoPeriodTotals {
  const byKind = ZERO_BY_KIND()
  let hours = 0, paidHours = 0, unpaidHours = 0, pay = 0
  for (const e of entries) {
    if (e.technician_id !== technicianId || !inDateRange(e, startISO, endISO)) continue
    const h = Number(e.hours)
    hours += h
    byKind[e.kind] += h
    if (e.is_paid) { paidHours += h; pay += ptoPay(e) } else unpaidHours += h
  }
  return { hours: round2(hours), paidHours: round2(paidHours), unpaidHours: round2(unpaidHours), pay: round2(pay), byKind }
}
