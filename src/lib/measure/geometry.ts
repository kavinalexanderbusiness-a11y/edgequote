// ── Measurement geometry ─────────────────────────────────────────────────────
// THE one place a shape on a map becomes a number. Pure functions: no React, no
// Google Maps SDK, no network. That is the point.
//
// WHY PURE, WHEN GOOGLE ALREADY HAS computeArea()
// Before this file, area was computed FOUR times — BookingClient, MeasureTool,
// QuoteMeasure and autoMeasure each carried their own `M2_TO_SQFT = 10.7639` and
// each called `google.maps.geometry.spherical.computeArea`. That meant:
//   * the number could only be produced inside a browser with the Maps SDK loaded,
//     so no test and no server could ever check it;
//   * four constants could drift apart, silently, and nothing would catch it;
//   * a measurement could not be re-derived from stored geometry after the fact.
// Here it is computed once, in code that runs anywhere and is verified by
// execution against Google's own output (see the harness).
//
// THE ALGORITHM matches google.maps.geometry.spherical exactly — same spherical
// excess formula, same default radius (6378137 m, WGS84 equatorial) — so swapping
// the SDK call for this one cannot move a single existing number. That was a hard
// requirement: this engine is landing under a live quoting flow it must not
// disturb.

/** A point on the map. Matches the existing `Coord` shape in lib/geo. */
export interface LatLng { lat: number; lng: number }

/** WGS84 equatorial radius, in metres — Google Maps' default sphere. */
export const EARTH_RADIUS_M = 6378137

/** THE conversion. Previously spelled out in four files; now spelled once. */
export const M2_TO_SQFT = 10.7639104167097
/** Metres → feet, for linear measurements (fences, hedges). */
export const M_TO_FT = 3.280839895013123

const toRad = (deg: number) => (deg * Math.PI) / 180

/**
 * Area of the polar triangle between two consecutive vertices — Google's
 * `polarTriangleArea`, using tan of the half-colatitude.
 *
 * Verified by execution, and the verification mattered: the first cut of this
 * file used the textbook trapezoid formula `Σ Δλ·(2 + sinφ₁ + sinφ₂)·R²/2`,
 * which agrees with this to ~1e-10 on a suburban lot but returns exactly HALF
 * the right answer for a polygon touching a pole — the trapezoid integrates
 * along meridians and the pole is a singularity of that parameterisation. The
 * octant test (a triangle to the North Pole, whose area is exactly πR²/2) caught
 * it. Nobody traces a lawn at the pole, so it would have shipped; but the claim
 * "matches Google exactly" would have been false, and this file's whole reason to
 * exist is replacing four SDK callers without moving a number.
 */
function polarTriangleArea(tan1: number, lng1: number, tan2: number, lng2: number): number {
  const deltaLng = lng1 - lng2
  const t = tan1 * tan2
  return 2 * Math.atan2(t * Math.sin(deltaLng), 1 + t * Math.cos(deltaLng))
}

/**
 * Signed spherical area of a closed ring, in square metres.
 *
 * Byte-for-byte the algorithm behind `google.maps.geometry.spherical.computeArea`
 * — same polar-triangle decomposition, same default radius — so swapping the SDK
 * call for this one cannot move an existing measurement. The ring is treated as
 * closed (last point joins the first); callers do not repeat the first point.
 *
 * Sign encodes winding order, so a caller could detect holes; every public
 * function here returns the absolute value, because a negative area is not a
 * measurement.
 */
function signedAreaM2(ring: LatLng[]): number {
  const n = ring.length
  if (n < 3) return 0
  let total = 0
  let prev = ring[n - 1]
  let prevTanLat = Math.tan((Math.PI / 2 - toRad(prev.lat)) / 2)
  let prevLng = toRad(prev.lng)
  for (const point of ring) {
    const tanLat = Math.tan((Math.PI / 2 - toRad(point.lat)) / 2)
    const lng = toRad(point.lng)
    total += polarTriangleArea(tanLat, lng, prevTanLat, prevLng)
    prevTanLat = tanLat
    prevLng = lng
  }
  return total * EARTH_RADIUS_M * EARTH_RADIUS_M
}

/** Area of a closed ring in square metres. Fewer than 3 points is not an area. */
export function ringAreaM2(ring: LatLng[]): number {
  return Math.abs(signedAreaM2(ring))
}

/** Area of a closed ring in square feet — the unit the product speaks. */
export function ringAreaSqFt(ring: LatLng[]): number {
  return ringAreaM2(ring) * M2_TO_SQFT
}

/** Total area of several rings (e.g. front + back lawn), in square feet. */
export function ringsAreaSqFt(rings: LatLng[][]): number {
  return rings.reduce((sum, r) => sum + ringAreaSqFt(r), 0)
}

/**
 * Great-circle distance between two points, in metres.
 *
 * Haversine. lib/geo.haversineKm exists and is used for ROUTING (kilometres
 * between jobs); this returns metres for measurement and keeps the two unit
 * vocabularies from leaking into each other. Same maths, different question.
 */
export function distanceM(a: LatLng, b: LatLng): number {
  const dLat = toRad(b.lat - a.lat)
  const dLng = toRad(b.lng - a.lng)
  const s =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLng / 2) ** 2
  return 2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(s)))
}

/**
 * Length of an OPEN path in feet — a fence line, a hedge run.
 *
 * Open, not closed: a fence along three sides of a yard is three segments, not
 * four. Closing it would silently bill the customer for a side that isn't there.
 * Use ringPerimeterFt when the shape genuinely closes.
 */
export function pathLengthFt(path: LatLng[]): number {
  if (path.length < 2) return 0
  let m = 0
  for (let i = 0; i < path.length - 1; i++) m += distanceM(path[i], path[i + 1])
  return m * M_TO_FT
}

/** Perimeter of a CLOSED ring in feet (the path, plus the closing segment). */
export function ringPerimeterFt(ring: LatLng[]): number {
  if (ring.length < 3) return 0
  return pathLengthFt([...ring, ring[0]])
}

/**
 * Centroid of a ring — used to anchor a label or a map pin, never to measure.
 * Planar average: adequate at property scale (metres), and the caller only wants
 * somewhere sensible to put a marker.
 */
export function ringCentroid(ring: LatLng[]): LatLng | null {
  if (!ring.length) return null
  const lat = ring.reduce((s, p) => s + p.lat, 0) / ring.length
  const lng = ring.reduce((s, p) => s + p.lng, 0) / ring.length
  return { lat, lng }
}

/** A ring needs 3 distinct points to enclose anything. */
export function isTraceableRing(ring: LatLng[] | null | undefined): boolean {
  return !!ring && ring.length >= 3
}
/** A path needs 2 points to have a length. */
export function isTraceablePath(path: LatLng[] | null | undefined): boolean {
  return !!path && path.length >= 2
}
