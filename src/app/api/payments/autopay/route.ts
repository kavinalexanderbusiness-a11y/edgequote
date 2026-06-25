import { NextRequest, NextResponse } from 'next/server'
import { createClient as createServerClient } from '@/lib/supabase/server'
import { createClient as createServiceClient, type SupabaseClient } from '@supabase/supabase-js'
import { stripeEnabled, webhookConfigured, chargeSavedCardOffSession } from '@/lib/stripe/config'
import { invoiceTotals } from '@/lib/invoiceTotals'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

// Charge a recurring invoice to the customer's saved card OFF-SESSION. Called two
// ways: automatically by the invoicing hook the moment a recurring visit drafts an
// invoice (manual=false), and by the owner from the Invoices page (manual=true) to
// charge a held/draft invoice on demand. This route ONLY initiates the charge — the
// existing Stripe webhook records the payment + flips the invoice to paid, exactly
// like a manual payment (one writer of paid-state). Idempotency-Key + a pre-charge
// dedupe + the DB unique key mean an invoice can be charged at most once.
//
// Result codes: 'charged' (PaymentIntent submitted), 'held' (anomaly — needs the
// owner), 'skipped' (+reason: not eligible), 'declined' (charge failed → owner
// notified, invoice left unpaid). Never throws on a no-op.
export async function POST(req: NextRequest) {
  const supabase = await createServerClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'unauthorized' }, { status: 401 })

  const body = await req.json().catch(() => ({}))
  const invoiceId = String(body.invoiceId || '')
  const manual = body.manual === true   // owner-initiated → bypass autopay-enabled + anomaly hold
  if (!invoiceId) return NextResponse.json({ error: 'bad request' }, { status: 400 })

  // AutoPay refuses to charge unless the webhook is configured — otherwise money
  // could be taken with no path to mark the invoice paid.
  if (!stripeEnabled()) return NextResponse.json({ result: 'skipped', reason: 'stripe-disabled' })
  if (!webhookConfigured()) return NextResponse.json({ result: 'skipped', reason: 'webhook-unconfigured' })

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL!, svc = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!svc) return NextResponse.json({ result: 'skipped', reason: 'server-misconfigured' })
  const sb = createServiceClient(url, svc)
  const userId = user.id

  // Invoice — scoped to the owner. Must be unpaid + have a payable amount.
  const { data: invRow } = await sb.from('invoices')
    .select('id, amount, status, job_id, customer_id, invoice_number, service_type, notes')
    .eq('id', invoiceId).eq('user_id', userId).maybeSingle()
  const invoice = invRow as {
    id: string; amount: number; status: string; job_id: string | null; customer_id: string | null
    invoice_number: string; service_type: string | null; notes: string | null
  } | null
  if (!invoice) return NextResponse.json({ result: 'skipped', reason: 'no-invoice' })
  if (invoice.status === 'paid') return NextResponse.json({ result: 'skipped', reason: 'already-paid' })
  if (!invoice.customer_id) return NextResponse.json({ result: 'skipped', reason: 'no-customer' })

  // AutoPay charges ONLY recurring invoices (job_id → a job with a recurrence).
  if (!invoice.job_id) return NextResponse.json({ result: 'skipped', reason: 'not-recurring' })
  const { data: jobRow } = await sb.from('jobs').select('recurrence_id').eq('id', invoice.job_id).maybeSingle()
  if (!(jobRow as { recurrence_id: string | null } | null)?.recurrence_id) {
    return NextResponse.json({ result: 'skipped', reason: 'not-recurring' })
  }

  // Customer AutoPay state + saved card.
  const { data: custRow } = await sb.from('customers')
    .select('id, autopay_enabled, autopay_charge_mode, stripe_customer_id')
    .eq('id', invoice.customer_id).eq('user_id', userId).maybeSingle()
  const customer = custRow as { id: string; autopay_enabled: boolean | null; autopay_charge_mode: string | null; stripe_customer_id: string | null } | null
  if (!customer) return NextResponse.json({ result: 'skipped', reason: 'no-customer' })

  const { data: pmRow } = await sb.from('payment_methods')
    .select('stripe_payment_method_id, stripe_customer_id').eq('customer_id', customer.id)
    .order('is_default', { ascending: false }).order('created_at', { ascending: false }).limit(1).maybeSingle()
  const pm = pmRow as { stripe_payment_method_id: string; stripe_customer_id: string | null } | null
  if (!pm) return NextResponse.json({ result: 'skipped', reason: 'no-card' })
  const stripeCustomerId = customer.stripe_customer_id || pm.stripe_customer_id
  if (!stripeCustomerId) return NextResponse.json({ result: 'skipped', reason: 'no-stripe-customer' })

  // Automatic path: require AutoPay enabled + honour the effective charge mode.
  if (!manual) {
    if (!customer.autopay_enabled) return NextResponse.json({ result: 'skipped', reason: 'autopay-off' })
    const { data: bizRow } = await sb.from('business_settings')
      .select('autopay_charge_mode, autopay_variance_pct, gst_percent').eq('user_id', userId).maybeSingle()
    const biz = bizRow as { autopay_charge_mode: string | null; autopay_variance_pct: number | null; gst_percent: number | null } | null
    const mode = customer.autopay_charge_mode || biz?.autopay_charge_mode || 'auto'
    if (mode === 'manual_review') return NextResponse.json({ result: 'skipped', reason: 'manual-review-mode' })

    // ── Anomaly safety check ──
    // Hold (don't auto-charge) when this invoice's amount deviates from the
    // customer's usual recurring amount by more than the configured variance.
    const variancePct = Number.isFinite(Number(biz?.autopay_variance_pct)) ? Number(biz!.autopay_variance_pct) : 40
    const baseline = await usualRecurringAmount(sb, userId, customer.id, invoiceId)
    if (baseline != null && baseline > 0) {
      const deviation = Math.abs(Number(invoice.amount) - baseline) / baseline
      if (deviation > variancePct / 100) {
        await holdForReview(sb, userId, invoice, baseline)
        return NextResponse.json({ result: 'held', reason: 'amount-variance', baseline, amount: Number(invoice.amount) })
      }
    }
  }

  // Already charged? (pre-charge dedupe — the deterministic key is one-per-invoice)
  const { data: dup } = await sb.from('payments').select('id').eq('stripe_session_id', `autopay:${invoiceId}`).limit(1)
  if (dup && dup.length) return NextResponse.json({ result: 'skipped', reason: 'already-charged' })

  // GST-inclusive total — the exact amount the manual Pay flow would charge.
  const { data: bizGst } = await sb.from('business_settings').select('gst_percent').eq('user_id', userId).maybeSingle()
  const total = invoiceTotals(invoice.amount, { gst_percent: (bizGst as { gst_percent: number | null } | null)?.gst_percent }).total
  const cents = Math.round(total * 100)
  if (!(cents > 0)) return NextResponse.json({ result: 'skipped', reason: 'no-amount' })

  const charge = await chargeSavedCardOffSession({
    stripeCustomerId, paymentMethodId: pm.stripe_payment_method_id, amountCents: cents,
    invoiceId, userId, customerId: customer.id,
  })

  // Success (incl. 'processing') → the webhook records payment + flips the invoice
  // + sends the receipt. We do NOT write paid-state here (one writer).
  if (charge.ok && (charge.status === 'succeeded' || charge.status === 'processing')) {
    return NextResponse.json({ result: 'charged', status: charge.status })
  }

  // Failure (decline / SCA-required off-session) → notify the owner now (deduped
  // with the webhook's failure branch) and leave the invoice unpaid.
  await notifyChargeFailed(sb, userId, invoice, charge.declineCode)
  return NextResponse.json({ result: 'declined', reason: charge.declineCode || charge.status || 'charge-failed' })
}

