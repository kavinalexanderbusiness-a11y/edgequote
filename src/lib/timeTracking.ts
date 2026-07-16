// ── Paid time engine ─────────────────────────────────────────────────────────
// THE one place "how long did someone work, and what did it cost" is answered.
// Every surface (clock in/out button, timesheet, future payroll export) reads
// from here so no two screens can disagree about a shift.
//
// Pure data + tiny supabase helpers — NO React import (mirrors lib/crews.ts and
// lib/dayStatus).
//
// TWO THINGS THIS DELIBERATELY DOES NOT DO
//  1. It never derives hours from `technicians.status`. That field is dispatch
//     state (where someone is right now); a tech can be 'off' with an open shift
//     (forgot to clock out) or 'on_job' having never clocked in. Paid time comes
//     from time_entries and nothing else.
//  2. It never reads `technicians.hourly_wage` to price a PAST shift. The rate is
//     snapshotted onto the entry at clock-in; wage is only the default for the
//     next one. Pricing history off the live wage would silently rewrite every
//     past shift's cost the moment someone gets a raise.

import type { SupabaseClient } from '@supabase/supabase-js'
import type { TimeEntry, Technician } from '@/types'

// ── Duration ─────────────────────────────────────────────────────────────────

/**
 * Paid minutes for an entry.
 *
 * CLOSED shift -> the DB's generated `minutes_worked` is authoritative and is
 * returned as-is; never recompute it here, or the timesheet and the database
 * could disagree.
 *
 * OPEN shift -> the DB has no value yet (an unfinished shift has no duration),
 * so this mirrors the SAME formula live, for display only. That mirroring is the
 * one intentional duplication of the generated-column expression:
 *   greatest(0, (clock_out - clock_in) minutes - break_minutes)
 * If the DB formula ever changes, change it here too.
 */
export function entryMinutes(e: TimeEntry, now: Date = new Date()): number {
  if (e.clock_out) return e.minutes_worked ?? 0
  const elapsed = Math.floor((now.getTime() - new Date(e.clock_in).getTime()) / 60_000)
  return Math.max(0, elapsed - (e.break_minutes || 0))
}

/** Labour cost of an entry, from the SNAPSHOT rate. 0 when no rate was stamped. */
export function entryCost(e: TimeEntry, now?: Date): number {
  if (e.hourly_rate == null) return 0
  return Math.round((entryMinutes(e, now) / 60) * Number(e.hourly_rate) * 100) / 100
}

/** "7h 30m" / "45m" / "0m" — one duration format for every surface. */
export function formatDuration(minutes: number): string {
  const m = Math.max(0, Math.round(minutes))
  const h = Math.floor(m / 60)
  const rem = m % 60
  if (!h) return `${rem}m`
  if (!rem) return `${h}h`
  return `${h}h ${rem}m`
}

/** Decimal hours (2dp) — the shape payroll systems and CSV exports want. */
export function decimalHours(minutes: number): number {
  return Math.round((minutes / 60) * 100) / 100
}

// ── Open shifts ──────────────────────────────────────────────────────────────

export function isOpen(e: TimeEntry): boolean {
  return e.clock_out == null
}

/** The tech's open shift, if any. The DB permits at most one (partial unique index). */
export function openEntryFor(entries: TimeEntry[], technicianId: string): TimeEntry | null {
  return entries.find(e => e.technician_id === technicianId && isOpen(e)) ?? null
}

// ── Rollups ──────────────────────────────────────────────────────────────────

export interface TimeTotals {
  minutes: number
  cost: number
  entries: number
}

export function totals(entries: TimeEntry[], now?: Date): TimeTotals {
  return entries.reduce<TimeTotals>(
    (acc, e) => ({
      minutes: acc.minutes + entryMinutes(e, now),
      cost: Math.round((acc.cost + entryCost(e, now)) * 100) / 100,
      entries: acc.entries + 1,
    }),
    { minutes: 0, cost: 0, entries: 0 },
  )
}

export function totalsByTechnician(entries: TimeEntry[], now?: Date): Record<string, TimeTotals> {
  const out: Record<string, TimeTotals> = {}
  for (const e of entries) {
    const cur = out[e.technician_id] ?? { minutes: 0, cost: 0, entries: 0 }
    out[e.technician_id] = {
      minutes: cur.minutes + entryMinutes(e, now),
      cost: Math.round((cur.cost + entryCost(e, now)) * 100) / 100,
      entries: cur.entries + 1,
    }
  }
  return out
}

// ── Supabase helpers ─────────────────────────────────────────────────────────

