import { addDays, addMonths, format, parseISO, differenceInCalendarDays } from 'date-fns'
import type { Job, RecurUnit, RecurrenceScope } from '@/types'

// Safety caps so a series never materialises unbounded rows.
const HARD_CAP = 260            // ~5 years weekly — absolute ceiling
const OPEN_ENDED_HORIZON = 26   // visits to pre-create when there's no end

function stepUnit(d: Date, unit: RecurUnit, count: number): Date {
  if (unit === 'day') return addDays(d, count)
  if (unit === 'week') return addDays(d, count * 7)
  return addMonths(d, count)
}

/**
 * Materialise the visit dates for a series. Supports any interval (count + unit)
 * and three end modes: end_date, end after N visits, or open-ended (rolling horizon).
 */
export function generateOccurrences(
  startISO: string,
  unit: RecurUnit,
  count: number,
  endDate: string | null,
  endCount: number | null,
): string[] {
  const start = parseISO(startISO)
  const cap = endCount && endCount > 0
    ? Math.min(endCount, HARD_CAP)
    : endDate ? HARD_CAP : OPEN_ENDED_HORIZON
  const dates: string[] = []
  let d = start
  for (let i = 0; i < cap; i++) {
    const iso = format(d, 'yyyy-MM-dd')
    if (endDate && iso > endDate) break
    dates.push(iso)
    d = stepUnit(d, unit, Math.max(1, count))
  }
  return dates
}

/** Human label for a cadence, e.g. "Weekly", "Every 3 weeks", "Every 10 days". */
export function recurrenceLabel(unit: RecurUnit | null, count: number | null, freq?: string | null): string {
  if (!unit || !count) {
    if (freq === 'weekly') return 'Weekly'
    if (freq === 'biweekly') return 'Every 2 weeks'
    if (freq === 'monthly') return 'Monthly'
    return 'Recurring'
  }
  if (unit === 'week' && count === 1) return 'Weekly'
  if (unit === 'week' && count === 2) return 'Every 2 weeks'
  if (unit === 'month' && count === 1) return 'Monthly'
  return count === 1 ? `Every ${unit}` : `Every ${count} ${unit}s`
}

/** Short customer-facing status, e.g. "Weekly Customer", "Custom Schedule". */
export function recurringCustomerLabel(unit: RecurUnit | null, count: number | null, freq?: string | null): string {
  const l = recurrenceLabel(unit, count, freq)
  if (l === 'Weekly') return 'Weekly Customer'
  if (l === 'Every 2 weeks') return 'Bi-Weekly Customer'
  if (l === 'Monthly') return 'Monthly Customer'
  return 'Custom Schedule'
}

/**
 * The jobs an Apple-style scope touches, relative to an anchor visit.
 * `this` → just the anchor; `future` → anchor + later visits; `all` → every visit.
 */
export function jobsInScope(anchor: Job, allJobs: Job[], scope: RecurrenceScope): Job[] {
  if (!anchor.recurrence_id || scope === 'this') return [anchor]
  const series = allJobs.filter(j => j.recurrence_id === anchor.recurrence_id)
  if (scope === 'all') return series
  return series.filter(j => j.scheduled_date >= anchor.scheduled_date)
}

/** Shift a date string by a number of days, returning yyyy-MM-dd. */
export function shiftDate(iso: string, deltaDays: number): string {
  return format(addDays(parseISO(iso), deltaDays), 'yyyy-MM-dd')
}

export function dayDelta(fromISO: string, toISO: string): number {
  return differenceInCalendarDays(parseISO(toISO), parseISO(fromISO))
}
