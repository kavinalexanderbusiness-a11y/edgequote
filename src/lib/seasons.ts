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

// Calgary defaults. lawn/snow resolve through the built-in hint lists (below), not
// through `match`, so their exact priority is preserved — `label` is only for display.
export const DEFAULT_LAWN_SEASON: ServiceSeason = { startMonth: 4, startDay: 15, endMonth: 10, endDay: 31, label: 'Lawn' }
export const DEFAULT_SNOW_SEASON: ServiceSeason = { startMonth: 11, startDay: 1, endMonth: 3, endDay: 31, label: 'Snow' }
export const DEFAULT_SEASONS: ServiceSeasons = { lawn: DEFAULT_LAWN_SEASON, snow: DEFAULT_SNOW_SEASON }

// ── The season a SERIES belongs to — declared, not guessed ───────────────────
// Session 110, after a production audit found recurring visits scheduled through
// winter under a configured season.
//
// ⭐⭐ THE DEFECT WAS THE INPUT, NOT THE ARITHMETIC. Every function below this
// point is correct. What was wrong is that the only way to ask "which season
// governs this series?" was `seasonForService(NAME, seasons)` — a keyword guess
// over the service's NAME. Measured on production 2026-08-29:
//
//   14 series named "…Mowing" / "Lawn Mowing"  → matched 'mow'/'lawn' → lawn
//                                                season, end_date 2026-10-31 ✅
//    1 series named "Bi-weekly"                → matched NOTHING → no season,
//                                                no end_date, 24 future visits
//                                                generated through to 2027-07-31
//    1 series named "General Upkeep"           → matched NOTHING → no season
//
// Identical cadence, identical intent, opposite outcome — decided entirely by
// what the owner happened to type. That is the bug: governance was accidental.
//
// ⛔ A NAME IS NOT A RELATIONSHIP. Renaming a service must never change when it
// runs, and a business whose vocabulary we did not anticipate must not silently
// lose its season. So a series DECLARES its season, and this resolver reads that
// declaration.

/**
 * The season key meaning "this series is deliberately year-round".
 *
 * ⭐ Distinct from NULL, and the distinction is the whole point: NULL means
 * NOBODY HAS SAID YET (a legacy row awaiting backfill), `'none'` means the owner
 * looked at it and said no season applies. Collapsing them would make "not yet
 * migrated" indistinguishable from "deliberately runs all year", and the only
 * safe treatment of the first is the unsafe treatment of the second.
 */
export const SEASON_NONE = 'none'

/** What a series says about its own season. `seasonKey` is the declaration. */
export interface SeriesSeasonInput {
  /** A key in business_settings.service_seasons, SEASON_NONE, or null/undefined
   *  when the series predates the declaration and has not been backfilled. */
  seasonKey?: string | null
}

export interface SeasonResolution {
  season: ServiceSeason | null
  /** How the answer was reached — so a surface can tell the owner, and so the
   *  guard can prove a declaration was not quietly overridden by a guess. */
  source: 'declared' | 'declared-none' | 'unknown'
  /** The key that was declared, when one was. */
  key: string | null
}

/**
 * THE resolver. A series' season, from its DECLARATION.
 *
 * Order, and it is short because there is nothing to weigh:
 *   1. a  naming a configured season → that season
 *   2. SEASON_NONE                              → no season, ON PURPOSE
 *   3. anything else (including no key at all)  → unknown
 *
 * ⛔⛔ THERE IS NO FOURTH BRANCH. No service name is read, so no rename can
 * move a season and no unanticipated vocabulary can silently lose one. An
 * undeclared series answers , which the UI MUST surface as "Needs
 * selection" rather than quietly treating as year-round.
 */
export function resolveSeriesSeason(
  input: SeriesSeasonInput,
  seasons: ServiceSeasons,
): SeasonResolution {
  const key = input.seasonKey?.trim() || null
  if (key === SEASON_NONE) return { season: null, source: 'declared-none', key }
  if (key) {
    const declared = seasons[key]
    // ⛔ A key naming a season the business does not have is NOT quietly
    // downgraded to a name guess. The owner said "this one"; answering with a
    // different season inferred from a word in the title would be worse than
    // admitting we cannot resolve it.
    if (declared) return { season: declared, source: 'declared', key }
    return { season: null, source: 'unknown', key }
  }
  // ⛔⛔ NO INFERENCE. There is no branch here that looks at a service name,
  // and that absence IS the repair. An undeclared series resolves to 'unknown'
  // — which the UI must surface as "Needs selection", never quietly treat as
  // year-round. The keyword guess lives in lib/legacySeasonInference and is
  // reachable only from the migration.
  return { season: null, source: 'unknown', key: null }
}