/** Entries overlapping [fromISO, toISO] by clock_in, newest first. */
export async function loadTimeEntries(
  supabase: SupabaseClient,
  userId: string,
  opts: { fromISO?: string; toISO?: string; technicianId?: string } = {},
): Promise<TimeEntry[]> {
  let q = supabase.from('time_entries').select('*').eq('user_id', userId)
  if (opts.technicianId) q = q.eq('technician_id', opts.technicianId)
  if (opts.fromISO) q = q.gte('clock_in', opts.fromISO)
  if (opts.toISO) q = q.lte('clock_in', opts.toISO)
  const { data, error } = await q.order('clock_in', { ascending: false }).limit(2000)
  if (error) throw new Error(error.message)
  return (data as TimeEntry[]) || []
}

export type ClockInResult = { ok: true; entry: TimeEntry } | { ok: false; error: string }

/**
 * Start a shift, stamping the technician's CURRENT wage onto the entry.
 * A second open shift is rejected by the DB's partial unique index (23505) —
 * translated here into something an owner can act on.
 */
export async function clockIn(
  supabase: SupabaseClient,
  args: { userId: string; technician: Technician; jobId?: string | null; notes?: string | null },
): Promise<ClockInResult> {
  const { data, error } = await supabase
    .from('time_entries')
    .insert({
      user_id: args.userId,
      technician_id: args.technician.id,
      job_id: args.jobId ?? null,
      hourly_rate: args.technician.hourly_wage,   // snapshot — see header
      notes: args.notes ?? null,
      clock_in: new Date().toISOString(),
    })
    .select()
    .single()
  if (error) {
    if (error.code === '23505') {
      return { ok: false, error: `${args.technician.name} is already clocked in.` }
    }
    return { ok: false, error: error.message }
  }
  return { ok: true, entry: data as TimeEntry }
}

export type UpdateEntryResult = { ok: true; entry: TimeEntry } | { ok: false; error: string }

export interface TimeEntryPatch {
  clock_in?: string
  /** null re-opens the shift (puts the tech back on the clock). */
  clock_out?: string | null
  break_minutes?: number
  notes?: string | null
}

/**
 * Correct a shift after the fact — the owner fixing a forgotten clock-out or a
 * mistyped time. Goes through here (not a raw update in a component) so every
 * DB guard is translated into something an owner can act on, in one place.
 *
 * `minutes_worked` is deliberately never patched: it is GENERATED, so Postgres
 * recomputes it from whatever times land here. Sending it would be rejected.
 */
export async function updateTimeEntry(
  supabase: SupabaseClient,
  entryId: string,
  patch: TimeEntryPatch,
): Promise<UpdateEntryResult> {
  const row: Record<string, unknown> = {}
  if (patch.clock_in !== undefined) row.clock_in = patch.clock_in
  if (patch.clock_out !== undefined) row.clock_out = patch.clock_out
  if (patch.break_minutes !== undefined) row.break_minutes = Math.max(0, Math.round(patch.break_minutes))
  if (patch.notes !== undefined) row.notes = patch.notes
  if (!Object.keys(row).length) return { ok: false, error: 'Nothing to save.' }

  const { data, error } = await supabase.from('time_entries').update(row).eq('id', entryId).select().maybeSingle()
  if (error) {
    // 23514 = check_violation: clock_out <= clock_in, or a negative break.
    if (error.code === '23514') {
      return { ok: false, error: 'A shift has to end after it starts, and a break can’t be negative.' }
    }
    // 23505 = the one-open-shift-per-technician index: re-opening this shift
    // would leave the tech on the clock twice.
    if (error.code === '23505') {
      return { ok: false, error: 'That person already has an open shift — close it before re-opening this one.' }
    }
    return { ok: false, error: error.message }
  }
  if (!data) return { ok: false, error: 'That shift no longer exists.' }
  return { ok: true, entry: data as TimeEntry }
}

export type ClockOutResult = { ok: true; entry: TimeEntry } | { ok: false; error: string }

/**
 * End a shift. Guarded by `.is('clock_out', null)` so two tabs racing can't
 * overwrite an already-closed shift's end time — the second one simply finds no
 * row. A clock_out before clock_in is rejected by the DB check (23514).
 */
export async function clockOut(
  supabase: SupabaseClient,
  entryId: string,
  opts: { breakMinutes?: number } = {},
): Promise<ClockOutResult> {
  const patch: Record<string, unknown> = { clock_out: new Date().toISOString() }
  if (opts.breakMinutes != null) patch.break_minutes = Math.max(0, Math.round(opts.breakMinutes))
  const { data, error } = await supabase
    .from('time_entries')
    .update(patch)
    .eq('id', entryId)
    .is('clock_out', null)
    .select()
    .maybeSingle()
  if (error) {
    if (error.code === '23514') return { ok: false, error: 'That shift would end before it started.' }
    return { ok: false, error: error.message }
  }
  if (!data) return { ok: false, error: 'That shift was already closed.' }
  return { ok: true, entry: data as TimeEntry }
}
