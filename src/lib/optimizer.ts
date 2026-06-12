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
  customerId: string | null    // groups a customer's visits into one timeline
  neighborhood?: string | null // real area name, for cluster-aware reasons
  // Resolved scheduling preferences (customer default + property override). The
  // optimizer never moves a visit onto an avoid day, and is nudged toward the
  // customer's preferred weekdays. getDay indices; empty/undefined = no preference.
  preferredDays?: number[] | null
  avoidDays?: number[] | null
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
  // Set when the move lands the job onto a day its area already clusters (a peer
  // in the same grid cell). Lets the proactive cards report REAL, validated
  // cluster merges instead of a raw heuristic count.
  groupsCluster?: boolean
  clusterNeighborhood?: string | null
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
  groupedIntoCluster: number // moves that landed a job onto an existing cluster
  blockedMoves: number   // candidate moves rejected to protect recurring series
  warnings: string[]     // pre-Apply safety notes (series conflicts avoided/blocked)
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
// Priority order (owner): cadence > weekday stability > workload > driving >
// revenue. Cadence is a HARD constraint (validated, never weighted). Stability
// is weighted ABOVE the workload terms in every mode so a customer's established
// day is protected unless the gain is large. Week-crossing is penalised heavily
// so balancing stays within the day/weekend/week before reaching into future weeks.
const WEIGHTS: Record<OptimizeMode, { km: number; over: number; spread: number; days: number; cluster: number; stability: number; weekCross: number; pref: number }> = {
  // Max Density: drive as little as possible, tightest routes.
  density:     { km: 1.2, over: 1.0, spread: 0.0, days: 0.2, cluster: 0.6, stability: 1.0, weekCross: 1.5, pref: 1.0 },
  // Balanced Workload: even hours, no overloaded days.
  balanced:    { km: 0.3, over: 2.5, spread: 1.4, days: 0.0, cluster: 0.2, stability: 1.6, weekCross: 1.5, pref: 1.2 },
  // Max Profit: revenue per hour — cut drive time, fill strong clusters first.
  revenue:     { km: 0.8, over: 2.0, spread: 0.0, days: 0.9, cluster: 0.9, stability: 1.2, weekCross: 1.5, pref: 1.0 },
  // Smart Recommended: best overall blend incl. customer convenience (stability + prefs).
  recommended: { km: 0.7, over: 1.6, spread: 0.6, days: 0.4, cluster: 0.5, stability: 1.8, weekCross: 2.0, pref: 1.5 },
}
const DAY_OVERHEAD_MIN = 45  // proxy cost of opening another working day
const CLUSTER_CELL_MIN = 25  // proxy cost of an extra neighborhood-cell on a day
const STABILITY_MIN = 40     // proxy cost of moving a recurring customer off their day
const WEEK_CROSS_MIN = 90    // proxy cost of moving a job out of its original week
const PREF_MIN = 50          // proxy cost of a visit sitting off the customer's preferred day
const CLUSTER_GRID = 80      // ~1.4 km cells: round lat/lng × this, floor, ÷ back

function cellKey(lat: number, lng: number): string {
  return `${Math.round(lat * CLUSTER_GRID)},${Math.round(lng * CLUSTER_GRID)}`
}

// The recurrence-rule lookup shape shared by the optimizer AND the manual
// scheduling guards (drag-drop, job-form date picker).
export type CadenceRecs = Record<string, { freq: string | null; interval_unit: string | null; interval_count: number | null }>

// Cadence interval in days (for spacing validation). Falls back to weekly.
export function cadenceDaysFor(recurrenceId: string | null, recs: CadenceRecs): number {
  if (!recurrenceId) return 7
  const r = recs[recurrenceId]
  if (r?.interval_unit === 'day') return Math.max(1, r.interval_count ?? 1)
  if (r?.interval_unit === 'week') return 7 * Math.max(1, r.interval_count ?? 1)
  if (r?.interval_unit === 'month') return 30 * Math.max(1, r.interval_count ?? 1)
  const f = r ? effectiveFreq(r.freq, r.interval_unit, r.interval_count) : null
  return f === 'weekly' ? 7 : f === 'biweekly' ? 14 : f === 'monthly' ? 30 : 7
}

