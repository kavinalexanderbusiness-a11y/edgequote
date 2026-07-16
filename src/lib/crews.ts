// ── Crews (dispatch) engine seam ─────────────────────────────────────────────
// THE one place crew identity meets the scheduling engines. The dispatch board
// partitions a day's jobs by crew and feeds each subset to the SAME pure
// engines the schedule already uses — sequenceRoute/optimizeRoute →
// computeDayEtas for timing, day_statuses for day-level blocks/overrides.
// Nothing here re-implements routing, capacity or ETA math.
//
// Named `crews` (not `dispatch`) deliberately: lib/comms/dispatch.ts is the
// message-send pipeline and the two must never be confused.
//
// Pure data + tiny supabase helpers — NO React import (mirrors lib/dayStatus).

import type { SupabaseClient } from '@supabase/supabase-js'
import { Crew, Technician, TechnicianStatus, DispatchNote, Job } from '@/types'
import { DEFAULT_JOB_MIN } from '@/lib/route'
import { DayStatusRow, dayStartTime } from '@/lib/dayStatus'

// ── Crew palette ─────────────────────────────────────────────────────────────
// Distinct HUES (not the 6 semantic tones — those mean status/alarm). Hex is
// deliberate: Google Maps marker/polyline styling can't resolve CSS variables
// (same reason GRADE_COLORS is hex). chip/dot/text are Tailwind classes for the
// board; hex drives the map.
export interface CrewPaletteEntry {
  key: string
  label: string
  hex: string
  chip: string   // lane header chip (border/bg/text)
  dot: string    // small identity dot
  text: string   // foreground accents
}

export const CREW_PALETTE: CrewPaletteEntry[] = [
  { key: 'emerald', label: 'Green',  hex: '#10B981', chip: 'border-emerald-500/30 bg-emerald-500/10 text-emerald-400', dot: 'bg-emerald-400', text: 'text-emerald-400' },
  { key: 'sky',     label: 'Blue',   hex: '#38BDF8', chip: 'border-sky-500/30 bg-sky-500/10 text-sky-400',             dot: 'bg-sky-400',     text: 'text-sky-400' },
  { key: 'amber',   label: 'Amber',  hex: '#F59E0B', chip: 'border-amber-500/30 bg-amber-500/10 text-amber-400',       dot: 'bg-amber-400',   text: 'text-amber-400' },
  { key: 'violet',  label: 'Violet', hex: '#A78BFA', chip: 'border-violet-500/30 bg-violet-500/10 text-violet-400',    dot: 'bg-violet-400',  text: 'text-violet-400' },
  { key: 'rose',    label: 'Rose',   hex: '#FB7185', chip: 'border-rose-500/30 bg-rose-500/10 text-rose-400',          dot: 'bg-rose-400',    text: 'text-rose-400' },
  { key: 'orange',  label: 'Orange', hex: '#FB923C', chip: 'border-orange-500/30 bg-orange-500/10 text-orange-400',    dot: 'bg-orange-400',  text: 'text-orange-400' },
  { key: 'teal',    label: 'Teal',   hex: '#2DD4BF', chip: 'border-teal-500/30 bg-teal-500/10 text-teal-400',          dot: 'bg-teal-400',    text: 'text-teal-400' },
]

// The unassigned lane is a real lane on the board (jobs.crew_id null), styled
// neutral so it never reads as a crew.
export const UNASSIGNED_LANE: CrewPaletteEntry = {
  key: 'unassigned', label: 'Unassigned', hex: '#94A3B8',
  chip: 'border-border bg-surface text-ink-muted', dot: 'bg-ink-faint', text: 'text-ink-muted',
}

// Resolve a crew's palette entry — by key, falling back deterministically by
// index so an unknown/legacy key still gets a stable colour.
export function crewPalette(colorKey: string | null | undefined, index = 0): CrewPaletteEntry {
  return CREW_PALETTE.find(p => p.key === colorKey) ?? CREW_PALETTE[index % CREW_PALETTE.length]
}

// Next unused palette key for a new crew (repeat from the start when exhausted).
export function nextCrewColor(existing: Crew[]): string {
  const used = new Set(existing.map(c => c.color))
  return (CREW_PALETTE.find(p => !used.has(p.key)) ?? CREW_PALETTE[existing.length % CREW_PALETTE.length]).key
}

