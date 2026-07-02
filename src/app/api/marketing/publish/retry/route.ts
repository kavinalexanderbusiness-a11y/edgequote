import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { processJobNow, retryJob } from '@/lib/marketing/publishQueue'
import type { ContentPiece, PublishJob, PublishResponse, SocialConnection } from '@/lib/marketing/types'

const CONN_COLS = 'id, created_at, updated_at, user_id, platform, provider, mode, account_id, account_name, account_url, avatar_url, status, meta'

// POST /api/marketing/publish/retry — re-arm a failed job and run it again. Reuses the
// SAME job (idempotency_key unchanged), so a retry never creates a duplicate post.
export async function POST(req: NextRequest): Promise<NextResponse> {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ ok: false, error: 'unauthorized' } satisfies PublishResponse, { status: 401 })

  const body = await req.json().catch(() => ({}))
  const jobId = String(body.jobId || '')
  if (!jobId) return NextResponse.json({ ok: false, error: 'bad request' } satisfies PublishResponse, { status: 400 })

  const { data: jobRow } = await supabase.from('publish_jobs').select('*').eq('id', jobId).eq('user_id', user.id).maybeSingle()
  const existing = jobRow as PublishJob | null
  if (!existing) return NextResponse.json({ ok: false, error: 'job not found' } satisfies PublishResponse, { status: 404 })
  if (existing.status === 'published') return NextResponse.json({ ok: true, job: existing } satisfies PublishResponse)
  if (existing.attempts >= existing.max_attempts) {
    return NextResponse.json({ ok: false, error: `Reached the retry limit (${existing.max_attempts}). Publish manually instead.`, job: existing } satisfies PublishResponse, { status: 429 })
  }

  const { data: pieceRow } = await supabase.from('content_pieces').select('*').eq('id', existing.content_piece_id).eq('user_id', user.id).maybeSingle()
  const piece = pieceRow as ContentPiece | null
  if (!piece) return NextResponse.json({ ok: false, error: 'post not found' } satisfies PublishResponse, { status: 404 })

  let connection: SocialConnection | null = null
  if (existing.connection_id) {
    const { data } = await supabase.from('social_connections').select(CONN_COLS).eq('id', existing.connection_id).eq('user_id', user.id).maybeSingle()
    connection = (data as SocialConnection | null) ?? null
  }

  const rearmed = (await retryJob(supabase, existing.id)) ?? existing
  const { job, manual } = await processJobNow(supabase, user.id, { job: rearmed, piece, connection })
  return NextResponse.json({ ok: job.status !== 'failed', job, manual } satisfies PublishResponse)
}
