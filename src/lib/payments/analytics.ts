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