/**
 * Where the season migration currently stands, and whether that is consistent.
 *
 * ⭐⭐ PURE, AND IN src/ ON PURPOSE. This rule used to live inside
 * verify:season-recurrence, where it could not be tested — a guard cannot
 * mutation-test its own logic, so the ratchet that stops the transition
 * silently never ending was itself unguarded. Mutation testing found exactly
 * that. It lives here so the guard can drive it over fixtures AND use the same
 * function against the live book.
 *
 * The two failure directions are the whole point:
 *   • every active series declared, flag still false → the transition never
 *     ended and the keyword guess lives on forever;
 *   • series still undeclared, flag already true → flipping early strips the
 *     season from every un-migrated series at once.
 */
export type TransitionVerdict =
  | 'not-started'        // the column does not exist yet; the flag must be false
  | 'in-progress'        // rows remain undeclared; the flag must be false
  | 'complete'           // every active row declared; the flag must be TRUE
  | 'flag-too-early'     // ⛔ flag true while rows are still undeclared
  | 'flag-overdue'       // ⛔ every row declared but the flag is still false

export function seasonTransitionVerdict(input: {
  columnExists: boolean
  undeclaredActive: number
  flag: boolean
}): TransitionVerdict {
  if (!input.columnExists) return input.flag ? 'flag-too-early' : 'not-started'
  if (input.undeclaredActive > 0) return input.flag ? 'flag-too-early' : 'in-progress'
  return input.flag ? 'complete' : 'flag-overdue'
}

/** True for the verdicts that mean something is wrong and must fail a gate. */
export function transitionIsBroken(v: TransitionVerdict): boolean {
  return v === 'flag-too-early' || v === 'flag-overdue'
}

/** The season keys an owner may choose, in a stable order. */
export function seasonKeys(seasons: ServiceSeasons): string[] {
  return Object.keys(seasons).sort()
}

/**
 * Where a series must stop: the earlier of the owner's own end date and the end
 * of the season that governs it.
 *
 * ⭐⭐ THE SEASON BOUND IS EXPRESSED AS AN END DATE, deliberately, because that
 * is the representation Session 39 already established — "Season End has ONE
 * representation: a plain `end_date` on `job_recurrences`". So the recurrence
 * engine STAYS SEASON-UNAWARE: it keeps taking one end date and knows nothing
 * about months. Teaching it seasons would be a second representation of the same
 * fact, and the two would eventually disagree.
 *
 * Wrapping seasons (Nov 1 → Mar 31) and leap years need no special case here —
 * `seasonEndDateFor` already handles both, including clamping Feb 29 into a
 * non-leap year.
 *
 * ⛔ It only ever makes the horizon SHORTER. A season cannot extend a series past
 * the date the owner typed.
 */
export function effectiveSeriesEnd(
  startISO: string,
  endDate: string | null | undefined,
  season: ServiceSeason | null,
): string | null {
  const owner = endDate?.trim() || null
  if (!season) return owner
  const seasonEnd = seasonEndDateFor(startISO, season)
  if (!owner) return seasonEnd
  return seasonEnd < owner ? seasonEnd : owner
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

// The next date this season OPENS, strictly after `afterISO`. The mirror of
// seasonEndDateFor and the anchor the renewal engine asks about: "when would
// their next season begin?" Wrapping seasons need no special case — the start is
// a fixed month/day anchor either way.
//
// Lifted out of lib/suggestions, which had it as a private copy. A second answer
// to "when does the next season start" is exactly the drift this module exists
// to prevent, and the copy already differed: it padded the day straight in
// without clampDay, so a season anchored on a day that month doesn't have
// produced an invalid date string.
export function nextSeasonStartISO(season: ServiceSeason, afterISO: string): string {
  const year = Number(afterISO.slice(0, 4))
  const at = (y: number) => `${y}-${pad(season.startMonth)}-${pad(clampDay(y, season.startMonth, season.startDay))}`
  const thisYear = at(year)
  return thisYear > afterISO ? thisYear : at(year + 1)
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
