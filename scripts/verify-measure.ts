// ── Verify: the measurement contract, so it stays coherent when it opens ─────
//   npm run verify:measure
//
// WHY THIS SCRIPT EXISTS
// Measurement Engine V2 (RUN-2026-07-16) is the typed sensor of record: a
// measurement carries a KIND, a UNIT, its own geometry, and where the number came
// from. The engine underneath is genuinely generic — `measureShapes` dispatches on
// CAPTURE MODE (area / line / point), never on a trade word — but the VOCABULARY
// is deliberately closed today, and it is closed in FOUR places that have to agree:
//
//   1. the `MeasurementKind` TS union            (src/lib/measure/kinds.ts)
//   2. the `MEASUREMENT_KINDS` data table         (same file)
//   3. `property_measurements_kind_known`         (the migration's CHECK)
//   4. `property_measurements_unit_matches_kind`  (the migration's CHECK)
//
// Nothing in the type system connects those. The 2026-08-10 Service Location
// audit recommended eventually replacing the closed enum with owner-owned rows —
// exactly as `service_units` already works for quote lines. THAT is what this
// guard is for: it pins the invariants that must survive the vocabulary opening,
// so the change is made deliberately and in all four places at once.
//
// THE TWO FAILURE SHAPES IT CATCHES
//   * A kind added to TS but not to the DB CHECK → every write of it is rejected
//     at runtime, in a code path with no test coverage.
//   * A kind added to the DB but not to TS → `readMeasurements` SKIPS the row
//     (index.ts: `if (!isMeasurementKind(r.kind)) continue`). Silent data loss:
//     the row exists, is billable, and is invisible to every reader.
// The second is worse and completely quiet, which is why parity is asserted in
// BOTH directions rather than "TS ⊆ DB".
//
// This is deliberately NOT a grep over the app. It executes the real engine
// functions and parses the real migration, because the contract lives in those
// two artefacts and nowhere else.
//
// Pricing is OUT OF SCOPE here — `serviceRecommendation` and `servicePricingKind`
// are pinned by verify-pricing.ts. This file must never grow a money assertion.

import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import {
  MEASUREMENT_KINDS, kindDef, isMeasurementKind, formatMeasurement,
  kindsByCapture, LEGACY_MIRRORED_KINDS, UNIT_LABELS,
  type MeasurementKind, type MeasurementUnit, type CaptureMode,
} from '../src/lib/measure/kinds'
import { measureShapes, usableShapes, readMeasurements, type Measurement, type MeasurementShape } from '../src/lib/measure'
import { ringsAreaSqFt, pathLengthFt, M2_TO_SQFT, M_TO_FT } from '../src/lib/measure/geometry'
import { canAutoMeasure } from '../src/lib/measure/confidence'

let failures = 0
const ok = (name: string) => console.log(`  ✓ ${name}`)
const fail = (name: string, detail: string) => { failures++; console.log(`  ✗ ${name}\n      ${detail}`) }
const check = (name: string, cond: boolean, detail = '') => (cond ? ok(name) : fail(name, detail))
const eq = (name: string, actual: unknown, expected: unknown) =>
  check(name, JSON.stringify(actual) === JSON.stringify(expected),
    `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`)
const sorted = (a: readonly string[]) => [...a].sort()

const ROOT = process.cwd()
const read = (p: string) => readFileSync(join(ROOT, p), 'utf8')

const MIGRATION = read('supabase/archive/run/RUN-2026-07-16-measurement-engine-v2.sql')
const LAWN_GUARD = read('supabase/archive/run/RUN-2026-07-17-meas1-lawn-sqft-guard.sql')

