import type { SupabaseClient } from '@supabase/supabase-js'
import { neighborhoodKey } from '@/lib/profitability'

// ── Automatic lawn measurement (provider-swappable) ──────────────────────────
// Default workflow: estimate the lawn from a free data source the moment we have
// an address, let the owner Accept / Adjust / Redraw, and RECORD the auto vs the
// final accepted area so the estimate self-calibrates per neighborhood. The
// provider is abstracted so a paid AI provider (SatQuote/DeepLawn/…) can be
// dropped in later WITHOUT touching the UI, storage, learning, or analytics —
// a precise provider simply returns `lawnSqft` directly (confidence 'high').

export type MeasureConfidence = 'high' | 'medium' | 'low'
// THE conversion now lives in lib/measure (one definition, verified by execution).
import { M2_TO_SQFT } from '@/lib/measure'
const SQFT_TO_M2 = 1 / M2_TO_SQFT
const EARTH_R = 6378137 // metres

// Free estimate: lawn ≈ building footprint × ratio. Calibrates per neighborhood
// from the owner's accept/adjust history; this is just the cold-start value.
export const DEFAULT_LAWN_RATIO = 2.3
const CALIBRATION_MIN_SAMPLES = 5

export interface AutoMeasureResult {
  sqft: number
  confidence: MeasureConfidence
  source: string            // provider name — stored so providers can be swapped
  buildingSqft: number | null
  lat: number
  lng: number
}

// A provider returns EITHER a precise lawn area (paid AI) OR a building footprint
// (the free building-anchored method); null when no data for this point.
export interface ProviderResult { lawnSqft?: number; buildingSqft?: number; hitOnPoint?: boolean }
export interface MeasureProvider { name: string; measure(lat: number, lng: number): Promise<ProviderResult | null> }

// ── Geodesic polygon area (no Google dependency) ──
function ringAreaM2(ring: number[][]): number {
  if (ring.length < 3) return 0
  const rad = (d: number) => (d * Math.PI) / 180
  let total = 0
  for (let i = 0; i < ring.length; i++) {
    const [lng1, lat1] = ring[i]
    const [lng2, lat2] = ring[(i + 1) % ring.length]
    total += (rad(lng2) - rad(lng1)) * (2 + Math.sin(rad(lat1)) + Math.sin(rad(lat2)))
  }
  return Math.abs((total * EARTH_R * EARTH_R) / 2)
}
// MultiPolygon/Polygon footprint area (outer ring of each polygon, minus holes).
function geometryAreaM2(geom: { type: string; coordinates: unknown }): number {
  const polys = geom.type === 'MultiPolygon' ? (geom.coordinates as number[][][][]) : [geom.coordinates as number[][][]]
  let area = 0
  for (const poly of polys) {
    if (!poly?.length) continue
    area += ringAreaM2(poly[0])
    for (let h = 1; h < poly.length; h++) area -= ringAreaM2(poly[h]) // holes
  }
  return area
}

// ── Free provider: City of Calgary open building footprints ──
// Dataset uc4c-6kbd "Buildings" — 511,586 rows of roof outlines and garages.
//
// THIS PROVIDER HAD NEVER RETURNED A SINGLE RESULT. Three separate faults, each
// hidden by the next, and all of them silent (see the audit, 2026-07-16):
//
//   1. The SoQL column is `multipolygon`. We asked for `geometry`, which does not
//      exist on this dataset → HTTP 400 on EVERY call since the file was written.
//   2. The `.geojson` endpoint answers 200 with an EMPTY BODY for this dataset, so
//      even the corrected column returns nothing through it. `.json` is the one
//      that works — it embeds the geometry in the row as `multipolygon`.
//   3. Both failures were swallowed (`if (!res.ok) return []`, then `catch { return
//      null }`), so the caller could not tell "no building here" from "we have been
//      broken for our entire existence". 31 of 31 measurements were manual.
//
// Verified live before this change (real customer property, 50.9382678/-114.0897189):
//   .json    + within_circle(multipolygon,…)  → 200, 4 roof outlines   ✅
//   .geojson + within_circle(multipolygon,…)  → 200, empty body
//   either   + within_circle(geometry,…)      → 400 no-such-column
//
// Verified live AFTER, against three real customer properties — the provider returns
// a footprint for all three, and `intersects` hits the roof on two of them:
//   12804 Canso Cres SW  → 3,737 ft²  hitOnPoint=false (fell back to within_circle)
//   121 Riverside Bay SE → 1,779 ft²  hitOnPoint=true
//   303 Hawthorn Dr NW   → 1,194 ft²  hitOnPoint=true
// So both paths earn their place: a false `hitOnPoint` means the geocode landed off
// the roof, NOT that the provider failed.
export const calgaryBuildingsProvider: MeasureProvider = {
  name: 'calgary-buildings',
  async measure(lat, lng) {
    const base = 'https://data.calgary.ca/resource/uc4c-6kbd.json'
    try {
      // 1) the building footprint the point falls inside (the home).
      let rows = await fetchBuildings(`${base}?$where=intersects(multipolygon,'POINT(${lng} ${lat})')&$limit=5`)
      const hitOnPoint = rows.length > 0
      // 2) fallback: nearest footprints within ~45 m (geocode landed off the roof).
      if (!rows.length) rows = await fetchBuildings(`${base}?$where=within_circle(multipolygon,${lat},${lng},45)&$limit=12`)
      if (!rows.length) return null
      const areas = rows.map(r => geometryAreaM2(r.multipolygon)).filter(a => a > 10)
      if (!areas.length) return null
      // Containing → sum them (a home can be multipolygon); nearby → take largest.
      // Largest matters here: a 45 m circle also catches the garage (bldg_code_desc
      // 'Residential Garage') and a neighbour's roof.
      const buildingM2 = hitOnPoint ? areas.reduce((s, a) => s + a, 0) : Math.max(...areas)
      return { buildingSqft: Math.round(buildingM2 * M2_TO_SQFT), hitOnPoint }
    } catch (e) {
      reportProviderFailure('calgary-buildings threw', e)
      return null
    }
  },
}

