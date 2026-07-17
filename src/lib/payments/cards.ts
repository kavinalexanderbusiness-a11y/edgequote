import type { SupabaseClient } from '@supabase/supabase-js'
import { createStripeCustomer, detachPaymentMethod } from '@/lib/stripe/config'

// ── Saved-card plumbing, in ONE place ────────────────────────────────────────
// Two things every card path needs, extracted so the checkout (mode=payment) save
// and the portal "Add a card" (mode=setup) save cannot drift apart:
//   1. ensureStripeCustomerId — a card can only be SAVED against a Stripe
//      Customer, so every flow that might save one has to mint it the same way.
//      This was already copy-pasted in two setup-card routes; adding checkout
//      would have made four.
//   2. saveCardForCustomer — the write. Its ordering is load-bearing (below), and
//      that reasoning must not exist twice.
// No new payment flow: this is the same Stripe architecture, called from one place.

export interface CardCustomer {
  id: string
  name?: string | null
  email?: string | null
  stripe_customer_id?: string | null
}

// The Stripe Customer for one of our customers, creating it on first need and
// persisting the id so we only ever mint one per person.
export async function ensureStripeCustomerId(
  sb: SupabaseClient,
  customer: CardCustomer,
  opts?: { userId?: string },
): Promise<{ id?: string; error?: string }> {
  if (customer.stripe_customer_id) return { id: customer.stripe_customer_id }
  const made = await createStripeCustomer({ internalCustomerId: customer.id, name: customer.name, email: customer.email })
  if (!made.ok || !made.id) return { error: made.error || 'Could not set up payment for this customer.' }
  let q = sb.from('customers').update({ stripe_customer_id: made.id }).eq('id', customer.id)
  if (opts?.userId) q = q.eq('user_id', opts.userId)
  const { error } = await q
  // A Stripe Customer we failed to persist is an orphan: the next call would mint
  // a SECOND one and the card would attach to whichever we happened to keep.
  if (error) return { error: 'Could not save the payment profile — try again.' }
  return { id: made.id }
}

export interface SavedCard {
  paymentMethodId: string
  stripeCustomerId: string
  brand?: string | null
  last4?: string | null
  expMonth?: number | null
  expYear?: number | null
}

// Record a saved card and retire any previous one.
//
// Ordering is load-bearing and is why this is not inlined twice: save the NEW card
// FIRST, then detach + delete the old. A failure mid-way therefore leaves a
// harmless stale row rather than a customer with NO card while AutoPay is still
// on — and the charge path always picks is_default + newest.
export async function saveCardForCustomer(
  sb: SupabaseClient,
  p: { userId: string; customerId: string; card: SavedCard },
): Promise<{ error?: string }> {
  const { userId, customerId, card } = p

  // Keep the customer's Stripe id in step — AutoPay charges need it, and a card
  // saved at checkout may be the first time we learn it.
  await sb.from('customers').update({ stripe_customer_id: card.stripeCustomerId }).eq('id', customerId).eq('user_id', userId)

  const upRes = await sb.from('payment_methods').upsert({
    user_id: userId, customer_id: customerId, stripe_customer_id: card.stripeCustomerId,
    stripe_payment_method_id: card.paymentMethodId, brand: card.brand ?? null, last4: card.last4 ?? null,
    exp_month: card.expMonth ?? null, exp_year: card.expYear ?? null, is_default: true,
  }, { onConflict: 'stripe_payment_method_id' })
  if (upRes.error) return { error: upRes.error.message }

  const { data: prior } = await sb.from('payment_methods')
    .select('stripe_payment_method_id').eq('customer_id', customerId).neq('stripe_payment_method_id', card.paymentMethodId)
  for (const old of (prior as { stripe_payment_method_id: string }[] | null) || []) {
    await detachPaymentMethod(old.stripe_payment_method_id)
  }
  await sb.from('payment_methods').delete().eq('customer_id', customerId).neq('stripe_payment_method_id', card.paymentMethodId)
  return {}
}
