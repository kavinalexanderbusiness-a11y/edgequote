// ── Route optimization engine ─────────────────────────────────────────────────
// The ONE place day-route ordering lives. Used by the Route Planner page and the
// calendar Day Operations panel so they can never order a day differently.

import { parseISO, addDays, format, getDay } from 'date-fns'
import { Coord, haversineKm, geocodeAddressDetailed, NEARBY_RADIUS_KM, SchedJob } from '@/lib/geo'
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
      const c = await geocodeAddressDetailed(s.address)
      if (c) {
        s.lat = c.lat; s.lng = c.lng; n++
        if (s.propertyId) {
          // One geocode fills coords AND the community name (neighborhood
          // analytics read properties.neighborhood — one source of truth).
          const patch: Record<string, unknown> = { lat: c.lat, lng: c.lng }
          if (c.neighborhood) patch.neighborhood = c.neighborhood
          await supabase.from('properties').update(patch).eq('id', s.propertyId)
        }
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

// Cluster tightness when no base is configured: walk the stops from the first
// one. Still measures how spread out a day is, just without the home leg.
export function clusterKmEstimate(located: { lat: number; lng: number }[]): number {
  return located.length > 1 ? routeKmEstimate(located[0], located.slice(1)) : 0
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

export const AVG_SPEED_KM_PER_MIN = 0.5 // ~30 km/h urban

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

// ── Whole-week multi-mode scheduler ──────────────────────────────────────────
// Instead of optimizing one job in isolation (which packs everything onto the
// first day that happened to get a nearby job), this scores EVERY preferred work
// day over the horizon and returns the best day under three lenses. Reuses the
// route engine (routeKmEstimate marginal-insertion cost) + geo (haversine) — no
// separate scheduling engine.

export interface DayPlan {
  date: string
  weekday: string
  weekdayIdx: number       // 0=Sun … 6=Sat
  isPreferred: boolean
  jobCount: number         // existing jobs that day
  plannedHours: number     // existing hours + the new job's hours
  scheduledRevenue: number // existing revenue + the new job's value
  nearbyCount: number      // existing located jobs within radius of the target
  addedDriveMin: number    // marginal driving to slot the target into that day's route
}

export interface ScheduleModes {
  density: DayPlan | null   // 🏆 tightest cluster / least added driving
  balanced: DayPlan | null  // ⚖️ spread workload evenly
  revenue: DayPlan | null   // 💰 richest day while keeping density sane
  days: DayPlan[]
}

export function recommendScheduleDays(
  target: Coord,
  jobs: SchedJob[],
  opts: {
    fromISO: string
    horizonDays?: number
    preferredDays: number[]   // weekday indices the owner works; empty = all days
    base?: Coord | null
    targetHours?: number      // the job-being-scheduled's on-site hours
    targetValue?: number      // the job-being-scheduled's per-visit revenue
    radiusKm?: number
  },
): ScheduleModes {
  const horizon = opts.horizonDays ?? 28
  const radius = opts.radiusKm ?? NEARBY_RADIUS_KM
  const targetHours = opts.targetHours ?? 0.75
  const targetValue = opts.targetValue ?? 0
  const preferAll = !opts.preferredDays || opts.preferredDays.length === 0
  const pref = new Set(opts.preferredDays || [])
  const base = opts.base ?? null
  const from = parseISO(opts.fromISO)

  const byDate: Record<string, SchedJob[]> = {}
  for (const j of jobs) (byDate[j.scheduled_date] ||= []).push(j)

  const days: DayPlan[] = []
  for (let i = 0; i < horizon; i++) {
    const d = addDays(from, i)
    const widx = getDay(d)
    if (!preferAll && !pref.has(widx)) continue   // strong preference: only score work days
    const iso = format(d, 'yyyy-MM-dd')
    const dayJobs = byDate[iso] || []
    const located = dayJobs.filter(j => j.lat != null && j.lng != null).map(j => ({ lat: j.lat as number, lng: j.lng as number }))
    const nearby = located.map(p => haversineKm(target, p)).filter(km => km <= radius)
    const existingMin = dayJobs.reduce((s, j) => s + j.durationMin, 0)
    const existingRev = dayJobs.reduce((s, j) => s + j.value, 0)

    let addedDriveMin: number
    if (base && located.length) {
      const without = routeKmEstimate(base, located)
      const withT = routeKmEstimate(base, [...located, { lat: target.lat, lng: target.lng }])
      addedDriveMin = Math.round(Math.max(0, withT - without) / AVG_SPEED_KM_PER_MIN)
    } else if (base) {
      addedDriveMin = Math.round(routeKmEstimate(base, [{ lat: target.lat, lng: target.lng }]) / AVG_SPEED_KM_PER_MIN)
    } else if (located.length) {
      addedDriveMin = Math.round((Math.min(...located.map(p => haversineKm(target, p))) * 2) / AVG_SPEED_KM_PER_MIN)
    } else {
      // No base AND an empty day: opening a brand-new isolated trip. Charge the
      // worst-case in-radius detour so revenue mode can't prefer it over joining
      // an existing nearby cluster (0 here would invert the driving signal).
      addedDriveMin = Math.round((radius * 2) / AVG_SPEED_KM_PER_MIN)
    }

    days.push({
      date: iso, weekday: format(d, 'EEEE'), weekdayIdx: widx, isPreferred: preferAll || pref.has(widx),
      jobCount: dayJobs.length,
      plannedHours: Math.round(((existingMin + targetHours * 60) / 60) * 10) / 10,
      scheduledRevenue: Math.round(existingRev + targetValue),
      nearbyCount: nearby.length,
      addedDriveMin,
    })
  }

  if (!days.length) return { density: null, balanced: null, revenue: null, days: [] }
  const argmax = (score: (d: DayPlan) => number) => days.reduce((best, d) => (score(d) > score(best) ? d : best), days[0])

  return {
    // Join the tightest existing cluster: many nearby stops, least added driving.
    density: argmax(d => d.nearbyCount * 100 - d.addedDriveMin),
    // Spread the load: the emptiest work day (tie-break: fewer jobs, slight nearby pull).
    balanced: argmax(d => -(d.plannedHours * 10 + d.jobCount) + d.nearbyCount * 0.1),
    // Richest resulting day, lightly penalised for the driving it adds.
    revenue: argmax(d => d.scheduledRevenue - d.addedDriveMin * 3),
    days,
  }
}

// ── Real-world day timing (ETAs) ─────────────────────────────────────────────
// ONE place arrival/finish times are computed from work start + route order +
// per-leg drive time + job durations. Used by Day Ops, Route Analysis and the
// Weekend Outlook so an 8:00 start always produces the same 2:45 finish.

export const DEFAULT_WORK_START = '08:00'
const FALLBACK_LEG_MIN = 10     // drive estimate when a leg has no distance
export const DEFAULT_JOB_MIN = 45

export function timeToMinutes(hhmm: string | null | undefined): number {
  const m = (hhmm || '').match(/^(\d{1,2}):(\d{2})/)
  if (!m) return 8 * 60
  return Math.min(23 * 60 + 59, parseInt(m[1], 10) * 60 + parseInt(m[2], 10))
}

export function minutesToTime12(totalMin: number): string {
  const m = ((Math.round(totalMin) % 1440) + 1440) % 1440
  const h24 = Math.floor(m / 60)
  const h12 = h24 % 12 === 0 ? 12 : h24 % 12
  return `${h12}:${String(m % 60).padStart(2, '0')} ${h24 < 12 ? 'AM' : 'PM'}`
}

export interface EtaStop { jobId: string; arrivalMin: number; arrival: string }
export interface DayEtas { stops: EtaStop[]; finishMin: number; finish: string; startMin: number }

// Walk the ordered route: drive each leg, work the stop, drive on. legKm null →
// fallback leg time so un-located stops still advance the clock.
export function computeDayEtas(
  startHHmm: string | null | undefined,
  ordered: { jobId: string; legKm: number | null }[],
  durationMinByJob: Record<string, number>,
): DayEtas {
  const startMin = timeToMinutes(startHHmm || DEFAULT_WORK_START)
  let t = startMin
  const stops: EtaStop[] = []
  for (const s of ordered) {
    t += s.legKm != null ? Math.round(s.legKm / AVG_SPEED_KM_PER_MIN) : FALLBACK_LEG_MIN
    stops.push({ jobId: s.jobId, arrivalMin: t, arrival: minutesToTime12(t) })
    t += durationMinByJob[s.jobId] ?? DEFAULT_JOB_MIN
  }
  return { stops, finishMin: t, finish: minutesToTime12(t), startMin }
}

// Quick finish estimate when no route order exists (summaries): start + labour
// + a fallback drive leg per stop.
export function roughFinishEstimate(startHHmm: string | null | undefined, totalLaborMin: number, stops: number): { finishMin: number; finish: string } {
  const t = timeToMinutes(startHHmm || DEFAULT_WORK_START) + totalLaborMin + stops * FALLBACK_LEG_MIN
  return { finishMin: t, finish: minutesToTime12(t) }
}

// Soft load signal vs the owner's daily capacity. spareMin >= 60 → room for more.
export function dayLoad(totalWorkMin: number, capacityHours: number | null | undefined): { state: 'overloaded' | 'full' | 'room'; spareMin: number } {
  const cap = (capacityHours && capacityHours > 0 ? capacityHours : 8) * 60
  const spare = Math.round(cap - totalWorkMin)
  return { state: spare < 0 ? 'overloaded' : spare >= 60 ? 'room' : 'full', spareMin: spare }
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
