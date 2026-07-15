import type { SupabaseClient } from '@supabase/supabase-js'
import { haversineKm } from '@/lib/geo'
import { readCache, writeCache, CACHE_TTL } from '@/lib/clientCache'
import { clamp } from '@/lib/utils'

// ── Drive-time learning ──────────────────────────────────────────────────────
// EdgeQuote already turns distance → minutes with ONE constant (geo.ts
// AVG_SPEED_KM_PER_MIN = 0.5 km/min → 2 min/km), used by the optimizer, ETA, and
// best-day suggester. This engine LEARNS that speed (and the per-stop load/unload
// overhead) from completed routes instead of assuming it — then feeds the SAME
// `overhead + km × minPerKm` math. It does NOT replace any engine and needs NO new
// table: a "leg" is the gap between finishing one job and starting the next on the
// same day (jobs already stamp started_at / completed_at), paired with the
// straight-line distance between the two properties. Thin data → falls back to the
// historical constant, so behaviour is unchanged until enough routes accrue.

// The legacy defaults (1 / AVG_SPEED_KM_PER_MIN). Keep them as the fallback so an
// owner with no timed routes sees exactly today's numbers.
export const DEFAULT_MIN_PER_KM = 2
export const DEFAULT_OVERHEAD_MIN = 5

export type TravelConfidence = 'high' | 'medium' | 'low'

export interface TravelModel {
  minPerKm: number       // learned drive minutes per km (else default)
  overheadMin: number    // learned fixed per-stop load/unload/setup (else default)
  samples: number        // timed legs learned from
  confidence: TravelConfidence
  byHood: Record<string, { minPerKm: number; n: number }> // per from-neighborhood refinement
  source: 'learned' | 'default'
}

interface Leg { km: number; minutes: number; fromHood: string | null }

function median(xs: number[]): number {
  if (!xs.length) return 0
  const s = [...xs].sort((a, b) => a - b)
  const m = s.length >> 1
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2
}

export const DEFAULT_TRAVEL_MODEL: TravelModel = {
  minPerKm: DEFAULT_MIN_PER_KM, overheadMin: DEFAULT_OVERHEAD_MIN,
  samples: 0, confidence: 'low', byHood: {}, source: 'default',
}

export function learnTravelModel(legs: Leg[]): TravelModel {
  // Overhead = the typical transition on a near-zero-distance leg (next stop in the
  // same area): pure load/unload/setup with negligible driving.
  const shortLegs = legs.filter(l => l.km < 0.3 && l.minutes > 0 && l.minutes < 60)
  const overheadMin = shortLegs.length >= 3 ? clamp(median(shortLegs.map(l => l.minutes)), 0, 30) : DEFAULT_OVERHEAD_MIN

  // Drive speed = (transition − overhead) ÷ km over real legs. Robust median, sane clamp.
  const driveLegs = legs.filter(l => l.km >= 0.5 && l.minutes > overheadMin && l.minutes < 180)
  const perKm = driveLegs.map(l => (l.minutes - overheadMin) / l.km).filter(v => v > 0.2 && v < 12)
  const learned = perKm.length >= 5 ? clamp(median(perKm), 0.5, 8) : DEFAULT_MIN_PER_KM
  const samples = driveLegs.length
  const confidence: TravelConfidence = samples >= 30 ? 'high' : samples >= 8 ? 'medium' : 'low'

  // Per-from-neighborhood refinement (only where enough data — else use the global).
  const byHoodVals: Record<string, number[]> = {}
  for (const l of driveLegs) {
    if (!l.fromHood) continue
    const v = (l.minutes - overheadMin) / l.km
    if (v > 0.2 && v < 12) (byHoodVals[l.fromHood] ||= []).push(v)
  }
  const byHood: TravelModel['byHood'] = {}
  for (const [h, vs] of Object.entries(byHoodVals)) if (vs.length >= 4) byHood[h] = { minPerKm: clamp(median(vs), 0.5, 8), n: vs.length }

  const enough = samples >= 5
  return {
    minPerKm: enough ? learned : DEFAULT_MIN_PER_KM,
    overheadMin, samples, confidence, byHood,
    source: enough ? 'learned' : 'default',
  }
}

// Travel minutes for a leg of `km`, optionally refined by the from-neighborhood.
// This is the ONE place every consumer should turn distance into drive minutes.
export function estimateLegMinutes(km: number, model: TravelModel = DEFAULT_TRAVEL_MODEL, fromHood?: string | null): number {
  const mpk = (fromHood && model.byHood[fromHood]?.minPerKm) || model.minPerKm
  return Math.round(model.overheadMin + Math.max(0, km) * mpk)
}

const CACHE_KEY = 'travel-model'

export async function loadTravelModel(supabase: SupabaseClient, opts?: { force?: boolean }): Promise<TravelModel> {
  if (!opts?.force) {
    const cached = readCache<TravelModel>(CACHE_KEY, CACHE_TTL.medium)
    if (cached) return cached
  }
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return DEFAULT_TRAVEL_MODEL
  const { data } = await supabase
    .from('jobs')
    .select('scheduled_date, started_at, completed_at, properties(lat, lng, neighborhood)')
    .eq('user_id', user.id).eq('status', 'completed')
    .not('started_at', 'is', null).not('completed_at', 'is', null)
    .order('scheduled_date', { ascending: false })
    .limit(2000)

  type Row = { scheduled_date: string; started_at: string; completed_at: string; properties?: { lat: number | null; lng: number | null; neighborhood: string | null } | null }
  const rows = (data as unknown as Row[]) || []

  // Group by day, order by completion, build consecutive legs.
  const byDay: Record<string, Row[]> = {}
  for (const r of rows) if (r.properties?.lat != null && r.properties?.lng != null) (byDay[r.scheduled_date] ||= []).push(r)
  const legs: Leg[] = []
  for (const day of Object.values(byDay)) {
    const ordered = day.sort((a, b) => a.completed_at.localeCompare(b.completed_at))
    for (let i = 1; i < ordered.length; i++) {
      const prev = ordered[i - 1], cur = ordered[i]
      const gapMin = (new Date(cur.started_at).getTime() - new Date(prev.completed_at).getTime()) / 60000
      if (!(gapMin > 0) || gapMin > 240) continue // skip overlaps + long idle gaps (lunch/errands)
      const km = haversineKm(
        { lat: prev.properties!.lat as number, lng: prev.properties!.lng as number },
        { lat: cur.properties!.lat as number, lng: cur.properties!.lng as number },
      )
      legs.push({ km, minutes: gapMin, fromHood: prev.properties?.neighborhood ?? null })
    }
  }
  const model = learnTravelModel(legs)
  writeCache(CACHE_KEY, model)
  return model
}
