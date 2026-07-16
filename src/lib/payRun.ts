// ── Pay runs ─────────────────────────────────────────────────────────────────
// Finalizing a pay period into a frozen record, and reading those records back.
// Pure data + one persist function; the maths is entirely delegated.
//
// THIS IS NOT A PAYROLL CALCULATOR. It computes no hours and no overtime. It
// COMPOSES the two engines that already exist:
//   worked pay  <- lib/payroll.payrollSummary  (regular/OT split, the ONE OT rule)
//   PTO pay     <- lib/pto.ptoTotalsFor        (hours x rate, never worked time)
//   gross       =  worked pay + PTO pay
// If overtime is ever wrong, there is exactly one file to fix, and it is not this
// one.
//
// WHY A PAY RUN IS A SNAPSHOT AND NOT A VIEW
// Once you have paid someone, that fact is history. If a pay run were recomputed
// on read, then editing an old time entry — or fixing an OT rule, or giving a
// raise — would silently restate a cheque that already cleared. So finalizing
// writes the numbers down, together with the OT rules that produced them. The
// Payroll page stays live and always-current; a pay run is the receipt.
//
// This is the same principle as TimeEntry.hourly_rate (snapshot the rate so a
// raise can't rewrite history), applied one level up to the whole period.
//
// DRIFT IS SURFACED, NOT HIDDEN
// Because a run is frozen, the underlying shifts CAN move after the fact. That is
// not corruption — it is the point — but the owner deserves to know. detectDrift()
// recomputes the period live and reports any gap, so the history page can say "you
// paid X; the shifts now say Y" instead of quietly showing a stale number.

import type { SupabaseClient } from '@supabase/supabase-js'
import { format } from 'date-fns'
import type { PayRun, PayRunLine, PtoEntry, Technician, TimeEntry } from '@/types'
import { payrollSummary, type OvertimeRules, type PayPeriod } from '@/lib/payroll'
import { ptoTotalsFor } from '@/lib/pto'

const round2 = (n: number) => Math.round(n * 100) / 100
const iso = (d: Date) => format(d, 'yyyy-MM-dd')

/** A pay run as it WOULD be if finalized now — the preview the owner confirms. */
export interface DraftPayRun {
  period: PayPeriod
  rules: OvertimeRules
  lines: DraftPayRunLine[]
  regularMinutes: number
  otMinutes: number
  workedPay: number
  ptoHours: number
  ptoPay: number
  grossPay: number
  employeeCount: number
  openShifts: number
  unratedMinutes: number
}

export interface DraftPayRunLine {
  technicianId: string
  technicianName: string
  technicianRole: string | null
  regularMinutes: number
  otMinutes: number
  blendedRate: number
  regularPay: number
  otPay: number
  ptoHours: number
  ptoPay: number
  grossPay: number
  shifts: number
  unratedMinutes: number
}

/**
 * Build the draft. Worked pay comes from lib/payroll; PTO from lib/pto; this
 * function only adds them together.
 *
 * Anyone with PTO but no shifts still gets a line — a week entirely on vacation
 * is a real paycheque, and dropping it would silently not pay someone.
 */
export function buildDraftPayRun(args: {
  entries: TimeEntry[]
  ptoEntries: PtoEntry[]
  technicians: Technician[]
  rules: OvertimeRules
  period: PayPeriod
}): DraftPayRun {
  const { entries, ptoEntries, technicians, rules, period } = args
  const startISO = iso(period.start)
  const endISO = iso(period.end)

  // THE overtime engine. Not reimplemented, not adjusted, not second-guessed.
  const worked = payrollSummary(entries, technicians, rules, period)
  const workedById = new Map(worked.rows.map(r => [r.technicianId, r]))
  const byId = new Map(technicians.map(t => [t.id, t]))

  // Everyone with worked time OR paid/unpaid time off in the period.
  const ids = new Set<string>(worked.rows.map(r => r.technicianId))
  for (const p of ptoEntries) {
    const d = p.date.slice(0, 10)
    if (d >= startISO && d <= endISO) ids.add(p.technician_id)
  }

  const lines: DraftPayRunLine[] = []
  for (const id of ids) {
    const w = workedById.get(id)
    const pto = ptoTotalsFor(ptoEntries, id, startISO, endISO)
    const t = byId.get(id)
    const regularPay = w?.regularPay ?? 0
    const otPay = w?.otPay ?? 0
    lines.push({
      technicianId: id,
      technicianName: w?.name ?? t?.name ?? 'Removed technician',
      technicianRole: t?.role ?? null,
      regularMinutes: w?.regularMinutes ?? 0,
      otMinutes: w?.otMinutes ?? 0,
      blendedRate: w?.blendedRate ?? 0,
      regularPay,
      otPay,
      // Reported as HOURS (not minutes) because PTO is booked in hours — a
      // half-day is 4h, never 240 minutes, on any form an owner has ever seen.
      ptoHours: pto.paidHours,
      ptoPay: pto.pay,
      grossPay: round2(regularPay + otPay + pto.pay),
      shifts: w?.shifts ?? 0,
      unratedMinutes: w?.unratedMinutes ?? 0,
    })
  }

  lines.sort((a, b) => b.grossPay - a.grossPay || a.technicianName.localeCompare(b.technicianName))

  return {
    period,
    rules,
    lines,
    regularMinutes: worked.regularMinutes,
    otMinutes: worked.otMinutes,
    workedPay: worked.totalPay,
    ptoHours: round2(lines.reduce((s, l) => s + l.ptoHours, 0)),
    ptoPay: round2(lines.reduce((s, l) => s + l.ptoPay, 0)),
    grossPay: round2(lines.reduce((s, l) => s + l.grossPay, 0)),
    employeeCount: lines.length,
    openShifts: worked.openShifts,
    unratedMinutes: worked.unratedMinutes,
  }
}

