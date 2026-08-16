// ── Worker availability — who can work a given date, and for how long ────────
// Session 67. Before this, "who works Tuesday?" had exactly two inputs: the
// roster (technicians) and dated time off (pto_entries) — a business whose
// crew simply doesn't work Wednesdays had no way to say so, and every planning
// surface silently assumed seven identical days.
//
// This module is PURE (no I/O, no React) and owns the vocabulary:
//
//   · A WEEKLY PATTERN (worker_availability, one row per weekday) is a worker's
//     standard week: Mon 8–5, Wed unavailable. A worker with NO rows has no
//     recorded pattern — they are ASSUMED generally available, and every
//     surface must label that assumption rather than present it as fact.
//   · A worker WITH a pattern is available only on weekdays holding an
//     available=true row. Missing weekday = unavailable, explicitly — the UI
//     writes the whole week, so absence is a statement, not an accident.
//   · TIME OFF (pto_entries) is the dated exception. Only APPROVED rows
//     subtract availability — a request the owner has not decided must not
//     quietly reshape the plan, and a declined one never does. (Callers pass
//     approved rows only; lib/dayFitLoad filters at the read.)
//   · An approved time-off row removes the WHOLE person for that date — the
//     long-standing planning rule, kept deliberately: counting a part-day
//     absence as a full worker is how a day gets overbooked. Part-day rows
//     surface their hours (offHours) so the conservatism is disclosed.
//
// THE COUNT ("how many people can work Tuesday?") stays where it has always
// lived: lib/dayFit.workersAvailableOn — this module feeds it the pattern rule
// (patternUnavailableOn) rather than growing a rival counter. What lives here
// is the RICHER answer: per-worker states for the owner's team view, the day
// board's staffing warnings, and the crew's own week.
//
// HISTORY IS NOT REWRITTEN. A pattern edit changes planning from now on; no
// surface derives PAST staffing from the current pattern (past dates outside
// the planning horizon already answer "unknown", and what actually happened is
// the work-session record, not this table).

import { DEFAULT_CAPACITY_HOURS } from '@/lib/route'

// ── Vocabulary ───────────────────────────────────────────────────────────────

/** Index = weekday number, matching Date.getDay() and the DB's `weekday`. */
export const WEEKDAY_LABELS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'] as const

/** What a fresh "working" day is pre-filled with. A starting point the owner
 *  edits — never a claim about anyone's hours. */
export const DEFAULT_WORK_WINDOW = { start: '08:00', end: '17:00' } as const

/** The one place the product says what each state MEANS on screen. */
export const WORKER_DAY_STATE_LABELS: Record<WorkerDayState, string> = {
  available: 'Working',
  partial: 'Part day',
  assumed: 'Assumed available',
  off: 'Time off',
  unavailable: 'Not working',
}

// ── Row shapes (as read from the tables / passed by loaders) ─────────────────

export interface AvailabilityPatternRow {
  technician_id: string
  /** 0=Sun … 6=Sat (getUTCDay of the date-only value). */
  weekday: number
  available: boolean
  /** 'HH:mm' or 'HH:mm:ss'. Set exactly when available. */
  start_time?: string | null
  end_time?: string | null
}

/** An APPROVED absence on a date. Callers must pre-filter with `isBookedOff`. */
export interface ApprovedTimeOffDay {
  technician_id: string
  date: string
  hours?: number | null
}

/**
 * THE test for "does this time-off row take somebody off the schedule?" — one
 * definition, used by every surface that counts, costs or plans around leave.
 *
 * A row with NO status is approved. That is not leniency: every row written
 * before Session 67 was booked by the owner, and booking IS approval — the
 * column's default says the same thing. Reading a missing status as anything
 * else would silently empty the balances (a wrong number, not an unknown) on
 * any row the migration has not reached yet.
 */
export const isBookedOff = (row: { status?: string | null }): boolean =>
  row.status == null || row.status === 'approved'

/**
 * Does this Postgres/PostgREST error mean the availability table simply is not
 * there yet — i.e. the code is deployed ahead of its migration?
 *
 * That is a DIFFERENT fact from "the read failed", and collapsing the two costs
 * something either way. Treating a real failure as "no pattern recorded" would
 * turn an unknown into the most optimistic answer available (everyone works
 * every day). Treating a not-yet-created table as a failure would blank the
 * day board's worker counts — a capability production has today — for the whole
 * window between deploying and applying the migration.
 *
 * ⏳ TEMPORARY BY CONSTRUCTION: once the migration is applied this returns false
 * forever, and it can be deleted. Nothing else may use it to soften an error.
 */
export const isMissingRelation = (err: { code?: string | null; message?: string | null } | null): boolean =>
  !!err && (err.code === '42P01' || err.code === 'PGRST205'
    || /relation .*worker_availability.* does not exist/i.test(err.message ?? '')
    || /Could not find the table .*worker_availability/i.test(err.message ?? ''))

export interface WorkerForAvailability {
  id: string
  name?: string | null
  crew_id?: string | null
  is_active: boolean
  ended_on?: string | null
  archived_at?: string | null
}

// ── Per-worker day state ─────────────────────────────────────────────────────

export type WorkerDayState =
  | 'available'    // pattern says yes for the full business day
  | 'partial'      // pattern says yes, but for less than the business day
  | 'assumed'      // no pattern recorded — treated as available, SAY SO
  | 'off'          // approved time off on this date
  | 'unavailable'  // pattern says this weekday is not a working day

