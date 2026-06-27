import 'server-only'
import type { SupabaseClient } from '@supabase/supabase-js'
import type { VisionImage, VisionMediaType } from '@/lib/ai/vision'
import { fetchSatelliteImage, SATELLITE_ZOOM } from './staticMap'
import { confidenceBand, type IntelSource, type PropertyIntelligence, type VisionAnalysis } from './types'
import { VISION_PROMPT_VERSION } from './prompt'

// ── AI Vision — server data layer ─────────────────────────────────────────────
// Gathers the imagery for one property (satellite still + uploaded photos) as
// base64 for the model, computes a reuse signature, and persists / reads the
// property_intelligence rows. Server-only: it reads the maps key and pulls image
// bytes. Nothing here prices or writes a quote/job — it stores recommendations.

const MAX_PHOTOS = 6 // satellite + up to 6 ground photos keeps the request lean

// A photo the route resolved (public bucket URL) ready to attach.
export interface AnalyzablePhoto {
  id: string
  url: string
  kind: 'before' | 'after' | 'general'
  caption: string | null
  taken_at?: string | null
}

function normalizeMediaType(ct: string | null): VisionMediaType {
  const t = (ct || '').toLowerCase()
  if (t.includes('png')) return 'image/png'
  if (t.includes('webp')) return 'image/webp'
  if (t.includes('gif')) return 'image/gif'
  return 'image/jpeg'
}

// Fetch a remote image (public photo URL) → base64. null on any failure so one
// bad photo never sinks the whole analysis. Never throws.
async function fetchRemoteImage(url: string): Promise<{ mediaType: VisionMediaType; dataBase64: string } | null> {
  try {
    const res = await fetch(url)
    if (!res.ok) return null
    const mediaType = normalizeMediaType(res.headers.get('content-type'))
    const buf = Buffer.from(await res.arrayBuffer())
    if (buf.length === 0) return null
    return { mediaType, dataBase64: buf.toString('base64') }
  } catch {
    return null
  }
}

function photoLabel(p: AnalyzablePhoto, idx: number): string {
  const tag = p.kind === 'before' ? 'BEFORE photo' : p.kind === 'after' ? 'AFTER photo' : 'Ground photo'
  const cap = p.caption ? ` — "${p.caption}"` : ''
  return `${tag} ${idx + 1} (ground-level, current)${cap}:`
}

export interface GatheredImages {
  images: VisionImage[]
  source: IntelSource
  signature: string
  usedPhotoIds: string[]
  satelliteUsed: boolean
}

// Prefer before→after→general, newest first, capped — the most informative set.
const PHOTO_ORDER = { before: 0, after: 1, general: 2 } as const
function rankPhotos(photos: AnalyzablePhoto[]): AnalyzablePhoto[] {
  return [...photos]
    .sort((a, b) => (PHOTO_ORDER[a.kind] - PHOTO_ORDER[b.kind]) || ((b.taken_at || '').localeCompare(a.taken_at || '')))
    .slice(0, MAX_PHOTOS)
}

// THE one signature format — used by both the prospective plan and the actual
// gather, so the cache-hit check and the stored key can never disagree on shape.
function signatureFor(satellite: boolean, photoIds: string[]): string {
  return `sat:${satellite ? SATELLITE_ZOOM : 0}|photos:${[...photoIds].sort().join(',')}`
}

// What a run WILL analyze, decided WITHOUT fetching a single byte. The route uses
// the plan's signature to serve a cache hit (identical imagery already analysed)
// without paying the satellite + photo download cost on every re-open.
export interface ImagePlan {
  satellitePlanned: boolean
  photoPlan: AnalyzablePhoto[]
  signature: string
}
export function planImageSet(opts: {
  lat: number | null
  lng: number | null
  includeSatellite: boolean
  satelliteAvailable: boolean
  photos: AnalyzablePhoto[]
}): ImagePlan {
  const satellitePlanned = opts.includeSatellite && opts.lat != null && opts.lng != null && opts.satelliteAvailable
  const photoPlan = rankPhotos(opts.photos)
  return { satellitePlanned, photoPlan, signature: signatureFor(satellitePlanned, photoPlan.map(p => p.id)) }
}

// Fetch the actual bytes for a plan (satellite first, then photos). The returned
// signature reflects what ACTUALLY loaded (a failed fetch drops out), so the
// stored key is always truthful. Only runs once we've decided to (re)analyze.
export async function gatherImages(plan: ImagePlan, ctx: { lat: number | null; lng: number | null }): Promise<GatheredImages> {
  const images: VisionImage[] = []
  let satelliteUsed = false

  if (plan.satellitePlanned && ctx.lat != null && ctx.lng != null) {
    const sat = await fetchSatelliteImage(ctx.lat, ctx.lng)
    if (sat) {
      images.push({ label: 'Satellite aerial view (top-down, may be a few months old):', mediaType: sat.mediaType, dataBase64: sat.dataBase64 })
      satelliteUsed = true
    }
  }

  const usedPhotoIds: string[] = []
  for (const p of plan.photoPlan) {
    const img = await fetchRemoteImage(p.url)
    if (!img) continue
    images.push({ label: photoLabel(p, usedPhotoIds.length), mediaType: img.mediaType, dataBase64: img.dataBase64 })
    usedPhotoIds.push(p.id)
  }

  const source: IntelSource = satelliteUsed && usedPhotoIds.length ? 'combined' : satelliteUsed ? 'satellite' : 'photos'
  return { images, source, signature: signatureFor(satelliteUsed, usedPhotoIds), usedPhotoIds, satelliteUsed }
}

