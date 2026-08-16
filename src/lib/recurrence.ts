import { addDays, addMonths, format, parseISO, differenceInCalendarDays } from 'date-fns'
import type { SupabaseClient } from '@supabase/supabase-js'
import type { Job, JobRecurrence, RecurUnit, RecurrenceScope } from '@/types'
import { ServiceSeasons, seasonForService, seasonEndDateFor, seasonLabel } from '@/lib/seasons'
// THE seasonality rule — shared with reactivation/churn so a customer never
// reads as dormant on one screen and lost on another (see signals/lifecycle).
import { isSeasonallyDormant } from '@/lib/signals/lifecycle'

// Safety caps so a series never materialises unbounded rows.
const HARD_CAP = 260            // ~5 years weekly — absolute ceiling
// Visits to pre-create when there's no end. Exported because the job form has to
// SAY this number: nothing tops a series up, so "no end date" means exactly this
// many visits and then silence — which the form used to describe as "kept rolling
// on your calendar". Copy reads the constant so the two cannot drift apart.
export const OPEN_ENDED_HORIZON = 26

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

// ── Why a plan has nothing booked ────────────────────────────────────────────
// `paused` was one boolean over FOUR different situations, and every surface
// rendered them identically: a delivered 10-visit package, a snow series in
// August, an open-ended series that exhausted its materialised horizon, and a
// schedule the owner deliberately cleared all read "Paused · schedule it again
// to resume". The portal told the customer "No visits booked" for all of them.
//
// The distinction is fully derivable from rows we already hold — no column, no
// new write. Seasonality is NOT re-derived here: it comes from
// signals/lifecycle.isSeasonallyDormant, the same call reactivation.ts makes,
// so a customer can no longer read as dormant on one screen and lost on another.
//
// Order matters, and dormancy is checked before the rule: an out-of-season
// series is dormant whether it stopped because its end date passed or because it
// simply ran out, and that is what the lifecycle engine already believes.
export type PlanStatus =
  | 'active'          // future visits are booked
  | 'dormant'         // seasonal service, out of season — back next season
  | 'ended'           // the rule is exhausted: end date passed, or all N delivered
  | 'cancelled_ahead' // upcoming visits exist but were cancelled
  | 'ran_dry'         // nothing left and nothing says why — needs re-booking

// The vocabulary lives with the engine so the customer page, the properties page
// and the portal cannot drift into three different words for one state.
// OWNER copy names the state; CUSTOMER copy says only what a homeowner needs and
// never exposes an internal reason ("ran dry" is the owner's problem to fix).
export const PLAN_STATUS_LABEL: Record<PlanStatus, string> = {
  active: 'Active',
  dormant: 'Season over',
  ended: 'Plan complete',
  cancelled_ahead: 'Upcoming cancelled',
  ran_dry: 'Needs re-booking',
}

export const PLAN_STATUS_CUSTOMER_LABEL: Record<PlanStatus, string> = {
  active: 'Active',
  dormant: 'Back next season',
  ended: 'Plan complete',
  cancelled_ahead: 'No visits booked',
  ran_dry: 'No visits booked',
}

export interface ServicePlan {
  recurrenceId: string
  propertyId: string | null
  serviceName: string        // e.g. "Weekly Mowing" (service_type of its visits)
  cadenceLabel: string       // "Weekly", "Every 2 weeks", …
  weekday: string | null     // "Fridays" — the dominant visit weekday, if consistent
  windowLabel: string | null // "Apr 15 → Oct 31" (season or end_date), null = ongoing
  remaining: number          // future scheduled/in-progress visits booked
  nextVisitDate: string | null
  status: PlanStatus
  /** @deprecated Reads as `status !== 'active'`. Kept so callers migrate one at
   *  a time; every surface should branch on `status`, which says WHY. */
  paused: boolean
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

