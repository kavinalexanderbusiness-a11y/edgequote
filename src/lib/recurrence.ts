import { addDays, addMonths, format, parseISO, differenceInCalendarDays } from 'date-fns'
import type { Job, JobRecurrence, RecurUnit, RecurrenceScope } from '@/types'
import { ServiceSeasons, seasonForService, seasonEndDateFor, seasonLabel } from '@/lib/seasons'

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

// ── What a recurrence edit is allowed to destroy ──────────────────────────────
// ONE predicate, because every recurrence edit that removes rows — reconciling
// against an end date, regenerating a changed cadence, removing the series
// outright — is asking the same question, and a second definition is how one of
// them ends up laxer than the others.
//
// A visit is CANONICALLY REPLACEABLE only when it is a bare future placeholder:
// something the series itself put on the calendar and can put back. Anything
// that records what happened is not:
//
//   • status other than `scheduled` — completed and in-progress visits are work,
//     cancelled ones are a deliberate record that it was called off.
//   • any `actual_minutes` — time was logged against it (the column is the
//     database-enforced sum of its work sessions).
//   • anything the caller marks protected — invoices, work sessions, crew media,
//     photos, expenses, time entries, change orders, priced extras. Deleting the
//     visit CASCADES those away or orphans them (see lib/seriesHistory).
//   • anything before `todayISO` — a past visit is the book's record of what was
//     planned, not a placeholder for work still to come.
//   • the anchor — the visit the owner is looking at while saving. Removing the
//     row under an open editor is how a save turns into a vanish.
//
// The three groups are reported separately so a caller can say the true thing:
// `preserved` is what was spared INSIDE the window it was reconciling (worth
// naming to the owner), `untouched` is everything outside that window (not news).
export interface SeriesVisitLite {
  id: string
  scheduled_date: string
  status: string
  actual_minutes?: number | null
}

export interface ReplaceWindow {
  anchorId?: string
  protectedIds?: Set<string>
  /** Only visits strictly AFTER this date are in the window (end reconciliation). */
  afterDate?: string
  /** Only visits on or after this date are in the window (never rewrite the past). */
  todayISO?: string
}

export interface SeriesPartition {
  replaceable: SeriesVisitLite[]
  preserved: SeriesVisitLite[]
  untouched: SeriesVisitLite[]
}

export function partitionSeriesVisits(series: SeriesVisitLite[], opts: ReplaceWindow = {}): SeriesPartition {
  const out: SeriesPartition = { replaceable: [], preserved: [], untouched: [] }
  for (const j of series) {
    if (j.id === opts.anchorId) continue
    const inWindow =
      (opts.afterDate === undefined || j.scheduled_date > opts.afterDate) &&
      (opts.todayISO === undefined || j.scheduled_date >= opts.todayISO)
    if (!inWindow) { out.untouched.push(j); continue }
    const bare =
      j.status === 'scheduled' &&
      !(Number(j.actual_minutes) > 0) &&
      !opts.protectedIds?.has(j.id)
    ;(bare ? out.replaceable : out.preserved).push(j)
  }
  return out
}

// ── Series-end reconciliation ─────────────────────────────────────────────────
// The visits that CONTRADICT a series' end date: bare placeholders sitting
// strictly AFTER the end. Strict `>` so a visit ON the end date is the season's
// last legitimate stop, never a ghost. No `todayISO` — a stray visit past an end
// the owner just re-asserted is a ghost whether or not the calendar has reached
// it yet; that is the shape the production incident left behind.
export function visitsBeyondEnd(
  series: SeriesVisitLite[],
  endDate: string | null,
  opts: { anchorId?: string; protectedIds?: Set<string> } = {},
): string[] {
  if (!endDate) return []
  return partitionSeriesVisits(series, { ...opts, afterDate: endDate }).replaceable.map(j => j.id)
}

