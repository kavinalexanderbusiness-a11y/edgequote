import type { createClient } from '@/lib/supabase/client'
import type { Invoice } from '@/types'
import type { FeeSettings } from '@/lib/invoiceTotals'
import { invoiceBalance } from '@/lib/payments/ledger'

// ── THE deposit / upfront-request engine ─────────────────────────────────────
//
// A deposit in EdgeQuote is NOT a second invoice and NOT a new kind of money row.
// It is a PARTIAL PAYMENT against the invoice that already exists, plus a
// remembered request for how much of it to collect now.
//
// Why that is the canonical shape (do not relitigate):
//  • Partial payments already work end to end. `payments` rows carry whatever was
//    actually paid, the `recompute_invoice_paid` trigger derives
//    invoices.amount_paid + status ('partial'), and the Stripe webhook records
//    `amount_total` — the amount CHARGED, not the invoice total. So a $1,500
//    charge against a $3,000 invoice already lands correctly today.
//  • A separate "deposit invoice" would create a second invoice number and a
//    second revenue record for one job — the accounting module would read the
//    work as billed twice, and the deposit would have to be un-billed later.
//  • `recordDeposit` in ledger.ts is a DIFFERENT thing and stays as it is: money
//    taken BEFORE any invoice exists, held as customer credit. That has no
//    invoice to be a partial payment OF. This engine is for the case the owner
//    described: an invoice/job total exists and part of it is wanted up front.
//
// So the only new state is the REQUEST: how much was asked for, and when it was
// successfully sent. Both live on the invoice, so a deposit can never become a
// disconnected money record — it is welded to the customer/job/invoice by the
// row it sits on.
//
// Everything else is DERIVED here. In particular the percentage is never stored:
// it is always computed from the requested amount against the live invoice total,
// so it cannot drift from the canonical total the way a stored percent would.
// The AMOUNT is what's stored because the amount is what was communicated to the
// customer — you cannot text someone "$1,500" and then charge them something else
// because the invoice was edited afterwards.
//
// The rules below are PURE (no React, no I/O) so scripts/verify-deposit.ts can
// pin every one of them directly; the three tiny writers live at the bottom, in
// the same module, so "what a deposit is" and "how a deposit is stored" can never
// drift apart the way they would if the writes were inlined in a component.

const round2 = (n: number) => Math.round(n * 100) / 100

/** The invoice fields this engine reads. Structural, so an `Invoice` satisfies it. */
export type DepositInvoice = Pick<
  Invoice, 'amount' | 'amount_paid' | 'discount_type' | 'discount_value'
> & {
  deposit_amount?: number | string | null
  deposit_requested_at?: string | null
}

export type DepositStatus =
  | 'none'      // no deposit requested
  | 'draft'     // requested, not yet sent to the customer
  | 'sent'      // sent, still waiting on the money
  | 'paid'      // enough has been received to cover it

export interface DepositState {
  /** GST-inclusive invoice total — the number a percentage is taken OF. */
  total: number
  /** What was asked for up front, or null when no deposit is requested. */
  requested: number | null
  /** requested as a % of total, DERIVED (never stored) — null when none. */
  percent: number | null
  /** Received against this invoice so far (any method, not just the deposit). */
  paid: number
  /** Still needed to satisfy the deposit. 0 once covered. */
  outstanding: number
  /** What is left on the whole invoice after the deposit is fully paid. */
  remainingAfter: number
  status: DepositStatus
  /**
   * The request is larger than the invoice now is — the invoice was edited DOWN
   * after the deposit was asked for. Surfaced rather than silently clamped, so
   * the owner is told their request no longer matches the job.
   */
  exceedsTotal: boolean
}

/**
 * A percentage of the invoice total, as money.
 *
 * Rounded to cents ONCE, here, so every surface that shows "50%" shows the same
 * dollars. Percentages that don't divide evenly (33% of $100 = $33.33) resolve
 * to the nearest cent rather than carrying a fraction into the ledger.
 */
export function depositFromPercent(total: number, percent: number): number {
  const t = round2(Number(total) || 0)
  const p = Number(percent)
  if (!Number.isFinite(p) || !(t > 0)) return 0
  return round2(t * p / 100)
}

/** The inverse, for display only: what percentage of the total is this amount? */
export function depositPercentOf(total: number, amount: number): number | null {
  const t = round2(Number(total) || 0)
  const a = round2(Number(amount) || 0)
  if (!(t > 0) || !(a > 0)) return null
  return Math.round((a / t) * 1000) / 10   // one decimal: 33.3%, not 33.33333%
}

/**
 * Validate an owner's deposit input against the live invoice.
 *
 * Returns the exact amount to store, or a plain-language error. The rules are
 * the product's, not arbitrary:
 *  • > 0 — a $0 deposit is not a request, it's a no-op that would still send a
 *    message asking for nothing.
 *  • ≤ total — asking for more than the job costs is never intended, and would
 *    make "remaining after" negative.
 *  • ≤ what is still owed — an invoice already part-paid must not have a deposit
 *    requested for money that has arrived. 100% is allowed (it is just "pay in
 *    full up front"); above 100% is rejected.
 */
