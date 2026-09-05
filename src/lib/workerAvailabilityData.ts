// ── Loading and writing availability ─────────────────────────────────────────
// lib/workerAvailability.ts is pure; this is the ONE place that knows which
// tables a week comes from. Engine · loader · UI, the same split as
// dayFit/dayFitLoad and estimateVsActual/estimateVsActualData.
//
// TENANCY: every read and write is `.eq('user_id', userId)` on RLS own-row
// tables. The filter is load-bearing the day a caller hands this a service-role
// client — one business's roster must never shape another's plan.

import type { SupabaseClient } from '@supabase/supabase-js'
import type { PtoEntry, WorkerAvailability } from '@/types'

export type AvailabilityLoad =
  | { outcome: 'ok'; rows: WorkerAvailability[] }
  /** The read failed. NOT "nobody has a pattern" — that is a different fact,
   *  and conflating them is how a failed read becomes "everyone's available". */
  | { outcome: 'unavailable'; reason: string }

export async function loadWorkerAvailability(
  supabase: SupabaseClient, userId: string, opts?: { technicianId?: string },
): Promise<AvailabilityLoad> {
  if (!userId) return { outcome: 'unavailable', reason: 'not_signed_in' }
  let q = supabase.from('worker_availability').select('*').eq('user_id', userId)
  if (opts?.technicianId) q = q.eq('technician_id', opts.technicianId)
  const { data, error } = await q
  if (error) return { outcome: 'unavailable', reason: error.message || 'availability_read_failed' }
  return { outcome: 'ok', rows: (data as WorkerAvailability[]) ?? [] }
}

/**
 * Write ONE weekday of one worker's week. Upsert on the natural key, so the
 * seven rows can never multiply — and so a double-tap on a phone is idempotent
 * rather than a constraint violation the worker has to interpret.
 */
export async function saveWorkerDay(
  supabase: SupabaseClient,
  args: {
    userId: string; technicianId: string; weekday: number
    available: boolean; start: string | null; end: string | null
  },
): Promise<{ ok: true } | { ok: false; message: string }> {
  const { error } = await supabase.from('worker_availability').upsert({
    user_id: args.userId,
    technician_id: args.technicianId,
    weekday: args.weekday,
    available: args.available,
    // An unavailable day states no window — the CHECK constraint enforces it,
    // and sending stale times would be rejected rather than ignored.
    start_time: args.available ? args.start : null,
    end_time: args.available ? args.end : null,
  }, { onConflict: 'technician_id,weekday' })
  return error ? { ok: false, message: error.message } : { ok: true }
}

// ── Time-off decisions (owner) ───────────────────────────────────────────────
// APPROVE is the only thing that changes planning availability, so it is the
// only write that stamps money: the wage is snapshotted at the moment of the
// decision, the same rule as booking and clock-in — a later raise must never
// re-value a day already granted.

export async function decideTimeOff(
  supabase: SupabaseClient,
  entry: PtoEntry,
  decision: 'approved' | 'declined',
  opts?: { paid?: boolean; hourlyRate?: number | null },
): Promise<{ ok: true } | { ok: false; message: string }> {
  const patch: Record<string, unknown> = { status: decision, decided_at: new Date().toISOString() }
  if (decision === 'approved') {
    const paid = opts?.paid ?? false
    patch.is_paid = paid
    patch.hourly_rate = paid ? (opts?.hourlyRate ?? null) : null
  }
  const { error } = await supabase.from('pto_entries').update(patch).eq('id', entry.id)
  return error ? { ok: false, message: error.message } : { ok: true }
}