// ── Persistence ───────────────────────────────────────────────────────────────

function rowToIntelligence(row: Record<string, unknown>): PropertyIntelligence {
  return {
    id: row.id as string,
    created_at: row.created_at as string,
    updated_at: row.updated_at as string,
    user_id: row.user_id as string,
    property_id: row.property_id as string,
    customer_id: (row.customer_id as string | null) ?? null,
    job_id: (row.job_id as string | null) ?? null,
    source: row.source as IntelSource,
    image_count: (row.image_count as number) ?? 0,
    image_signature: (row.image_signature as string | null) ?? null,
    analysis: (row.analysis as VisionAnalysis) ?? ({} as VisionAnalysis),
    summary: (row.summary as string | null) ?? null,
    detections: ((row.detections as PropertyIntelligence['detections']) ?? []),
    upsell_keys: ((row.upsell_keys as string[]) ?? []),
    mowing_difficulty: (row.mowing_difficulty as PropertyIntelligence['mowing_difficulty']) ?? null,
    difficulty_score: (row.difficulty_score as number | null) ?? null,
    est_labour_min: (row.est_labour_min as number | null) ?? null,
    est_trimming_min: (row.est_trimming_min as number | null) ?? null,
    est_edging_ft: (row.est_edging_ft as number | null) ?? null,
    confidence: (row.confidence as number | null) ?? null,
    confidence_band: (row.confidence_band as PropertyIntelligence['confidence_band']) ?? null,
    model: (row.model as string | null) ?? null,
    prompt_version: (row.prompt_version as string | null) ?? null,
    status: row.status as PropertyIntelligence['status'],
    inputs: (row.inputs as PropertyIntelligence['inputs']) ?? [],
    observed_at: (row.observed_at as string | null) ?? null,
  }
}

// The latest ACTIVE analysis for a property (the current read), or null.
export async function latestForProperty(
  supabase: SupabaseClient,
  userId: string,
  propertyId: string,
): Promise<PropertyIntelligence | null> {
  const { data } = await supabase
    .from('property_intelligence')
    .select('*')
    .eq('user_id', userId)
    .eq('property_id', propertyId)
    .eq('status', 'active')
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle()
  return data ? rowToIntelligence(data as Record<string, unknown>) : null
}

// Persist a fresh analysis: supersede the prior active row(s) for this property,
// then insert the new active row with denormalised headline fields. Returns the
// stored row (mapped) or null if the insert failed.
// One described input that fed an analysis. OPEN `kind` so future modalities
// (drone, customer_upload, inspection_note, ndvi…) describe themselves here.
export interface AnalysisInput {
  kind: string                 // satellite | ground_photo | drone | customer_upload | …
  ref: string | null           // photo id / source label
  captured_at: string | null
}

export async function persistAnalysis(
  supabase: SupabaseClient,
  params: {
    userId: string
    propertyId: string
    customerId: string | null
    jobId: string | null
    source: IntelSource
    imageCount: number
    imageSignature: string
    inputs: AnalysisInput[]
    observedAt: string
    analysis: VisionAnalysis
    model: string
  },
): Promise<PropertyIntelligence | null> {
  const { analysis } = params
  // Inserting this active row atomically supersedes the prior active read — the
  // BEFORE INSERT trigger (migration RUN-2026-06-27-vision-active-integrity) does
  // it in the same statement, and a partial unique index guarantees exactly one
  // active per property. No separate (non-atomic) supersede step here.

  const detections = (analysis.detections || []).filter(d => d.present).map(d => d.key)
  const upsellKeys = (analysis.upsells || []).map(u => u.key)
  const row = {
    user_id: params.userId,
    property_id: params.propertyId,
    customer_id: params.customerId,
    job_id: params.jobId,
    source: params.source,
    image_count: params.imageCount,
    image_signature: params.imageSignature,
    inputs: params.inputs,
    observed_at: params.observedAt,
    analysis,
    summary: analysis.summary ?? null,
    detections,
    upsell_keys: upsellKeys,
    mowing_difficulty: analysis.estimates?.mowing_difficulty ?? null,
    difficulty_score: analysis.estimates?.difficulty_score ?? null,
    est_labour_min: analysis.estimates?.labour_minutes ?? null,
    est_trimming_min: analysis.estimates?.trimming_minutes ?? null,
    est_edging_ft: analysis.estimates?.edging_feet ?? null,
    confidence: analysis.confidence ?? null,
    confidence_band: confidenceBand(analysis.confidence),
    model: params.model,
    prompt_version: VISION_PROMPT_VERSION,
    status: 'active' as const,
  }
  const { data, error } = await supabase.from('property_intelligence').insert(row).select('*').single()
  if (error || !data) return null
  return rowToIntelligence(data as Record<string, unknown>)
}
