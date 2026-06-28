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

// ── Discounts (fixed $ or %) ─────────────────────────────────────────────────
// ONE definition of "apply a discount to a subtotal", used at SAVE time (the draft
// editor + the draft-sync engine) to compute the NET amount we store. The display
// side (invoiceTotals) reverses it from the stored net — never duplicating the math.
export type DiscountType = 'amount' | 'percent'
export interface DiscountInput { type?: DiscountType | null; value?: number | null }

// gross → { net, discountAmount }. A $ discount is capped at the subtotal; a %
// discount is capped at 100. Invalid/zero discounts pass the gross through.
export function applyDiscount(grossSubtotal: number, d: DiscountInput | null | undefined): { net: number; discountAmount: number } {
  const gross = round2(Number(grossSubtotal) || 0)
  const value = Number(d?.value)
  if (!d?.type || !Number.isFinite(value) || value <= 0 || gross <= 0) return { net: gross, discountAmount: 0 }
  if (d.type === 'amount') {
    const amt = Math.min(round2(value), gross)
    return { net: round2(gross - amt), discountAmount: amt }
  }
  const p = Math.min(value, 100)
  const amt = round2(gross * p / 100)
  return { net: round2(gross - amt), discountAmount: amt }
}

export interface InvoiceTotals {
  subtotal: number          // pre-discount (gross)
  discountAmount: number
  discountedSubtotal: number // = the stored net amount
  discountLabel: string | null // e.g. "10%" for a percentage; null for a fixed $
  gstPercent: number
  gstAmount: number
  total: number
  hasGst: boolean
  hasDiscount: boolean
}

const trimNum = (n: number) => (Number.isInteger(n) ? String(n) : String(round2(n)))

// Split a stored invoice `amount` (the NET subtotal — already post-discount and
// inclusive of any baked-in fee recovery) into a full breakdown. The optional
// discount reconstructs the pre-discount gross for DISPLAY only; GST and the total
// are computed on the net `amount`, so charged totals never change. Backward
// compatible: called without a discount it returns subtotal === amount as before.
export function invoiceTotals(
  amount: number | string | null | undefined,
  s: FeeSettings | null | undefined,
  discount?: DiscountInput | null,
): InvoiceTotals {
  const net = round2(Number(amount) || 0)
  const value = Number(discount?.value)
  let discountAmount = 0
  let discountLabel: string | null = null
  if (discount?.type && Number.isFinite(value) && value > 0 && net > 0) {
    if (discount.type === 'amount') {
      discountAmount = round2(value)
    } else {
      // net = gross·(1 − p/100) ⇒ discountAmount = net·p/(100 − p) (exact inverse).
      const p = Math.min(value, 100)
      discountAmount = p < 100 ? round2(net * p / (100 - p)) : 0
      discountLabel = `${trimNum(p)}%`
    }
  }
  const gross = round2(net + discountAmount)
  const gstPercent = Number(s?.gst_percent) || 0
  const gstAmount = gstPercent > 0 ? round2(net * gstPercent / 100) : 0
  return {
    subtotal: gross,
    discountAmount,
    discountedSubtotal: net,
    discountLabel,
    gstPercent,
    gstAmount,
    total: round2(net + gstAmount),
    hasGst: gstPercent > 0,
    hasDiscount: discountAmount > 0,
  }
}