// The minimum spacing (days) a visit must keep from its nearest sibling on either
// side — the cadence "floor" used to reject collisions/compression. 60% of the
// nominal interval, never below 2 days. ONE definition for optimizer + manual.
export function cadenceFloorFor(recurrenceId: string | null, recs: CadenceRecs): number {
  return Math.max(2, Math.round(cadenceDaysFor(recurrenceId, recs) * 0.6))
}

// How far a visit may shift without breaking its cadence promise.
function moveWindowDays(j: OptJob, recs: CadenceRecs): number {
  if (!j.recurrence_id) return 6
  const r = recs[j.recurrence_id]
  const f = r ? effectiveFreq(r.freq, r.interval_unit, r.interval_count) : null
  return f === 'weekly' ? 2 : f === 'biweekly' ? 3 : 4
}

// One timeline key for a job: same customer (or, lacking that, same series) groups
// every visit so hand-made weekly visits are protected alongside real series.
export function cadenceGroupKey(j: { id: string; customerId: string | null; recurrence_id: string | null }): string {
  return j.customerId ? `c:${j.customerId}` : j.recurrence_id ? `r:${j.recurrence_id}` : `j:${j.id}`
}

const diffDaysISO = (a: string, b: string) => Math.round((parseISO(b).getTime() - parseISO(a).getTime()) / 86400000)

// ── Manual-move cadence guard ─────────────────────────────────────────────────
// The SAME timeline check the optimizer enforces, exposed for hand scheduling
// (drag-drop + the job-form date picker). Given a visit moving onto `toDate`,
// look at the customer's whole set of other visits and report whether the move
// collides (two visits same day) or compresses cadence (lands inside the floor
// gap of a neighbour). Returns a soft, owner-facing message — manual edits are
// never blocked, only warned.
export interface CadenceVisit {
  id: string
  scheduled_date: string
  status: string
  customerId: string | null
  recurrence_id: string | null
  customerName?: string | null
}

export interface ManualCadenceResult {
  status: 'ok' | 'warn' | 'collision'
  message: string | null
}

export function manualCadenceCheck(
  move: { id: string; customerId: string | null; recurrence_id: string | null },
  toDate: string,
  allVisits: CadenceVisit[],
  recs: CadenceRecs,
): ManualCadenceResult {
  const key = cadenceGroupKey(move)
  const mates = allVisits.filter(v => v.id !== move.id && v.status !== 'cancelled' && cadenceGroupKey(v) === key)
  if (mates.length === 0) return { status: 'ok', message: null }

  const floor = cadenceFloorFor(move.recurrence_id, recs)
  let prev: { gap: number; v: CadenceVisit } | null = null
  let next: { gap: number; v: CadenceVisit } | null = null
  let sameDay: CadenceVisit | null = null
  for (const m of mates) {
    const diff = diffDaysISO(m.scheduled_date, toDate) // (toDate − mate) in days
    if (diff === 0) { sameDay = m; continue }
    if (diff > 0) { if (!prev || diff < prev.gap) prev = { gap: diff, v: m } }
    else { const g = -diff; if (!next || g < next.gap) next = { gap: g, v: m } }
  }

  const nameOf = (v: CadenceVisit) => v.customerName?.trim() || 'this customer'
  const dayLabel = (iso: string) => format(parseISO(iso + 'T00:00:00'), 'EEE, MMM d')
  if (sameDay) {
    return { status: 'collision', message: `${nameOf(sameDay)} already has a visit on ${dayLabel(sameDay.scheduled_date)} — this would book two on the same day.` }
  }
  const tooClosePrev = prev && prev.gap < floor
  const tooCloseNext = next && next.gap < floor
  if (tooClosePrev || tooCloseNext) {
    const nearer = tooCloseNext && (!tooClosePrev || next!.gap <= prev!.gap) ? next! : prev!
    const dir = nearer === next ? 'before' : 'after'
    const nominal = cadenceDaysFor(move.recurrence_id, recs)
    return {
      status: 'warn',
      message: `This lands ${nearer.gap} day${nearer.gap !== 1 ? 's' : ''} ${dir} ${nameOf(nearer.v)}'s ${dayLabel(nearer.v.scheduled_date)} visit — usual spacing is ~${nominal} days. Break cadence?`,
    }
  }
  return { status: 'ok', message: null }
}

