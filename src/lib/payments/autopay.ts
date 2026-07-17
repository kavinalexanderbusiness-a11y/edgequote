import type { SupabaseClient } from '@supabase/supabase-js'
import { stripeEnabled, webhookConfigured, chargeSavedCardOffSession } from '@/lib/stripe/config'
import { invoiceBalance } from '@/lib/payments/ledger'

// ── THE single AutoPay charge path ───────────────────────────────────────────
// Called from THREE entry points, all sharing this one function so there is exactly
// ONE charge flow (never a second payment path):
//   1. /api/payments/autopay  — the invoicing fire-and-forget on visit completion,
//      and the owner's manual "Charge card" button (manual=true).
//   2. /api/cron/autopay      — the safety-net sweep that catches charges the
//      fire-and-forget missed (closed tab / dropped request).
// It ONLY initiates the charge; the existing Stripe webhook records the payment +
// flips the invoice to paid (one writer of paid-state).
//
// Safe to call repeatedly. Two independent guards, and it's worth knowing which does
// what:
//   • the pre-charge DB dedupe below ('autopay:<invoiceId>' in payments) stops any
//     retry once a charge has actually been RECORDED — the durable guarantee;
//   • the Stripe Idempotency-Key collapses entry points racing before the webhook has
//     landed (see offSessionIdempotencyKey — stable per invoice for the automatic
//     path; per-attempt for a manual charge, because a stable key made retrying after
//     a decline impossible for 24h).
//
// Result codes: 'charged' (PaymentIntent submitted), 'held' (anomaly — needs owner),
// 'skipped' (+reason: ineligible/no-op), 'declined' (charge failed → owner notified,
// invoice left unpaid). NEVER throws on a no-op.

export type AutoPayResultCode = 'charged' | 'held' | 'skipped' | 'declined'
// THE hold marker. It was a bare string literal in three places, and they didn't
// even agree — the engine wrote/checked 'AutoPay held for review' while the
// invoices page matched the shorter 'AutoPay held'. One constant, so a wording
// change can't silently strand a held invoice with no banner and no confirm.
export const AUTOPAY_HOLD_FLAG = 'AutoPay held for review'

// Does this invoice carry the hold? Reads internal_notes (never the customer's
// `notes`), so the flag can't be edited away by fixing a customer-facing typo.
export function isAutoPayHeld(inv: { internal_notes?: string | null }): boolean {
  return (inv.internal_notes || '').includes(AUTOPAY_HOLD_FLAG)
}

export interface AutoPayChargeResult {
  result: AutoPayResultCode
  reason?: string
  status?: string
  baseline?: number
  amount?: number
}

interface InvoiceRow {
  id: string; amount: number; amount_paid: number | null; status: string; job_id: string | null; customer_id: string | null
  discount_type: 'amount' | 'percent' | null; discount_value: number | null
  invoice_number: string; service_type: string | null; internal_notes: string | null
}

