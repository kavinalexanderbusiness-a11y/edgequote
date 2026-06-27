import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { aiEnabled } from '@/lib/ai/anthropic'
import { analyzeImages } from '@/lib/ai/vision'
import { listPhotos } from '@/lib/photos'
import { gatherImages, latestForProperty, persistAnalysis, planImageSet, type AnalysisInput, type AnalyzablePhoto } from '@/lib/vision/data'
import { satelliteConfigured } from '@/lib/vision/staticMap'
import { checkAnalyzeAllowed } from '@/lib/vision/rateLimit'
import { buildAnalysisPrompt } from '@/lib/vision/prompt'
import { updateTwinAfterAnalysis } from '@/lib/vision/intelligence'
import { getTwin } from '@/lib/vision/twin'
import type { AnalyzeResponse, VisionAnalysis } from '@/lib/vision/types'
import type { MeasurementSnapshot } from '@/types'

// AI Vision — analyse one property's imagery (satellite + uploaded photos) and
// store a structured, durable read. Recommendations only: this NEVER writes a
// price, quote, job or invoice — it inserts a property_intelligence row the owner
// (and future AI tools) can read. The owner's session scopes every read/write
// (RLS). The model is only ever called when the image set actually changed (or
// force=true), so re-opening a property is free.

export const runtime = 'nodejs'        // needs Buffer + server-side image fetch
export const maxDuration = 60          // vision over several images can take a while
export const dynamic = 'force-dynamic'

function json(body: AnalyzeResponse, status = 200) {
  return NextResponse.json(body, { status })
}