// ISO-week key (year-week) for a date, for the week-crossing penalty.
function isoWeekKey(dateISO: string): string {
  const d = parseISO(dateISO)
  const mon = addDays(d, -((getDay(d) + 6) % 7))
  return format(mon, 'yyyy-MM-dd')
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
  const origWeek = new Map([...movable].map(j => [j.id, isoWeekKey(j.scheduled_date)]))

  // ── Recurring-series integrity ──
  // A customer's visits are ONE timeline, validated across the WHOLE schedule —
  // every job, every week, linked by recurrence_id OR just same customer (so
  // hand-made weekly visits are protected too). Out-of-window visits are fixed
  // anchors; in-window ones move. This is what stops a move from colliding with,
  // skipping, or doubling up against another visit of the same customer.
  const customerKeyOf = (j: OptJob) => j.customerId ? `c:${j.customerId}` : j.recurrence_id ? `r:${j.recurrence_id}` : `j:${j.id}`
  const groups: Record<string, OptJob[]> = {}
  for (const j of jobs) {
    if (j.status === 'cancelled') continue
    ;(groups[customerKeyOf(j)] ||= []).push(j)
  }
  const matesByJobId = new Map<string, OptJob[]>()
  for (const j of movable) matesByJobId.set(j.id, (groups[customerKeyOf(j)] || []).filter(m => m.id !== j.id))

  const byId = new Map(universe.map(j => [j.id, j]))
  // Current date of any visit: its live assignment if in the search universe,
  // else its fixed scheduled_date (past, future-out-of-window, or locked).
  const currentDateOf = (m: OptJob) => assign.get(m.id) ?? m.scheduled_date

  // Is moving job j onto `to` valid for the customer's whole timeline?
  // Rules: no visit on the same day (duplicate/double-week), and at least the
  // cadence floor of days from the nearest visit on either side (no compression,
  // no skipped/doubled week, never crossing into the next occurrence).
  function validCadence(j: OptJob, to: string): boolean {
    const mates = matesByJobId.get(j.id)
    if (!mates || mates.length === 0) return true
    const floor = cadenceFloorFor(j.recurrence_id, opts.recurrences)
    let prevGap = Infinity, nextGap = Infinity
    for (const m of mates) {
      const diff = diffDaysISO(currentDateOf(m), to) // (to − mate) in days
      if (diff === 0) return false                // same-day collision
      if (diff > 0) prevGap = Math.min(prevGap, diff)
      else nextGap = Math.min(nextGap, -diff)
    }
    return prevGap >= floor && nextGap >= floor
  }
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

  // Stability cost: a recurring movable job sitting OFF its established weekday,
  // PLUS a strong penalty for any job pushed out of its original week (keeps
  // balancing within day/weekend/week before reaching into future weeks).
  function stabilityCost(): number {
    let pen = 0
    for (const j of movable) {
      if (j.recurrence_id) {
        const est = estWeekday[j.recurrence_id]
        if (est != null && getDay(parseISO(assign.get(j.id)!)) !== est) pen += STABILITY_MIN
      }
    }
    return pen
  }
  function weekCrossCost(): number {
    let pen = 0
    for (const j of movable) {
      if (isoWeekKey(assign.get(j.id)!) !== origWeek.get(j.id)) pen += WEEK_CROSS_MIN
    }
    return pen
  }
  // Customer scheduling preferences: a movable visit landing on an avoid day is
  // penalised hard; landing off the customer's preferred set is a soft nudge. So
  // the optimizer pulls visits TOWARD stated promises (and off avoided days).
  function prefCost(): number {
    let pen = 0
    for (const j of movable) {
      const wd = getDay(parseISO(assign.get(j.id)!))
      if (j.avoidDays && j.avoidDays.includes(wd)) pen += PREF_MIN * 2
      else if (j.preferredDays && j.preferredDays.length && !j.preferredDays.includes(wd)) pen += PREF_MIN
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
      + w.stability * stabilityCost() + w.weekCross * weekCrossCost() + w.pref * prefCost()
  }

  // Candidate dates: inside the cadence jitter window AND the scope's TARGET
  // window, on a preferred work day, strictly future, and HARD-validated against
  // the customer's entire visit timeline (no collisions, no cadence violations).
  function candidates(j: OptJob): string[] {
    const wd = moveWindowDays(j, opts.recurrences)
    const origin = parseISO(original.get(j.id)!)
    const out: string[] = []
    for (let d = -wd; d <= wd; d++) {
      if (d === 0) continue
      const date = format(addDays(origin, d), 'yyyy-MM-dd')
      if (date <= opts.today) continue
      if (!inTarget(date)) continue
      if (date === assign.get(j.id)) continue
      if (prefSet && !prefSet.has(getDay(parseISO(date)))) continue
      if (j.avoidDays && j.avoidDays.includes(getDay(parseISO(date)))) continue // never move onto a customer's avoid day
      if (!validCadence(j, date)) continue // series integrity — the key guard
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

  // ── Pre-Apply safety gate ──
  // Re-validate every proposed move against the FINAL whole-schedule timeline and
  // revert any that would conflict with a recurring visit. The search already
  // rejects invalid candidates, so this is a defensive backstop that GUARANTEES
  // no move ever creates a duplicate, skipped, doubled or cadence-violating visit.
  let blockedMoves = 0
  for (const j of movable) {
    const to = assign.get(j.id)!
    if (to === original.get(j.id)!) continue
    if (!validCadence(j, to)) { applyMove(j.id, original.get(j.id)!); blockedMoves++ }
  }

  const after = metricsNow()
  const moves: PlannedMove[] = []
  let groupedIntoCluster = 0
  const strengthenedHoods = new Set<string>()
  for (const j of movable) {
    const from = original.get(j.id)!
    const to = assign.get(j.id)!
    if (from === to) continue
    const move: PlannedMove = { jobId: j.id, title: j.title, customerName: j.customerName, from, to, value: j.value, recurring: !!j.recurrence_id }
    // Did this land in an existing cluster (same cell already on the target day)?
    if (j.lat != null && j.lng != null) {
      const cell = cellKey(j.lat, j.lng)
      const peers = [...(dayJobs.get(to) ?? [])].some(id => {
        if (id === j.id) return false
        const o = byId.get(id)!
        return o.lat != null && o.lng != null && cellKey(o.lat, o.lng) === cell
      })
      if (peers) {
        groupedIntoCluster++
        move.groupsCluster = true
        move.clusterNeighborhood = j.neighborhood ?? null
        if (j.neighborhood) strengthenedHoods.add(j.neighborhood)
      }
    }
    moves.push(move)
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

  const recurringMoves = moves.filter(m => m.recurring).length
  const warnings: string[] = []
  if (blockedMoves > 0) {
    warnings.push(`${blockedMoves} proposed move${blockedMoves !== 1 ? 's were' : ' was'} blocked — ${blockedMoves !== 1 ? 'they' : 'it'} would conflict with a recurring visit.`)
  }
  if (moves.length > 0) {
    warnings.push(recurringMoves > 0
      ? `All ${moves.length} moves validated against each customer's full schedule — no skipped, doubled or cadence-breaking visits (${recurringMoves} recurring visit${recurringMoves !== 1 ? 's' : ''} kept on cadence).`
      : `All ${moves.length} moves validated — no recurring-series conflicts.`)
  }

  return {
    mode: opts.mode, scope: opts.scope,
    before, after, moves, daysAffected, kmSaved, minutesSaved,
    movableCount: movable.length, lockedTimes, lockedBilled, stableKept,
    groupedIntoCluster, blockedMoves, warnings, reasons,
  }
}

function fmtDur(min: number): string {
  return min >= 60 ? `${Math.round((min / 60) * 10) / 10}h` : `${min}m`
}

// ── Proactive auto-suggestions ────────────────────────────────────────────────
// Owner-style observations that surface on the Schedule page WITHOUT opening the
// optimizer. CRITICAL INVARIANT: every card is backed by a real optimizeSchedule()
// simulation — the SAME function (and the same inputs: prefs, capacity, base,
// recurrences, invoiced locks) the Optimize button runs. A card may only claim a
// move the optimizer would actually make, so the page can never recommend
// something the optimizer immediately calls "already optimized". When a day is
// genuinely overloaded but no legal move exists (cadence / preferences / capacity
// / locks), we show a NON-actionable explanation instead of a dead "Optimize" CTA.

export interface ScheduleSuggestion {
  id: string
  kind: 'overload' | 'cluster' | 'recurring' | 'underutil' | 'stuck'
  severity: 'high' | 'medium'
  title: string
  detail: string
  // actionable = a validated optimizer move exists; the card shows an Optimize CTA
  // wired to the SAME scope/mode/anchor that produced the move. Non-actionable
  // cards are explanations only (no CTA).
  actionable: boolean
  scope: OptimizeScope
  anchorDate: string
  mode: OptimizeMode
}

// Why an overloaded day can't be auto-balanced — derived from the day's own jobs
// against the optimizer's movability rules (mirrors the `movable` gate). Honest
// and specific so the card explains the constraint instead of dead-ending.
function explainStuckDay(dayJobs: OptJob[]): string {
  const movable = dayJobs.filter(j => j.status === 'scheduled' && !j.invoiced && !j.start_time)
  if (movable.length === 0) {
    const billed = dayJobs.some(j => j.invoiced)
    const timed = dayJobs.some(j => !!j.start_time)
    const locks = [billed ? 'already billed' : null, timed ? 'have a committed start time' : null].filter(Boolean).join(' or ')
    return `Every visit that day is ${locks || 'locked'}, so none can be rescheduled. Free one up to rebalance.`
  }
  const reasons: string[] = []
  if (movable.some(j => j.recurrence_id)) reasons.push('held to a recurring cadence')
  if (movable.some(j => j.avoidDays && j.avoidDays.length > 0)) reasons.push('limited by customer day preferences')
  reasons.push('the other work days in range are just as full')
  return `Its visits can't move — ${reasons.join(', ')}. Add capacity or relax a constraint to rebalance.`
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

  // 1) Overloaded days — for each, SIMULATE the exact balanced/week optimize the
  // card's button would run. Only claim a fix if the optimizer actually moves a
  // job OFF that day; otherwise show a non-actionable explanation of why it's
  // stuck (so we never show a dead "Optimize" CTA the optimizer can't honour).
  const overloaded = Object.entries(byDate)
    .map(([date, list]) => ({ date, over: loadOf(list).total - capMin, count: list.length }))
    .filter(d => d.over > 20)
    .sort((a, b) => a.date.localeCompare(b.date))
    .slice(0, 3)
  for (const d of overloaded) {
    const res = optimizeSchedule(jobs, { ...base, mode: 'balanced', scope: 'week', anchorDate: d.date })
    const dayName = format(parseISO(d.date + 'T00:00:00'), 'EEEE')
    const leaves = res.moves.filter(m => m.from === d.date)
    if (leaves.length > 0 && res.after.overloadedDays <= res.before.overloadedDays) {
      const fixed = res.after.overloadedDays < res.before.overloadedDays
      out.push({
        id: `overload-${d.date}`, kind: 'overload', severity: 'high', actionable: true,
        title: `${dayName} is overloaded by ${fmtDur(d.over)}.`,
        detail: `Moving ${leaves.length} job${leaves.length !== 1 ? 's' : ''} off ${dayName} would ${res.kmSaved > 0 ? `save ${res.kmSaved} km and ` : ''}${fixed ? 'bring the day under capacity' : 'ease the day'}.`,
        scope: 'week', anchorDate: d.date, mode: 'balanced',
      })
    } else {
      out.push({
        id: `overload-${d.date}`, kind: 'stuck', severity: 'medium', actionable: false,
        title: `${dayName} is overloaded by ${fmtDur(d.over)}, but it can't be auto-balanced.`,
        detail: explainStuckDay(byDate[d.date]),
        scope: 'week', anchorDate: d.date, mode: 'balanced',
      })
    }
  }

  // 2) + 3) Cluster + recurring opportunities — derived from ONE density/future
  // simulation. Every "isolated job" we report is a move the optimizer actually
  // made (cadence-validated, score-improving), so the count is real and clicking
  // reproduces it. This replaces the old raw heuristic counter (which could read
  // hundreds of "isolated" jobs the optimizer would never touch).
  const densityRes = optimizeSchedule(jobs, { ...base, mode: 'density', scope: 'future', anchorDate: base.today })
  const grouped = densityRes.moves.filter(m => m.groupsCluster)

  if (grouped.length >= 2) {
    out.push({
      id: 'cluster-merge', kind: 'cluster', severity: 'medium', actionable: true,
      title: `${grouped.length} job${grouped.length !== 1 ? 's' : ''} can be grouped into existing clusters.`,
      detail: 'Optimizing for density would shift them onto a day their area already clusters, cutting driving.',
      scope: 'future', anchorDate: base.today, mode: 'density',
    })
  }

  // A specific recurring customer the optimizer would fold into a cluster —
  // phrased with real dates (never "Friday → Friday"), since it IS a real move.
  const recMove = grouped.find(m => m.recurring)
  if (recMove) {
    const toLbl = format(parseISO(recMove.to + 'T00:00:00'), 'EEE, MMM d')
    const fromLbl = format(parseISO(recMove.from + 'T00:00:00'), 'EEE, MMM d')
    const area = recMove.clusterNeighborhood ? `your ${recMove.clusterNeighborhood} route` : 'that route'
    out.push({
      id: `recurring-${recMove.jobId}`, kind: 'recurring', severity: 'medium', actionable: true,
      title: `Shifting ${recMove.customerName} to ${toLbl} would strengthen ${area}.`,
      detail: `Their ${fromLbl} visit sits alone; that area already clusters on ${toLbl}.`,
      scope: 'future', anchorDate: base.today, mode: 'density',
    })
  }

  // 4) Underutilized days — a light WORK day whose handful of jobs the optimizer
  // can fold into a busier day, saving a whole base trip (already simulation-
  // backed: only shown when a density week-optimize actually frees the day).
  const prefSet = base.preferredDays.length ? new Set(base.preferredDays) : null
  const dayList = Object.entries(byDate)
    .map(([date, list]) => ({ date, count: list.length, load: loadOf(list).total }))
    .filter(d => d.count > 0)
    .sort((a, b) => a.date.localeCompare(b.date))
  for (const d of dayList) {
    if (out.some(s => s.kind === 'underutil')) break          // at most one
    if (out.some(s => (s.kind === 'overload' || s.kind === 'stuck') && s.anchorDate === d.date)) continue
    const widx = getDay(parseISO(d.date + 'T00:00:00'))
    if (prefSet && !prefSet.has(widx)) continue               // an off day isn't "underutilized"
    if (d.count > 2 || d.load >= capMin * 0.4) continue       // must be genuinely light
    const res = optimizeSchedule(jobs, { ...base, mode: 'density', scope: 'week', anchorDate: d.date })
    if (res.moves.length === 0 || res.after.activeDays >= res.before.activeDays) continue // no trip actually saved
    const dayName = format(parseISO(d.date + 'T00:00:00'), 'EEEE')
    out.push({
      id: `underutil-${d.date}`, kind: 'underutil', severity: 'medium', actionable: true,
      title: `${dayName} has only ${d.count} job${d.count !== 1 ? 's' : ''} — consolidating could save a base trip.`,
      detail: res.kmSaved > 0
        ? `Folding ${dayName}'s work into a busier day frees the day and saves ${res.kmSaved} km of driving.`
        : `Folding ${dayName}'s work into a busier day frees up the whole day.`,
      scope: 'week', anchorDate: d.date, mode: 'density',
    })
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
