// ── Whole-schedule optimizer ──────────────────────────────────────────────────
// The highest-level scheduling tool: analyzes ALL future jobs together and
// searches for date moves that reduce driving, balance workload and respect the
// owner's constraints. It is ORCHESTRATION ONLY — every piece of math comes from
// the existing engines: lib/route (drive km/minutes), lib/invoicing (cadence,
// per-visit value computed by the caller), business settings (work days,
// capacity). Never touches completed, cancelled, invoiced, time-committed or
// past/today jobs — only future scheduled work.

import { addDays, format, getDay, parseISO } from 'date-fns'
import { Coord } from '@/lib/geo'
import { routeKmEstimate, clusterKmEstimate, AVG_SPEED_KM_PER_MIN, DEFAULT_JOB_MIN } from '@/lib/route'
import { effectiveFreq } from '@/lib/invoicing'

export type OptimizeMode = 'density' | 'balanced' | 'revenue' | 'recommended'

export interface OptJob {
  id: string
  scheduled_date: string
  status: string
  recurrence_id: string | null
  start_time: string | null
  duration_minutes: number | null
  lat: number | null
  lng: number | null
  value: number          // per-visit revenue (from the ONE valuation engine)
  invoiced: boolean      // already billed — immutable
  title: string
  customerName: string
}

export interface OptOptions {
  mode: OptimizeMode
  today: string                 // yyyy-MM-dd local
  base: Coord | null
  preferredDays: number[]       // getDay indices; empty = any day allowed
  capacityHours: number
  recurrences: Record<string, { freq: string | null; interval_unit: string | null; interval_count: number | null }>
}

export interface ScheduleMetrics {
  totalKm: number
  driveMinutes: number
  laborMinutes: number
  totalHours: number
  activeDays: number
  stops: number
  densityScore: number   // 0–100, higher = tighter routes
  revenue: number
  revPerHour: number
  overloadedDays: number
}

export interface PlannedMove {
  jobId: string
  title: string
  customerName: string
  from: string
  to: string
  value: number
  recurring: boolean
}

export interface OptimizationResult {
  mode: OptimizeMode
  before: ScheduleMetrics
  after: ScheduleMetrics
  moves: PlannedMove[]
  daysAffected: number
  kmSaved: number
  minutesSaved: number
  movableCount: number
  lockedTimes: number    // future jobs left alone because they have a set start time
  lockedBilled: number   // future jobs left alone because they're already invoiced
}

// Mode weights — all terms expressed in MINUTES so they compose meaningfully.
// over = minutes beyond daily capacity (heavily penalized everywhere),
// spread = stddev of active-day total minutes (workload balance),
// days = per-active-day overhead (consolidation pressure — fewer base trips).
const WEIGHTS: Record<OptimizeMode, { km: number; over: number; spread: number; days: number }> = {
  density:     { km: 1.0, over: 1.0, spread: 0.0, days: 0.2 },
  balanced:    { km: 0.3, over: 2.0, spread: 1.2, days: 0.0 },
  revenue:     { km: 0.7, over: 2.0, spread: 0.0, days: 1.0 },
  recommended: { km: 0.8, over: 1.5, spread: 0.5, days: 0.4 },
}
const DAY_OVERHEAD_MIN = 45 // proxy cost of opening another working day

// How far a visit may shift without breaking its cadence promise.
function moveWindowDays(j: OptJob, recs: OptOptions['recurrences']): number {
  if (!j.recurrence_id) return 6
  const r = recs[j.recurrence_id]
  const f = r ? effectiveFreq(r.freq, r.interval_unit, r.interval_count) : null
  return f === 'weekly' ? 2 : f === 'biweekly' ? 3 : 4
}

interface DayEval { driveMin: number; laborMin: number; km: number; totalMin: number }

