// REST hooks — the Zapier/Make instant-trigger contract.
//   GET  /api/v1/hooks — list subscriptions (secrets not included)
//   POST /api/v1/hooks {url, events?, description?} — subscribe; returns the
//        endpoint id + signing secret ONCE. Deliveries start immediately.
// Subscriptions land in the SAME webhook_endpoints table as manual endpoints —
// one delivery engine, one log, one management UI.
import { NextRequest, NextResponse } from 'next/server'
import { authenticateRequest, apiError } from '@/lib/integrations/apiAuth'
import { validateEventSelection } from '@/lib/integrations/events'
import { generateWebhookSecret } from '@/lib/integrations/keys'

export const dynamic = 'force-dynamic'

export async function GET(req: NextRequest) {
  const { auth, fail } = await authenticateRequest(req, 'read')
  if (!auth) return fail!
  const { data, error } = await auth.sb.from('webhook_endpoints')
    .select('id, url, description, events, source, active, created_at')
    .eq('user_id', auth.userId).order('created_at', { ascending: false })
  if (error) return apiError(500, error.message)
  return NextResponse.json({ data: data ?? [] })
}

export async function POST(req: NextRequest) {
  const { auth, fail } = await authenticateRequest(req, 'write')
  if (!auth) return fail!
  let body: Record<string, unknown>
  try {
    body = await req.json()
  } catch {
    return apiError(400, 'Body must be JSON.')
  }
  const url = typeof body.url === 'string' ? body.url.trim() : ''
  try {
    const parsed = new URL(url)
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') throw new Error()
  } catch {
    return apiError(422, "'url' must be a valid http(s) URL.")
  }
  const events = Array.isArray(body.events) && body.events.length > 0 ? body.events.map(String) : ['*']
  const eventsError = validateEventSelection(events)
  if (eventsError) return apiError(422, eventsError)

  const secret = generateWebhookSecret()
  const { data, error } = await auth.sb.from('webhook_endpoints').insert({
    user_id: auth.userId, url, events,
    description: typeof body.description === 'string' ? body.description.slice(0, 200) : null,
    secret, source: 'api',
  }).select('id, url, events, source, active, created_at').single()
  if (error || !data) return apiError(500, error?.message ?? 'Failed to create subscription.')
  return NextResponse.json({ data: { ...data, secret } }, { status: 201 })
}
