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
  // Owner-facing name ("Pool season", "Pest season"). Optional; the two built-in
  // seasons don't need one. Present on any season an owner defines.
  label?: string
  // The keywords that map a service TYPE to this season. This is how a non-lawn
  // trade declares its own seasonality with NO industry picker and NO code change:
  // a pool company adds a season whose match is ['pool','open','clos'] and its
  // "Pool Opening"/"Pool Closing" services become seasonal. Absent on the stored
  // built-in seasons (they fall back to the hardcoded hints below), so every
  // existing lawn install behaves identically.
  match?: string[]
}

// A keyed map of the business's seasons. `lawn` and `snow` are the built-in two and
// stay concrete so all existing consumers (settings editor, cross-sell, JobForm
// labels) keep compiling and behaving exactly as before. The index signature is
// what lets an owner add more — "pool", "pest", "holiday-lights" — without a schema
// change, an enum, or the app ever asking "what industry are you?".
export interface ServiceSeasons {
  lawn: ServiceSeason
  snow: ServiceSeason
  [key: string]: ServiceSeason
}

// Service-type → category. Substring match so "Weekly Mowing", "Bi-Weekly
// Mowing", "Monthly Lawn Care", "Fertilization" all read as lawn; "Snow
// Removal/Blowing/Clearing" as snow. Anything else is year-round (no season).
// Exported so the Settings editor can WARN when a custom season's keyword collides
// with a built-in hint — custom seasons resolve first (deliberately: the owner's
// word beats ours), which means adding 'trim' to a Tree season silently moves
// "Hedge Trimming" off the lawn season. That priority is right; it being invisible
// is not. The UI's only defence is knowing these words.
export const LAWN_HINTS = ['mow', 'lawn', 'fertiliz', 'fertilis', 'grass', 'aerat', 'trim', 'edge']
export const SNOW_HINTS = ['snow', 'ice', 'plow', 'plough', 'salt', 'shovel']

// Calgary defaults. lawn/snow resolve through the built-in hint lists (below), not
// through `match`, so their exact priority is preserved — `label` is only for display.
export const DEFAULT_LAWN_SEASON: ServiceSeason = { startMonth: 4, startDay: 15, endMonth: 10, endDay: 31, label: 'Lawn' }
export const DEFAULT_SNOW_SEASON: ServiceSeason = { startMonth: 11, startDay: 1, endMonth: 3, endDay: 31, label: 'Snow' }
export const DEFAULT_SEASONS: ServiceSeasons = { lawn: DEFAULT_LAWN_SEASON, snow: DEFAULT_SNOW_SEASON }

export function serviceCategory(serviceType: string | null | undefined): SeasonCategory {
  const s = (serviceType || '').toLowerCase()
  if (SNOW_HINTS.some(h => s.includes(h))) return 'snow'
  if (LAWN_HINTS.some(h => s.includes(h))) return 'lawn'
  return 'year_round'
}

// Resolve the season a service belongs to. THE fix for the one structural blocker:
// this used to consult only the hardcoded lawn/snow hints, so a genuinely seasonal
// non-lawn trade (pool opens in spring, pest ramps in summer) matched nothing, fell
// to year-round with no season end, and the reactivation engine could not tell
// "their season ended" from "we lost them" — every off-season customer read as
// lapsed.
//
// Now an owner-defined `match` list wins first, so any trade can declare its own
// season through the EXISTING service_seasons jsonb. The built-in lawn/snow hints
// remain as the fallback, so a lawn business — including every install whose stored
// seasons predate `match` — resolves exactly as before.
export function seasonForService(serviceType: string | null | undefined, seasons: ServiceSeasons): ServiceSeason | null {
  const s = (serviceType || '').toLowerCase()
  // Owner-defined CUSTOM seasons (any key other than the built-in lawn/snow) win
  // first — this is the new capability. lawn/snow are deliberately excluded here so
  // their exact resolution, INCLUDING snow-before-lawn priority, is left entirely to
  // the untouched hint logic below. That's what guarantees a lawn business behaves
  // byte-for-byte as before.
  if (s) {
    // Keys are SORTED before iterating. Object.keys order is insertion order in
    // memory but Postgres jsonb canonicalises key order on save (length, then
    // bytewise) — so without sorting, which season wins an overlapping keyword
    // could FLIP between "before save" and "after reload" with no edit by the
    // owner. Sorting makes resolution identical everywhere, always.
    for (const key of Object.keys(seasons).sort()) {
      if (key === 'lawn' || key === 'snow') continue
      const season = seasons[key]
      if (season?.match?.some(m => m && s.includes(m.toLowerCase()))) return season
    }
  }
  const cat = serviceCategory(serviceType)
  if (cat === 'lawn') return seasons.lawn
  if (cat === 'snow') return seasons.snow
  return null
}

function pad(n: number): string { return String(n).padStart(2, '0') }

// Clamp a stored day to a real day of that month IN THAT YEAR. The editor caps
// days at 31 without month awareness, so "Feb 30" (or Feb 29 crossing into a
// non-leap year, or Sep 31) can reach the store — and this function used to pad
// it straight into an invalid date string ('2027-02-30') that crashes formatDate
// at render and is rejected by the recurrence insert. A season ending "Feb 30"
// can only ever mean its last real day.
function clampDay(year: number, month: number, day: number): number {
  return Math.min(day, new Date(year, month, 0).getDate())
}

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
    return `${year}-${pad(season.endMonth)}-${pad(clampDay(year, season.endMonth, season.endDay))}`
  }
  // Wrapping season (snow): Nov–Dec start → end next year; Jan–Mar start → end this year.
  const startSegmentIsTail = startMD >= season.startMonth * 100 + season.startDay
  const year = startSegmentIsTail ? startYear + 1 : startYear
  return `${year}-${pad(season.endMonth)}-${pad(clampDay(year, season.endMonth, season.endDay))}`
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
// object keyed by season — { lawn, snow, …any owner-defined seasons }. Tolerant of
// partial/missing data.
//
// It used to hardcode only lawn/snow, which meant an owner-defined "pool" season in
// the jsonb was silently DROPPED on read — the engine could resolve a custom season
// but never saw one. This carries every valid season key through, while guaranteeing
// lawn/snow are always present (so the concrete consumers never hit undefined).
export function settingsToSeasons(raw: unknown): ServiceSeasons {
  if (!raw || typeof raw !== 'object') return DEFAULT_SEASONS
  const r = raw as Record<string, unknown>
  const valid = (s: unknown): s is ServiceSeason =>
    !!s && typeof s === 'object'
    && typeof (s as ServiceSeason).startMonth === 'number'
    && typeof (s as ServiceSeason).endMonth === 'number'
  const out: ServiceSeasons = {
    lawn: valid(r.lawn) ? r.lawn : DEFAULT_LAWN_SEASON,
    snow: valid(r.snow) ? r.snow : DEFAULT_SNOW_SEASON,
  }
  for (const key of Object.keys(r)) {
    if (key === 'lawn' || key === 'snow') continue
    if (valid(r[key])) out[key] = r[key]
  }
  return out
}
