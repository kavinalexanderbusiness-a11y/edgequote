// ── Reporting periods ────────────────────────────────────────────────────────
// A period is a pair of inclusive 'YYYY-MM-DD' strings. Everything here is string
// arithmetic on purpose — the same idiom the reports page uses — because parsing a
// stored date to build a range is how a December 31st receipt lands in the wrong
// tax year on a UTC boundary.
//
// The only Date used is "what is today for THIS user", which the caller passes in
// as an ISO string (localTodayISO()), so this module stays pure and testable.

export interface Period {
  from: string
  to: string
  label: string
}

export type PeriodKey =
  | 'today' | 'yesterday' | 'this_week' | 'last_week'
  | 'this_month' | 'last_month' | 'this_quarter' | 'last_quarter'
  | 'this_year' | 'last_year' | 'all' | 'custom'

export const PERIOD_OPTIONS: { value: PeriodKey; label: string }[] = [
  { value: 'today', label: 'Today' },
  { value: 'yesterday', label: 'Yesterday' },
  { value: 'this_week', label: 'This week' },
  { value: 'last_week', label: 'Last week' },
  { value: 'this_month', label: 'This month' },
  { value: 'last_month', label: 'Last month' },
  { value: 'this_quarter', label: 'This quarter' },
  { value: 'last_quarter', label: 'Last quarter' },
  { value: 'this_year', label: 'This year' },
  { value: 'last_year', label: 'Last year' },
  { value: 'all', label: 'All time' },
  { value: 'custom', label: 'Custom range…' },
]

const MONTH_NAMES = ['January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December']

const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']

const pad = (n: number) => String(n).padStart(2, '0')

/** Last calendar day of a month — the bit Feb 29 lives in. */
export function daysInMonth(year: number, month1: number): number {
  // Day 0 of the NEXT month is the last day of this one, and the Date constructor
  // applies the leap-year rule for us. Constructing from integers is safe: no
  // stored string is being parsed, so there is no timezone to shift across.
  return new Date(year, month1, 0).getDate()
}

export function monthRange(year: number, month1: number): Period {
  return {
    from: `${year}-${pad(month1)}-01`,
    to: `${year}-${pad(month1)}-${pad(daysInMonth(year, month1))}`,
    label: `${MONTH_NAMES[month1 - 1]} ${year}`,
  }
}

/**
 * Shift an ISO date by whole days.
 *
 * Same safety rule as daysInMonth: the Date is CONSTRUCTED from integers we split
 * off the string ourselves, never parsed from the string, so there is no timezone
 * to shift across. Date's constructor normalises overflow for us — day 0 of March
 * is the last of February, day 32 is the 1st of next month — so month ends and
 * leap years need no special case here.
 */
export function addDaysISO(iso: string, days: number): string {
  const y = Number(iso.slice(0, 4))
  const m = Number(iso.slice(5, 7))
  const d = Number(iso.slice(8, 10))
  const dt = new Date(y, m - 1, d + days)
  return `${dt.getFullYear()}-${pad(dt.getMonth() + 1)}-${pad(dt.getDate())}`
}

/** Day of week for an ISO date, 0=Sunday..6=Saturday. Constructed, never parsed. */
export function weekdayOf(iso: string): number {
  return new Date(Number(iso.slice(0, 4)), Number(iso.slice(5, 7)) - 1, Number(iso.slice(8, 10))).getDay()
}

/** A single day. `from` and `to` are the same date — a period of one. */
export function dayRange(iso: string): Period {
  return { from: iso, to: iso, label: `${DAY_NAMES[weekdayOf(iso)]}, ${MONTH_NAMES[Number(iso.slice(5, 7)) - 1]} ${Number(iso.slice(8, 10))}, ${iso.slice(0, 4)}` }
}

/**
 * The CALENDAR week (Sunday–Saturday) containing `iso`.
 *
 * Sunday-start is not a new convention: it is what BIReport.weekday already reports
 * against (Sun(0)..Sat(6)) and what date-fns' startOfWeek defaults to on the
 * profitability page. A third convention would mean two screens disagreeing about
 * which week a Sunday job belongs to.
 *
 * Deliberately NOT the trailing-7-days that /dashboard/review uses. That page is a
 * rolling look-back ("how did the last week go, asked today"), which is the right
 * shape for a page you open whenever. A SCHEDULED report is the opposite: it must
 * cover a fixed, closed period the owner can reconcile against a bank statement.
 * "The 7 days ending whenever the cron happened to fire" is not a week anyone can
 * check, and two runs a day apart would overlap by six days.
 */
export function weekRange(iso: string): Period {
  const from = addDaysISO(iso, -weekdayOf(iso))
  const to = addDaysISO(from, 6)
  return { from, to, label: `Week of ${MONTH_NAMES[Number(from.slice(5, 7)) - 1].slice(0, 3)} ${Number(from.slice(8, 10))}, ${from.slice(0, 4)}` }
}

