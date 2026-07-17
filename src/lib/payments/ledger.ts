import type { createClient } from '@/lib/supabase/client'
import type { Invoice, InvoiceDisplayStatus } from '@/types'
import { invoiceTotals, type FeeSettings, type DiscountInput } from '@/lib/invoiceTotals'

// ── The ONE payment-ledger engine ────────────────────────────────────────────
// Records money against the EXISTING `payments` table (no separate payment/credit
// system) and reads the trigger-maintained invoices.amount_paid. Every balance,
// status overlay and charge amount derives from here so nothing can disagree.

type Supa = ReturnType<typeof createClient>
const round2 = (n: number) => Math.round(n * 100) / 100

function discountOf(inv: Pick<Invoice, 'discount_type' | 'discount_value'>): DiscountInput {
  return { type: inv.discount_type, value: inv.discount_value }
}

// Total owed (GST-inclusive; any discount is already inside `amount`) vs what's been
// received, and the remaining balance. The single definition reused by the invoices
// list, portal, charge routes, and the recorder's default amount.
export function invoiceBalance(
  inv: Pick<Invoice, 'amount' | 'amount_paid' | 'discount_type' | 'discount_value'>,
  settings: FeeSettings | null | undefined,
): { total: number; paid: number; balance: number; overpaid: number } {
  const total = invoiceTotals(inv.amount, settings, discountOf(inv)).total
  const paid = round2(Number(inv.amount_paid) || 0)
  const balance = round2(total - paid)
  return { total, paid, balance, overpaid: balance < -0.01 ? round2(-balance) : 0 }
}

// Stored status overlaid with the display-only lifecycle states: 'overdue'
// (balance owing + past the due date) and 'viewed' (sent + the customer opened it
// in the portal). partial/paid/overpaid come from the recompute_invoice_paid
// trigger; 'cancelled' is terminal and passes through untouched.
export function displayInvoiceStatus(
  inv: Pick<Invoice, 'status' | 'due_date' | 'amount' | 'amount_paid' | 'discount_type' | 'discount_value'> & { viewed_at?: string | null },
  settings: FeeSettings | null | undefined,
  todayISO: string,
): InvoiceDisplayStatus {
  if (inv.status === 'cancelled') return 'cancelled'
  const { balance } = invoiceBalance(inv, settings)
  if (balance > 0.01 && inv.due_date && inv.due_date < todayISO && (inv.status === 'unpaid' || inv.status === 'sent' || inv.status === 'partial')) {
    return 'overdue'
  }
  if (inv.status === 'sent' && inv.viewed_at) return 'viewed'
  return inv.status
}

// Cancel an invoice (terminal — the ledger trigger never revives it). Guarded:
// an invoice with money received must be refunded first, so the books balance.
export async function cancelInvoice(sb: Supa, invoice: Invoice): Promise<{ error?: string }> {
  // Ask the DB, not the prop it was rendered from. This guard is the only thing
  // standing between "cancelled" (terminal) and an invoice holding real money, and
  // it used to trust a value that goes stale the moment a payment lands — the exact
  // moment the guard most needs to fire.
  const { data, error: readErr } = await sb.from('invoices').select('amount_paid').eq('id', invoice.id).maybeSingle()
  if (readErr) return { error: 'Could not check this invoice’s payments — try again.' }
  if (!data) return { error: 'This invoice no longer exists.' }
  if ((Number((data as { amount_paid: number | null }).amount_paid) || 0) > 0.01) {
    return { error: 'This invoice has payments — refund them before cancelling.' }
  }
  const { error } = await sb.from('invoices').update({ status: 'cancelled' }).eq('id', invoice.id)
  return error ? { error: error.message } : {}
}

// Undo a cancellation — back to unpaid (the trigger re-derives partial/paid if a
// payment lands later).
export async function reactivateInvoice(sb: Supa, invoiceId: string): Promise<{ error?: string }> {
  const { error } = await sb.from('invoices').update({ status: 'unpaid' }).eq('id', invoiceId).eq('status', 'cancelled')
  return error ? { error: error.message } : {}
}

