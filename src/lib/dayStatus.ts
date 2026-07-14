// ── Day Status (per-day availability) ───────────────────────────────────────────
// A flexible status for a single calendar day. "Normal" is the absence of a row.
// Whether a day blocks scheduling is stored ON THE ROW (`blocks`), not hardcoded by
// status name — so new statuses (Training, Office work, Inventory day, …) can be
// added later with NO schema change and NO code change to the consumers: the
// optimizer / Weather Ops / Auto Optimize all just read `row.blocks`. The config
// below (DAY_STATUS_META) only supplies DISPLAY (label/emoji/colours) + a sensible
// default-blocking value for the known statuses, and falls back gracefully for any
// status string it doesn't know. This is the ONE source of truth for days off.
//
// Pure data + tiny supabase helpers — intentionally NO React/lucide import so the
// server-side Weather Ops loader can use it without pulling a UI bundle.

import type { SupabaseClient } from '@supabase/supabase-js'

// Known statuses (config keys). `DayStatusRow.status` is a free-form string so the
// DB can hold future statuses the config hasn't been taught yet.
export type DayStatus = 'rain' | 'snow' | 'holiday' | 'vacation' | 'sick' | 'equipment' | 'personal' | 'custom'

export interface DayStatusRow {
  id: string
  date: string                 // yyyy-MM-dd
  status: string               // known DayStatus or a future one
  blocks: boolean              // AUTHORITATIVE — does this day block scheduling?
  label: string | null         // free text (custom reason / display override)
  notes: string | null         // longer free-text notes
  starts_at: string | null     // HH:mm[:ss] — day-specific working hours (null = default)
  ends_at: string | null
  crew_size: number | null     // day-specific crew override (null = business default)
  created_by: string | null
  created_at?: string | null
}

export interface DayStatusMeta {
  label: string
  emoji: string
  defaultBlocks: boolean       // default value for `blocks` when this status is set
  shade: string                // day-cell background tint
  badge: string                // status pill classes (border/bg/text)
}

// Display + default-blocking config for the known statuses. Add a status here for
// nice display (optional) — but the DB `blocks` column is what actually decides.
export const DAY_STATUS_META: Record<DayStatus, DayStatusMeta> = {
  rain:      { label: 'Rain',            emoji: '🌧️', defaultBlocks: true, shade: 'bg-blue-500/10',   badge: 'border-blue-400/40 bg-blue-400/10 text-blue-300' },
  snow:      { label: 'Snow',            emoji: '❄️', defaultBlocks: true, shade: 'bg-sky-500/10',    badge: 'border-sky-400/40 bg-sky-400/10 text-sky-300' },
  holiday:   { label: 'Holiday',         emoji: '🎉', defaultBlocks: true, shade: 'bg-violet-500/10', badge: 'border-violet-400/40 bg-violet-400/10 text-violet-300' },
  vacation:  { label: 'Vacation',        emoji: '🏖️', defaultBlocks: true, shade: 'bg-amber-500/10',  badge: 'border-amber-400/40 bg-amber-400/10 text-amber-300' },
  sick:      { label: 'Sick day',        emoji: '🤒', defaultBlocks: true, shade: 'bg-rose-500/10',   badge: 'border-rose-400/40 bg-rose-400/10 text-rose-300' },
  equipment: { label: 'Equipment issue', emoji: '🔧', defaultBlocks: true, shade: 'bg-orange-500/10', badge: 'border-orange-400/40 bg-orange-400/10 text-orange-300' },
  personal:  { label: 'Personal day',    emoji: '🧍', defaultBlocks: true, shade: 'bg-teal-500/10',   badge: 'border-teal-400/40 bg-teal-400/10 text-teal-300' },
  custom:    { label: 'Custom',          emoji: '🚫', defaultBlocks: true, shade: 'bg-slate-500/10',  badge: 'border-slate-400/40 bg-slate-400/10 text-slate-200' },
}

export const DAY_STATUSES = Object.keys(DAY_STATUS_META) as DayStatus[]
export const DAY_STATUS_SELECT = 'id, date, status, blocks, label, notes, starts_at, ends_at, crew_size, created_by, created_at'

function titleCase(s: string): string {
  return s.replace(/[_-]+/g, ' ').replace(/\b\w/g, c => c.toUpperCase())
}

