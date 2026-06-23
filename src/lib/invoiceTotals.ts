import { PaymentFeeStrategy } from '@/types'

// ── Payment fee recovery + GST totals ────────────────────────────────────────
// Two independent, accounting-correct mechanisms:
//  1. Fee recovery (YOUR revenue): a global price increase BAKED INTO new quote
//     prices at generation — so the invoice Subtotal already includes it. No
//     surcharge line, and no double-application (invoices inherit the quote price).
//  2. GST (a pass-through LIABILITY): computed ON TOP of the subtotal at display/
//     charge time from gst_percent, shown only when > 0. NOT stored in
//     invoice.amount, so `amount` stays = your revenue (the subtotal).

export interface FeeSettings {
  payment_fee_strategy?: PaymentFeeStrategy | null
  fee_recovery_percent?: number | null
  gst_percent?: number | null
}

const round2 = (n: number) => Math.round(n * 100) / 100

// 1 + fee% when the strategy is the global price increase, else 1 (absorb /
// etransfer_discount leave prices untouched).
export function feeRecoveryMultiplier(s: FeeSettings | null | undefined): number {
  if (s?.payment_fee_strategy === 'global_price_increase') {
    const pct = Number(s.fee_recovery_percent)
    if (Number.isFinite(pct) && pct > 0) return 1 + pct / 100
  }
  return 1
}

// Bake the recovery into a single price at quote generation. Null/0 pass through
// unchanged (an unset cadence price stays unset).
export function applyFeeRecovery(price: number | null | undefined, s: FeeSettings | null | undefined): number | null {
  const p = Number(price)
  if (!Number.isFinite(p) || p <= 0) return price == null ? null : p
  return round2(p * feeRecoveryMultiplier(s))
}

export interface InvoiceTotals { subtotal: number; gstPercent: number; gstAmount: number; total: number; hasGst: boolean }

// Split a stored invoice `amount` (the subtotal — already includes any baked-in
// fee recovery) into Subtotal / GST / Total. GST only appears when gst_percent > 0.
export function invoiceTotals(amount: number | string | null | undefined, s: FeeSettings | null | undefined): InvoiceTotals {
  const subtotal = round2(Number(amount) || 0)
  const gstPercent = Number(s?.gst_percent) || 0
  const gstAmount = gstPercent > 0 ? round2(subtotal * gstPercent / 100) : 0
  return { subtotal, gstPercent, gstAmount, total: round2(subtotal + gstAmount), hasGst: gstPercent > 0 }
}
