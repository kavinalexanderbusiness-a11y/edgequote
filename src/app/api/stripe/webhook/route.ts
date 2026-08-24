import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'
import { constructWebhookEvent, fetchSetupIntentCard, fetchPaymentIntentCard } from '@/lib/stripe/config'
import { saveCardForCustomer } from '@/lib/payments/cards'
import { splitGrossCents, apportionRefund, tipSessionKey, tipRefundKey } from '@/lib/payments/tips'
import { sendPaymentReceipt } from '@/lib/comms/receipt'
import { appOrigin, cleanOrigin } from '@/lib/appOrigin'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

// Stripe → us. The ONLY path that records a Stripe payment as 'paid'. It verifies
// the signature first, then (service role) records the payment and marks the
// invoice paid. Idempotent: the payment row is unique per checkout session / per
// invoice and the invoice is only flipped while still owing — so a re-delivered
// event is a no-op. A client can't forge this: without the webhook secret the
// signature check fails and nothing is written.
//
// Money-in events share the same payments table + invoice flip; the rest report on
// money that moved (or was taken back) outside this app:
//   • checkout.session.completed (mode=payment)  — one-time Pay Now (UNCHANGED)
//   • checkout.session.completed (mode=setup)    — AutoPay card saved
//   • payment_intent.succeeded   (source=autopay)— AutoPay charge succeeded
//   • payment_intent.payment_failed (source=autopay) — AutoPay charge declined
//   • charge.refunded            — refund → negative ledger row (THE only writer)
//   • charge.dispute.created / .closed — chargeback opened / decided (notify only)
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
  const origin = cleanOrigin(req.nextUrl?.origin) || appOrigin()
  const cad = (n: number) => new Intl.NumberFormat('en-CA', { style: 'currency', currency: 'CAD' }).format(n)
  // Find the recorded payment (+ its invoice number) for a Stripe PaymentIntent —
  // used by the refund + dispute branches to locate the affected invoice/owner.
  async function paymentForIntent(piId: string) {
    // .gt('amount', 0) targets the ORIGINAL money-in row. Refund rows carry the same
    // stripe_payment_intent (that's how the refund branch links them back), so once a
    // charge has been refunded at least once this lookup had two candidates and no
    // ORDER BY — Postgres could hand back the refund row. Today the fields we read
    // (invoice_id/user_id/customer_id) happen to match on both, so it silently got
    // away with it; on a payment with no invoice, entity_id would flip between the
    // two rows and the notify-once dedupe would stop deduping. Ask for the row we
    // actually mean.
    // .eq('kind','payment') keeps the pre-invoice deposit pair honest: both legs
    // of a quote deposit carry the same intent id, and the credit leg is not the
    // money-in row this lookup exists to find.
    const { data } = await sb.from('payments')
      .select('id, amount, invoice_id, quote_id, user_id, customer_id, invoices(invoice_number)')
      .eq('stripe_payment_intent', piId).eq('kind', 'payment').gt('amount', 0).limit(1).maybeSingle()
    const p = data as { id: string; amount: number; invoice_id: string | null; quote_id: string | null; user_id: string; customer_id: string | null; invoices?: { invoice_number: string } | { invoice_number: string }[] | null } | null
    if (!p) return null
    const inv = Array.isArray(p.invoices) ? p.invoices[0] : p.invoices
    return { ...p, invoiceNumber: inv?.invoice_number ?? null }
  }
  async function notifyOnce(userId: string, type: string, entityId: string, title: string, body: string, customerId: string | null, entityType: 'invoice' | 'quote' = 'invoice') {
    const { data: dup } = await sb.from('notifications').select('id').eq('user_id', userId).eq('type', type).eq('entity_id', entityId).limit(1)
    if (dup && dup.length) return
    await sb.from('notifications').insert({
      user_id: userId, type, title, body, customer_id: customerId, entity_type: entityType, entity_id: entityId,
      href: customerId ? `/dashboard/customers/${customerId}` : (entityType === 'quote' ? '/dashboard/quotes' : '/dashboard/invoices'),
    })
  }

  // ── One-time Pay Now (mode=payment) — UNCHANGED ──────────────────────────────
  if (event.type === 'checkout.session.completed' || event.type === 'checkout.session.async_payment_succeeded') {
    const s = event.data.object as {
      id: string; mode?: string; payment_status?: string; amount_total?: number; currency?: string
      payment_intent?: string | null; setup_intent?: string | null; customer?: string | null
      metadata?: Record<string, string> | null
    }
    // ── Scheduling deposit on a QUOTE (no invoice exists yet) ────────────────
    // Routed by metadata.quote_deposit — the key /api/portal/quote-deposit sets
    // and the invoice path never does, so the two vocabularies can't cross.
    // Records the ledger's canonical pre-invoice deposit shape (recordDeposit's
    // two legs: the CASH that arrived + the CREDIT the business now holds for
    // the customer), both welded to the booking by payments.quote_id. The
    // scheduling gate derives "deposit received" from the cash leg; nothing
    // here stores a readiness flag anywhere.
    if (s.payment_status === 'paid' && s.metadata?.quote_deposit === '1') {
      const quoteId = s.metadata?.quote_id
      const userId = s.metadata?.user_id
      const customerId = s.metadata?.customer_id ?? null
      if (quoteId && userId) {
        const amount = (s.amount_total ?? 0) / 100
        const piId = typeof s.payment_intent === 'string' ? s.payment_intent : null
        // Each leg is separately idempotent on its own stripe_session_id key —
        // a re-delivered event no-ops both. A 500 on either write makes Stripe
        // retry rather than lose money (both writes are safe to replay).
        const cashRes = await sb.from('payments').upsert({
          user_id: userId, customer_id: customerId, invoice_id: null, quote_id: quoteId,
          amount, currency: s.currency ?? 'cad',
          kind: 'payment', provider: 'stripe', method: 'stripe',
          stripe_session_id: s.id, stripe_payment_intent: piId,
          status: 'paid', paid_at: now(), notes: 'Scheduling deposit',
        }, { onConflict: 'stripe_session_id', ignoreDuplicates: true }).select('id')
        if (cashRes.error) {
          console.error('[stripe] quote-deposit cash leg failed:', cashRes.error.message)
          return NextResponse.json({ error: 'db write failed' }, { status: 500 })
        }
        const creditRes = await sb.from('payments').upsert({
          user_id: userId, customer_id: customerId, invoice_id: null, quote_id: quoteId,
          amount, currency: s.currency ?? 'cad',
          kind: 'credit', provider: 'credit', method: 'credit',
          stripe_session_id: `credit:${s.id}`, stripe_payment_intent: piId,
          status: 'paid', paid_at: now(), notes: 'Scheduling deposit — held as credit',
        }, { onConflict: 'stripe_session_id', ignoreDuplicates: true })
        if (creditRes.error) {
          console.error('[stripe] quote-deposit credit leg failed:', creditRes.error.message)
          return NextResponse.json({ error: 'db write failed' }, { status: 500 })
        }
        const isNewPayment = (cashRes.data?.length ?? 0) > 0
        if (isNewPayment) {
          const num = s.metadata?.quote_number || 'their quote'
          await notifyOnce(userId, 'deposit_received', quoteId, 'Deposit received',
            `${cad(amount)} received toward ${num} — check whether the booking is ready to schedule.`, customerId, 'quote')
          // The receipt template asserts only "received your payment of $X" —
          // partial-safe by design, so a deposit can reuse it. Best-effort +
          // time-boxed, and gated on THIS delivery inserting the row (a Stripe
          // re-delivery no-ops above → no second message).
          if (customerId) {
            await Promise.race([
              sendPaymentReceipt(sb, { userId, customerId, amount, origin }),
              new Promise<void>(resolve => setTimeout(resolve, 6000)),
            ])
          }
        }
      }
    }

    if (s.payment_status === 'paid' && s.metadata?.quote_deposit !== '1') {
      const invoiceId = s.metadata?.invoice_id
      const userId = s.metadata?.user_id
      if (invoiceId && userId) {
        // ── Split the settled charge ─────────────────────────────────────────
        // Stripe settles ONE gross figure. When the customer added a tip, that
        // gross is invoice-payment + gratuity, and only the first half may ever
        // reach recompute_invoice_paid. The split comes from metadata WE wrote
        // when we built the session (lib/stripe/config) — a server→server
        // channel the browser cannot touch — and never from a client claim, and
        // never from re-reading Stripe's line items.
        //
        // splitGrossCents clamps the tip to the gross, so a corrupt or truncated
        // metadata value can only ever mis-classify money that genuinely
        // arrived; it can never book a NEGATIVE invoice payment, which the
        // trigger would turn into a reopened balance and the chaser into a text
        // message to a customer who just paid.
        const { invoiceCents, tipCents } = splitGrossCents(s.amount_total ?? 0, s.metadata?.tip_cents)
        const piId = typeof s.payment_intent === 'string' ? s.payment_intent : null
        // One payment row per session (unique stripe_session_id) — duplicate
        // deliveries are ignored rather than double-counted.
        const payRes = await sb.from('payments').upsert({
          user_id: userId,
          customer_id: s.metadata?.customer_id ?? null,
          invoice_id: invoiceId,
          amount: invoiceCents / 100,
          currency: s.currency ?? 'cad',
          stripe_session_id: s.id,
          stripe_payment_intent: piId,
          status: 'paid',
          paid_at: now(),
        }, { onConflict: 'stripe_session_id', ignoreDuplicates: true }).select('id')
        // A DB write must NOT be reported as handled — return 500 so Stripe RETRIES
        // (both writes are idempotent: the upsert dedupes on stripe_session_id and
        // the invoice flip is guarded by .neq('paid'), so a retry can't double-count
        // or un-pay). Silently 200-ing on a failed write would LOSE the payment.
        if (payRes.error) {
          console.error('[stripe] payment upsert failed:', payRes.error.message)
          return NextResponse.json({ error: 'db write failed' }, { status: 500 })
        }
        // ── The gratuity leg ─────────────────────────────────────────────────
        // Written AFTER the invoice row, and separately keyed, so the two are
        // independently replay-safe: a 500 between them makes Stripe redeliver,
        // the invoice row no-ops on its unique session id and the tip row lands.
        //
        // kind='tip' is the whole mechanism. recompute_invoice_paid_for sums only
        // kind='payment', so this row cannot move amount_paid, the balance or the
        // status; isCashRow rejects it, so it cannot enter a single collected /
        // revenue / GST figure; capture_integration_event requires kind='payment',
        // so it fires no outbound payment.recorded; and paymentForIntent filters
        // kind='payment' AND amount > 0, so the refund and dispute lookups still
        // resolve exactly one row for this PaymentIntent. invoice_id IS set —
        // that linkage is what puts the tip on the right receipt, the right
        // portal row and the right customer timeline.
        if (tipCents > 0) {
          const tipRes = await sb.from('payments').upsert({
            user_id: userId,
            customer_id: s.metadata?.customer_id ?? null,
            invoice_id: invoiceId,
            amount: tipCents / 100,
            currency: s.currency ?? 'cad',
            kind: 'tip', provider: 'stripe', method: 'stripe',
            stripe_session_id: tipSessionKey(s.id),
            stripe_payment_intent: piId,
            status: 'paid',
            paid_at: now(),
            notes: 'Tip',
          }, { onConflict: 'stripe_session_id', ignoreDuplicates: true })
          if (tipRes.error) {
            console.error('[stripe] tip upsert failed:', tipRes.error.message)
            return NextResponse.json({ error: 'db write failed' }, { status: 500 })
          }
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
        // Receipt for ONE-TIME online payments too (AutoPay already sends one).
        // Gated on THIS delivery inserting the payment row (a Stripe re-delivery
        // ignores the duplicate → no second receipt); best-effort + time-boxed so
        // a slow provider never stalls the webhook 200.
        const receiptCustomer = s.metadata?.customer_id ?? null
        if ((payRes.data?.length ?? 0) > 0) {
          // Tell the owner a gratuity arrived, as its own event. Deliberately
          // NOT folded into the payment notification: a tip is money the
          // customer chose to give, and burying it inside "invoice paid" is how
          // it goes unnoticed and unthanked. Keyed on the invoice with its own
          // type, so it can't dedupe against payment_refunded/invoice_paid.
          if (tipCents > 0) {
            await notifyOnce(userId, 'tip_received', invoiceId, 'Tip received',
              `${s.metadata?.invoice_number ? s.metadata.invoice_number + ': ' : ''}${cad(tipCents / 100)} tip on top of the ${cad(invoiceCents / 100)} payment. It is recorded separately — your invoice total is unchanged.`,
              receiptCustomer)
          }
          // The receipt states the GROSS — what the customer's card was actually
          // charged, and therefore what their statement will say. The split
          // (invoice payment vs tip) lives on the portal this message links to,
          // where there is room to show it properly.
          if (receiptCustomer) {
            await Promise.race([
              sendPaymentReceipt(sb, { userId, customerId: receiptCustomer, amount: (invoiceCents + tipCents) / 100, origin }),
              new Promise<void>(resolve => setTimeout(resolve, 6000)),
            ])
          }
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
        const stripeCustomerId = card.stripeCustomerId || (typeof s.customer === 'string' ? s.customer : null)
        if (card.ok && card.paymentMethodId && stripeCustomerId) {
          const res = await saveCardForCustomer(sb, {
            userId, customerId,
            card: { paymentMethodId: card.paymentMethodId, stripeCustomerId, brand: card.brand, last4: card.last4, expMonth: card.expMonth, expYear: card.expYear },
          })
          if (res.error) {
            console.error('[stripe] payment_method upsert failed:', res.error)
            return NextResponse.json({ error: 'db write failed' }, { status: 500 })
          }
        }
      }
    }

    // ── Card saved WHILE paying an invoice (mode=payment + ticked consent) ─────
    // Runs after the payment is recorded above, and is deliberately separate from
    // it: a card that fails to save must never cast doubt on money that was taken.
    // fetchPaymentIntentCard.consented reads Stripe's setup_future_usage, which is
    // set ONLY if the customer ticked the box — so an untick lands here and saves
    // nothing. Same save path as the portal's Add-a-card, so AutoPay and "Charge
    // saved card" pick the card up with no extra wiring.
    if (s.mode === 'payment') {
      const userId = s.metadata?.user_id
      const customerId = s.metadata?.customer_id
      const paymentIntentId = typeof s.payment_intent === 'string' ? s.payment_intent : null
      if (userId && customerId && paymentIntentId) {
        const card = await fetchPaymentIntentCard(paymentIntentId)
        const stripeCustomerId = card.stripeCustomerId || (typeof s.customer === 'string' ? s.customer : null)
        if (card.ok && card.consented && card.paymentMethodId && stripeCustomerId) {
          const res = await saveCardForCustomer(sb, {
            userId, customerId,
            card: { paymentMethodId: card.paymentMethodId, stripeCustomerId, brand: card.brand, last4: card.last4, expMonth: card.expMonth, expYear: card.expYear },
          })
          // The invoice IS paid regardless — log and move on rather than 500 and
          // make Stripe replay a payment we already recorded.
          if (res.error) console.error('[stripe] saving the card offered at checkout failed:', res.error)
        }
      }
    }
  }

  // ── Saved card changed at the network (Stripe Account Updater) ───────────────
  // Card brand/last4/expiry were written ONCE, at setup, and then trusted forever.
  // But Stripe's Account Updater silently refreshes saved cards when the issuer
  // reissues them — so our copy rots while the card keeps working. That made the
  // expiry warning on the customer card LIE in the most damaging direction: it told
  // the owner "this card expired, AutoPay will decline" about a card Stripe had
  // already updated and would charge without complaint. A stale row is not a
  // cosmetic problem when the UI draws conclusions from it.
  //
  // Keyed on stripe_payment_method_id (the id is stable across an auto-update), so
  // this only ever refreshes a card we already store — it can't invent one.
  if (event.type === 'payment_method.automatically_updated' || event.type === 'payment_method.updated') {
    const pm = event.data.object as { id: string; card?: { brand?: string; last4?: string; exp_month?: number; exp_year?: number } | null }
    if (pm.id && pm.card) {
      const upd = await sb.from('payment_methods').update({
        brand: pm.card.brand ?? null, last4: pm.card.last4 ?? null,
        exp_month: pm.card.exp_month ?? null, exp_year: pm.card.exp_year ?? null,
      }).eq('stripe_payment_method_id', pm.id)
      // Let Stripe retry rather than 200 a write we didn't make — the whole point is
      // that our copy must not silently drift out of date.
      if (upd.error) {
        console.error('[stripe] payment_method refresh failed:', upd.error.message)
        return NextResponse.json({ error: 'db write failed' }, { status: 500 })
      }
    }
  }

  // ── Saved card changed at the network (Stripe Account Updater) ───────────────
  // Card brand/last4/expiry were written ONCE, at setup, and then trusted forever.
  // But Stripe's Account Updater silently refreshes saved cards when the issuer
  // reissues them — so our copy rots while the card keeps working. That made the
  // expiry warning on the customer card LIE in the most damaging direction: it told
  // the owner "this card expired, AutoPay will decline" about a card Stripe had
  // already updated and would charge without complaint. A stale row is not a
  // cosmetic problem when the UI draws conclusions from it.
  //
  // Keyed on stripe_payment_method_id (the id is stable across an auto-update), so
  // this only ever refreshes a card we already store — it can't invent one.
  if (event.type === 'payment_method.automatically_updated' || event.type === 'payment_method.updated') {
    const pm = event.data.object as { id: string; card?: { brand?: string; last4?: string; exp_month?: number; exp_year?: number } | null }
    if (pm.id && pm.card) {
      const upd = await sb.from('payment_methods').update({
        brand: pm.card.brand ?? null, last4: pm.card.last4 ?? null,
        exp_month: pm.card.exp_month ?? null, exp_year: pm.card.exp_year ?? null,
      }).eq('stripe_payment_method_id', pm.id)
      // Let Stripe retry rather than 200 a write we didn't make — the whole point is
      // that our copy must not silently drift out of date.
      if (upd.error) {
        console.error('[stripe] payment_method refresh failed:', upd.error.message)
        return NextResponse.json({ error: 'db write failed' }, { status: 500 })
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
  // EVERY refund (full or partial) lands in the LEDGER as a negative payment row
  // for the not-yet-recorded delta; the recompute_invoice_paid trigger then derives
  // amount_paid + status (paid → partial → unpaid) — the webhook never writes
  // invoice status directly (a multi-payment invoice must not flip to 'unpaid'
  // because ONE of its charges was refunded). Idempotent two ways: the row's
  // unique key encodes the CUMULATIVE refunded amount, and the delta is computed
  // against refund rows already recorded for this charge.
  if (event.type === 'charge.refunded') {
    const ch = event.data.object as { id: string; payment_intent?: string | null; amount?: number; amount_refunded?: number; refunded?: boolean }
    const piId = typeof ch.payment_intent === 'string' ? ch.payment_intent : null
    if (piId) {
      const p = await paymentForIntent(piId)
      if (p) {
        const captured = (ch.amount ?? 0) / 100
        const refunded = (ch.amount_refunded ?? 0) / 100
        const full = ch.refunded === true || (captured > 0 && refunded >= captured)
        const entityId = p.invoice_id ?? p.quote_id ?? p.id
        // ── A SCHEDULING DEPOSIT refunded ──────────────────────────────────────
        // The original row carries quote_id and no invoice_id. Both legs of the
        // deposit reverse: a negative CASH row (drops the gate's `collected`, so
        // the booking honestly stops being secured — the exact reason readiness
        // is derived and never stored) and a negative CREDIT row (the held
        // credit is gone; availableCredit must stop granting it). Same
        // cumulative-idempotent key scheme as the invoice branch below. If the
        // credit was already spent on the eventual invoice before this refund,
        // the customer's credit goes negative — signed and visible, which is the
        // honest record of refunding money that was already applied.
        if (!p.invoice_id && p.quote_id && refunded > 0) {
          const { data: prior } = await sb.from('payments').select('amount')
            .eq('user_id', p.user_id).eq('quote_id', p.quote_id).eq('kind', 'payment')
            .lt('amount', 0).like('stripe_session_id', `refund:${ch.id}:%`)
          const already = ((prior as { amount: number }[] | null) || []).reduce((s2, r) => s2 + Math.abs(Number(r.amount) || 0), 0)
          const delta = Math.round((refunded - already) * 100) / 100
          if (delta > 0.005) {
            const common = {
              user_id: p.user_id, customer_id: p.customer_id, invoice_id: null, quote_id: p.quote_id,
              currency: 'cad', status: 'paid', paid_at: now(), stripe_payment_intent: piId,
            }
            const cashRes = await sb.from('payments').upsert({
              ...common, amount: -delta, kind: 'payment', provider: 'stripe', method: 'refund',
              stripe_session_id: `refund:${ch.id}:${Math.round(refunded * 100)}`,
              notes: full ? 'Scheduling deposit refunded (Stripe)' : 'Scheduling deposit partly refunded (Stripe)',
            }, { onConflict: 'stripe_session_id', ignoreDuplicates: true })
            if (cashRes.error) {
              console.error('[stripe] quote-deposit refund cash leg failed:', cashRes.error.message)
              return NextResponse.json({ error: 'db write failed' }, { status: 500 })
            }
            const credRes = await sb.from('payments').upsert({
              ...common, amount: -delta, kind: 'credit', provider: 'credit', method: 'credit',
              stripe_session_id: `refund-credit:${ch.id}:${Math.round(refunded * 100)}`,
              notes: 'Scheduling deposit refund — held credit released',
            }, { onConflict: 'stripe_session_id', ignoreDuplicates: true })
            if (credRes.error) {
              console.error('[stripe] quote-deposit refund credit leg failed:', credRes.error.message)
              return NextResponse.json({ error: 'db write failed' }, { status: 500 })
            }
          }
          await notifyOnce(p.user_id, 'payment_refunded', entityId, full ? 'Deposit refunded' : 'Deposit partly refunded',
            `${cad(refunded)} of the scheduling deposit refunded — the booking is no longer secured by it.`, p.customer_id, 'quote')
        }
        // ── A refund on a charge that may have carried a TIP ──────────────────
        // Stripe refunds the CHARGE, and the charge is the GROSS. Booking that
        // gross against the invoice would reverse money the invoice never
        // received: a full refund of a $575 charge on a $500 invoice would drive
        // amount_paid to −$75, flip the status back to unpaid, and — the due date
        // being long past — start the payment chaser texting a customer who was
        // just given their money back. So the refund is apportioned across the
        // two legs it actually settled, TIP FIRST (see apportionRefund for why
        // that ordering, and why a wrong guess there is the cheap one).
        //
        // The split is looked up from OUR ledger by PaymentIntent, never from
        // Stripe's payload: the owner refunds in the Stripe dashboard, so no
        // refund object carries our metadata, and whether a charge mirrors its
        // PaymentIntent's metadata is API-version-sensitive on an unpinned
        // account. Both legs stay cumulative-keyed, so a re-delivery computes
        // deltas of zero and writes nothing.
        let tipDeltaApplied = 0
        let refundBasis: 'exact-tip' | 'exact-service' | 'full' | 'tip-first' | 'none' = 'none'
        if (p.invoice_id && refunded > 0) {
          const { data: prior, error: priorErr } = await sb.from('payments').select('amount')
            .eq('user_id', p.user_id).eq('invoice_id', p.invoice_id).eq('kind', 'payment')
            .lt('amount', 0).like('stripe_session_id', `refund:${ch.id}:%`)
          // Every tip leg for this charge: the positives are what was collected,
          // the negatives are what earlier deliveries already gave back.
          const { data: tipRows, error: tipErr } = await sb.from('payments').select('amount')
            .eq('user_id', p.user_id).eq('stripe_payment_intent', piId).eq('kind', 'tip')
          // A read we cannot complete would make the apportionment guess, and a
          // guess here writes money. 500 → Stripe retries the whole delivery,
          // which is safe because every write below is cumulative-keyed.
          if (priorErr || tipErr) {
            console.error('[stripe] refund apportionment read failed:', (priorErr || tipErr)?.message)
            return NextResponse.json({ error: 'db read failed' }, { status: 500 })
          }
          const alreadyInvoice = ((prior as { amount: number }[] | null) || [])
            .reduce((s, r) => s + Math.abs(Number(r.amount) || 0), 0)
          const tips = (tipRows as { amount: number }[] | null) || []
          const tipRecorded = tips.reduce((s, r) => s + Math.max(0, Number(r.amount) || 0), 0)
          const alreadyTip = tips.reduce((s, r) => s + Math.max(0, -(Number(r.amount) || 0)), 0)
          // invoiceRecorded is what THIS charge actually put against the invoice
          // — the positive kind='payment' row paymentForIntent just resolved. With
          // it, apportionRefund can recognise an exact service-only or full refund
          // instead of guessing; without it the whole thing degrades to tip-first,
          // which is why it is optional rather than required.
          const { invoiceDelta, tipDelta, basis } = apportionRefund({
            refundedTotal: refunded, alreadyInvoice, alreadyTip, tipRecorded,
            invoiceRecorded: Number(p.amount) || 0,
          })
          refundBasis = basis
          tipDeltaApplied = tipDelta
          const cumulativeCents = Math.round(refunded * 100)
          if (tipDelta > 0.005) {
            const tipRefRes = await sb.from('payments').upsert({
              user_id: p.user_id, customer_id: p.customer_id, invoice_id: p.invoice_id,
              amount: -tipDelta, currency: 'cad', provider: 'stripe', kind: 'tip', method: 'refund',
              status: 'paid', paid_at: now(),
              stripe_session_id: tipRefundKey(ch.id, cumulativeCents),
              stripe_payment_intent: piId,
              notes: 'Tip refunded (Stripe)',
            }, { onConflict: 'stripe_session_id', ignoreDuplicates: true })
            if (tipRefRes.error) {
              console.error('[stripe] tip refund ledger write failed:', tipRefRes.error.message)
              return NextResponse.json({ error: 'db write failed' }, { status: 500 })
            }
          }
          if (invoiceDelta > 0.005) {
            const refRes = await sb.from('payments').upsert({
              user_id: p.user_id, customer_id: p.customer_id, invoice_id: p.invoice_id,
              amount: -invoiceDelta, currency: 'cad', provider: 'stripe', kind: 'payment', method: 'refund',
              status: 'paid', paid_at: now(),
              stripe_session_id: `refund:${ch.id}:${cumulativeCents}`,
              stripe_payment_intent: piId,
              notes: full ? 'Full refund (Stripe)' : 'Partial refund (Stripe)',
            }, { onConflict: 'stripe_session_id', ignoreDuplicates: true })
            if (refRes.error) {
              console.error('[stripe] refund ledger write failed:', refRes.error.message)
              return NextResponse.json({ error: 'db write failed' }, { status: 500 })
            }
          }
        }
        // Name the split. The owner refunded in Stripe and told us only a total,
        // so if the apportionment guessed wrong about a PARTIAL refund this
        // sentence is what makes it correctable instead of silent.
        // Name the split AND say whether it was read or guessed. "We matched it
        // to the tip exactly" and "we had to choose, and chose the tip" are
        // different claims, and only the second one asks the owner to check.
        const tipNote = tipDeltaApplied > 0.005
          ? ` ${cad(tipDeltaApplied)} of that came off the tip${refundBasis === 'tip-first'
              ? ' — that part was a partial refund we could not match to either side, so it came off the tip first. Adjust it if that is not what you meant.'
              : '.'}`
          : ''
        await notifyOnce(p.user_id, 'payment_refunded', entityId, full ? 'Payment refunded' : 'Partial refund',
          `${p.invoiceNumber ? p.invoiceNumber + ': ' : ''}${cad(refunded)} refunded${full ? ' — the invoice balance reopened.' : '.'}${tipNote}`, p.customer_id)
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

  // ── Dispute resolved ────────────────────────────────────────────────────────
  // 'created' told the owner to go respond and then went silent forever, so the
  // outcome — the part that decides whether they still have the money — only ever
  // existed in Stripe. A LOST dispute is the dangerous one: Stripe withdraws the
  // funds and this invoice keeps reading 'paid', so the books show money that is
  // gone.
  //
  // We still don't auto-write the reversal, and here that restraint is load-bearing
  // rather than inherited: a negative row reopens the balance, the due date is long
  // past by the time a dispute closes, so dueForAutoReminder would go true and the
  // chaser would start texting payment reminders at the customer who just won the
  // chargeback. That is the one thing this must never do on its own. So: tell the
  // owner precisely what happened and let them decide.
  if (event.type === 'charge.dispute.closed') {
    const d = event.data.object as { id: string; payment_intent?: string | null; amount?: number; status?: string }
    const piId = typeof d.payment_intent === 'string' ? d.payment_intent : null
    if (piId) {
      const p = await paymentForIntent(piId)
      if (p) {
        const amount = cad((d.amount ?? 0) / 100)
        const ref = p.invoiceNumber ? p.invoiceNumber + ': ' : ''
        const lost = d.status === 'lost'
        // A disputed charge is the GROSS, so a tip inside it was withdrawn too.
        // We still write nothing (see the restraint documented above), but the
        // owner must not be told only the service half was taken back — that is
        // exactly the "pretend only the service amount was disputed" failure.
        // A failed read here degrades to no sentence, never to a wrong one.
        const { data: dTips } = await sb.from('payments').select('amount')
          .eq('user_id', p.user_id).eq('stripe_payment_intent', piId).eq('kind', 'tip')
        const disputedTip = ((dTips as { amount: number }[] | null) || [])
          .reduce((s, r) => s + (Number(r.amount) || 0), 0)
        const tipClause = disputedTip > 0.005
          ? ` That charge included a ${cad(disputedTip)} tip, which is part of the disputed amount — the tip is still recorded as received.`
          : ''
        // Distinct type per outcome so the 'created' notification never dedupes this
        // one away, and a won dispute can't be mistaken for a lost one in the list.
        if (lost) {
          await notifyOnce(p.user_id, 'payment_dispute_lost', p.invoice_id ?? p.id, 'Dispute lost — money withdrawn',
            `${ref}the ${amount} dispute was decided for the customer and Stripe has taken the money back. This invoice still shows as paid — nothing was changed automatically, because reopening the balance would start chasing them for it.${tipClause}`, p.customer_id)
        } else {
          await notifyOnce(p.user_id, 'payment_dispute_won', p.invoice_id ?? p.id, 'Dispute resolved in your favour',
            `${ref}the ${amount} dispute closed${d.status === 'won' ? ' in your favour' : ''} — you keep the payment. Nothing to do.`, p.customer_id)
        }
      }
    }
  }

  return NextResponse.json({ received: true })
}