const FALLBACK_META: DayStatusMeta = { label: 'Unavailable', emoji: '🚫', defaultBlocks: true, shade: 'bg-slate-500/10', badge: 'border-slate-400/40 bg-slate-400/10 text-slate-200' }

// Display meta for ANY status string — known ones from config, unknown ones get a
// graceful default (so a future status renders without a code change).
export function dayStatusMeta(status: string): DayStatusMeta {
  return DAY_STATUS_META[status as DayStatus] ?? { ...FALLBACK_META, label: titleCase(status) }
}

// Display label for a row — the custom free-text when present, else the status label.
export function dayStatusLabel(row: { status: string; label: string | null }): string {
  if (row.label && row.label.trim()) return row.label.trim()
  return dayStatusMeta(row.status).label
}

// Resolve rows into a fast lookup + the set of dates that block scheduling — driven
// by the stored `blocks` flag, NOT the status name. This is what the optimizer and
// Weather Ops consume.
export interface DayStatusMap {
  byDate: Record<string, DayStatusRow>
  blockedDates: Set<string>
}

export function buildDayStatusMap(rows: DayStatusRow[]): DayStatusMap {
  const byDate: Record<string, DayStatusRow> = {}
  const blockedDates = new Set<string>()
  for (const r of rows) {
    byDate[r.date] = r
    if (r.blocks) blockedDates.add(r.date)
  }
  return { byDate, blockedDates }
}

// True when this date is unavailable for scheduling (optimizer + Weather Ops must
// avoid it as a target; the owner can still manually drag a job onto it).
export function isDayBlocked(map: DayStatusMap | null | undefined, dateISO: string): boolean {
  return !!map?.blockedDates.has(dateISO)
}

// Count blocking days within [startISO, endISO] inclusive — for the optimizer's
// "N unavailable days were excluded" summary.
export function countBlockedInRange(map: DayStatusMap | null | undefined, startISO: string, endISO: string): number {
  if (!map) return 0
  let n = 0
  for (const d of map.blockedDates) if (d >= startISO && d <= endISO) n++
  return n
}

// ── Per-day capacity (Day Settings: crew + working-hours overrides) ──────────────
// The business defaults: `crew` (default crew size) and `hours` (work-hours per
// crew per day = daily_capacity_hours ÷ default_crew_size). Available LABOR-HOURS
// for a day = crew × hours, so with no override a day equals the existing global
// capacity exactly (nothing changes). An override sets crew and/or start/end time
// for THAT day only. A blocked day has 0 capacity.
export interface CapacityDefaults { crew: number; hours: number }

function hoursBetween(start: string, end: string): number {
  const [sh, sm = '0'] = start.split(':'); const [eh, em = '0'] = end.split(':')
  const mins = (Number(eh) * 60 + Number(em)) - (Number(sh) * 60 + Number(sm))
  return Math.max(0, mins / 60)
}
function hhmmToMin(hhmm: string): number { const [h, m = '0'] = hhmm.split(':'); return Number(h) * 60 + Number(m) }
function minToHHMM(min: number): string { return `${String(Math.floor(min / 60) % 24).padStart(2, '0')}:${String(Math.round(min) % 60).padStart(2, '0')}` }

// Crew working that day (override → default).
export function dayCrew(row: DayStatusRow | null | undefined, def: CapacityDefaults): number {
  return row?.crew_size && row.crew_size > 0 ? row.crew_size : def.crew
}
// Work-hours (wall-clock) that day (override start/end → default).
export function dayWorkHours(row: DayStatusRow | null | undefined, def: CapacityDefaults): number {
  return row?.starts_at && row?.ends_at ? hoursBetween(row.starts_at, row.ends_at) : def.hours
}
// Available LABOR-HOURS for a date: 0 when blocked, else crew × work-hours.
export function dayLaborHours(row: DayStatusRow | null | undefined, def: CapacityDefaults): number {
  if (row?.blocks) return 0
  return dayCrew(row, def) * dayWorkHours(row, def)
}
// Effective working START for a day (override → business default), 'HH:mm'. The
// scheduler feeds this to the timing engine so ETAs shift when the day's start does.
export function dayStartTime(row: DayStatusRow | null | undefined, defaultStart: string): string {
  return row?.starts_at?.slice(0, 5) || defaultStart
}
// Effective working END for a day: explicit override, else start + per-crew hours.
export function dayEndTime(row: DayStatusRow | null | undefined, def: CapacityDefaults, defaultStart: string): string {
  if (row?.ends_at) return row.ends_at.slice(0, 5)
  return minToHHMM(hhmmToMin(dayStartTime(row, defaultStart)) + Math.round(def.hours * 60))
}
// A per-date labor-hours function for the optimizer / capacity math / Weather Ops.
export function buildCapacityForDate(map: DayStatusMap | null | undefined, def: CapacityDefaults): (dateISO: string) => number {
  return (dateISO: string) => dayLaborHours(map?.byDate[dateISO] ?? null, def)
}
// True when a day carries a crew/hours override (vs. just a status / nothing).
export function hasCapacityOverride(row: DayStatusRow | null | undefined): boolean {
  return !!(row && (row.crew_size != null || (row.starts_at && row.ends_at)))
}