/** Rows carry the geometry inline as `multipolygon` — this is the `.json` shape, NOT
 *  GeoJSON's `feature.geometry`. Using the wrong one is fault #2 above. */
async function fetchBuildings(url: string): Promise<{ multipolygon: { type: string; coordinates: unknown } }[]> {
  const res = await fetch(url)
  if (!res.ok) {
    // A provider that has been down since birth must SAY so once. This is the line
    // whose absence cost the product its entire measurement-calibration story.
    reportProviderFailure(`calgary-buildings HTTP ${res.status}`, await res.text().catch(() => ''))
    return []
  }
  const rows = await res.json()
  return (Array.isArray(rows) ? rows : []) as { multipolygon: { type: string; coordinates: unknown } }[]
}

// Once per session, not per call: a broken provider is hit on every measurement and
// a per-call log would bury the console it is trying to warn.
let providerFailureReported = false
function reportProviderFailure(what: string, detail: unknown) {
  if (providerFailureReported) return
  providerFailureReported = true
  console.error(`[autoMeasure] building-footprint provider is failing — auto-measure is OFF and every measurement will fall back to manual. ${what}:`, detail)
}

// The active provider — swap this (or branch on config) to use a paid provider.
const ACTIVE_PROVIDER: MeasureProvider = calgaryBuildingsProvider

// Estimate the lawn for a point. `ratio`/`calibrated` come from neighborhood
// learning (getNeighborhoodRatio). Returns null → caller falls back to manual.
export async function autoMeasureLawn(
  lat: number, lng: number, opts?: { ratio?: number; calibrated?: boolean },
): Promise<AutoMeasureResult | null> {
  const r = await ACTIVE_PROVIDER.measure(lat, lng)
  if (!r) return null
  // Precise provider (paid) → use its lawn area directly, high confidence.
  if (typeof r.lawnSqft === 'number' && r.lawnSqft > 0) {
    return { sqft: Math.round(r.lawnSqft), confidence: 'high', source: ACTIVE_PROVIDER.name, buildingSqft: r.buildingSqft ?? null, lat, lng }
  }
  if (typeof r.buildingSqft === 'number' && r.buildingSqft > 0) {
    const ratio = opts?.ratio && opts.ratio > 0 ? opts.ratio : DEFAULT_LAWN_RATIO
    const sqft = Math.round(r.buildingSqft * ratio)
    // Building method never exceeds 'medium'; 'high' is reserved for a precise provider.
    const confidence: MeasureConfidence = opts?.calibrated && r.hitOnPoint ? 'medium' : 'low'
    return { sqft, confidence, source: ACTIVE_PROVIDER.name, buildingSqft: r.buildingSqft, lat, lng }
  }
  return null
}

export function neighborhoodOf(postal?: string | null, city?: string | null, hood?: string | null): string {
  return neighborhoodKey(postal ?? null, city ?? null, hood ?? null)
}

// ── Learning: the calibrated lawn:footprint ratio for a neighborhood ──
export async function getNeighborhoodRatio(
  supabase: SupabaseClient, userId: string, neighborhood: string,
): Promise<{ ratio: number; calibrated: boolean }> {
  const { data } = await supabase.from('measurements')
    .select('building_sqft, accepted_sqft')
    .eq('user_id', userId).eq('neighborhood', neighborhood)
    .not('building_sqft', 'is', null).not('accepted_sqft', 'is', null)
    .limit(200)
  const rows = (data as { building_sqft: number | null; accepted_sqft: number | null }[] | null) || []
  const ratios = rows
    .filter(r => Number(r.building_sqft) > 0 && Number(r.accepted_sqft) > 0)
    .map(r => Number(r.accepted_sqft) / Number(r.building_sqft))
  if (ratios.length < CALIBRATION_MIN_SAMPLES) return { ratio: DEFAULT_LAWN_RATIO, calibrated: false }
  return { ratio: ratios.reduce((s, x) => s + x, 0) / ratios.length, calibrated: true }
}

