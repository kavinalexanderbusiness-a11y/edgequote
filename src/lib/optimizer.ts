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

// Where the optimizer is allowed to work. Lets the owner optimize only the area
// they care about instead of the whole future every time.
export type OptimizeScope = 'day' | 'weekend' | 'week' | 'month' | 'future'

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
  neighborhood?: string | null // real area name, for cluster-aware reasons
}

export interface OptOptions {
  mode: OptimizeMode
  scope: OptimizeScope
  anchorDate: string            // yyyy-MM-dd the scope is measured around (cursor)
  today: string                 // yyyy-MM-dd local
  base: Coord | null
  preferredDays: number[]       // getDay indices; empty = any day allowed
  capacityHours: number
  recurrences: Record<string, { freq: string | null; interval_unit: string | null; interval_count: number | null }>
}

// Resolve a scope into its date windows. movable = origin dates that may move;
// target = allowed destinations (wider for 'day' so jobs can leave the day);
// metrics = the area whose before/after we report. null end = unbounded forward.
export interface ScopeWindows {
  movableStart: string; movableEnd: string | null
  targetStart: string;  targetEnd: string | null
  metricsStart: string; metricsEnd: string | null
}

function mondayOf(d: Date): Date {
  return addDays(d, -((getDay(d) + 6) % 7)) // ISO week start (Mon)
}

export function scopeWindows(scope: OptimizeScope, anchorISO: string, todayISO: string): ScopeWindows {
  const a = parseISO(anchorISO)
  const iso = (d: Date) => format(d, 'yyyy-MM-dd')
  if (scope === 'future') {
    return { movableStart: todayISO, movableEnd: null, targetStart: todayISO, targetEnd: null, metricsStart: todayISO, metricsEnd: null }
  }
  if (scope === 'day') {
    // The day itself is movable; targets spill into its ISO week so jobs can
    // leave an overloaded day. Metrics report just the day.
    const mon = mondayOf(a)
    return {
      movableStart: anchorISO, movableEnd: anchorISO,
      targetStart: iso(mon), targetEnd: iso(addDays(mon, 6)),
      metricsStart: anchorISO, metricsEnd: anchorISO,
    }
  }
  if (scope === 'weekend') {
    const mon = mondayOf(a)
    const fri = iso(addDays(mon, 4)); const sun = iso(addDays(mon, 6))
    return { movableStart: fri, movableEnd: sun, targetStart: fri, targetEnd: sun, metricsStart: fri, metricsEnd: sun }
  }
  if (scope === 'week') {
    const mon = mondayOf(a); const sun = iso(addDays(mon, 6))
    return { movableStart: iso(mon), movableEnd: sun, targetStart: iso(mon), targetEnd: sun, metricsStart: iso(mon), metricsEnd: sun }
  }
  // month
  const first = new Date(a.getFullYear(), a.getMonth(), 1)
  const last = new Date(a.getFullYear(), a.getMonth() + 1, 0)
  return { movableStart: iso(first), movableEnd: iso(last), targetStart: iso(first), targetEnd: iso(last), metricsStart: iso(first), metricsEnd: iso(last) }
}

const SCOPE_LABELS: Record<OptimizeScope, string> = {
  day: 'this day', weekend: 'this weekend', week: 'this week', month: 'this month', future: 'all future work',
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
  scope: OptimizeScope
  before: ScheduleMetrics
  after: ScheduleMetrics
  moves: PlannedMove[]
  daysAffected: number
  kmSaved: number
  minutesSaved: number
  movableCount: number
  lockedTimes: number    // future jobs left alone because they have a set start time
  lockedBilled: number   // future jobs left alone because they're already invoiced
  stableKept: number     // recurring customers kept on their established weekday
  reasons: string[]      // plain-language WHY this is better
}

// ── Rain delay planning ──────────────────────────────────────────────────────
// Redistribute one rained-out day across the NEXT preferred work days, capacity-
// aware and series-safe. Same locks as the optimizer (billed jobs never move);
// jobs with a set start time DO move (rain forces it) but are flagged so the
// owner confirms with the customer.

export interface RainDayPlan {
  date: string
  jobs: number
  revenue: number
  laborMin: number
}

export interface RainMove extends PlannedMove { hasSetTime: boolean }

