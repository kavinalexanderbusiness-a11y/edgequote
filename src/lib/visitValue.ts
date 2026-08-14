// ── Visit value — the leaf the whole app can afford to import ────────────────
// THE single definition of "what is this visit worth" and how a recurring
// cadence resolves. Extracted from lib/invoicing because HALF THE APP needs
// these pure functions — geo, the optimizer, weather impact, labor,
// profitability, suggestions, revenue intelligence, signals, dashboards —
// and importing them from lib/invoicing dragged the entire invoice engine
// (numbering, draft creation, discount maths, date-fns) into every one of
// those graphs. This module imports NOTHING but a type.
//
// lib/invoicing re-exports all of them, so existing `from '@/lib/invoicing'`
// call sites (including frozen surfaces) keep working unchanged.

import type { InvoiceLineItem, JobLineItem } from '@/types'

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

// ── What the customer has authorized us to bill for this visit ───────────────
// The base visit value PLUS every approved extra PLUS a separately-billed travel
// charge. It lives here, next to jobVisitValue, because it is the same question
// one step out: jobVisitValue answers "what is the service worth", this answers
// "what may we bill for the whole visit".
//
// ⭐ ONE definition, TWO readers. The invoice engine builds a draft from this, and
// the job-profit review measures margin against it (lib/jobProfit). Because they
// call the same function, "what we were authorized to bill" and "what we billed"
// can only ever differ for a REASON that is itself recorded — a hand-edited
// invoice, or a discount — never because two code paths added up the same visit
// differently.
//
// `job_line_items` are priced EXTRAS (revenue), and once change orders land they
// are what an APPROVAL mints — so an approved extra is authorized value by
// construction, and a pending or declined one has no row and cannot bill.

// Human label for the base service line on an invoice/breakdown ("Weekly Mowing").
function serviceLineLabel(serviceType: string | null | undefined, freq: string | null, isInitial: boolean): string {
  const base = serviceType || 'Services rendered'
  if (isInitial) return `Initial visit — ${base}`
  if (!freq) return base
  const cap = freq.charAt(0).toUpperCase() + freq.slice(1)
  return `${cap} ${base}`
}

// THE single definition of what an invoice should show + total: the base visit
// value (job price > quote) plus every add-on, plus a separate travel charge
// when the quote bills travel separately. Used by the draft + the sync so the
// breakdown and the amount can never disagree.
export function buildInvoiceLineItems(opts: {
  serviceType: string | null
  baseAmount: number
  freq: string | null
  isInitial: boolean
  addons?: Pick<JobLineItem, 'description' | 'amount'>[] | null
  quote?: Record<string, unknown> | null
}): { lineItems: InvoiceLineItem[]; total: number } {
  const lines: InvoiceLineItem[] = []
  const base = Math.round(opts.baseAmount)
  if (base > 0) lines.push({ description: serviceLineLabel(opts.serviceType, opts.freq, opts.isInitial), amount: base, kind: 'service' })
  for (const a of opts.addons || []) {
    const amt = Math.round(Number(a.amount) || 0)
    if (amt !== 0) lines.push({ description: a.description, amount: amt, kind: 'addon' })
  }
  // Separate travel charge only when the quote opted to bill it separately —
  // otherwise it's already inside the cadence price (don't double-count).
  const q = opts.quote
  if (q && q.show_travel_separately && Number(q.travel_fee) > 0) {
    lines.push({ description: 'Travel charge', amount: Math.round(Number(q.travel_fee)), kind: 'travel' })
  }
  const total = lines.reduce((s, l) => s + l.amount, 0)
  return { lineItems: lines, total }
}
