import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { enqueue, processJobNow } from '@/lib/marketing/publishQueue'
import type { ContentPiece, PublishResponse, SocialConnection } from '@/lib/marketing/types'

const CONN_COLS = 'id, created_at, updated_at, user_id, platform, provider, mode, account_id, account_name, account_url, avatar_url, status, meta'

// POST /api/marketing/publish — schedule or publish a content piece to a connected
// account. Idempotent: one job per (piece, account); an already-published post is never
// re-published. Manual connections return copy/open instructions; api connections (when
// a provider is live) dispatch directly and record the platform post id or the failure.
export async function POST(req: NextRequest): Promise<NextResponse> {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ ok: false, error: 'unauthorized' } satisfies PublishResponse, { status: 401 })

  const body = await req.json().catch(() => ({}))
  const pieceId = String(body.pieceId || '')
  const connectionId: string | null = typeof body.connectionId === 'string' ? body.connectionId : null
  const scheduledFor: string | null = typeof body.scheduledFor === 'string' && body.scheduledFor ? body.scheduledFor : null
  if (!pieceId) return NextResponse.json({ ok: false, error: 'bad request' } satisfies PublishResponse, { status: 400 })

  const { data: pieceRow } = await supabase.from('content_pieces').select('*').eq('id', pieceId).eq('user_id', user.id).maybeSingle()
  const piece = pieceRow as ContentPiece | null
  if (!piece) return NextResponse.json({ ok: false, error: 'post not found' } satisfies PublishResponse, { status: 404 })

  let connection: SocialConnection | null = null
  if (connectionId) {
    const { data } = await supabase.from('social_connections').select(CONN_COLS).eq('id', connectionId).eq('user_id', user.id).maybeSingle()
    connection = (data as SocialConnection | null) ?? null
    if (!connection) return NextResponse.json({ ok: false, error: 'account not found' } satisfies PublishResponse, { status: 404 })
    if (connection.platform !== piece.channel) return NextResponse.json({ ok: false, error: 'account is for a different platform' } satisfies PublishResponse, { status: 400 })
  }

  let enqueued
  try {
    enqueued = await enqueue(supabase, user.id, { piece, connection, scheduledFor })
  } catch {
    return NextResponse.json({ ok: false, error: 'Publishing isn’t set up yet — run the social-publishing migration.' } satisfies PublishResponse, { status: 503 })
  }
  if (!enqueued.job) return NextResponse.json({ ok: false, error: 'could not queue the post' } satisfies PublishResponse, { status: 500 })
  if (enqueued.alreadyPublished) return NextResponse.json({ ok: true, job: enqueued.job } satisfies PublishResponse)

  // Scheduled → leave it in the queue and reflect it on the post.
  if (scheduledFor) {
    await supabase.from('content_pieces').update({ status: 'scheduled', scheduled_for: scheduledFor }).eq('id', piece.id)
    return NextResponse.json({ ok: true, job: enqueued.job } satisfies PublishResponse)
  }

  // Publish now.
  const { job, manual } = await processJobNow(supabase, user.id, { job: enqueued.job, piece, connection })
  return NextResponse.json({ ok: job.status !== 'failed', job, manual } satisfies PublishResponse)
}
