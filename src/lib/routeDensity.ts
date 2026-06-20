import { Coord, haversineKm } from '@/lib/geo'

// ── Route Density Score — THE single "how on-route is this stop" engine ─────────
// One place answers "is this property dense or isolated?" so quotes, the customer
// page, the Suggestions Center and value-based pricing all agree. Pure geometry
// over the located customer stops — reuses haversineKm, no new distance math.
//
// Dense stops are nearly pure profit (the truck is already in the area); isolated
// stops carry a full detour. This score feeds pricing aggressiveness, the
// reprice/density/review guardrail, route-gap filling and neighbourhood domination.

export type DensityTier = 'dense' | 'moderate' | 'isolated'

export interface DensityScore {
  score: number            // 0..100 — higher = more on-route
  tier: DensityTier
  within1km: number        // other stops within 1 km
  within2km: number
  within5km: number
  nearestKm: number | null // distance to the closest other stop
}

// Distances that define "on the same street" / "same neighbourhood" / "same side
// of town" for an urban lawn route.
const NEAR_KM = 1
const MID_KM = 2
const FAR_KM = 5

// Score one target against the located stops (excluding the target's own point).
// `stops` is every OTHER customer property with coordinates.
export function densityFor(target: Coord, stops: Coord[]): DensityScore {
  let within1 = 0, within2 = 0, within5 = 0
  let nearest = Infinity
  for (const s of stops) {
    if (s.lat === target.lat && s.lng === target.lng) continue // same point = the target itself
    const d = haversineKm(target, s)
    if (d < nearest) nearest = d
    if (d <= NEAR_KM) within1++
    if (d <= MID_KM) within2++
    if (d <= FAR_KM) within5++
  }
  // Weighted by proximity: a neighbour on the same block is worth far more to the
  // route than one 5 km away. Saturates at 100.
  const raw = within1 * 30 + (within2 - within1) * 14 + (within5 - within2) * 4
  const score = Math.max(0, Math.min(100, raw))
  const tier: DensityTier =
    within2 >= 3 || score >= 60 ? 'dense'
    : within2 >= 1 || within5 >= 3 ? 'moderate'
    : 'isolated'
  return { score, tier, within1km: within1, within2km: within2, within5km: within5, nearestKm: isFinite(nearest) ? Math.round(nearest * 10) / 10 : null }
}

export const DENSITY_TIER_LABEL: Record<DensityTier, string> = {
  dense: 'Dense route',
  moderate: 'Moderate',
  isolated: 'Isolated',
}
export const DENSITY_TIER_TONE: Record<DensityTier, string> = {
  dense: 'text-emerald-400 border-emerald-500/30 bg-emerald-500/10',
  moderate: 'text-amber-400 border-amber-500/30 bg-amber-500/10',
  isolated: 'text-red-400 border-red-500/30 bg-red-500/10',
}

// Convenience: pull the located coordinates out of a list of properties/jobs that
// expose lat/lng — the input to densityFor. Deduped by rounded point so the same
// property visited many times counts once.
export function locatedStops(items: { lat: number | null; lng: number | null }[]): Coord[] {
  const seen = new Set<string>()
  const out: Coord[] = []
  for (const i of items) {
    if (i.lat == null || i.lng == null) continue
    const key = `${i.lat.toFixed(5)},${i.lng.toFixed(5)}`
    if (seen.has(key)) continue
    seen.add(key)
    out.push({ lat: i.lat, lng: i.lng })
  }
  return out
}