export type FinalizeResult = { ok: true; payRunId: string } | { ok: false; error: string }

/**
 * Freeze the draft. Writes the run + one line per employee, snapshotting the OT
 * rules alongside the totals so the record stays readable on its own terms.
 *
 * The lines are inserted AFTER the run and the run is deleted if they fail: a
 * pay run with no lines is a receipt with no contents, which is worse than no
 * receipt. (There is no client-side transaction in supabase-js, so this is the
 * honest compensating action rather than a pretend one.)
 */
export async function finalizePayRun(
  supabase: SupabaseClient,
  userId: string,
  draft: DraftPayRun,
  note?: string,
): Promise<FinalizeResult> {
  if (!draft.lines.length) return { ok: false, error: 'Nothing to finalize — no hours or time off in this period.' }

  const { data: run, error: runErr } = await supabase.from('pay_runs').insert({
    user_id: userId,
    period_start: iso(draft.period.start),
    period_end: iso(draft.period.end),
    period_kind: draft.rules.kind,
    note: note?.trim() || null,
    ot_daily_hours: draft.rules.dailyHours,
    ot_weekly_hours: draft.rules.weeklyHours,
    ot_multiplier: draft.rules.multiplier,
    pay_week_starts_on: draft.rules.weekStartsOn,
    regular_minutes: draft.regularMinutes,
    ot_minutes: draft.otMinutes,
    worked_pay: draft.workedPay,
    pto_hours: draft.ptoHours,
    pto_pay: draft.ptoPay,
    gross_pay: draft.grossPay,
    employee_count: draft.employeeCount,
  }).select('id').maybeSingle()

  if (runErr) {
    // 23505 = the one-run-per-period unique constraint.
    if (runErr.code === '23505') {
      return { ok: false, error: 'This pay period has already been finalized. Delete the existing pay run first to redo it.' }
    }
    return { ok: false, error: runErr.message }
  }
  if (!run) return { ok: false, error: 'Could not create the pay run.' }

  const { error: lineErr } = await supabase.from('pay_run_lines').insert(
    draft.lines.map(l => ({
      user_id: userId,
      pay_run_id: run.id as string,
      technician_id: l.technicianId,
      technician_name: l.technicianName,
      technician_role: l.technicianRole,
      regular_minutes: l.regularMinutes,
      ot_minutes: l.otMinutes,
      blended_rate: l.blendedRate,
      regular_pay: l.regularPay,
      ot_pay: l.otPay,
      pto_hours: l.ptoHours,
      pto_pay: l.ptoPay,
      gross_pay: l.grossPay,
      shifts: l.shifts,
      unrated_minutes: l.unratedMinutes,
    })),
  )

  if (lineErr) {
    await supabase.from('pay_runs').delete().eq('id', run.id)
    return { ok: false, error: `Could not save the pay stubs, so the pay run was rolled back: ${lineErr.message}` }
  }

  return { ok: true, payRunId: run.id as string }
}

// ── Drift ────────────────────────────────────────────────────────────────────

export interface PayRunDrift {
  /** Gross now, if the period were recomputed from today's shifts. */
  liveGross: number
  /** What was actually paid. */
  paidGross: number
  difference: number
  drifted: boolean
}

/**
 * Compare a frozen run against what the shifts say NOW.
 *
 * Recomputed with the run's OWN snapshot rules, not today's settings — the
 * question is "have the SHIFTS changed since I paid this", and using current
 * rules would conflate that with "have the rules changed", reporting drift on a
 * period where nothing about the work moved at all.
 */
export function detectDrift(args: {
  run: PayRun
  entries: TimeEntry[]
  ptoEntries: PtoEntry[]
  technicians: Technician[]
}): PayRunDrift {
  const { run, entries, ptoEntries, technicians } = args
  const rules: OvertimeRules = {
    dailyHours: run.ot_daily_hours == null ? null : Number(run.ot_daily_hours),
    weeklyHours: run.ot_weekly_hours == null ? null : Number(run.ot_weekly_hours),
    multiplier: Number(run.ot_multiplier),
    weekStartsOn: run.pay_week_starts_on as OvertimeRules['weekStartsOn'],
    kind: run.period_kind,
    anchorISO: null,
  }
  const start = new Date(`${run.period_start.slice(0, 10)}T00:00:00`)
  const end = new Date(`${run.period_end.slice(0, 10)}T00:00:00`)
  const period: PayPeriod = { kind: run.period_kind, start, end, label: '' }

  const live = buildDraftPayRun({ entries, ptoEntries, technicians, rules, period })
  const paidGross = round2(Number(run.gross_pay))
  const difference = round2(live.grossPay - paidGross)
  return { liveGross: live.grossPay, paidGross, difference, drifted: Math.abs(difference) >= 0.01 }
}
