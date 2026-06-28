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

// Stored status overlaid with 'overdue' (balance owing + past the due date). The
// partial/paid/overpaid states already come from the recompute_invoice_paid trigger.
export function displayInvoiceStatus(
  inv: Pick<Invoice, 'status' | 'due_date' | 'amount' | 'amount_paid' | 'discount_type' | 'discount_value'>,
  settings: FeeSettings | null | undefined,
  todayISO: string,
): InvoiceDisplayStatus {
  const { balance } = invoiceBalance(inv, settings)
  if (balance > 0.01 && inv.due_date && inv.due_date < todayISO && (inv.status === 'unpaid' || inv.status === 'sent' || inv.status === 'partial')) {
    return 'overdue'
  }
  return inv.status
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
}): Promise<{ error?: string }> {
  const amt = round2(p.amount)
  if (!amt) return { error: 'Enter a payment amount.' }
  const { error } = await sb.from('payments').insert({
    user_id: p.userId, customer_id: p.invoice.customer_id, invoice_id: p.invoice.id,
    amount: amt, currency: 'cad', provider: p.method, kind: 'payment', method: p.method,
    status: 'paid', paid_at: dateToIso(p.date), notes: p.notes?.trim() || null,
  })
  return error ? { error: error.message } : {}
}

// Sum of the customer's credit ledger = currently available credit.
export async function availableCredit(sb: Supa, customerId: string): Promise<number> {
  const { data } = await sb.from('payments').select('amount').eq('customer_id', customerId).eq('kind', 'credit')
  return round2(((data as { amount: number }[]) || []).reduce((s, r) => s + Number(r.amount || 0), 0))
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