export interface RainTargetDay {
  date: string
  beforeMin: number   // existing load (labor+drive)
  afterMin: number    // load after absorbing moved jobs
  beforeKm: number
  afterKm: number
  added: number
  overCapacity: boolean
}

export interface RainDelayPlan {
  day: RainDayPlan
  moves: RainMove[]
  unmovable: { jobId: string; title: string; customerName: string; reason: string }[]
  targets: RainTargetDay[]
  driveKmBefore: number   // delayed day's route km that disappears
  driveKmAfter: number    // extra km added across target days
}

export function planRainDelay(jobs: OptJob[], dayISO: string, opts: Omit<OptOptions, 'mode' | 'scope' | 'anchorDate'>): RainDelayPlan {
  const capMin = (opts.capacityHours > 0 ? opts.capacityHours : 8) * 60
  const prefSet = opts.preferredDays.length ? new Set(opts.preferredDays) : null

  const dayJobs = jobs.filter(j => j.scheduled_date === dayISO && j.status !== 'cancelled' && j.status !== 'completed')
  const movable = dayJobs.filter(j => !j.invoiced)
  const billed = dayJobs.filter(j => j.invoiced)

  // Next-visit ceiling per series: a bumped visit must stay BEFORE its next sibling.
  const nextSibling = (j: OptJob): string | null => {
    if (!j.recurrence_id) return null
    const later = jobs
      .filter(x => x.recurrence_id === j.recurrence_id && x.id !== j.id && x.status !== 'cancelled' && x.scheduled_date > dayISO)
      .map(x => x.scheduled_date).sort()
    return later[0] ?? null
  }

  // Candidate target days: next preferred work days after the rained-out day.
  const targetDates: string[] = []
  let d = addDays(parseISO(dayISO), 1)
  for (let i = 0; i < 21 && targetDates.length < 5; i++) {
    if (!prefSet || prefSet.has(getDay(d))) targetDates.push(format(d, 'yyyy-MM-dd'))
    d = addDays(d, 1)
  }

  // Existing load per target day (all non-cancelled jobs already there).
  const existing = new Map<string, OptJob[]>()
  for (const t of targetDates) existing.set(t, jobs.filter(j => j.scheduled_date === t && j.status !== 'cancelled'))
  const loadOf = (list: { duration_minutes: number | null; lat: number | null; lng: number | null }[]) => {
    const labor = list.reduce((s, j) => s + (j.duration_minutes || DEFAULT_JOB_MIN), 0)
    const located = list.filter(j => j.lat != null && j.lng != null).map(j => ({ lat: j.lat as number, lng: j.lng as number }))
    const km = opts.base ? routeKmEstimate(opts.base, located) : clusterKmEstimate(located)
    return { labor, km, total: labor + Math.round(km / AVG_SPEED_KM_PER_MIN) }
  }

  // Greedy fill: keep route order, pour into the first target day with capacity
  // room (and before the series' next visit); overflow rolls to later days.
  const assignedTo = new Map<string, OptJob[]>()
  for (const t of targetDates) assignedTo.set(t, [])
  const moves: RainMove[] = []
  const unmovable: RainDelayPlan['unmovable'] = []

  for (const j of [...movable].sort((a, b) => (a.start_time || '99').localeCompare(b.start_time || '99'))) {
    const ceiling = nextSibling(j)
    let placed = false
    for (const t of targetDates) {
      if (ceiling && t >= ceiling) break // any later day is past the next visit too
      const current = loadOf([...existing.get(t)!, ...assignedTo.get(t)!])
      const jobMin = (j.duration_minutes || DEFAULT_JOB_MIN) + 10
      if (current.total + jobMin > capMin && targetDates.some(t2 => t2 > t && (!ceiling || t2 < ceiling))) continue
      assignedTo.get(t)!.push(j)
      moves.push({ jobId: j.id, title: j.title, customerName: j.customerName, from: dayISO, to: t, value: j.value, recurring: !!j.recurrence_id, hasSetTime: !!j.start_time })
      placed = true
      break
    }
    if (!placed) unmovable.push({ jobId: j.id, title: j.title, customerName: j.customerName, reason: ceiling ? `next visit is ${ceiling} — skip this one instead` : 'no capacity in range' })
  }
  for (const j of billed) unmovable.push({ jobId: j.id, title: j.title, customerName: j.customerName, reason: 'already invoiced' })

  const dayLoadNow = loadOf(dayJobs)
  const targets: RainTargetDay[] = targetDates
    .filter(t => assignedTo.get(t)!.length > 0)
    .map(t => {
      const before = loadOf(existing.get(t)!)
      const after = loadOf([...existing.get(t)!, ...assignedTo.get(t)!])
      return {
        date: t, beforeMin: before.total, afterMin: after.total,
        beforeKm: Math.round(before.km * 10) / 10, afterKm: Math.round(after.km * 10) / 10,
        added: assignedTo.get(t)!.length, overCapacity: after.total > capMin,
      }
    })

  return {
    day: {
      date: dayISO,
      jobs: dayJobs.length,
      revenue: Math.round(dayJobs.reduce((s, j) => s + j.value, 0)),
      laborMin: dayJobs.reduce((s, j) => s + (j.duration_minutes || DEFAULT_JOB_MIN), 0),
    },
    moves, unmovable, targets,
    driveKmBefore: Math.round(dayLoadNow.km * 10) / 10,
    driveKmAfter: Math.round(targets.reduce((s, t) => s + (t.afterKm - t.beforeKm), 0) * 10) / 10,
  }
}

