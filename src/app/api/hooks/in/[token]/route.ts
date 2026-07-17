// The inbound webhook receiver: POST /api/hooks/in/<token>
//
// The token IS the auth (same submit-only-token model as booking_token) — it
// resolves the hook, which resolves the owner and the action. CORS-open like
// the other public intake doors. GET answers a liveness probe so Zapier/Make
// setup tests pass without side effects. Per-hook rate limit: 60/hour,
// mirroring the intake doors' per-business guards.

import { NextRequest, NextResponse } from 'next/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { normalizeInboundPayload, runInboundAction } from '@/lib/integrations/inboundActions'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
}
const RATE_LIMIT_PER_HOUR = 60
const MAX_BODY_BYTES = 100_000

const json = (body: unknown, status = 200) => NextResponse.json(body, { status, headers: CORS })

export async function OPTIONS() {
  return new NextResponse(null, { status: 204, headers: CORS })
}

async function findHook(token: string) {
  const sb = createAdminClient()
  if (!sb) return { sb: null, hook: null }
  const { data } = await sb.from('inbound_webhooks')
    .select('id, user_id, name, action, active, received_count')
    .eq('token', token).maybeSingle()
  return { sb, hook: data ?? null }
}

export async function GET(_req: NextRequest, ctx: { params: Promise<{ token: string }> }) {
  const { token } = await ctx.params
  const { sb, hook } = await findHook(token)
  if (!sb) return json({ error: 'not configured' }, 503)
  if (!hook || !hook.active) return json({ error: 'not found' }, 404)
  return json({ ok: true, name: hook.name, action: hook.action, hint: 'POST a JSON payload to this URL.' })
}

export async function POST(req: NextRequest, ctx: { params: Promise<{ token: string }> }) {
  const { token } = await ctx.params
  const { sb, hook } = await findHook(token)
  if (!sb) return json({ error: 'not configured' }, 503)
  if (!hook || !hook.active) return json({ error: 'not found' }, 404)

  const raw = await req.text()
  if (raw.length > MAX_BODY_BYTES) return json({ error: 'payload too large' }, 413)
  let payload: Record<string, unknown>
  try {
    const parsed = JSON.parse(raw)
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error()
    payload = parsed
  } catch {
    return json({ error: 'Body must be a JSON object.' }, 400)
  }

  const hourAgo = new Date(Date.now() - 3_600_000).toISOString()
  const { count } = await sb.from('inbound_events')
    .select('id', { count: 'exact', head: true })
    .eq('hook_id', hook.id).gt('created_at', hourAgo)
  if ((count ?? 0) >= RATE_LIMIT_PER_HOUR) return json({ error: 'rate_limited' }, 429)

  const result = await runInboundAction(sb, hook.user_id, hook.action as 'lead' | 'customer', normalizeInboundPayload(payload), hook.name)

  // Receipt + counters are bookkeeping — the caller's verdict is `result`.
  await sb.from('inbound_events').insert({
    user_id: hook.user_id, hook_id: hook.id, ok: result.ok,
    summary: result.summary, entity_id: result.customerId ?? null, payload,
  })
  await sb.from('inbound_webhooks').update({
    received_count: hook.received_count + 1, last_received_at: new Date().toISOString(),
  }).eq('id', hook.id)

  return json({
    ok: result.ok,
    summary: result.summary,
    ...(result.customerId ? { customer_id: result.customerId } : {}),
    ...(result.propertyId ? { property_id: result.propertyId } : {}),
    ...(result.requestId ? { request_id: result.requestId } : {}),
    ...(result.deduped !== undefined ? { matched_existing: result.deduped } : {}),
  }, result.status)
}
