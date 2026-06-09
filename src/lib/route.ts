// ── Route optimization engine ─────────────────────────────────────────────────
// The ONE place day-route ordering lives. Used by the Route Planner page and the
// calendar Day Operations panel so they can never order a day differently.

import { Coord, haversineKm, geocodeAddress } from '@/lib/geo'
import type { createClient } from '@/lib/supabase/client'

type Supa = ReturnType<typeof createClient>

export interface RouteStop {
  jobId: string
  title: string
  address: string
  propertyId: string | null
  lat: number | null
  lng: number | null
}

export interface OrderedRouteStop extends RouteStop {
  order: number
  legKm: number | null
}

export interface RouteResult {
  ordered: OrderedRouteStop[]
  totalKm: number
  usedGoogle: boolean
  missing: RouteStop[]
  mapsUrl: string | null
}

// Geocode any stop missing coords, writing the result back to its property so we
// don't re-geocode next time. Mutates stops in place; returns how many we located.
export async function geocodeMissingStops(supabase: Supa, stops: RouteStop[]): Promise<number> {
  let n = 0
  for (const s of stops) {
    if ((s.lat == null || s.lng == null) && s.address) {
      const c = await geocodeAddress(s.address)
      if (c) {
        s.lat = c.lat; s.lng = c.lng; n++
        if (s.propertyId) await supabase.from('properties').update({ lat: c.lat, lng: c.lng }).eq('id', s.propertyId)
      }
    }
  }
  return n
}

// Shared nearest-neighbour core (sync, no API). One implementation used by the
// Route Planner / Day panel fallback AND the Route Profitability estimator.
function nnOrder(base: Coord, pts: { lat: number; lng: number }[]): { order: number[]; legKm: number[]; totalKm: number } {
  const remaining = pts.map((p, i) => ({ p, i }))
  let current = base
  let total = 0
  const order: number[] = []
  const legKm: number[] = []
  while (remaining.length) {
    let bi = 0, bd = Infinity
    for (let k = 0; k < remaining.length; k++) {
      const d = haversineKm(current, remaining[k].p)
      if (d < bd) { bd = d; bi = k }
    }
    const n = remaining.splice(bi, 1)[0]
    order.push(n.i)
    legKm.push(Math.round(bd * 10) / 10)
    total += bd
    current = { lat: n.p.lat, lng: n.p.lng }
  }
  return { order, legKm, totalKm: Math.round(total * 10) / 10 }
}

// Ordered nearest-neighbour route over located stops (used as the API fallback).
export function nearestNeighborRoute(base: Coord, located: RouteStop[]): { ordered: OrderedRouteStop[]; totalKm: number } {
  const r = nnOrder(base, located.map(s => ({ lat: s.lat as number, lng: s.lng as number })))
  return { ordered: r.order.map((idx, i) => ({ ...located[idx], order: i + 1, legKm: r.legKm[i] })), totalKm: r.totalKm }
}

// Quick total-km estimate for a set of coords (profitability dashboard — no API).
export function routeKmEstimate(base: Coord, located: { lat: number; lng: number }[]): number {
  return located.length ? nnOrder(base, located).totalKm : 0
}

// Order stops into an efficient driving route. Prefers Google's real-road
// optimization (/api/route); falls back to straight-line nearest-neighbour.
export async function optimizeRoute(base: Coord, stops: RouteStop[]): Promise<RouteResult> {
  const located = stops.filter(s => s.lat != null && s.lng != null)
  const missing = stops.filter(s => s.lat == null || s.lng == null)
  if (located.length === 0) return { ordered: [], totalKm: 0, usedGoogle: false, missing, mapsUrl: null }

  let ordered: OrderedRouteStop[] = []
  let total = 0
  let usedGoogle = false

  try {
    const res = await fetch('/api/route', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ base, stops: located.map(s => ({ lat: s.lat, lng: s.lng })) }),
    })
    const data = await res.json()
    if (res.ok && Array.isArray(data.order)) {
      ordered = data.order.map((idx: number, i: number) => ({
        ...located[idx], order: i + 1,
        legKm: typeof data.legKm?.[i] === 'number' ? data.legKm[i] : null,
      }))
      total = typeof data.totalKm === 'number' ? data.totalKm : 0
      usedGoogle = true
    }
  } catch { /* fall back below */ }

  if (!usedGoogle) {
    const nn = nearestNeighborRoute(base, located)
    ordered = nn.ordered
    total = nn.totalKm
  }

  const baseParam = `${base.lat},${base.lng}`
  const waypoints = ordered.map(s => `${s.lat},${s.lng}`).join('|')
  const u = new URL('https://www.google.com/maps/dir/')
  u.searchParams.set('api', '1')
  u.searchParams.set('origin', baseParam)
  u.searchParams.set('destination', baseParam)
  if (waypoints) u.searchParams.set('waypoints', waypoints)
  u.searchParams.set('travelmode', 'driving')

  return { ordered, totalKm: total, usedGoogle, missing, mapsUrl: u.toString() }
}

const AVG_SPEED_KM_PER_MIN = 0.5 // ~30 km/h urban

// Density stats for a set of located stops + the optimized total distance.
export function routeStats(
  located: { lat: number; lng: number }[],
  totalKm: number,
): { avgLegKm: number; driveMinutes: number; clusters: number } {
  const n = located.length
  const avgLegKm = n > 0 ? Math.round((totalKm / n) * 10) / 10 : 0
  const driveMinutes = Math.round(totalKm / AVG_SPEED_KM_PER_MIN)
  // Connected components: stops within 1 km link into the same cluster.
  const CLUSTER_KM = 1
  const parent = located.map((_, i) => i)
  const find = (a: number): number => (parent[a] === a ? a : (parent[a] = find(parent[a])))
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      if (haversineKm(located[i], located[j]) <= CLUSTER_KM) parent[find(i)] = find(j)
    }
  }
  return { avgLegKm, driveMinutes, clusters: new Set(located.map((_, i) => find(i))).size }
}

// Google Maps directions URL from base to a single stop.
export function directionsUrl(dest: { lat: number | null; lng: number | null; address?: string }, base?: Coord | null): string {
  const u = new URL('https://www.google.com/maps/dir/')
  u.searchParams.set('api', '1')
  if (base) u.searchParams.set('origin', `${base.lat},${base.lng}`)
  u.searchParams.set('destination', dest.lat != null && dest.lng != null ? `${dest.lat},${dest.lng}` : (dest.address || ''))
  u.searchParams.set('travelmode', 'driving')
  return u.toString()
}
