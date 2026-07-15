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

  // Read the cards BEFORE anything else: if this fails we must not delete rows we
  // never detached — that would orphan the card at Stripe with no id left to retry.
  const { data: pms, error: readErr } = await sb.from('payment_methods')
    .select('stripe_payment_method_id').eq('customer_id', customerId).eq('user_id', user.id)
  if (readErr) return NextResponse.json({ error: 'could not read the saved card' }, { status: 500 })

  // AutoPay OFF first — this is the write that stops money moving. If the delete below
  // fails we've still disarmed the charge; if this one fails we stop before telling the
  // owner the card is gone, because attemptAutoPayCharge would happily charge it again.
  const { error: autopayErr } = await sb.from('customers')
    .update({ autopay_enabled: false }).eq('id', customerId).eq('user_id', user.id)
  if (autopayErr) return NextResponse.json({ error: 'could not turn AutoPay off' }, { status: 500 })

  for (const p of (pms as { stripe_payment_method_id: string }[] | null) || []) {
    await detachPaymentMethod(p.stripe_payment_method_id)
  }

  // Supabase resolves on a failed write. Unchecked, this route 200'd on a failed delete
  // and the UI cleared the card — while AutoPay would keep charging the row still there.
  const { error: delErr } = await sb.from('payment_methods')
    .delete().eq('customer_id', customerId).eq('user_id', user.id)
  if (delErr) return NextResponse.json({ error: 'could not remove the card' }, { status: 500 })

  return NextResponse.json({ ok: true })
}