// ── Technician status display ────────────────────────────────────────────────
// Quiet dot + label on the board (loud pills stay reserved for risk/alarm).
export const TECH_STATUS_META: Record<TechnicianStatus, { dot: string; order: number }> = {
  available: { dot: 'bg-emerald-400', order: 0 },
  en_route:  { dot: 'bg-sky-400',     order: 1 },
  on_job:    { dot: 'bg-amber-400',   order: 2 },
  break:     { dot: 'bg-violet-400',  order: 3 },
  off:       { dot: 'bg-ink-faint',   order: 4 },
}
export const TECH_STATUSES = (Object.keys(TECH_STATUS_META) as TechnicianStatus[])
  .sort((a, b) => TECH_STATUS_META[a].order - TECH_STATUS_META[b].order)

// ── Partition: a day's jobs → lanes ──────────────────────────────────────────
export const UNASSIGNED_ID = 'unassigned'

export interface CrewLaneData {
  laneId: string          // crew id, or UNASSIGNED_ID
  crew: Crew | null       // null = the unassigned lane
  palette: CrewPaletteEntry
  jobs: Job[]             // this lane's jobs for the day (all statuses)
}

// Active crews first (sort_order), unassigned lane always LAST — and always
// present so a job dragged off a crew has somewhere visible to land.
export function partitionByCrew(jobs: Job[], crews: Crew[]): CrewLaneData[] {
  const active = crews.filter(c => c.is_active).sort((a, b) => a.sort_order - b.sort_order || a.name.localeCompare(b.name))
  const byLane = new Map<string, Job[]>()
  for (const j of jobs) {
    const key = j.crew_id && active.some(c => c.id === j.crew_id) ? j.crew_id : UNASSIGNED_ID
    const list = byLane.get(key) ?? []
    list.push(j)
    byLane.set(key, list)
  }
  const lanes: CrewLaneData[] = active.map((c, i) => ({
    laneId: c.id, crew: c, palette: crewPalette(c.color, i), jobs: byLane.get(c.id) ?? [],
  }))
  lanes.push({ laneId: UNASSIGNED_ID, crew: null, palette: UNASSIGNED_LANE, jobs: byLane.get(UNASSIGNED_ID) ?? [] })
  return lanes
}

// In-lane visit order: the owner's manual route_order first (nulls last), then
// start_time, then creation — the same precedence the day board uses, applied
// within the lane's subset.
export function laneSequence(jobs: Job[]): Job[] {
  return [...jobs]
    .filter(j => j.status !== 'cancelled')
    .sort((a, b) =>
      (a.route_order ?? 1e9) - (b.route_order ?? 1e9) ||
      (a.start_time ?? '99:99').localeCompare(b.start_time ?? '99:99') ||
      a.created_at.localeCompare(b.created_at))
}

// ── Per-crew capacity ────────────────────────────────────────────────────────
// Precedence: day blocked → 0; explicit crews.capacity_minutes; crew's own
// day window; the business default window. day_statuses stays the DAY-level
// authority (a blocked day blocks every crew) — this only refines WITHIN a day.
function windowMinutes(start: string | null, end: string | null): number | null {
  if (!start || !end) return null
  const [sh, sm = '0'] = start.split(':'); const [eh, em = '0'] = end.split(':')
  return Math.max(0, (Number(eh) * 60 + Number(em)) - (Number(sh) * 60 + Number(sm)))
}

export function crewCapacityMinutes(
  crew: Crew | null,
  dayRow: DayStatusRow | null | undefined,
  defaultDailyHours: number,
): number {
  if (dayRow?.blocks) return 0
  if (crew?.capacity_minutes != null && crew.capacity_minutes >= 0) return crew.capacity_minutes
  const win = windowMinutes(crew?.day_start ?? null, crew?.day_end ?? null)
  if (win != null) return win
  const dayWin = windowMinutes(dayRow?.starts_at ?? null, dayRow?.ends_at ?? null)
  if (dayWin != null) return dayWin
  return Math.round((defaultDailyHours > 0 ? defaultDailyHours : 8) * 60)
}

