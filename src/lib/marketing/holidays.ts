import type { CampaignKind, Season } from './types'

// ── Holidays & seasonal reminders ─────────────────────────────────────────────────
// A deterministic, dependency-free calendar of the marketing-relevant dates for a
// Canadian (Alberta) property-care business, plus the season turn-points that should
// prompt a campaign. Used by the Content Calendar (markers) and the Suggestions engine
// (timely nudges). Pure date math — no AI, no tables.

export interface Holiday {
  date: string          // yyyy-mm-dd
  name: string
  // a marketing angle the owner can act on; maps to a campaign kind when relevant
  marketingAngle: string
  campaignKind: CampaignKind
}

export interface SeasonReminder {
  date: string          // yyyy-mm-dd the season window opens/closes
  season: Season
  edge: 'start' | 'end'
  label: string
  campaignKind: CampaignKind
}

function iso(y: number, m: number, d: number): string {
  return `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`
}

// nth weekday (0=Sun..6=Sat) of a month, e.g. 2nd Monday of October.
function nthWeekday(year: number, month1: number, weekday: number, n: number): string {
  const first = new Date(year, month1 - 1, 1).getDay()
  const offset = (weekday - first + 7) % 7
  const day = 1 + offset + (n - 1) * 7
  return iso(year, month1, day)
}

// last given weekday strictly before a date (used for Victoria Day = Mon before May 25).
function mondayBefore(year: number, month1: number, day: number): string {
  const d = new Date(year, month1 - 1, day)
  const back = (d.getDay() + 6) % 7 || 7 // days to previous Monday (1..7)
  d.setDate(d.getDate() - back)
  return iso(d.getFullYear(), d.getMonth() + 1, d.getDate())
}

// Anonymous-Gregorian Easter (for Good Friday = Easter Sunday − 2).
function goodFriday(year: number): string {
  const a = year % 19, b = Math.floor(year / 100), c = year % 100
  const d = Math.floor(b / 4), e = b % 4, f = Math.floor((b + 8) / 25)
  const g = Math.floor((b - f + 1) / 3), h = (19 * a + b - d - g + 15) % 30
  const i = Math.floor(c / 4), k = c % 4, l = (32 + 2 * e + 2 * i - h - k) % 7
  const m = Math.floor((a + 11 * h + 22 * l) / 451)
  const month = Math.floor((h + l - 7 * m + 114) / 31)
  const day = ((h + l - 7 * m + 114) % 31) + 1
  const easter = new Date(year, month - 1, day)
  easter.setDate(easter.getDate() - 2)
  return iso(easter.getFullYear(), easter.getMonth() + 1, easter.getDate())
}

// All holidays for a single year, in date order.
function holidaysForYear(year: number): Holiday[] {
  const list: Holiday[] = [
    { date: iso(year, 1, 1),  name: 'New Year’s Day',  marketingAngle: 'New season, fresh start — book your spot for the year.', campaignKind: 'custom' },
    { date: iso(year, 2, 14), name: 'Valentine’s Day', marketingAngle: 'Light, warm community greeting.',                          campaignKind: 'holiday' },
    { date: nthWeekday(year, 2, 1, 3), name: 'Family Day', marketingAngle: 'Long weekend — a friendly community hello.',           campaignKind: 'holiday' },
    { date: goodFriday(year), name: 'Good Friday',    marketingAngle: 'Spring is around the corner — get on the schedule.',        campaignKind: 'spring' },
    { date: nthWeekday(year, 5, 0, 2), name: 'Mother’s Day', marketingAngle: 'Yard ready for spring gatherings.',                  campaignKind: 'spring' },
    { date: mondayBefore(year, 5, 25), name: 'Victoria Day', marketingAngle: 'May long weekend — planting & spring cleanup season.', campaignKind: 'spring' },
    { date: nthWeekday(year, 6, 0, 3), name: 'Father’s Day', marketingAngle: 'Summer lawn care is in full swing.',                 campaignKind: 'summer' },
    { date: iso(year, 7, 1),  name: 'Canada Day',     marketingAngle: 'Crisp lawns for Canada Day gatherings.',                    campaignKind: 'summer' },
    { date: nthWeekday(year, 9, 1, 1), name: 'Labour Day', marketingAngle: 'End-of-summer push before fall cleanup.',              campaignKind: 'fall' },
    { date: nthWeekday(year, 10, 1, 2), name: 'Thanksgiving', marketingAngle: 'Fall cleanup before the holiday.',                  campaignKind: 'fall' },
    { date: iso(year, 10, 31), name: 'Halloween',     marketingAngle: 'Leaf cleanup season — tidy yards for trick-or-treaters.',   campaignKind: 'fall' },
    { date: iso(year, 11, 11), name: 'Remembrance Day', marketingAngle: 'A respectful community note.',                            campaignKind: 'holiday' },
    { date: nthWeekday(year, 11, 5, 4), name: 'Black Friday', marketingAngle: 'A seasonal offer on snow removal packages.',        campaignKind: 'winter' },
    { date: iso(year, 12, 25), name: 'Christmas',     marketingAngle: 'Warm holiday greeting + snow-season reminder.',             campaignKind: 'winter' },
  ]
  return list.sort((a, b) => a.date.localeCompare(b.date))
}

// Upcoming holidays within `days` of `fromISO` (spans the year boundary).
export function upcomingHolidays(fromISO: string, days = 60): Holiday[] {
  const from = new Date(fromISO + 'T00:00:00')
  const year = from.getFullYear()
  const all = [...holidaysForYear(year), ...holidaysForYear(year + 1)]
  const horizon = new Date(from); horizon.setDate(horizon.getDate() + days)
  return all.filter(h => {
    const d = new Date(h.date + 'T00:00:00')
    return d >= from && d <= horizon
  })
}

// Season window edges for the year (Calgary defaults; the season engine owns the
// authoritative windows but these are the simple calendar turn-points for nudges).
function seasonRemindersForYear(year: number): SeasonReminder[] {
  return [
    { date: iso(year, 4, 1),  season: 'spring', edge: 'start', label: 'Spring cleanup season is starting', campaignKind: 'spring' },
    { date: iso(year, 6, 1),  season: 'summer', edge: 'start', label: 'Summer lawn-care season is here',    campaignKind: 'summer' },
    { date: iso(year, 9, 1),  season: 'fall',   edge: 'start', label: 'Leaf-cleanup season is starting',    campaignKind: 'fall' },
    { date: iso(year, 10, 31), season: 'fall',  edge: 'end',   label: 'Last call for fall cleanup',         campaignKind: 'fall' },
    { date: iso(year, 11, 1), season: 'winter', edge: 'start', label: 'Snow-removal season is starting',    campaignKind: 'winter' },
  ]
}

export function upcomingSeasonReminders(fromISO: string, days = 30): SeasonReminder[] {
  const from = new Date(fromISO + 'T00:00:00')
  const year = from.getFullYear()
  const all = [...seasonRemindersForYear(year), ...seasonRemindersForYear(year + 1)]
  const horizon = new Date(from); horizon.setDate(horizon.getDate() + days)
  return all.filter(r => {
    const d = new Date(r.date + 'T00:00:00')
    return d >= from && d <= horizon
  }).sort((a, b) => a.date.localeCompare(b.date))
}
