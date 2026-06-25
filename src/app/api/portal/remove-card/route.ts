import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'
import { detachPaymentMethod } from '@/lib/stripe/config'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

// Public, token-scoped: a customer removes their saved card. The SECURITY DEFINER
// RPC deletes the metadata rows for the token's customer + disables AutoPay and
// returns the Stripe payment_method id(s) so we can detach them from Stripe.
export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => ({}))
  const token = String(body.token || '')
  if (!token) return NextResponse.json({ error: 'bad request' }, { status: 400 })

  const anon = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!)
  const { data, error } = await anon.rpc('portal_remove_card', { p_token: token })
  if (error || data == null) return NextResponse.json({ error: 'This portal link is not valid.' }, { status: 404 })
  const ids = (data as string[]) || []
  for (const id of ids) await detachPaymentMethod(id)
  return NextResponse.json({ ok: true })
}
