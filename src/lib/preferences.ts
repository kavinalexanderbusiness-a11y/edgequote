// ── Per-customer / per-property scheduling preferences ────────────────────────
// The ONE place a customer's real scheduling commitments are modelled and read,
// so manual scheduling, the optimizer and the weekly scheduler all honour the
// same promises ("Mrs. Lee is always Friday mornings", "never the Patels on
// Sunday"). Preferences live at two levels: a customer-wide default and an
// optional per-property override. resolvePrefs() merges them PER FIELD — a
// property only overrides the fields it actually sets, inheriting the rest.

import { getDay, parseISO } from 'date-fns'
import { timeToMinutes } from '@/lib/route'

export interface SchedulePrefs {
  preferredDays: number[]    // getDay indices (0=Sun … 6=Sat); empty = no preference
  avoidDays: number[]        // weekday indices the customer should not be booked on
  timeStart: string | null   // 'HH:mm' — earliest preferred start (null = any)
  timeEnd: string | null     // 'HH:mm' — latest preferred start (null = any)
}

// The raw, nullable columns as stored on a customer or property row.
export interface PrefSource {
  preferred_days?: number[] | null
  avoid_days?: number[] | null
  pref_time_start?: string | null
  pref_time_end?: string | null
}

export const EMPTY_PREFS: SchedulePrefs = { preferredDays: [], avoidDays: [], timeStart: null, timeEnd: null }

const WEEKDAY_SHORT = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
const WEEKDAY_LONG = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']
const MONTH_SHORT = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

export function weekdayShort(idx: number): string { return WEEKDAY_SHORT[((idx % 7) + 7) % 7] }
export function weekdayLong(idx: number): string { return WEEKDAY_LONG[((idx % 7) + 7) % 7] }
// 0-indexed (0=Jan … 11=Dec) — pass `month - 1` when coming from a 1-based date part.
export function monthShort(idx: number): string { return MONTH_SHORT[((idx % 12) + 12) % 12] }

const cleanDays = (v: number[] | null | undefined): number[] =>
  Array.isArray(v) ? v.filter(n => Number.isInteger(n) && n >= 0 && n <= 6) : []
const cleanTime = (v: string | null | undefined): string | null => (v && /^\d{1,2}:\d{2}/.test(v) ? v : null)

// Does this source carry any preference at all? (Used to skip empty rows.)
export function hasAnyPref(p: PrefSource | null | undefined): boolean {
  if (!p) return false
  return cleanDays(p.preferred_days).length > 0 || cleanDays(p.avoid_days).length > 0
    || !!cleanTime(p.pref_time_start) || !!cleanTime(p.pref_time_end)
}

// Merge customer default + property override, PER FIELD. A property field that is
// set (non-empty days / non-null time) wins; otherwise the customer default flows
// through. So "property override" never erases an unrelated customer-level field.
export function resolvePrefs(customer?: PrefSource | null, property?: PrefSource | null): SchedulePrefs {
  const cPref = cleanDays(customer?.preferred_days)
  const cAvoid = cleanDays(customer?.avoid_days)
  const cStart = cleanTime(customer?.pref_time_start)
  const cEnd = cleanTime(customer?.pref_time_end)
  const pPref = cleanDays(property?.preferred_days)
  const pAvoid = cleanDays(property?.avoid_days)
  const pStart = cleanTime(property?.pref_time_start)
  const pEnd = cleanTime(property?.pref_time_end)
  return {
    preferredDays: pPref.length ? pPref : cPref,
    avoidDays: pAvoid.length ? pAvoid : cAvoid,
    timeStart: pStart ?? cStart,
    timeEnd: pEnd ?? cEnd,
  }
}

export function prefsAreEmpty(p: SchedulePrefs): boolean {
  return p.preferredDays.length === 0 && p.avoidDays.length === 0 && !p.timeStart && !p.timeEnd
}

// Soft, owner-facing warnings for placing a visit on `dateISO` at optional
// `startTime`. Never blocks — these surface as gentle "are you sure?" notes next
// to the cadence guard. Avoid-day is the strongest signal (an explicit promise);
// preferred-day fires only when a preferred set exists and this day isn't in it.
export function prefWarnings(prefs: SchedulePrefs, dateISO: string, startTime?: string | null, customerName?: string | null): string[] {
  if (prefsAreEmpty(prefs)) return []
  const who = customerName?.trim() || 'This customer'
  const dow = getDay(parseISO(dateISO + 'T00:00:00'))
  const out: string[] = []

  if (prefs.avoidDays.includes(dow)) {
    out.push(`${who} asked not to be scheduled on ${weekdayLong(dow)}s.`)
  } else if (prefs.preferredDays.length && !prefs.preferredDays.includes(dow)) {
    const days = prefs.preferredDays.map(weekdayShort).join('/')
    out.push(`${who} usually prefers ${days} — this is a ${weekdayLong(dow)}.`)
  }

  if (startTime && (prefs.timeStart || prefs.timeEnd)) {
    const t = timeToMinutes(startTime)
    const lo = prefs.timeStart ? timeToMinutes(prefs.timeStart) : null
    const hi = prefs.timeEnd ? timeToMinutes(prefs.timeEnd) : null
    if ((lo != null && t < lo) || (hi != null && t > hi)) {
      const window = prefs.timeStart && prefs.timeEnd ? `${prefs.timeStart}–${prefs.timeEnd}`
        : prefs.timeStart ? `after ${prefs.timeStart}` : `before ${prefs.timeEnd}`
      out.push(`${who} prefers a ${window} start time.`)
    }
  }
  return out
}

// A one-line summary of a prefs set for compact display (chips, hints).
export function prefSummary(p: SchedulePrefs): string | null {
  if (prefsAreEmpty(p)) return null
  const parts: string[] = []
  if (p.preferredDays.length) parts.push(`Prefers ${p.preferredDays.map(weekdayShort).join('/')}`)
  if (p.avoidDays.length) parts.push(`Avoid ${p.avoidDays.map(weekdayShort).join('/')}`)
  if (p.timeStart || p.timeEnd) {
    parts.push(p.timeStart && p.timeEnd ? `${p.timeStart}–${p.timeEnd}` : p.timeStart ? `after ${p.timeStart}` : `before ${p.timeEnd}`)
  }
  return parts.join(' · ')
}