// Receipt number for a ledger payment — deterministic from the payment row (no
// counter table): RCT- + the row id's first 12 hex (48 bits — collision odds are
// negligible at any realistic volume), uppercase. Stable across re-sends.
export function receiptNumberFor(paymentId: string): string {
  return `RCT-${paymentId.replace(/-/g, '').slice(0, 12).toUpperCase()}`
}

// Local-noon ISO for a yyyy-MM-dd so an evening entry can't stamp the next UTC day.
function dateToIso(date: string): string {
  if (!date) return new Date().toISOString()
  return new Date(`${date}T12:00:00`).toISOString()
}

// Record a payment received toward an invoice. The trigger recomputes the invoice's
// amount_paid + status. A negative amount is a reversal (refund / move-to-credit).
export async function recordPayment(sb: Supa, p: {
  userId: string; invoice: Invoice; amount: number; method: string; date: string; notes?: string
}): Promise<{ error?: string; payment?: import('@/types').Payment }> {
  const amt = round2(p.amount)
  if (!amt) return { error: 'Enter a payment amount.' }
  const { data, error } = await sb.from('payments').insert({
    user_id: p.userId, customer_id: p.invoice.customer_id, invoice_id: p.invoice.id,
    amount: amt, currency: 'cad', provider: p.method, kind: 'payment', method: p.method,
    status: 'paid', paid_at: dateToIso(p.date), notes: p.notes?.trim() || null,
  }).select('*').single()
  return error ? { error: error.message } : { payment: data as import('@/types').Payment }
}

// Revert (remove) a recorded payment — the SAFE way to "un-pay" an invoice: the
// row is deleted from the ledger and the recompute trigger re-derives amount_paid
// and status naturally (paid → partial/unpaid). Never writes invoice status.
// Guarded to MANUAL rows: an online (Stripe) payment is real money held by the
// processor — reversing it means a refund, not an edit. Returns the removed row
// so the caller can offer Undo (re-insert with the same id → trigger re-derives).
export async function removePayment(sb: Supa, payment: import('@/types').Payment): Promise<{ error?: string }> {
  if (payment.provider === 'stripe') {
    return { error: 'Online payments can’t be reverted — issue a refund in Stripe instead (it flows back automatically).' }
  }
  const { error } = await sb.from('payments').delete().eq('id', payment.id)
  return error ? { error: error.message } : {}
}

// Re-insert a reverted payment with its ORIGINAL id/dates (the Undo path) — the
// trigger recomputes the invoice forward again.
export async function restorePayment(sb: Supa, payment: import('@/types').Payment): Promise<{ error?: string }> {
  const { error } = await sb.from('payments').insert({
    id: payment.id, user_id: payment.user_id, customer_id: payment.customer_id,
    invoice_id: payment.invoice_id, amount: payment.amount, currency: payment.currency,
    provider: payment.provider, kind: payment.kind, method: payment.method,
    status: payment.status, paid_at: payment.paid_at, notes: payment.notes,
  })
  return error ? { error: error.message } : {}
}

// ── THE definition of "this row is cash arriving" ────────────────────────────
// Every figure that claims to be money RECEIVED must ask this, so a report, a tile
// and a dashboard can't quietly mean different things by "collected".
//
// Two exclusions, both of which would otherwise double-count the same dollar:
//  • kind='credit' rows are the credit LEDGER — the liability side. They always pair
//    with a kind='payment' leg; counting both counts the money twice.
//  • provider='credit' payment rows are an invoice being settled FROM credit the
//    customer already handed over earlier. Real, but the cash arrived back when the
//    credit was granted; counting it again on settlement invents revenue.
export function isCashRow(r: { kind?: string | null; provider?: string | null; status?: string | null }): boolean {
  return r.kind === 'payment' && r.status === 'paid' && r.provider !== 'credit'
}

