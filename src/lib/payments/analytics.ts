import type { Payment } from '@/types'
import { isCashRow } from '@/lib/payments/ledger'

// ── Transaction aggregation (pure) ───────────────────────────────────────────
// Every figure here derives from isCashRow in the ledger engine rather than
// restating "what counts as money" — a report that disagrees with the dashboard
// about collected cash is worse than no report, because it gets believed.
//
// Pure functions over rows the caller already fetched: no queries, no second
// source of truth, trivially checkable.

const round2 = (n: number) => Math.round(n * 100) / 100

// ── THE name for a ledger row ────────────────────────────────────────────────
// One classifier, so an export, a table and a tile can't call the same row
// different things. Derived strictly from what the ledger's writers actually
// produce (see recordPayment / recordDeposit / applyCreditToInvoice /
// overpaymentToCredit / recordRefund):
//
//   recordPayment        → kind=payment, provider=<method>       → cash in
//   recordDeposit        → kind=payment, provider=<method>       → cash in
//                        + kind=credit,  amount>0                → credit issued
//   applyCreditToInvoice → kind=payment, provider=credit, amt>0  → NOT cash
//                        + kind=credit,  amount<0                → credit applied
//   overpaymentToCredit  → kind=payment, provider=credit, amt<0  → NOT cash
//                        + kind=credit,  amount>0                → credit issued
//   recordRefund         → kind=payment, provider=refund, amt<0  → cash out
//
// The trap this closes: "settled from credit" is kind='payment' with a POSITIVE
// amount, so anything that types a row by `kind` alone (or by the sign of the
// amount) calls it a payment and counts the customer's deposit as revenue twice.
export type LedgerRowType =
  | 'Payment' | 'Refund' | 'Settled from credit' | 'Overpayment to credit'
  | 'Credit issued' | 'Credit applied'

export function ledgerRowType(r: Pick<Payment, 'kind' | 'provider' | 'amount'>): LedgerRowType {
  const amt = Number(r.amount) || 0
  // The credit LEDGER — the liability side. Never cash.
  if (r.kind === 'credit') return amt >= 0 ? 'Credit issued' : 'Credit applied'
  // A payment row settled FROM credit: real settlement, but the cash arrived
  // earlier when the credit was granted.
  if (r.provider === 'credit') return amt >= 0 ? 'Settled from credit' : 'Overpayment to credit'
  return amt >= 0 ? 'Payment' : 'Refund'
}

/**
 * The signed CASH this row moved: the amount when isCashRow accepts it, else 0.
 *
 * This is what makes an export safe to sum. Over ANY slice of the ledger,
 * `sum(cashAmountOf)` === `summarizeTransactions(slice).net`, exactly — because
 * `net` is `collected − refunded` over precisely the rows isCashRow accepts. So a
 * CSV column built from this ties to the dashboard tile by construction rather
 * than by coincidence, and a bookkeeper who sums it cannot invent revenue.
 */
export function cashAmountOf(r: Pick<Payment, 'kind' | 'provider' | 'amount' | 'status'>): number {
  return isCashRow(r) ? round2(Number(r.amount) || 0) : 0
}

export interface MethodSlice { method: string; total: number; count: number }

export interface TxnSummary {
  /** Cash IN over the rows given (positive cash rows only). */
  collected: number
  /** Money handed BACK (negative cash rows), as a positive number. */
  refunded: number
  /** collected − refunded. The figure that ties to a signed ledger sum. */
  net: number
  /** Count of money-IN events. A refund is not "a payment received". */
  count: number
  /** Refund event count. */
  refundCount: number
  byMethod: MethodSlice[]
}

/**
 * `rows` is any slice of the ledger — a date range, a search result, everything.
 * Credit-ledger rows and credit settlements are excluded by isCashRow, so applying
 * $200 of credit to an invoice never reads as $200 of new money.
 */
export function summarizeTransactions(rows: Payment[]): TxnSummary {
  let collected = 0, refunded = 0, count = 0, refundCount = 0
  const methods = new Map<string, MethodSlice>()
  for (const r of rows) {
    if (!isCashRow(r)) continue
    const amt = Number(r.amount) || 0
    if (amt >= 0) {
      collected += amt
      count++
      // Group by how the money actually arrived. provider falls back for legacy rows
      // written before `method` existed; 'other' rather than a blank label.
      const key = (r.method || r.provider || 'other').toLowerCase()
      const slice = methods.get(key) || { method: key, total: 0, count: 0 }
      slice.total += amt; slice.count++
      methods.set(key, slice)
    } else {
      refunded += Math.abs(amt)
      refundCount++
    }
  }
  return {
    collected: round2(collected),
    refunded: round2(refunded),
    net: round2(collected - refunded),
    count,
    refundCount,
    byMethod: [...methods.values()]
      .map(s => ({ ...s, total: round2(s.total) }))
      .sort((a, b) => b.total - a.total),
  }
}

export interface CreditBalance { customerId: string; name: string; balance: number }

/**
 * Per-customer credit from the credit ledger. Mirrors availableCredit's rule (sum of
 * kind='credit' rows) but over rows already in hand, so one screen can show every
 * customer holding money without N queries.
 *
 * Only positive balances are returned: a zero balance is a customer who used their
 * credit, and listing them as "holding credit" would be noise. A NEGATIVE balance is
 * impossible by design — the ledger guards against it — so if one ever appears it is
 * surfaced rather than hidden, because it means a guard failed.
 */
export function creditBalances(
  rows: Pick<Payment, 'customer_id' | 'kind' | 'amount'>[],
  nameOf: (customerId: string) => string,
): { balances: CreditBalance[]; total: number; negative: CreditBalance[] } {
  const sums = new Map<string, number>()
  for (const r of rows) {
    if (r.kind !== 'credit' || !r.customer_id) continue
    sums.set(r.customer_id, (sums.get(r.customer_id) || 0) + (Number(r.amount) || 0))
  }
  const all: CreditBalance[] = [...sums.entries()]
    .map(([customerId, v]) => ({ customerId, name: nameOf(customerId), balance: round2(v) }))
  return {
    balances: all.filter(b => b.balance > 0.005).sort((a, b) => b.balance - a.balance),
    total: round2(all.reduce((s, b) => s + Math.max(0, b.balance), 0)),
    negative: all.filter(b => b.balance < -0.005),
  }
}
