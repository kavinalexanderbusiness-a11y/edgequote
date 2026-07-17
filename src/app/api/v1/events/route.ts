// GET /api/v1/events — the captured event stream (?event= ?limit ?offset ?since).
// Zapier polling triggers and "perform list" sampling read this; each row is
// exactly the JSON a webhook endpoint would receive for that event.
import { NextRequest, NextResponse } from 'next/server'
import { authenticateRequest, listParams, listEnvelope, apiError } from '@/lib/integrations/apiAuth'
import { deliveryBody } from '@/lib/integrations/events'

export const dynamic = 'force-dynamic'

export async function GET(req: NextRequest) {
  const { auth, fail } = await authenticateRequest(req, 'read')
  if (!auth) return fail!
  const { limit, offset, since } = listParams(req)
  let q = auth.sb.from('integration_events')
    .select('id, event, entity_type, entity_id, payload, created_at')
    .eq('user_id', auth.userId)
    .order('created_at', { ascending: false })
    .range(offset, offset + limit)
  if (since) q = q.gte('created_at', since)
  const event = req.nextUrl.searchParams.get('event')
  if (event) q = q.eq('event', event)
  const { data, error } = await q
  if (error) return apiError(500, error.message)
  const rows = (data ?? []).map((r) => deliveryBody({
    id: r.id, event: r.event, createdAt: r.created_at, data: (r.payload ?? {}) as Record<string, unknown>,
  }))
  return NextResponse.json(listEnvelope(rows, limit))
}
