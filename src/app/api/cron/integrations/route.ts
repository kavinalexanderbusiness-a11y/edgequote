// GET /api/cron/integrations — the webhook retry sweep + backstop (every 10
// minutes; vercel.json). The pg_net nudge delivers instantly in the happy
// path; this sweep owns retries (backoff schedule in lib/integrations/retry),
// re-queues deliveries a crashed worker left claimed, prunes 30-day logs, and
// writes the automation_sweeps heartbeat so "no deliveries" and "sweep never
// ran" stay distinguishable (the automation-foundation lesson).

import { NextRequest, NextResponse } from 'next/server'
import { cronSecretOk, serviceClient } from '@/lib/cron/guard'
import { processDueDeliveries, requeueStuckDeliveries, pruneIntegrationLogs } from '@/lib/integrations/deliver'
import { STUCK_PROCESSING_MINUTES, RETENTION_DAYS } from '@/lib/integrations/retry'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const maxDuration = 300

export async function GET(req: NextRequest) {
  if (!cronSecretOk(req)) return NextResponse.json({ error: 'forbidden' }, { status: 403 })
  const sb = serviceClient()
  const requestId = crypto.randomUUID().slice(0, 8)
  const started = Date.now()
  if (!sb) {
    console.error('[cron/integrations] SUPABASE_SERVICE_ROLE_KEY missing — sweep AND heartbeat cannot run')
    return NextResponse.json({ error: 'service key missing' }, { status: 503 })
  }

  const heartbeat = async (ok: boolean, detected: number, written: number, error: string | null) => {
    try {
      await sb.from('automation_sweeps').upsert({
        job: 'integrations', ran_on: new Date().toISOString().slice(0, 10),
        ran_at: new Date().toISOString(), // explicit: upsert UPDATE won't re-fire default now()
        ok, detected, written, ms: Date.now() - started, error, request_id: requestId,
      }, { onConflict: 'job,ran_on' })
    } catch (e) {
      console.error('[cron/integrations] heartbeat write failed:', e instanceof Error ? e.message : e)
    }
  }

  try {
    const requeued = await requeueStuckDeliveries(sb, STUCK_PROCESSING_MINUTES)
    const summary = await processDueDeliveries(sb, null, 240_000)
    await pruneIntegrationLogs(sb, RETENTION_DAYS)
    await heartbeat(true, summary.claimed, summary.delivered, null)
    // Unconditional: for a sweep, the quiet night is the one needing proof.
    console.log('[cron/integrations] run:', JSON.stringify({ requestId, requeued, ...summary, ms: Date.now() - started }))
    return NextResponse.json({ ok: true, requeued, ...summary })
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e)
    await heartbeat(false, 0, 0, message.slice(0, 500))
    console.error('[cron/integrations] failed:', message)
    return NextResponse.json({ error: message }, { status: 500 })
  }
}
