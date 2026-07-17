// ── Stripe payments layer ────────────────────────────────────────────────────
// Hosted Stripe Checkout via the raw REST API (no SDK — mirrors lib/comms). All
// server-only; never import into a client component. DISABLED until
// STRIPE_SECRET_KEY is present: every entry point checks stripeEnabled() and
// returns a friendly "not set up" instead of throwing, so Pay Now buttons can be
// wired now and light up the moment the key lands.
import crypto from 'crypto'

export function stripeEnabled(): boolean {
  return !!process.env.STRIPE_SECRET_KEY?.trim()
}
export function webhookConfigured(): boolean {
  return !!process.env.STRIPE_WEBHOOK_SECRET
}

// The ONE message any payment failure shows a user. Stripe details (response
// bodies, exceptions, headers, the key) are logged server-side and NEVER
// returned to a caller that forwards to the browser.
const GENERIC_PAYMENT_ERROR = 'Could not start payment. Please try again.'

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
  opts: {
    successUrl: string; cancelUrl: string; customerEmail?: string | null; chargeCents?: number
    // Attaching the Stripe Customer is what makes a card SAVEABLE at all — without
    // it Stripe has nobody to attach the payment method to, which is why paying an
    // invoice used to throw the card away every single time.
    stripeCustomerId?: string | null
    // Offer to keep the card for future invoices. Stripe renders its own consent
    // CHECKBOX and only sets setup_future_usage when the customer ticks it — so
    // consent is explicit, the wording is Stripe's compliant copy, and leaving it
    // unticked IS the opt-out. We never set setup_future_usage ourselves; doing so
    // would save the card silently, which is the thing we're refusing to do.
    offerSaveCard?: boolean
  },
): Promise<CheckoutResult> {
  if (!stripeEnabled()) return { ok: false, error: 'Payments are not set up yet.' }
  // chargeCents (the GST-inclusive total) wins when the caller computes it;
  // otherwise charge the invoice amount as-is.
  const cents = opts.chargeCents != null ? Math.round(opts.chargeCents) : Math.round(Number(invoice.amount) * 100)
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
  // `customer` and `customer_email` are mutually exclusive — sending both is a
  // Stripe 400. Prefer the Customer: it's the only shape a card can be saved to,
  // and Stripe shows the address/email it already knows.
  if (opts.stripeCustomerId) {
    form.set('customer', opts.stripeCustomerId)
    // Stripe owns the checkbox and its wording; it sets setup_future_usage on the
    // PaymentIntent only if the customer ticks it. The webhook reads that flag back
    // as the record of consent, so an untick saves nothing anywhere.
    if (opts.offerSaveCard) form.set('saved_payment_method_options[payment_method_save]', 'enabled')
  } else if (opts.customerEmail) {
    form.set('customer_email', opts.customerEmail)
  }
  // The webhook reads this metadata to mark the invoice paid for the right owner.
  form.set('metadata[invoice_id]', invoice.id)
  form.set('metadata[user_id]', invoice.user_id)
  if (invoice.customer_id) form.set('metadata[customer_id]', invoice.customer_id)
  form.set('metadata[invoice_number]', invoice.invoice_number)
  form.set('payment_intent_data[metadata][invoice_id]', invoice.id)

  // Read + TRIM the secret here. A stray newline/space in the env var makes fetch
  // throw a TypeError whose message embeds the header value (the key) — which is
  // exactly how the key once leaked to the browser. We trim it AND never let any
  // Stripe detail (response body, header, exception) reach the caller.
  const secret = process.env.STRIPE_SECRET_KEY?.trim()
  if (!secret) { console.error('[stripe] STRIPE_SECRET_KEY missing/blank'); return { ok: false, error: GENERIC_PAYMENT_ERROR } }
  try {
    const res = await fetch('https://api.stripe.com/v1/checkout/sessions', {
      method: 'POST',
      headers: { Authorization: `Bearer ${secret}`, 'Content-Type': 'application/x-www-form-urlencoded' },
      body: form,
    })
    if (!res.ok) {
      // Log Stripe's body server-side ONLY; the caller gets a generic message.
      const detail = await res.text().catch(() => '')
      console.error(`[stripe] checkout session HTTP ${res.status}:`, detail.slice(0, 500))
      return { ok: false, error: GENERIC_PAYMENT_ERROR }
    }
    const data = await res.json()
    return { ok: true, url: data.url }
  } catch (e) {
    // e.message can embed the Authorization header (the key) — log, never return.
    console.error('[stripe] checkout session request failed:', e)
    return { ok: false, error: GENERIC_PAYMENT_ERROR }
  }
}

