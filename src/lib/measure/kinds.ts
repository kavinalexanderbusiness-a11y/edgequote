// ── What can be measured ─────────────────────────────────────────────────────
// THE catalogue of measurement kinds, and the one thing the old tools could never
// express: a measurement's UNIT.
//
// THE BUG THIS FIXES
// Both old tools were polygon-area-only and every number they produced was square
// feet — the column is literally named `measured_sqft`. So a fence could not be
// measured (it's a line, not an area), a tree could not be counted, and tracing
// the same polygon for "Lawn Mowing" and "Fence Installation" returned
// byte-identical output. Meanwhile `fence_length`, `mulch_area` and `rock_area`
// were declared, rendered to CUSTOMERS ("12 ft fence" in the portal) — and written
// by nothing in the codebase. The product showed measurements no code could
// produce.
//
// A measurement here therefore carries its own unit, and the unit follows from
// the kind. A fence is metres of line; a tree is a count; a lawn is an area.
// Nothing downstream has to guess.
//
// NOT A PRICING TABLE. There are no rates here and no money. This engine answers
// "how much of it is there", full stop. Pricing consumes these numbers through the
// public API in ./index and decides what they are worth — that separation is why
// this can ship without touching the pricing engine at all.

/** The nine things a trades business measures on a property. */
export type MeasurementKind =
  | 'lawn'
  | 'mulch'
  | 'gravel'
  | 'rock'
  | 'concrete'
  | 'fencing'
  | 'hedges'
  | 'trees'
  | 'snow'

/** What the number MEANS. The old engine could only ever say 'sqft'. */
export type MeasurementUnit = 'sqft' | 'linear_ft' | 'count'

/** How the shape is captured on the map — decides the drawing tool. */
export type CaptureMode = 'area' | 'line' | 'point'

/** Where the number came from. Drives confidence; see ./confidence. */
export type MeasurementSource = 'traced' | 'auto' | 'manual'

export interface MeasurementKindDef {
  key: MeasurementKind
  label: string
  /** Plain noun for a sentence: "1,200 sq ft of lawn". */
  noun: string
  unit: MeasurementUnit
  capture: CaptureMode
  /** Map/legend colour. A palette key would be nicer, but the Maps SDK wants hex. */
  color: string
  /**
   * The legacy `properties` column this kind mirrors into, or null.
   *
   * Only four exist, and they predate satellite measuring. They are kept in sync
   * by a DB trigger (see the migration) so the portal and the pricing engine keep
   * reading exactly what they read today, unchanged. New kinds have no column and
   * live only in property_measurements — the new source of truth.
   */
  legacyColumn: 'lawn_sqft' | 'fence_length' | 'mulch_area' | 'rock_area' | null
  /**
   * Whether auto-measure can estimate this kind from imagery. Only lawn can.
   * See ./confidence — for everything else we refuse rather than invent.
   */
  canAuto: boolean
  /** One line the UI shows so the owner knows what they're tracing. */
  hint: string
}

export const MEASUREMENT_KINDS: MeasurementKindDef[] = [
  { key: 'lawn', label: 'Lawn', noun: 'lawn', unit: 'sqft', capture: 'area', color: '#84cc16',
    legacyColumn: 'lawn_sqft', canAuto: true,
    hint: 'Trace the grass. Leave out beds, driveways and the house.' },
  { key: 'mulch', label: 'Mulch bed', noun: 'mulch bed', unit: 'sqft', capture: 'area', color: '#92400e',
    legacyColumn: 'mulch_area', canAuto: false,
    hint: 'Trace each bed. Depth is a material choice, not a measurement.' },
  { key: 'gravel', label: 'Gravel', noun: 'gravel', unit: 'sqft', capture: 'area', color: '#a8a29e',
    legacyColumn: null, canAuto: false,
    hint: 'Trace the gravel area — paths, parking pads, side yards.' },
  { key: 'rock', label: 'Rock', noun: 'rock', unit: 'sqft', capture: 'area', color: '#78716c',
    legacyColumn: 'rock_area', canAuto: false,
    hint: 'Decorative rock and river stone. Gravel is tracked separately.' },
  { key: 'concrete', label: 'Concrete', noun: 'concrete', unit: 'sqft', capture: 'area', color: '#94a3b8',
    // NOT mapped to driveway_area on purpose: concrete is not a synonym for
    // driveway (a patio and a walkway are concrete too). Mirroring it there would
    // be a quiet lie in a column the portal shows a customer.
    legacyColumn: null, canAuto: false,
    hint: 'Driveways, walkways, patios, pads.' },
  { key: 'fencing', label: 'Fencing', noun: 'fencing', unit: 'linear_ft', capture: 'line', color: '#f59e0b',
    legacyColumn: 'fence_length', canAuto: false,
    hint: 'Trace along the fence line — not around it. Each run is a line.' },
  { key: 'hedges', label: 'Hedges', noun: 'hedging', unit: 'linear_ft', capture: 'line', color: '#15803d',
    legacyColumn: null, canAuto: false,
    hint: 'Trace along the hedge run. Length, not area.' },
  { key: 'trees', label: 'Trees', noun: 'trees', unit: 'count', capture: 'point', color: '#166534',
    legacyColumn: null, canAuto: false,
    hint: 'Drop a pin on each tree.' },
  { key: 'snow', label: 'Snow clearing', noun: 'snow clearing', unit: 'sqft', capture: 'area', color: '#38bdf8',
    legacyColumn: null, canAuto: false,
    hint: 'Trace what gets cleared — driveway, walks, parking.' },
]

const BY_KEY = new Map(MEASUREMENT_KINDS.map(k => [k.key, k]))

export function kindDef(kind: MeasurementKind): MeasurementKindDef {
  const d = BY_KEY.get(kind)
  // Throwing beats a silent default: an unknown kind reaching here means a
  // migration or a cast went wrong, and inventing 'lawn' would hide it.
  if (!d) throw new Error(`Unknown measurement kind: ${kind}`)
  return d
}

export function isMeasurementKind(v: unknown): v is MeasurementKind {
  return typeof v === 'string' && BY_KEY.has(v as MeasurementKind)
}

export const UNIT_LABELS: Record<MeasurementUnit, string> = {
  sqft: 'sq ft',
  linear_ft: 'linear ft',
  count: '',
}

/** "1,240 sq ft" · "86 linear ft" · "3 trees" — one place, so nothing disagrees. */
export function formatMeasurement(value: number, kind: MeasurementKind): string {
  const d = kindDef(kind)
  const n = d.unit === 'count' ? Math.round(value) : Math.round(value)
  const num = n.toLocaleString('en-CA')
  if (d.unit === 'count') return `${num} ${n === 1 ? singularNoun(d) : d.noun}`
  return `${num} ${UNIT_LABELS[d.unit]}`
}

function singularNoun(d: MeasurementKindDef): string {
  return d.noun.endsWith('s') ? d.noun.slice(0, -1) : d.noun
}

/** Kinds whose capture mode matches — drives which drawing tool the UI offers. */
export function kindsByCapture(mode: CaptureMode): MeasurementKindDef[] {
  return MEASUREMENT_KINDS.filter(k => k.capture === mode)
}

/** The four legacy columns this engine keeps alive, for the migration's benefit. */
export const LEGACY_MIRRORED_KINDS = MEASUREMENT_KINDS.filter(k => k.legacyColumn !== null)
