// ── Visit value — the leaf the whole app can afford to import ────────────────
// THE single definition of "what is this visit worth" and how a recurring
// cadence resolves. Extracted from lib/invoicing because HALF THE APP needs
// these three pure functions — geo, the optimizer, weather impact, labor,
// profitability, suggestions, revenue intelligence, signals, dashboards —
// and importing them from lib/invoicing dragged the entire invoice engine
// (numbering, draft creation, discount maths, date-fns) into every one of
// those graphs. This module deliberately imports NOTHING.
//
// lib/invoicing re-exports all three, so existing `from '@/lib/invoicing'`
// call sites (including frozen surfaces) keep working unchanged.

// Resolve a recurring cadence to weekly/biweekly/monthly. The legacy `freq`
// column is null for any non-legacy interval (every 3 weeks, every 10 days,
// every 2 months…), so derive from interval_unit/count and map custom cadences
// to the NEAREST standard per-visit price — never the first-visit price.
export function effectiveFreq(freq: string | null, unit?: string | null, count?: number | null): string | null {
  if (freq) return freq
  if (unit === 'week' && (count ?? 1) === 1) return 'weekly'
  if (unit === 'week' && (count ?? 1) === 2) return 'biweekly'
  if (unit === 'week') return (count ?? 0) >= 4 ? 'monthly' : 'biweekly' // every 3wk≈biweekly, 4wk+≈monthly
  if (unit === 'month') return 'monthly'
  if (unit === 'day') return 'weekly'
  return null
}

// The value of ONE visit of a job, from its originating quote. For a recurring
// job the cadence price applies; otherwise the first-visit price. One source of
// truth for "what is this visit worth" — used by invoicing, daily revenue and
// route profitability.
export function quoteVisitAmount(quote: Record<string, unknown> | null | undefined, freq: string | null): number {
  if (!quote) return 0
  const byFreq =
    freq === 'weekly' ? Number(quote.weekly_price)
    : freq === 'biweekly' ? Number(quote.biweekly_price)
    : freq === 'monthly' ? Number(quote.monthly_price)
    : NaN
  if (Number.isFinite(byFreq) && byFreq > 0) return byFreq
  // Recurring visit but the matching cadence price is blank → use ANY recurring
  // price before falling back to the (often setup-inflated) first-visit/total.
  if (freq) {
    const anyRec = [quote.weekly_price, quote.biweekly_price, quote.monthly_price]
      .map(Number).find(n => Number.isFinite(n) && n > 0)
    if (anyRec) return anyRec
  }
  return Number(quote.initial_price) || Number(quote.total) || 0
}

// A visit's value with the job-level manual price taking precedence over the
// quote-derived price. THE single definition of "what is this visit worth".
// `isInitial` = the anchor visit of a recurring series; it derives the quote's
// INITIAL price (freq treated as null) rather than the cadence price, so the
// first visit can show $150 while the rest derive $65. Defaults false →
// identical behaviour for every existing caller (backward compatible).
export function jobVisitValue(jobPrice: number | null | undefined, quote: Record<string, unknown> | null | undefined, freq: string | null, isInitial = false): number {
  const p = Number(jobPrice)
  if (Number.isFinite(p) && p > 0) return p
  return quoteVisitAmount(quote, isInitial ? null : freq)
}