// ── Card-on-file AutoPay (SetupIntents + off-session PaymentIntents) ──────────
// All raw REST, same secret-trim + server-only-logging discipline as above. These
// power "save a card" (hosted Checkout in mode=setup) and the recurring off-session
// charge. They REUSE the existing webhook to record the result, so a saved-card
// charge marks an invoice paid exactly like a manual one.

// Read + trim the secret once per call; a stray newline makes fetch embed the key
// in its error, which is exactly how the key once leaked. Returns null if absent.
function stripeSecret(): string | null {
  const s = process.env.STRIPE_SECRET_KEY?.trim()
  return s || null
}

// POST x-www-form-urlencoded to Stripe. Optional Idempotency-Key collapses retries
// into a single operation. On any non-2xx, logs Stripe's body server-side ONLY and
// returns { ok:false } with Stripe's error code (safe — a code, never the key/body).
async function stripePost(
  path: string, form: URLSearchParams, idempotencyKey?: string,
): Promise<{ ok: boolean; data?: Record<string, unknown>; status: number; code?: string; declineCode?: string }> {
  const secret = stripeSecret()
  if (!secret) { console.error('[stripe] STRIPE_SECRET_KEY missing/blank'); return { ok: false, status: 0 } }
  const headers: Record<string, string> = { Authorization: `Bearer ${secret}`, 'Content-Type': 'application/x-www-form-urlencoded' }
  if (idempotencyKey) headers['Idempotency-Key'] = idempotencyKey
  try {
    const res = await fetch(`https://api.stripe.com/v1/${path}`, { method: 'POST', headers, body: form })
    const text = await res.text().catch(() => '')
    let data: Record<string, unknown> = {}
    try { data = text ? JSON.parse(text) : {} } catch { /* non-JSON */ }
    if (!res.ok) {
      const err = (data.error as { code?: string; decline_code?: string; message?: string } | undefined) || undefined
      console.error(`[stripe] POST ${path} HTTP ${res.status}:`, text.slice(0, 500))
      return { ok: false, status: res.status, data, code: err?.code, declineCode: err?.decline_code }
    }
    return { ok: true, status: res.status, data }
  } catch (e) {
    console.error(`[stripe] POST ${path} request failed:`, e)
    return { ok: false, status: 0 }
  }
}

async function stripeGet(path: string): Promise<{ ok: boolean; data?: Record<string, unknown> }> {
  const secret = stripeSecret()
  if (!secret) return { ok: false }
  try {
    const res = await fetch(`https://api.stripe.com/v1/${path}`, { headers: { Authorization: `Bearer ${secret}` } })
    if (!res.ok) { console.error(`[stripe] GET ${path} HTTP ${res.status}`); return { ok: false } }
    return { ok: true, data: await res.json() }
  } catch (e) { console.error(`[stripe] GET ${path} failed:`, e); return { ok: false } }
}

// Create a Stripe Customer for one of OUR customers. Idempotency-Key 'cust:<id>'
// guarantees we never create two Stripe customers for the same person on retries.
export async function createStripeCustomer(
  opts: { internalCustomerId: string; name?: string | null; email?: string | null },
): Promise<{ ok: boolean; id?: string; error?: string }> {
  if (!stripeEnabled()) return { ok: false, error: 'Payments are not set up yet.' }
  const form = new URLSearchParams()
  if (opts.name) form.set('name', opts.name)
  if (opts.email) form.set('email', opts.email)
  form.set('metadata[customer_id]', opts.internalCustomerId)
  const r = await stripePost('customers', form, `cust:${opts.internalCustomerId}`)
  if (!r.ok || !r.data?.id) return { ok: false, error: GENERIC_PAYMENT_ERROR }
  return { ok: true, id: String(r.data.id) }
}

