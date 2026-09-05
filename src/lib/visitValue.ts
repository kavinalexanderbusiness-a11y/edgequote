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

// ── UNKNOWN IS NOT ZERO ──────────────────────────────────────────────────────
// THE domain law this module now enforces, and the reason the `…OrNull` pair
// below exists:
//
//   UNPRICED  ≠  INTENTIONALLY FREE  ≠  $0 DUE  ≠  PAID
//
// Nobody has priced this work yet is a DIFFERENT FACT from this work is free,
// and both are different from the customer owes nothing right now. For years
// this file collapsed the first into the third by returning a bare `0`, and
// twenty-two consumers — dashboards, profitability, revenue intelligence,
// signals, the optimizer, Growth — read that zero as a real amount. A business
// with ten unpriced visits saw $0 of booked revenue and no warning that the
// figure was fiction.
//
// The fix is not a new engine. It is the SAME arithmetic with its unknown case
// preserved: `null` means nobody has priced this, and a caller that wants a
// number has to say what it wants the unknown to become.
//
// ⛔ `?? 0` on the result of these functions is the bug this file exists to
// prevent. If a surface needs a number, it must first decide — and SAY on
// screen — what it is doing with the unknown ones. See lib/money/unknown.

/** A derived money figure. `null` = UNKNOWN (nobody has priced it), never $0. */
export type DerivedAmount = number | null

// The value of ONE visit of a job, from its originating quote — UNKNOWN-
// PRESERVING. For a recurring job the cadence price applies; otherwise the
// first-visit price. One source of truth for "what is this visit worth".
export function quoteVisitAmountOrNull(quote: Record<string, unknown> | null | undefined, freq: string | null): DerivedAmount {
  if (!quote) return null
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
  // Same precedence the numeric version always had — `initial_price || total`
  // — with ONLY the trailing `|| 0` replaced by the truth: neither is known.
  // ⚠️ The bare truthiness tests are deliberate and must stay: they reproduce
  // `||` exactly, where NaN (absent) and 0 both fall through and a negative
  // does NOT. Rewriting these as `> 0` silently changes the answer for a
  // negative price, which is a different bug from the one being fixed here.
  const initial = Number(quote.initial_price)
  if (initial) return initial
  const total = Number(quote.total)
  if (total) return total
  return null
}

// A visit's value with the job-level manual price taking precedence over the
// quote-derived price — UNKNOWN-PRESERVING. THE single definition of "what is
// this visit worth". `isInitial` = the anchor visit of a recurring series; it
// derives the quote's INITIAL price (freq treated as null) rather than the
// cadence price, so the first visit can show $150 while the rest derive $65.
//
// ⭐ `jobPrice === null` does NOT mean unpriced on its own — on `jobs` it means
// "no job-level override, derive from the quote" (lib/recurrence and the
// schedule page both write `price: null` deliberately to make a series follow
// its quote). Unknown is the case where that derivation ALSO finds nothing.
export function jobVisitValueOrNull(jobPrice: number | null | undefined, quote: Record<string, unknown> | null | undefined, freq: string | null, isInitial = false): DerivedAmount {
  const p = Number(jobPrice)
  if (Number.isFinite(p) && p > 0) return p
  return quoteVisitAmountOrNull(quote, isInitial ? null : freq)
}

// ── The numeric readings ─────────────────────────────────────────────────────
// Unchanged signatures and unchanged answers for every existing caller: these
// are now defined AS the unknown-preserving functions with the unknown spent on
// a zero. That is deliberate — one arithmetic, two readings — so the two can
// never drift the way two copies of a pricing rule always do.
//
// ⚠️ A caller of these is asserting "a zero is a safe answer here". That is true
// for a capacity/ordering input and false for anything a person reads as money.
// Money surfaces call the `…OrNull` pair and say "unknown" out loud.
export function quoteVisitAmount(quote: Record<string, unknown> | null | undefined, freq: string | null): number {
  return quoteVisitAmountOrNull(quote, freq) ?? 0
}

export function jobVisitValue(jobPrice: number | null | undefined, quote: Record<string, unknown> | null | undefined, freq: string | null, isInitial = false): number {
  return jobVisitValueOrNull(jobPrice, quote, freq, isInitial) ?? 0
}
