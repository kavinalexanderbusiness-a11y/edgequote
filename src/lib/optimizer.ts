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
import { routeKmEstimate, clusterKmEstimate, AVG_SPEED_KM_PER_MIN, DEFAULT_JOB_MIN, DistFn } from '@/lib/route'

// Learned drive minutes/km (lib/travelLearning, passed via OptOptions.minPerKm) or
// the legacy 2 min/km fallback — so capacity/drive-time decisions sharpen over time.
const DEFAULT_MIN_PER_KM = 1 / AVG_SPEED_KM_PER_MIN
import { effectiveFreq } from '@/lib/invoicing'
import { DayStatusMap, isDayBlocked } from '@/lib/dayStatus'

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
  serviceType?: string | null  // cadence protection applies only within the same service category
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
  // When set, the result carries a per-job `diagnosis` for that date — exactly
  // why each visit on it could (or couldn't) move, evaluated against the SAME
  // constraints + cost model the search uses. Powers the "stuck day" explanation.
  diagnoseDate?: string
  // Cached real-road distance lookup (lib/distance). When provided, EVERY route /
  // km figure the optimizer computes uses real driving distance instead of
  // straight-line; falls back to haversine per-pair internally. Pre-fetched by
  // the caller (the engine itself stays sync/pure).
  roadDist?: DistFn
  // Owner-blocked days (Rain / Vacation / Holiday …). Their `blockedDates` are
  // treated as unavailable: the optimizer never MOVES a job onto one and never
  // offers one as an alternative. (The owner can still manually drag onto it.)
  dayStatusMap?: DayStatusMap
  // Per-day available LABOR-HOURS (Day Settings crew/hours overrides). When set,
  // capacity checks use this PER DAY instead of the flat capacityHours.
  capacityForDate?: (dateISO: string) => number
  // Learned drive minutes per km (lib/travelLearning). Omitted → legacy 2 min/km.
  minPerKm?: number
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

// ── Per-job move diagnosis (the "experienced dispatcher" explanation) ─────────
// For a single (usually overloaded) day, why each visit on it can or cannot move,
// plus the closest alternative destination for each and the concrete reason it was
// rejected. Built from the SAME candidate/cadence/cost machinery the search uses.
export type MoveBlockReason =
  | 'locked-billed' | 'locked-time'   // can't move at all
  | 'customer-avoid'                  // destination is a customer avoid-day
  | 'cadence-collision'               // another visit of theirs that day
  | 'cadence-floor'                   // too close to a neighbouring visit
  | 'cadence-window'                  // too far off the recurring rhythm
  | 'scope'                           // outside the optimize window (e.g. next week)
  | 'capacity'                        // destination day already full
  | 'stability'                       // would pull a recurring customer off their day
  | 'no-gain'                         // legal, but wouldn't ease the day enough to justify
  | 'blocked-day'                     // owner marked the destination unavailable (rain/vacation/…)

export const MOVE_REASON_LABEL: Record<MoveBlockReason, string> = {
  'locked-billed': 'already billed', 'locked-time': 'set start time',
  'customer-avoid': 'customer preference', 'cadence-collision': 'cadence',
  'cadence-floor': 'cadence', 'cadence-window': 'cadence', 'scope': 'weekly balance',
  'capacity': 'destination capacity', 'stability': 'route stability', 'no-gain': 'no net gain',
  'blocked-day': 'day unavailable',
}

export interface JobMoveDiag {
  jobId: string
  customerName: string
  recurring: boolean
  canMove: boolean                    // a legal, beneficial move exists (false at a true optimum)
  reason: string                      // one-line prose explanation
  closest?: { date: string; reason: MoveBlockReason; detail: string } // nearest work-day option + why it failed
}

