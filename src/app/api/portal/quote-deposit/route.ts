import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'
import { createQuoteDepositCheckoutSession, stripeEnabled } from '@/lib/stripe/config'
import { schedulingGate, type GateLedgerRow } from '@/lib/payments/depositGate'
import {
  acceptedPresentation, customerFacingQuote, depositChargeBlockedNote,
  type AcceptanceKind,
} from '@/lib/quoteAcceptance'
import { tenantCapabilities, CAPABILITY_MESSAGE } from '@/lib/capabilities'
import { appOrigin } from '@/lib/appOrigin'
import { portalUrl } from '@/lib/portal'

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
    return NextResponse.json({ error: 'This quote isn’t accepted yet — accept it first, then pay the deposit.' }, { status: 409 })
  }

  // ── ⭐⭐⭐ WHOSE ACCEPTANCE AUTHORISES THIS CHARGE? ────────────────────────
  // ⭐ ASKED FIRST, because it is the more specific question. The S121 fence
  // below asks whether the accepted deal has DRIFTED; it does not ask whether
  // anyone is NAMED on it — quote_acceptance_is_current takes the latest row and
  // compares fingerprints, never the kind — so a `legacy_unrecorded` backfill row
  // sails through it. That row says a deal exists and that WHO agreed to it was
  // never captured, and there is nobody to point at if this customer later asks
  // who authorised the charge.
  //
  // ⚠️ Both refuse a quote with no evidence at all, so the ORDER is about the
  // sentence, not the safety: asking about drift first told a customer with no
  // acceptance on file that their quote "has changed since it was accepted",
  // which is a confident description of something that never happened.
  //
  // ⛔ A kind too weak to say "you accepted" is too weak to take money.
  //
  // ⚠️ A FAILED READ IS NOT "no evidence" in the permissive direction — it lands
  // on `undefined`, which the presentation rule treats as unproven and refuses.
  // Never answer "couldn't check" as "go ahead", the same contract the token and
  // ledger reads above already follow.
  const { data: accRow, error: accErr } = await admin.from('quote_acceptances')
    .select('kind').eq('quote_id', quote.id).eq('user_id', quote.user_id)
    .order('seq', { ascending: false }).limit(1).maybeSingle()
  if (accErr) return NextResponse.json({ error: 'We couldn’t start the payment — please try again in a moment.' }, { status: 502 })
  const kind = (accRow as { kind: string } | null)?.kind as AcceptanceKind | null | undefined

  // ⭐ ONE call for BOTH halves — the same function the portal card, the timing
  // sentence and the customer's PDF read. The basis and the permission to charge
  // it come out together, so this door cannot price a quote it is not allowed to
  // charge, and the figure it charges is the figure that was displayed.
  const facing = customerFacingQuote(acceptedPresentation(quote.status, kind), quote)
  if (facing.depositChargeBlock) {
    // ⛔ Neither figure is substituted. Charging the sanitized total would take
    // money for a version nobody confirmed; charging the backfilled snapshot
    // would treat a number the migration COPIED as though someone had agreed to
    // it. The honest ending is a refusal plus a way out — which the customer's
    // own portal card states in the same words.
    return NextResponse.json({ error: depositChargeBlockedNote(facing.depositChargeBlock) }, { status: 409 })
  }

  // ── ⭐⭐ THE ACCEPTANCE GATE (Session 121) ─────────────────────────────────
  // Asking a customer for money is acting on the commercial terms, so it asks
  // the same question scheduling and invoicing do — through the DATABASE's half
  // of the seam (quote_acceptance_is_current), because this route has no user
  // session and cannot call the tenancy-asserting state RPC.
  //
  // The status check above is NOT this check. Status says a deal was struck
  // once; it says nothing about whether the deal on screen is still the one that
  // was agreed. Before this, an owner could accept a $5,550 quote with a 20%
  // deposit, raise it to $6,075, and the portal would charge a deposit computed
  // off the new figure against the old consent.
  //
  // ⚠️ A FAILED CHECK BLOCKS. `data !== true` covers both false and an errored
  // call — charging a card because a truth query failed is not a trade we make.
  const { data: stillCurrent, error: curErr } = await admin
    .rpc('quote_acceptance_is_current', { p_quote_id: quote.id })
  if (curErr) return NextResponse.json({ error: 'We couldn’t start the payment — please try again in a moment.' }, { status: 502 })
  if (stillCurrent !== true) {
    return NextResponse.json({
      error: 'This quote has changed since it was accepted, so we’ve paused its deposit. Please message us and we’ll send you the updated quote to look over.',
    }, { status: 409 })
  }

  const { data: payRows, error: payErr } = await admin.from('payments')
    .select('amount, kind, provider, status')
    .eq('quote_id', quote.id).eq('user_id', quote.user_id)
  if (payErr) return NextResponse.json({ error: 'We couldn’t start the payment — please try again in a moment.' }, { status: 502 })

  // THE one gate — the same call the portal row and the owner's panel make, over
  // the SAME basis object they were handed.
  const gate = schedulingGate(facing.moneyQuote, (payRows as GateLedgerRow[]) || [])
  if (gate.required <= 0) return NextResponse.json({ error: 'This quote doesn’t require a deposit.' }, { status: 409 })
  if (gate.outstanding <= 0) return NextResponse.json({ error: 'This deposit is already paid — nothing more is needed.' }, { status: 409 })

  // ⭐ ONE seam — see /api/portal/pay.
  const base = appOrigin()
  const result = await createQuoteDepositCheckoutSession(quote, {
    successUrl: portalUrl(token, base, { paid: 1 }),
    cancelUrl: portalUrl(token, base),
    chargeCents: Math.round(gate.outstanding * 100),
    chargeLabel: `Deposit — Quote ${quote.quote_number}`,
  })
  if (!result.ok) return NextResponse.json({ error: result.error }, { status: 502 })
  return NextResponse.json({ url: result.url })
}
