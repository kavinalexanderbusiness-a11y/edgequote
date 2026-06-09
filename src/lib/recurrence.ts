import { addDays, addMonths, format, parseISO, differenceInCalendarDays } from 'date-fns'
import type { Job, RecurFreq, RecurrenceScope } from '@/types'

// Safety caps so an open-ended series never materialises unbounded rows.
const MAX_OCCURRENCES = 104          // ~2 years weekly with an end date
const OPEN_ENDED_HORIZON = 26        // visits to pre-create when "never ends"

function step(d: Date, freq: RecurFreq): Date {
  if (freq === 'weekly') return addDays(d, 7)
  if (freq === 'biweekly') return addDays(d, 14)
  return addMonths(d, 1)
}

/**
 * Materialise the visit dates for a series. `startISO`/`endISO` are yyyy-MM-dd.
 * Open-ended series (endISO null) generate a rolling horizon of visits.
 */
export function generateOccurrenceDates(startISO: string, freq: RecurFreq, endISO: string | null): string[] {
  const start = parseISO(startISO)
  const cap = endISO ? MAX_OCCURRENCES : OPEN_ENDED_HORIZON
  const dates: string[] = []
  let d = start
  for (let i = 0; i < cap; i++) {
    const iso = format(d, 'yyyy-MM-dd')
    if (endISO && iso > endISO) break
    dates.push(iso)
    d = step(d, freq)
  }
  return dates
}

/**
 * The jobs an Apple-style scope touches, relative to an anchor visit.
 * `this` → just the anchor; `future` → anchor + later visits in the series;
 * `all` → every visit in the series.
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