export interface WorkerDayDetail {
  technicianId: string
  name: string | null
  crewId: string | null
  state: WorkerDayState
  /** Plannable minutes this date: the pattern window, the business day when
   *  assumed, 0 when off/unavailable. Display + disclosure — the labour
   *  formula stays headcount × day hours (lib/dayFit), by design. */
  minutes: number
  /** Hours on the approved time-off row, when one exists — surfaced so a
   *  part-day absence counted as a full day off is disclosed, not hidden. */
  offHours: number | null
}

/** One date's staffing picture, ready for lib/dayPlan's warnings. */
export interface DayStaffing {
  date: string
  workers: WorkerDayDetail[]
  /** Crew id → display name, for naming a crew in a warning. */
  crewNames: Record<string, string>
  /** True when NOBODY on the roster has a recorded pattern — the whole
   *  people-dimension is an assumption and must be labelled as one. */
  allAssumed: boolean
}

// ── Date helpers ─────────────────────────────────────────────────────────────

/** Weekday of a yyyy-MM-dd, timezone-proof (date-only values never shift). */
export function weekdayOf(dateISO: string): number {
  const [y, m, d] = dateISO.slice(0, 10).split('-').map(Number)
  return new Date(Date.UTC(y, (m || 1) - 1, d || 1)).getUTCDay()
}

const timeToMin = (t: string | null | undefined): number | null => {
  if (!t) return null
  const m = /^(\d{1,2}):(\d{2})/.exec(t)
  if (!m) return null
  const min = Number(m[1]) * 60 + Number(m[2])
  return Number.isFinite(min) ? min : null
}

/** Minutes in an available pattern row's window, or null when malformed. */
export function patternWindowMinutes(row: Pick<AvailabilityPatternRow, 'start_time' | 'end_time'>): number | null {
  const s = timeToMin(row.start_time), e = timeToMin(row.end_time)
  if (s == null || e == null || e <= s) return null
  return e - s
}

// ── The pattern rule (consumed by lib/dayFit's canonical count) ──────────────

const byTech = (patterns: AvailabilityPatternRow[]): Map<string, AvailabilityPatternRow[]> => {
  const m = new Map<string, AvailabilityPatternRow[]>()
  for (const p of patterns) {
    const rows = m.get(p.technician_id)
    if (rows) rows.push(p)
    else m.set(p.technician_id, [p])
  }
  return m
}

/**
 * Who a weekly pattern rules OUT on this date: workers that HAVE pattern rows
 * but no available=true row for this weekday. Workers with no rows are never
 * in the set — no pattern is an assumption of availability, not a refusal.
 */
export function patternUnavailableOn(
  date: string,
  patterns: AvailabilityPatternRow[],
): Set<string> {
  const wd = weekdayOf(date)
  const out = new Set<string>()
  for (const [tech, rows] of byTech(patterns)) {
    if (!rows.some(r => r.weekday === wd && r.available)) out.add(tech)
  }
  return out
}

// ── The full per-worker picture ──────────────────────────────────────────────

const onRoster = (t: WorkerForAvailability, date: string) =>
  t.is_active && !t.archived_at && (!t.ended_on || t.ended_on >= date)

/**
 * Every rostered worker's state on one date. The classification here and the
 * canonical count (lib/dayFit.workersAvailableOn with the same inputs) agree
 * by construction: a worker counts exactly when their state is
 * available/partial/assumed — verify:availability pins the equivalence.
 */
export function workerDayStates(
  date: string,
  workers: WorkerForAvailability[],
  patterns: AvailabilityPatternRow[],
  approvedOff: ApprovedTimeOffDay[],
  opts?: { capacityHours?: number | null },
): WorkerDayDetail[] {
  const dayMinutes = (opts?.capacityHours == null || Number(opts.capacityHours) < 0
    ? DEFAULT_CAPACITY_HOURS : Number(opts.capacityHours)) * 60
  const patternRows = byTech(patterns)
  const offByTech = new Map<string, ApprovedTimeOffDay>()
  for (const p of approvedOff) {
    if (p.date.slice(0, 10) === date) offByTech.set(p.technician_id, p)
  }
  const wd = weekdayOf(date)

  return workers.filter(t => onRoster(t, date)).map(t => {
    const base = {
      technicianId: t.id,
      name: t.name ?? null,
      crewId: t.crew_id ?? null,
      offHours: null as number | null,
    }
    const off = offByTech.get(t.id)
    if (off) {
      const h = Number(off.hours)
      return { ...base, state: 'off' as const, minutes: 0, offHours: Number.isFinite(h) && h > 0 ? h : null }
    }
    const rows = patternRows.get(t.id)
    if (!rows || rows.length === 0) {
      return { ...base, state: 'assumed' as const, minutes: dayMinutes }
    }
    const today = rows.find(r => r.weekday === wd && r.available)
    if (!today) {
      return { ...base, state: 'unavailable' as const, minutes: 0 }
    }
    const window = patternWindowMinutes(today) ?? dayMinutes
    return {
      ...base,
      state: window < dayMinutes ? ('partial' as const) : ('available' as const),
      minutes: window,
    }
  })
}

/** One date's staffing input for lib/dayPlan, from the states + the crew list. */
export function dayStaffing(
  date: string,
  states: WorkerDayDetail[],
  crews: { id: string; name: string }[],
): DayStaffing {
  return {
    date,
    workers: states,
    crewNames: Object.fromEntries(crews.map(c => [c.id, c.name])),
    allAssumed: states.length > 0 && states.every(w => w.state === 'assumed'),
  }
}

/** Can this worker do ANY work that date? (The count's membership test.) */
export const canWork = (w: WorkerDayDetail): boolean =>
  w.state === 'available' || w.state === 'partial' || w.state === 'assumed'
