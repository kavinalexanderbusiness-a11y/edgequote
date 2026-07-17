// POST /api/integrations/inbound — create an inbound webhook (token minted
// server-side). Toggle/rename/delete are client-side RLS.
import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { generateInboundToken } from '@/lib/integrations/keys'

export const dynamic = 'force-dynamic'

export async function POST(req: NextRequest) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'unauthorized' }, { status: 401 })

  const body = await req.json().catch(() => ({}))
  const name = typeof body.name === 'string' && body.name.trim() ? body.name.trim().slice(0, 80) : 'Inbound webhook'
  const action = body.action === 'customer' ? 'customer' : 'lead'

  const { data, error } = await supabase.from('inbound_webhooks').insert({
    user_id: user.id, name, action, token: generateInboundToken(),
  }).select('*').single()
  if (error || !data) return NextResponse.json({ error: error?.message ?? 'insert failed' }, { status: 500 })
  return NextResponse.json(data, { status: 201 })
}