// Mode weights — all terms expressed in MINUTES so they compose meaningfully.
// over    = minutes beyond daily capacity (heavily penalized everywhere),
// spread  = stddev of active-day total minutes (workload balance),
// days    = per-active-day overhead (consolidation pressure — fewer base trips),
// cluster = extra distinct neighborhood-cells per day (route-ownership pressure),
// stability = penalty for moving a recurring customer off their established day.
//
// Modes (owner-facing names): Max Profit (revenue), Max Density (density),
// Balanced Workload (balanced), Smart Recommended (recommended).
const WEIGHTS: Record<OptimizeMode, { km: number; over: number; spread: number; days: number; cluster: number; stability: number }> = {
  // Max Density: drive as little as possible, tightest routes.
  density:     { km: 1.2, over: 1.0, spread: 0.0, days: 0.2, cluster: 0.6, stability: 0.4 },
  // Balanced Workload: even hours, no overloaded days.
  balanced:    { km: 0.3, over: 2.5, spread: 1.4, days: 0.0, cluster: 0.2, stability: 0.5 },
  // Max Profit: revenue per hour — cut drive time, fill strong clusters first.
  revenue:     { km: 0.8, over: 2.0, spread: 0.0, days: 0.9, cluster: 0.9, stability: 0.5 },
  // Smart Recommended: best overall blend incl. customer convenience (stability).
  recommended: { km: 0.8, over: 1.6, spread: 0.5, days: 0.4, cluster: 0.5, stability: 0.8 },
}
const DAY_OVERHEAD_MIN = 45  // proxy cost of opening another working day
const CLUSTER_CELL_MIN = 25  // proxy cost of an extra neighborhood-cell on a day
const STABILITY_MIN = 40     // proxy cost of moving a recurring customer off their day
const CLUSTER_GRID = 80      // ~1.4 km cells: round lat/lng × this, floor, ÷ back

function cellKey(lat: number, lng: number): string {
  return `${Math.round(lat * CLUSTER_GRID)},${Math.round(lng * CLUSTER_GRID)}`
}

// How far a visit may shift without breaking its cadence promise.
function moveWindowDays(j: OptJob, recs: OptOptions['recurrences']): number {
  if (!j.recurrence_id) return 6
  const r = recs[j.recurrence_id]
  const f = r ? effectiveFreq(r.freq, r.interval_unit, r.interval_count) : null
  return f === 'weekly' ? 2 : f === 'biweekly' ? 3 : 4
}

interface DayEval { driveMin: number; laborMin: number; km: number; totalMin: number; cells: number }

