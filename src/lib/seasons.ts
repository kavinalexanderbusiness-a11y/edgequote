// ── Service seasons engine ────────────────────────────────────────────────────
// The ONE place seasonal logic lives. Recurring lawn/snow services are seasonal
// in reality — a weekly mow runs Apr–Oct, snow runs Nov–Mar. This module maps a
// service type to its season, computes the season's end date for a given start,
// estimates the visit count, and tells the reactivation engine when a series
// ended NATURALLY (season over) vs. was lost.
//
// Seasons are stored as month/day anchors (not full dates) so they recur every
// year. A season can wrap the new year (snow: Nov 1 → Mar 31).

import { addDays, parseISO, format } from 'date-fns'
import { monthShort } from '@/lib/preferences'
import type { RecurUnit } from '@/types'

export type SeasonCategory = 'lawn' | 'snow' | 'year_round'

// A season as recurring month/day anchors. start may be after end on the
// calendar (wraps the year) — handled by every consumer below.
export interface ServiceSeason {
  startMonth: number // 1-12
  startDay: number   // 1-31
  endMonth: number
  endDay: number
}

export interface ServiceSeasons {
  lawn: ServiceSeason
  snow: ServiceSeason
}

// Calgary defaults.
export const DEFAULT_LAWN_SEASON: ServiceSeason = { startMonth: 4, startDay: 15, endMonth: 10, endDay: 31 }
export const DEFAULT_SNOW_SEASON: ServiceSeason = { startMonth: 11, startDay: 1, endMonth: 3, endDay: 31 }
export const DEFAULT_SEASONS: ServiceSeasons = { lawn: DEFAULT_LAWN_SEASON, snow: DEFAULT_SNOW_SEASON }

// Service-type → category. Substring match so "Weekly Mowing", "Bi-Weekly
// Mowing", "Monthly Lawn Care", "Fertilization" all read as lawn; "Snow
// Removal/Blowing/Clearing" as snow. Anything else is year-round (no season).
const LAWN_HINTS = ['mow', 'lawn', 'fertiliz', 'fertilis', 'grass', 'aerat', 'trim', 'edge']
const SNOW_HINTS = ['snow', 'ice', 'plow', 'plough', 'salt', 'shovel']

export function serviceCategory(serviceType: string | null | undefined): SeasonCategory {
  const s = (serviceType || '').toLowerCase()
  if (SNOW_HINTS.some(h => s.includes(h))) return 'snow'
  if (LAWN_HINTS.some(h => s.includes(h))) return 'lawn'
  return 'year_round'
}

export function seasonForService(serviceType: string | null | undefined, seasons: ServiceSeasons): ServiceSeason | null {
  const cat = serviceCategory(serviceType)
  if (cat === 'lawn') return seasons.lawn
  if (cat === 'snow') return seasons.snow
  return null
}

function pad(n: number): string { return String(n).padStart(2, '0') }

// Does this season wrap the calendar year (start month/day after end)?
function wraps(s: ServiceSeason): boolean {
  return s.startMonth > s.endMonth || (s.startMonth === s.endMonth && s.startDay > s.endDay)
}

// The season-end DATE (yyyy-MM-dd) for a series that starts on startISO.
// For a wrapping season (snow), the end is in the FOLLOWING year when the start
// falls in the season's first calendar segment (Nov/Dec).
export function seasonEndDateFor(startISO: string, season: ServiceSeason): string {
  const start = parseISO(startISO)
  const startYear = start.getFullYear()
  const startMD = (start.getMonth() + 1) * 100 + start.getDate()
  const endMD = season.endMonth * 100 + season.endDay

  if (!wraps(season)) {
    // Same-year season (lawn). If we start after this year's end, the relevant
    // end is next year's (e.g. measuring in November for next spring).
    const year = startMD > endMD ? startYear + 1 : startYear
    return `${year}-${pad(season.endMonth)}-${pad(season.endDay)}`
  }
  // Wrapping season (snow): Nov–Dec start → end next year; Jan–Mar start → end this year.
  const startSegmentIsTail = startMD >= season.startMonth * 100 + season.startDay
  const year = startSegmentIsTail ? startYear + 1 : startYear
  return `${year}-${pad(season.endMonth)}-${pad(season.endDay)}`
}

// Is dateISO within the season that contains/follows it? Used to detect whether
// a customer's NEXT season has arrived (for reactivation). Returns the active or
// upcoming-window check relative to a reference date.
export function isWithinSeason(dateISO: string, season: ServiceSeason): boolean {
  const d = parseISO(dateISO)
  const md = (d.getMonth() + 1) * 100 + d.getDate()
  const startMD = season.startMonth * 100 + season.startDay
  const endMD = season.endMonth * 100 + season.endDay
  if (!wraps(season)) return md >= startMD && md <= endMD
  // Wrapping: in-season if on/after start OR on/before end.
  return md >= startMD || md <= endMD
}

// Estimate visits between startISO and endISO for an interval (count + unit).
// Reuses the same stepping the recurrence engine uses (day/week/month).
export function estimateSeasonVisits(startISO: string, endISO: string, unit: RecurUnit, count: number): number {
  if (endISO < startISO) return 0
  const stepDays = unit === 'day' ? Math.max(1, count) : unit === 'week' ? 7 * Math.max(1, count) : 30 * Math.max(1, count)
  let d = parseISO(startISO)
  const end = parseISO(endISO)
  let n = 0
  // Cap iterations defensively.
  for (let i = 0; i < 400; i++) {
    if (format(d, 'yyyy-MM-dd') > endISO) break
    n++
    d = addDays(d, stepDays)
    if (d > end) break
  }
  return n
}

// Human label like "Apr 15 → Oct 31".
export function seasonLabel(s: ServiceSeason): string {
  return `${monthShort(s.startMonth - 1)} ${s.startDay} → ${monthShort(s.endMonth - 1)} ${s.endDay}`
}

// Read seasons off business_settings, falling back to defaults. Stored as a JSON
// object { lawn, snow }; tolerant of partial/missing data.
export function settingsToSeasons(raw: unknown): ServiceSeasons {
  if (!raw || typeof raw !== 'object') return DEFAULT_SEASONS
  const r = raw as Partial<ServiceSeasons>
  const valid = (s: unknown): s is ServiceSeason =>
    !!s && typeof s === 'object'
    && typeof (s as ServiceSeason).startMonth === 'number'
    && typeof (s as ServiceSeason).endMonth === 'number'
  return {
    lawn: valid(r.lawn) ? r.lawn : DEFAULT_LAWN_SEASON,
    snow: valid(r.snow) ? r.snow : DEFAULT_SNOW_SEASON,
  }
}
