import { NextRequest, NextResponse } from 'next/server'
import { createClient as createServerClient } from '@/lib/supabase/server'
import { createClient as createServiceClient } from '@supabase/supabase-js'
import { detachPaymentMethod } from '@/lib/stripe/config'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

// Owner-initiated "remove card". Detaches the saved card(s) from Stripe, deletes our
// metadata rows, and turns AutoPay off (it can't run with no card). payment_methods
// has no client write policy, so the delete uses the service role (scoped to owner).
export async function POST(req: NextRequest) {
  const supabase = await createServerClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'unauthorized' }, { status: 401 })

  const body = await req.json().catch(() => ({}))
  const customerId = String(body.customerId || '')
  if (!customerId) return NextResponse.json({ error: 'bad request' }, { status: 400 })

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL!, svc = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!svc) return NextResponse.json({ error: 'server not configured' }, { status: 500 })
  const sb = createServiceClient(url, svc)

  const { data: pms } = await sb.from('payment_methods')
    .select('stripe_payment_method_id').eq('customer_id', customerId).eq('user_id', user.id)
  for (const p of (pms as { stripe_payment_method_id: string }[] | null) || []) {
    await detachPaymentMethod(p.stripe_payment_method_id)
  }
  await sb.from('payment_methods').delete().eq('customer_id', customerId).eq('user_id', user.id)
  await sb.from('customers').update({ autopay_enabled: false }).eq('id', customerId).eq('user_id', user.id)

  return NextResponse.json({ ok: true })
}
