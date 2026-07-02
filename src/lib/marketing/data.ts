import type { SupabaseClient } from '@supabase/supabase-js'
import { PHOTO_BUCKET } from '@/lib/photos'
import { scoreCandidate, seasonOf, type ScoreCustomer, type ScoreProperty, type ScorePhoto } from './score'
import { deriveBrandVoice, type BrandSource, type BrandVoice } from './brandVoice'
import type { ContentPiece, MarketingCandidate, MarketingChannel, Season } from './types'

// The owner's brand voice, loaded once from business_settings. Shared by every
// generate route so the "who is this business" read lives in one place.
export async function loadBrandVoice(supabase: SupabaseClient, userId: string): Promise<BrandVoice> {
  const { data } = await supabase.from('business_settings')
    .select('company_name, owner_name, phone, website, email_primary, base_address, review_url')
    .eq('user_id', userId).maybeSingle()
  return deriveBrandVoice(data as BrandSource | null)
}

// ── Marketing data layer ────────────────────────────────────────────────────────
// Assembles scored MarketingCandidates from the data the app already holds — jobs,
// job_photos, properties, customers. Works with ANY Supabase client (the browser
// client on the Studio/Library pages, the server client in the generate route), so
// the "what's postable" logic lives in exactly one place. All reads are RLS-scoped
// to the owner; we still pass user_id explicitly to match the rest of the app.

function publicUrl(supabase: SupabaseClient, path: string): string {
  return supabase.storage.from(PHOTO_BUCKET).getPublicUrl(path).data.publicUrl
}

interface JobRow {
  id: string
  service_type: string | null
  scheduled_date: string | null
  completed_at: string | null
  customer_id: string | null
  property_id: string | null
}
interface PhotoRow {
  id: string
  job_id: string | null
  kind: 'before' | 'after' | 'general'
  storage_path: string
}

const nonNull = (arr: (string | null)[]): string[] =>
  Array.from(new Set(arr.filter((v): v is string => !!v)))

async function loadMaps(supabase: SupabaseClient, userId: string, jobs: JobRow[]) {
  const customerIds = nonNull(jobs.map(j => j.customer_id))
  const propertyIds = nonNull(jobs.map(j => j.property_id))
  const jobIds = jobs.map(j => j.id)

  const [custRes, propRes, photoRes] = await Promise.all([
    customerIds.length
      ? supabase.from('customers').select('id, name, reviewed_at, photo_marketing_consent').eq('user_id', userId).in('id', customerIds)
      : Promise.resolve({ data: [] as ScoreCustomer[] }),
    propertyIds.length
      ? supabase.from('properties').select('id, neighborhood, city, lawn_sqft').eq('user_id', userId).in('id', propertyIds)
      : Promise.resolve({ data: [] as ScoreProperty[] }),
    jobIds.length
      ? supabase.from('job_photos').select('id, job_id, kind, storage_path').eq('user_id', userId).in('job_id', jobIds).order('taken_at', { ascending: false })
      : Promise.resolve({ data: [] as PhotoRow[] }),
  ])

  const custById = new Map<string, ScoreCustomer>()
  for (const c of (custRes.data as ScoreCustomer[] | null) || []) custById.set(c.id, c)
  const propById = new Map<string, ScoreProperty>()
  for (const p of (propRes.data as ScoreProperty[] | null) || []) propById.set(p.id, p)
  // Photos grouped by job, already newest-first from the query order.
  const photosByJob = new Map<string, ScorePhoto[]>()
  for (const ph of (photoRes.data as PhotoRow[] | null) || []) {
    if (!ph.job_id) continue
    const list = photosByJob.get(ph.job_id) || []
    list.push({ id: ph.id, kind: ph.kind, url: publicUrl(supabase, ph.storage_path) })
    photosByJob.set(ph.job_id, list)
  }
  return { custById, propById, photosByJob }
}

function toCandidate(
  job: JobRow,
  maps: { custById: Map<string, ScoreCustomer>; propById: Map<string, ScoreProperty>; photosByJob: Map<string, ScorePhoto[]> },
): MarketingCandidate {
  return scoreCandidate({
    job,
    customer: job.customer_id ? maps.custById.get(job.customer_id) ?? null : null,
    property: job.property_id ? maps.propById.get(job.property_id) ?? null : null,
    photos: maps.photosByJob.get(job.id) || [],
  })
}

