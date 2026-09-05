// ── How long the work takes, said in the unit the trade actually uses ────────
//
// One number is stored — `jobs.duration_minutes`, integer minutes, unchanged
// since the schema was written. This file is the ONLY translation between that
// number and the words a person types: 45 minutes, 2 hours, 1.5 hours, 3
// workdays. ⛔ There is no second duration column, no "duration_unit" column and
// no hours-vs-minutes fork anywhere downstream. A unit is a way of SAYING a
// duration, not a second fact about it — the moment it is stored, every reader
// (dayFit's capacity maths, lib/duration's learning, estimate-vs-actual) would
// have to learn about it, and one of them would forget.
//
// ⭐⭐ A WORKDAY IS NOT 24 HOURS.
//
// It is `business_settings.daily_capacity_hours` — the field the owner already
// sets in Settings, that already means "how long my working day is", that the
// calendar's capacity bar, dayFit, dayStatus, the dispatch board and the
// suggestions engine already read, and that already defaults to 8. Nothing new
// was invented here and nothing was hard-coded: a two-person cleaning business
// on 6-hour days and a construction crew on 10-hour days each get "1 day"
// meaning their own day. The 8-hour fallback below is the SAME fallback those
// six existing call sites use, so a business that has never opened Settings sees
// one consistent answer rather than a seventh opinion.
//
// ⚠️ One deliberate divergence from dayFit: there, an EXPLICIT `0` capacity means
// "this day is blocked". As a unit of measurement zero is not a quantity — a job
// cannot be "3 days" long if a day is zero hours — so a non-positive setting
// falls back here rather than propagating a division by zero. dayFit's reading
// is untouched.
//
// ⭐ ELAPSED, NOT LABOUR. `duration_minutes` is time ON SITE — the clock. Two
// people for one day is still one day of duration; the second person is
// `crew_size`, and person-hours are that product, computed by dayFit for
// capacity and by lib/workSession for what actually happened. Saying "2 days"
// here never means "2 person-days".

/** The workday used when the business has not set one. The same figure every
 *  existing `daily_capacity_hours` reader falls back to. */
export const WORKDAY_FALLBACK_HOURS = 8

/** Units a duration may be SPOKEN in. The stored value is always minutes. */
export type DurationUnit = 'minutes' | 'hours' | 'days'

export const DURATION_UNITS: { value: DurationUnit; label: string; short: string }[] = [
  { value: 'minutes', label: 'Minutes', short: 'min' },
  { value: 'hours', label: 'Hours', short: 'h' },
  // Deliberately "Workdays" and not "Days": the word has to carry that this is
  // the business's working day, not a 24-hour one, at the point of choosing it.
  { value: 'days', label: 'Workdays', short: 'd' },
]

/**
 * Minutes in ONE workday, from the owner's own setting.
 * Clamped to a real day (1 minute … 24 hours) so a typo in Settings can never
 * make "1 day" mean a week or nothing at all.
 */
export function workdayMinutes(capacityHours: number | null | undefined): number {
  const h = Number(capacityHours)
  if (!Number.isFinite(h) || h <= 0) return WORKDAY_FALLBACK_HOURS * 60
  return Math.round(Math.min(24, h) * 60)
}

/** Is this business's workday something other than the default? Used to word
 *  the hint under the field — a business on 8h days does not need telling. */
export function workdayIsCustom(workdayMin: number): boolean {
  return workdayMin !== WORKDAY_FALLBACK_HOURS * 60
}

/** "8-hour day" / "7.5-hour day" — never a bare number of hours, because the
 *  reader has to know it is a WORKING day being described. */
export function describeWorkday(workdayMin: number): string {
  const h = workdayMin / 60
  const shown = Number.isInteger(h) ? String(h) : h.toFixed(1).replace(/\.0$/, '')
  return `${shown}-hour day`
}

