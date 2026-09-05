import { format, isValid, parseISO } from 'date-fns'

/** Accept a real calendar date from a schedule link, never an Invalid Date. */
export function parseScheduleDate(value: string | null | undefined): Date | null {
  if (!value || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null
  const date = parseISO(value + 'T00:00:00')
  return isValid(date) && format(date, 'yyyy-MM-dd') === value ? date : null
}
