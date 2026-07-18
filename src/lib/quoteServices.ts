import { applyDiscount, DiscountType } from './invoiceTotals'
import type { QuoteService, QuoteServiceInput } from '@/types'

// ── Multi-service quote math ─────────────────────────────────────────────────
// The ONE place quote service-line arithmetic lives. Line net = quantity ×
// unit_price minus the per-line discount, using the SAME applyDiscount the
// invoice engine uses (identical $ / % semantics — no second discount system).
// The quote's stored initial_price = Σ line nets, so the generated quotes.total
// (initial_price + travel_fee) and every downstream consumer stay correct.

// The unit vocabulary lives in lib/units (SYSTEM_UNITS + the service_units table).
// A four-value SERVICE_UNITS list used to sit here and was still wired as the
// picker's fallback, so a failed read silently swapped nine units for four and
// dropped fixture/room/zone/equipment/flat. Deleted rather than widened: this file
// owns the ARITHMETIC, which never sees a unit at all.

// Accepts both the builder's input shape ('' = no discount) and loaded DB rows
// (nulls) — the math already coalesces both to "no discount" / 0.
type LineLike = Pick<QuoteServiceInput, 'quantity' | 'unit_price'> & {
  discount_type: QuoteServiceInput['discount_type'] | null
  discount_value: number | null
}

export interface LineTotals { gross: number; net: number; discountAmount: number }

// One line's totals: gross = qty × unit price; net = gross after its discount.
export function serviceLineTotals(line: LineLike): LineTotals {
  const qty = Number(line.quantity) > 0 ? Number(line.quantity) : 1
  const gross = round2(qty * (Number(line.unit_price) || 0))
  const { net, discountAmount } = applyDiscount(gross, {
    type: (line.discount_type as DiscountType | null) ?? null,
    value: line.discount_value ?? null,
  })
  return { gross, net, discountAmount }
}

// Sum a set of lines (gross/net/discount + total estimated minutes).
export function sumServiceLines(lines: LineLike[] | null | undefined): LineTotals & { minutes: number } {
  let gross = 0, net = 0, discountAmount = 0, minutes = 0
  for (const l of lines || []) {
    const t = serviceLineTotals(l)
    gross += t.gross; net += t.net; discountAmount += t.discountAmount
    minutes += Number((l as QuoteServiceInput).est_minutes) || 0
  }
  return { gross: round2(gross), net: round2(net), discountAmount: round2(discountAmount), minutes }
}

// Split loaded rows into the builder's shape: row 0 (the primary service) maps to
// the classic single-service fields; rows 1+ are the "Additional services" list.
export function splitServices(rows: QuoteService[]): { primary: QuoteService | null; extras: QuoteService[] } {
  const sorted = [...rows].sort((a, b) => a.sort_order - b.sort_order)
  return { primary: sorted[0] ?? null, extras: sorted.slice(1) }
}

// A blank additional-service line for the builder. `kind` is explicit rather than
// defaulted so a caller can never create an untyped line — lib/quoteMaterials
// owns the material equivalent, and the arithmetic above is identical for both.
export function emptyServiceLine(): QuoteServiceInput {
  return { service_type: '', service_template_id: '', quantity: 1, unit: 'each', unit_price: 0, est_minutes: 0, discount_type: '', discount_value: 0, notes: '', kind: 'service' }
}

function round2(n: number): number { return Math.round((Number(n) || 0) * 100) / 100 }
