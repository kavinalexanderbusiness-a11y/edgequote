import type { SupabaseClient } from '@supabase/supabase-js'
import { channel as channelDef } from './channels'
import { dispatchPublish, effectiveMode, provider, ProviderError } from './providers'
import type { ContentPiece, PublishJob, PublishJobStatus, SocialConnection } from './types'

// ── Publish queue ───────────────────────────────────────────────────────────────────
// The publishing lifecycle over public.publish_jobs:
//   draft → scheduled → queued → publishing → published / failed (→ retry).
// A UNIQUE idempotency_key (piece + connection) is the hard guarantee against duplicate
// posts. Reads are defensive (empty if not yet migrated). The actual platform dispatch
// (processJobNow) runs server-side; everything else is client-safe (RLS-scoped writes).

const nowISO = () => new Date().toISOString()

export function idempotencyKey(pieceId: string, connectionId: string | null): string {
  return `${pieceId}:${connectionId ?? 'manual'}`
}

export function captionFor(piece: Pick<ContentPiece, 'body' | 'hashtags'>): string {
  return [piece.body?.trim(), (piece.hashtags || []).map(h => `#${h.replace(/^#/, '')}`).join(' ')].filter(Boolean).join('\n\n')
}

// ── Reads ──
export async function listJobs(supabase: SupabaseClient, userId: string, opts?: { statuses?: PublishJobStatus[]; limit?: number }): Promise<PublishJob[]> {
  try {
    let q = supabase.from('publish_jobs').select('*').eq('user_id', userId)
    if (opts?.statuses?.length) q = q.in('status', opts.statuses)
    const { data } = await q.order('created_at', { ascending: false }).limit(opts?.limit ?? 100)
    return (data as PublishJob[] | null) || []
  } catch { return [] }
}

export async function listJobsForPiece(supabase: SupabaseClient, userId: string, pieceId: string): Promise<PublishJob[]> {
  try {
    const { data } = await supabase.from('publish_jobs').select('*').eq('user_id', userId).eq('content_piece_id', pieceId).order('created_at', { ascending: false })
    return (data as PublishJob[] | null) || []
  } catch { return [] }
}

export async function getJobByKey(supabase: SupabaseClient, userId: string, key: string): Promise<PublishJob | null> {
  const { data } = await supabase.from('publish_jobs').select('*').eq('user_id', userId).eq('idempotency_key', key).maybeSingle()
  return (data as PublishJob | null) ?? null
}

async function patchJob(supabase: SupabaseClient, id: string, patch: Record<string, unknown>): Promise<PublishJob | null> {
  const { data } = await supabase.from('publish_jobs').update(patch).eq('id', id).select('*').maybeSingle()
  return (data as PublishJob | null) ?? null
}

async function syncPieceStatus(supabase: SupabaseClient, pieceId: string, status: string, extra?: Record<string, unknown>) {
  await supabase.from('content_pieces').update({ status, ...extra }).eq('id', pieceId)
}

// ── Enqueue (idempotent) ──
// One job per (piece, connection). Re-enqueuing re-arms a scheduled/failed job; an
// already-PUBLISHED job is returned untouched (never re-publish → never duplicate).
export async function enqueue(
  supabase: SupabaseClient,
  userId: string,
  args: { piece: Pick<ContentPiece, 'id' | 'channel'>; connection: SocialConnection | null; scheduledFor: string | null },
): Promise<{ job: PublishJob | null; alreadyPublished: boolean }> {
  const key = idempotencyKey(args.piece.id, args.connection?.id ?? null)
  const existing = await getJobByKey(supabase, userId, key)
  if (existing && existing.status === 'published') return { job: existing, alreadyPublished: true }

  const mode = effectiveMode(args.piece.channel, args.connection?.mode)
  const status: PublishJobStatus = args.scheduledFor ? 'scheduled' : 'queued'
  const { data } = await supabase.from('publish_jobs').upsert({
    user_id: userId,
    content_piece_id: args.piece.id,
    connection_id: args.connection?.id ?? null,
    platform: args.piece.channel,
    mode,
    status,
    scheduled_for: args.scheduledFor ?? null,
    error: null,
    idempotency_key: key,
  }, { onConflict: 'idempotency_key' }).select('*').maybeSingle()
  return { job: (data as PublishJob | null) ?? null, alreadyPublished: false }
}

