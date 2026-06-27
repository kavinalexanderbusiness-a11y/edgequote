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

// A distance function between two coords. Defaults to straight-line haversine;
// callers can pass a cached real-road distance (lib/distance) to sharpen ordering
// and leg/total km without changing any of the engine's call sites.
export type DistFn = (a: Coord, b: Coord) => number

// Total open-path length: base → seq[0] → … → seq[last] (no return leg).
function pathKm(base: Coord, seq: { lat: number; lng: number }[], dist: DistFn): number {
  let total = 0
  let current: Coord = base
  for (const p of seq) { total += dist(current, p); current = p }
  return total
}

// 2-opt is skipped above this size to keep the estimator cheap; real days are
// far smaller, so in practice every route gets the improvement.
const MAX_2OPT_STOPS = 16

// Shared nearest-neighbour core (sync, no API) + 2-opt segment-reversal
// improvement. One implementation used by the Route Planner / Day panel
// fallback AND every km estimator, so ordering and distances never drift apart.
// NN alone is typically 10–25% above optimal; the 2-opt polish closes most of
// that gap. The improvement step recomputes the full path per candidate (O(n)
// for n ≤ MAX_2OPT_STOPS), which keeps it exact for ASYMMETRIC dist functions
// too (cached real-road distances are direction-dependent).
function nnOrder(base: Coord, pts: { lat: number; lng: number }[], dist: DistFn = haversineKm): { order: number[]; legKm: number[]; totalKm: number } {
  // 1) Greedy nearest-neighbour construction.
  const remaining = pts.map((_, i) => i)
  let current = base
  let seq: number[] = []
  while (remaining.length) {
    let bi = 0, bd = Infinity
    for (let k = 0; k < remaining.length; k++) {
      const d = dist(current, pts[remaining[k]])
      if (d < bd) { bd = d; bi = k }
    }
    const idx = remaining.splice(bi, 1)[0]
    seq.push(idx)
    current = pts[idx]
  }
  // 2) 2-opt improvement (fixed start at base, open path).
  if (seq.length >= 3 && seq.length <= MAX_2OPT_STOPS) {
    if (dist === haversineKm) {
      // Symmetric distance → reversing a segment leaves its interior length
      // unchanged, so each candidate is an O(1) delta on the two boundary
      // edges. First-improvement with restart; every restart strictly
      // shortens the path, so termination is guaranteed.
      const tryImprove = (): boolean => {
        for (let i = 0; i < seq.length - 1; i++) {
          const prev = i === 0 ? base : pts[seq[i - 1]]
          for (let j = i + 1; j < seq.length; j++) {
            const next = j + 1 < seq.length ? pts[seq[j + 1]] : null
            const delta = dist(prev, pts[seq[j]]) - dist(prev, pts[seq[i]])
              + (next ? dist(pts[seq[i]], next) - dist(pts[seq[j]], next) : 0)
            if (delta < -1e-9) {
              for (let a = i, b = j; a < b; a++, b--) { const t = seq[a]; seq[a] = seq[b]; seq[b] = t }
              return true
            }
          }
        }
        return false
      }
      for (let guard = 0; guard < 40 && tryImprove(); guard++) { /* improve until stable */ }
    } else {
      // Asymmetric (cached real-road) distances: a reversal changes interior
      // leg directions too, so evaluate candidates with a full-path recompute.
      // Only the Day Ops road path hits this — once per render, tiny n.
      let bestKm = pathKm(base, seq.map(i => pts[i]), dist)
      for (let sweep = 0; sweep < 8; sweep++) {
        let improved = false
        for (let i = 0; i < seq.length - 1; i++) {
          for (let j = i + 1; j < seq.length; j++) {
            const cand = seq.slice(0, i).concat(seq.slice(i, j + 1).reverse(), seq.slice(j + 1))
            const km = pathKm(base, cand.map(k => pts[k]), dist)
            if (km < bestKm - 1e-9) { seq = cand; bestKm = km; improved = true }
          }
        }
        if (!improved) break
      }
    }
  }
  // 3) Legs + total from the final order.
  let total = 0
  let cur: Coord = base
  const legKm: number[] = []
  for (const i of seq) {
    const d = dist(cur, pts[i])
    legKm.push(Math.round(d * 10) / 10)
    total += d
    cur = pts[i]
  }
  return { order: seq, legKm, totalKm: Math.round(total * 10) / 10 }
}