export function validateDeposit(
  input: { kind: 'percent' | 'amount'; value: number },
  total: number,
  alreadyPaid = 0,
): { ok: true; amount: number } | { ok: false; error: string } {
  const no = (error: string) => ({ ok: false as const, error })
  const t = round2(Number(total) || 0)
  if (!(t > 0)) return no('This invoice has no amount to take a deposit from.')

  const v = Number(input.value)
  if (!Number.isFinite(v)) return no('Enter a deposit amount.')

  if (input.kind === 'percent') {
    if (v <= 0) return no('Enter a percentage above 0.')
    if (v > 100) return no('A deposit can’t be more than 100% of the invoice.')
  } else if (v <= 0) {
    return no('Enter a deposit amount above $0.')
  }

  const amount = input.kind === 'percent' ? depositFromPercent(t, v) : round2(v)
  if (!(amount > 0)) return no('That works out to $0 — enter a larger deposit.')
  if (amount > t + 0.005) {
    return no(`A deposit can’t be more than the invoice total of ${t.toFixed(2)}.`)
  }

  const paid = round2(Number(alreadyPaid) || 0)
  const owing = round2(t - paid)
  if (paid > 0.005 && amount > owing + 0.005) {
    return owing > 0.005
      ? no(`Only ${owing.toFixed(2)} is still owed on this invoice — ask for that or less.`)
      : no('This invoice is already paid in full.')
  }
  return { ok: true, amount }
}

/**
 * The whole deposit picture for one invoice — the ONE reader every surface uses
 * so the owner's panel, the message, the portal and any report agree.
 */
export function depositState(
  inv: DepositInvoice,
  settings: FeeSettings | null | undefined,
): DepositState {
  const { total, paid } = invoiceBalance(inv, settings)
  const raw = inv.deposit_amount == null ? null : round2(Number(inv.deposit_amount) || 0)
  const requested = raw != null && raw > 0 ? raw : null

  if (requested == null) {
    return {
      total, requested: null, percent: null, paid,
      outstanding: 0, remainingAfter: round2(total - paid),
      status: 'none', exceedsTotal: false,
    }
  }

  // Covered by money ALREADY received, whatever it came from — if the customer
  // paid $1,500 by e-transfer, the deposit is satisfied and must not still read
  // as owing. A cent of tolerance so float noise can't leave it 99.99% paid.
  const outstanding = Math.max(0, round2(requested - paid))
  const covered = outstanding <= 0.005
  return {
    total,
    requested,
    percent: depositPercentOf(total, requested),
    paid,
    outstanding: covered ? 0 : outstanding,
    remainingAfter: round2(total - Math.max(requested, paid)),
    status: covered ? 'paid' : (inv.deposit_requested_at ? 'sent' : 'draft'),
    exceedsTotal: requested > round2(total) + 0.005,
  }
}

/**
 * THE amount a payment surface should collect right now.
 *
 * One rule, so the owner's "take a card" link, the portal's Pay button and any
 * future payment page can never ask for different money: while an unpaid deposit
 * is outstanding, that is what's due; otherwise it is the ordinary balance.
 *
 * Always clamped to the real balance — a deposit left over from before the
 * invoice was edited down can never charge more than is actually owed.
 */
export function depositChargeAmount(
  inv: DepositInvoice,
  settings: FeeSettings | null | undefined,
): { amount: number; isDeposit: boolean } {
  const { balance } = invoiceBalance(inv, settings)
  const d = depositState(inv, settings)
  if (d.status === 'none' || d.status === 'paid' || balance <= 0) {
    return { amount: Math.max(0, balance), isDeposit: false }
  }
  const amount = round2(Math.min(d.outstanding, balance))
  return amount > 0 ? { amount, isDeposit: true } : { amount: Math.max(0, balance), isDeposit: false }
}

// ── Persistence ──────────────────────────────────────────────────────────────
// Three writes, all on the invoice row. Nothing here touches `payments`: asking
// for a deposit moves no money, so it must not write to the ledger. The money
// arrives later as an ordinary payment and the recompute_invoice_paid trigger
// does what it already does.

type Supa = ReturnType<typeof createClient>

/**
 * Store (or change) the requested amount. Validation is the CALLER's, through
 * validateDeposit, so the owner sees a specific message; this is the write.
 *
 * Setting a NEW amount clears deposit_requested_at: the customer was told a
 * different number, so the old "sent" is no longer true of this request. That is
 * the whole reason the stamp exists — it must never vouch for an amount nobody
 * was told.
 */
export async function saveDepositRequest(
  sb: Supa, p: { invoiceId: string; amount: number },
): Promise<{ error?: string }> {
  const amt = round2(p.amount)
  if (!(amt > 0)) return { error: 'Enter a deposit amount above $0.' }
  const { error } = await sb.from('invoices')
    .update({ deposit_amount: amt, deposit_requested_at: null })
    .eq('id', p.invoiceId)
  return error ? { error: error.message } : {}
}

/** Remove the request entirely (the owner changed their mind). Moves no money. */
export async function clearDepositRequest(sb: Supa, invoiceId: string): Promise<{ error?: string }> {
  const { error } = await sb.from('invoices')
    .update({ deposit_amount: null, deposit_requested_at: null })
    .eq('id', invoiceId)
  return error ? { error: error.message } : {}
}

/**
 * Stamp the request as sent — call ONLY after a delivery actually succeeded.
 *
 * The UI reads this column to say "sent", so stamping it optimistically (or on a
 * failed send) would tell the owner a customer was asked for money they never
 * heard about, and the owner would sit waiting for a deposit that can't arrive.
 */
export async function markDepositRequestSent(sb: Supa, invoiceId: string): Promise<{ error?: string }> {
  const { error } = await sb.from('invoices')
    .update({ deposit_requested_at: new Date().toISOString() })
    .eq('id', invoiceId)
    .not('deposit_amount', 'is', null)
  return error ? { error: error.message } : {}
}
