import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'
import { stripeEnabled, createStripeCustomer, createSetupCheckoutSession } from '@/lib/stripe/config'

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

  let stripeCustomerId = c.stripe_customer_id
  if (!stripeCustomerId) {
    const made = await createStripeCustomer({ internalCustomerId: c.id, name: c.name, email: c.email })
    if (!made.ok || !made.id) return NextResponse.json({ error: made.error || 'Could not start card setup.' }, { status: 502 })
    stripeCustomerId = made.id
    // anon can't write customers — persist the new Stripe id with the service role.
    const svc = process.env.SUPABASE_SERVICE_ROLE_KEY
    if (svc) await createClient(url, svc).from('customers').update({ stripe_customer_id: stripeCustomerId }).eq('id', c.id)
  }

  const origin = (req.nextUrl?.origin || process.env.NEXT_PUBLIC_APP_URL || '').replace(/\/$/, '')
  const result = await createSetupCheckoutSession({
    stripeCustomerId,
    successUrl: `${origin}/portal/${token}?cardsaved=1`,
    cancelUrl: `${origin}/portal/${token}`,
    metadata: { user_id: c.user_id, customer_id: c.id },
  })
  if (!result.ok) return NextResponse.json({ error: result.error }, { status: 502 })
  return NextResponse.json({ url: result.url })
}
