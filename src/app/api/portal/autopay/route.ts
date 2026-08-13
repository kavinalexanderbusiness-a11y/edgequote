import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'
import { tenantCapabilities, CAPABILITY_MESSAGE } from '@/lib/capabilities'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

// Public, token-scoped: a customer enables/disables AutoPay from their portal. The
// SECURITY DEFINER RPC flips the per-customer flag (refusing to enable with no card).
export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => ({}))
  const token = String(body.token || '')
  const enabled = body.enabled === true
  if (!token) return NextResponse.json({ error: 'bad request' }, { status: 400 })

  // Tenant capability — gate the ENABLE only. Turning AutoPay OFF is
  // de-escalation and must always work, whatever the tenant's grants are.
  if (enabled) {
    const url = process.env.NEXT_PUBLIC_SUPABASE_URL, svc = process.env.SUPABASE_SERVICE_ROLE_KEY
    if (!url || !svc) return NextResponse.json({ error: 'Could not update AutoPay.' }, { status: 502 })
    const admin = createClient(url, svc)
    const { data: tok } = await admin.from('customer_portal_tokens')
      .select('user_id').eq('token', token).eq('revoked', false).maybeSingle()
    const t = tok as { user_id: string } | null
    if (!t) return NextResponse.json({ error: 'This link is not valid.' }, { status: 404 })
    if (!(await tenantCapabilities(admin, t.user_id)).onlinePayments) {
      return NextResponse.json({ error: CAPABILITY_MESSAGE.payments }, { status: 503 })
    }
  }

  const anon = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!)
  const { data, error } = await anon.rpc('portal_set_autopay', { p_token: token, p_enabled: enabled })
  if (error) return NextResponse.json({ error: 'Could not update AutoPay.' }, { status: 502 })
  // false when enabling without a saved card on file.
  return NextResponse.json({ ok: data === true, enabled: data === true ? enabled : false })
}