// All postable completed jobs, scored and ranked best-first. Bounded to the most
// recent 200 completed jobs (the marketing-relevant window).
export async function listCandidates(supabase: SupabaseClient, userId: string): Promise<MarketingCandidate[]> {
  const { data } = await supabase
    .from('jobs')
    .select('id, service_type, scheduled_date, completed_at, customer_id, property_id')
    .eq('user_id', userId)
    .eq('status', 'completed')
    .order('completed_at', { ascending: false, nullsFirst: false })
    .limit(200)
  const jobs = (data as JobRow[] | null) || []
  if (!jobs.length) return []
  const maps = await loadMaps(supabase, userId, jobs)
  return jobs.map(j => toCandidate(j, maps)).sort((a, b) => b.score - a.score)
}

// One scored candidate for a single job (the generate route's context source).
export async function assembleCandidate(supabase: SupabaseClient, userId: string, jobId: string): Promise<MarketingCandidate | null> {
  const { data } = await supabase
    .from('jobs')
    .select('id, service_type, scheduled_date, completed_at, customer_id, property_id')
    .eq('user_id', userId)
    .eq('id', jobId)
    .maybeSingle()
  const job = data as JobRow | null
  if (!job) return null
  const maps = await loadMaps(supabase, userId, [job])
  return toCandidate(job, maps)
}

export interface DraftInput {
  title?: string | null
  body: string
  hashtags: string[]
  model: string | null
  promptVersion: string
  meta?: Record<string, unknown>   // e.g. the PostOptions the draft was generated with
  season?: Season | null           // defaults to the candidate's season
  campaignId?: string | null       // set when generated as part of a campaign
}

// Upsert the marketing_assets anchor (idempotent, one per job; status stays
// 'candidate' until published). Returns the asset id, or null on failure. Split out
// of persistDraft so a batch generate ("all platforms") upserts the anchor ONCE
// instead of racing six identical upserts on the same (user_id, job_id).
export async function upsertAsset(
  supabase: SupabaseClient,
  userId: string,
  candidate: MarketingCandidate,
): Promise<string | null> {
  const { data: assetRow } = await supabase.from('marketing_assets')
    .upsert({
      user_id: userId,
      job_id: candidate.jobId,
      customer_id: candidate.customerId,
      property_id: candidate.propertyId,
      service_type: candidate.serviceType,
      neighborhood: candidate.neighborhood,
      season: seasonOf(candidate.date),
      quality_score: candidate.score,
      has_before: candidate.hasBefore,
      has_after: candidate.hasAfter,
      best_before_photo_id: candidate.bestBeforePhotoId,
      best_after_photo_id: candidate.bestAfterPhotoId,
      ai_rationale: candidate.rationale,
    }, { onConflict: 'user_id,job_id' })
    .select('id').maybeSingle()
  return (assetRow as { id: string } | null)?.id ?? null
}

// What a piece hangs off — a finished job, or nothing (a themed campaign post). A
// MarketingCandidate is structurally a valid anchor, so existing callers pass it as-is.
export interface PieceAnchor {
  jobId: string | null
  customerId: string | null
  date?: string | null
}

// Insert one content_pieces draft row for a channel under an already-upserted asset.
export async function insertPiece(
  supabase: SupabaseClient,
  userId: string,
  anchor: PieceAnchor,
  channel: MarketingChannel,
  assetId: string | null,
  draft: DraftInput,
): Promise<ContentPiece | null> {
  const hashtags = draft.hashtags.map(h => String(h).replace(/^#/, '').trim()).filter(Boolean).slice(0, 8)
  const meta = draft.meta ?? {}
  const { data: pieceRow } = await supabase.from('content_pieces')
    .insert({
      user_id: userId,
      asset_id: assetId,
      job_id: anchor.jobId,
      customer_id: anchor.customerId,
      channel,
      kind: 'organic',
      title: draft.title?.trim() || null,
      body: draft.body.trim(),
      hashtags,
      status: 'draft',
      model: draft.model,
      prompt_version: draft.promptVersion,
      season: draft.season ?? seasonOf(anchor.date ?? null),
      campaign_id: draft.campaignId ?? null,
      meta,
    })
    .select('*').single()
  return (pieceRow as ContentPiece | null) ?? null
}

// Persist a single generated draft: upsert the asset anchor + insert the piece.
// Shared by the streaming and non-streaming generate routes so the one-channel write
// path lives in one place. Returns the saved piece, or null on failure.
export async function persistDraft(
  supabase: SupabaseClient,
  userId: string,
  candidate: MarketingCandidate,
  channel: MarketingChannel,
  draft: DraftInput,
): Promise<ContentPiece | null> {
  const assetId = await upsertAsset(supabase, userId, candidate)
  return insertPiece(supabase, userId, candidate, channel, assetId, draft)
}
