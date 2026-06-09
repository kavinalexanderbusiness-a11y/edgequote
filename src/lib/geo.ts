import { parseISO, addDays, format } from 'date-fns'

// ── Single source of truth for geo math shared by the Route Planner and the
// Best-Day Suggester. Keep all distance/geocode logic here so route ordering
// and scheduling recommendations never drift apart.

export interface Coord { lat: number; lng: number }

// Straight-line (Haversine) distance in km.
export function haversineKm(a: Coord, b: Coord): number {
  const R = 6371
  const dLat = (b.lat - a.lat) * Math.PI / 180
  const dLng = (b.lng - a.lng) * Math.PI / 180
  const lat1 = a.lat * Math.PI / 180
  const lat2 = b.lat * Math.PI / 180
  const h = Math.sin(dLat / 2) ** 2 + Math.sin(dLng / 2) ** 2 * Math.cos(lat1) * Math.cos(lat2)
  return R * 2 * Math.atan2(Math.sqrt(h), Math.sqrt(1 - h))
}

// Geocode an address via the shared /api/geocode route.
export async function geocodeAddress(address: string): Promise<Coord | null> {
  const res = await fetch('/api/geocode', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ address }),
  })
  const data = await res.json()
  if (res.ok && typeof data.lat === 'number' && typeof data.lng === 'number') {
    return { lat: data.lat, lng: data.lng }
  }
  return null
}

// A job within driving range counts toward a day's "density" for that area.
export const NEARBY_RADIUS_KM = 5
// Rough urban driving speed used to translate detour distance into minutes.
const AVG_SPEED_KM_PER_MIN = 0.5

export interface DaySuggestion {
  date: string        // yyyy-MM-dd
  weekday: string     // e.g. "Tuesday"
  nearbyCount: number
  avgKm: number       // mean distance from the target to the nearby stops
  nearestKm: number   // closest existing stop that day
  addedDriveMin: number // estimated extra driving to slot this stop in
}

interface DatedPoint { scheduled_date: string; lat: number | null; lng: number | null }

/**
 * Recommend the days that already have jobs clustered near `target`, so a new
 * job can be packed into an existing run instead of opening a new trip.
 * Ranked by how many nearby jobs a day has, then by least added driving.
 */
export function suggestBestDays(
  target: Coord,
  jobs: DatedPoint[],
  opts: { fromISO: string; days?: number; radiusKm?: number; max?: number; excludeDate?: string },
): DaySuggestion[] {
  const days = opts.days ?? 21
  const radius = opts.radiusKm ?? NEARBY_RADIUS_KM
  const max = opts.max ?? 4
  const located = jobs.filter(j => j.lat != null && j.lng != null)
  const from = parseISO(opts.fromISO)

  const out: DaySuggestion[] = []
  for (let i = 0; i < days; i++) {
    const d = addDays(from, i)
    const iso = format(d, 'yyyy-MM-dd')
    if (iso === opts.excludeDate) continue
    const dayJobs = located.filter(j => j.scheduled_date === iso)
    if (dayJobs.length === 0) continue

    const nearby = dayJobs
      .map(j => haversineKm(target, { lat: j.lat as number, lng: j.lng as number }))
      .filter(km => km <= radius)
    if (nearby.length === 0) continue

    const nearestKm = Math.min(...nearby)
    const avgKm = nearby.reduce((s, k) => s + k, 0) / nearby.length
    out.push({
      date: iso,
      weekday: format(d, 'EEEE'),
      nearbyCount: nearby.length,
      avgKm: Math.round(avgKm * 10) / 10,
      nearestKm: Math.round(nearestKm * 10) / 10,
      addedDriveMin: Math.round((nearestKm * 2) / AVG_SPEED_KM_PER_MIN),
    })
  }

  out.sort((a, b) => b.nearbyCount - a.nearbyCount || a.addedDriveMin - b.addedDriveMin)
  return out.slice(0, max)
}