// Hosted Checkout in mode=setup — saves a card to the Stripe customer with NO
// charge and NO publishable key (Stripe-hosted, same redirect UX as Pay Now). The
// webhook captures the saved card (brand/last4/exp) on checkout.session.completed.
export async function createSetupCheckoutSession(
  opts: { stripeCustomerId: string; successUrl: string; cancelUrl: string; metadata: Record<string, string> },
): Promise<CheckoutResult> {
  if (!stripeEnabled()) return { ok: false, error: 'Payments are not set up yet.' }
  const form = new URLSearchParams()
  form.set('mode', 'setup')
  form.set('customer', opts.stripeCustomerId)
  form.set('payment_method_types[0]', 'card')
  form.set('success_url', opts.successUrl)
  form.set('cancel_url', opts.cancelUrl)
  for (const [k, v] of Object.entries(opts.metadata)) form.set(`metadata[${k}]`, v)
  const r = await stripePost('checkout/sessions', form)
  if (!r.ok || !r.data?.url) return { ok: false, error: GENERIC_PAYMENT_ERROR }
  return { ok: true, url: String(r.data.url) }
}

export interface OffSessionResult {
  ok: boolean
  status?: string          // Stripe PaymentIntent.status (e.g. 'succeeded', 'requires_action')
  paymentIntentId?: string
  error?: string           // generic, safe to surface
  declineCode?: string     // server-side detail (logged/returned to owner UI only)
}

// ── The off-session Idempotency-Key ──────────────────────────────────────────
// Stripe caches the response for a key for ~24h and replays it — INCLUDING failures.
// A single stable key per invoice therefore made a legitimate retry impossible: after
// a decline, the owner's "Charge card" replayed the cached 402 (same card), or got a
// 400 idempotency_error (new card — the params no longer match the first request).
// The customer fixes their card, the owner retries, and it still says declined. For a
// whole day.
//
// So the key now distinguishes the two callers, because they mean different things:
//
//   automatic  — the cron sweep and the on-completion fire-and-forget are the SAME
//                attempt arriving twice. Collapsing them is the entire point, and a
//                stable per-invoice key is exactly right. UNCHANGED.
//
//   manual     — the owner explicitly asking for a NEW attempt, normally because the
//                last one failed and something has since changed. Keyed per card (so
//                replacing the card retries instantly rather than 400ing) and per
//                minute (so a double-click, or a second tab, still collapses into one
//                charge).
//
// Residual, stated plainly: two manual clicks that straddle a minute boundary AND land
// before the webhook records the first could both charge. That is a far smaller risk
// than a retry path that was guaranteed broken, and the pre-charge DB dedupe in
// attemptAutoPayCharge closes it as soon as the webhook lands.
function offSessionIdempotencyKey(
  opts: { invoiceId: string; paymentMethodId: string; manual?: boolean },
): string {
  if (!opts.manual) return `autopay:${opts.invoiceId}`
  const minute = Math.floor(Date.now() / 60_000)
  return `autopay:${opts.invoiceId}:${opts.paymentMethodId}:m${minute}`
}

// Charge a SAVED card off-session for a recurring invoice. confirm=true + off_session
// attempts the charge immediately. metadata.source='autopay' is what the webhook uses
// to tell these apart from the one-time Checkout PaymentIntents (so the one-time flow
// is never double-recorded).
export async function chargeSavedCardOffSession(
  opts: {
    stripeCustomerId: string; paymentMethodId: string; amountCents: number
    invoiceId: string; userId: string; customerId: string; currency?: string
    /** Owner-initiated "Charge card" — see offSessionIdempotencyKey. */
    manual?: boolean
  },
): Promise<OffSessionResult> {
  if (!stripeEnabled()) return { ok: false, error: 'Payments are not set up yet.' }
  if (!Number.isFinite(opts.amountCents) || opts.amountCents <= 0) return { ok: false, error: 'This invoice has no payable amount.' }
  const form = new URLSearchParams()
  form.set('amount', String(Math.round(opts.amountCents)))
  form.set('currency', opts.currency || 'cad')
  form.set('customer', opts.stripeCustomerId)
  form.set('payment_method', opts.paymentMethodId)
  form.set('off_session', 'true')
  form.set('confirm', 'true')
  form.set('metadata[source]', 'autopay')
  form.set('metadata[invoice_id]', opts.invoiceId)
  form.set('metadata[user_id]', opts.userId)
  form.set('metadata[customer_id]', opts.customerId)
  const r = await stripePost('payment_intents', form, offSessionIdempotencyKey(opts))
  if (!r.ok) {
    // A decline returns the failed PaymentIntent inside error.payment_intent.
    const pi = (r.data?.error as { payment_intent?: { id?: string; status?: string } } | undefined)?.payment_intent
    return { ok: false, status: pi?.status, paymentIntentId: pi?.id, error: GENERIC_PAYMENT_ERROR, declineCode: r.declineCode || r.code }
  }
  const d = r.data || {}
  return { ok: true, status: String(d.status || ''), paymentIntentId: d.id ? String(d.id) : undefined }
}

