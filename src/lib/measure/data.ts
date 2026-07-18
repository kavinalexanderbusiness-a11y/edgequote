// ── Measurement persistence ──────────────────────────────────────────────────
// The only place property_measurements is read or written. Everything it stores
// is computed by ./index — this file never does geometry and never invents a
// number.
//
// IT ALSO NEVER WRITES properties.lawn_sqft (or fence_length / mulch_area /
// rock_area). Those are derived from this table by a DB trigger. Two writers
// drift; one writer plus a derived mirror cannot. That is what lets pricing and
// the customer portal keep reading exactly what they read today while this engine
// lands underneath them, with zero changes to either.

import type { SupabaseClient } from '@supabase/supabase-js'
import type { Measurement, MeasurementShape, PropertyMeasurements } from './index'
import { measureShapes, usableShapes, readMeasurements } from './index'
import type { MeasurementKind, MeasurementSource } from './kinds'
import { kindDef } from './kinds'
import { assessConfidence, canAutoMeasure, type AutoEvidence } from './confidence'

const SELECT =
  'id, created_at, updated_at, user_id, property_id, kind, unit, value, shapes, source, confidence, confidence_reason, needs_review, notes, measured_at'

export async function loadMeasurements(
  supabase: SupabaseClient,
  userId: string,
  propertyId: string,
): Promise<PropertyMeasurements> {
  const { data } = await supabase
    .from('property_measurements').select(SELECT)
    .eq('user_id', userId).eq('property_id', propertyId)
  return readMeasurements((data as Measurement[] | null) ?? [])
}

/** Measurements for many properties at once — one query, not N. */
export async function loadMeasurementsFor(
  supabase: SupabaseClient,
  userId: string,
  propertyIds: string[],
): Promise<Map<string, PropertyMeasurements>> {
  const out = new Map<string, PropertyMeasurements>()
  if (!propertyIds.length) return out
  const { data } = await supabase
    .from('property_measurements').select(SELECT)
    .eq('user_id', userId).in('property_id', propertyIds)
  const byProp = new Map<string, Measurement[]>()
  for (const row of (data as Measurement[] | null) ?? []) {
    const list = byProp.get(row.property_id)
    if (list) list.push(row); else byProp.set(row.property_id, [row])
  }
  for (const id of propertyIds) out.set(id, readMeasurements(byProp.get(id) ?? []))
  return out
}

export type SaveResult = { ok: true; measurement: Measurement } | { ok: false; error: string }

/**
 * Save a TRACED measurement — the owner drew it.
 *
 * The value is derived from the shapes here rather than accepted from the caller,
 * so a stored number can always be re-derived from its own geometry. A caller
 * cannot save "5,000 sq ft" against a shape that measures 900.
 */
export async function saveTraced(
  supabase: SupabaseClient,
  args: { userId: string; propertyId: string; kind: MeasurementKind; shapes: MeasurementShape[]; notes?: string | null },
): Promise<SaveResult> {
  const shapes = usableShapes(args.kind, args.shapes)
  if (!shapes.length) {
    const d = kindDef(args.kind)
    return { ok: false, error: d.capture === 'point' ? 'Drop at least one pin first.' : 'Draw the shape first.' }
  }
  return persist(supabase, {
    ...args,
    shapes,
    value: measureShapes(args.kind, shapes),
    source: 'traced',
    evidence: null,
  })
}

/**
 * Save a MANUAL measurement — the owner typed a number they're asserting.
 *
 * No shapes: there is no geometry, and pretending otherwise would make the value
 * look re-derivable when it isn't. Confidence is high because this is the owner's
 * own figure, not EdgeQuote's estimate — but `source` records that nobody traced
 * it, so a later reader can tell the difference.
 */
export async function saveManual(
  supabase: SupabaseClient,
  args: { userId: string; propertyId: string; kind: MeasurementKind; value: number; notes?: string | null },
): Promise<SaveResult> {
  if (!Number.isFinite(args.value) || args.value < 0) {
    return { ok: false, error: 'Enter a number of 0 or more.' }
  }
  return persist(supabase, { ...args, shapes: [], source: 'manual', evidence: null })
}

/**
 * Save an AUTO measurement — EdgeQuote's own estimate.
 *
 * Refuses outright for any kind that cannot be honestly estimated from imagery,
 * rather than returning a number with a caveat. This is the gate that stops
 * `2.3 × building footprint` — a Calgary LAWN heuristic — being served as a
 * driveway, a fence or a tree count.
 */
export async function saveAuto(
  supabase: SupabaseClient,
  args: { userId: string; propertyId: string; kind: MeasurementKind; value: number; evidence: AutoEvidence },
): Promise<SaveResult> {
  const gate = canAutoMeasure(args.kind)
  if (!gate.ok) return { ok: false, error: gate.reason }
  if (!Number.isFinite(args.value) || args.value < 0) {
    return { ok: false, error: 'The estimate did not produce a usable number.' }
  }
  return persist(supabase, { ...args, shapes: [], source: 'auto', evidence: args.evidence })
}

async function persist(
  supabase: SupabaseClient,
  args: {
    userId: string; propertyId: string; kind: MeasurementKind; value: number
    shapes: MeasurementShape[]; source: MeasurementSource; evidence: AutoEvidence | null
    notes?: string | null
  },
): Promise<SaveResult> {
  const d = kindDef(args.kind)
  const c = assessConfidence({ source: args.source, kind: args.kind, evidence: args.evidence })

  const { data, error } = await supabase
    .from('property_measurements')
    .upsert({
      user_id: args.userId,
      property_id: args.propertyId,
      kind: args.kind,
      // Never passed in by a caller: the unit follows from the kind, and the DB
      // re-checks it. A fence can't be stored in square feet from any code path.
      unit: d.unit,
      value: Math.max(0, Math.round(args.value * 100) / 100),
      shapes: args.shapes,
      source: args.source,
      confidence: c.level,
      confidence_reason: c.reason,
      needs_review: c.needsReview,
      notes: args.notes?.trim() || null,
      measured_at: new Date().toISOString(),
    }, { onConflict: 'property_id,kind' })
    .select(SELECT)
    .maybeSingle()

  if (error) {
    // 23514 = the kind↔unit CHECK. Reaching it means this file and kinds.ts
    // disagree, which is a bug worth naming rather than a message worth softening.
    if (error.code === '23514') {
      return { ok: false, error: `A ${d.label.toLowerCase()} can't be stored in ${d.unit}. This is a bug — please report it.` }
    }
    return { ok: false, error: error.message }
  }
  if (!data) return { ok: false, error: 'Could not save the measurement.' }
  return { ok: true, measurement: data as Measurement }
}

/** Remove a measurement. The trigger clears its legacy mirror column too. */
export async function deleteMeasurement(
  supabase: SupabaseClient,
  id: string,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const { error } = await supabase.from('property_measurements').delete().eq('id', id)
  return error ? { ok: false, error: error.message } : { ok: true }
}