export function optimizeSchedule(jobs: OptJob[], opts: OptOptions): OptimizationResult {
  const capMin = (opts.capacityHours > 0 ? opts.capacityHours : 8) * 60
  const prefSet = opts.preferredDays.length ? new Set(opts.preferredDays) : null
  const w = WEIGHTS[opts.mode]

  // The future universe: every non-cancelled job AFTER today participates in the
  // metrics (immovable ones still shape each day's route); only clean candidates move.
  const future = jobs.filter(j => j.scheduled_date > opts.today && j.status !== 'cancelled')
  const lockedTimes = future.filter(j => j.status === 'scheduled' && !j.invoiced && !!j.start_time).length
  const lockedBilled = future.filter(j => j.invoiced).length
  const movable = future.filter(j => j.status === 'scheduled' && !j.invoiced && !j.start_time)

  // Current assignment (mutated by the search) + original dates for reporting.
  const assign = new Map<string, string>()
  for (const j of future) assign.set(j.id, j.scheduled_date)
  const original = new Map(future.map(j => [j.id, j.scheduled_date]))

  // Series siblings in ORIGINAL order — a moved visit must stay strictly between
  // its neighbours so cadence ordering is never scrambled.
  const seriesJobs: Record<string, OptJob[]> = {}
  for (const j of future) if (j.recurrence_id) (seriesJobs[j.recurrence_id] ||= []).push(j)
  for (const k in seriesJobs) seriesJobs[k].sort((a, b) => a.scheduled_date.localeCompare(b.scheduled_date))

  const byId = new Map(future.map(j => [j.id, j]))
  const dayJobs = new Map<string, Set<string>>()
  const addTo = (date: string, id: string) => { (dayJobs.get(date) ?? dayJobs.set(date, new Set()).get(date)!).add(id) }
  for (const j of future) addTo(j.scheduled_date, j.id)

  // ── Day evaluation (route engine math, cached per day) ──
  const cache = new Map<string, DayEval>()
  function evalDay(date: string): DayEval {
    const hit = cache.get(date)
    if (hit) return hit
    const ids = dayJobs.get(date)
    let laborMin = 0
    const located: { lat: number; lng: number }[] = []
    if (ids) for (const id of ids) {
      const j = byId.get(id)!
      laborMin += j.duration_minutes || DEFAULT_JOB_MIN
      if (j.lat != null && j.lng != null) located.push({ lat: j.lat, lng: j.lng })
    }
    const km = opts.base ? routeKmEstimate(opts.base, located) : clusterKmEstimate(located)
    const driveMin = Math.round(km / AVG_SPEED_KM_PER_MIN)
    const e = { driveMin, laborMin, km, totalMin: driveMin + laborMin }
    cache.set(date, e)
    return e
  }
  const invalidate = (date: string) => cache.delete(date)

  function globalCost(): number {
    let drive = 0, over = 0, days = 0
    const totals: number[] = []
    for (const [date, ids] of dayJobs) {
      if (ids.size === 0) continue
      const e = evalDay(date)
      drive += e.driveMin
      over += Math.max(0, e.totalMin - capMin)
      days++
      totals.push(e.totalMin)
    }
    let spread = 0
    if (totals.length > 1) {
      const mean = totals.reduce((a, b) => a + b, 0) / totals.length
      spread = Math.sqrt(totals.reduce((s, t) => s + (t - mean) ** 2, 0) / totals.length)
    }
    return w.km * drive + w.over * over + w.spread * spread + w.days * days * DAY_OVERHEAD_MIN
  }

  // Candidate dates for a job: inside its cadence window, on a preferred work
  // day, strictly future, and keeping series order intact (vs CURRENT positions).
  function candidates(j: OptJob): string[] {
    const win = moveWindowDays(j, opts.recurrences)
    const origin = parseISO(original.get(j.id)!)
    const out: string[] = []
    const sibs = j.recurrence_id ? seriesJobs[j.recurrence_id] : null
    const idx = sibs ? sibs.findIndex(s => s.id === j.id) : -1
    const prevDate = sibs && idx > 0 ? assign.get(sibs[idx - 1].id)! : null
    const nextDate = sibs && idx >= 0 && idx < sibs.length - 1 ? assign.get(sibs[idx + 1].id)! : null
    for (let d = -win; d <= win; d++) {
      if (d === 0) continue
      const date = format(addDays(origin, d), 'yyyy-MM-dd')
      if (date <= opts.today) continue
      if (date === assign.get(j.id)) continue
      if (prefSet && !prefSet.has(getDay(parseISO(date)))) continue
      if (prevDate && date <= prevDate) continue
      if (nextDate && date >= nextDate) continue
      out.push(date)
    }
    return out
  }

  function applyMove(id: string, to: string) {
    const from = assign.get(id)!
    dayJobs.get(from)!.delete(id)
    addTo(to, id)
    assign.set(id, to)
    invalidate(from); invalidate(to)
  }

  const metricsNow = (): ScheduleMetrics => {
    let km = 0, drive = 0, labor = 0, days = 0, stops = 0, over = 0
    for (const [date, ids] of dayJobs) {
      if (ids.size === 0) continue
      const e = evalDay(date)
      km += e.km; drive += e.driveMin; labor += e.laborMin; days++; stops += ids.size
      if (e.totalMin > capMin) over++
    }
    const revenue = future.reduce((s, j) => s + j.value, 0)
    const totalHours = Math.round(((drive + labor) / 60) * 10) / 10
    return {
      totalKm: Math.round(km * 10) / 10,
      driveMinutes: drive,
      laborMinutes: labor,
      totalHours,
      activeDays: days,
      stops,
      densityScore: stops > 0 ? Math.max(0, Math.min(100, Math.round(100 - (km / stops) * 8))) : 100,
      revenue: Math.round(revenue),
      revPerHour: totalHours > 0 ? Math.round(revenue / totalHours) : 0,
      overloadedDays: over,
    }
  }

  const before = metricsNow()

  // ── Greedy whole-schedule search: best-improvement passes until stable ──
  // Each candidate move is scored against the GLOBAL cost (drive + overload +
  // spread + day count), so a job only moves when the WHOLE schedule improves.
  let cost = globalCost()
  const MIN_GAIN = 1 // minutes-equivalent — ignore noise-level improvements
  for (let pass = 0; pass < 4; pass++) {
    let improved = false
    for (const j of movable) {
      let bestDate: string | null = null
      let bestCost = cost
      const fromDate = assign.get(j.id)!
      for (const date of candidates(j)) {
        applyMove(j.id, date)
        const c = globalCost()
        if (c < bestCost - MIN_GAIN) { bestCost = c; bestDate = date }
        applyMove(j.id, fromDate) // revert for the next trial
      }
      if (bestDate) {
        applyMove(j.id, bestDate)
        cost = bestCost
        improved = true
      }
    }
    if (!improved) break
  }

  const after = metricsNow()
  const moves: PlannedMove[] = []
  for (const j of movable) {
    const from = original.get(j.id)!
    const to = assign.get(j.id)!
    if (from !== to) moves.push({ jobId: j.id, title: j.title, customerName: j.customerName, from, to, value: j.value, recurring: !!j.recurrence_id })
  }
  moves.sort((a, b) => a.to.localeCompare(b.to))
  const daysAffected = new Set(moves.flatMap(m => [m.from, m.to])).size

  return {
    mode: opts.mode,
    before, after, moves, daysAffected,
    kmSaved: Math.round((before.totalKm - after.totalKm) * 10) / 10,
    minutesSaved: before.driveMinutes - after.driveMinutes,
    movableCount: movable.length,
    lockedTimes, lockedBilled,
  }
}
