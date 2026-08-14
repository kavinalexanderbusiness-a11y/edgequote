// GET /api/cron/integrations — the webhook retry sweep + backstop (every 10
// minutes; vercel.json). The pg_net nudge delivers instantly in the happy
// path; this sweep owns retries (backoff schedule in lib/integrations/retry),
// re-queues deliveries a crashed worker left claimed, prunes 30-day logs, and
// writes the automation_sweeps heartbeat so "no deliveries" and "sweep never
// ran" stay distinguishable (the automation-foundation lesson).

import { NextRequest, NextResponse } from 'next/server'
import { cronSecretOk, serviceClient } from '@/lib/cron/guard'
import { withCronSweep, counts } from '@/lib/cron/heartbeat'
import { processDueDeliveries, requeueStuckDeliveries, pruneIntegrationLogs } from '@/lib/integrations/deliver'
import { STUCK_PROCESSING_MINUTES, RETENTION_DAYS } from '@/lib/integrations/retry'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const maxDuration = 300

async function handler(req: NextRequest) {
  if (!cronSecretOk(req)) return NextResponse.json({ error: 'forbidden' }, { status: 403 })
  const sb = serviceClient()
  const started = Date.now()
  if (!sb) {
    console.error('[cron/integrations] SUPABASE_SERVICE_ROLE_KEY missing — sweep AND heartbeat cannot run')
    return NextResponse.json({ error: 'service key missing' }, { status: 503 })
  }

  // The bespoke heartbeat that used to live here moved to lib/cron/heartbeat, where
  // all twelve crons share one writer. It also keyed `ran_on` off the UTC date while
  // signals and engine used the server's local date — so two jobs could file the same
  // night under different days. One writer, one day key.
  try {
    const requeued = await requeueStuckDeliveries(sb, STUCK_PROCESSING_MINUTES)
    const summary = await processDueDeliveries(sb, null, 240_000)
    await pruneIntegrationLogs(sb, RETENTION_DAYS)
    // Unconditional: for a sweep, the quiet night is the one needing proof.
    console.log('[cron/integrations] run:', JSON.stringify({ requeued, ...summary, ms: Date.now() - started }))
    return NextResponse.json({ ok: true, requeued, ...summary })
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e)
    console.error('[cron/integrations] failed:', message)
    return NextResponse.json({ ok: false, error: message }, { status: 500 })
  }
}

export const GET = withCronSweep('integrations', handler, b => counts(b, undefined, 'claimed', 'delivered'))