/**
 * A typed value + unit → stored minutes. Returns null for anything that is not
 * a positive quantity, so "not stated" stays distinguishable from "zero" all
 * the way to the column (which is nullable for exactly that reason).
 *
 * 90 + minutes → 90 · 1.5 + hours → 90 · 2 + hours → 120 · 0.5 + days → half
 * of whatever this business's day is. Fractions are accepted and rounded to a
 * whole minute; nobody schedules a third of a minute.
 */
export function toMinutes(
  value: number | string | null | undefined,
  unit: DurationUnit,
  workdayMin: number,
): number | null {
  const n = typeof value === 'string' ? Number(value.trim()) : Number(value)
  if (!Number.isFinite(n) || n <= 0) return null
  const per = unit === 'days' ? workdayMin : unit === 'hours' ? 60 : 1
  const mins = Math.round(n * per)
  return mins > 0 ? mins : null
}

/**
 * Stored minutes → the value + unit to SHOW in the control. The largest unit
 * that says the same number without lying:
 *
 *   480 (8h day) → 1 workday · 720 → 1.5 workdays · 120 → 2 hours
 *   90 → 1.5 hours · 45 → 45 minutes · 50 → 50 minutes
 *
 * Halves are allowed because "1.5 hours" is how people speak; thirds are not,
 * because "1.33 hours" is how nobody speaks. Anything that would need a third
 * falls back to the unit below, where it is exact.
 */
export function splitDuration(
  minutes: number | null | undefined,
  workdayMin: number,
): { value: number; unit: DurationUnit } {
  const m = Number(minutes)
  if (!Number.isFinite(m) || m <= 0) return { value: 0, unit: 'minutes' }
  const days = m / workdayMin
  if (days >= 1 && Number.isInteger(days * 2)) return { value: days, unit: 'days' }
  const hours = m / 60
  if (hours >= 1 && Number.isInteger(hours * 2)) return { value: hours, unit: 'hours' }
  return { value: m, unit: 'minutes' }
}

/** "2", "1.5" — a value for an input box, never "1.50" or "2.0". */
export function durationValueText(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return ''
  return Number.isInteger(value) ? String(value) : String(Number(value.toFixed(2)))
}

/**
 * A PLANNED duration in words: "45m", "2h", "1h 30m", "1 day", "2 days 4h".
 *
 * Days appear only once the estimate reaches a whole working day — below that
 * "0.4 days" is a worse answer than "3h" for every trade. Above it, the day is
 * the unit the owner priced the work in.
 */
export function formatDuration(
  minutes: number | null | undefined,
  workdayMin: number,
): string {
  const m = Math.round(Number(minutes))
  if (!Number.isFinite(m) || m <= 0) return ''
  if (m < workdayMin) return formatWorked(m)
  const days = Math.floor(m / workdayMin)
  const rest = m - days * workdayMin
  const dayPart = `${days} day${days === 1 ? '' : 's'}`
  return rest > 0 ? `${dayPart} ${formatWorked(rest)}` : dayPart
}

/**
 * TIME ACTUALLY WORKED in words: "45m", "3h 20m", "8h".
 *
 * ⭐ Never expressed in days, and that is the point. A workday is a PLANNING
 * unit — a way of sizing work before it happens. Once the work has happened, the
 * business knows real hours and real minutes, and rendering them back as "0.9
 * days" would throw away precision the record actually has and re-state a fact
 * through a setting that could change tomorrow. History reads in hours forever.
 */
export function formatWorked(minutes: number | null | undefined): string {
  const m = Math.round(Number(minutes))
  if (!Number.isFinite(m) || m <= 0) return ''
  const h = Math.floor(m / 60)
  const rest = m - h * 60
  if (h === 0) return `${rest}m`
  if (rest === 0) return `${h}h`
  return `${h}h ${rest}m`
}

/** The same figure with the word spelled out, for one-line history entries:
 *  "Worked 3h 20m". Empty when there is nothing true to say. */
export function formatWorkedLong(minutes: number | null | undefined): string {
  const s = formatWorked(minutes)
  return s ? `Worked ${s}` : ''
}