// Take a deposit BEFORE any invoice exists — money in advance, which the credit
// ledger already models, so this needs no new `kind` and no constraint change.
//
// Written as double entry, deliberately TWO rows, because one row can't be honest:
//  • the kind='payment' leg is the cash, and it is what makes the deposit show up in
//    "collected" on the day it actually arrived. A credit-only deposit would leave
//    real money invisible to every cash figure FOREVER — the later settlement leg is
//    provider='credit' and excluded by design, so the dollar would never be counted.
//  • the kind='credit' leg is the liability: what the business now owes the customer.
//    availableCredit sums it, applyCreditToInvoice spends it, and the portal already
//    shows it — so a deposit is visible to the customer the moment it's taken, with
//    no new plumbing.
// invoice_id is null on both: a deposit predates the invoice. recompute_invoice_paid
// returns early on a null invoice_id, so neither leg can disturb an invoice.
export async function recordDeposit(sb: Supa, p: {
  userId: string; customerId: string; amount: number; method: string; notes?: string
}): Promise<{ error?: string }> {
  const amt = round2(p.amount)
  if (!(amt > 0)) return { error: 'Enter a deposit amount.' }
  if (!p.customerId) return { error: 'Choose which customer this deposit is from.' }
  const at = new Date().toISOString()
  const base = { user_id: p.userId, customer_id: p.customerId, invoice_id: null, currency: 'cad', status: 'paid', paid_at: at }
  const note = p.notes?.trim() || 'Deposit'
  // Sign convention, and it is easy to get backwards: GRANTING credit is a POSITIVE
  // kind='credit' row (see overpaymentToCredit); SPENDING it is negative (see
  // applyCreditToInvoice). availableCredit sums them, so a flipped sign here would
  // drive a customer's balance negative instead of giving them their deposit.
  const { error } = await sb.from('payments').insert([
    { ...base, amount: amt, kind: 'payment', provider: p.method, method: p.method, notes: note },
    { ...base, amount: amt, kind: 'credit', provider: 'credit', method: 'credit', notes: `${note} — held as credit` },
  ])
  return error ? { error: error.message } : {}
}

// Sum of the customer's credit ledger = currently available credit.
export async function availableCredit(sb: Supa, customerId: string): Promise<number> {
  const { data } = await sb.from('payments').select('amount').eq('customer_id', customerId).eq('kind', 'credit')
  return round2(((data as { amount: number }[]) || []).reduce((s, r) => s + Number(r.amount || 0), 0))
}

// ── Stale-view guard for the amount-derived movements ────────────────────────
// applyCredit / overpaymentToCredit / recordRefund are all handed an amount the
// CALLER derived from the invoice it last rendered (min(credit, balance), overpaid,
// paid). If that view is stale the amount is wrong, and these three don't just
// mis-record — they INVENT money. Two tabs open on an invoice overpaid by $50, both
// clicking "Apply as credit", book that invoice −$100 and grant $100 of credit that
// never existed. The button's loading state only ever protected a double-click in ONE
// tab; nothing protected a second tab, a stale page, or a payment landing via
// realtime between render and click.
//
// amount_paid is the natural version token: it's trigger-maintained from the ledger,
// so it changes on ANY movement against this invoice. Compare-and-swap on it — no new
// column, no migration, and it catches every staleness case rather than the ones we
// thought to enumerate. Cheap: one indexed read on a path that's about to write.
//
// This narrows the race, it doesn't erase it: two callers reading the same value
// concurrently still both pass. Closing that properly needs the DB to own the
// invariant (see the note on availableCredit below).
// Exported so the invoice EDITOR can reuse the same staleness guard the credit /
// refund writers use — an edit computed against a balance that has since moved is
// the same hazard as a credit computed against one, and it must not get a second
// implementation that drifts from this one.
export async function assertCurrent(sb: Supa, invoice: Invoice): Promise<string | null> {
  const { data, error } = await sb.from('invoices').select('amount_paid, status').eq('id', invoice.id).maybeSingle()
  // A failed read must NOT be treated as "unchanged" — that's the exact assumption
  // this guard exists to remove.
  if (error) return 'Could not confirm the invoice’s current balance — try again.'
  if (!data) return 'This invoice no longer exists.'
  const now = round2(Number((data as { amount_paid: number | null }).amount_paid) || 0)
  const seen = round2(Number(invoice.amount_paid) || 0)
  if (now !== seen) return 'This invoice changed while you had it open — refresh to see the current balance, then try again.'
  return null
}

