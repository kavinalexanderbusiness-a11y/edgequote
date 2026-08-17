import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'
import { createInvoiceCheckoutSession, stripeEnabled } from '@/lib/stripe/config'
import { ensureStripeCustomerId, type CardCustomer } from '@/lib/payments/cards'
import { depositChargeAmount } from '@/lib/payments/deposit'
import { tenantCapabilities, CAPABILITY_MESSAGE } from '@/lib/capabilities'
import { appOrigin } from '@/lib/appOrigin'
import { tipConfig, resolveTipCents, tipRejectionMessage, type TipSettings } from '@/lib/payments/tips'

export const dynamic = 'force-dynamic'

// Public, token-scoped: a customer pays an invoice from their portal. The RPC
// (SECURITY DEFINER) verifies the invoice belongs to the token's customer AND is
// still owing, and returns the amount — so a malicious client can't pay/peek
// another customer's invoice or tamper with the amount.
export async function POST(req: NextRequest) {
  if (!stripeEnabled()) return NextResponse.json({ error: 'Payments are not set up yet.' }, { status: 503 })
  const body = await req.json().catch(() => ({}))
  const token = String(body.token || '')
  const invoiceId = String(body.invoiceId || '')
  if (!token || !invoiceId) return NextResponse.json({ error: 'bad request' }, { status: 400 })

  const anon = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!)
  const { data: invJson } = await anon.rpc('portal_invoice_for_payment', { p_token: token, p_invoice_id: invoiceId })
  if (!invJson) return NextResponse.json({ error: 'This invoice is not available to pay.' }, { status: 404 })
  const invoice = invJson as {
    id: string; invoice_number: string; service_type: string | null; amount: number | string; amount_paid?: number | null
    status: string; user_id: string; customer_id: string | null; gst_percent?: number | null
  }
  // Charge the remaining BALANCE (GST-inclusive total minus payments already
  // recorded). The RPC doesn't return gst_percent, so resolve it from the owner's
  // business_settings server-side (service role — anon can't read settings); a
  // GST-registered business must charge tax on portal payments too.
  // The RPC also predates deposits, so the deposit columns come from the same
  // service-role read as the GST rate. WITHOUT this the portal charges the full
  // balance while the owner's payment link charges the deposit — the two surfaces
  // asking one customer for different money for the same invoice, which is the
  // exact disagreement depositChargeAmount exists to prevent. Resolved here rather
  // than by widening portal_invoice_for_payment: that RPC sits in a chain of
  // `create or replace` definitions where re-issuing an older link silently rolls
  // back get_portal_data (see the migration audit).
  let gst = Number(invoice.gst_percent)
  let depositAmount: number | null = null
  let depositRequestedAt: string | null = null
  // The owner's gratuity configuration, resolved from the same service-role read
  // as the GST rate. Never from the client: the browser tells us what the
  // customer CHOSE, and this tells us what they were allowed to choose.
  let tips = tipConfig(null)
  {
    const url = process.env.NEXT_PUBLIC_SUPABASE_URL, svc = process.env.SUPABASE_SERVICE_ROLE_KEY
    // The deposit columns are what decide HOW MUCH this session charges, and the
    // portal has just shown the customer that figure. So a read we cannot
    // complete is a session we must not build: "couldn't check the deposit"
    // answered as "no deposit" would charge the FULL balance behind a button
    // that said "Pay $2,000 deposit" — the exact display-vs-charge split this
    // route exists to prevent, reachable by nothing more than a transient
    // failure on this one query. Refuse (502) and let the customer tap again;
    // the client already shows "couldn't start the payment — try again" for
    // exactly this status. (Same contract as a missing service key: we cannot
    // know the ask, so we do not guess it.)
    if (!url || !svc) {
      console.error('[portal/pay] missing Supabase service-role env — cannot resolve the deposit ask')
      return NextResponse.json({ error: 'Payments are temporarily unavailable — please try again shortly.' }, { status: 502 })
    }
    const admin = createClient(url, svc)
    // Tenant capability, from the OWNER the invoice resolved to — never from the
    // client. A business without the online_payments grant must not have its
    // customers charged into the deployment's one Stripe account; the portal
    // hides Pay buttons for it, and this is the server half the portal can't
    // reach around.
    if (!(await tenantCapabilities(admin, invoice.user_id)).onlinePayments) {
      return NextResponse.json({ error: CAPABILITY_MESSAGE.payments }, { status: 503 })
    }
    if (!Number.isFinite(gst)) {
      const { data: bs, error: bsErr } = await admin.from('business_settings').select('gst_percent').eq('user_id', invoice.user_id).maybeSingle()
      if (bsErr) return NextResponse.json({ error: 'We couldn’t start the payment — please try again in a moment.' }, { status: 502 })
      gst = Number((bs as { gst_percent?: number | null } | null)?.gst_percent) || 0
    }
    // ── The tip configuration, read SEPARATELY and on purpose ────────────────
    // Not folded into the GST select above, because these three columns arrive
    // in a migration and PostgREST fails the WHOLE select on a column it does
    // not know. Merged, this route would 502 on every payment attempt in the
    // window between the code deploying and the migration being applied — the
    // Pay button dead for a feature nobody had switched on yet. Separate, the
    // deploy is order-independent: pre-migration this read errors, `tips` stays
    // TIPS_OFF, and the route behaves exactly as it does today.
    //
    // The refusal contract is therefore conditional on INTENT, not on the read:
    //   • no tip requested → an unreadable tip config changes nothing. Proceed.
    //   • a tip requested  → we cannot confirm the customer was allowed to give
    //     it, or what the ceiling was. Refuse (502) rather than charge an
    //     unverified gratuity. `resolveTipCents` reaches the same conclusion
    //     from TIPS_OFF, but it would report it as "tips are disabled" — which
    //     is a claim about the owner's settings we have not actually read.
    const { data: tipRow, error: tipErr } = await admin.from('business_settings')
      .select('tips_enabled, tip_presets, tip_custom_enabled')
      .eq('user_id', invoice.user_id).maybeSingle()
    if (tipErr) {
      if (body.tipCents) {
        console.error('[portal/pay] could not read the tip configuration:', tipErr.message)
        return NextResponse.json({ error: 'We couldn’t start the payment — please try again in a moment.' }, { status: 502 })
      }
    } else {
      tips = tipConfig(tipRow as TipSettings | null)
    }
    const { data: dep, error: depErr } = await admin.from('invoices')
      .select('deposit_amount, deposit_requested_at').eq('id', invoice.id).eq('user_id', invoice.user_id).maybeSingle()
    if (depErr) return NextResponse.json({ error: 'We couldn’t start the payment — please try again in a moment.' }, { status: 502 })
    const d = dep as { deposit_amount: number | string | null; deposit_requested_at: string | null } | null
    depositAmount = d?.deposit_amount == null ? null : Number(d.deposit_amount)
    depositRequestedAt = d?.deposit_requested_at ?? null
  }
  if (!Number.isFinite(gst)) gst = 0

  // THE one collection rule, shared with the owner's checkout route: an outstanding
  // deposit is what's due, otherwise the whole balance — clamped to the balance
  // either way. The customer NEVER names an amount; it is derived from the invoice
  // the owner controls.
  //
  // Discount columns aren't in the RPC's projection and don't need to be: a discount
  // is already inside the stored `amount`, and invoiceTotals only reads it to
  // reconstruct the pre-discount subtotal for DISPLAY — `.total` is identical either
  // way. (The dashboard route passes them because it renders that breakdown.)
  const charge = depositChargeAmount(
    {
      amount: Number(invoice.amount) || 0,
      amount_paid: Number(invoice.amount_paid) || 0,
      discount_type: null, discount_value: null,
      deposit_amount: depositAmount, deposit_requested_at: depositRequestedAt,
    },
    { gst_percent: gst },
  )
  if (!(charge.amount > 0)) return NextResponse.json({ error: 'This invoice is already paid.' }, { status: 409 })
  const chargeCents = Math.round(charge.amount * 100)

  // ── The tip: intent from the browser, money from here ───────────────────────
  // `body.tipCents` is the ONLY figure this route ever accepts from a client, and
  // it is not an amount owed — it is a request. resolveTipCents re-derives
  // whether this business takes tips, whether THIS charge may carry one, and
  // what the ceiling is, from state the browser cannot reach. A tampered value
  // is rejected, not clamped: a customer charged $1,000 after asking for $5,000
  // has been overcharged from where they sit, so the honest answer is to refuse
  // and let the portal re-render.
  //
  // ⛔ NOT TIPPABLE: a DEPOSIT / part payment (charge.isDeposit). The deposit ask
  // is a number the business has already communicated — "you cannot text someone
  // $1,500 and then charge them something else" — and a tip would make Stripe's
  // total disagree with it at the exact moment the card is out. That is the
  // display-vs-charge split the whole deposit lane exists to prevent. A tip is
  // offered on the payment that CLOSES the invoice, which includes the final
  // instalment of a part-paid one. AutoPay is untippable for a simpler reason:
  // nobody is present to choose.
  const tip = resolveTipCents(body.tipCents, { chargeCents, config: tips, tippable: !charge.isDeposit })
  if (tip.rejected) {
    return NextResponse.json({ error: tipRejectionMessage(tip.rejected, chargeCents) }, { status: 400 })
  }

  // The customer paying their own invoice is the ONE moment they already have the
  // card out — so it's the only moment worth offering to keep it. Needs a Stripe
  // Customer to attach to, which needs the service role (anon can't touch
  // customers). Best-effort throughout: if any of it fails the invoice must still
  // be payable, so we fall back to a plain session with no save offered.
  let stripeCustomerId: string | null = null
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL, svc = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (url && svc && invoice.customer_id) {
    const admin = createClient(url, svc)
    const { data: cRow } = await admin.from('customers')
      .select('id, name, email, stripe_customer_id').eq('id', invoice.customer_id).eq('user_id', invoice.user_id).maybeSingle()
    if (cRow) {
      const ensured = await ensureStripeCustomerId(admin, cRow as CardCustomer, { userId: invoice.user_id })
      stripeCustomerId = ensured.id ?? null
    }
  }

  const base = appOrigin()
  const result = await createInvoiceCheckoutSession(invoice, {
    successUrl: `${base}/portal/${token}?paid=1`,
    cancelUrl: `${base}/portal/${token}`,
    chargeCents,
    tipCents: tip.cents,
    // Stripe's page is where the customer decides the smaller number is right —
    // name the charge as the deposit it is, or $2,000 against a $4,000 invoice
    // reads as an error at the exact moment their card is out.
    chargeLabel: charge.isDeposit ? `Deposit — Invoice ${invoice.invoice_number}` : null,
    stripeCustomerId,
    offerSaveCard: !!stripeCustomerId,
  })
  if (!result.ok) return NextResponse.json({ error: result.error }, { status: 502 })
  return NextResponse.json({ url: result.url })
}