/** Every quoted token in a slice of SQL. */
const quoted = (s: string): string[] => (s.match(/'[^']*'/g) ?? []).map(t => t.slice(1, -1))

/**
 * The DECLARATION of a named constraint, not the prose about it.
 *
 * Anchored on the `constraint <name>` keyword: this migration's header explains
 * `property_measurements_unit_matches_kind` in a comment BEFORE declaring it, and
 * a bare indexOf on the name reads the comment — which is how the first cut of
 * this guard failed against a perfectly correct migration.
 */
function constraintBody(sql: string, name: string): string {
  const at = sql.indexOf(`constraint ${name}`)
  if (at < 0) return ''
  const open = sql.indexOf('(', at)
  if (open < 0) return ''
  // Walk to the matching close paren — these bodies nest.
  let depth = 0
  for (let i = open; i < sql.length; i++) {
    if (sql[i] === '(') depth++
    else if (sql[i] === ')') { depth--; if (depth === 0) return sql.slice(open + 1, i) }
  }
  return ''
}

/** Pull the quoted members of a `check (col in ('a','b',…))` constraint. */
const checkMembers = (sql: string, name: string): string[] => quoted(constraintBody(sql, name))

// ── 1. The kind vocabulary agrees, in BOTH directions ───────────────────────
console.log('\nKind vocabulary — TS union ⇄ database CHECK')

const tsKinds = MEASUREMENT_KINDS.map(k => k.key)
const dbKinds = checkMembers(MIGRATION, 'property_measurements_kind_known')

check('the migration declares a kind CHECK at all', dbKinds.length > 0,
  'property_measurements_kind_known not found — the parser or the migration moved')
eq('every TS kind is accepted by the database', sorted(tsKinds), sorted(dbKinds))
check('no TS kind is missing from the CHECK',
  tsKinds.every(k => dbKinds.includes(k)),
  `writes would be rejected at runtime for: ${tsKinds.filter(k => !dbKinds.includes(k)).join(', ')}`)
check('no database kind is missing from TS',
  dbKinds.every(k => (tsKinds as string[]).includes(k)),
  `readMeasurements would SILENTLY SKIP rows of kind: ${dbKinds.filter(k => !(tsKinds as string[]).includes(k)).join(', ')}`)
check('kind keys are unique', new Set(tsKinds).size === tsKinds.length)

const dbUnits = checkMembers(MIGRATION, 'property_measurements_unit_known')
const tsUnits = [...new Set(MEASUREMENT_KINDS.map(k => k.unit))]
check('every unit a TS kind declares is accepted by the database',
  tsUnits.every(u => dbUnits.includes(u)),
  `rejected units: ${tsUnits.filter(u => !dbUnits.includes(u)).join(', ')}`)
eq('the unit vocabulary is exactly the three the engine formats',
  sorted(dbUnits), sorted(Object.keys(UNIT_LABELS)))

const dbSources = checkMembers(MIGRATION, 'property_measurements_source_known')
eq('the source vocabulary is traced/auto/manual', sorted(dbSources), ['auto', 'manual', 'traced'])

// ── 2. Unit follows capture mode — the rule the whole engine rests on ───────
console.log('\nUnit follows capture mode')

const EXPECTED_UNIT: Record<CaptureMode, MeasurementUnit> = {
  area: 'sqft',
  line: 'linear_ft',
  point: 'count',
}
for (const d of MEASUREMENT_KINDS) {
  eq(`${d.key}: ${d.capture} → ${EXPECTED_UNIT[d.capture]}`, d.unit, EXPECTED_UNIT[d.capture])
}
check('every capture mode is exercised by at least one kind',
  (['area', 'line', 'point'] as CaptureMode[]).every(m => kindsByCapture(m).length > 0),
  'a capture mode with no kind means an untested branch in measureShapes')

// …and the same rule as the DB states it. `unit_matches_kind` is a disjunction of
// arms, each pairing a set of kinds with the one unit they may carry. Each arm
// must be EXACTLY the TS kinds whose capture mode implies that unit — so opening
// the vocabulary in TS without extending this CHECK fails here rather than in
// production, where it would surface as a rejected write on a live quote.
const unitArms = constraintBody(MIGRATION, 'property_measurements_unit_matches_kind').split(/\bor\b/)
check('the migration declares the unit-matches-kind rule', unitArms.length >= 3,
  'the constraint body did not parse into arms')
for (const [mode, unit] of Object.entries(EXPECTED_UNIT) as [CaptureMode, MeasurementUnit][]) {
  const arm = unitArms.find(a => a.includes(`unit = '${unit}'`))
  check(`the database states the ${unit} rule`, !!arm, `no arm binds unit = '${unit}'`)
  if (arm) {
    // Every quoted token in the arm except the unit itself is a kind.
    const inDb = sorted(quoted(arm).filter(t => t !== unit))
    eq(`…and it lists exactly the ${mode} kinds`, inDb, sorted(kindsByCapture(mode).map(k => k.key)))
  }
}

// ── 3. The geometry is generic — the MODE decides, not the trade word ───────
console.log('\nGeometry dispatches on capture mode, not on a trade name')

// A ~100m square near Calgary. Exact value doesn't matter; agreement does.
const SQUARE: MeasurementShape = {
  id: 's1', label: null,
  ring: [
    { lat: 51.0000, lng: -114.0000 },
    { lat: 51.0000, lng: -113.99857 },
    { lat: 51.00090, lng: -113.99857 },
    { lat: 51.00090, lng: -114.0000 },
  ],
}
const LINE: MeasurementShape = {
  id: 's2', label: null,
  path: [{ lat: 51.0, lng: -114.0 }, { lat: 51.0, lng: -113.99857 }],
}
const PIN = (id: string): MeasurementShape => ({ id, label: null, point: { lat: 51.0, lng: -114.0 } })

const areaKinds = kindsByCapture('area').map(k => k.key)
const lineKinds = kindsByCapture('line').map(k => k.key)
const pointKinds = kindsByCapture('point').map(k => k.key)

// THE assertion this whole section exists for: two DIFFERENT kinds sharing a
// capture mode must return the SAME number for the SAME geometry. If a trade word
// ever enters the maths, this is what breaks first.
const areaValues = areaKinds.map(k => measureShapes(k, [SQUARE]))
check('every AREA kind measures the same square identically',
  new Set(areaValues.map(v => v.toFixed(6))).size === 1,
  `landscaping name leaked into the maths: ${JSON.stringify(Object.fromEntries(areaKinds.map((k, i) => [k, areaValues[i]])))}`)
const lineValues = lineKinds.map(k => measureShapes(k, [LINE]))
check('every LINE kind measures the same path identically',
  new Set(lineValues.map(v => v.toFixed(6))).size === 1,
  `got ${JSON.stringify(Object.fromEntries(lineKinds.map((k, i) => [k, lineValues[i]])))}`)

eq('an area kind agrees with the shared ring engine',
  measureShapes(areaKinds[0], [SQUARE]), ringsAreaSqFt([SQUARE.ring!]))
eq('a line kind agrees with the shared path engine',
  measureShapes(lineKinds[0], [LINE]), pathLengthFt(LINE.path!))
eq('a point kind counts PLACED pins, not shape objects',
  measureShapes(pointKinds[0], [PIN('a'), PIN('b'), { id: 'c', label: null }]), 2)

check('an area measurement of a real square is a plausible area',
  measureShapes(areaKinds[0], [SQUARE]) > 5_000 && measureShapes(areaKinds[0], [SQUARE]) < 200_000,
  `got ${measureShapes(areaKinds[0], [SQUARE])} sq ft — the polar/trapezoid halving bug looks like this`)
check('the unit constants are the real conversions',
  Math.abs(M2_TO_SQFT - 10.7639104167097) < 1e-9 && Math.abs(M_TO_FT - 3.280839895013123) < 1e-9)

// A shape carrying the WRONG geometry for its mode is not usable — this is what
// stops a traced line being saved as an area of zero.
eq('a ring is not usable geometry for a line kind', usableShapes(lineKinds[0], [SQUARE]).length, 0)
eq('a path is not usable geometry for an area kind', usableShapes(areaKinds[0], [LINE]).length, 0)
eq('a pin is not usable geometry for an area kind', usableShapes(areaKinds[0], [PIN('a')]).length, 0)

// ── 4. An unknown kind cannot enter the system quietly ──────────────────────
console.log('\nUnknown kinds are refused, never guessed')

check('isMeasurementKind rejects an unknown string', !isMeasurementKind('roof'))
check('isMeasurementKind rejects a non-string', !isMeasurementKind(7) && !isMeasurementKind(null))
check('kindDef THROWS on an unknown kind rather than defaulting to lawn', (() => {
  try { kindDef('roof' as MeasurementKind); return false } catch { return true }
})(), 'a silent default would mirror a stranger’s number into properties.lawn_sqft')
check('measureShapes THROWS on an unknown kind', (() => {
  try { measureShapes('roof' as MeasurementKind, [SQUARE]); return false } catch { return true }
})(), 'the single writer derives unit + value through kindDef; it must not proceed')

// The forward-compatibility property that MUST hold when the vocabulary opens:
// a reader meeting a kind it does not know yet skips it and keeps going, rather
// than throwing and blanking the whole property.
{
  const row = (kind: string): Measurement => ({
    id: kind, user_id: 'u', property_id: 'p', kind: kind as MeasurementKind,
    unit: 'sqft', value: 100, shapes: [], source: 'manual',
    confidence: 'high', confidence_reason: 'typed', needs_review: false, notes: null,
    measured_at: '2026-08-10T00:00:00Z', created_at: '2026-08-10T00:00:00Z', updated_at: '2026-08-10T00:00:00Z',
  })
  const known = MEASUREMENT_KINDS[0].key
  const m = readMeasurements([row(known), row('roof')])
  eq('a reader keeps the kinds it knows', m.kinds, [known])
  eq('…and does not throw on one it does not', m.get('roof' as MeasurementKind), null)
  check('…and the known value survives alongside the unknown row', m.value(known) === 100,
    'an unknown row must never take the known ones down with it')
}

// ── 5. The legacy mirror contract ───────────────────────────────────────────
console.log('\nLegacy mirror — one writer, and the DB defends it')

// The TS registry claims four kinds mirror into a legacy column. The migration's
// mirror function is what actually does it; they must name the same pairs.
for (const d of LEGACY_MIRRORED_KINDS) {
  const pattern = new RegExp(`when '${d.key}'\\s*then update public\\.properties set ${d.legacyColumn}\\b`)
  check(`${d.key} mirrors to properties.${d.legacyColumn}`, pattern.test(MIGRATION),
    'the TS registry and the mirror trigger disagree about where this number lands')
}
check('exactly the mirrored kinds declare a legacy column',
  MEASUREMENT_KINDS.filter(k => k.legacyColumn !== null).length === LEGACY_MIRRORED_KINDS.length)
check('concrete is NOT mirrored into driveway_area',
  kindDef('concrete').legacyColumn === null,
  'a patio is not a driveway, and that column is shown to a customer')

// MEAS-1: property_measurements is the SOLE authority for lawn_sqft.
check('the lawn_sqft write guard exists', /create trigger properties_guard_lawn_sqft/.test(LAWN_GUARD))
check('…it fires BEFORE UPDATE OF lawn_sqft', /before update of lawn_sqft on public\.properties/.test(LAWN_GUARD))
check('…and it rejects a direct write that disagrees with the ledger',
  /raise exception 'lawn_sqft is derived from property_measurements/.test(LAWN_GUARD),
  'without this a legacy path silently REVERTS the number pricing reads')
check('…while an AGREEING write still passes (the mirror must not deadlock itself)',
  /is not distinct from v_lawn|new\.lawn_sqft is distinct from v_lawn/.test(LAWN_GUARD))
eq('lawn is the kind that owns lawn_sqft', kindDef('lawn').legacyColumn, 'lawn_sqft')

// ── 6. Auto-measure refuses what it cannot honestly estimate ────────────────
console.log('\nAuto-measure refuses rather than invents')

const autoKinds = MEASUREMENT_KINDS.filter(k => k.canAuto).map(k => k.key)
eq('exactly one kind may be auto-measured', autoKinds, ['lawn'])
for (const d of MEASUREMENT_KINDS.filter(k => !k.canAuto)) {
  check(`auto-measure refuses ${d.key}`, canAutoMeasure(d.key).ok === false,
    'the 2.3× building-footprint heuristic is a LAWN ratio; serving it as anything else invents a number')
}
check('auto-measure allows lawn', canAutoMeasure('lawn').ok === true)

// ── 7. Formatting states the unit, and a count is not an area ──────────────
console.log('\nFormatting')

eq('an area formats with its unit', formatMeasurement(1240, areaKinds[0]), '1,240 sq ft')
eq('a line formats in linear feet', formatMeasurement(86, lineKinds[0]), '86 linear ft')
eq('a count formats as a plural noun', formatMeasurement(3, pointKinds[0]), `3 ${kindDef(pointKinds[0]).noun}`)
check('a count of one is singular', !formatMeasurement(1, pointKinds[0]).endsWith('ss'))
eq('a count never renders a unit suffix', UNIT_LABELS.count, '')

console.log(failures === 0
  ? '\n✅ the measurement contract is coherent — TS, the database and the engine agree\n'
  : `\n❌ ${failures} check${failures === 1 ? '' : 's'} failed\n`)
process.exit(failures === 0 ? 0 : 1)