export interface DayDiagnosis {
  date: string
  jobs: JobMoveDiag[]
  alternatives: { jobId: string; customerName: string; date: string; reason: MoveBlockReason; detail: string }[]
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
  diagnosis?: DayDiagnosis // per-job move explanation for opts.diagnoseDate (if set)
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
  const capMinFor = (date: string) => (opts.capacityForDate ? opts.capacityForDate(date) : (opts.capacityHours > 0 ? opts.capacityHours : 8)) * 60
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
    const iso = format(d, 'yyyy-MM-dd')
    // Skip owner-blocked days (rain/vacation/…) — never bump rained-out work onto one.
    if ((!prefSet || prefSet.has(getDay(d))) && !isDayBlocked(opts.dayStatusMap, iso)) targetDates.push(iso)
    d = addDays(d, 1)
  }

  // Existing load per target day (all non-cancelled jobs already there).
  const existing = new Map<string, OptJob[]>()
  for (const t of targetDates) existing.set(t, jobs.filter(j => j.scheduled_date === t && j.status !== 'cancelled'))
  const loadOf = (list: { duration_minutes: number | null; lat: number | null; lng: number | null }[]) => {
    const labor = list.reduce((s, j) => s + (j.duration_minutes || DEFAULT_JOB_MIN), 0)
    const located = list.filter(j => j.lat != null && j.lng != null).map(j => ({ lat: j.lat as number, lng: j.lng as number }))
    const km = opts.base ? routeKmEstimate(opts.base, located) : clusterKmEstimate(located)
    return { labor, km, total: labor + Math.round(km * (opts.minPerKm ?? DEFAULT_MIN_PER_KM)) }
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
      if (current.total + jobMin > capMinFor(t) && targetDates.some(t2 => t2 > t && (!ceiling || t2 < ceiling))) continue
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
        added: assignedTo.get(t)!.length, overCapacity: after.total > capMinFor(t),
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
// Step cost for a day CROSSING the capacity line (on top of the linear over-
// minutes term). Without it, density/profit modes will happily trade "+1 newly
// overloaded day" for a few km — a dispatcher never makes that trade lightly.
const OVERLOAD_DAY_STEP = 25
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

// Minimum days between two SAME-CATEGORY visits of one customer (the "mowing
// cadence protection"). A FLAT hard floor — enough to stop duplicate / too-close
// mowing while leaving the optimizer and manual scheduling room to balance
// routes. The (recurrenceId, recs) params are kept only for call-site stability;
// the floor no longer scales with the recurrence interval.
export const CADENCE_FLOOR_DAYS = 4
export function cadenceFloorFor(_recurrenceId?: string | null, _recs?: CadenceRecs): number {
  return CADENCE_FLOOR_DAYS
}

// How far a visit may shift without breaking its cadence promise.
function moveWindowDays(j: OptJob, recs: CadenceRecs): number {
  if (!j.recurrence_id) return 6
  const r = recs[j.recurrence_id]
  const f = r ? effectiveFreq(r.freq, r.interval_unit, r.interval_count) : null
  return f === 'weekly' ? 2 : f === 'biweekly' ? 3 : 4
}

// Service-category key for cadence grouping. Cadence protection applies ONLY
// between visits of the SAME category — so a customer's mowing and their
// fertilization / cleanup / mulch / snow can sit on adjacent days, but two
// MOWING visits stay ≥ the floor apart. Every recognized lawn-mowing label
// collapses to 'mow'; any other service groups by its own normalized type, so a
// service never blocks a DIFFERENT service. (Adjust MOW_LABEL if your mowing
// service is named something this doesn't catch.)
const MOW_LABEL = /mow|grass cut|lawn care|(weekly|biweekly|bi-?weekly|monthly) service/
export function cadenceServiceKey(serviceType: string | null | undefined): string {
  const t = (serviceType || '').toLowerCase().trim()
  if (!t) return 'svc:other'
  return MOW_LABEL.test(t) ? 'mow' : `svc:${t}`
}

// One cadence-timeline key for a job: same customer (or, lacking that, same
// series) AND same service category. So hand-made weekly mows are protected
// alongside the recurring series, but unrelated services never collide.
export function cadenceGroupKey(j: { id: string; customerId: string | null; recurrence_id: string | null; serviceType?: string | null }): string {
  const svc = cadenceServiceKey(j.serviceType)
  return j.customerId ? `c:${j.customerId}|${svc}` : j.recurrence_id ? `r:${j.recurrence_id}|${svc}` : `j:${j.id}`
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
  serviceType?: string | null
  customerName?: string | null
}

export interface ManualCadenceResult {
  status: 'ok' | 'warn' | 'collision'
  message: string | null
}

export function manualCadenceCheck(
  move: { id: string; customerId: string | null; recurrence_id: string | null; serviceType?: string | null },
  toDate: string,
  allVisits: CadenceVisit[],
  recs: CadenceRecs,
): ManualCadenceResult {
  const key = cadenceGroupKey(move)
  // Only SAME-category visits of this customer are cadence mates.
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

  // The shared service noun for messaging — "mowing" when this is a mow group,
  // else just "visit".
  const svcNoun = cadenceServiceKey(move.serviceType) === 'mow' ? 'mowing visit' : 'visit'
  const nameOf = (v: CadenceVisit) => v.customerName?.trim() || 'this customer'
  const dayLabel = (iso: string) => format(parseISO(iso + 'T00:00:00'), 'EEE, MMM d')
  if (sameDay) {
    return { status: 'collision', message: `${nameOf(sameDay)} already has a ${svcNoun} on ${dayLabel(sameDay.scheduled_date)} — this would book two on the same day.` }
  }
  const tooClosePrev = prev && prev.gap < floor
  const tooCloseNext = next && next.gap < floor
  if (tooClosePrev || tooCloseNext) {
    const nearer = tooCloseNext && (!tooClosePrev || next!.gap <= prev!.gap) ? next! : prev!
    const dir = nearer === next ? 'before' : 'after'
    return {
      status: 'warn',
      message: `This lands only ${nearer.gap} day${nearer.gap !== 1 ? 's' : ''} ${dir} ${nameOf(nearer.v)}'s ${dayLabel(nearer.v.scheduled_date)} ${svcNoun} — keep ${svcNoun === 'mowing visit' ? 'mowing visits' : 'visits'} at least ${floor} days apart?`,
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
  // Per-day capacity (Day Settings crew/hours overrides) → falls back to the flat
  // capacity when no override exists, so normal days are unchanged.
  const capMinFor = (date: string) => (opts.capacityForDate ? opts.capacityForDate(date) : (opts.capacityHours > 0 ? opts.capacityHours : 8)) * 60
  const prefSet = opts.preferredDays.length ? new Set(opts.preferredDays) : null
  // A day the owner blocked (rain/vacation/…) is never a legal MOVE destination.
  const isBlockedDay = (date: string) => isDayBlocked(opts.dayStatusMap, date)
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

  // ── Same-category cadence integrity ──
  // A customer's visits of ONE service category are a single timeline, validated
  // across the WHOLE schedule (grouped by cadenceGroupKey = customer/series +
  // service category, so hand-made mows are protected alongside the series, while
  // a DIFFERENT service never blocks it). Out-of-window visits are fixed anchors;
  // in-window ones move. This is what stops a move from colliding with or
  // compressing another SAME-CATEGORY visit of the same customer.
  const groups: Record<string, OptJob[]> = {}
  for (const j of jobs) {
    if (j.status === 'cancelled') continue
    ;(groups[cadenceGroupKey(j)] ||= []).push(j)
  }
  const matesByJobId = new Map<string, OptJob[]>()
  for (const j of movable) matesByJobId.set(j.id, (groups[cadenceGroupKey(j)] || []).filter(m => m.id !== j.id))

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

  // ── Day evaluation (route engine math + cluster cells) ──
  // daySorted keeps each day's job ids in sorted order, so a day's config key is
  // an O(k) join with no per-call sort. evalSet can score ANY hypothetical day
  // composition through the config cache — that's what lets the search evaluate
  // candidate moves and swaps WITHOUT mutating state, committing only winners.
  // Identical job sets always evaluate identically (sorted iteration), keeping
  // the cost landscape noise-free.
  const daySorted = new Map<string, string[]>()
  for (const [date, ids] of dayJobs) daySorted.set(date, [...ids].sort())
  const lowerBound = (arr: string[], id: string): number => {
    let lo = 0, hi = arr.length
    while (lo < hi) { const mid = (lo + hi) >> 1; if (arr[mid] < id) lo = mid + 1; else hi = mid }
    return lo
  }
  const withRemoved = (arr: string[], id: string): string[] => {
    const i = lowerBound(arr, id)
    return arr[i] === id ? arr.slice(0, i).concat(arr.slice(i + 1)) : arr.slice()
  }
  const withInserted = (arr: string[], id: string): string[] => {
    const i = lowerBound(arr, id)
    const out = arr.slice(0, i)
    out.push(id)
    for (let k = i; k < arr.length; k++) out.push(arr[k])
    return out
  }
  const cache = new Map<string, DayEval>()
  const cfgCache = new Map<string, DayEval>()
  const EMPTY_EVAL: DayEval = { driveMin: 0, laborMin: 0, km: 0, totalMin: 0, cells: 0 }
  function evalSet(sorted: string[]): DayEval {
    if (sorted.length === 0) return EMPTY_EVAL
    const key = sorted.join(',')
    const hit = cfgCache.get(key)
    if (hit) return hit
    let laborMin = 0
    const located: { lat: number; lng: number }[] = []
    const cellSet = new Set<string>()
    for (const id of sorted) {
      const j = byId.get(id)!
      laborMin += j.duration_minutes || DEFAULT_JOB_MIN
      if (j.lat != null && j.lng != null) { located.push({ lat: j.lat, lng: j.lng }); cellSet.add(cellKey(j.lat, j.lng)) }
    }
    const km = opts.base ? routeKmEstimate(opts.base, located, opts.roadDist) : clusterKmEstimate(located, opts.roadDist)
    const driveMin = Math.round(km * (opts.minPerKm ?? DEFAULT_MIN_PER_KM))
    const e = { driveMin, laborMin, km, totalMin: driveMin + laborMin, cells: cellSet.size }
    if (cfgCache.size < 200000) cfgCache.set(key, e)
    return e
  }
  function evalDay(date: string): DayEval {
    const hit = cache.get(date)
    if (hit) return hit
    const e = evalSet(daySorted.get(date) ?? [])
    cache.set(date, e)
    return e
  }
  const invalidate = (date: string) => cache.delete(date)

  // ── Incremental global cost ──
  // The cost is a sum of per-day terms (drive / over-capacity / active-day /
  // cluster-cells + the day-total mean & variance behind the spread term) and
  // per-job placement penalties (stability off the established weekday, week-
  // crossing, customer preferences). Both are kept as RUNNING AGGREGATES that
  // applyMove updates in place, so reading the cost during the search is O(1)
  // instead of O(days + jobs). That speed budget is what pays for swap moves
  // and multi-start below. recomputeAggregates() rebuilds from scratch (init +
  // drift-squash after the search settles).
  const dateInfo = new Map<string, { dow: number; week: string }>()
  const infoOf = (dateISO: string) => {
    let v = dateInfo.get(dateISO)
    if (!v) { v = { dow: getDay(parseISO(dateISO)), week: isoWeekKey(dateISO) }; dateInfo.set(dateISO, v) }
    return v
  }
  // Weighted per-job placement penalty (stability + week-cross + preferences) —
  // the same terms the old whole-schedule scans computed, per job per date.
  function penaltyOf(j: OptJob, dateISO: string): number {
    const { dow, week } = infoOf(dateISO)
    let pen = 0
    if (j.recurrence_id) {
      const est = estWeekday[j.recurrence_id]
      if (est != null && dow !== est) pen += w.stability * STABILITY_MIN
    }
    if (week !== origWeek.get(j.id)) pen += w.weekCross * WEEK_CROSS_MIN
    if (j.avoidDays && j.avoidDays.includes(dow)) pen += w.pref * PREF_MIN * 2
    else if (j.preferredDays && j.preferredDays.length && !j.preferredDays.includes(dow)) pen += w.pref * PREF_MIN
    return pen
  }
  interface DayContrib { drive: number; over: number; overDay: number; active: number; cells: number; total: number }
  const ZERO_CONTRIB: DayContrib = { drive: 0, over: 0, overDay: 0, active: 0, cells: 0, total: 0 }
  const contribOf = (e: DayEval, size: number): DayContrib => {
    if (size === 0) return ZERO_CONTRIB
    const over = Math.max(0, e.totalMin - capMin)
    return { drive: e.driveMin, over, overDay: over > 0 ? 1 : 0, active: 1, cells: Math.max(0, e.cells - 1), total: e.totalMin }
  }
  const dayContrib = (date: string): DayContrib => contribOf(evalDay(date), dayJobs.get(date)?.size ?? 0)
  let aggDrive = 0, aggOver = 0, aggOverDays = 0, aggDays = 0, aggCells = 0, aggSum = 0, aggSumSq = 0, jobPenaltyTotal = 0
  const jobPenalty = new Map<string, number>()
  function recomputeAggregates(): void {
    aggDrive = 0; aggOver = 0; aggOverDays = 0; aggDays = 0; aggCells = 0; aggSum = 0; aggSumSq = 0; jobPenaltyTotal = 0
    for (const date of dayJobs.keys()) {
      const c = dayContrib(date)
      aggDrive += c.drive; aggOver += c.over; aggOverDays += c.overDay; aggDays += c.active; aggCells += c.cells
      aggSum += c.total; aggSumSq += c.total * c.total
    }
    jobPenalty.clear()
    for (const j of movable) {
      const p = penaltyOf(j, assign.get(j.id)!)
      jobPenalty.set(j.id, p)
      jobPenaltyTotal += p
    }
  }

  function globalCost(): number {
    let spread = 0
    if (aggDays > 1) {
      const mean = aggSum / aggDays
      spread = Math.sqrt(Math.max(0, aggSumSq / aggDays - mean * mean))
    }
    return w.km * aggDrive + w.over * (aggOver + aggOverDays * OVERLOAD_DAY_STEP) + w.spread * spread
      + w.days * aggDays * DAY_OVERHEAD_MIN + w.cluster * aggCells * CLUSTER_CELL_MIN
      + jobPenaltyTotal
  }

  // ── Hypothetical evaluation (the search's hot path) ──
  // Score "what would the cost be if…" WITHOUT touching dayJobs/daySorted/the
  // caches. Candidate day compositions go through evalSet (config-cached), and
  // the aggregate deltas are applied arithmetically. Rejected candidates — the
  // overwhelming majority — therefore cost two map lookups and some arithmetic
  // instead of four mutating applyMove calls.
  function costWith(deltas: { d: DayContrib; n: DayContrib }[], penDelta: number): number {
    let drive = aggDrive, over = aggOver, overDays = aggOverDays, days = aggDays, cells = aggCells, sum = aggSum, sumSq = aggSumSq
    for (const { d, n } of deltas) {
      drive += n.drive - d.drive
      over += n.over - d.over
      overDays += n.overDay - d.overDay
      days += n.active - d.active
      cells += n.cells - d.cells
      sum += n.total - d.total
      sumSq += n.total * n.total - d.total * d.total
    }
    let spread = 0
    if (days > 1) {
      const mean = sum / days
      spread = Math.sqrt(Math.max(0, sumSq / days - mean * mean))
    }
    return w.km * drive + w.over * (over + overDays * OVERLOAD_DAY_STEP) + w.spread * spread
      + w.days * days * DAY_OVERHEAD_MIN + w.cluster * cells * CLUSTER_CELL_MIN
      + (jobPenaltyTotal + penDelta)
  }
  // Cost if job j moved to `to` (no mutation).
  function moveCost(j: OptJob, to: string): number {
    const from = assign.get(j.id)!
    const s1 = daySorted.get(from) ?? []
    const s2 = daySorted.get(to) ?? []
    return costWith([
      { d: dayContrib(from), n: contribOf(evalSet(withRemoved(s1, j.id)), s1.length - 1) },
      { d: dayContrib(to), n: contribOf(evalSet(withInserted(s2, j.id)), s2.length + 1) },
    ], penaltyOf(j, to) - (jobPenalty.get(j.id) ?? 0))
  }
  // Cost if j1 (on its current day) and j2 (on day d2) traded days (no mutation).
  function swapCost(j1: OptJob, d2: string, j2: OptJob): number {
    const d1 = assign.get(j1.id)!
    const s1 = daySorted.get(d1) ?? []
    const s2 = daySorted.get(d2) ?? []
    const n1 = withInserted(withRemoved(s1, j1.id), j2.id)
    const n2 = withInserted(withRemoved(s2, j2.id), j1.id)
    return costWith([
      { d: dayContrib(d1), n: contribOf(evalSet(n1), n1.length) },
      { d: dayContrib(d2), n: contribOf(evalSet(n2), n2.length) },
    ], penaltyOf(j1, d2) - (jobPenalty.get(j1.id) ?? 0) + penaltyOf(j2, d1) - (jobPenalty.get(j2.id) ?? 0))
  }

  // Basic placement legality (everything EXCEPT series cadence): strictly
  // future, inside the scope's TARGET window, on a preferred work day, never a
  // customer avoid-day, within the job's cadence jitter window of its ORIGINAL
  // date, and different from where it currently sits. Shared by single-move
  // candidates and the swap neighborhood (which validates cadence post-swap,
  // since both jobs move at once).
  function basicTargets(j: OptJob): string[] {
    const wd = moveWindowDays(j, opts.recurrences)
    const origin = parseISO(original.get(j.id)!)
    const out: string[] = []
    for (let d = -wd; d <= wd; d++) {
      const date = format(addDays(origin, d), 'yyyy-MM-dd')
      if (date <= opts.today) continue
      if (!inTarget(date)) continue
      if (date === assign.get(j.id)) continue
      const { dow } = infoOf(date)
      if (prefSet && !prefSet.has(dow)) continue
      if (isBlockedDay(date)) continue                       // owner marked the day unavailable
      if (j.avoidDays && j.avoidDays.includes(dow)) continue // never move onto a customer's avoid day
      out.push(date)
    }
    return out
  }
  function basicLegal(j: OptJob, date: string): boolean {
    if (date <= opts.today || !inTarget(date) || date === assign.get(j.id)) return false
    const { dow } = infoOf(date)
    if (prefSet && !prefSet.has(dow)) return false
    if (isBlockedDay(date)) return false                     // owner-blocked day
    if (j.avoidDays && j.avoidDays.includes(dow)) return false
    return Math.abs(diffDaysISO(original.get(j.id)!, date)) <= moveWindowDays(j, opts.recurrences)
  }
  // Candidate dates: basic legality + HARD validation against the customer's
  // entire visit timeline (no collisions, no cadence violations).
  function candidates(j: OptJob): string[] {
    return basicTargets(j).filter(date => validCadence(j, date))
  }

  // Move a job and update every cost aggregate exactly: capture the two affected
  // days' contributions before, re-evaluate after, apply the deltas. Reversible
  // (applyMove(id, back) restores aggregates bit-for-bit modulo float rounding,
  // which recomputeAggregates squashes after the search).
  function applyMove(id: string, to: string) {
    const from = assign.get(id)!
    if (from === to) return
    const oldFrom = dayContrib(from)
    const oldTo = dayContrib(to)
    dayJobs.get(from)!.delete(id)
    addTo(to, id)
    // Keep the sorted-id mirror in lock-step with dayJobs.
    const sFrom = daySorted.get(from)!
    sFrom.splice(lowerBound(sFrom, id), 1)
    let sTo = daySorted.get(to)
    if (!sTo) { sTo = []; daySorted.set(to, sTo) }
    sTo.splice(lowerBound(sTo, id), 0, id)
    assign.set(id, to)
    invalidate(from); invalidate(to)
    const newFrom = dayContrib(from)
    const newTo = dayContrib(to)
    aggDrive += newFrom.drive + newTo.drive - oldFrom.drive - oldTo.drive
    aggOver += newFrom.over + newTo.over - oldFrom.over - oldTo.over
    aggOverDays += newFrom.overDay + newTo.overDay - oldFrom.overDay - oldTo.overDay
    aggDays += newFrom.active + newTo.active - oldFrom.active - oldTo.active
    aggCells += newFrom.cells + newTo.cells - oldFrom.cells - oldTo.cells
    aggSum += newFrom.total + newTo.total - oldFrom.total - oldTo.total
    aggSumSq += newFrom.total ** 2 + newTo.total ** 2 - oldFrom.total ** 2 - oldTo.total ** 2
    const oldPen = jobPenalty.get(id)
    if (oldPen != null) {
      const newPen = penaltyOf(byId.get(id)!, to)
      jobPenalty.set(id, newPen)
      jobPenaltyTotal += newPen - oldPen
    }
  }

  // Metrics report only the days in the scope's METRICS window.
  const metricsNow = (): ScheduleMetrics => {
    let km = 0, drive = 0, labor = 0, days = 0, stops = 0, over = 0, revenue = 0
    for (const [date, ids] of dayJobs) {
      if (ids.size === 0 || !inMetrics(date)) continue
      const e = evalDay(date)
      km += e.km; drive += e.driveMin; labor += e.laborMin; days++; stops += ids.size
      if (e.totalMin > capMinFor(date)) over++
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
  recomputeAggregates()

  // ── Search: deterministic multi-start · single moves · swaps · pruning ──
  // 1) Best-improvement single-job passes until stable (the classic move).
  // 2) Pairwise SWAPS — exchange two jobs' days. Escapes local optima single
  //    moves can't reach (two full days that can only trade, never give).
  //    Cadence is validated POST-swap on both jobs, against the swapped state.
  // 3) Three deterministic starting orders explore different basins; the best
  //    final plan wins (ties → fewer moves, so least disruption).
  // 4) Neutral-move pruning: any move that no longer pays for itself once the
  //    dust settles is reverted, keeping the plan minimal.
  // Every trial runs through the same applyMove/validCadence machinery, so all
  // hard constraints hold at every intermediate step. Fully deterministic.
  const MIN_GAIN = 1
  if (movable.length > 0) {
    const movableIdSet = new Set(movable.map(j => j.id))
    const startLoad = new Map<string, number>()
    for (const j of movable) startLoad.set(j.id, evalDay(assign.get(j.id)!).totalMin)
    const bigN = movable.length > 500 // degenerate-size guard — still deterministic
    const orderings: OptJob[][] = bigN ? [movable] : [
      movable, // natural order (date ascending, as fetched)
      [...movable].sort((a, b) => (startLoad.get(b.id)! - startLoad.get(a.id)!) || a.id.localeCompare(b.id)), // most-loaded days first
    ]

    function singlePass(order: OptJob[]): boolean {
      let improved = false
      for (const j of order) {
        let bestDate: string | null = null
        let bestCost = globalCost()
        for (const date of candidates(j)) {
          const c = moveCost(j, date) // hypothetical — nothing mutates
          if (c < bestCost - MIN_GAIN) { bestCost = c; bestDate = date }
        }
        if (bestDate) { applyMove(j.id, bestDate); improved = true }
      }
      return improved
    }

    function swapPass(): boolean {
      let improved = false
      let trials = 0
      for (const j1 of movable) {
        if (trials > 60000) break // hard budget — deterministic truncation
        const d1 = assign.get(j1.id)!
        const g1 = cadenceGroupKey(j1)
        let done = false
        for (const d2 of basicTargets(j1)) {
          const ids2 = daySorted.get(d2)
          if (!ids2 || ids2.length === 0) continue
          let partners = 0
          for (const id2 of ids2) { // already sorted → deterministic
            if (partners >= 4) break // bounded fan-out per day
            if (id2 === j1.id || !movableIdSet.has(id2)) continue
            const j2 = byId.get(id2)!
            // Same-customer pairs trade identical dates — no gain, and their
            // cadence interacts; different customers' cadence checks stay
            // independent, so pre-apply validation below is exact.
            if (cadenceGroupKey(j2) === g1) continue
            if (!basicLegal(j2, d1)) continue
            partners++
            trials++
            if (swapCost(j1, d2, j2) < globalCost() - MIN_GAIN && validCadence(j1, d2) && validCadence(j2, d1)) {
              applyMove(j1.id, d2)
              applyMove(j2.id, d1)
              improved = true
              done = true
              break
            }
          }
          if (done) break // j1 has a new day — continue with the next job
        }
      }
      return improved
    }

    // Revert any move that's no longer pulling its weight (reverting to the
    // original date is always offered the chance — it's the user's own
    // placement — but only if the customer's timeline stays cadence-valid).
    function prunePass(): void {
      let pruned = true
      while (pruned) {
        pruned = false
        for (const j of movable) {
          const cur = assign.get(j.id)!
          const orig = original.get(j.id)!
          if (cur === orig) continue
          if (!validCadence(j, orig)) continue
          if (moveCost(j, orig) <= globalCost() + 1e-9) { applyMove(j.id, orig); pruned = true }
        }
      }
    }

    let bestCost = Infinity
    let bestMoveCount = Infinity
    let bestAssign: Map<string, string> | null = null
    for (const order of orderings) {
      for (const j of movable) applyMove(j.id, original.get(j.id)!) // reset to the real schedule
      for (let cycle = 0; cycle < 4; cycle++) {
        let any = false
        for (let p = 0; p < 10 && singlePass(order); p++) any = true
        if (!bigN) for (let sp = 0; sp < 3 && swapPass(); sp++) any = true
        if (!any) break
      }
      prunePass()
      const c = globalCost()
      const moveCount = movable.reduce((n, j) => n + (assign.get(j.id)! !== original.get(j.id)! ? 1 : 0), 0)
      if (c < bestCost - 1e-9 || (Math.abs(c - bestCost) <= 1e-9 && moveCount < bestMoveCount)) {
        bestCost = c
        bestMoveCount = moveCount
        bestAssign = new Map(assign)
      }
    }
    if (bestAssign) for (const j of movable) applyMove(j.id, bestAssign.get(j.id)!)
    recomputeAggregates() // squash float drift before metrics/diagnosis read the cost
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

  // ── Per-job move diagnosis for a requested day ──
  // Runs AFTER the search settles, against the FINAL optimized state. For each
  // visit on the day it walks every nearby work day and records the FIRST binding
  // reason it can't usefully move there — using the exact same cadence guard,
  // avoid-day rule, scope window and global-cost delta the search itself uses, so
  // the explanation can never disagree with the optimizer. (Pure: every trial
  // move is reverted.)
  let diagnosis: DayDiagnosis | undefined
  if (opts.diagnoseDate) {
    const date = opts.diagnoseDate
    const baseCost = globalCost()
    const movableSet = new Set(movable.map(j => j.id))
    const fmtD = (iso: string) => format(parseISO(iso + 'T00:00:00'), 'EEE, MMM d')
    const longDow = (iso: string) => format(parseISO(iso + 'T00:00:00'), 'EEEE')

    const classify = (j: OptJob, to: string): { ok: boolean; reason: MoveBlockReason; detail: string } => {
      const dow = getDay(parseISO(to + 'T00:00:00'))
      if (isBlockedDay(to)) return { ok: false, reason: 'blocked-day', detail: `${longDow(to)} is marked unavailable` }
      if (j.avoidDays && j.avoidDays.includes(dow)) {
        return { ok: false, reason: 'customer-avoid', detail: `${j.customerName} asked to avoid ${longDow(to)}s` }
      }
      // Cadence against the customer's whole timeline (collision, then floor).
      const mates = matesByJobId.get(j.id) || []
      let collide = false, nearestGap = Infinity, nearestMate: OptJob | null = null
      for (const m of mates) {
        const diff = diffDaysISO(currentDateOf(m), to)
        if (diff === 0) { collide = true; break }
        const g = Math.abs(diff)
        if (g < nearestGap) { nearestGap = g; nearestMate = m }
      }
      if (collide) return { ok: false, reason: 'cadence-collision', detail: `${j.customerName} already has a visit that day` }
      const floor = cadenceFloorFor(j.recurrence_id, opts.recurrences)
      if (nearestMate && nearestGap < floor) {
        return { ok: false, reason: 'cadence-floor', detail: `it would land ${nearestGap} day${nearestGap !== 1 ? 's' : ''} from their ${fmtD(currentDateOf(nearestMate))} visit — cadence needs ≥${floor} days` }
      }
      const wd = moveWindowDays(j, opts.recurrences)
      const off = Math.abs(diffDaysISO(original.get(j.id)!, to))
      if (j.recurrence_id && off > wd) {
        return { ok: false, reason: 'cadence-window', detail: `it’s ${off} days off their recurring rhythm (visits flex ±${wd} days)` }
      }
      if (!inTarget(to)) return { ok: false, reason: 'scope', detail: 'it falls outside the stretch being balanced' }
      // Legal move — does it actually help? Same hypothetical cost the search uses.
      const fromDate = assign.get(j.id)!
      const delta = moveCost(j, to) - baseCost
      const destSorted = daySorted.get(to) ?? []
      const destOver = evalSet(withInserted(destSorted, j.id)).totalMin - capMinFor(to)
      if (delta < -MIN_GAIN) return { ok: true, reason: 'no-gain', detail: 'a beneficial move exists' }
      if (destOver > 0) return { ok: false, reason: 'capacity', detail: `${longDow(to)} is already full (${fmtDur(destOver)} over capacity)` }
      if (j.recurrence_id) {
        const est = estWeekday[j.recurrence_id]
        if (est != null && getDay(parseISO(fromDate + 'T00:00:00')) === est && dow !== est) {
          return { ok: false, reason: 'stability', detail: `it would pull ${j.customerName} off their usual ${longDow(fromDate)} for too small a gain` }
        }
      }
      if (isoWeekKey(to) !== isoWeekKey(fromDate)) {
        return { ok: false, reason: 'scope', detail: 'it would push the visit into a different week for too little benefit' }
      }
      return { ok: false, reason: 'no-gain', detail: 'it wouldn’t cut driving or ease the day enough to justify' }
    }

    const onDay = [...(dayJobs.get(date) ?? [])].map(id => byId.get(id)!).filter(Boolean)
    const jobDiags: JobMoveDiag[] = []
    const alternatives: DayDiagnosis['alternatives'] = []
    for (const j of onDay) {
      if (!movableSet.has(j.id)) {
        jobDiags.push({
          jobId: j.id, customerName: j.customerName, recurring: !!j.recurrence_id, canMove: false,
          reason: j.invoiced
            ? `${j.customerName} is already billed, so the visit is locked.`
            : `${j.customerName} has a set start time (${j.start_time}), so the visit is locked.`,
        })
        continue
      }
      const fromDate = assign.get(j.id)!
      let canMove = false
      let closest: JobMoveDiag['closest'] | undefined
      for (let step = 1; step <= 14 && !canMove; step++) {
        for (const dir of [1, -1]) {
          const d = addDays(parseISO(fromDate + 'T00:00:00'), dir * step)
          const to = format(d, 'yyyy-MM-dd')
          if (to <= opts.today) continue
          if (prefSet && !prefSet.has(getDay(d))) continue   // only real work days are credible alternatives
          if (isBlockedDay(format(d, 'yyyy-MM-dd'))) continue // …and not a day the owner blocked
          const v = classify(j, to)
          if (v.ok) { canMove = true; break }
          if (!closest) closest = { date: to, reason: v.reason, detail: v.detail }
        }
      }
      jobDiags.push({
        jobId: j.id, customerName: j.customerName, recurring: !!j.recurrence_id, canMove,
        reason: closest ? `${j.customerName} can’t move — ${closest.detail}.` : `${j.customerName} has no nearby work day open to move to.`,
        closest,
      })
      if (closest) alternatives.push({ jobId: j.id, customerName: j.customerName, date: closest.date, reason: closest.reason, detail: closest.detail })
    }
    diagnosis = { date, jobs: jobDiags, alternatives }
  }

  return {
    mode: opts.mode, scope: opts.scope,
    before, after, moves, daysAffected, kmSaved, minutesSaved,
    movableCount: movable.length, lockedTimes, lockedBilled, stableKept,
    groupedIntoCluster, blockedMoves, warnings, reasons, diagnosis,
  }
}

function fmtDur(min: number): string {
  return min >= 60 ? `${Math.round((min / 60) * 10) / 10}h` : `${min}m`
}

// ── Subset metrics (cherry-pick support) ──────────────────────────────────────
// Metrics for the schedule with an arbitrary SUBSET of proposed moves applied —
// powers the optimizer modal's live before/after as the owner ticks individual
// moves on and off. Same math as the engine's internal metrics (route engine +
// capacity + scope metrics window), so with every move selected it reproduces
// result.after exactly.
export function metricsWithMoves(
  jobs: OptJob[],
  opts: Pick<OptOptions, 'scope' | 'anchorDate' | 'today' | 'base' | 'capacityHours' | 'roadDist' | 'capacityForDate' | 'minPerKm'>,
  moves: Pick<PlannedMove, 'jobId' | 'to'>[],
): ScheduleMetrics {
  const capMinFor = (date: string) => (opts.capacityForDate ? opts.capacityForDate(date) : (opts.capacityHours > 0 ? opts.capacityHours : 8)) * 60
  const win = scopeWindows(opts.scope, opts.anchorDate, opts.today)
  const inMetrics = (date: string) => date >= win.metricsStart && (win.metricsEnd == null || date <= win.metricsEnd)
  const override = new Map(moves.map(m => [m.jobId, m.to]))
  const byDate = new Map<string, OptJob[]>()
  for (const j of jobs) {
    if (j.status === 'cancelled') continue
    const date = override.get(j.id) ?? j.scheduled_date
    if (!inMetrics(date)) continue
    const list = byDate.get(date)
    if (list) list.push(j)
    else byDate.set(date, [j])
  }
  let km = 0, drive = 0, labor = 0, days = 0, stops = 0, over = 0, revenue = 0
  for (const [date, list] of byDate) {
    const laborMin = list.reduce((s, j) => s + (j.duration_minutes || DEFAULT_JOB_MIN), 0)
    const located = list.filter(j => j.lat != null && j.lng != null).map(j => ({ lat: j.lat as number, lng: j.lng as number }))
    const dayKm = opts.base ? routeKmEstimate(opts.base, located, opts.roadDist) : clusterKmEstimate(located, opts.roadDist)
    const driveMin = Math.round(dayKm * (opts.minPerKm ?? DEFAULT_MIN_PER_KM))
    km += dayKm; drive += driveMin; labor += laborMin; days++; stops += list.length
    if (driveMin + laborMin > capMinFor(date)) over++
    revenue += list.reduce((s, j) => s + j.value, 0)
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
  // Present on 'stuck' cards: the per-job breakdown of why nothing can move.
  diagnosis?: DayDiagnosis
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
  const capMinFor = (date: string) => (base.capacityForDate ? base.capacityForDate(date) : (base.capacityHours > 0 ? base.capacityHours : 8)) * 60
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
    return { total: labor + Math.round(km * (base.minPerKm ?? DEFAULT_MIN_PER_KM)) }
  }

  // 1) Overloaded days — for each, SIMULATE the exact balanced/week optimize the
  // card's button would run. Only claim a fix if the optimizer actually moves a
  // job OFF that day; otherwise show a non-actionable explanation of why it's
  // stuck (so we never show a dead "Optimize" CTA the optimizer can't honour).
  const overloaded = Object.entries(byDate)
    .map(([date, list]) => ({ date, over: loadOf(list).total - capMinFor(date), count: list.length }))
    .filter(d => d.over > 20)
    .sort((a, b) => a.date.localeCompare(b.date))
    .slice(0, 3)
  for (const d of overloaded) {
    const dayName = format(parseISO(d.date + 'T00:00:00'), 'EEEE')
    const relieves = (r: OptimizationResult) => r.moves.filter(m => m.from === d.date).length > 0 && r.after.overloadedDays <= r.before.overloadedDays
    // First the least-disruptive search (balance within the week). diagnoseDate
    // makes the result carry the per-job "why it can / can't move" breakdown.
    const week = optimizeSchedule(jobs, { ...base, mode: 'balanced', scope: 'week', anchorDate: d.date, diagnoseDate: d.date })
    if (relieves(week)) {
      const leaves = week.moves.filter(m => m.from === d.date).length
      const fixed = week.after.overloadedDays < week.before.overloadedDays
      out.push({
        id: `overload-${d.date}`, kind: 'overload', severity: 'high', actionable: true,
        title: `${dayName} is overloaded by ${fmtDur(d.over)}.`,
        detail: `Moving ${leaves} job${leaves !== 1 ? 's' : ''} off ${dayName} would ${week.kmSaved > 0 ? `save ${week.kmSaved} km and ` : ''}${fixed ? 'bring the day under capacity' : 'ease the day'}.`,
        scope: 'week', anchorDate: d.date, mode: 'balanced',
      })
      continue
    }
    // The week itself is full — before declaring it impossible, evaluate the
    // broader cross-week search (a job may relieve the day by shifting into an
    // adjacent week if the gain outweighs the week-cross penalty).
    const month = optimizeSchedule(jobs, { ...base, mode: 'balanced', scope: 'month', anchorDate: d.date, diagnoseDate: d.date })
    if (relieves(month)) {
      const leaves = month.moves.filter(m => m.from === d.date).length
      const fixed = month.after.overloadedDays < month.before.overloadedDays
      out.push({
        id: `overload-${d.date}`, kind: 'overload', severity: 'high', actionable: true,
        title: `${dayName} is overloaded by ${fmtDur(d.over)}.`,
        detail: `Its own week is full, but shifting ${leaves} job${leaves !== 1 ? 's' : ''} into an adjacent week would ${fixed ? 'bring the day under capacity' : 'ease it'}${month.kmSaved > 0 ? ` (saves ${month.kmSaved} km)` : ''}.`,
        scope: 'month', anchorDate: d.date, mode: 'balanced',
      })
      continue
    }
    // Genuinely stuck even allowing cross-week moves — explain with the broadest
    // diagnosis, so per-job reasons are concrete (capacity / cadence / stability)
    // rather than "outside this week".
    out.push({
      id: `overload-${d.date}`, kind: 'stuck', severity: 'medium', actionable: false,
      title: `${dayName} is overloaded by ${fmtDur(d.over)}, but no legal move relieves it.`,
      detail: explainStuckDay(byDate[d.date]),
      scope: 'month', anchorDate: d.date, mode: 'balanced',
      diagnosis: month.diagnosis,
    })
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
  let underutilSims = 0
  for (const d of dayList) {
    if (out.some(s => s.kind === 'underutil')) break          // at most one
    if (out.some(s => (s.kind === 'overload' || s.kind === 'stuck') && s.anchorDate === d.date)) continue
    const widx = getDay(parseISO(d.date + 'T00:00:00'))
    if (prefSet && !prefSet.has(widx)) continue               // an off day isn't "underutilized"
    if (d.count > 2 || d.load >= capMinFor(d.date) * 0.4) continue       // must be genuinely light
    if (++underutilSims > 3) break                            // bounded simulation budget
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