// Ordered nearest-neighbour route over located stops (used as the API fallback).
export function nearestNeighborRoute(base: Coord, located: RouteStop[], dist: DistFn = haversineKm): { ordered: OrderedRouteStop[]; totalKm: number } {
  const r = nnOrder(base, located.map(s => ({ lat: s.lat as number, lng: s.lng as number })), dist)
  return { ordered: r.order.map((idx, i) => ({ ...located[idx], order: i + 1, legKm: r.legKm[i] })), totalKm: r.totalKm }
}

// Quick total-km estimate for a set of coords (profitability dashboard — no API).
export function routeKmEstimate(base: Coord, located: { lat: number; lng: number }[], dist: DistFn = haversineKm): number {
  return located.length ? nnOrder(base, located, dist).totalKm : 0
}

// A stop's Maps locator: the real street ADDRESS when we have it (so Google
// shows the named place, not a "dropped pin" at bare coordinates), else the
// lat/lng. Returns null for a stop with neither.
function stopLocator(s: { lat: number | null; lng: number | null; address?: string | null }): string | null {
  const addr = s.address?.trim()
  if (addr) return addr
  if (s.lat != null && s.lng != null) return `${s.lat},${s.lng}`
  return null
}

// Round-trip Google Maps directions URL (base → stops → base). Shared so the
// cached-road path can build the same "Open in Maps" link optimizeRoute does.
// Waypoints use each stop's street address when available.
export function roundTripMapsUrl(base: Coord, ordered: { lat: number | null; lng: number | null; address?: string | null }[]): string {
  const baseParam = `${base.lat},${base.lng}`
  const waypoints = ordered.map(stopLocator).filter((x): x is string => !!x).join('|')
  const u = new URL('https://www.google.com/maps/dir/')
  u.searchParams.set('api', '1')
  u.searchParams.set('origin', baseParam)
  u.searchParams.set('destination', baseParam)
  if (waypoints) u.searchParams.set('waypoints', waypoints)
  u.searchParams.set('travelmode', 'driving')
  return u.toString()
}

// Cluster tightness when no base is configured: walk the stops from a
// DETERMINISTIC, content-based start (the westmost point) — never from
// "whatever happened to be first in the array". Input order must not change
// the estimate, or the optimizer's cost landscape becomes noisy and it can
// accept moves that only look better because the walk started elsewhere.
export function clusterKmEstimate(located: { lat: number; lng: number }[], dist: DistFn = haversineKm): number {
  if (located.length < 2) return 0
  let s = 0
  for (let i = 1; i < located.length; i++) {
    if (located[i].lng < located[s].lng || (located[i].lng === located[s].lng && located[i].lat < located[s].lat)) s = i
  }
  return routeKmEstimate(located[s], located.filter((_, i) => i !== s), dist)
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

  // Stop addresses (named places) for the waypoints, not bare coordinates.
  const mapsUrl = roundTripMapsUrl(base, ordered)

  return { ordered, totalKm: total, usedGoogle, missing, mapsUrl }
}

export const AVG_SPEED_KM_PER_MIN = 0.5 // ~30 km/h urban (fallback when nothing learned)

// A learned/overridable speed model. Defaults reproduce the legacy constant exactly
// (2 min/km, no per-stop overhead), so any caller that doesn't pass one is unchanged.
// lib/travelLearning supplies a learned { minPerKm, overheadMin } from completed routes.
export interface SpeedModel { minPerKm?: number; overheadMin?: number }
const DEFAULT_MIN_PER_KM = 1 / AVG_SPEED_KM_PER_MIN // = 2

// THE one place a leg's distance becomes drive minutes (load/unload overhead + drive).
export function legMinutes(km: number, speed?: SpeedModel): number {
  const mpk = speed?.minPerKm ?? DEFAULT_MIN_PER_KM
  const oh = speed?.overheadMin ?? 0
  return Math.round(oh + Math.max(0, km) * mpk)
}

