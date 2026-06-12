// ── Road-distance cache ───────────────────────────────────────────────────────
// Pairwise real-road distances for the small set of points that actually appear
// on a route (a day's base + stops), fetched ONCE from the Distance Matrix and
// reused from the road_distance_cache table — so Day Ops route numbers are
// real-road instead of straight-line without re-billing the API on every view.
// Returns a (a,b)=>km function that falls back to haversine for any pair still
// missing (no API key, offline, or an unreachable element). Build it once, then
// feed it into the existing route engine (lib/route distFn param).

import type { SupabaseClient } from '@supabase/supabase-js'
import { Coord, haversineKm } from '@/lib/geo'

export type RoadDist = (a: Coord, b: Coord) => number

// ~11 m grid — coordinates this close share a cache entry (geocodes are stable to
// well within this, so two visits at the same property reuse one measurement).
export function distKey(lat: number, lng: number): string {
  return `${lat.toFixed(4)},${lng.toFixed(4)}`
}

function dedupeByKey(coords: Coord[]): Coord[] {
  const seen = new Set<string>()
  const out: Coord[] = []
  for (const c of coords) {
    const k = distKey(c.lat, c.lng)
    if (seen.has(k)) continue
    seen.add(k)
    out.push(c)
  }
  return out
}

const DISTANCE_MATRIX_MAX_ELEMENTS = 100

interface MatrixResponse { rows?: ({ km: number; seconds: number | null } | null)[][] }

// Fetch every origin→destination distance among `pts`, batching to stay under the
// Distance Matrix element cap. Fills `cache` (keyed "from|to") and returns the
// rows to persist.
async function fetchMatrix(pts: Coord[], cache: Map<string, number>): Promise<{ from_key: string; to_key: string; km: number; seconds: number | null }[]> {
  const keys = pts.map(p => distKey(p.lat, p.lng))
  const toInsert: { from_key: string; to_key: string; km: number; seconds: number | null }[] = []
  const chunkSize = Math.max(1, Math.floor(DISTANCE_MATRIX_MAX_ELEMENTS / pts.length))

  for (let i = 0; i < pts.length; i += chunkSize) {
    const originSlice = pts.slice(i, i + chunkSize)
    let data: MatrixResponse
    try {
      const res = await fetch('/api/distance-matrix', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ origins: originSlice, destinations: pts }),
      })
      if (!res.ok) return toInsert // API/key error — keep whatever we have, fall back to haversine
      data = await res.json()
    } catch {
      return toInsert
    }
    const rows = data.rows || []
    rows.forEach((row, oi) => {
      const fromIdx = i + oi
      ;(row || []).forEach((cell, di) => {
        if (!cell || fromIdx === di) return
        const fk = keys[fromIdx], tk = keys[di]
        if (fk === tk) return
        cache.set(`${fk}|${tk}`, cell.km)
        toInsert.push({ from_key: fk, to_key: tk, km: cell.km, seconds: cell.seconds })
      })
    })
  }
  return toInsert
}

// Build a road-distance function over `coords` (base + the day's located stops).
// usedRoad = at least one real-road pair is available (so the UI can say so).
export async function buildRoadDistance(
  supabase: SupabaseClient,
  userId: string,
  coords: Coord[],
): Promise<{ dist: RoadDist; usedRoad: boolean }> {
  const pts = dedupeByKey(coords.filter(c => c && c.lat != null && c.lng != null))
  if (pts.length < 2) return { dist: haversineKm, usedRoad: false }

  const keys = pts.map(p => distKey(p.lat, p.lng))
  const cache = new Map<string, number>() // "from|to" → km

  // 1) Load whatever pairs we've already measured.
  try {
    const { data } = await supabase
      .from('road_distance_cache')
      .select('from_key, to_key, km')
      .eq('user_id', userId)
      .in('from_key', keys)
      .in('to_key', keys)
    for (const r of (data as { from_key: string; to_key: string; km: number }[] | null) || []) {
      cache.set(`${r.from_key}|${r.to_key}`, Number(r.km))
    }
  } catch { /* cache read failed — proceed, we'll just fetch / fall back */ }

  // 2) Any ordered pair still missing?
  let anyMissing = false
  for (let a = 0; a < pts.length && !anyMissing; a++) {
    for (let b = 0; b < pts.length; b++) {
      if (a === b || keys[a] === keys[b]) continue
      if (!cache.has(`${keys[a]}|${keys[b]}`)) { anyMissing = true; break }
    }
  }

  // 3) Fetch the missing pairs in one (batched) pass and persist them.
  if (anyMissing) {
    const fetched = await fetchMatrix(pts, cache)
    if (fetched.length) {
      try {
        await supabase.from('road_distance_cache')
          .upsert(fetched.map(f => ({ user_id: userId, ...f })), { onConflict: 'user_id,from_key,to_key' })
      } catch { /* persist failed — distances still usable for this session */ }
    }
  }

  const dist: RoadDist = (a, b) => {
    const v = cache.get(`${distKey(a.lat, a.lng)}|${distKey(b.lat, b.lng)}`)
    return v != null ? v : haversineKm(a, b)
  }
  return { dist, usedRoad: cache.size > 0 }
}
