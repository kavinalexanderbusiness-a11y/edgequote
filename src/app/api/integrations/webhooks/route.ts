// POST /api/integrations/webhooks — create an outbound endpoint for the
// signed-in owner (the UI path; Zapier/Make use POST /api/v1/hooks — both
// land in the same table). Server-side so secret minting stays in one place.
import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { validateEventSelection } from '@/lib/integrations/events'
import { generateWebhookSecret } from '@/lib/integrations/keys'

export const dynamic = 'force-dynamic'

export async function POST(req: NextRequest) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'unauthorized' }, { status: 401 })

  const body = await req.json().catch(() => ({}))
  const url = typeof body.url === 'string' ? body.url.trim() : ''
  try {
    const parsed = new URL(url)
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') throw new Error()
  } catch {
    return NextResponse.json({ error: 'Enter a valid http(s) URL.' }, { status: 422 })
  }
  const events = Array.isArray(body.events) && body.events.length > 0 ? body.events.map(String) : ['*']
  const eventsError = validateEventSelection(events)
  if (eventsError) return NextResponse.json({ error: eventsError }, { status: 422 })

  const { data, error } = await supabase.from('webhook_endpoints').insert({
    user_id: user.id, url, events,
    description: typeof body.description === 'string' && body.description.trim() ? body.description.trim().slice(0, 200) : null,
    secret: generateWebhookSecret(), source: 'manual',
  }).select('*').single()
  if (error || !data) return NextResponse.json({ error: error?.message ?? 'insert failed' }, { status: 500 })
  return NextResponse.json(data, { status: 201 })
}
