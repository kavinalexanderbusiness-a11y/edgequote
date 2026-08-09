import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createInvoiceCheckoutSession, stripeEnabled } from '@/lib/stripe/config'
import { ensureStripeCustomerId, type CardCustomer } from '@/lib/payments/cards'
import { depositChargeAmount } from '@/lib/payments/deposit'

export const dynamic = 'force-dynamic'

// Owner-initiated checkout: build a hosted payment link for ONE of their own
// invoices (to take a card in person or text the link). The invoice — and its
// amount — is re-read server-side, scoped to the signed-in owner; the client
// only supplies an invoiceId.
export async function POST(req: NextRequest) {
  if (!stripeEnabled()) return NextResponse.json({ error: 'Payments are not set up yet.' }, { status: 503 })
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'unauthorized' }, { status: 401 })

  const body = await req.json().catch(() => ({}))
  const invoiceId = String(body.invoiceId || '')
  if (!invoiceId) return NextResponse.json({ error: 'bad request' }, { status: 400 })

  const { data: inv } = await supabase.from('invoices')
    .select('id, invoice_number, service_type, amount, amount_paid, deposit_amount, deposit_requested_at, discount_type, discount_value, status, user_id, customer_id, customers(email)')
    .eq('id', invoiceId).eq('user_id', user.id).maybeSingle()
  if (!inv) return NextResponse.json({ error: 'invoice not found' }, { status: 404 })
  const invoice = inv as unknown as {
    id: string; invoice_number: string; service_type: string | null; amount: number | string; amount_paid: number | null
    discount_type: 'amount' | 'percent' | null; discount_value: number | null
    deposit_amount: number | string | null; deposit_requested_at: string | null
    status: string; user_id: string; customer_id: string | null; customers?: { email: string | null } | null
  }

  // How much to collect, from THE deposit engine (lib/payments/deposit) — which is
  // invoiceBalance plus one rule: while an unpaid deposit is outstanding, that is
  // what's due; otherwise it's the whole balance, clamped to it either way.
  //
  // The amount is NEVER taken from the request body. It is derived server-side from
  // the invoice's own stored deposit_amount, so a tampered client cannot choose what
  // to pay, and the owner's link and the portal's Pay button can never ask for
  // different money. This replaced an inline `total − amount_paid` — a third copy of
  // the balance rule that a deposit cap would have had to be added to separately.
  const { data: bs } = await supabase.from('business_settings').select('gst_percent').eq('user_id', user.id).maybeSingle()
  // Coerced, not cast: PostgREST hands `numeric` back as a string and `amount_paid`
  // is NULL until the first payment lands — the same `?? 0` autopay.ts uses.
  const charge = depositChargeAmount(
    {
      amount: Number(invoice.amount) || 0,
      amount_paid: Number(invoice.amount_paid) || 0,
      discount_type: invoice.discount_type,
      discount_value: invoice.discount_value,
      deposit_amount: invoice.deposit_amount,
      deposit_requested_at: invoice.deposit_requested_at,
    },
    bs as { gst_percent?: number | null } | null,
  )
  if (!(charge.amount > 0)) return NextResponse.json({ error: 'This invoice is already paid.' }, { status: 409 })

  // A card can only be offered for saving if Stripe has a Customer to attach it
  // to. Best-effort: if this fails the invoice must still be payable, so we fall
  // back to the old email-only session (pay now, no save offered).
  let stripeCustomerId: string | null = null
  if (invoice.customer_id) {
    const { data: cRow } = await supabase.from('customers')
      .select('id, name, email, stripe_customer_id').eq('id', invoice.customer_id).eq('user_id', user.id).maybeSingle()
    if (cRow) {
      const ensured = await ensureStripeCustomerId(supabase, cRow as CardCustomer, { userId: user.id })
      stripeCustomerId = ensured.id ?? null
    }
  }

  const base = (process.env.NEXT_PUBLIC_APP_URL || '').replace(/\/$/, '')
  const result = await createInvoiceCheckoutSession(invoice, {
    successUrl: `${base}/dashboard/invoices?paid=1`,
    cancelUrl: `${base}/dashboard/invoices`,
    customerEmail: invoice.customers?.email ?? null,
    chargeCents: Math.round(charge.amount * 100),
    // Same labelling rule as the portal route: a deposit charge names itself.
    chargeLabel: charge.isDeposit ? `Deposit — Invoice ${invoice.invoice_number}` : null,
    stripeCustomerId,
    // Only offer the save when we know who to save it against.
    offerSaveCard: !!stripeCustomerId,
  })
  if (!result.ok) return NextResponse.json({ error: result.error }, { status: 502 })
  return NextResponse.json({ url: result.url })
}