export function optimizeSchedule(jobs: OptJob[], opts: OptOptions): OptimizationResult {
  const capMin = (opts.capacityHours > 0 ? opts.capacityHours : 8) * 60
  const prefSet = opts.preferredDays.length ? new Set(opts.preferredDays) : null
  const w = WEIGHTS[opts.mode]
  const win = scopeWindows(opts.scope, opts.anchorDate, opts.today)
  const inTarget = (date: string) => date >= win.targetStart && (win.targetEnd == null || date <= win.targetEnd)
  const inMovable = (date: string) => date >= win.movableStart && (win.movableEnd == null || date <= win.movableEnd)
  const inMetrics = (date: string) => date >= win.metricsStart && (win.metricsEnd == null || date <= win.metricsEnd)

  // Established weekday per recurring series — the dominant day across ALL its
  // visits (past + future, completed included), so "this customer has been on
  // Fridays for months" is known. Route stability protects this.
  const estWeekday: Record<string, number> = {}
  {
    const dows: Record<string, Record<number, number>> = {}
    for (const j of jobs) {
      if (!j.recurrence_id || j.status === 'cancelled') continue
      const d = getDay(parseISO(j.scheduled_date))
      ;(dows[j.recurrence_id] ||= {})[d] = ((dows[j.recurrence_id] ||= {})[d] || 0) + 1
    }
    for (const rid in dows) {
      const top = Object.entries(dows[rid]).sort((a, b) => b[1] - a[1])[0]
      if (top) estWeekday[rid] = Number(top[0])
    }
  }

  // Search universe: non-cancelled jobs whose date falls in the target window —
  // these shape each day's route. Movability is gated separately (below).
  const universe = jobs.filter(j => j.status !== 'cancelled' && inTarget(j.scheduled_date))
  const lockedTimes = universe.filter(j => j.scheduled_date > opts.today && inMovable(j.scheduled_date) && j.status === 'scheduled' && !j.invoiced && !!j.start_time).length
  const lockedBilled = universe.filter(j => j.scheduled_date > opts.today && inMovable(j.scheduled_date) && j.invoiced).length
  const movable = universe.filter(j => j.scheduled_date > opts.today && inMovable(j.scheduled_date) && j.status === 'scheduled' && !j.invoiced && !j.start_time)

  const assign = new Map<string, string>()
  for (const j of universe) assign.set(j.id, j.scheduled_date)
  const original = new Map(universe.map(j => [j.id, j.scheduled_date]))

  // Series siblings in ORIGINAL order — a moved visit must stay strictly between
  // its neighbours so cadence ordering is never scrambled.
  const seriesJobs: Record<string, OptJob[]> = {}
  for (const j of universe) if (j.recurrence_id) (seriesJobs[j.recurrence_id] ||= []).push(j)
  for (const k in seriesJobs) seriesJobs[k].sort((a, b) => a.scheduled_date.localeCompare(b.scheduled_date))

  const byId = new Map(universe.map(j => [j.id, j]))
  const dayJobs = new Map<string, Set<string>>()
  const addTo = (date: string, id: string) => { (dayJobs.get(date) ?? dayJobs.set(date, new Set()).get(date)!).add(id) }
  for (const j of universe) addTo(j.scheduled_date, j.id)

  // ── Day evaluation (route engine math + cluster cells, cached per day) ──
  const cache = new Map<string, DayEval>()
  function evalDay(date: string): DayEval {
    const hit = cache.get(date)
    if (hit) return hit
    const ids = dayJobs.get(date)
    let laborMin = 0
    const located: { lat: number; lng: number }[] = []
    const cellSet = new Set<string>()
    if (ids) for (const id of ids) {
      const j = byId.get(id)!
      laborMin += j.duration_minutes || DEFAULT_JOB_MIN
      if (j.lat != null && j.lng != null) { located.push({ lat: j.lat, lng: j.lng }); cellSet.add(cellKey(j.lat, j.lng)) }
    }
    const km = opts.base ? routeKmEstimate(opts.base, located) : clusterKmEstimate(located)
    const driveMin = Math.round(km / AVG_SPEED_KM_PER_MIN)
    const e = { driveMin, laborMin, km, totalMin: driveMin + laborMin, cells: cellSet.size }
    cache.set(date, e)
    return e
  }
  const invalidate = (date: string) => cache.delete(date)

  // Stability cost: a recurring movable job sitting OFF its established weekday.
  function stabilityCost(): number {
    let pen = 0
    for (const j of movable) {
      if (!j.recurrence_id) continue
      const est = estWeekday[j.recurrence_id]
      if (est == null) continue
      if (getDay(parseISO(assign.get(j.id)!)) !== est) pen += STABILITY_MIN
    }
    return pen
  }

  function globalCost(): number {
    let drive = 0, over = 0, days = 0, cells = 0
    const totals: number[] = []
    for (const [date, ids] of dayJobs) {
      if (ids.size === 0) continue
      const e = evalDay(date)
      drive += e.driveMin
      over += Math.max(0, e.totalMin - capMin)
      days++
      cells += Math.max(0, e.cells - 1) // first cell is free; extras cost
      totals.push(e.totalMin)
    }
    let spread = 0
    if (totals.length > 1) {
      const mean = totals.reduce((a, b) => a + b, 0) / totals.length
      spread = Math.sqrt(totals.reduce((s, t) => s + (t - mean) ** 2, 0) / totals.length)
    }
    return w.km * drive + w.over * over + w.spread * spread
      + w.days * days * DAY_OVERHEAD_MIN + w.cluster * cells * CLUSTER_CELL_MIN
      + w.stability * stabilityCost()
  }

  // Candidate dates: inside cadence window AND the scope's TARGET window, on a
  // preferred work day, strictly future, keeping series order intact.
  function candidates(j: OptJob): string[] {
    const wd = moveWindowDays(j, opts.recurrences)
    const origin = parseISO(original.get(j.id)!)
    const out: string[] = []
    const sibs = j.recurrence_id ? seriesJobs[j.recurrence_id] : null
    const idx = sibs ? sibs.findIndex(s => s.id === j.id) : -1
    const prevDate = sibs && idx > 0 ? assign.get(sibs[idx - 1].id)! : null
    const nextDate = sibs && idx >= 0 && idx < sibs.length - 1 ? assign.get(sibs[idx + 1].id)! : null
    for (let d = -wd; d <= wd; d++) {
      if (d === 0) continue
      const date = format(addDays(origin, d), 'yyyy-MM-dd')
      if (date <= opts.today) continue
      if (!inTarget(date)) continue
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

  // Metrics report only the days in the scope's METRICS window.
  const metricsNow = (): ScheduleMetrics => {
    let km = 0, drive = 0, labor = 0, days = 0, stops = 0, over = 0, revenue = 0
    for (const [date, ids] of dayJobs) {
      if (ids.size === 0 || !inMetrics(date)) continue
      const e = evalDay(date)
      km += e.km; drive += e.driveMin; labor += e.laborMin; days++; stops += ids.size
      if (e.totalMin > capMin) over++
      for (const id of ids) revenue += byId.get(id)!.value
    }
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

  // ── Greedy best-improvement search until stable ──
  let cost = globalCost()
  const MIN_GAIN = 1
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
        applyMove(j.id, fromDate)
      }
      if (bestDate) { applyMove(j.id, bestDate); cost = bestCost; improved = true }
    }
    if (!improved) break
  }

  const after = metricsNow()
  const moves: PlannedMove[] = []
  let groupedIntoCluster = 0
  const strengthenedHoods = new Set<string>()
  for (const j of movable) {
    const from = original.get(j.id)!
    const to = assign.get(j.id)!
    if (from === to) continue
    moves.push({ jobId: j.id, title: j.title, customerName: j.customerName, from, to, value: j.value, recurring: !!j.recurrence_id })
    // Did this land in an existing cluster (same cell already on the target day)?
    if (j.lat != null && j.lng != null) {
      const cell = cellKey(j.lat, j.lng)
      const peers = [...(dayJobs.get(to) ?? [])].some(id => {
        if (id === j.id) return false
        const o = byId.get(id)!
        return o.lat != null && o.lng != null && cellKey(o.lat, o.lng) === cell
      })
      if (peers) { groupedIntoCluster++; if (j.neighborhood) strengthenedHoods.add(j.neighborhood) }
    }
  }
  moves.sort((a, b) => a.to.localeCompare(b.to))
  const daysAffected = new Set(moves.flatMap(m => [m.from, m.to])).size
  const stableKept = movable.filter(j => j.recurrence_id && estWeekday[j.recurrence_id] != null
    && getDay(parseISO(assign.get(j.id)!)) === estWeekday[j.recurrence_id]).length

  const kmSaved = Math.round((before.totalKm - after.totalKm) * 10) / 10
  const minutesSaved = before.driveMinutes - after.driveMinutes
  const reasons = buildReasons({
    moves: moves.length, kmSaved, minutesSaved, before, after, groupedIntoCluster,
    strengthenedHoods: [...strengthenedHoods], stableKept, mode: opts.mode, scope: opts.scope,
  })

  return {
    mode: opts.mode, scope: opts.scope,
    before, after, moves, daysAffected, kmSaved, minutesSaved,
    movableCount: movable.length, lockedTimes, lockedBilled, stableKept, reasons,
  }
}