// ── May this save remove the series at all? ───────────────────────────────────
// "Does not repeat" on a job that HAS a series deletes siblings and the series
// row, so the save must prove the owner ASKED for that. Two independent things
// have to be true, and neither is inferable from the other:
//
//   1. the series was actually loaded — a form that knows nothing about a series
//      has not been told to delete it (mayRemoveRecurrence); and
//   2. the owner touched the Repeat controls during THIS edit session.
//
// (2) is what makes the guard hold even when the form is wrong for a reason
// nobody has thought of yet. A "Does not repeat" the owner never selected is the
// control's DEFAULT, not their instruction — a series that failed to map onto
// the presets, a snapshot that arrived after the initial render and re-seeded
// nothing, a future refactor. Silence is not consent, so an untouched Repeat
// control can change a price or a crew size, but it can never end a schedule.
export type RemovalDecision =
  | { kind: 'remove' }
  | { kind: 'refuse'; reason: 'series-not-loaded' | 'repeat-untouched' }

export function planRecurrenceRemoval(
  recurrenceId: string | null | undefined,
  loaded: Record<string, unknown>,
  repeatAsserted: boolean | undefined,
): RemovalDecision {
  if (!recurrenceId) return { kind: 'remove' } // a one-time job has nothing to lose
  if (!mayRemoveRecurrence(recurrenceId, loaded)) return { kind: 'refuse', reason: 'series-not-loaded' }
  if (!repeatAsserted) return { kind: 'refuse', reason: 'repeat-untouched' }
  return { kind: 'remove' }
}

// ── What a rule change MEANS for an existing series ──────────────────────────
// One engine, so the page never has to re-derive it. Three real answers:
//
//  regenerate — the rule still has visits ahead: rebuild the forward grid.
//  end        — the rule stops the series at or before the visit being edited.
//               NOT a failure. This is what "ends Oct 31" means when you're
//               standing on the Oct 28 visit, and refusing it (as a bare
//               `future.length === 0` check does) silently discards the
//               owner's end rule: nothing persists, and reopening the job
//               still says "Never ends".
//  reject     — the rule genuinely materialises no schedule: an end before the
//               visit itself, or an END-LESS cadence that yields nothing
//               forward. Only here is keeping the old schedule the right call.
export type SeriesChangePlan =
  | { kind: 'reject'; reason: 'no-occurrences' | 'no-future' }
  | { kind: 'end'; cutoff: string }
  | { kind: 'regenerate'; future: string[] }

export function planSeriesChange(
  anchorISO: string,
  unit: RecurUnit,
  count: number,
  endDate: string | null,
  endCount: number | null,
  todayISO: string,
): SeriesChangePlan {
  const dates = generateOccurrences(anchorISO, unit, count, endDate, endCount)
  if (dates.length === 0) return { kind: 'reject', reason: 'no-occurrences' }
  const future = dates.slice(1).filter(d => d >= todayISO)
  if (future.length > 0) return { kind: 'regenerate', future }
  if (!endDate && !endCount) return { kind: 'reject', reason: 'no-future' }
  // The cutoff is the owner's own end date; a count-limited rule ends at the
  // last occurrence it allows. Reconciling against the END DATE (not the last
  // generated date) is what keeps a legitimate in-season stop that simply sits
  // off the new grid.
  return { kind: 'end', cutoff: endDate ?? dates[dates.length - 1] }
}

// ── The stored rule ⇄ the Repeat controls ────────────────────────────────────
// Lives here, not in the form, because it IS part of the recurrence contract:
// it decides whether an existing series reads back as repeating at all. When
// the editor rendered a real weekly series as "Does not repeat" (its snapshot
// hadn't loaded yet), saving deleted the entire series — so this mapping is
// guarded rather than left inline in a component no script can import.
export type RepeatPreset = 'none' | 'w1' | 'w2' | 'w3' | 'w4' | 'm1' | 'custom'
export type EndMode = 'season' | 'on' | 'after' | 'never'

export interface RecurrenceUi {
  preset: RepeatPreset
  customUnit: RecurUnit
  customCount: number
  endMode: EndMode
  endDate: string
  endCount: number
}

export interface RecurrenceLike {
  unit: RecurUnit | null
  count: number
  endDate: string | null
  endCount: number | null
}