// ── supabase helpers (shared by the scheduler UI + the Weather Ops loader) ──────
export async function loadDayStatuses(supabase: SupabaseClient, userId: string): Promise<DayStatusRow[]> {
  const { data } = await supabase.from('day_statuses').select(DAY_STATUS_SELECT).eq('user_id', userId)
  return (data as DayStatusRow[]) || []
}

export interface SetDayStatusInput {
  status: string
  blocks?: boolean             // defaults to the status's defaultBlocks (known) or true
  label?: string | null
  notes?: string | null
  startsAt?: string | null     // HH:mm — day-specific working hours (optional)
  endsAt?: string | null
  crewSize?: number | null     // day-specific crew override (optional)
  createdBy?: string | null
}

// Set (or change) a day's status — upsert on (user, date). Fields the caller
// doesn't specify are PRESERVED from the existing row (setting a day to "Rain"
// must not wipe a crew/hours override saved via Day Settings — they're
// independent facts about the same day).
export async function setDayStatus(supabase: SupabaseClient, userId: string, date: string, input: SetDayStatusInput) {
  const blocks = input.blocks ?? dayStatusMeta(input.status).defaultBlocks
  const { data } = await supabase.from('day_statuses')
    .select('label, notes, starts_at, ends_at, crew_size')
    .eq('user_id', userId).eq('date', date).maybeSingle()
  const cur = data as Pick<DayStatusRow, 'label' | 'notes' | 'starts_at' | 'ends_at' | 'crew_size'> | null
  return supabase.from('day_statuses').upsert({
    user_id: userId, date, status: input.status, blocks,
    label: input.label !== undefined ? input.label : (cur?.label ?? null),
    notes: input.notes !== undefined ? input.notes : (cur?.notes ?? null),
    starts_at: input.startsAt !== undefined ? input.startsAt : (cur?.starts_at ?? null),
    ends_at: input.endsAt !== undefined ? input.endsAt : (cur?.ends_at ?? null),
    crew_size: input.crewSize !== undefined ? input.crewSize : (cur?.crew_size ?? null),
    created_by: input.createdBy ?? null, updated_at: new Date().toISOString(),
  }, { onConflict: 'user_id,date' })
}

// Save ONLY a day's capacity override (crew + working hours) without changing its
// block status — for the Day Settings panel. Upserts so it merges with any status
// already on the day. An override with no block uses status 'custom', blocks=false.
export async function setDayCapacity(
  supabase: SupabaseClient, userId: string, date: string,
  cur: DayStatusRow | null,
  patch: { crewSize?: number | null; startsAt?: string | null; endsAt?: string | null },
) {
  const status = cur?.status ?? 'custom'
  const blocks = cur?.blocks ?? false
  return supabase.from('day_statuses').upsert({
    user_id: userId, date, status, blocks,
    label: cur?.label ?? null, notes: cur?.notes ?? null,
    starts_at: patch.startsAt !== undefined ? patch.startsAt : (cur?.starts_at ?? null),
    ends_at: patch.endsAt !== undefined ? patch.endsAt : (cur?.ends_at ?? null),
    crew_size: patch.crewSize !== undefined ? patch.crewSize : (cur?.crew_size ?? null),
    created_by: cur?.created_by ?? null, updated_at: new Date().toISOString(),
  }, { onConflict: 'user_id,date' })
}

// Return a day to Normal (delete its row).
export async function clearDayStatus(supabase: SupabaseClient, userId: string, date: string) {
  return supabase.from('day_statuses').delete().eq('user_id', userId).eq('date', date)
}