// Apply available credit to an invoice (double-entry): a +payment toward the invoice
// (drops its balance) and a −credit movement (consumes the credit). Audit trail in notes.
export async function applyCreditToInvoice(sb: Supa, p: {
  userId: string; invoice: Invoice; amount: number
}): Promise<{ error?: string }> {
  const amt = round2(p.amount)
  if (!(amt > 0)) return { error: 'Nothing to apply.' }
  if (!p.invoice.customer_id) return { error: 'This invoice has no customer.' }
  const stale = await assertCurrent(sb, p.invoice)
  if (stale) return { error: stale }
  // Credit lives on the CUSTOMER, not this invoice, so amount_paid can't speak for it:
  // the same credit spent on a different invoice leaves this one untouched. Re-read the
  // balance we're about to draw down.
  const available = await availableCredit(sb, p.invoice.customer_id)
  if (amt > available + 0.005) {
    return { error: available > 0
      ? `Only ${available.toFixed(2)} of credit is left — refresh and try again.`
      : 'This customer has no credit left to apply.' }
  }
  const at = new Date().toISOString()
  const common = { user_id: p.userId, customer_id: p.invoice.customer_id, invoice_id: p.invoice.id, currency: 'cad', provider: 'credit', method: 'credit', status: 'paid', paid_at: at }
  const { error } = await sb.from('payments').insert([
    { ...common, amount: amt, kind: 'payment', notes: 'Applied customer credit' },
    { ...common, amount: -amt, kind: 'credit', notes: `Applied to ${p.invoice.invoice_number}` },
  ])
  return error ? { error: error.message } : {}
}

// Move an invoice overpayment into customer credit (double-entry): a −payment on the
// source invoice (returns its balance to exactly $0) and a +credit grant.
export async function overpaymentToCredit(sb: Supa, p: {
  userId: string; invoice: Invoice; amount: number
}): Promise<{ error?: string }> {
  const amt = round2(p.amount)
  if (!(amt > 0)) return { error: 'No overpayment to move.' }
  if (!p.invoice.customer_id) return { error: 'This invoice has no customer.' }
  // The one that invents money outright: `overpaid` is derived from amount_paid, so a
  // stale view grants credit against an overpayment that's already been resolved.
  const stale = await assertCurrent(sb, p.invoice)
  if (stale) return { error: stale }
  const at = new Date().toISOString()
  const common = { user_id: p.userId, customer_id: p.invoice.customer_id, invoice_id: p.invoice.id, currency: 'cad', provider: 'credit', method: 'credit', status: 'paid', paid_at: at }
  const { error } = await sb.from('payments').insert([
    { ...common, amount: -amt, kind: 'payment', notes: 'Overpayment moved to credit' },
    { ...common, amount: amt, kind: 'credit', notes: `From ${p.invoice.invoice_number} overpayment` },
  ])
  return error ? { error: error.message } : {}
}

// Record a refund (reduces Total Paid). For card payments the actual money movement
// happens in Stripe; this keeps balances/reports honest. Stored as a negative payment.
export async function recordRefund(sb: Supa, p: {
  userId: string; invoice: Invoice; amount: number; notes?: string
}): Promise<{ error?: string }> {
  const amt = round2(Math.abs(p.amount))
  if (!(amt > 0)) return { error: 'Enter a refund amount.' }
  const stale = await assertCurrent(sb, p.invoice)
  if (stale) return { error: stale }
  // The UI caps the field at `paid`, but that cap is only as fresh as the render it
  // came from. Refunding more than was ever collected is not a thing that can be
  // true, so the engine says so rather than trusting the form.
  const collected = round2(Number(p.invoice.amount_paid) || 0)
  if (amt > collected + 0.005) {
    return { error: collected > 0
      ? `Only ${collected.toFixed(2)} was collected on this invoice — you can’t refund more than that.`
      : 'Nothing has been collected on this invoice yet, so there’s nothing to refund.' }
  }
  const { error } = await sb.from('payments').insert({
    user_id: p.userId, customer_id: p.invoice.customer_id, invoice_id: p.invoice.id,
    amount: -amt, currency: 'cad', provider: 'refund', kind: 'payment', method: 'refund',
    status: 'paid', paid_at: new Date().toISOString(), notes: p.notes?.trim() || 'Refund',
  })
  return error ? { error: error.message } : {}
}
