import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'
import { createQuoteDepositCheckoutSession, stripeEnabled } from '@/lib/stripe/config'
import { schedulingGate, type GateLedgerRow } from '@/lib/payments/depositGate'
import { tenantCapabilities, CAPABILITY_MESSAGE } from '@/lib/capabilities'
import { configuredAppOrigin } from '@/lib/appOrigin'

export const dynamic = 'force-dynamic'

// Public, token-scoped: a customer pays the SCHEDULING DEPOSIT on their accepted
// quote. The mirror of /api/portal/pay, one step earlier in the job's life — no
// invoice exists yet, so the money lands as the ledger's pre-invoice deposit
// (recordDeposit's two-leg shape, written by the webhook) welded to the quote by
// payments.quote_id.
//
// The amount is NEVER named by the client. It is the gate's `outstanding` —
// required (the quote's rule × the accepted price) minus what the ledger already
// holds — computed server-side from rows the customer cannot write. A partial
// payment simply shrinks the next ask; a satisfied gate refuses to charge at all.
export async function POST(req: NextRequest) {
  if (!stripeEnabled()) return NextResponse.json({ error: 'Payments are not set up yet.' }, { status: 503 })
  const body = await req.json().catch(() => ({}))
  const token = String(body.token || '')
  const quoteId = String(body.quoteId || '')
  if (!token || !quoteId) return NextResponse.json({ error: 'bad request' }, { status: 400 })

  // Everything below needs the service role: the token table, the quote's deposit
  // rule and the ledger rows are all owner-side data the anon key can't read.
  // Same contract as /api/portal/pay's deposit lookup: a read we cannot complete
  // is a session we must not build — never answer "couldn't check" as "no deposit".
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL, svc = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!url || !svc) {
    console.error('[portal/quote-deposit] missing Supabase service-role env')
    return NextResponse.json({ error: 'Payments are temporarily unavailable — please try again shortly.' }, { status: 502 })
  }
  const admin = createClient(url, svc)

  // The token IS the authority: it resolves to a customer, and the quote must be
  // that customer's. A forged quoteId belonging to anyone else finds no row.
  const { data: tok, error: tokErr } = await admin.from('customer_portal_tokens')
    .select('customer_id, user_id').eq('token', token).eq('revoked', false).maybeSingle()
  if (tokErr) return NextResponse.json({ error: 'We couldn’t start the payment — please try again in a moment.' }, { status: 502 })
  const t = tok as { customer_id: string; user_id: string } | null
  if (!t?.customer_id) return NextResponse.json({ error: 'This link is not valid.' }, { status: 404 })

  const { data: qRow, error: qErr } = await admin.from('quotes')
    .select('id, quote_number, service_type, status, total, accepted_price, deposit_type, deposit_value, user_id, customer_id')
    .eq('id', quoteId).eq('customer_id', t.customer_id).maybeSingle()
  if (qErr) return NextResponse.json({ error: 'We couldn’t start the payment — please try again in a moment.' }, { status: 502 })
  const quote = qRow as {
    id: string; quote_number: string; service_type: string | null; status: string
    total: number | string | null; accepted_price: number | string | null
    deposit_type: string | null; deposit_value: number | string | null
    user_id: string; customer_id: string | null
  } | null
  if (!quote) return NextResponse.json({ error: 'This quote is not available.' }, { status: 404 })

  // Tenant capability, from the owner the quote resolved to. The deposit ASK
  // stays real for every tenant (the gate still blocks scheduling); only the
  // online way of paying it is withheld — the owner records e-transfer/cash and
  // the same ledger satisfies the same gate.
  if (!(await tenantCapabilities(admin, quote.user_id)).onlinePayments) {
    return NextResponse.json({ error: CAPABILITY_MESSAGE.payments }, { status: 503 })
  }

  // A deposit secures a booking the customer has CONSENTED to. Before acceptance
  // there is nothing to secure; 'scheduled' stays payable because an owner who
  // scheduled on an override is still owed the money they explicitly deferred.
  if (quote.status !== 'accepted' && quote.status !== 'scheduled') {
    return NextResponse.json({ error: 'This quote isn’t approved yet — approve it first, then pay the deposit.' }, { status: 409 })
  }

  const { data: payRows, error: payErr } = await admin.from('payments')
    .select('amount, kind, provider, status')
    .eq('quote_id', quote.id).eq('user_id', quote.user_id)
  if (payErr) return NextResponse.json({ error: 'We couldn’t start the payment — please try again in a moment.' }, { status: 502 })

  // THE one gate — the same call the portal row and the owner's panel make.
  const gate = schedulingGate(quote, (payRows as GateLedgerRow[]) || [])
  if (gate.required <= 0) return NextResponse.json({ error: 'This quote doesn’t require a deposit.' }, { status: 409 })
  if (gate.outstanding <= 0) return NextResponse.json({ error: 'This deposit is already paid — nothing more is needed.' }, { status: 409 })

  const base = configuredAppOrigin()
  const result = await createQuoteDepositCheckoutSession(quote, {
    successUrl: `${base}/portal/${token}?paid=1`,
    cancelUrl: `${base}/portal/${token}`,
    chargeCents: Math.round(gate.outstanding * 100),
    chargeLabel: `Deposit — Quote ${quote.quote_number}`,
  })
  if (!result.ok) return NextResponse.json({ error: result.error }, { status: 502 })
  return NextResponse.json({ url: result.url })
}
