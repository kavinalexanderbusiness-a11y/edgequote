import { addDaysISO, dayLabel, dayRole, formatMonthDay, weekdayShort, type DayRole } from '@/lib/tenantTime'

// ── Weather, told truthfully ─────────────────────────────────────────────────
//
// Pure and I/O-free. Two jobs, both of which the Weather page was doing wrongly
// and doing itself:
//
//   1. LABELLING A DAY. Exactly one card may say "Today", and it must be the
//      business's today.
//   2. EXPLAINING A RECOMMENDATION. When the forecast visibly shows a dry day
//      and the app does not suggest it, the owner is owed the reason.
//
// ── 1 · THE DUPLICATE "TODAY", AND HOW IT HAPPENED ───────────────────────────
// The page rendered its first card with a HARD-CODED label:
//
//     {r.today && <WeatherCard f={r.today} label="Today" />}
//     {r.tomorrow && <WeatherCard f={r.tomorrow} label={dayLabel(r.tomorrow.date, today)} />}
//
// …where `r.today` came from the impact engine (which used the DEVICE's local
// date) and `today` came from the page (which used `new Date().toISOString()` —
// UTC). Those two disagree for the whole evening in any zone west of Greenwich.
// From ~17:00 in Alberta:
//
//     card 1  holds the 28th, labelled "Today" because the label is a constant
//     card 2  holds the 29th, and dayLabel(29th, UTC-today = 29th) → "Today"
//
// TWO CARDS, BOTH SAYING TODAY, SHOWING DIFFERENT DAYS. And the hourly strip
// marked "Now" by the same UTC comparison, so "Now" sat on tomorrow.
//
// ⭐ The fix is structural, not a patched comparison: NOTHING may pass a label
// in. Every card asks `forecastDayLabel` for its own words, from the one tenant
// date — so "Today" can attach to exactly one date by construction, and a
// second card claiming it is not expressible.

export interface ForecastDayLabel {
  role: DayRole
  /** The headline word: "Today", "Tomorrow", or a weekday. */
  label: string
  /** The actual calendar date, always. Never null, never implied. */
  dated: string
  /** For the compact hourly/strip row, where only a few characters fit. */
  short: string
}

/**
 * THE label for one forecast day.
 *
 * ⭐ `dated` is not optional and has no "hide the date" mode. A card three days
 * out reading only "Fri" makes the owner count on their fingers, and next Friday
 * renders identically to this one — which is precisely the kind of quiet
 * ambiguity that lets someone move a job to the wrong week.
 */
export function forecastDayLabel(iso: string, todayISO: string): ForecastDayLabel {
  const role = dayRole(iso, todayISO)
  return {
    role,
    label: role === 'today' ? 'Today' : role === 'tomorrow' ? 'Tomorrow' : weekdayShort(iso),
    dated: formatMonthDay(iso),
    // ⛔ "Now" is deliberately NOT a label this returns. "Now" is a statement
    // about an instant inside today; using it for a DAY is what let it drift
    // onto tomorrow. The hourly strip marks the current hour; the day strip says
    // "Today".
    short: role === 'today' ? 'Today' : weekdayShort(iso),
  }
}

/** Full label with the date attached — "Today · Aug 28", "Fri Sep 4". */
export function forecastDayFullLabel(iso: string, todayISO: string): string {
  return dayLabel(iso, todayISO, { withDate: true })
}

/**
 * ⭐⭐ THE INVARIANT, checkable. Given the days a screen is about to render,
 * how many of them would claim to be today?
 *
 * The guard asserts this is never more than one against a deliberately
 * mismatched pair of clocks — the exact condition that produced the live bug.
 */
export function countTodayLabels(dates: string[], todayISO: string): number {
  return dates.filter(d => forecastDayLabel(d, todayISO).role === 'today').length
}

// ── 2 · WHY A DRY DAY WAS NOT RECOMMENDED ────────────────────────────────────
//
// `findDryDay` walked the forecast and skipped days for five different reasons,
// then returned a single date or null. The owner saw "Best move: Thu Sep 3" —
// or nothing at all — while looking at a forecast strip showing a perfectly
// sunny Saturday. Nothing on the screen explained the contradiction, and the
// most common cause was not weather at all: Saturday simply is not one of their
// working days.
//
// ⛔ "No dry work day in range" was the only explanation offered, and it is a
// claim about the FORECAST. When the real reason is the owner's own work-day
// settings or their capacity, that sentence is false.

export type DryDayRejection =
  /** Earlier than (or the same day as) the rained-out day being moved. */
  | 'not_after'
  /** Rain — the only reason that is actually about weather. */
  | 'rainy'
  /** Not one of the business's working days (business_settings.preferred_work_days). */
  | 'not_a_work_day'
  /** The owner marked the day unavailable (vacation, holiday, no crew…). */
  | 'day_blocked'
  /** Dry and open, but the day is already full. */
  | 'over_capacity'

export interface DryDayEvaluation {
  date: string
  /** Null when the day was accepted. */
  rejection: DryDayRejection | null
  /** Extra colour for the reasons that have some — the block's own label, the hours. */
  detail?: string
}

export interface DryDaySearch {
  /** The day to move to, or null when nothing qualified. */
  chosen: string | null
  /** True when `chosen` is dry and open but already over capacity. */
  chosenOverbooks: boolean
  /** Every day considered, in order, with the reason it was passed over. */
  evaluations: DryDayEvaluation[]
}