    // Why is there nothing booked? (see PlanStatus). Dormancy comes from the
    // canonical lifecycle detector so this agrees with reactivation/churn.
    let status: PlanStatus = 'active'
    if (future.length === 0) {
      const delivered = series.filter(j => j.status !== 'cancelled').length
      const ruleExhausted =
        (!!r.end_date && r.end_date < todayISO) ||
        (!!r.end_count && delivered >= r.end_count)
      status =
        isSeasonallyDormant(serviceName, seasons, todayISO) ? 'dormant'
        : ruleExhausted ? 'ended'
        : series.some(j => j.scheduled_date >= todayISO && j.status === 'cancelled') ? 'cancelled_ahead'
        : 'ran_dry'
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
      status,
      paused: status !== 'active',
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

// ── Creating a service plan ──────────────────────────────────────────────────
// Moved here from lib/suggestions, where it was the "one-click apply" of one
// feature. It is not one feature's helper: it is THE way a plan comes into
// existence outside the schedule screen's own editor, and the renewal queue
// needs exactly the same write. Two copies of "insert a recurrence and its
// visits" is the shape this codebase keeps getting hurt by, so there is one, and
// it lives beside the engine that generates the dates. lib/suggestions re-exports
// it, so its existing callers are untouched.
//
// Mirrors the schedule page's convertToRecurring: GENERATE + VALIDATE before any
// write (refuse a plan with no visits), insert the recurrence, then its visits;
// roll the orphan recurrence back if the visit insert fails.
//
// ⚠️ This function is a WRITE and it is deliberately dumb: it creates what it is
// told to create. Every caller is responsible for having an owner's explicit
// instruction behind it — see lib/renewals.createRenewedPlan, which will not
// call it without an accepted quote.
export interface RecurringPlanPayload {
  customerId: string | null
  propertyId: string | null
  serviceType: string | null
  title: string
  /** Per-visit money written onto every visit. Pass null WITH a quoteId to let
   *  the visits derive the quote's cadence price instead — one money path,
   *  the same choice convertToRecurring makes for quote-linked series. */
  perVisitPrice: number | null
  intervalUnit: RecurUnit
  intervalCount: number
  startDate: string             // yyyy-MM-dd
  endDate: string | null        // a season end, a term end, or null for open-ended
  /** Ends after N visits instead of on a date. */
  endCount?: number | null
  crewSize: number
  durationMinutes: number | null
  /** Links every visit to the quote the customer accepted. */
  quoteId?: string | null
}

export async function createRecurringPlan(
  supabase: SupabaseClient,
  plan: RecurringPlanPayload,
): Promise<{ ok: boolean; error?: string; count?: number; recurrenceId?: string }> {
  // getSession (local read), not getUser (network hop): the id only scopes RLS-filtered reads.
  const { data: { session } } = await supabase.auth.getSession()
  const user = session?.user
  if (!user) return { ok: false, error: 'Not signed in' }
  try {
    const dates = generateOccurrences(plan.startDate, plan.intervalUnit, plan.intervalCount, plan.endDate, plan.endCount ?? null)
    const future = dates.filter(d => d >= plan.startDate)
    if (future.length === 0) return { ok: false, error: 'No visits would be generated — check the dates and cadence.' }
    const { data: rec, error: recErr } = await supabase.from('job_recurrences').insert({
      user_id: user.id,
      freq: plan.intervalUnit === 'week' && plan.intervalCount === 1 ? 'weekly'
        : plan.intervalUnit === 'week' && plan.intervalCount === 2 ? 'biweekly'
        : plan.intervalUnit === 'month' && plan.intervalCount === 1 ? 'monthly'
        : null,
      interval_unit: plan.intervalUnit, interval_count: plan.intervalCount,
      start_date: plan.startDate, end_date: plan.endDate, end_count: plan.endCount ?? null,
      customer_id: plan.customerId,
    }).select().single()
    if (recErr || !rec) return { ok: false, error: recErr?.message || 'Could not create the plan' }
    const rows = future.map(d => ({
      user_id: user.id, customer_id: plan.customerId, property_id: plan.propertyId,
      quote_id: plan.quoteId ?? null,
      recurrence_id: (rec as { id: string }).id, title: plan.title, service_type: plan.serviceType,
      scheduled_date: d, crew_size: plan.crewSize, status: 'scheduled', price: plan.perVisitPrice,
      is_initial_visit: false, duration_minutes: plan.durationMinutes,
    }))
    const { error: jErr } = await supabase.from('jobs').insert(rows)
    if (jErr) {
      await supabase.from('job_recurrences').delete().eq('id', (rec as { id: string }).id) // rollback orphan
      return { ok: false, error: jErr.message }
    }
    return { ok: true, count: future.length, recurrenceId: (rec as { id: string }).id }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : 'Create failed' }
  }
}

// ── What a scope actually costs ──────────────────────────────────────────────
// The scope chooser offered three bare labels — "This visit only", "This and
// future visits", "All visits" — for mutations whose reach differs by an order
// of magnitude. On a mowing customer 15 visits into the season, "All visits" is
// the only option that READS like "stop this plan", and it is the one that hard-
// deletes every completed visit: the actual minutes, the profitability, the
// estimate-vs-actual sample and the customer's timeline.
//
// This does not change what any scope does. It says what each one touches, from
// jobsInScope — THE same predicate the mutation runs — so a label can never
// promise a different reach than the write. Counting the anchor itself is
// deliberate: deleting one completed visit is still destroying history.
export interface ScopeImpact {
  scope: RecurrenceScope
  /** "This and 7 later visits" — the reach, in visits. */
  label: string
  total: number
  completed: number
  inProgress: number
  /** "includes 15 completed" — null when this scope touches no history. */
  historyNote: string | null
}

function historyNote(completed: number, inProgress: number): string | null {
  if (completed > 0 && inProgress > 0) return `includes ${completed} completed and ${inProgress} in progress`
  if (completed > 0) return `includes ${completed} completed`
  if (inProgress > 0) return `includes ${inProgress} in progress`
  return null
}

export function scopeImpacts(anchor: Job, allJobs: Job[]): ScopeImpact[] {
  const SCOPES: RecurrenceScope[] = ['this', 'future', 'all']
  return SCOPES.map(scope => {
    const targets = jobsInScope(anchor, allJobs, scope)
    const completed = targets.filter(j => j.status === 'completed').length
    const inProgress = targets.filter(j => j.status === 'in_progress').length
    const later = targets.length - 1
    const label =
      scope === 'this' ? 'This visit only'
      : scope === 'future'
        ? (later === 0 ? 'This visit — none later' : `This and ${later} later visit${later !== 1 ? 's' : ''}`)
        : `All ${targets.length} visit${targets.length !== 1 ? 's' : ''}`
    return { scope, label, total: targets.length, completed, inProgress, historyNote: historyNote(completed, inProgress) }
  })
}
