import type { SupabaseClient } from '@supabase/supabase-js'
import { listSucceededPaymentIntents, type StripeCharge } from '@/lib/stripe/config'

// ── Stripe ↔ ledger reconciliation (READ-ONLY) ───────────────────────────────
// The webhook is the single writer of paid-state, which is right — but it means a
// missed delivery is INVISIBLE by construction. If the endpoint was down, the secret
// was unset, or Stripe exhausted its retries, the customer's money sits in the Stripe
// account and the invoice reads unpaid forever. Nothing on our side records the
// absence, so nothing could ever notice it. The owner finds out by chasing someone
// who already paid.
//
// This asks the only question that closes that hole: for every succeeded PaymentIntent
// Stripe knows about, is there a ledger row? It WRITES NOTHING — it reports, and the
// owner decides. Recording money automatically from a sweep is a different, riskier
// feature (deliberately declined for now); finding it is unambiguously safe.
//
// Reuses the existing engines rather than restating them: listSucceededPaymentIntents
// for the Stripe side, the `payments` table for ours. `stripe_payment_intent` is the
// join key both webhook branches already persist.

export interface UnrecordedPayment extends StripeCharge {
  /** Our invoice, when the PaymentIntent metadata still names one we can resolve. */
  invoiceNumber: string | null
  /** True when metadata points at an invoice that no longer exists (or never did). */
  orphaned: boolean
}

export interface ReconcileReport {
  ok: boolean
  /** Stripe couldn't be read — say so; do NOT report "all clear". */
  error?: string
  checked: number
  unrecorded: UnrecordedPayment[]
  total: number
  /** Stripe had more history than we paged through; the report is a subset. */
  truncated: boolean
  sinceIso: string
}

const round2 = (n: number) => Math.round(n * 100) / 100

/**
 * `sb` must be able to read this owner's `payments` + `invoices` (service role, or an
 * RLS'd client for the signed-in owner). `userId` scopes our side; the Stripe side is
 * account-wide, so a PaymentIntent without resolvable ownership is reported rather
 * than silently dropped — an unrecorded payment we can't attribute is exactly the
 * kind we most need to see.
 */
export async function reconcileStripe(
  sb: SupabaseClient, p: { userId: string; sinceIso: string; maxPages?: number },
): Promise<ReconcileReport> {
  const base: ReconcileReport = { ok: false, checked: 0, unrecorded: [], total: 0, truncated: false, sinceIso: p.sinceIso }

  const stripe = await listSucceededPaymentIntents({ sinceIso: p.sinceIso, maxPages: p.maxPages })
  if (!stripe.ok) return { ...base, error: 'Could not read payments from Stripe — check the API key and try again.' }

  // Our side of the join. Asked as "which of THESE specific intents are recorded?"
  // rather than "give me every intent I've recorded", for two reasons that both end
  // in the owner double-recording money:
  //
  //  • NOT filtered by paid_at — that's the date the OWNER TYPED for a manual row
  //    (dateToIso), so a back-dated payment falls outside a date window while its
  //    PaymentIntent sits inside it, and a recorded payment reports as unrecorded.
  //  • NOT an unbounded select either — PostgREST silently caps rows (the same cap
  //    that once made future work vanish from the calendar). Past that many payments
  //    the tail drops out of the set and, again, recorded payments report as
  //    unrecorded. A cap that shows up only after N rows, on a report whose whole
  //    promise is that it's safe to act on, is the worst kind of quiet.
  //
  // Keying on the ids Stripe just handed us bounds the query by construction and
  // answers exactly the question asked. Chunked because a few hundred ids in one
  // .in() overflows the request URI.
  const wanted = stripe.charges.map(c => c.paymentIntentId)
  const recorded = new Set<string>()
  const CHUNK = 100
  for (let i = 0; i < wanted.length; i += CHUNK) {
    const { data, error } = await sb.from('payments')
      .select('stripe_payment_intent')
      .eq('user_id', p.userId)
      .in('stripe_payment_intent', wanted.slice(i, i + CHUNK))
    // A failed read must not read as "nothing recorded" — that would report every
    // charge in the chunk as stranded money.
    if (error) return { ...base, error: 'Could not read your payment ledger — try again.' }
    for (const r of ((data as { stripe_payment_intent: string | null }[]) || [])) {
      if (r.stripe_payment_intent) recorded.add(r.stripe_payment_intent)
    }
  }

  const missing = stripe.charges.filter(c => !recorded.has(c.paymentIntentId))
  if (missing.length === 0) {
    return { ok: true, checked: stripe.charges.length, unrecorded: [], total: 0, truncated: stripe.truncated, sinceIso: p.sinceIso }
  }

  // Resolve the invoice names once, so the report says "INV-1042" rather than a
  // PaymentIntent id the owner has no way to recognise.
  const ids = [...new Set(missing.map(c => c.invoiceId).filter((v): v is string => !!v))]
  const known = new Map<string, string>()
  if (ids.length > 0) {
    const { data: invs } = await sb.from('invoices')
      .select('id, invoice_number').eq('user_id', p.userId).in('id', ids)
    for (const i of ((invs as { id: string; invoice_number: string }[]) || [])) known.set(i.id, i.invoice_number)
  }

  const unrecorded: UnrecordedPayment[] = missing.map(c => ({
    ...c,
    invoiceNumber: (c.invoiceId && known.get(c.invoiceId)) || c.invoiceNumber,
    orphaned: !c.invoiceId || !known.has(c.invoiceId),
  }))

  return {
    ok: true,
    checked: stripe.charges.length,
    unrecorded,
    total: round2(unrecorded.reduce((s, c) => s + c.amount, 0)),
    truncated: stripe.truncated,
    sinceIso: p.sinceIso,
  }
}
