import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'
import { constructWebhookEvent, fetchSetupIntentCard, detachPaymentMethod } from '@/lib/stripe/config'
import { sendPaymentReceipt } from '@/lib/comms/receipt'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

// Stripe → us. The ONLY path that records a Stripe payment as 'paid'. It verifies
// the signature first, then (service role) records the payment and marks the
// invoice paid. Idempotent: the payment row is unique per checkout session / per
// invoice and the invoice is only flipped while still owing — so a re-delivered
// event is a no-op. A client can't forge this: without the webhook secret the
// signature check fails and nothing is written.
//
// Handles four event shapes, all sharing the same payments table + invoice flip:
//   • checkout.session.completed (mode=payment)  — one-time Pay Now (UNCHANGED)
//   • checkout.session.completed (mode=setup)    — AutoPay card saved
//   • payment_intent.succeeded   (source=autopay)— AutoPay charge succeeded
//   • payment_intent.payment_failed (source=autopay) — AutoPay charge declined
export async function POST(req: NextRequest) {
  const raw = await req.text()
  const sig = req.headers.get('stripe-signature')
  const v = constructWebhookEvent(raw, sig)
  if (!v.ok) {
    console.error('[stripe] webhook signature verification failed:', v.error)
    return NextResponse.json({ error: 'invalid signature' }, { status: 400 })
  }
  const event = v.event as { type: string; data: { object: Record<string, unknown> } }

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL, svc = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!url || !svc) {
    // Never silently 200 a payment we can't record — let Stripe retry until the
    // (required) service-role key is configured.
    console.error('[stripe] webhook missing Supabase service-role env')
    return NextResponse.json({ error: 'server not configured' }, { status: 500 })
  }
  const sb = createClient(url, svc)
  const now = () => new Date().toISOString()
  const origin = req.nextUrl?.origin || process.env.NEXT_PUBLIC_APP_URL || ''

  // ── One-time Pay Now (mode=payment) — UNCHANGED ──────────────────────────────
  if (event.type === 'checkout.session.completed' || event.type === 'checkout.session.async_payment_succeeded') {
    const s = event.data.object as {
      id: string; mode?: string; payment_status?: string; amount_total?: number; currency?: string
      payment_intent?: string | null; setup_intent?: string | null; customer?: string | null
      metadata?: Record<string, string> | null
    }
    if (s.payment_status === 'paid') {
      const invoiceId = s.metadata?.invoice_id
      const userId = s.metadata?.user_id
      if (invoiceId && userId) {
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
          paid_at: now(),
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
        const invRes = await sb.from('invoices').update({ status: 'paid', paid_at: now(), payment_method: 'stripe' })
          .eq('id', invoiceId).eq('user_id', userId).neq('status', 'paid')
        if (invRes.error) {
          console.error('[stripe] invoice update failed:', invRes.error.message)
          return NextResponse.json({ error: 'db write failed' }, { status: 500 })
        }
      }
    }

    // ── AutoPay card saved (mode=setup) ──
    if (s.mode === 'setup') {
      const userId = s.metadata?.user_id
      const customerId = s.metadata?.customer_id
      const setupIntentId = typeof s.setup_intent === 'string' ? s.setup_intent : null
      if (userId && customerId && setupIntentId) {
        const card = await fetchSetupIntentCard(setupIntentId)
        if (card.ok && card.paymentMethodId) {
          const stripeCustomerId = card.stripeCustomerId || (typeof s.customer === 'string' ? s.customer : null)
          if (stripeCustomerId) {
            await sb.from('customers').update({ stripe_customer_id: stripeCustomerId }).eq('id', customerId).eq('user_id', userId)
          }
          // Keep exactly ONE card per customer. Save the NEW card FIRST, then detach +
          // delete any previous cards — so a failure mid-way can never leave the
          // customer with NO card while AutoPay is still on (the worst case is a
          // harmless stale row, and the charge path always picks is_default + newest).
          const upRes = await sb.from('payment_methods').upsert({
            user_id: userId, customer_id: customerId, stripe_customer_id: stripeCustomerId,
            stripe_payment_method_id: card.paymentMethodId, brand: card.brand ?? null, last4: card.last4 ?? null,
            exp_month: card.expMonth ?? null, exp_year: card.expYear ?? null, is_default: true,
          }, { onConflict: 'stripe_payment_method_id' })
          if (upRes.error) {
            console.error('[stripe] payment_method upsert failed:', upRes.error.message)
            return NextResponse.json({ error: 'db write failed' }, { status: 500 })
          }
          const { data: prior } = await sb.from('payment_methods')
            .select('stripe_payment_method_id').eq('customer_id', customerId).neq('stripe_payment_method_id', card.paymentMethodId)
          for (const p of (prior as { stripe_payment_method_id: string }[] | null) || []) {
            await detachPaymentMethod(p.stripe_payment_method_id)
          }
          await sb.from('payment_methods').delete().eq('customer_id', customerId).neq('stripe_payment_method_id', card.paymentMethodId)
        }
      }
    }
  }

  // ── AutoPay charge succeeded (off-session PaymentIntent) ──────────────────────
  // Gate strictly on source=autopay so the one-time Checkout's OWN payment_intent
  // .succeeded (which also carries invoice_id) is never double-recorded.
  if (event.type === 'payment_intent.succeeded') {
    const pi = event.data.object as { id: string; amount?: number; currency?: string; metadata?: Record<string, string> | null }
    if (pi.metadata?.source === 'autopay') {
      const invoiceId = pi.metadata.invoice_id
      const userId = pi.metadata.user_id
      const customerId = pi.metadata.customer_id ?? null
      if (invoiceId && userId) {
        // Deterministic dedupe key 'autopay:<invoiceId>' — a re-delivered event is a
        // no-op and a one-time payment (cs_… session id) never collides with it.
        const payRes = await sb.from('payments').upsert({
          user_id: userId, customer_id: customerId, invoice_id: invoiceId,
          amount: (pi.amount ?? 0) / 100, currency: pi.currency ?? 'cad',
          stripe_session_id: `autopay:${invoiceId}`, stripe_payment_intent: pi.id,
          status: 'paid', paid_at: now(),
        }, { onConflict: 'stripe_session_id', ignoreDuplicates: true })
        if (payRes.error) {
          console.error('[stripe] autopay payment upsert failed:', payRes.error.message)
          return NextResponse.json({ error: 'db write failed' }, { status: 500 })
        }
        // .select() tells us whether THIS event actually flipped the invoice — so the
        // receipt fires exactly once (a retry flips 0 rows → no duplicate receipt).
        const invRes = await sb.from('invoices').update({ status: 'paid', paid_at: now(), payment_method: 'stripe' })
          .eq('id', invoiceId).eq('user_id', userId).neq('status', 'paid').select('id')
        if (invRes.error) {
          console.error('[stripe] autopay invoice update failed:', invRes.error.message)
          return NextResponse.json({ error: 'db write failed' }, { status: 500 })
        }
        if ((invRes.data?.length ?? 0) > 0) {
          // The payment is already recorded + the invoice flipped, so the receipt is
          // pure best-effort. Time-box it: a slow/hung SMS/email provider must never
          // stall the webhook 200 (which would make Stripe needlessly retry).
          await Promise.race([
            sendPaymentReceipt(sb, { userId, customerId, amount: (pi.amount ?? 0) / 100, origin }),
            new Promise<void>(resolve => setTimeout(resolve, 6000)),
          ])
        }
      }
    }
  }

  // ── AutoPay charge failed (declined / SCA required off-session) ───────────────
  if (event.type === 'payment_intent.payment_failed') {
    const pi = event.data.object as { id: string; metadata?: Record<string, string> | null; last_payment_error?: { message?: string } | null }
    if (pi.metadata?.source === 'autopay') {
      const invoiceId = pi.metadata.invoice_id ?? null
      const userId = pi.metadata.user_id
      const customerId = pi.metadata.customer_id ?? null
      if (userId) {
        // One failure notification per invoice (a re-delivered event won't repeat it).
        let exists = false
        if (invoiceId) {
          const { data: dup } = await sb.from('notifications').select('id')
            .eq('user_id', userId).eq('type', 'payment_failed').eq('entity_id', invoiceId).limit(1)
          exists = !!(dup && dup.length)
        }
        if (!exists) {
          const reason = pi.last_payment_error?.message || 'The card was declined.'
          await sb.from('notifications').insert({
            user_id: userId, type: 'payment_failed', title: 'AutoPay charge failed',
            body: `${reason} The invoice was left unpaid — send a payment link or update the card.`,
            customer_id: customerId, entity_type: 'invoice', entity_id: invoiceId,
            href: customerId ? `/dashboard/customers/${customerId}` : '/dashboard/invoices',
          })
        }
      }
    }
  }

  return NextResponse.json({ received: true })
}