// Resolve a completed setup Checkout/SetupIntent to its saved card details, so the
// webhook can persist brand/last4/exp. Expands payment_method in one round-trip.
export async function fetchSetupIntentCard(
  setupIntentId: string,
): Promise<{ ok: boolean; paymentMethodId?: string; stripeCustomerId?: string; brand?: string; last4?: string; expMonth?: number; expYear?: number }> {
  const r = await stripeGet(`setup_intents/${setupIntentId}?expand[]=payment_method`)
  if (!r.ok || !r.data) return { ok: false }
  const si = r.data as { customer?: string; payment_method?: { id?: string; card?: { brand?: string; last4?: string; exp_month?: number; exp_year?: number } } | string }
  const pm = typeof si.payment_method === 'object' ? si.payment_method : undefined
  return {
    ok: true,
    paymentMethodId: pm?.id || (typeof si.payment_method === 'string' ? si.payment_method : undefined),
    stripeCustomerId: typeof si.customer === 'string' ? si.customer : undefined,
    brand: pm?.card?.brand, last4: pm?.card?.last4, expMonth: pm?.card?.exp_month, expYear: pm?.card?.exp_year,
  }
}

// The mode=payment twin of fetchSetupIntentCard. `setupFutureUsage` is the whole
// point: Stripe sets it ONLY when the customer ticked "save my card", so it is the
// durable record of consent. The webhook saves nothing without it — an untick
// leaves a PaymentIntent that paid the invoice and kept no card, which is exactly
// what the customer asked for.
export async function fetchPaymentIntentCard(
  paymentIntentId: string,
): Promise<{ ok: boolean; consented: boolean; paymentMethodId?: string; stripeCustomerId?: string; brand?: string; last4?: string; expMonth?: number; expYear?: number }> {
  const r = await stripeGet(`payment_intents/${paymentIntentId}?expand[]=payment_method`)
  if (!r.ok || !r.data) return { ok: false, consented: false }
  const pi = r.data as {
    customer?: string | null
    setup_future_usage?: string | null
    payment_method?: { id?: string; card?: { brand?: string; last4?: string; exp_month?: number; exp_year?: number } } | string | null
  }
  const pm = typeof pi.payment_method === 'object' && pi.payment_method ? pi.payment_method : undefined
  return {
    ok: true,
    consented: !!pi.setup_future_usage,
    paymentMethodId: pm?.id || (typeof pi.payment_method === 'string' ? pi.payment_method : undefined),
    stripeCustomerId: typeof pi.customer === 'string' ? pi.customer : undefined,
    brand: pm?.card?.brand, last4: pm?.card?.last4, expMonth: pm?.card?.exp_month, expYear: pm?.card?.exp_year,
  }
}

// ── Reconciliation source ────────────────────────────────────────────────────
// List SUCCEEDED PaymentIntents in a window, newest first, following Stripe's
// cursor pagination. Read-only: this exists so lib/payments/reconcile can ask "did
// any of this money never reach the ledger?" — the question nobody could answer,
// because a missed webhook leaves no trace on our side by definition.
export interface StripeCharge {
  paymentIntentId: string
  /** Dollars STILL HELD — captured minus refunded. Never the gross figure. */
  amount: number
  /** Dollars refunded so far; > 0 means this charge was partially given back. */
  refunded: number
  createdIso: string
  invoiceId: string | null  // from metadata, when it was one of ours
  invoiceNumber: string | null
  description: string | null
}

