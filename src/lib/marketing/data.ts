import type { SupabaseClient } from '@supabase/supabase-js'
import { PHOTO_BUCKET } from '@/lib/photos'
import { scoreCandidate, type ScoreCustomer, type ScoreProperty, type ScorePhoto } from './score'
import type { MarketingCandidate } from './types'

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