// `sb` MUST be a service-role client. The caller is responsible for verifying that
// `userId` owns `invoiceId` (the route does it via auth + .eq('user_id'); the cron
// passes each invoice's own user_id from a service-role query).
export async function attemptAutoPayCharge(
  sb: SupabaseClient, opts: { invoiceId: string; userId: string; manual?: boolean },
): Promise<AutoPayChargeResult> {
  const { invoiceId, userId, manual = false } = opts

  // AutoPay refuses to charge unless the webhook is configured — otherwise money
  // could be taken with no path to mark the invoice paid.
  if (!stripeEnabled()) return { result: 'skipped', reason: 'stripe-disabled' }
  if (!webhookConfigured()) return { result: 'skipped', reason: 'webhook-unconfigured' }

  // Invoice — scoped to the owner. Must be unpaid + have a payable amount.
  // amount_paid/discount are selected because the charge is the BALANCE, not the
  // total — a partly-paid invoice must never be charged twice for the paid part.
  const { data: invRow } = await sb.from('invoices')
    .select('id, amount, amount_paid, discount_type, discount_value, status, job_id, customer_id, invoice_number, service_type, internal_notes')
    .eq('id', invoiceId).eq('user_id', userId).maybeSingle()
  const invoice = invRow as InvoiceRow | null
  if (!invoice) return { result: 'skipped', reason: 'no-invoice' }
  if (invoice.status === 'paid') return { result: 'skipped', reason: 'already-paid' }
  if (!invoice.customer_id) return { result: 'skipped', reason: 'no-customer' }

  // AutoPay charges ONLY recurring invoices (job_id → a job with a recurrence).
  if (!invoice.job_id) return { result: 'skipped', reason: 'not-recurring' }
  const { data: jobRow } = await sb.from('jobs').select('recurrence_id').eq('id', invoice.job_id).maybeSingle()
  if (!(jobRow as { recurrence_id: string | null } | null)?.recurrence_id) {
    return { result: 'skipped', reason: 'not-recurring' }
  }

  // Customer AutoPay state + saved card.
  const { data: custRow } = await sb.from('customers')
    .select('id, autopay_enabled, autopay_charge_mode, stripe_customer_id')
    .eq('id', invoice.customer_id).eq('user_id', userId).maybeSingle()
  const customer = custRow as { id: string; autopay_enabled: boolean | null; autopay_charge_mode: string | null; stripe_customer_id: string | null } | null
  if (!customer) return { result: 'skipped', reason: 'no-customer' }

  const { data: pmRow } = await sb.from('payment_methods')
    .select('stripe_payment_method_id, stripe_customer_id').eq('customer_id', customer.id)
    .order('is_default', { ascending: false }).order('created_at', { ascending: false }).limit(1).maybeSingle()
  const pm = pmRow as { stripe_payment_method_id: string; stripe_customer_id: string | null } | null
  if (!pm) return { result: 'skipped', reason: 'no-card' }
  const stripeCustomerId = customer.stripe_customer_id || pm.stripe_customer_id
  if (!stripeCustomerId) return { result: 'skipped', reason: 'no-stripe-customer' }

  // Automatic path: require AutoPay enabled + honour the effective charge mode.
  if (!manual) {
    if (!customer.autopay_enabled) return { result: 'skipped', reason: 'autopay-off' }
    const { data: bizRow } = await sb.from('business_settings')
      .select('autopay_charge_mode, autopay_variance_pct').eq('user_id', userId).maybeSingle()
    const biz = bizRow as { autopay_charge_mode: string | null; autopay_variance_pct: number | null } | null
    const mode = customer.autopay_charge_mode || biz?.autopay_charge_mode || 'auto'
    if (mode === 'manual_review') return { result: 'skipped', reason: 'manual-review-mode' }

    // ── Anomaly safety check ──
    const variancePct = Number.isFinite(Number(biz?.autopay_variance_pct)) ? Number(biz!.autopay_variance_pct) : 40
    const baseline = await usualRecurringAmount(sb, userId, customer.id, invoiceId)
    if (baseline != null && baseline > 0) {
      const deviation = Math.abs(Number(invoice.amount) - baseline) / baseline
      if (deviation > variancePct / 100) {
        await holdForReview(sb, userId, invoice, baseline)
        return { result: 'held', reason: 'amount-variance', baseline, amount: Number(invoice.amount) }
      }
    }
  }

  // Already charged? (pre-charge dedupe — the deterministic key is one-per-invoice)
  const { data: dup } = await sb.from('payments').select('id').eq('stripe_session_id', `autopay:${invoiceId}`).limit(1)
  if (dup && dup.length) return { result: 'skipped', reason: 'already-charged' }

  // The GST-inclusive BALANCE — the exact amount the manual Pay flow charges, via
  // the same ledger definition it uses (invoiceBalance).
  //
  // This used to charge invoiceTotals(...).total and never selected amount_paid,
  // while the gate above only excludes 'paid' — so a PARTIAL invoice (customer
  // already sent $30 of $65) was chargeable for the full $65. The one-charge-per-
  // invoice dedupe hid it for the cron path, but `manual: true` retries re-enter
  // here. Charging the balance is what every other charge path already does.
  const { data: bizGst } = await sb.from('business_settings').select('gst_percent').eq('user_id', userId).maybeSingle()
  const { balance } = invoiceBalance(
    {
      amount: invoice.amount,
      amount_paid: invoice.amount_paid ?? 0, // DB null → nothing collected yet
      discount_type: invoice.discount_type,
      discount_value: invoice.discount_value,
    },
    { gst_percent: (bizGst as { gst_percent: number | null } | null)?.gst_percent },
  )
  const cents = Math.round(balance * 100)
  if (!(cents > 0)) return { result: 'skipped', reason: 'no-amount' }

  const charge = await chargeSavedCardOffSession({
    stripeCustomerId, paymentMethodId: pm.stripe_payment_method_id, amountCents: cents,
    invoiceId, userId, customerId: customer.id,
    // Tells the Stripe layer this is a deliberate new attempt, not the cron and the
    // fire-and-forget racing over the same one — see offSessionIdempotencyKey.
    manual,
  })

  // Success (incl. 'processing') → the webhook records payment + flips the invoice +
  // sends the receipt. We do NOT write paid-state here (one writer).
  if (charge.ok && (charge.status === 'succeeded' || charge.status === 'processing')) {
    console.log(`[autopay] charged ${invoice.invoice_number} (${invoiceId}) — ${cents}¢, status=${charge.status}`)
    return { result: 'charged', status: charge.status }
  }

  // Failure (decline / SCA-required off-session) → notify the owner now (deduped with
  // the webhook's failure branch) and leave the invoice unpaid.
  console.warn(`[autopay] declined ${invoice.invoice_number} (${invoiceId}) — ${charge.declineCode || charge.status || 'charge-failed'}`)
  await notifyChargeFailed(sb, userId, invoice, charge.declineCode)
  return { result: 'declined', reason: charge.declineCode || charge.status || 'charge-failed' }
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
  if (amounts.length < 2) return null
  const mid = Math.floor(amounts.length / 2)
  return amounts.length % 2 ? amounts[mid] : (amounts[mid - 1] + amounts[mid]) / 2
}

async function holdForReview(
  sb: SupabaseClient, userId: string,
  invoice: { id: string; amount: number; customer_id: string | null; invoice_number: string; internal_notes: string | null }, baseline: number,
): Promise<void> {
  const fmt = (n: number) => new Intl.NumberFormat('en-CA', { style: 'currency', currency: 'CAD' }).format(n)
  const note = `${AUTOPAY_HOLD_FLAG} — ${fmt(Number(invoice.amount))} differs from the usual ~${fmt(baseline)}.`
  // Both the flag and its reason live in internal_notes now. This used to write to
  // `notes`, which meant the customer's invoice printed the owner's own pricing
  // baseline ("$450 differs from the usual ~$120") — and, since invoices became
  // editable after approval, the owner retyping that note would silently un-hold
  // the charge, because the flag WAS the customer-facing string.
  if (!(invoice.internal_notes || '').includes(AUTOPAY_HOLD_FLAG)) {
    await sb.from('invoices').update({ internal_notes: `${invoice.internal_notes ? invoice.internal_notes + ' · ' : ''}${note}` }).eq('id', invoice.id).eq('user_id', userId)
  }
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