/** Map an existing series back onto the Repeat UI controls so editing pre-fills. */
export function recurrenceToUi(r?: RecurrenceLike): RecurrenceUi {
  if (!r || !r.unit) {
    return { preset: 'none', customUnit: 'week', customCount: 3, endMode: 'never', endDate: '', endCount: 10 }
  }
  let preset: RepeatPreset = 'custom'
  if (r.unit === 'week' && r.count === 1) preset = 'w1'
  else if (r.unit === 'week' && r.count === 2) preset = 'w2'
  else if (r.unit === 'week' && r.count === 3) preset = 'w3'
  else if (r.unit === 'week' && r.count === 4) preset = 'w4'
  else if (r.unit === 'month' && r.count === 1) preset = 'm1'
  // An existing end_date pre-fills as a specific date; the editor re-derives
  // "Season end" from it by comparing against the series' own season end.
  const endMode: EndMode = r.endDate ? 'on' : r.endCount ? 'after' : 'never'
  return {
    preset,
    customUnit: r.unit,
    customCount: Math.max(1, r.count),
    endMode,
    endDate: r.endDate || '',
    endCount: r.endCount || 10,
  }
}

// ── Re-seeding the Repeat controls when the series finally arrives ────────────
// The editor seeds its controls from the series in useState initializers, which
// read the prop ONCE. The schedule page opens the editor from a ?focus= deep
// link the moment `jobs` arrives — which can beat the `recurrences` read it
// looks the series up in — so a genuinely weekly job rendered as "Does not
// repeat" and STAYED that way after its series landed.
//
// This says what the controls should read when the series arrives late. Split in
// two because the owner touches the halves independently: a chosen cadence and a
// chosen end are each protected on their own, and a late prop never overwrites
// either. Returning nothing for a half means "leave it exactly as it is" —
// including the case that matters most, a deliberate "Does not repeat".
export interface RepeatReseed {
  repeat?: Pick<RecurrenceUi, 'preset' | 'customUnit' | 'customCount'>
  end?: Pick<RecurrenceUi, 'endMode' | 'endDate' | 'endCount'>
}

export function reseedRepeatUi(
  incoming: RecurrenceLike | undefined,
  touched: { repeat: boolean; end: boolean },
): RepeatReseed {
  // Nothing to re-seed FROM: a series that has not arrived (or a job that never
  // had one) must not push the controls anywhere. The save-side guard, not this,
  // is what stops that silence from being read as an instruction.
  if (!incoming?.unit) return {}
  const ui = recurrenceToUi(incoming)
  const out: RepeatReseed = {}
  if (!touched.repeat) out.repeat = { preset: ui.preset, customUnit: ui.customUnit, customCount: ui.customCount }
  if (!touched.repeat && !touched.end) out.end = { endMode: ui.endMode, endDate: ui.endDate, endCount: ui.endCount }
  return out
}

/**
 * May a save that says "does not repeat" actually REMOVE this job's series?
 * Only when the series was genuinely loaded. A missing snapshot means the form
 * never knew about the series — treating that silence as the owner's intent
 * deletes every sibling visit.
 */
export function mayRemoveRecurrence(recurrenceId: string | null | undefined, loaded: Record<string, unknown>): boolean {
  if (!recurrenceId) return true
  return !!loaded[recurrenceId]
}

/** Shift a date string by a number of days, returning yyyy-MM-dd. */
export function shiftDate(iso: string, deltaDays: number): string {
  return format(addDays(parseISO(iso), deltaDays), 'yyyy-MM-dd')
}

export function dayDelta(fromISO: string, toISO: string): number {
  return differenceInCalendarDays(parseISO(toISO), parseISO(fromISO))
}

// ── Current Service Plan ──────────────────────────────────────────────────────
// An at-a-glance summary of an active recurring schedule, assembled from the
// existing recurrence row + its jobs. Shown on customer/property pages so the
// plan is visible without opening the schedule. Reuses the seasons engine for
// the date window when the series itself has no explicit end_date.

const WEEKDAYS = ['Sundays', 'Mondays', 'Tuesdays', 'Wednesdays', 'Thursdays', 'Fridays', 'Saturdays']

