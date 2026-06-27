import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'
import { processJobNow } from '@/lib/marketing/publishQueue'
import type { ContentPiece, PublishJob, SocialConnection } from '@/lib/marketing/types'

export const dynamic = 'force-dynamic'

// Scheduled publishing processor (Vercel Cron → vercel.json). Picks up due jobs and
// drives them: api jobs publish through their provider (recording the post id or the
// failure); manual scheduled jobs flip to 'queued' so they surface as "ready to post".
// Fully guarded: requires CRON_SECRET, needs the service-role key to act across owners,
// and no-ops cleanly when either is missing. Idempotency_key + status gating mean a job
// is never double-published.
export async function GET(req: NextRequest): Promise<NextResponse> {
  const secret = req.headers.get('authorization')?.replace('Bearer ', '') || new URL(req.url).searchParams.get('secret') || ''
  if (!process.env.CRON_SECRET || secret !== process.env.CRON_SECRET) {
    return NextResponse.json({ error: 'forbidden' }, { status: 403 })
  }
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL, svc = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!url || !svc) return NextResponse.json({ ok: true, skipped: true, note: 'Set SUPABASE_SERVICE_ROLE_KEY to process the publishing queue.' })
  const supabase = createClient(url, svc)

  const now = new Date().toISOString()
  let jobs: PublishJob[] = []
  try {
    const { data } = await supabase.from('publish_jobs').select('*')
      .in('status', ['scheduled', 'queued'])
      .or(`scheduled_for.is.null,scheduled_for.lte.${now}`)
      .order('scheduled_for', { ascending: true })
      .limit(50)
    jobs = (data as PublishJob[] | null) || []
  } catch {
    return NextResponse.json({ ok: true, skipped: true, note: 'Publishing tables not migrated yet.' })
  }

  let published = 0, ready = 0, failed = 0
  for (const job of jobs) {
    // Manual jobs can't auto-post — when their schedule arrives, surface them as ready.
    if (job.mode !== 'api') {
      if (job.status === 'scheduled') { await supabase.from('publish_jobs').update({ status: 'queued' }).eq('id', job.id); ready++ }
      continue
    }
    if (job.attempts >= job.max_attempts) continue

    const { data: pieceRow } = await supabase.from('content_pieces').select('*').eq('id', job.content_piece_id).maybeSingle()
    const piece = pieceRow as ContentPiece | null
    if (!piece) continue
    let connection: SocialConnection | null = null
    if (job.connection_id) {
      const { data: c } = await supabase.from('social_connections').select('*').eq('id', job.connection_id).maybeSingle()
      connection = c as SocialConnection | null
    }
    const out = await processJobNow(supabase, job.user_id, { job, piece, connection })
    if (out.job.status === 'published') published++
    else if (out.job.status === 'failed') failed++
  }

  return NextResponse.json({ ok: true, processed: jobs.length, published, ready, failed })
}