// `latest_charge` is expanded because a PaymentIntent alone CANNOT answer the only
// question that matters here. A fully refunded charge leaves its PaymentIntent at
// status='succeeded' with amount_received unchanged — so filtering on status and
// reporting amount_received would present money the owner already gave back as money
// they never recorded. They'd "fix" it by recording a payment that doesn't exist.
// The refund lives on the charge, so we fetch the charge.
function chargeOf(pi: Record<string, unknown>): { refunded: number; captured: number } | null {
  // API versions ≥2022-11-15 expose latest_charge; older accounts return charges.data.
  // Support both rather than silently reporting gross amounts on an older account.
  const latest = pi.latest_charge
  const legacy = (pi.charges as { data?: Record<string, unknown>[] } | undefined)?.data?.[0]
  const ch = (latest && typeof latest === 'object' ? latest : legacy) as Record<string, unknown> | undefined
  if (!ch) return null
  return {
    refunded: (Number(ch.amount_refunded) || 0) / 100,
    captured: (Number(ch.amount_captured ?? ch.amount) || 0) / 100,
  }
}

export async function listSucceededPaymentIntents(
  opts: { sinceIso: string; maxPages?: number },
): Promise<{ ok: boolean; charges: StripeCharge[]; truncated: boolean }> {
  if (!stripeEnabled()) return { ok: false, charges: [], truncated: false }
  const createdGte = Math.floor(new Date(opts.sinceIso).getTime() / 1000)
  if (!Number.isFinite(createdGte)) return { ok: false, charges: [], truncated: false }
  const maxPages = opts.maxPages ?? 10   // 10 × 100 = 1000 intents; bounded on purpose
  const charges: StripeCharge[] = []
  let startingAfter: string | null = null

  for (let page = 0; page < maxPages; page++) {
    const q = new URLSearchParams({ limit: '100', 'created[gte]': String(createdGte) })
    q.append('expand[]', 'data.latest_charge')
    if (startingAfter) q.set('starting_after', startingAfter)
    const r = await stripeGet(`payment_intents?${q.toString()}`)
    // A partial read must not read as "nothing unrecorded" — that's the same
    // false-negative this whole report exists to eliminate.
    if (!r.ok || !r.data) return { ok: false, charges: [], truncated: false }
    const data = (r.data.data as Record<string, unknown>[] | undefined) || []
    for (const pi of data) {
      if (String(pi.status || '') !== 'succeeded') continue
      const md = (pi.metadata as Record<string, string> | null) || {}
      const ch = chargeOf(pi)
      const gross = (Number(pi.amount_received ?? pi.amount) || 0) / 100
      const refunded = ch?.refunded ?? 0
      // Net of refunds. If the charge couldn't be read at all, fall back to gross
      // rather than dropping the row — an over-reported charge gets reviewed by a
      // human; a dropped one is money that stays invisible.
      const net = Math.round(((ch ? ch.captured : gross) - refunded) * 100) / 100
      // Fully refunded → the money is NOT outstanding and never was owed. Reporting
      // it as unrecorded would invite the owner to book a payment they don't have.
      if (net <= 0.005) continue
      charges.push({
        paymentIntentId: String(pi.id),
        amount: net,
        refunded,
        createdIso: new Date((Number(pi.created) || 0) * 1000).toISOString(),
        invoiceId: md.invoice_id || null,
        invoiceNumber: md.invoice_number || null,
        description: pi.description ? String(pi.description) : null,
      })
    }
    if (!r.data.has_more || data.length === 0) return { ok: true, charges, truncated: false }
    startingAfter = String(data[data.length - 1].id)
  }
  // Hit the page cap — say so rather than quietly reporting a subset as the whole.
  return { ok: true, charges, truncated: true }
}

// Detach a saved card from Stripe (used on Remove / on replacing the old card).
// Best-effort — failure is logged, not surfaced; the DB row is the source of truth.
export async function detachPaymentMethod(paymentMethodId: string): Promise<void> {
  if (!stripeEnabled() || !paymentMethodId) return
  await stripePost(`payment_methods/${paymentMethodId}/detach`, new URLSearchParams())
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
