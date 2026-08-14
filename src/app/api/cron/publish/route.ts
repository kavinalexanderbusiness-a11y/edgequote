import { NextRequest, NextResponse } from 'next/server'
import { cronSecretOk, serviceClient } from '@/lib/cron/guard'
import { withCronSweep, counts } from '@/lib/cron/heartbeat'
import { processDueJobs } from '@/lib/marketing/publishQueue'

export const dynamic = 'force-dynamic'

// OPTIONAL daily backstop for the publishing queue. Core scheduling does NOT depend on
// this — due jobs are processed on demand when each owner opens the Studio (see
// /api/marketing/publish/process), which works on Vercel Hobby with no paid plan. This
// cron just sweeps ALL owners once a day (or hourly if a Pro user bumps the schedule in
// vercel.json) so a post still goes out even if the owner never logs in. Guarded by
// CRON_SECRET + the service-role key; no-ops cleanly when either is absent.
async function handler(req: NextRequest): Promise<NextResponse> {
  if (!cronSecretOk(req)) return NextResponse.json({ error: 'forbidden' }, { status: 403 })
  const supabase = serviceClient() // service role → sweeps every owner
  if (!supabase) return NextResponse.json({ ok: true, skipped: true, note: 'Optional — set SUPABASE_SERVICE_ROLE_KEY to enable the daily sweep.' })

  const result = await processDueJobs(supabase)
  return NextResponse.json({ ok: true, ...result })
}

// The heartbeat is the only durable evidence this sweep ever ran: processDueJobs
// swallows a failed read and returns all-zeros, so "nothing was due" and "the query
// died" reach the exact same response.
export const GET = withCronSweep('publish', handler, b => counts(b, undefined, 'processed', 'published'))