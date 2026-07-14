import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'
import { addDays, format } from 'date-fns'
import { prepareAutoDraft } from '@/lib/marketing/autoDraft'
import { resolveAutomations } from '@/lib/comms/automations'

export const dynamic = 'force-dynamic'

// Daily backstop for auto marketing drafts. The completion fire-and-forget is best-
// effort (photos are usually uploaded AFTER the visit, and a tab can close before it
// runs), so this is the RELIABLE path: it sweeps recently-completed jobs that have
// before+after photos and no draft yet, and prepares one (never publishes). Guarded by
// CRON_SECRET + the service-role key; no-ops cleanly when either is absent. Bounded per
// run. Idempotent via prepareAutoDraft (skips jobs that already have content pieces).
export async function GET(req: NextRequest): Promise<NextResponse> {
  const secret = req.headers.get('authorization')?.replace('Bearer ', '') || new URL(req.url).searchParams.get('secret') || ''
  if (!process.env.CRON_SECRET || secret !== process.env.CRON_SECRET) {
    return NextResponse.json({ error: 'forbidden' }, { status: 403 })
  }
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL, svc = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!url || !svc) return NextResponse.json({ ok: true, skipped: true, note: 'Set SUPABASE_SERVICE_ROLE_KEY to enable the daily marketing-draft sweep.' })
  const supabase = createClient(url, svc) // service role → sweeps every owner

  const sinceDate = format(addDays(new Date(), -14), 'yyyy-MM-dd')
  const { data: jobRows } = await supabase.from('jobs')
    .select('id, user_id, scheduled_date').eq('status', 'completed').gte('scheduled_date', sinceDate).limit(400)
  const jobs = (jobRows as { id: string; user_id: string }[] | null) || []
  if (!jobs.length) return NextResponse.json({ ok: true, prepared: 0 })
  const jobIds = jobs.map(j => j.id)

  // Jobs with BOTH a before and an after photo.
  const { data: photoRows } = await supabase.from('job_photos').select('job_id, kind').in('job_id', jobIds).in('kind', ['before', 'after'])
  const before = new Set<string>(), after = new Set<string>()
  for (const p of (photoRows as { job_id: string; kind: string }[] | null) || []) {
    if (p.kind === 'before') before.add(p.job_id)
    else if (p.kind === 'after') after.add(p.job_id)
  }
  // Jobs that already have a draft/piece — never re-draft.
  const { data: pieceRows } = await supabase.from('content_pieces').select('job_id').in('job_id', jobIds)
  const hasPiece = new Set<string>(((pieceRows as { job_id: string | null }[] | null) || []).map(r => r.job_id).filter((x): x is string => !!x))

  const eligible = jobs.filter(j => before.has(j.id) && after.has(j.id) && !hasPiece.has(j.id))

  // Per-owner automation gate (cached) — respect the owner's toggle.
  const autoCache: Record<string, boolean> = {}
  async function drafts(userId: string): Promise<boolean> {
    if (userId in autoCache) return autoCache[userId]
    const { data } = await supabase.from('business_settings').select('automations').eq('user_id', userId).maybeSingle()
    return (autoCache[userId] = resolveAutomations((data as { automations: unknown } | null)?.automations).marketing_draft)
  }

  let prepared = 0
  for (const j of eligible.slice(0, 25)) { // bounded per run
    try {
      if (!(await drafts(j.user_id))) continue // per-owner toggle (inside try so a rejected query can't abort the sweep)
      const r = await prepareAutoDraft(supabase, j.user_id, j.id)
      if (r.status === 'created' || r.status === 'shell') prepared++
    } catch { /* one job failing never stops the sweep */ }
  }
  return NextResponse.json({ ok: true, eligible: eligible.length, prepared })
}