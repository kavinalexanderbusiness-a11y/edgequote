import type { SupabaseClient } from '@supabase/supabase-js'
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
  if ((Number(invoice.amount_paid) || 0) > 0.01) {
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

// Sum of the customer's credit ledger = currently available credit.
export async function availableCredit(sb: Supa, customerId: string): Promise<number> {
  const { data } = await sb.from('payments').select('amount').eq('customer_id', customerId).eq('kind', 'credit')
  return round2(((data as { amount: number }[]) || []).reduce((s, r) => s + Number(r.amount || 0), 0))
}

// Local-midnight ISO bounds for a yyyy-MM-dd day — the mirror of dateToIso's
// local-day convention, so a payment the owner dated "today" lands in today.
export function dayBoundsIso(dateISO: string): { start: string; end: string } {
  const start = new Date(`${dateISO}T00:00:00`)
  const end = new Date(start.getTime())
  end.setDate(end.getDate() + 1)
  return { start: start.toISOString(), end: end.toISOString() }
}

// ── Money actually received in a window ──────────────────────────────────────
// THE date-range cash figure (today / this week / any span). It must read the
// `payments` rows, NOT invoices.amount_paid: that column is a trigger rollup with
// the time dimension collapsed, so it can answer "how much in total" but never
// "how much today". Summed over all time this agrees exactly with the dashboard's
// lifetime Collected — same rows, same trigger source.
//
// The sum is SIGNED on purpose: a refund is stored as a negative kind='payment'
// row (recordRefund), so refunds net themselves out with no special handling.
// `kind='credit'` rows are excluded because applying credit writes BOTH a +payment
// and a −credit for one event — counting the credit leg would double-count.
//
// includeCreditApplications=false (the default) also drops the +payment leg of
// applyCreditToInvoice (provider='credit'): settling an invoice from credit the
// customer already paid earlier is not new cash arriving today.
// Typed against the generic SupabaseClient (like lib/crm/radar) so the SERVER
// dashboard can call it too — the money lands in the first paint, no spinner.
export async function collectedBetween(sb: SupabaseClient, p: {
  userId: string; startIso: string; endIso: string; includeCreditApplications?: boolean
}): Promise<{ total: number; count: number }> {
  const { data } = await sb.from('payments')
    .select('amount, provider')
    .eq('user_id', p.userId)
    .eq('kind', 'payment')
    .eq('status', 'paid')
    .gte('paid_at', p.startIso)
    .lt('paid_at', p.endIso)
  const rows = ((data as { amount: number; provider: string | null }[]) || [])
    .filter(r => p.includeCreditApplications || r.provider !== 'credit')
  return {
    total: round2(rows.reduce((s, r) => s + (Number(r.amount) || 0), 0)),
    // Money-in events only — a refund shouldn't read as "1 payment today".
    count: rows.filter(r => (Number(r.amount) || 0) > 0).length,
  }
}

// Apply available credit to an invoice (double-entry): a +payment toward the invoice
// (drops its balance) and a −credit movement (consumes the credit). Audit trail in notes.
export async function applyCreditToInvoice(sb: Supa, p: {
  userId: string; invoice: Invoice; amount: number
}): Promise<{ error?: string }> {
  const amt = round2(p.amount)
  if (!(amt > 0)) return { error: 'Nothing to apply.' }
  if (!p.invoice.customer_id) return { error: 'This invoice has no customer.' }
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
  const { error } = await sb.from('payments').insert({
    user_id: p.userId, customer_id: p.invoice.customer_id, invoice_id: p.invoice.id,
    amount: -amt, currency: 'cad', provider: 'refund', kind: 'payment', method: 'refund',
    status: 'paid', paid_at: new Date().toISOString(), notes: p.notes?.trim() || 'Refund',
  })
  return error ? { error: error.message } : {}
}
