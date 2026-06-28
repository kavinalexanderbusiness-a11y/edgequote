import type { SupabaseClient } from '@supabase/supabase-js'

// ── Before/After: job resolution + auto-pairing ──────────────────────────────────
// Two reuse-only helpers, no new storage:
//  • resolveTargetJob — "which job do these photos belong to?" Prefers an explicit
//    job, else the single active/recent job on the property; asks only when genuinely
//    ambiguous (req: don't guess when unsure).
//  • ensurePair — once a property+job has a before AND an after, record it in the
//    SHARED `marketing_assets` table so Marketing Studio (and everything else that
//    reads it) knows immediately. Idempotent on (user_id, job_id): it never recreates
//    a pair and never clobbers an owner's status or an AI rationale. Best-effort —
//    a missing/unmigrated table never blocks the upload.

export interface JobRow {
  id: string
  title: string | null
  service_type: string | null
  scheduled_date: string | null
  completed_at: string | null
  status: string | null
  customer_id: string | null
  property_id: string | null
}

export interface ResolvedJob {
  jobId: string | null
  job: JobRow | null
  candidates: JobRow[]   // populated when ambiguous, so the UI can let the owner pick
  needsAsk: boolean      // true → more than one plausible job; ask instead of guessing
}

const RECENT_MS = 3 * 24 * 60 * 60 * 1000 // a visit you'd still be photographing

function isOpen(s: string | null): boolean {
  const v = (s || '').toLowerCase()
  return v !== '' && v !== 'completed' && v !== 'cancelled' && v !== 'canceled'
}
function isRecentlyCompleted(j: JobRow, nowMs: number): boolean {
  const t = j.completed_at ? Date.parse(j.completed_at) : NaN
  return Number.isFinite(t) && nowMs - t <= RECENT_MS
}

export async function resolveTargetJob(
  supabase: SupabaseClient,
  userId: string,
  propertyId: string | null,
  explicitJobId: string | null | undefined,
  nowMs: number,
): Promise<ResolvedJob> {
  const sel = 'id,title,service_type,scheduled_date,completed_at,status,customer_id,property_id'

  // Opened from a specific job → always that job (req: auto-attach to the open job).
  if (explicitJobId) {
    const { data } = await supabase.from('jobs').select(sel).eq('user_id', userId).eq('id', explicitJobId).maybeSingle()
    return { jobId: explicitJobId, job: (data as JobRow) || null, candidates: [], needsAsk: false }
  }
  if (!propertyId) return { jobId: null, job: null, candidates: [], needsAsk: false }

  const { data } = await supabase.from('jobs').select(sel)
    .eq('user_id', userId).eq('property_id', propertyId)
    .order('scheduled_date', { ascending: false }).limit(25)
  const jobs = ((data as JobRow[]) || []).filter(j => (j.status || '').toLowerCase() !== 'cancelled')
  if (!jobs.length) return { jobId: null, job: null, candidates: [], needsAsk: false }

  // The "obvious" job: open right now or completed in the last few days.
  const active = jobs.filter(j => isOpen(j.status) || isRecentlyCompleted(j, nowMs))
  if (active.length === 1) return { jobId: active[0].id, job: active[0], candidates: [], needsAsk: false }
  if (active.length === 0 && jobs.length === 1) return { jobId: jobs[0].id, job: jobs[0], candidates: [], needsAsk: false }

  // Ambiguous → ask, offering the most relevant jobs first.
  const candidates = (active.length ? active : jobs).slice(0, 8)
  return { jobId: null, job: null, candidates, needsAsk: candidates.length > 1 }
}

// ── deterministic marketing_assets materialization ──────────────────────────────
const VISUAL_HINTS = ['mow', 'lawn', 'landscap', 'cleanup', 'clean-up', 'clean up', 'leaf', 'leaves', 'snow', 'plow', 'mulch', 'trim', 'hedge', 'garden', 'aerat', 'overseed', 'sod', 'pressure', 'power wash', 'gutter', 'edg', 'weed', 'rock']
function deterministicScore(serviceType: string | null, completedAt: string | null, nowMs: number): number {
  let score = 55
  const s = (serviceType || '').toLowerCase()
  if (VISUAL_HINTS.some(h => s.includes(h))) score += 15
  const t = completedAt ? Date.parse(completedAt) : NaN
  if (Number.isFinite(t) && nowMs - t <= 30 * 86_400_000) score += 10
  return Math.max(0, Math.min(100, score))
}
function seasonOf(iso: string | null, nowMs: number): string {
  const d = iso ? new Date(iso) : new Date(nowMs)
  const m = d.getMonth()
  if (m >= 2 && m <= 4) return 'spring'
  if (m >= 5 && m <= 7) return 'summer'
  if (m >= 8 && m <= 10) return 'fall'
  return 'winter'
}

export interface EnsurePairInput {
  userId: string
  job: JobRow
  beforePhotoId: string
  afterPhotoId: string
  neighborhood?: string | null
}

// Record (or top up) the before/after pair in marketing_assets. Returns true if a
// row now exists. Never recreates: if a row is already there we only fill gaps
// (has_before/after, best ids when still null) and leave status / ai_rationale alone.
export async function ensurePair(
  supabase: SupabaseClient,
  input: EnsurePairInput,
  nowMs: number,
): Promise<boolean> {
  const { userId, job } = input
  try {
    const { data: existing, error } = await supabase
      .from('marketing_assets')
      .select('id,has_before,has_after,best_before_photo_id,best_after_photo_id')
      .eq('user_id', userId).eq('job_id', job.id).maybeSingle()
    if (error) return false // table absent / not migrated — caller degrades gracefully

    if (existing) {
      const patch: Record<string, unknown> = {}
      if (!existing.has_before) patch.has_before = true
      if (!existing.has_after) patch.has_after = true
      if (!existing.best_before_photo_id) patch.best_before_photo_id = input.beforePhotoId
      if (!existing.best_after_photo_id) patch.best_after_photo_id = input.afterPhotoId
      if (Object.keys(patch).length) await supabase.from('marketing_assets').update(patch).eq('id', existing.id)
      return true
    }

    await supabase.from('marketing_assets').insert({
      user_id: userId,
      job_id: job.id,
      customer_id: job.customer_id ?? null,
      property_id: job.property_id ?? null,
      service_type: job.service_type ?? null,
      neighborhood: input.neighborhood ?? null,
      season: seasonOf(job.completed_at ?? job.scheduled_date ?? null, nowMs),
      quality_score: deterministicScore(job.service_type, job.completed_at, nowMs),
      has_before: true,
      has_after: true,
      best_before_photo_id: input.beforePhotoId,
      best_after_photo_id: input.afterPhotoId,
      status: 'candidate',
    })
    return true
  } catch {
    return false
  }
}
