// ── Stripe payments layer ────────────────────────────────────────────────────
// Hosted Stripe Checkout via the raw REST API (no SDK — mirrors lib/comms). All
// server-only; never import into a client component. DISABLED until
// STRIPE_SECRET_KEY is present: every entry point checks stripeEnabled() and
// returns a friendly "not set up" instead of throwing, so Pay Now buttons can be
// wired now and light up the moment the key lands.
import crypto from 'crypto'

export function stripeEnabled(): boolean {
  return !!process.env.STRIPE_SECRET_KEY
}
export function webhookConfigured(): boolean {
  return !!process.env.STRIPE_WEBHOOK_SECRET
}

export interface CheckoutInvoice {
  id: string
  invoice_number: string
  service_type: string | null
  amount: number | string
  user_id: string
  customer_id: string | null
}

export interface CheckoutResult { ok: boolean; url?: string; error?: string }

// Build a hosted Checkout Session for ONE invoice. The amount is derived from the
// invoice row server-side — NEVER from the client — and the webhook metadata is
// what lets us mark exactly the right invoice paid for the right owner.
export async function createInvoiceCheckoutSession(
  invoice: CheckoutInvoice,
  opts: { successUrl: string; cancelUrl: string; customerEmail?: string | null },
): Promise<CheckoutResult> {
  if (!stripeEnabled()) return { ok: false, error: 'Payments are not set up yet.' }
  const cents = Math.round(Number(invoice.amount) * 100)
  if (!Number.isFinite(cents) || cents <= 0) return { ok: false, error: 'This invoice has no payable amount.' }

  const form = new URLSearchParams()
  form.set('mode', 'payment')
  form.set('success_url', opts.successUrl)
  form.set('cancel_url', opts.cancelUrl)
  form.set('client_reference_id', invoice.id)
  form.set('line_items[0][quantity]', '1')
  form.set('line_items[0][price_data][currency]', 'cad')
  form.set('line_items[0][price_data][unit_amount]', String(cents))
  form.set('line_items[0][price_data][product_data][name]', `Invoice ${invoice.invoice_number}`)
  if (invoice.service_type) form.set('line_items[0][price_data][product_data][description]', invoice.service_type.slice(0, 200))
  if (opts.customerEmail) form.set('customer_email', opts.customerEmail)
  // The webhook reads this metadata to mark the invoice paid for the right owner.
  form.set('metadata[invoice_id]', invoice.id)
  form.set('metadata[user_id]', invoice.user_id)
  if (invoice.customer_id) form.set('metadata[customer_id]', invoice.customer_id)
  form.set('metadata[invoice_number]', invoice.invoice_number)
  form.set('payment_intent_data[metadata][invoice_id]', invoice.id)

  try {
    const res = await fetch('https://api.stripe.com/v1/checkout/sessions', {
      method: 'POST',
      headers: { Authorization: `Bearer ${process.env.STRIPE_SECRET_KEY!}`, 'Content-Type': 'application/x-www-form-urlencoded' },
      body: form,
    })
    if (!res.ok) {
      // Surface Stripe's exact error (e.g. {"error":{"message":"Invalid API Key"}}).
      const detail = await res.text().catch(() => '')
      let msg = `Stripe ${res.status}`
      try { const j = JSON.parse(detail); if (j?.error?.message) msg = `Stripe ${res.status}: ${j.error.message}` } catch { if (detail) msg += `: ${detail.slice(0, 300)}` }
      return { ok: false, error: msg }
    }
    const data = await res.json()
    return { ok: true, url: data.url }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : 'Could not reach Stripe.' }
  }
}

// Verify a Stripe webhook signature WITHOUT the SDK: HMAC-SHA256 over
// `${timestamp}.${rawBody}`, timing-safe compared against any v1 signature, with
// a 5-minute replay window. Returns the parsed event ONLY when authentic — the
// caller must trust nothing until ok === true.
export function constructWebhookEvent(
  rawBody: string, sigHeader: string | null,
): { ok: boolean; event?: Record<string, unknown>; error?: string } {
  const secret = process.env.STRIPE_WEBHOOK_SECRET
  if (!secret) return { ok: false, error: 'webhook secret not configured' }
  if (!sigHeader) return { ok: false, error: 'missing signature' }
  const parts = sigHeader.split(',').map(s => s.split('='))
  const t = parts.find(([k]) => k === 't')?.[1]
  const v1s = parts.filter(([k]) => k === 'v1').map(([, v]) => v)
  if (!t || v1s.length === 0) return { ok: false, error: 'malformed signature' }
  if (Math.abs(Date.now() / 1000 - Number(t)) > 300) return { ok: false, error: 'timestamp outside tolerance' }
  const expected = crypto.createHmac('sha256', secret).update(`${t}.${rawBody}`, 'utf8').digest('hex')
  const expBuf = Buffer.from(expected)
  const match = v1s.some(v => { const b = Buffer.from(v); return b.length === expBuf.length && crypto.timingSafeEqual(b, expBuf) })
  if (!match) return { ok: false, error: 'signature mismatch' }
  try { return { ok: true, event: JSON.parse(rawBody) } } catch { return { ok: false, error: 'invalid json' } }
}