// The customer's "normal" recurring invoice amount = median of their prior PAID
// recurring-origin invoices (job_id set). Returns null when there's no baseline yet
// (first recurring invoice can't be anomalous).
async function usualRecurringAmount(
  sb: SupabaseClient, userId: string, customerId: string, excludeInvoiceId: string,
): Promise<number | null> {
  const { data } = await sb.from('invoices')
    .select('id, amount').eq('user_id', userId).eq('customer_id', customerId).eq('status', 'paid')
    .not('job_id', 'is', null)
  const amounts = ((data as { id: string; amount: number }[] | null) || [])
    .filter(r => r.id !== excludeInvoiceId).map(r => Number(r.amount)).filter(n => Number.isFinite(n) && n > 0)
    .sort((a, b) => a - b)
  if (amounts.length < 2) return null   // need at least two prior visits for a stable baseline
  const mid = Math.floor(amounts.length / 2)
  return amounts.length % 2 ? amounts[mid] : (amounts[mid - 1] + amounts[mid]) / 2
}

async function holdForReview(
  sb: SupabaseClient, userId: string,
  invoice: { id: string; amount: number; customer_id: string | null; invoice_number: string; notes: string | null }, baseline: number,
): Promise<void> {
  const fmt = (n: number) => new Intl.NumberFormat('en-CA', { style: 'currency', currency: 'CAD' }).format(n)
  const note = `AutoPay held for review — ${fmt(Number(invoice.amount))} differs from the usual ~${fmt(baseline)}.`
  // Stamp the reason on the invoice (visible in the drafts list) — once.
  if (!(invoice.notes || '').includes('AutoPay held for review')) {
    await sb.from('invoices').update({ notes: `${invoice.notes ? invoice.notes + ' · ' : ''}${note}` }).eq('id', invoice.id).eq('user_id', userId)
  }
  // Notify the owner (deduped on entity_id).
  const { data: dup } = await sb.from('notifications').select('id')
    .eq('user_id', userId).eq('type', 'autopay_review').eq('entity_id', invoice.id).limit(1)
  if (!(dup && dup.length)) {
    await sb.from('notifications').insert({
      user_id: userId, type: 'autopay_review', title: 'AutoPay needs review',
      body: `${invoice.invoice_number}: ${note} Charge it manually if it looks right.`,
      customer_id: invoice.customer_id, entity_type: 'invoice', entity_id: invoice.id, href: '/dashboard/invoices',
    })
  }
}

async function notifyChargeFailed(
  sb: SupabaseClient, userId: string,
  invoice: { id: string; customer_id: string | null; invoice_number: string }, declineCode?: string,
): Promise<void> {
  const { data: dup } = await sb.from('notifications').select('id')
    .eq('user_id', userId).eq('type', 'payment_failed').eq('entity_id', invoice.id).limit(1)
  if (dup && dup.length) return
  await sb.from('notifications').insert({
    user_id: userId, type: 'payment_failed', title: 'AutoPay charge failed',
    body: `Couldn't charge the saved card for ${invoice.invoice_number}${declineCode ? ` (${declineCode})` : ''}. The invoice was left unpaid — send a payment link or update the card.`,
    customer_id: invoice.customer_id, entity_type: 'invoice', entity_id: invoice.id,
    href: invoice.customer_id ? `/dashboard/customers/${invoice.customer_id}` : '/dashboard/invoices',
  })
}