// ── Record one measurement (owner-authenticated surfaces) ──
export async function recordMeasurement(
  supabase: SupabaseClient,
  m: {
    userId: string; context: 'quote' | 'property' | 'booking' | 'snow'
    lat?: number | null; lng?: number | null; neighborhood?: string | null
    propertyId?: string | null; quoteId?: string | null; customerId?: string | null
    auto: AutoMeasureResult | null; acceptedSqft: number
  },
): Promise<void> {
  const auto = m.auto?.sqft ?? null
  const adjusted = auto != null && auto > 0 && Math.abs(m.acceptedSqft - auto) > Math.max(1, auto * 0.02)
  const diffPct = auto && auto > 0 ? Math.round(((m.acceptedSqft - auto) / auto) * 1000) / 10 : null
  await supabase.from('measurements').insert({
    user_id: m.userId, context: m.context, property_id: m.propertyId ?? null, quote_id: m.quoteId ?? null,
    customer_id: m.customerId ?? null, lat: m.lat ?? null, lng: m.lng ?? null, neighborhood: m.neighborhood ?? null,
    source: m.auto?.source ?? 'manual', confidence: m.auto?.confidence ?? null,
    building_sqft: m.auto?.buildingSqft ?? null, auto_sqft: auto, accepted_sqft: m.acceptedSqft,
    adjusted, diff_pct: diffPct,
  })
}

// ── Analytics: acceptance rate, avg adjustment, by neighborhood & confidence ──
export interface MeasureStats {
  total: number; autoTotal: number
  acceptedAsIs: number; acceptanceRate: number   // % of auto estimates kept unchanged
  avgAdjustmentPct: number                        // mean |diff%| over adjusted
  byNeighborhood: { neighborhood: string; n: number; avgAbsDiffPct: number }[]
  byConfidence: { confidence: string; n: number; acceptanceRate: number; avgAbsDiffPct: number }[]
}
export async function measurementStats(supabase: SupabaseClient, userId: string): Promise<MeasureStats> {
  const { data } = await supabase.from('measurements')
    .select('neighborhood, confidence, auto_sqft, adjusted, diff_pct')
    .eq('user_id', userId).not('auto_sqft', 'is', null).limit(2000)
  const rows = (data as { neighborhood: string | null; confidence: string | null; auto_sqft: number | null; adjusted: boolean | null; diff_pct: number | null }[] | null) || []
  const autoTotal = rows.length
  const acceptedAsIs = rows.filter(r => !r.adjusted).length
  const adj = rows.filter(r => r.adjusted && r.diff_pct != null)
  const avgAdjustmentPct = adj.length ? Math.round((adj.reduce((s, r) => s + Math.abs(Number(r.diff_pct)), 0) / adj.length) * 10) / 10 : 0

  const hoodMap: Record<string, number[]> = {}
  for (const r of rows) { const k = r.neighborhood || 'Unknown'; (hoodMap[k] ||= []).push(Math.abs(Number(r.diff_pct) || 0)) }
  const byNeighborhood = Object.entries(hoodMap).map(([neighborhood, ds]) => ({
    neighborhood, n: ds.length, avgAbsDiffPct: Math.round((ds.reduce((s, x) => s + x, 0) / ds.length) * 10) / 10,
  })).sort((a, b) => a.avgAbsDiffPct - b.avgAbsDiffPct)

  const confMap: Record<string, { n: number; asIs: number; ds: number[] }> = {}
  for (const r of rows) { const k = r.confidence || 'low'; const e = (confMap[k] ||= { n: 0, asIs: 0, ds: [] }); e.n++; if (!r.adjusted) e.asIs++; if (r.diff_pct != null) e.ds.push(Math.abs(Number(r.diff_pct))) }
  const byConfidence = Object.entries(confMap).map(([confidence, e]) => ({
    confidence, n: e.n, acceptanceRate: e.n ? Math.round((e.asIs / e.n) * 100) : 0,
    avgAbsDiffPct: e.ds.length ? Math.round((e.ds.reduce((s, x) => s + x, 0) / e.ds.length) * 10) / 10 : 0,
  }))

  return {
    total: rows.length, autoTotal, acceptedAsIs,
    acceptanceRate: autoTotal ? Math.round((acceptedAsIs / autoTotal) * 100) : 0,
    avgAdjustmentPct, byNeighborhood, byConfidence,
  }
}