export async function POST(req: NextRequest): Promise<NextResponse> {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return json({ ok: false, aiEnabled: aiEnabled(), error: 'unauthorized' }, 401)

  const body = await req.json().catch(() => ({}))
  const propertyId = String(body.propertyId || '')
  if (!propertyId) return json({ ok: false, aiEnabled: aiEnabled(), error: 'bad request' }, 400)
  const includeSatellite = body.includeSatellite !== false
  const force = body.force === true
  const jobId: string | null = body.jobId ? String(body.jobId) : null
  const photoIds: string[] | null = Array.isArray(body.photoIds) && body.photoIds.length ? body.photoIds.map(String) : null

  if (!aiEnabled()) return json({ ok: false, aiEnabled: false, error: 'AI is not configured yet.' })

  // Property + photos are independent reads — fetch them together (RLS-scoped).
  const [propRes, allPhotos] = await Promise.all([
    supabase
      .from('properties')
      .select('id, customer_id, address, city, neighborhood, lat, lng, lawn_sqft, measurement_history')
      .eq('id', propertyId)
      .maybeSingle(),
    listPhotos(supabase, user.id, { propertyId }),
  ])
  if (!propRes.data) return json({ ok: false, aiEnabled: true, error: 'property not found' }, 404)
  const property = propRes.data as {
    id: string; customer_id: string | null; address: string | null; city: string | null
    neighborhood: string | null; lat: number | null; lng: number | null
    lawn_sqft: number | null; measurement_history: MeasurementSnapshot[] | null
  }

  // Photos for this property (or the requested subset).
  const chosen = photoIds ? allPhotos.filter(p => photoIds.includes(p.id)) : allPhotos
  const photos: AnalyzablePhoto[] = chosen.map(p => ({
    id: p.id, url: p.url, kind: p.kind, caption: p.caption, taken_at: p.taken_at,
  }))

  // Decide WHICH imagery this run covers — without downloading anything yet.
  const plan = planImageSet({ lat: property.lat, lng: property.lng, includeSatellite, satelliteAvailable: satelliteConfigured(), photos })
  if (!plan.satellitePlanned && !plan.photoPlan.length) {
    return json({ ok: false, aiEnabled: true, error: 'No imagery to analyze. Add a photo, or set the property location so the satellite view is available.' }, 422)
  }

  // Reuse: if the imagery is identical to the last analysis, return it + the twin
  // with NO model call AND no image downloads — the twin already reflects this
  // read. This is the common re-open case, so it must be cheap.
  if (!force) {
    const latest = await latestForProperty(supabase, user.id, propertyId)
    if (latest && latest.image_signature === plan.signature) {
      const twin = await getTwin(supabase, user.id, propertyId)
      return json({ ok: true, aiEnabled: true, intelligence: latest, twin: twin ?? undefined, reused: true })
    }
  }

  // We're now on the BILLED path (a real model call). Enforce cost/abuse limits
  // here only — cache hits above returned for free and were never limited.
  const gate = await checkAnalyzeAllowed(supabase, user.id, propertyId)
  if (!gate.allowed) return json({ ok: false, aiEnabled: true, error: gate.message }, 429)

  // Changed (or forced): now pay to download the bytes and (re)analyze.
  const gathered = await gatherImages(plan, { lat: property.lat, lng: property.lng })
  if (!gathered.images.length) {
    return json({ ok: false, aiEnabled: true, error: 'No imagery could be loaded. Check the photos or property location and try again.' }, 422)
  }

  // Lawn size to anchor the labour estimate: stored field, else newest measurement.
  const newestSnap = (property.measurement_history || []).slice().sort((a, b) => (b.date || '').localeCompare(a.date || ''))[0]
  const lawnSqft = property.lawn_sqft ?? newestSnap?.total_sqft ?? null

  const input = buildAnalysisPrompt({
    address: property.address,
    neighborhood: property.neighborhood,
    city: property.city,
    lawnSqft,
    imageLabels: gathered.images.map(i => i.label),
  })

  const result = await analyzeImages<VisionAnalysis>({
    system: input.system,
    prompt: input.prompt,
    images: gathered.images,
    toolName: input.toolName,
    toolDescription: input.toolDescription,
    schema: input.schema,
  })
  if (!result.ok) {
    return json({ ok: false, aiEnabled: true, error: result.error || 'analysis failed' }, 502)
  }

  // Capture time = newest photo in the set (when it's ABOUT), else now.
  const usedPhotos = photos.filter(p => gathered.usedPhotoIds.includes(p.id))
  const nowIso = new Date().toISOString()
  const observedAt = usedPhotos.map(p => p.taken_at).filter(Boolean).sort().slice(-1)[0] || nowIso
  const inputs: AnalysisInput[] = [
    ...(gathered.satelliteUsed ? [{ kind: 'satellite', ref: 'static-maps', captured_at: nowIso }] : []),
    ...usedPhotos.map(p => ({ kind: 'ground_photo', ref: p.id, captured_at: p.taken_at ?? null })),
  ]

  const intelligence = await persistAnalysis(supabase, {
    userId: user.id,
    propertyId,
    customerId: property.customer_id,
    jobId,
    source: gathered.source,
    imageCount: gathered.images.length,
    imageSignature: gathered.signature,
    inputs,
    observedAt,
    analysis: result.data,
    model: result.model,
  })
  if (!intelligence) return json({ ok: false, aiEnabled: true, error: 'could not save analysis' }, 500)

  // Evolve the digital twin: emit observations, detect change vs prior, recompute
  // seasonal/forecast/opportunities/marketing/CRM, materialize. Best-effort — a
  // twin hiccup never fails the analysis the owner just paid for.
  const twin = await updateTwinAfterAnalysis(supabase, {
    userId: user.id,
    property: { id: property.id, customer_id: property.customer_id, lat: property.lat, lng: property.lng, lawn_sqft: lawnSqft },
    intelligence,
    observedAt,
    hasBeforeAfter: usedPhotos.some(p => p.kind === 'before') && usedPhotos.some(p => p.kind === 'after'),
    nowIso,
  })

  return json({ ok: true, aiEnabled: true, intelligence, twin: twin ?? undefined, reused: false })
}
