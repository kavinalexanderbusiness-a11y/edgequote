import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'
import { constructWebhookEvent } from '@/lib/stripe/config'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

// Stripe → us. The ONLY path that records a Stripe payment as 'paid'. It verifies
// the signature first, then (service role) records the payment and marks the
// invoice paid. Idempotent: the payment row is unique per checkout session and
// the invoice is only flipped while still owing — so a re-delivered event is a
// no-op. A client can't forge this: without the webhook secret the signature
// check fails and nothing is written.
export async function POST(req: NextRequest) {
  const raw = await req.text()
  const sig = req.headers.get('stripe-signature')
  const v = constructWebhookEvent(raw, sig)
  if (!v.ok) {
    console.error('[stripe] webhook signature verification failed:', v.error)
    return NextResponse.json({ error: 'invalid signature' }, { status: 400 })
  }
  const event = v.event as { type: string; data: { object: Record<string, unknown> } }

  if (event.type === 'checkout.session.completed' || event.type === 'checkout.session.async_payment_succeeded') {
    const s = event.data.object as {
      id: string; payment_status?: string; amount_total?: number; currency?: string
      payment_intent?: string | null; metadata?: Record<string, string> | null
    }
    if (s.payment_status === 'paid') {
      const invoiceId = s.metadata?.invoice_id
      const userId = s.metadata?.user_id
      const url = process.env.NEXT_PUBLIC_SUPABASE_URL, svc = process.env.SUPABASE_SERVICE_ROLE_KEY
      if (invoiceId && userId && url && svc) {
        const sb = createClient(url, svc)
        // One payment row per session (unique stripe_session_id) — duplicate
        // deliveries are ignored rather than double-counted.
        const payRes = await sb.from('payments').upsert({
          user_id: userId,
          customer_id: s.metadata?.customer_id ?? null,
          invoice_id: invoiceId,
          amount: (s.amount_total ?? 0) / 100,
          currency: s.currency ?? 'cad',
          stripe_session_id: s.id,
          stripe_payment_intent: typeof s.payment_intent === 'string' ? s.payment_intent : null,
          status: 'paid',
          paid_at: new Date().toISOString(),
        }, { onConflict: 'stripe_session_id', ignoreDuplicates: true })
        // A DB write must NOT be reported as handled — return 500 so Stripe RETRIES
        // (both writes are idempotent: the upsert dedupes on stripe_session_id and
        // the invoice flip is guarded by .neq('paid'), so a retry can't double-count
        // or un-pay). Silently 200-ing on a failed write would LOSE the payment.
        if (payRes.error) {
          console.error('[stripe] payment upsert failed:', payRes.error.message)
          return NextResponse.json({ error: 'db write failed' }, { status: 500 })
        }
        // Mark the invoice paid — scoped to the owner from metadata, and only
        // while it's still owing (never un-pay or touch someone else's invoice).
        const invRes = await sb.from('invoices').update({ status: 'paid', paid_at: new Date().toISOString(), payment_method: 'stripe' })
          .eq('id', invoiceId).eq('user_id', userId).neq('status', 'paid')
        if (invRes.error) {
          console.error('[stripe] invoice update failed:', invRes.error.message)
          return NextResponse.json({ error: 'db write failed' }, { status: 500 })
        }
      }
    }
  }
  return NextResponse.json({ received: true })
}