// Density stats for a set of located stops + the optimized total distance.
export function routeStats(
  located: { lat: number; lng: number }[],
  totalKm: number,
  speed?: SpeedModel,
): { avgLegKm: number; driveMinutes: number; clusters: number } {
  const n = located.length
  const avgLegKm = n > 0 ? Math.round((totalKm / n) * 10) / 10 : 0
  const driveMinutes = Math.round(totalKm * (speed?.minPerKm ?? DEFAULT_MIN_PER_KM))
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
  customerPreferred: boolean // this weekday is in the customer's preferred set
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
    customerPreferredDays?: number[] // the customer's preferred weekdays (boost)
    customerAvoidDays?: number[]     // the customer's avoid weekdays (excluded)
    speed?: SpeedModel               // learned travel speed (else legacy 2 min/km)
  },
): ScheduleModes {
  const horizon = opts.horizonDays ?? 28
  const radius = opts.radiusKm ?? NEARBY_RADIUS_KM
  const targetHours = opts.targetHours ?? 0.75
  const targetValue = opts.targetValue ?? 0
  const preferAll = !opts.preferredDays || opts.preferredDays.length === 0
  const pref = new Set(opts.preferredDays || [])
  const custPref = new Set(opts.customerPreferredDays || [])
  const custAvoid = new Set(opts.customerAvoidDays || [])
  const base = opts.base ?? null
  const from = parseISO(opts.fromISO)

  const byDate: Record<string, SchedJob[]> = {}
  for (const j of jobs) (byDate[j.scheduled_date] ||= []).push(j)

  const days: DayPlan[] = []
  for (let i = 0; i < horizon; i++) {
    const d = addDays(from, i)
    const widx = getDay(d)
    if (!preferAll && !pref.has(widx)) continue   // strong preference: only score work days
    if (custAvoid.has(widx)) continue             // customer asked not to be booked this weekday
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
      addedDriveMin = legMinutes(Math.max(0, withT - without), opts.speed)
    } else if (base) {
      addedDriveMin = legMinutes(routeKmEstimate(base, [{ lat: target.lat, lng: target.lng }]), opts.speed)
    } else if (located.length) {
      addedDriveMin = legMinutes(Math.min(...located.map(p => haversineKm(target, p))) * 2, opts.speed)
    } else {
      // No base AND an empty day: opening a brand-new isolated trip. Charge the
      // worst-case in-radius detour so revenue mode can't prefer it over joining
      // an existing nearby cluster (0 here would invert the driving signal).
      addedDriveMin = legMinutes(radius * 2, opts.speed)
    }

    days.push({
      date: iso, weekday: format(d, 'EEEE'), weekdayIdx: widx, isPreferred: preferAll || pref.has(widx),
      jobCount: dayJobs.length,
      plannedHours: Math.round(((existingMin + targetHours * 60) / 60) * 10) / 10,
      scheduledRevenue: Math.round(existingRev + targetValue),
      nearbyCount: nearby.length,
      addedDriveMin,
      customerPreferred: custPref.has(widx),
    })
  }

  if (!days.length) return { density: null, balanced: null, revenue: null, days: [] }
  const argmax = (score: (d: DayPlan) => number) => days.reduce((best, d) => (score(d) > score(best) ? d : best), days[0])
  // Honour the customer's preferred weekdays as a bonus on every lens, so the
  // recommended day lands on a promised day unless another signal is far stronger.
  const pb = (d: DayPlan) => (d.customerPreferred ? 1 : 0)

  return {
    // Join the tightest existing cluster: many nearby stops, least added driving.
    density: argmax(d => d.nearbyCount * 100 - d.addedDriveMin + pb(d) * 200),
    // Spread the load: the emptiest work day (tie-break: fewer jobs, slight nearby pull).
    balanced: argmax(d => -(d.plannedHours * 10 + d.jobCount) + d.nearbyCount * 0.1 + pb(d) * 6),
    // Richest resulting day, lightly penalised for the driving it adds.
    revenue: argmax(d => d.scheduledRevenue - d.addedDriveMin * 3 + pb(d) * 80),
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
  speed?: SpeedModel,   // learned travel speed + load/unload overhead (else legacy 2 min/km)
): DayEtas {
  const startMin = timeToMinutes(startHHmm || DEFAULT_WORK_START)
  let t = startMin
  const stops: EtaStop[] = []
  for (const s of ordered) {
    t += s.legKm != null ? legMinutes(s.legKm, speed) : FALLBACK_LEG_MIN
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

// Google Maps directions URL from base to a single stop. Uses the stop's street
// ADDRESS as the destination when available (a named place, not a dropped pin),
// falling back to coordinates.
export function directionsUrl(dest: { lat: number | null; lng: number | null; address?: string | null }, base?: Coord | null): string {
  const u = new URL('https://www.google.com/maps/dir/')
  u.searchParams.set('api', '1')
  if (base) u.searchParams.set('origin', `${base.lat},${base.lng}`)
  u.searchParams.set('destination', stopLocator(dest) ?? '')
  u.searchParams.set('travelmode', 'driving')
  return u.toString()
}
