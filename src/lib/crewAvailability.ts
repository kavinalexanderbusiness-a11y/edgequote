// ── Crew Mode: a worker's own availability and time off ──────────────────────
// Four RPCs, the same contract every other crew door has (lib/crewAccess):
// SECURITY DEFINER, typed parameters, identity resolved from the roster
// switches — never from anything the client sends. A crew session has NO table
// access at all, so `worker_availability` and `pto_entries` are unreachable to
// it except through these.
//
// ⭐ THE PERMISSION RULE, and it lives in the DATABASE, not here: every one of
// these resolves `crew_technician_id()` from the session and can therefore only
// ever address the CALLER'S OWN row. There is no technician-id parameter to
// tamper with, which is why an ordinary worker cannot edit somebody else's
// week — not by convention, but because no such request can be expressed.
//
// Reads follow the three-outcome rule: a failed read is not a revoked account
// and neither is an empty week (see CrewDayResult's note — folding error into
// null is how a worker in a dead zone gets told they were fired).

import type { SupabaseClient } from '@supabase/supabase-js'
import type { PtoKind, PtoStatus } from '@/types'

export interface CrewPatternDay {
  weekday: number
  available: boolean
  start_time: string | null
  end_time: string | null
}

export interface CrewTimeOffRow {
  id: string
  date: string
  hours: number
  kind: PtoKind
  status: PtoStatus
}

export interface CrewAvailability {
  pattern: CrewPatternDay[]
  time_off: CrewTimeOffRow[]
}

export type CrewAvailabilityResult =
  | { kind: 'ok'; availability: CrewAvailability }
  | { kind: 'revoked' }
  | { kind: 'error'; message: string }

export async function loadCrewAvailability(supabase: SupabaseClient): Promise<CrewAvailabilityResult> {
  const { data, error } = await supabase.rpc('crew_my_availability')
  if (error) return { kind: 'error', message: error.message }
  if (!data) return { kind: 'revoked' }
  return { kind: 'ok', availability: data as CrewAvailability }
}

/** What a refused write means, in words a worker can act on. */
const WRITE_REASONS: Record<string, string> = {
  bad_weekday: 'That day couldn’t be saved.',
  bad_window: 'The finish time has to be after the start time.',
  past_date: 'That date has already passed — pick a day still to come.',
  bad_hours: 'Hours have to be between 0 and 24.',
  bad_kind: 'Pick one of the listed reasons.',
  already_booked: 'You already have that day requested or booked off.',
  not_pending: 'That request has already been decided — talk to the office to change it.',
}

export type CrewWriteResult = { ok: true } | { ok: false; message: string }

const interpret = (data: unknown, error: { message: string } | null): CrewWriteResult => {
  if (error) return { ok: false, message: error.message }
  const row = data as { ok?: boolean; reason?: string } | null
  if (row?.ok) return { ok: true }
  const reason = row?.reason ?? ''
  return { ok: false, message: WRITE_REASONS[reason] ?? 'That didn’t save. Try again.' }
}

export async function setCrewDayAvailability(
  supabase: SupabaseClient,
  weekday: number, available: boolean, start: string | null, end: string | null,
): Promise<CrewWriteResult> {
  const { data, error } = await supabase.rpc('crew_set_day_availability', {
    p_weekday: weekday, p_available: available, p_start_time: start, p_end_time: end,
  })
  return interpret(data, error)
}

export async function requestCrewTimeOff(
  supabase: SupabaseClient,
  args: { date: string; hours: number; kind: PtoKind; note?: string | null },
): Promise<CrewWriteResult> {
  const { data, error } = await supabase.rpc('crew_request_time_off', {
    p_date: args.date, p_hours: args.hours, p_kind: args.kind, p_note: args.note ?? null,
  })
  return interpret(data, error)
}

export async function cancelCrewTimeOff(supabase: SupabaseClient, id: string): Promise<CrewWriteResult> {
  const { data, error } = await supabase.rpc('crew_cancel_time_off', { p_id: id })
  return interpret(data, error)
}

/** The kinds a worker may ask for. 'holiday' is the owner's calendar, applied
 *  from the holiday list — never requested, so it is not offered here. */
export const REQUESTABLE_KINDS: PtoKind[] = ['vacation', 'sick', 'personal', 'bereavement']
