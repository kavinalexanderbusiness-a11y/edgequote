// ── Day Status (per-day availability) ───────────────────────────────────────────
// A flexible status for a single calendar day. "Normal" is the absence of a row;
// any stored row is a non-Normal status. Today EVERY non-Normal status blocks
// scheduling (the optimizer, Weather Ops and Auto Optimize must treat the day as
// unavailable unless the owner manually overrides by dragging a job onto it). The
// `blocks` flag lives in config — so a future non-blocking status (e.g. "Half day")
// is one entry here, with NO schema change. This is the ONE source of truth for
// which days are off; the calendar, optimizer and Weather Ops all read it.
//
// Pure data + tiny supabase helpers — intentionally NO React/lucide import so the
// server-side Weather Ops loader can use it without pulling a UI bundle. The
// scheduler UI maps each status to an icon on its side.

import type { SupabaseClient } from '@supabase/supabase-js'

export type DayStatus = 'rain' | 'snow' | 'holiday' | 'vacation' | 'sick' | 'equipment' | 'personal' | 'custom'

export interface DayStatusRow {
  id: string
  date: string            // yyyy-MM-dd
  status: DayStatus
  label: string | null    // free text when status === 'custom'
}

export interface DayStatusMeta {
  label: string
  emoji: string
  blocks: boolean         // true → optimizer / Weather Ops treat the day as unavailable
  // Tailwind classes for the calendar day shading + the status badge. The scheduler
  // UI may use these directly so disabled days look consistent everywhere.
  shade: string           // day-cell background tint
  badge: string           // status pill (border/bg/text)
}

// Order is the menu order. Every entry here currently blocks; add a non-blocking
// status later by setting blocks:false — nothing else changes.
export const DAY_STATUS_META: Record<DayStatus, DayStatusMeta> = {
  rain:      { label: 'Rain (unavailable)', emoji: '🌧️', blocks: true, shade: 'bg-blue-500/10',   badge: 'border-blue-400/40 bg-blue-400/10 text-blue-300' },
  snow:      { label: 'Snow (unavailable)', emoji: '❄️', blocks: true, shade: 'bg-sky-500/10',    badge: 'border-sky-400/40 bg-sky-400/10 text-sky-300' },
  holiday:   { label: 'Holiday',            emoji: '🎉', blocks: true, shade: 'bg-violet-500/10', badge: 'border-violet-400/40 bg-violet-400/10 text-violet-300' },
  vacation:  { label: 'Vacation',           emoji: '🏖️', blocks: true, shade: 'bg-amber-500/10',  badge: 'border-amber-400/40 bg-amber-400/10 text-amber-300' },
  sick:      { label: 'Sick day',           emoji: '🤒', blocks: true, shade: 'bg-rose-500/10',   badge: 'border-rose-400/40 bg-rose-400/10 text-rose-300' },
  equipment: { label: 'Equipment issue',    emoji: '🔧', blocks: true, shade: 'bg-orange-500/10', badge: 'border-orange-400/40 bg-orange-400/10 text-orange-300' },
  personal:  { label: 'Personal day',       emoji: '🧍', blocks: true, shade: 'bg-teal-500/10',   badge: 'border-teal-400/40 bg-teal-400/10 text-teal-300' },
  custom:    { label: 'Custom',             emoji: '🚫', blocks: true, shade: 'bg-slate-500/10',  badge: 'border-slate-400/40 bg-slate-400/10 text-slate-200' },
}

export const DAY_STATUSES = Object.keys(DAY_STATUS_META) as DayStatus[]
export const DAY_STATUS_SELECT = 'id, date, status, label'

// Display label for a row — the custom free-text when present, else the status label.
export function dayStatusLabel(row: DayStatusRow): string {
  if (row.status === 'custom' && row.label && row.label.trim()) return row.label.trim()
  return DAY_STATUS_META[row.status]?.label ?? 'Unavailable'
}

// Resolve rows into a fast lookup + the set of dates that block scheduling. This is
// what the optimizer and Weather Ops consume: `blockedDates` is the authoritative
// "do not schedule / never recommend" set.
export interface DayStatusMap {
  byDate: Record<string, DayStatusRow>
  blockedDates: Set<string>
}

export function buildDayStatusMap(rows: DayStatusRow[]): DayStatusMap {
  const byDate: Record<string, DayStatusRow> = {}
  const blockedDates = new Set<string>()
  for (const r of rows) {
    byDate[r.date] = r
    if (DAY_STATUS_META[r.status]?.blocks) blockedDates.add(r.date)
  }
  return { byDate, blockedDates }
}

// True when this date is unavailable for scheduling (the optimizer + Weather Ops
// must avoid it as a target; the owner can still manually drag a job onto it).
export function isDayBlocked(map: DayStatusMap | null | undefined, dateISO: string): boolean {
  return !!map?.blockedDates.has(dateISO)
}

// ── supabase helpers (shared by the scheduler UI + the Weather Ops loader) ──────
export async function loadDayStatuses(supabase: SupabaseClient, userId: string): Promise<DayStatusRow[]> {
  const { data } = await supabase.from('day_statuses').select(DAY_STATUS_SELECT).eq('user_id', userId)
  return (data as DayStatusRow[]) || []
}

// Set (or change) a day's status — upsert on (user, date). Pass label only for custom.
export async function setDayStatus(supabase: SupabaseClient, userId: string, date: string, status: DayStatus, label?: string | null) {
  return supabase.from('day_statuses').upsert(
    { user_id: userId, date, status, label: label ?? null, updated_at: new Date().toISOString() },
    { onConflict: 'user_id,date' },
  )
}

// Return a day to Normal (delete its row).
export async function clearDayStatus(supabase: SupabaseClient, userId: string, date: string) {
  return supabase.from('day_statuses').delete().eq('user_id', userId).eq('date', date)
}
