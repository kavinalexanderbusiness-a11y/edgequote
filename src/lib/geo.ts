import { parseISO, addDays, format } from 'date-fns'
import type { SupabaseClient } from '@supabase/supabase-js'
import { jobVisitValue, effectiveFreq } from '@/lib/invoicing'

// ── Single source of truth for geo math shared by the Route Planner and the
// Best-Day Suggester. Keep all distance/geocode logic here so route ordering
// and scheduling recommendations never drift apart.

export interface Coord { lat: number; lng: number }

// Local (not UTC) yyyy-MM-dd — the one place this is defined so every
// "scheduled_date >= today" window stays in lock-step.
export function todayLocalISO(): string {
  const d = new Date()
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

export interface LocatedJob { id: string; scheduled_date: string; lat: number | null; lng: number | null }

// The shared definition of "an upcoming located job" used for BOTH route-density
// pricing and best-day suggestions, so the two features can never disagree on
// which jobs count.
export async function fetchLocatedUpcomingJobs(supabase: SupabaseClient, userId: string): Promise<LocatedJob[]> {
  const { data } = await supabase
    .from('jobs')
    .select('id, scheduled_date, properties(lat, lng)')
    .eq('user_id', userId)
    .gte('scheduled_date', todayLocalISO())
    .in('status', ['scheduled', 'in_progress'])
  return ((data as unknown as { id: string; scheduled_date: string; properties?: { lat: number | null; lng: number | null } | null }[]) || [])
    .map(r => ({ id: r.id, scheduled_date: r.scheduled_date, lat: r.properties?.lat ?? null, lng: r.properties?.lng ?? null }))
}

// A richer upcoming-job row for the weekly scheduler: location + hours + the
// per-visit revenue (via the ONE valuation engine), so density/balance/revenue
// modes all read from the same data without a separate engine.
export interface SchedJob {
  id: string
  scheduled_date: string
  lat: number | null
  lng: number | null
  durationMin: number
  value: number
}

const DEFAULT_VISIT_MIN = 45 // assumed on-site time when a job has no duration

export async function fetchUpcomingSchedulingJobs(supabase: SupabaseClient, userId: string): Promise<SchedJob[]> {
  const [jRes, qRes, rRes] = await Promise.all([
    supabase.from('jobs')
      .select('id, scheduled_date, status, duration_minutes, price, quote_id, recurrence_id, is_initial_visit, properties(lat, lng)')
      .eq('user_id', userId).gte('scheduled_date', todayLocalISO()).in('status', ['scheduled', 'in_progress']),
    supabase.from('quotes').select('id, total, initial_price, weekly_price, biweekly_price, monthly_price').eq('user_id', userId),
    supabase.from('job_recurrences').select('id, freq, interval_unit, interval_count').eq('user_id', userId),
  ])
  const quotesById: Record<string, Record<string, unknown>> = {}
  for (const q of (qRes.data as Record<string, unknown>[]) || []) quotesById[q.id as string] = q
  const recById: Record<string, { freq: string | null; interval_unit: string | null; interval_count: number | null }> = {}
  for (const r of (rRes.data as { id: string; freq: string | null; interval_unit: string | null; interval_count: number | null }[]) || []) recById[r.id] = r

  return ((jRes.data as unknown as Array<Record<string, unknown> & { properties?: { lat: number | null; lng: number | null } | null }>) || [])
    .map(j => {
      const quote = j.quote_id ? quotesById[j.quote_id as string] : null
      const rec = j.recurrence_id ? recById[j.recurrence_id as string] : null
      const freq = rec ? effectiveFreq(rec.freq, rec.interval_unit, rec.interval_count) : null
      return {
        id: j.id as string,
        scheduled_date: j.scheduled_date as string,
        lat: j.properties?.lat ?? null,
        lng: j.properties?.lng ?? null,
        durationMin: (j.duration_minutes as number) || DEFAULT_VISIT_MIN,
        value: Math.round(jobVisitValue(j.price as number | null, quote, freq, Boolean(j.is_initial_visit))),
      }
    })
}

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
  const full = await geocodeAddressDetailed(address)
  return full ? { lat: full.lat, lng: full.lng } : null
}

// Same call, but also returns the resolved community/neighborhood name so a
// single geocode can populate both coordinates AND the area name.
export async function geocodeAddressDetailed(address: string): Promise<{ lat: number; lng: number; neighborhood: string | null } | null> {
  try {
    const res = await fetch('/api/geocode', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ address }),
    })
    const data = await res.json()
    if (res.ok && typeof data.lat === 'number' && typeof data.lng === 'number') {
      return { lat: data.lat, lng: data.lng, neighborhood: data.neighborhood ?? null }
    }
  } catch { /* network/JSON failure → null */ }
  return null
}

// Reverse lookup: coordinates → real community name ("Queensland"), district as
// fallback. Used to backfill properties.neighborhood — stored once, never re-fetched.
export async function reverseNeighborhood(lat: number, lng: number): Promise<string | null> {
  try {
    const res = await fetch('/api/geocode', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ lat, lng }),
    })
    const data = await res.json()
    if (res.ok && typeof data.neighborhood === 'string' && data.neighborhood) return data.neighborhood
  } catch { /* ignore */ }
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

// How many existing located jobs sit within driving range of a target property,
// and how close the nearest one is. Powers the route-density travel discount and
// pricing-confidence scoring — same radius the Best-Day Suggester uses.
export function nearbyJobCount(
  target: Coord,
  jobs: { lat: number | null; lng: number | null }[],
  radiusKm: number = NEARBY_RADIUS_KM,
): { count: number; nearestKm: number | null } {
  const dists = jobs
    .filter(j => j.lat != null && j.lng != null)
    .map(j => haversineKm(target, { lat: j.lat as number, lng: j.lng as number }))
    .filter(km => km <= radiusKm)
  return {
    count: dists.length,
    nearestKm: dists.length ? Math.round(Math.min(...dists) * 10) / 10 : null,
  }
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
