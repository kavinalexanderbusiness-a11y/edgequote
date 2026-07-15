import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { stripeEnabled, createSetupCheckoutSession } from '@/lib/stripe/config'
import { ensureStripeCustomerId } from '@/lib/payments/cards'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

// Owner-initiated "save / replace card" for a customer. Ensures the customer has a
// Stripe customer id (lazily creating + persisting it) and returns a hosted Checkout
// URL in mode=setup. The webhook captures the saved card on completion — the card
// number never touches our servers.
export async function POST(req: NextRequest) {
  if (!stripeEnabled()) return NextResponse.json({ error: 'Payments are not set up yet.' }, { status: 503 })
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'unauthorized' }, { status: 401 })

  const body = await req.json().catch(() => ({}))
  const customerId = String(body.customerId || '')
  if (!customerId) return NextResponse.json({ error: 'bad request' }, { status: 400 })

  const { data: cRow } = await supabase.from('customers')
    .select('id, name, email, stripe_customer_id').eq('id', customerId).eq('user_id', user.id).maybeSingle()
  const customer = cRow as { id: string; name: string; email: string | null; stripe_customer_id: string | null } | null
  if (!customer) return NextResponse.json({ error: 'customer not found' }, { status: 404 })

  // ONE ensure-the-Stripe-Customer path, shared with the portal setup route and
  // both invoice-checkout routes — a second copy is a second way to mint a
  // duplicate Customer and attach the card to the wrong one.
  const ensured = await ensureStripeCustomerId(supabase, customer, { userId: user.id })
  if (!ensured.id) return NextResponse.json({ error: ensured.error || 'Could not start card setup.' }, { status: 502 })
  const stripeCustomerId = ensured.id

  const origin = (req.nextUrl?.origin || process.env.NEXT_PUBLIC_APP_URL || '').replace(/\/$/, '')
  const result = await createSetupCheckoutSession({
    stripeCustomerId,
    successUrl: `${origin}/dashboard/customers/${customer.id}?cardsaved=1`,
    cancelUrl: `${origin}/dashboard/customers/${customer.id}`,
    metadata: { user_id: user.id, customer_id: customer.id },
  })
  if (!result.ok) return NextResponse.json({ error: result.error }, { status: 502 })
  return NextResponse.json({ url: result.url })
}
