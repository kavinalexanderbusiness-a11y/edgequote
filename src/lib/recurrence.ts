import { addDays, addMonths, format, parseISO, differenceInCalendarDays } from 'date-fns'
import type { SupabaseClient } from '@supabase/supabase-js'
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
