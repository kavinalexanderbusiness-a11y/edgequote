// POST /api/integrations/webhooks/test { endpointId } — the endpoint testing
// tool. Sends a REAL signed test.ping through the REAL pipeline (a delivery
// row + the worker), then returns the settled row so the UI can show the
// response inline. Nothing simulated — if this succeeds, live events will too.
import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { processDueDeliveries } from '@/lib/integrations/deliver'
import { TEST_EVENT, TEST_SAMPLE } from '@/lib/integrations/events'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const maxDuration = 30

export async function POST(req: NextRequest) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'unauthorized' }, { status: 401 })

  const body = await req.json().catch(() => ({}))
  const endpointId = typeof body.endpointId === 'string' ? body.endpointId : ''
  const { data: endpoint } = await supabase.from('webhook_endpoints')
    .select('id, url, active').eq('id', endpointId).maybeSingle() // RLS scopes to owner
  if (!endpoint) return NextResponse.json({ error: 'endpoint not found' }, { status: 404 })
  if (!endpoint.active) return NextResponse.json({ error: 'endpoint is paused — resume it first' }, { status: 409 })

  const { data: delivery, error } = await supabase.from('webhook_deliveries').insert({
    user_id: user.id, endpoint_id: endpoint.id, event: TEST_EVENT,
    payload: { ...TEST_SAMPLE, endpoint_url: endpoint.url, requested_at: new Date().toISOString() },
  }).select('id').single()
  if (error || !delivery) return NextResponse.json({ error: error?.message ?? 'could not queue test' }, { status: 500 })

  const admin = createAdminClient()
  if (!admin) {
    // No service key on this deploy: the DB nudge / cron will still deliver it.
    return NextResponse.json({ queued: true, deliveryId: delivery.id })
  }
  await processDueDeliveries(admin, user.id, 15_000)

  const { data: settled } = await supabase.from('webhook_deliveries')
    .select('id, status, attempts, response_status, response_body, duration_ms, last_error, delivered_at')
    .eq('id', delivery.id).single()
  return NextResponse.json({ delivery: settled ?? { id: delivery.id, status: 'pending' } })
}
