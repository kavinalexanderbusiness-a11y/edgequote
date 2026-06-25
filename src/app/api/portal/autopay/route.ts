import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

// Public, token-scoped: a customer enables/disables AutoPay from their portal. The
// SECURITY DEFINER RPC flips the per-customer flag (refusing to enable with no card).
export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => ({}))
  const token = String(body.token || '')
  const enabled = body.enabled === true
  if (!token) return NextResponse.json({ error: 'bad request' }, { status: 400 })

  const anon = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!)
  const { data, error } = await anon.rpc('portal_set_autopay', { p_token: token, p_enabled: enabled })
  if (error) return NextResponse.json({ error: 'Could not update AutoPay.' }, { status: 502 })
  // false when enabling without a saved card on file.
  return NextResponse.json({ ok: data === true, enabled: data === true ? enabled : false })
}