export interface ServicePlan {
  recurrenceId: string
  propertyId: string | null
  serviceName: string        // e.g. "Weekly Mowing" (service_type of its visits)
  cadenceLabel: string       // "Weekly", "Every 2 weeks", …
  weekday: string | null     // "Fridays" — the dominant visit weekday, if consistent
  windowLabel: string | null // "Apr 15 → Oct 31" (season or end_date), null = ongoing
  remaining: number          // future scheduled/in-progress visits booked
  nextVisitDate: string | null
  paused: boolean            // recurring history but zero future visits booked
  initialPrice: number | null   // the anchor (initial) visit's value, when distinct
  recurringPrice: number | null // the per-visit cadence value
}

// Build a plan per recurrence that has ANY visit (past or future). `todayISO`
// keeps it testable/resume-safe (pass localTodayISO() at the call site). Pass
// `valueOf` (a per-visit valuation) to surface the initial vs recurring price.
export function buildServicePlans(
  recurrences: JobRecurrence[],
  jobs: Job[],
  seasons: ServiceSeasons,
  todayISO: string,
  valueOf?: (job: Job) => number,
): ServicePlan[] {
  const plans: ServicePlan[] = []
  for (const r of recurrences) {
    const series = jobs.filter(j => j.recurrence_id === r.id)
    if (series.length === 0) continue
    const future = series
      .filter(j => j.scheduled_date >= todayISO && (j.status === 'scheduled' || j.status === 'in_progress'))
      .sort((a, b) => a.scheduled_date.localeCompare(b.scheduled_date))
    const sample = series.find(j => j.service_type) || series[0]
    const serviceName = sample?.service_type || 'Recurring service'
    const propertyId = sample?.property_id ?? null

    // Dominant weekday across the non-cancelled visits — only report it when
    // it's actually consistent (a fixed-day route customer).
    const dows: Record<number, number> = {}
    for (const j of series) {
      if (j.status === 'cancelled') continue
      const d = parseISO(j.scheduled_date + 'T00:00:00').getDay()
      dows[d] = (dows[d] || 0) + 1
    }
    const entries = Object.entries(dows).sort((a, b) => b[1] - a[1])
    const total = entries.reduce((s, [, n]) => s + n, 0)
    const weekday = entries.length && total > 0 && entries[0][1] / total >= 0.6
      ? WEEKDAYS[Number(entries[0][0])] : null

    // Window: the series' own end_date if set, else the service's season window
    // anchored on its start. Count-limited series have no calendar window.
    let windowLabel: string | null = null
    const startISO = r.start_date || series.map(j => j.scheduled_date).sort()[0]
    if (r.end_date) {
      windowLabel = `${formatShort(startISO)} → ${formatShort(r.end_date)}`
    } else if (!r.end_count) {
      const season = seasonForService(serviceName, seasons)
      if (season) {
        const endISO = startISO ? seasonEndDateFor(startISO, season) : null
        windowLabel = endISO ? seasonLabel(season) : null
      }
    }

    // Initial vs recurring price — the anchor visit's value vs a recurring one.
    let initialPrice: number | null = null
    let recurringPrice: number | null = null
    if (valueOf) {
      const anchor = series.find(j => j.is_initial_visit)
      const recurringSample = series.find(j => !j.is_initial_visit && j.status !== 'cancelled')
      initialPrice = anchor ? Math.round(valueOf(anchor)) : null
      recurringPrice = recurringSample ? Math.round(valueOf(recurringSample)) : null
    }

    plans.push({
      recurrenceId: r.id,
      propertyId,
      serviceName,
      cadenceLabel: recurrenceLabel(r.interval_unit, r.interval_count, r.freq),
      weekday,
      windowLabel,
      remaining: future.length,
      nextVisitDate: future[0]?.scheduled_date ?? null,
      paused: future.length === 0,
      initialPrice,
      recurringPrice,
    })
  }
  // Active plans first, then most upcoming visits.
  return plans.sort((a, b) => Number(a.paused) - Number(b.paused) || b.remaining - a.remaining)
}

function formatShort(iso: string): string {
  const d = parseISO(iso + (iso.length === 10 ? 'T00:00:00' : ''))
  return format(d, 'MMM d')
}