function fmtDur(min: number): string {
  return min >= 60 ? `${Math.round((min / 60) * 10) / 10}h` : `${min}m`
}

// ── Proactive auto-suggestions ────────────────────────────────────────────────
// Owner-style observations that surface on the Schedule page WITHOUT opening the
// optimizer: overloaded days, isolated jobs that belong in a cluster, and
// recurring customers who'd strengthen a route by shifting day. Each suggestion
// carries the scope/mode to fix it in one click. Bounded work — a few scoped
// optimize runs at most.

export interface ScheduleSuggestion {
  id: string
  kind: 'overload' | 'cluster' | 'recurring'
  severity: 'high' | 'medium'
  title: string
  detail: string
  scope: OptimizeScope
  anchorDate: string
  mode: OptimizeMode
}

export function analyzeSchedule(jobs: OptJob[], base: Omit<OptOptions, 'mode' | 'scope' | 'anchorDate'>): ScheduleSuggestion[] {
  const capMin = (base.capacityHours > 0 ? base.capacityHours : 8) * 60
  const out: ScheduleSuggestion[] = []
  const future = jobs.filter(j => j.scheduled_date > base.today && j.status !== 'cancelled')
  if (future.length === 0) return out

  // Per-day load (route engine math).
  const byDate: Record<string, OptJob[]> = {}
  for (const j of future) (byDate[j.scheduled_date] ||= []).push(j)
  const loadOf = (list: OptJob[]) => {
    const labor = list.reduce((s, j) => s + (j.duration_minutes || DEFAULT_JOB_MIN), 0)
    const located = list.filter(j => j.lat != null && j.lng != null).map(j => ({ lat: j.lat as number, lng: j.lng as number }))
    const km = base.base ? routeKmEstimate(base.base, located) : clusterKmEstimate(located)
    return { total: labor + Math.round(km / AVG_SPEED_KM_PER_MIN) }
  }

  // 1) Overloaded days — run a week-scoped balanced fix to quantify the win.
  const overloaded = Object.entries(byDate)
    .map(([date, list]) => ({ date, over: loadOf(list).total - capMin, count: list.length }))
    .filter(d => d.over > 20)
    .sort((a, b) => a.date.localeCompare(b.date))
    .slice(0, 3)
  for (const d of overloaded) {
    const res = optimizeSchedule(jobs, { ...base, mode: 'balanced', scope: 'week', anchorDate: d.date })
    const dayName = format(parseISO(d.date + 'T00:00:00'), 'EEEE')
    const fixed = res.after.overloadedDays < res.before.overloadedDays
    const moved = res.moves.length
    out.push({
      id: `overload-${d.date}`, kind: 'overload', severity: 'high',
      title: `${dayName} is overloaded by ${fmtDur(d.over)}.`,
      detail: moved > 0
        ? `Moving ${moved} job${moved !== 1 ? 's' : ''} would save ${res.kmSaved > 0 ? `${res.kmSaved} km and ` : ''}${fixed ? 'bring the day under capacity' : 'ease the day'}.`
        : `Consider moving a job to a lighter day, or splitting the route.`,
      scope: 'week', anchorDate: d.date, mode: 'balanced',
    })
  }

  // 2) Isolated jobs — located future jobs whose cluster cell holds ≥3 jobs over
  // the next weeks but that sit alone on their own day.
  const cellDays: Record<string, Set<string>> = {}
  const cellCount: Record<string, number> = {}
  for (const j of future) {
    if (j.lat == null || j.lng == null) continue
    const c = cellKey(j.lat, j.lng)
    ;(cellDays[c] ||= new Set()).add(j.scheduled_date)
    cellCount[c] = (cellCount[c] || 0) + 1
  }
  let isolated = 0
  for (const j of future) {
    if (j.lat == null || j.lng == null) continue
    const c = cellKey(j.lat, j.lng)
    const alone = byDate[j.scheduled_date].filter(o => o.lat != null && o.lng != null && cellKey(o.lat, o.lng) === c).length === 1
    if (alone && cellCount[c] >= 3 && cellDays[c].size > 1) isolated++
  }
  if (isolated >= 2) {
    out.push({
      id: 'cluster-merge', kind: 'cluster', severity: 'medium',
      title: `${isolated} isolated jobs could merge into existing clusters.`,
      detail: 'Grouping them onto their cluster day cuts driving and tightens routes.',
      scope: 'future', anchorDate: base.today, mode: 'density',
    })
  }

  // 3) Recurring-into-cluster — a recurring customer alone in their area on their
  // day, while that area has a cluster on another nearby day.
  for (const j of future) {
    if (out.filter(s => s.kind === 'recurring').length >= 1) break
    if (!j.recurrence_id || j.lat == null || j.lng == null) continue
    const c = cellKey(j.lat, j.lng)
    const alone = byDate[j.scheduled_date].filter(o => o.lat != null && o.lng != null && cellKey(o.lat, o.lng) === c).length === 1
    if (!alone) continue
    // Another day (within ~a week) where this cell clusters (≥2 jobs).
    let clusterDay: string | null = null
    for (const [date, list] of Object.entries(byDate)) {
      if (date === j.scheduled_date) continue
      if (Math.abs(parseISO(date).getTime() - parseISO(j.scheduled_date).getTime()) > 8 * 86400000) continue
      const here = list.filter(o => o.lat != null && o.lng != null && cellKey(o.lat, o.lng) === c).length
      if (here >= 2) { clusterDay = date; break }
    }
    if (clusterDay) {
      const fromName = format(parseISO(j.scheduled_date + 'T00:00:00'), 'EEEE')
      const toName = format(parseISO(clusterDay + 'T00:00:00'), 'EEEE')
      const area = j.neighborhood ? `your ${j.neighborhood} route` : 'that route'
      out.push({
        id: `recurring-${j.id}`, kind: 'recurring', severity: 'medium',
        title: `Moving ${j.customerName} from ${fromName} to ${toName} would strengthen ${area}.`,
        detail: 'They sit alone now, but that area already clusters on the other day.',
        scope: 'week', anchorDate: j.scheduled_date, mode: 'density',
      })
    }
  }

  return out
}