const REJECTION_TEXT: Record<DryDayRejection, string> = {
  not_after: 'before the day being moved',
  rainy: 'rain forecast',
  not_a_work_day: 'not one of your working days',
  day_blocked: 'you marked this day unavailable',
  over_capacity: 'already full',
}

/** One rejected day, in the owner's words: "Sat Sep 5 — not one of your working days". */
export function rejectionLine(e: DryDayEvaluation, todayISO: string): string {
  const when = forecastDayFullLabel(e.date, todayISO)
  const why = e.rejection ? REJECTION_TEXT[e.rejection] : 'available'
  return e.detail ? `${when} — ${why} (${e.detail})` : `${when} — ${why}`
}

/**
 * The rejections worth SHOWING, and the order to show them in.
 *
 * ⭐ `not_after` is filtered out on purpose: "Monday was rejected because it is
 * before Tuesday" is noise, not an explanation, and burying the two reasons the
 * owner can actually act on under a list of them is how an explanation stops
 * being read.
 *
 * ⭐ And the order is by USEFULNESS, not by date. "Not one of your working days"
 * and "already full" are settings the owner can change in seconds; rain is not.
 */
export function explainableRejections(s: DryDaySearch): DryDayEvaluation[] {
  const rank: Record<DryDayRejection, number> = {
    not_a_work_day: 0, over_capacity: 1, day_blocked: 2, rainy: 3, not_after: 9,
  }
  return s.evaluations
    .filter(e => e.rejection && e.rejection !== 'not_after')
    .sort((a, b) => (rank[a.rejection!] - rank[b.rejection!]) || a.date.localeCompare(b.date))
}

/**
 * ⭐⭐ THE CONTRADICTION TEST. Is there a day the owner can SEE is dry on the
 * forecast strip, that we did not recommend?
 *
 * If yes, the screen owes them the reason — that is the whole contract this
 * function encodes. It returns the dry-but-rejected days specifically, because
 * a rainy rejection contradicts nothing: the strip already shows the rain.
 */
export function visiblyDryButRejected(s: DryDaySearch): DryDayEvaluation[] {
  return s.evaluations.filter(e =>
    e.rejection && e.rejection !== 'rainy' && e.rejection !== 'not_after')
}

export interface DryDayInput {
  /** Forecast days in date order. */
  days: { date: string; rainy: boolean }[]
  /** Move work that currently sits on this date. Only later days qualify. */
  afterDate: string
  /** Hours the moved work needs. */
  neededHours: number
  /** Hours already committed per date. */
  hoursByDate: Record<string, number>
  /** The business's daily capacity in hours. */
  capacityHours: number
  /** Working days as 0–6 (Sun–Sat). Null = every day is a working day. */
  preferredDays: Set<number> | null
  /** Dates the owner marked unavailable. */
  blockedDates: Set<string>
}

/**
 * Find the day to move rained-out work to, AND record why every other day was
 * passed over.
 *
 * Behaviourally identical to the search it replaces — same order, same
 * preferences, same fallback to "soonest dry day even though it overbooks". The
 * only change is that it now remembers, rather than discards, the reasons.
 */
export function findDryDay(input: DryDayInput): DryDaySearch {
  const { days, afterDate, neededHours, hoursByDate, capacityHours, preferredDays, blockedDates } = input
  const evaluations: DryDayEvaluation[] = []
  let firstDry: string | null = null
  let chosen: string | null = null

  for (const f of days) {
    if (f.date <= afterDate) { evaluations.push({ date: f.date, rejection: 'not_after' }); continue }
    if (preferredDays && !preferredDays.has(dowOf(f.date))) {
      evaluations.push({ date: f.date, rejection: 'not_a_work_day' }); continue
    }
    if (blockedDates.has(f.date)) {
      evaluations.push({ date: f.date, rejection: 'day_blocked' }); continue
    }
    if (f.rainy) { evaluations.push({ date: f.date, rejection: 'rainy' }); continue }
    if (firstDry == null) firstDry = f.date
    const projected = (hoursByDate[f.date] || 0) + neededHours
    if (projected <= capacityHours) {
      evaluations.push({ date: f.date, rejection: null })
      chosen = f.date
      break
    }
    evaluations.push({
      date: f.date, rejection: 'over_capacity',
      detail: `${round1(projected)}h of ${round1(capacityHours)}h`,
    })
  }

  // Nothing had room — fall back to the soonest dry day and SAY it overbooks,
  // exactly as before. Silently returning it as "best move" was the old
  // behaviour's one honest edge, and it is kept.
  if (chosen == null && firstDry != null) {
    return { chosen: firstDry, chosenOverbooks: true, evaluations }
  }
  return { chosen, chosenOverbooks: false, evaluations }
}

function dowOf(iso: string): number {
  const [y, m, d] = iso.split('-').map(Number)
  return new Date(Date.UTC(y, (m || 1) - 1, d || 1)).getUTCDay()
}
const round1 = (n: number) => Math.round(n * 10) / 10

/** The horizon a forecast covers, from the tenant's today. */
export function forecastHorizon(todayISO: string, days = 8): string {
  return addDaysISO(todayISO, days)
}
