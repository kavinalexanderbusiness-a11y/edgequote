// ── Loading what the day-fit engine compares against ─────────────────────────
// lib/dayFit.ts is pure; this is the ONE place that knows which tables a day's
// realistic capacity comes from. Engine · loader · UI, same split as
// estimateVsActual / estimateVsActualData and timeline / timelineData.
//
// ══ FAILURE HONESTY ══════════════════════════════════════════════════════════
// Three different failures, three different answers — never collapsed:
//   • jobs or settings unreadable  → outcome 'unavailable'. With the day's
//     committed load unknown, ANY fit claim would be invented; the UI must fall
//     back to saying so (a failed read is not free capacity).
//   • workforce unreadable         → ctx.workforceKnown = false and
//     workersByDate() = null. Solo-sized candidates still get the honest clock
//     answer; multi-worker candidates come back 'unknown' from the engine.
//   • learning unavailable / empty → learnedFor()/historyFor() return null.
//     Candidates fall to their own estimate or to 'unknown' — history that
//     could not be read teaches nothing, it does not teach zero.
//
// ══ TENANCY ══════════════════════════════════════════════════════════════════
// Every read is `.eq('user_id', userId)` on RLS own-row tables. The explicit
// filter is load-bearing the day any caller hands this a service-role client —
// one business's roster, time off and booked days must never shape another
// business's suggestions.

import type { SupabaseClient } from '@supabase/supabase-js'
import { addDays, format, parseISO } from 'date-fns'
import { serviceHistory, type LaborComparison, type ServiceVariance } from '@/lib/estimateVsActual'
import { loadCompletedVisitLearning } from '@/lib/estimateVsActualData'
import { workersAvailableOn, type DayVisitLike, type DayFitInput, type TechForAvailability } from '@/lib/dayFit'

export interface DayFitContext {
  /** business_settings.daily_capacity_hours (null follows dayLoad's 8h default). */
  capacityHours: number | null
  /** Owner's preferred work weekdays (0=Sun…6=Sat); empty = works any day. */
  preferredWorkDays: number[]
  /** Active (scheduled / in-progress) visits per yyyy-MM-dd inside the horizon. */
  visitsByDate: Record<string, DayVisitLike[]>
  /** Workers available on a date, or null when the workforce read failed. */
  workersByDate: (date: string) => number | null
  /** Established learned on-site minutes for a service, else null. */
  learnedFor: (serviceType: string | null | undefined) => number | null
  /** The full canonical history rollup for a service (resolveDuration input). */
  historyFor: (serviceType: string | null | undefined) => ServiceVariance | null
  /** False when technicians/pto could not be read — reads as "unknown", not 0. */
  workforceKnown: boolean
  /** Build the engine input for one day. */
  dayInput: (date: string) => DayFitInput
  /** The horizon, in order — every candidate day this context can answer for. */
  horizonDates: string[]
}

export type DayFitLoad =
  | { outcome: 'ok'; ctx: DayFitContext }
  /** The committed schedule or capacity setting could not be read. NOT empty. */
  | { outcome: 'unavailable'; reason: string }

export const DAYFIT_HORIZON_DAYS = 28

export async function loadDayFitContext(
  supabase: SupabaseClient,
  userId: string,
  opts: { fromISO: string; horizonDays?: number },
): Promise<DayFitLoad> {
  if (!userId) return { outcome: 'unavailable', reason: 'not_signed_in' }
  const horizon = opts.horizonDays ?? DAYFIT_HORIZON_DAYS
  const from = opts.fromISO
  const to = format(addDays(parseISO(from + 'T00:00:00'), horizon), 'yyyy-MM-dd')

  const [jRes, sRes, tRes, pRes, learn] = await Promise.all([
    supabase.from('jobs')
      .select('scheduled_date, status, duration_minutes, crew_size, service_type')
      .eq('user_id', userId)
      .gte('scheduled_date', from).lte('scheduled_date', to)
      .in('status', ['scheduled', 'in_progress']),
    supabase.from('business_settings')
      .select('daily_capacity_hours, preferred_work_days')
      .eq('user_id', userId).maybeSingle(),
    supabase.from('technicians')
      .select('id, is_active, ended_on, archived_at')
      .eq('user_id', userId),
    supabase.from('pto_entries')
      .select('technician_id, date')
      .eq('user_id', userId)
      .gte('date', from).lte('date', to),
    loadCompletedVisitLearning(supabase, userId),
  ])

  // Load-bearing: the committed schedule and the capacity setting. Without them
  // "remaining capacity" is fiction.
  if (jRes.error) return { outcome: 'unavailable', reason: jRes.error.message || 'jobs_read_failed' }
  if (sRes.error) return { outcome: 'unavailable', reason: sRes.error.message || 'settings_read_failed' }

  const visitsByDate: Record<string, DayVisitLike[]> = {}
  for (const j of (jRes.data as (DayVisitLike & { scheduled_date: string })[]) || []) {
    (visitsByDate[j.scheduled_date] ||= []).push(j)
  }

  const settings = sRes.data as { daily_capacity_hours: number | null; preferred_work_days: number[] | null } | null
  const capacityHours = settings?.daily_capacity_hours == null ? null : Number(settings.daily_capacity_hours)
  const preferredWorkDays = settings?.preferred_work_days?.length ? settings.preferred_work_days : []

  // Degrading, not load-bearing: an unreadable roster means "unknown", never 0.
  const workforceKnown = !tRes.error && !pRes.error
  const techs = workforceKnown ? ((tRes.data as TechForAvailability[]) || []) : []
  const pto = workforceKnown ? ((pRes.data as { technician_id: string; date: string }[]) || []) : []
  const workersByDate = (date: string): number | null =>
    workforceKnown ? workersAvailableOn(date, techs, pto) : null

  // Learning: canonical rollups, memoized per service bucket.
  const comparisons: LaborComparison[] =
    learn.outcome === 'unavailable' ? [] : learn.learning.comparisons
  const histCache = new Map<string, ServiceVariance>()
  const historyFor = (serviceType: string | null | undefined): ServiceVariance | null => {
    if (learn.outcome === 'unavailable') return null
    const rollup = histCache.get(String(serviceType ?? ''))
      ?? serviceHistory(serviceType, comparisons)
    histCache.set(String(serviceType ?? ''), rollup)
    return rollup
  }
  const learnedFor = (serviceType: string | null | undefined): number | null => {
    const h = historyFor(serviceType)
    return h?.established && h.medianActualMinutes != null && h.medianActualMinutes > 0
      ? Math.round(h.medianActualMinutes) : null
  }

  const horizonDates: string[] = []
  for (let i = 0; i < horizon; i++) {
    horizonDates.push(format(addDays(parseISO(from + 'T00:00:00'), i), 'yyyy-MM-dd'))
  }

  const dayInput = (date: string): DayFitInput => ({
    visits: visitsByDate[date] || [],
    capacityHours,
    workers: workersByDate(date),
    learnedFor,
  })

  return {
    outcome: 'ok',
    ctx: {
      capacityHours, preferredWorkDays, visitsByDate, workersByDate,
      learnedFor, historyFor, workforceKnown, dayInput, horizonDates,
    },
  }
}
