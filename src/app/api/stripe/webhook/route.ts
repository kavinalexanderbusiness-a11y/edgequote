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
  const cad = (n: number) => new Intl.NumberFormat('en-CA', { style: 'currency', currency: 'CAD' }).format(n)
  // Find the recorded payment (+ its invoice number) for a Stripe PaymentIntent —
  // used by the refund + dispute branches to locate the affected invoice/owner.
  async function paymentForIntent(piId: string) {
    const { data } = await sb.from('payments')
      .select('id, invoice_id, user_id, customer_id, invoices(invoice_number)')
      .eq('stripe_payment_intent', piId).limit(1).maybeSingle()
    const p = data as { id: string; invoice_id: string | null; user_id: string; customer_id: string | null; invoices?: { invoice_number: string } | { invoice_number: string }[] | null } | null
    if (!p) return null
    const inv = Array.isArray(p.invoices) ? p.invoices[0] : p.invoices
    return { ...p, invoiceNumber: inv?.invoice_number ?? null }
  }
  async function notifyOnce(userId: string, type: string, entityId: string, title: string, body: string, customerId: string | null) {
    const { data: dup } = await sb.from('notifications').select('id').eq('user_id', userId).eq('type', type).eq('entity_id', entityId).limit(1)
    if (dup && dup.length) return
    await sb.from('notifications').insert({
      user_id: userId, type, title, body, customer_id: customerId, entity_type: 'invoice', entity_id: entityId,
      href: customerId ? `/dashboard/customers/${customerId}` : '/dashboard/invoices',
    })
  }

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
        // The recompute_invoice_paid trigger derives status + paid_at from the ledger
        // the moment the payment row lands; here we only stamp the method for display.
        // Scoped to the owner from metadata (never touches someone else's invoice).
        const invRes = await sb.from('invoices').update({ payment_method: 'stripe' })
          .eq('id', invoiceId).eq('user_id', userId)
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
        // .select() tells us whether THIS event inserted a NEW payment row. The
        // recompute_invoice_paid trigger now derives the invoice status from the ledger
        // the moment this row lands, so we gate the once-only receipt on the payment
        // insert (a re-delivered event ignores the duplicate → no second receipt).
        const payRes = await sb.from('payments').upsert({
          user_id: userId, customer_id: customerId, invoice_id: invoiceId,
          amount: (pi.amount ?? 0) / 100, currency: pi.currency ?? 'cad',
          stripe_session_id: `autopay:${invoiceId}`, stripe_payment_intent: pi.id,
          status: 'paid', paid_at: now(),
        }, { onConflict: 'stripe_session_id', ignoreDuplicates: true }).select('id')
        if (payRes.error) {
          console.error('[stripe] autopay payment upsert failed:', payRes.error.message)
          return NextResponse.json({ error: 'db write failed' }, { status: 500 })
        }
        const isNewPayment = (payRes.data?.length ?? 0) > 0
        // Stamp the payment method for display (the trigger owns status + paid_at).
        const invRes = await sb.from('invoices').update({ payment_method: 'stripe' })
          .eq('id', invoiceId).eq('user_id', userId)
        if (invRes.error) {
          console.error('[stripe] autopay invoice update failed:', invRes.error.message)
          return NextResponse.json({ error: 'db write failed' }, { status: 500 })
        }
        if (isNewPayment) {
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

  // ── Refund ────────────────────────────────────────────────────────────────
  // A FULL refund reverts the invoice to unpaid + marks the payment refunded (so
  // revenue stops counting it); a partial refund only notifies. Idempotent: the
  // invoice flip is guarded by .eq('status','paid') and the notification is deduped.
  if (event.type === 'charge.refunded') {
    const ch = event.data.object as { id: string; payment_intent?: string | null; amount?: number; amount_refunded?: number; refunded?: boolean }
    const piId = typeof ch.payment_intent === 'string' ? ch.payment_intent : null
    if (piId) {
      const p = await paymentForIntent(piId)
      if (p) {
        const captured = (ch.amount ?? 0) / 100
        const refunded = (ch.amount_refunded ?? 0) / 100
        const full = ch.refunded === true || (captured > 0 && refunded >= captured)
        const entityId = p.invoice_id ?? p.id
        if (full && p.invoice_id) {
          const invRes = await sb.from('invoices').update({ status: 'unpaid', payment_method: null, paid_at: null })
            .eq('id', p.invoice_id).eq('user_id', p.user_id).eq('status', 'paid')
          if (invRes.error) {
            console.error('[stripe] refund invoice revert failed:', invRes.error.message)
            return NextResponse.json({ error: 'db write failed' }, { status: 500 })
          }
          await sb.from('payments').update({ status: 'refunded' }).eq('id', p.id)
        }
        await notifyOnce(p.user_id, 'payment_refunded', entityId, full ? 'Payment refunded' : 'Partial refund',
          `${p.invoiceNumber ? p.invoiceNumber + ': ' : ''}${cad(refunded)} refunded${full ? ' — the invoice is unpaid again.' : '.'}`, p.customer_id)
      }
    }
  }

  // ── Dispute (chargeback) ────────────────────────────────────────────────────
  // Needs the owner's action in Stripe — we notify but never auto-change state.
  if (event.type === 'charge.dispute.created') {
    const d = event.data.object as { id: string; payment_intent?: string | null; amount?: number; reason?: string }
    const piId = typeof d.payment_intent === 'string' ? d.payment_intent : null
    if (piId) {
      const p = await paymentForIntent(piId)
      if (p) {
        await notifyOnce(p.user_id, 'payment_disputed', p.invoice_id ?? p.id, 'Payment disputed',
          `${p.invoiceNumber ? p.invoiceNumber + ': ' : ''}A ${cad((d.amount ?? 0) / 100)} payment was disputed${d.reason ? ` (${d.reason})` : ''}. Respond in your Stripe dashboard.`, p.customer_id)
      }
    }
  }

  return NextResponse.json({ received: true })
}
