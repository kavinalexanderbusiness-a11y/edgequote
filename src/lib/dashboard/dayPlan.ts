// ── THE day-plan engine ──────────────────────────────────────────────────────
// The owner's next work days at a glance: planned revenue, hours, the stops, and
// which days are still open. Pure and framework-free — the caller supplies rows
// it has already loaded. Reuses the ONE valuation engine (jobVisitValue) and the
// ONE route/capacity engine (roughFinishEstimate/dayLoad); it only aggregates.

import { addDays, format, getDay, parseISO } from 'date-fns'
import { jobVisitValue, effectiveFreq } from '@/lib/invoicing'
import { roughFinishEstimate, dayLoad } from '@/lib/route'

export const DEFAULT_WORK_DAYS = [5, 6, 0]
const DEFAULT_MIN = 45
export const DAYS_TO_SHOW = 3

export interface DayJob {
  id: string; customer_name: string; phone: string | null; address: string | null
  service_type: string | null; start_time: string | null; value: number
}
export interface DayGroup {
  date: string; weekday: string; jobs: DayJob[]
  hours: number; revenue: number; finish: string
  loadState: 'overloaded' | 'full' | 'room'
  /** Today's row is the one the owner acts on this morning — the card marks it. */
  isToday: boolean
}

export interface PlanJob {
  id: string; scheduled_date: string; start_time: string | null
  service_type: string | null; duration_minutes: number | null; price: number | null
  quote_id: string | null; recurrence_id: string | null
  customers: { name: string | null; phone: string | null } | null
  properties: { address: string | null } | null
}

export interface DayPlanInput {
  jobs: PlanJob[]
  quotesById: Record<string, Record<string, unknown>>
  recById: Record<string, { freq: string | null; interval_unit: string | null; interval_count: number | null }>
  preferredWorkDays: number[] | null
  workStart: string
  capacityHours: number
  today: string
}

export interface DayPlan {
  groups: DayGroup[]
  totalJobs: number
  totalHours: number
  totalRevenue: number
}

/**
 * The next `count` preferred work days starting TODAY.
 *
 * `todayHasWork` forces today to the front even when it isn't a preferred work
 * day. Without it, a job booked on a day off is INVISIBLE on the dashboard —
 * "what's on today" is the whole point of this card, and the owner shouldn't have
 * to know their own settings to find out they have a stop this morning. An empty
 * non-work day is still skipped, so a real day off stays quiet.
 */
export function nextWorkDates(
  preferred: number[] | null, today: string, count = DAYS_TO_SHOW, todayHasWork = false,
): string[] {
  const prefSet = new Set(preferred?.length ? preferred : DEFAULT_WORK_DAYS)
  const out: string[] = []
  if (todayHasWork) out.push(today)
  let d = parseISO(today)
  for (let i = 0; i < 21 && out.length < count; i++) {
    const iso = format(d, 'yyyy-MM-dd')
    if (prefSet.has(getDay(d)) && !out.includes(iso)) out.push(iso)
    d = addDays(d, 1)
  }
  // `today` may have jumped the queue above — keep the card chronological.
  return out.sort()
}

export function computeDayPlan(i: DayPlanInput): DayPlan {
  const todayHasWork = i.jobs.some(j => j.scheduled_date === i.today)
  const wantDates = nextWorkDates(i.preferredWorkDays, i.today, DAYS_TO_SHOW, todayHasWork)

  const byDate: Record<string, DayJob[]> = {}
  const minByDate: Record<string, number> = {}
  for (const j of i.jobs) {
    if (!wantDates.includes(j.scheduled_date)) continue
    const quote = j.quote_id ? i.quotesById[j.quote_id] : null
    const rec = j.recurrence_id ? i.recById[j.recurrence_id] : null
    const freq = rec ? effectiveFreq(rec.freq, rec.interval_unit, rec.interval_count) : null
    ;(byDate[j.scheduled_date] ||= []).push({
      id: j.id,
      customer_name: j.customers?.name || 'Job',
      phone: j.customers?.phone ?? null,
      address: j.properties?.address ?? null,
      service_type: j.service_type,
      start_time: j.start_time,
      value: Math.round(jobVisitValue(j.price, quote, freq)),
    })
    minByDate[j.scheduled_date] = (minByDate[j.scheduled_date] || 0) + (j.duration_minutes || DEFAULT_MIN)
  }

  const groups: DayGroup[] = wantDates.map(date => {
    const dayJobs = byDate[date] || []
    const laborMin = minByDate[date] || 0
    // Rough plan-level timing (no route order here — Day Ops has the precise one).
    const fin = roughFinishEstimate(i.workStart, laborMin, dayJobs.length)
    const load = dayLoad(laborMin + dayJobs.length * 10, i.capacityHours)
    return {
      date,
      weekday: format(parseISO(date + 'T00:00:00'), 'EEEE'),
      jobs: dayJobs,
      hours: Math.round((laborMin / 60) * 10) / 10,
      revenue: dayJobs.reduce((s, j) => s + j.value, 0),
      finish: fin.finish,
      loadState: load.state,
      isToday: date === i.today,
    }
  })

  return {
    groups,
    totalJobs: groups.reduce((s, g) => s + g.jobs.length, 0),
    totalHours: Math.round(groups.reduce((s, g) => s + g.hours, 0) * 10) / 10,
    totalRevenue: groups.reduce((s, g) => s + g.revenue, 0),
  }
}