// Effective start for a crew's route: the day override wins (a late frost start
// applies to everyone), then the crew's habitual start, then the business start.
export function crewDayStart(crew: Crew | null, dayRow: DayStatusRow | null | undefined, businessStart: string): string {
  if (dayRow?.starts_at) return dayStartTime(dayRow, businessStart)
  return crew?.day_start?.slice(0, 5) || businessStart
}

// A lane's booked work minutes (cancelled excluded) — the capacity numerator.
export function laneWorkMinutes(jobs: Job[]): number {
  return jobs.filter(j => j.status !== 'cancelled').reduce((s, j) => s + (j.duration_minutes || DEFAULT_JOB_MIN), 0)
}

export type LaneLoadState = 'overloaded' | 'full' | 'room'
export function laneLoad(workMin: number, capacityMin: number): { state: LaneLoadState; spareMin: number; pct: number } {
  const spare = Math.round(capacityMin - workMin)
  return {
    state: spare < 0 ? 'overloaded' : spare >= 60 ? 'room' : 'full',
    spareMin: spare,
    pct: capacityMin > 0 ? Math.min(999, Math.round((workMin / capacityMin) * 100)) : (workMin > 0 ? 999 : 0),
  }
}

// ── Daily workload balancing ─────────────────────────────────────────────────
// Proposes moves that even out booked MINUTES across crews (greedy: shift the
// smallest movable job from the most- to the least-loaded lane until no move
// helps). TIME balancing only — geography stays the optimizer's job: after
// applying, each lane's "Best order" re-optimizes its own route. Only
// still-scheduled, unlocked visits move; in-progress/completed never do.
export interface BalanceMove {
  jobId: string
  title: string
  minutes: number
  fromLaneId: string
  toLaneId: string
}
export interface BalancePlan {
  moves: BalanceMove[]
  // laneId → booked minutes
  before: Record<string, number>
  after: Record<string, number>
  spreadBefore: number   // max-min utilization gap in minutes
  spreadAfter: number
}

export function balanceDay(
  lanes: { laneId: string; jobs: Job[]; capacityMin: number }[],
  opts?: { includeUnassigned?: boolean },
): BalancePlan {
  // Unassigned isn't a crew — by default it only ever GIVES work, never receives.
  const receiving = lanes.filter(l => l.laneId !== UNASSIGNED_ID || opts?.includeUnassigned)
  const minutesOf = (j: Job) => j.duration_minutes || DEFAULT_JOB_MIN
  const movable = new Map(lanes.map(l => [l.laneId, l.jobs.filter(j => j.status === 'scheduled' && !j.start_time)]))
  const load = new Map(lanes.map(l => [l.laneId, laneWorkMinutes(l.jobs)]))
  const before = Object.fromEntries(load)

  const util = (id: string) => {
    const cap = lanes.find(l => l.laneId === id)?.capacityMin ?? 0
    return cap > 0 ? (load.get(id) ?? 0) / cap : Number.POSITIVE_INFINITY
  }
  const spread = () => {
    const vals = receiving.map(l => load.get(l.laneId) ?? 0)
    return vals.length ? Math.max(...vals) - Math.min(...vals) : 0
  }

  const moves: BalanceMove[] = []
  const spreadBefore = spread()
  const give = (donorId: string, job: Job, takerId: string) => {
    load.set(donorId, (load.get(donorId) ?? 0) - minutesOf(job))
    load.set(takerId, (load.get(takerId) ?? 0) + minutesOf(job))
    movable.set(donorId, (movable.get(donorId) ?? []).filter(j => j.id !== job.id))
    moves.push({ jobId: job.id, title: job.customers?.name || job.title, minutes: minutesOf(job), fromLaneId: donorId, toLaneId: takerId })
  }

  // Phase 1 — assignment: DRAIN the unassigned lane into crews. Biggest jobs
  // first, each to the currently least-loaded crew (classic LPT greedy).
  const crewLanes = receiving.filter(l => l.laneId !== UNASSIGNED_ID)
  if (crewLanes.length > 0) {
    const pool = [...(movable.get(UNASSIGNED_ID) ?? [])].sort((a, b) => minutesOf(b) - minutesOf(a))
    for (const job of pool) {
      const taker = [...crewLanes].sort((a, b) => util(a.laneId) - util(b.laneId))[0]
      give(UNASSIGNED_ID, job, taker.laneId)
    }
  }

  // Phase 2 — balancing among crews: shift the smallest movable job from the
  // most- to the least-loaded crew while the move actually narrows the gap.
  for (let guard = 0; guard < 40; guard++) {
    const donors = [...crewLanes].sort((a, b) => util(b.laneId) - util(a.laneId))
    const donor = donors.find(l => (movable.get(l.laneId)?.length ?? 0) > 0)
    if (!donor) break
    const takers = crewLanes.filter(l => l.laneId !== donor.laneId).sort((a, b) => util(a.laneId) - util(b.laneId))
    const taker = takers[0]
    if (!taker) break
    const candidates = (movable.get(donor.laneId) ?? []).sort((a, b) => minutesOf(a) - minutesOf(b))
    const job = candidates[0]
    if (!job) break
    const gap = (load.get(donor.laneId) ?? 0) - (load.get(taker.laneId) ?? 0)
    // A move only helps while the donor is ahead by more than the job it gives.
    if (gap <= minutesOf(job)) break
    give(donor.laneId, job, taker.laneId)
  }
  return { moves, before, after: Object.fromEntries(load), spreadBefore, spreadAfter: spread() }
}