export function quarterRange(year: number, q: 1 | 2 | 3 | 4): Period {
  const startMonth = (q - 1) * 3 + 1
  const endMonth = startMonth + 2
  return {
    from: `${year}-${pad(startMonth)}-01`,
    to: `${year}-${pad(endMonth)}-${pad(daysInMonth(year, endMonth))}`,
    label: `Q${q} ${year}`,
  }
}

export function yearRange(year: number): Period {
  return { from: `${year}-01-01`, to: `${year}-12-31`, label: String(year) }
}

export function quarterOf(month1: number): 1 | 2 | 3 | 4 {
  return (Math.floor((month1 - 1) / 3) + 1) as 1 | 2 | 3 | 4
}

/**
 * Resolve a named period against the owner's today.
 *
 * `todayISO` is the caller's LOCAL today (localTodayISO()), never new Date() in
 * here — a report is about the owner's calendar, not the server's.
 *
 * 'all' returns sentinel bounds rather than undefined so callers never branch on
 * "is there a filter"; '0001-01-01'..'9999-12-31' compares correctly as strings
 * against any real date, which is the point of the string idiom.
 */
export function resolvePeriod(key: PeriodKey, todayISO: string, custom?: { from: string; to: string }): Period {
  const year = Number(todayISO.slice(0, 4))
  const month = Number(todayISO.slice(5, 7))

  switch (key) {
    case 'today':
      return dayRange(todayISO)
    case 'yesterday':
      return dayRange(addDaysISO(todayISO, -1))
    case 'this_week':
      return weekRange(todayISO)
    case 'last_week':
      return weekRange(addDaysISO(todayISO, -7))
    case 'this_month':
      return monthRange(year, month)
    case 'last_month':
      return month === 1 ? monthRange(year - 1, 12) : monthRange(year, month - 1)
    case 'this_quarter':
      return quarterRange(year, quarterOf(month))
    case 'last_quarter': {
      const q = quarterOf(month)
      return q === 1 ? quarterRange(year - 1, 4) : quarterRange(year, (q - 1) as 1 | 2 | 3)
    }
    case 'this_year':
      return yearRange(year)
    case 'last_year':
      return yearRange(year - 1)
    case 'custom': {
      const from = custom?.from || todayISO
      const to = custom?.to || todayISO
      // A backwards range silently returns nothing, which reads as "no expenses"
      // rather than "your dates are the wrong way round". Swap instead.
      const [a, b] = from <= to ? [from, to] : [to, from]
      return { from: a, to: b, label: `${a} → ${b}` }
    }
    case 'all':
    default:
      return { from: '0001-01-01', to: '9999-12-31', label: 'All time' }
  }
}

/** Inclusive membership, straight off the string. Null/blank is never in a period. */
export function inPeriod(iso: string | null | undefined, p: Period): boolean {
  if (!iso) return false
  const d = iso.slice(0, 10)
  return d >= p.from && d <= p.to
}

/** 'YYYY-MM' key for grouping — the unit every accounting trend line uses. */
export function monthKey(iso: string): string {
  return iso.slice(0, 7)
}

export function monthKeyLabel(key: string): string {
  const y = key.slice(0, 4)
  const m = Number(key.slice(5, 7))
  return `${MONTH_NAMES[m - 1]?.slice(0, 3) ?? key} ${y}`
}

/**
 * Every 'YYYY-MM' from `from` to `to` inclusive.
 *
 * Integer month arithmetic rather than walking Dates, so a month with no activity
 * still appears — a trend that skips empty months implies the business didn't exist
 * in them, and puts two bars a year apart side by side.
 *
 * Capped at 20 years: the 'all time' sentinel spans ~9998 years and would build a
 * 120k-element array that nothing can render.
 */
export function monthsBetween(from: string, to: string): string[] {
  const out: string[] = []
  let y = Number(from.slice(0, 4))
  let m = Number(from.slice(5, 7))
  const endY = Number(to.slice(0, 4))
  const endM = Number(to.slice(5, 7))
  if (!isFinite(y) || !isFinite(endY) || endY - y > 20) return []
  while (y < endY || (y === endY && m <= endM)) {
    out.push(`${y}-${pad(m)}`)
    m++
    if (m > 12) { m = 1; y++ }
  }
  return out
}

/**
 * Narrow an open/sentinel period to the data actually present, for charting.
 * 'All time' with one 2026 receipt should draw 2026, not 9,998 empty years.
 */
export function clampPeriodToData(p: Period, dates: string[]): { from: string; to: string } {
  if (!dates.length) return { from: p.from, to: p.to }
  let lo = dates[0], hi = dates[0]
  for (const d of dates) {
    if (d < lo) lo = d
    if (d > hi) hi = d
  }
  return { from: p.from < lo ? lo : p.from, to: p.to > hi ? hi : p.to }
}
