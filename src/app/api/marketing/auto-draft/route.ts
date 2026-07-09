import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { prepareAutoDraft } from '@/lib/marketing/autoDraft'

export const dynamic = 'force-dynamic'
export const maxDuration = 90

// POST /api/marketing/auto-draft?jobId=…  (jobId may also be in the body)
// Fired best-effort when a job is completed (mirrors the job_complete comms fire) to
// prepare a marketing DRAFT for a job with before+after photos. Idempotent + disabled-
// safe via prepareAutoDraft. Never publishes. The daily cron is the reliable backstop.
export async function POST(req: NextRequest): Promise<NextResponse> {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ ok: false }, { status: 401 })

  const body = await req.json().catch(() => ({}))
  const jobId = new URL(req.url).searchParams.get('jobId') || String(body.jobId || '')
  if (!jobId) return NextResponse.json({ ok: false, error: 'bad request' }, { status: 400 })

  try {
    const result = await prepareAutoDraft(supabase, user.id, jobId)
    return NextResponse.json({ ok: true, ...result })
  } catch {
    // Best-effort — a failure here must never surface to the completion flow.
    return NextResponse.json({ ok: false, error: 'auto-draft failed' }, { status: 200 })
  }
}
