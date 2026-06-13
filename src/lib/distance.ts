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

// ── Routing road distances for the OPTIMIZER (cost-bounded) ───────────────────
// The whole-schedule optimizer routes many candidate days over potentially
// hundreds of stops. A full pairwise matrix would be O(N²) Distance-Matrix
// elements — far too costly. Only the legs that ACTUALLY affect routing are
// fetched: base↔every stop (every route starts at base) and each stop↔its K
// nearest stops (only nearby stops ever share a tight day; far pairs use
// haversine, which is fine for "these are far apart"). This makes cost ~linear
// in the number of stops. A per-call request budget caps the API burst on first
// use; uncovered pairs fall back to haversine and fill in on later loads (the
// cache persists). The lookup treats road distance as symmetric.
export async function buildRoutingRoadDistance(
  supabase: SupabaseClient,
  userId: string,
  base: Coord | null,
  stops: Coord[],
  opts: { neighbors?: number; maxRequests?: number } = {},
): Promise<{ dist: RoadDist; usedRoad: boolean; coverage: number }> {
  const neighbors = opts.neighbors ?? 8
  const maxRequests = opts.maxRequests ?? 40
  const uniq = dedupeByKey(stops.filter(c => c && c.lat != null && c.lng != null))
  if (!base || uniq.length < 1) return { dist: haversineKm, usedRoad: false, coverage: 0 }

  const pts = [base, ...uniq]
  const keys = pts.map(p => distKey(p.lat, p.lng))
  const baseKey = keys[0]
  const stopKeys = keys.slice(1)
  const coordByKey = new Map<string, Coord>()
  pts.forEach((c, i) => coordByKey.set(keys[i], c))

  const cache = new Map<string, number>() // directional "from|to" → km
  const has = (ak: string, bk: string) => cache.has(`${ak}|${bk}`) || cache.has(`${bk}|${ak}`)

  // 1) Load all cached pairs among these keys.
  try {
    const { data } = await supabase.from('road_distance_cache')
      .select('from_key, to_key, km').eq('user_id', userId)
      .in('from_key', keys).in('to_key', keys)
    for (const r of (data as { from_key: string; to_key: string; km: number }[] | null) || []) {
      cache.set(`${r.from_key}|${r.to_key}`, Number(r.km))
    }
  } catch { /* proceed with haversine fallback */ }

  // 2) Needed pairs. base→stops keep base as the origin (fetched first, highest
  // value); stop↔K-nearest are canonicalized to dedupe direction.
  const neededPairs = new Set<string>()
  const need = new Map<string, Set<string>>() // originKey → missing destKeys
  const addNeed = (ok: string, dk: string, canonical: boolean) => {
    if (ok === dk) return
    const canon = ok < dk ? `${ok}|${dk}` : `${dk}|${ok}`
    neededPairs.add(canon)
    if (has(ok, dk)) return
    const origin = canonical ? (ok < dk ? ok : dk) : ok
    const dest = canonical ? (ok < dk ? dk : ok) : dk
    if (!need.has(origin)) need.set(origin, new Set())
    need.get(origin)!.add(dest)
  }
  for (const sk of stopKeys) addNeed(baseKey, sk, false)
  for (let i = 0; i < uniq.length; i++) {
    const nearest = uniq
      .map((c, j) => ({ j, d: j === i ? Infinity : haversineKm(uniq[i], c) }))
      .sort((a, b) => a.d - b.d).slice(0, neighbors)
    for (const { j } of nearest) addNeed(stopKeys[i], stopKeys[j], true)
  }

  // 3) Fetch missing (base origin first), bounded by the request budget.
  const toInsert: { from_key: string; to_key: string; km: number; seconds: number | null }[] = []
  let requests = 0
  const origins = [...need.keys()].sort((a, b) => (a === baseKey ? -1 : b === baseKey ? 1 : 0))
  outer: for (const ok of origins) {
    const destArr = [...need.get(ok)!]
    for (let i = 0; i < destArr.length; i += DISTANCE_MATRIX_MAX_ELEMENTS) {
      if (requests >= maxRequests) break outer
      const chunk = destArr.slice(i, i + DISTANCE_MATRIX_MAX_ELEMENTS)
      requests++
      let data: MatrixResponse
      try {
        const res = await fetch('/api/distance-matrix', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ origins: [coordByKey.get(ok)!], destinations: chunk.map(k => coordByKey.get(k)!) }),
        })
        if (!res.ok) break outer
        data = await res.json()
      } catch { break outer }
      const row = (data.rows || [])[0] || []
      row.forEach((cell, idx) => {
        if (!cell) return
        const tk = chunk[idx]
        cache.set(`${ok}|${tk}`, cell.km)
        toInsert.push({ from_key: ok, to_key: tk, km: cell.km, seconds: cell.seconds })
      })
    }
  }
  if (toInsert.length) {
    try {
      await supabase.from('road_distance_cache')
        .upsert(toInsert.map(f => ({ user_id: userId, ...f })), { onConflict: 'user_id,from_key,to_key' })
    } catch { /* still usable this session */ }
  }

  let covered = 0
  for (const canon of neededPairs) { const [a, b] = canon.split('|'); if (has(a, b)) covered++ }
  const coverage = neededPairs.size ? covered / neededPairs.size : 0

  const dist: RoadDist = (a, b) => {
    const ak = distKey(a.lat, a.lng), bk = distKey(b.lat, b.lng)
    const v = cache.get(`${ak}|${bk}`) ?? cache.get(`${bk}|${ak}`)
    return v != null ? v : haversineKm(a, b)
  }
  return { dist, usedRoad: cache.size > 0, coverage }
}