// Plain-language WHY — an owner wants to know what changed and that it's safe.
function buildReasons(x: {
  moves: number; kmSaved: number; minutesSaved: number
  before: ScheduleMetrics; after: ScheduleMetrics
  groupedIntoCluster: number; strengthenedHoods: string[]; stableKept: number
  mode: OptimizeMode; scope: OptimizeScope
}): string[] {
  if (x.moves === 0) return [`Your ${SCOPE_LABELS[x.scope]} is already well optimized for this goal — nothing worth moving.`]
  const r: string[] = []
  if (x.kmSaved > 0 || x.minutesSaved > 0) {
    const parts = [x.kmSaved > 0 ? `${x.kmSaved} km` : null, x.minutesSaved > 0 ? `${fmtDur(x.minutesSaved)} of driving` : null].filter(Boolean)
    r.push(`Cuts ${parts.join(' and ')}.`)
  }
  if (x.before.overloadedDays > x.after.overloadedDays) {
    const n = x.before.overloadedDays - x.after.overloadedDays
    r.push(`Brings ${n} overloaded day${n !== 1 ? 's' : ''} back under capacity.`)
  }
  if (x.groupedIntoCluster > 0) {
    const hoods = x.strengthenedHoods.length ? ` — strengthens your ${x.strengthenedHoods.slice(0, 2).join(' & ')} route${x.strengthenedHoods.length > 1 ? 's' : ''}` : ''
    r.push(`Groups ${x.groupedIntoCluster} job${x.groupedIntoCluster !== 1 ? 's' : ''} into existing clusters${hoods}.`)
  }
  if (x.after.revPerHour > x.before.revPerHour) {
    r.push(`Lifts revenue per hour from $${x.before.revPerHour} to $${x.after.revPerHour}.`)
  }
  if (x.mode === 'balanced' && x.after.activeDays !== x.before.activeDays) {
    r.push('Spreads the work more evenly across your days.')
  }
  if (x.stableKept > 0) {
    r.push(`Keeps ${x.stableKept} recurring customer${x.stableKept !== 1 ? 's' : ''} on their usual day.`)
  }
  return r.length ? r : ['Tightens your routes with minimal disruption.']
}
