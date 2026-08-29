import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'
import { stripeEnabled, createSetupCheckoutSession } from '@/lib/stripe/config'
import { ensureStripeCustomerId } from '@/lib/payments/cards'
import { tenantCapabilities, CAPABILITY_MESSAGE } from '@/lib/capabilities'
import { appOrigin } from '@/lib/appOrigin'
import { portalUrl } from '@/lib/portal'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

// Public, token-scoped: a customer saves/replaces a card from their portal. The
// SECURITY DEFINER RPC resolves the token → customer/user + any existing Stripe id;
// we lazily create the Stripe customer (persisted via the service role) and return a
// hosted setup-mode Checkout URL. The card is captured by the webhook on completion.
export async function POST(req: NextRequest) {
  if (!stripeEnabled()) return NextResponse.json({ error: 'Payments are not set up yet.' }, { status: 503 })
  const body = await req.json().catch(() => ({}))
  const token = String(body.token || '')
  if (!token) return NextResponse.json({ error: 'bad request' }, { status: 400 })

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL!
  const anon = createClient(url, process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!)
  const { data: cust } = await anon.rpc('portal_begin_setup', { p_token: token })
  if (!cust) return NextResponse.json({ error: 'This portal link is not valid.' }, { status: 404 })
  const c = cust as { id: string; user_id: string; name: string | null; email: string | null; stripe_customer_id: string | null }

  // Same ensure-the-Stripe-Customer path as the owner route and both checkout
  // routes. anon can't write customers, so it runs on the service role.
  const svc = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!svc) return NextResponse.json({ error: 'Could not start card setup.' }, { status: 502 })
  const admin = createClient(url, svc)
  // Tenant capability, from the owner the token resolved to — a card is only
  // ever saved to be charged into the deployment's one Stripe account.
  if (!(await tenantCapabilities(admin, c.user_id)).onlinePayments) {
    return NextResponse.json({ error: CAPABILITY_MESSAGE.payments }, { status: 503 })
  }
  const ensured = await ensureStripeCustomerId(admin, c, { userId: c.user_id })
  if (!ensured.id) return NextResponse.json({ error: ensured.error || 'Could not start card setup.' }, { status: 502 })
  const stripeCustomerId = ensured.id

  // ⚠️ WAS `cleanOrigin(req.nextUrl?.origin) || appOrigin()` — the REQUEST host
  // first. That inverts lib/appOrigin's contract (configured, then request) and
  // was the one customer-facing URL in the app built from where a request
  // happened to land: a customer arriving on an alias or a retired hostname got
  // a Stripe return address on THAT host. appOrigin(requestOrigin) keeps the
  // local-dev and preview fallback while making the configured host win.
  const origin = appOrigin(req.nextUrl?.origin)
  const result = await createSetupCheckoutSession({
    stripeCustomerId,
    successUrl: portalUrl(token, origin, { cardsaved: 1 }),
    cancelUrl: portalUrl(token, origin),
    metadata: { user_id: c.user_id, customer_id: c.id },
  })
  if (!result.ok) return NextResponse.json({ error: result.error }, { status: 502 })
  return NextResponse.json({ url: result.url })
}