// ── Rate limit (per connected account) ──
export async function rateLimitOk(supabase: SupabaseClient, userId: string, connectionId: string | null, ch: PublishJob['platform']): Promise<{ ok: boolean; reason?: string }> {
  if (!connectionId) return { ok: true }
  const rl = provider(ch).rateLimit
  const since = new Date(Date.now() - 3_600_000).toISOString()
  try {
    const { data } = await supabase.from('publish_jobs').select('published_at')
      .eq('user_id', userId).eq('connection_id', connectionId).eq('status', 'published').gte('published_at', since)
    const recent = ((data as { published_at: string }[] | null) || []).map(r => new Date(r.published_at).getTime())
    if (recent.length >= rl.perHour) return { ok: false, reason: `Rate limit reached (${rl.perHour}/hour for this account). It’ll go out later.` }
    const last = recent.sort((a, b) => b - a)[0]
    if (last && (Date.now() - last) / 1000 < rl.minSpacingSec) return { ok: false, reason: `Too soon — ${rl.minSpacingSec}s minimum between posts to this account.` }
    return { ok: true }
  } catch { return { ok: true } }
}

// ── Process now (server-side dispatch) ──
// Manual → mark 'queued' (ready to post) + return copy/open instructions. API → publish
// through the provider, recording the external id / failure on the job + the piece.
export async function processJobNow(
  supabase: SupabaseClient,
  userId: string,
  args: { job: PublishJob; piece: ContentPiece; connection: SocialConnection | null },
): Promise<{ job: PublishJob; manual?: { openUrl: string; caption: string } }> {
  const { job, piece, connection } = args
  const mode = effectiveMode(piece.channel, connection?.mode)
  const caption = captionFor(piece)
  const openUrl = channelDef(piece.channel).openUrl

  if (mode === 'manual') {
    const updated = (await patchJob(supabase, job.id, { status: 'queued', mode: 'manual' })) ?? job
    return { job: updated, manual: { openUrl, caption } }
  }

  const rl = await rateLimitOk(supabase, userId, job.connection_id, piece.channel)
  if (!rl.ok) {
    const failed = (await patchJob(supabase, job.id, { status: 'failed', error: rl.reason, last_attempt_at: nowISO() })) ?? job
    return { job: failed }
  }

  await patchJob(supabase, job.id, { status: 'publishing', attempts: (job.attempts || 0) + 1, last_attempt_at: nowISO() })
  try {
    const res = await dispatchPublish(piece.channel, {
      piece: { title: piece.title, body: piece.body, hashtags: piece.hashtags, imageUrl: null },
      account: { id: connection?.account_id ?? null, name: connection?.account_name ?? '' },
    })
    const done = (await patchJob(supabase, job.id, {
      status: 'published', published_at: nowISO(), external_post_id: res.externalId, external_url: res.url, error: null,
    })) ?? job
    await syncPieceStatus(supabase, piece.id, 'published', { published_at: nowISO(), external_ref: res.externalId })
    return { job: done }
  } catch (e) {
    const msg = e instanceof ProviderError ? e.message : e instanceof Error ? e.message : 'publish failed'
    const failed = (await patchJob(supabase, job.id, { status: 'failed', error: msg })) ?? job
    await syncPieceStatus(supabase, piece.id, 'failed')
    return { job: failed }
  }
}

// ── Owner actions (client-safe, RLS-scoped) ──
export async function retryJob(supabase: SupabaseClient, id: string): Promise<PublishJob | null> {
  return patchJob(supabase, id, { status: 'queued', error: null })
}
export async function cancelJob(supabase: SupabaseClient, id: string): Promise<PublishJob | null> {
  return patchJob(supabase, id, { status: 'canceled' })
}
// Manual completion: the owner pasted + posted → record it (never re-publishes).
export async function markManualPublished(supabase: SupabaseClient, job: PublishJob, externalUrl?: string | null): Promise<PublishJob | null> {
  const updated = await patchJob(supabase, job.id, { status: 'published', mode: 'manual', published_at: nowISO(), external_url: externalUrl ?? null })
  await syncPieceStatus(supabase, job.content_piece_id, 'published', { published_at: nowISO() })
  return updated
}
export async function clearHistory(supabase: SupabaseClient, userId: string): Promise<void> {
  await supabase.from('publish_jobs').delete().eq('user_id', userId).in('status', ['published', 'failed', 'canceled'])
}
