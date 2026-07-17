// ── THE measurement engine ───────────────────────────────────────────────────
// One canonical answer to "how much of it is there", and the stable seam Pricing
// and Quote V2 will consume later.
//
// WHAT THIS REPLACES
// Four independent implementations, each with its own `M2_TO_SQFT`:
//   src/components/properties/MeasureTool.tsx   (sections, haptics)
//   src/components/quotes/QuoteMeasure.tsx      (no sections, no haptics)
//   src/app/book/[token]/BookingClient.tsx      (public booking)
//   src/lib/autoMeasure.ts                      (footprint estimate)
// They disagreed about whether sections exist, could only run inside a browser
// with the Maps SDK loaded, and could never be tested. This module is pure and
// runs anywhere; the components become renderers over it.
//
// THE CONTRACT FOR CONSUMERS (pricing, quoting — later, not now)
//   readMeasurements(rows)  -> PropertyMeasurements
//   .value(kind)            -> number | null   ("how much")
//   .unit(kind)             -> MeasurementUnit ("of what")
//   .confidence(kind)       -> Confidence|null ("how much do we trust it")
//   .overall                -> Confidence|null (the WEAKEST — see ./confidence)
// A consumer never has to know how a number was captured, and can always ask how
// trustworthy it is before putting it in front of a customer. That question was
// unanswerable before: `measured_sqft` was a bare number with ft² baked into its
// name and no provenance at all.
//
// THIS FILE CONTAINS NO PRICING. No rates, no money, no cadence. That is a hard
// boundary: the engine says how much there is; pricing decides what it's worth.

import type { LatLng } from './geometry'
import {
  ringsAreaSqFt, pathLengthFt, isTraceableRing, isTraceablePath, ringCentroid,
} from './geometry'
import type { MeasurementKind, MeasurementUnit, MeasurementSource } from './kinds'
import { kindDef, isMeasurementKind, formatMeasurement } from './kinds'
import type { Confidence } from './confidence'
import { weakestConfidence } from './confidence'

export * from './geometry'
export * from './kinds'
export * from './confidence'

/**
 * One drawn thing. Which field is populated follows the kind's capture mode:
 *   area  -> ring   (closed; do not repeat the first point)
 *   line  -> path   (open; a fence along 3 sides is 3 segments, not 4)
 *   point -> point  (one tree)
 *
 * `label` replaces the old fixed six-section enum (front/back/left/right/
 * boulevard/other), which could only ever describe a lawn. A free label lets a
 * fence run be "street side" and a bed be "north bed" without a schema change.
 */
export interface MeasurementShape {
  id: string
  label: string | null
  ring?: LatLng[]
  path?: LatLng[]
  point?: LatLng
}

/** A measurement of one kind on one property. The unit of storage and of truth. */
export interface Measurement {
  id: string
  user_id: string
  property_id: string
  kind: MeasurementKind
  unit: MeasurementUnit
  /** The number, in `unit`. Always >= 0. */
  value: number
  shapes: MeasurementShape[]
  source: MeasurementSource
  confidence: Confidence
  confidence_reason: string
  needs_review: boolean
  notes: string | null
  measured_at: string
  created_at: string
  updated_at: string
}

// ── Computing a value from shapes ────────────────────────────────────────────

/**
 * The number a set of shapes is worth, in the kind's own unit.
 *
 * This is the ONLY place shapes become a value. `measureShapes('fencing', …)`
 * returns linear feet; `measureShapes('trees', …)` returns a count. The old
 * engine had exactly one answer shape — square feet — for every question.
 */
export function measureShapes(kind: MeasurementKind, shapes: MeasurementShape[]): number {
  const d = kindDef(kind)
  switch (d.capture) {
    case 'area':
      return ringsAreaSqFt(shapes.map(s => s.ring ?? []).filter(isTraceableRing))
    case 'line':
      return shapes
        .map(s => s.path ?? [])
        .filter(isTraceablePath)
        .reduce((sum, p) => sum + pathLengthFt(p), 0)
    case 'point':
      // A count is of PLACED pins, not of shape objects — an empty shape would
      // otherwise silently count as a tree.
      return shapes.filter(s => !!s.point).length
  }
}

/** Shapes that actually carry geometry — the rest are drawing leftovers. */
export function usableShapes(kind: MeasurementKind, shapes: MeasurementShape[]): MeasurementShape[] {
  const d = kindDef(kind)
  return shapes.filter(s => {
    if (d.capture === 'area') return isTraceableRing(s.ring)
    if (d.capture === 'line') return isTraceablePath(s.path)
    return !!s.point
  })
}

/** Somewhere sensible to anchor a label for a shape. Never used to measure. */
export function shapeAnchor(shape: MeasurementShape): LatLng | null {
  if (shape.point) return shape.point
  if (shape.ring?.length) return ringCentroid(shape.ring)
  if (shape.path?.length) return shape.path[Math.floor(shape.path.length / 2)]
  return null
}

// ── The consumer-facing read API ─────────────────────────────────────────────

export interface PropertyMeasurements {
  all: Measurement[]
  /** The measurement for a kind, or null if this property has none. */
  get(kind: MeasurementKind): Measurement | null
  /** How much. null (never 0) when unmeasured — 0 would be a claim. */
  value(kind: MeasurementKind): number | null
  /** Of what. Always known, even when the value isn't. */
  unit(kind: MeasurementKind): MeasurementUnit
  /** How much to trust it. null when unmeasured. */
  confidence(kind: MeasurementKind): Confidence | null
  /** "1,240 sq ft" — the display string, so no caller re-formats. */
  format(kind: MeasurementKind): string | null
  /** The kinds this property actually has. */
  kinds: MeasurementKind[]
  /** WEAKEST confidence across everything measured — see ./confidence. */
  overall: Confidence | null
  /** Anything an owner should look at before quoting off it. */
  needingReview: Measurement[]
}

/**
 * Wrap rows into the read API.
 *
 * One row per (property, kind) is the invariant the DB enforces; if duplicates
 * ever arrive, the NEWEST wins rather than the first — a stale row silently
 * beating a fresh one is the kind of bug that only shows up in a customer's quote.
 */
export function readMeasurements(rows: Measurement[]): PropertyMeasurements {
  const byKind = new Map<MeasurementKind, Measurement>()
  for (const r of rows) {
    if (!isMeasurementKind(r.kind)) continue
    const seen = byKind.get(r.kind)
    if (!seen || r.measured_at > seen.measured_at) byKind.set(r.kind, r)
  }
  const all = Array.from(byKind.values())
  return {
    all,
    get: k => byKind.get(k) ?? null,
    value: k => byKind.get(k)?.value ?? null,
    unit: k => kindDef(k).unit,
    confidence: k => byKind.get(k)?.confidence ?? null,
    format: k => {
      const m = byKind.get(k)
      return m ? formatMeasurement(m.value, k) : null
    },
    kinds: all.map(m => m.kind),
    overall: weakestConfidence(all.map(m => m.confidence)),
    needingReview: all.filter(m => m.needs_review),
  }
}

/** Empty set — so a caller with no measurements uses the same shape, not null. */
export function noMeasurements(): PropertyMeasurements {
  return readMeasurements([])
}