// ── Supabase helpers (shared by the board + anything else that needs crews) ──
export const CREW_SELECT = 'id, created_at, updated_at, user_id, name, color, day_start, day_end, capacity_minutes, is_active, sort_order'
// Explicit list, so it MUST be extended when the Technician type grows — a
// missing column here reads as undefined at runtime while TypeScript still
// believes the field exists (e.g. every wage silently becoming "not set").
export const TECHNICIAN_SELECT = 'id, created_at, updated_at, user_id, crew_id, name, phone, email, role, status, status_changed_at, is_active, hourly_wage, hired_on, ended_on'

export async function loadCrews(supabase: SupabaseClient, userId: string): Promise<Crew[]> {
  const { data } = await supabase.from('crews').select(CREW_SELECT).eq('user_id', userId).order('sort_order').order('created_at')
  return (data as Crew[] | null) ?? []
}

export async function loadTechnicians(supabase: SupabaseClient, userId: string): Promise<Technician[]> {
  const { data } = await supabase.from('technicians').select(TECHNICIAN_SELECT).eq('user_id', userId).order('created_at')
  return (data as Technician[] | null) ?? []
}

export async function loadDispatchNotes(supabase: SupabaseClient, userId: string, dateISO: string): Promise<DispatchNote[]> {
  const { data } = await supabase.from('dispatch_notes').select('*').eq('user_id', userId).eq('date', dateISO)
  return (data as DispatchNote[] | null) ?? []
}

// One note per (date, crew) — upsert on the unique constraint so typing twice
// never duplicates. Empty body deletes the row (a note you cleared is gone).
export async function saveDispatchNote(
  supabase: SupabaseClient, userId: string, dateISO: string, crewId: string | null, body: string,
): Promise<string | null> {
  if (!body.trim()) {
    let del = supabase.from('dispatch_notes').delete().eq('user_id', userId).eq('date', dateISO)
    del = crewId === null ? del.is('crew_id', null) : del.eq('crew_id', crewId)
    const { error } = await del
    return error?.message ?? null
  }
  const { error } = await supabase.from('dispatch_notes').upsert(
    { user_id: userId, date: dateISO, crew_id: crewId, body: body.trim() },
    { onConflict: 'user_id,date,crew_id' },
  )
  return error?.message ?? null
}

export async function setTechnicianStatus(
  supabase: SupabaseClient, technicianId: string, status: TechnicianStatus,
): Promise<string | null> {
  const { error } = await supabase.from('technicians')
    .update({ status, status_changed_at: new Date().toISOString() })
    .eq('id', technicianId)
  return error?.message ?? null
}

// Assign a visit to a crew (null = unassign). route_order is cleared so the job
// lands at the end of its new lane and never inherits a foreign sequence slot.
export async function assignJobCrew(
  supabase: SupabaseClient, jobId: string, crewId: string | null,
): Promise<string | null> {
  const { error } = await supabase.from('jobs').update({ crew_id: crewId, route_order: null }).eq('id', jobId)
  return error?.message ?? null
}
