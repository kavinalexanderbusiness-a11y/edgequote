import { format, parseISO } from 'date-fns'
import type { ServiceTemplate } from '@/types'
import {
  pricePlans, pricedOnly, formatPlanPrice, termDef,
  measurementTypeFor, unpricedReason,
  type PricedPlan, type PricingTerm, type ServicePricingPlan,
  type MeasurableService, type MeasurementType, type UnpricedReason,
} from '@/lib/measurePricing'
import { MIN_QUOTE_OPTIONS, MAX_QUOTE_OPTIONS, type OptionLike } from '@/lib/quoteOptions'

// ── THE recurring-service offering seam ──────────────────────────────────────
// One answer to "what can this quote offer for this service, and what does each
// offering cost?", so the builder panel, the map modal, the owner's preview and
// the guard cannot reach different answers.
//
// ⛔⛔ NOT A PRICING ENGINE. Every number here comes out of lib/measurePricing's
// pricePlans() — the same call QuoteMeasure already makes, with the same
// arithmetic and the same null. This module ORDERS, NAMES and PRESENTS offerings;
// it never multiplies anything. If a price ever differs between the map and the
// builder, it is because someone added a second multiplication, and that is the
// thing this file exists to make impossible.
//
// ⛔ NOT A SECOND OPTIONS ENGINE. Several offerings become a customer choice by
// producing rows for lib/quoteOptions — the engine that has owned "the customer
// picks one" since V1, including the portal, the PDF, owner-accept and the
// selection RPC. Nothing here selects, prices or totals an option.
//
// ⛔ THE UNIVERSAL-CRM RULE. Nothing in this file reads a service NAME. No
// /snow/i, no /mow/i, no category test, no industry list. A snow contractor, a
// pressure washer, a pool company and a commercial cleaner reach this same code
// and get their own offerings, because the offerings ARE their configuration.

// ── 1. Where a price is allowed to come from ─────────────────────────────────
/**
 * ⭐⭐ THE PRICING PRECEDENCE, stated once so it stops being four opinions.
 *
 * Four things in this codebase can produce a number for a service, and before
 * this they could all speak at once:
 *
 *   service_pricing_plans                            the ways the owner sells it
 *   service_templates.default_rate x a measurement   (the per_sqft arm)
 *   hours x crew x rate                              (the labour arm)
 *   service_templates.default_rate                   ("starting from")
 *
 * ⭐ THE FIRST TWO ARE THE SAME ARITHMETIC. A per_unit plan priced against a
 * trace and the `area_rate` recommendation both end in lib/measurePricing's
 * unitRatePrice(). Plans do not win because they multiply better; they win
 * because they are the MORE SPECIFIC CONFIGURATION. `default_rate` is one number
 * for a service that may be sold five ways — it cannot express a monthly price,
 * so where plans exist it is answering a question nobody asked.
 *
 * ⭐ Hence the demotion rule the whole session turns on: WHEN PLANS EXIST, THE
 * STARTING PRICE IS A DISPLAY HINT, NOT A QUOTE INPUT. It is never deleted and
 * never migrated — it still formats the catalogue's "Starting from $65" and it
 * is still exactly what speaks for every service with no plans configured, which
 * today is almost all of them.
 */
export type PricingSource =
  | 'configured_plans'
  | 'measured_template_rate'
  | 'labour'
  | 'starting_price'
  | 'unknown'

/** Most specific first. Exported so the guard asserts the order, not a comment. */
export const PRICING_PRECEDENCE: readonly PricingSource[] = [
  'configured_plans',
  'measured_template_rate',
  'labour',
  'starting_price',
  'unknown',
] as const

export const PRICING_SOURCE_LABEL: Record<PricingSource, string> = {
  configured_plans: 'Your pricing plans for this service',
  measured_template_rate: 'Your rate for this service × the measurement',
  labour: 'Hours × crew × your labour rate',
  starting_price: 'Your starting price for this service',
  unknown: 'Not enough configured to price this',
}

/**
 * Which source speaks for this service, given what is configured.
 *
 * ⭐ Asked BEFORE any price is computed, and answered only from configuration —
 * never from whether a number came out nicely. A source that is entitled to
 * speak but has nothing to say produces UNKNOWN, and unknown stays unknown.
 */
export function pricingSourceFor(
  service: MeasurableService | null | undefined,
  plans: ServicePricingPlan[] | null | undefined,
  hasMeasurement: boolean,
  hasLabour: boolean,
): PricingSource {
  if (plans?.length) return 'configured_plans'
  const t = (service as ServiceTemplate | null)?.pricing_display_type
  if (t === 'per_sqft' && hasMeasurement) return 'measured_template_rate'
  if (hasLabour) return 'labour'
  if (t === 'starting_from' || t === 'starting_from_materials') return 'starting_price'
  return 'unknown'
}

/**
 * ⭐ THE DEMOTION PREDICATE. True when this service's canonical commercial plans
 * exist, and the generic Starting Price is therefore a fallback/display hint
 * rather than a competing quote input.
 *
 * One predicate, asked by the Price Book editor (to move the field under
 * Advanced) and by the guard. ⛔ It never means "hide" and never means "delete":
 * historical data stays, and a service whose plans are later removed goes
 * straight back to being priced by it.
 */
export function startingPriceIsFallback(plans: ServicePricingPlan[] | null | undefined): boolean {
  return (plans?.length ?? 0) > 0
}

// ── 2. A plan, as a customer would read it ───────────────────────────────────
/**
 * The four owner-authored fields a plan row can carry beyond its price
 * (migration 20260827120000). All nullable, all NULL until the owner types
 * something, and NULL renders as NOTHING.
 *
 * ⛔ There are no defaults in this module and there must never be. "Pay only
 * when service occurs" is a promise about how a business operates; shipping it
 * as a default would put words the owner never wrote in front of their customer
 * — on a document that is a commercial offer.
 */
export interface PlanPresentation {
  customer_note?: string | null
  term_label?: string | null
  term_start?: string | null
  term_end?: string | null
}

export type OfferingPlan = ServicePricingPlan & PlanPresentation

/** "Nov 1, 2026 – Mar 31, 2027" · "2026/27 Winter Season" · both · or null. */
export function termText(p: PlanPresentation | null | undefined): string | null {
  const label = String(p?.term_label ?? '').trim() || null
  const range = dateRangeText(p?.term_start, p?.term_end)
  if (label && range) return `${label} · ${range}`
  return label ?? range
}

function dateRangeText(start?: string | null, end?: string | null): string | null {
  const a = safeDate(start)
  const b = safeDate(end)
  if (a && b) return `${format(a, 'MMM d, yyyy')} – ${format(b, 'MMM d, yyyy')}`
  // A half-dated term is a real state while the owner is still typing, and
  // saying "from Nov 1, 2026" is more honest than saying nothing.
  if (a) return `From ${format(a, 'MMM d, yyyy')}`
  if (b) return `Until ${format(b, 'MMM d, yyyy')}`
  return null
}

function safeDate(v?: string | null): Date | null {
  const s = String(v ?? '').trim()
  if (!s) return null
  try {
    const d = parseISO(s)
    return Number.isNaN(d.getTime()) ? null : d
  } catch {
    return null
  }
}

/** One offering: a priced plan plus the words the owner configured for it. */
export interface Offering {
  term: PricingTerm
  /** "Monthly" — the commercial term's own label, from ONE catalogue. */
  label: string
  /** "/month" — what the money is per. */
  priceSuffix: string
  /** ⭐⭐ null = UNKNOWN. Never 0, never a guess. */
  price: number | null
  /** "$240 / month", or null when the price is unknown. */
  priceText: string | null
  /** OWNER-facing provenance: "$0.05/sq ft × 1,392 sq ft". ⛔ Not for customers. */
  basisText: string
  /** CUSTOMER-facing, owner-authored. null when they wrote nothing. */
  customerNote: string | null
  /** The period this price covers, owner-configured. null when undated. */
  termText: string | null
  isRecommended: boolean
}

/**
 * Every way this service is sold, priced against this measurement.
 *
 * The prices come from pricePlans() unchanged — this maps the presentation
 * fields alongside them and does no arithmetic of its own.
 */
export function offeringsFor(
  plans: OfferingPlan[] | null | undefined,
  measuredValue: number | null,
  type: MeasurementType,
): Offering[] {
  const list = [...(plans || [])].sort((a, b) => (a.sort_order ?? 0) - (b.sort_order ?? 0))
  const priced = pricePlans(list, measuredValue, type)
  return priced.map((p, i) => fromPriced(p, list[i]))
}

function fromPriced(p: PricedPlan, source: OfferingPlan | undefined): Offering {
  return {
    term: p.term,
    label: p.label,
    priceSuffix: p.priceSuffix,
    price: p.price,
    priceText: formatPlanPrice(p),
    basisText: p.basisText,
    customerNote: String(source?.customer_note ?? '').trim() || null,
    termText: termText(source),
    isRecommended: p.isRecommended,
  }
}

/** Offerings that carry a real number — the only ones that may reach a customer. */
export function offerable(offerings: Offering[] | null | undefined): Offering[] {
  return (offerings || []).filter(o => o.price != null)
}

/** The one to land on: the owner's recommended, else the first that has a price. */
export function defaultOffering(offerings: Offering[] | null | undefined): Offering | null {
  const priced = offerable(offerings)
  if (!priced.length) return null
  return priced.find(o => o.isRecommended) ?? priced[0]
}

// ── 3. How the quote is built ────────────────────────────────────────────────
/**
 * What the owner chose to do with the offerings.
 *   'single'   one price, chosen by the owner  → quotes.initial_price
 *   'options'  the CUSTOMER picks              → quote_options rows
 */
export type OfferingMode = 'single' | 'options'

/**
 * May this service's offerings become a customer-facing choice?
 *
 * Delegates the threshold to lib/quoteOptions rather than restating it: that
 * engine refuses fewer than two, and a second copy of "2" here is a second
 * answer waiting to drift.
 */
export function canOfferOptions(offerings: Offering[] | null | undefined): boolean {
  return offerable(offerings).length >= MIN_QUOTE_OPTIONS
}

/** As many as Quote Options accepts, priced ones only, in the owner's order. */
export function offerableForOptions(offerings: Offering[] | null | undefined): Offering[] {
  return offerable(offerings).slice(0, MAX_QUOTE_OPTIONS)
}

/**
 * ⭐⭐ OFFERINGS → QUOTE OPTIONS. The whole "do not make the owner rebuild three
 * options by hand" requirement, in one function.
 *
 * The option NAME is the commercial term's label; the PRICE is the plan's price;
 * `is_recommended` is the owner's own badge, carried not invented.
 *
 * ⭐ THE DESCRIPTION IS THE OWNER'S SENTENCE, OR NOTHING. It used to be
 * `basisText` — "$0.05/sq ft × 1,392 sq ft" — which is the owner's rationale for
 * the number, written onto a field the customer reads on the quote, the portal
 * and the PDF. A customer does not need to audit the arithmetic; they need to
 * know what they are buying. When the owner has written nothing, the option
 * carries no description rather than a manufactured one.
 *
 * The term, when configured, travels with it — "$900 / season" is not an offer
 * until it says which season.
 *
 * Everything produced here is EDITABLE in the options editor before the quote is
 * sent. This seeds; it does not decide.
 */
export function offeringOptionRows(offerings: Offering[] | null | undefined): OptionLike[] {
  return offerableForOptions(offerings).map(o => ({
    name: o.label,
    description: optionDescription(o),
    price: o.price as number,
    is_recommended: o.isRecommended,
  }))
}

/** The customer-facing sentence for one offering: the owner's note, the term,
 *  both, or nothing at all. ⛔ Never the provenance string. */
export function optionDescription(o: Offering): string {
  return [o.customerNote, o.termText].filter(Boolean).join(' · ')
}

// ── 4. What to say when there is nothing to offer ────────────────────────────
/**
 * Why this service has no offerings to show, or null when it has.
 *
 * Delegates to lib/measurePricing's unpricedReason so the builder panel and the
 * map modal give the SAME diagnosis — the owner should not be told "pricing not
 * configured" on one screen and "trace the area" on the other.
 *
 * ⭐ The one case this adds: a service with plans that is NOT measured. That is
 * not an error and not a missing measurement — a flat $240/month plan is fully
 * priced with nothing traced — so it must never inherit 'not_measured', which is
 * the sentence that used to hide configured plans behind a satellite map.
 */
export function noOfferingsReason(
  service: MeasurableService | null | undefined,
  plans: ServicePricingPlan[] | null | undefined,
  measuredValue: number | null,
): UnpricedReason | null {
  if (plans?.length) {
    const priced = pricePlans(plans, measuredValue, measurementTypeFor(service))
    if (pricedOnly(priced).length) return null
    const needsMeasurement = priced.some(p => p.basis === 'per_unit' && p.rate > 0)
    return needsMeasurement && !(Number(measuredValue) > 0) ? 'no_measurement' : 'no_rates'
  }
  return unpricedReason(service, plans, measuredValue)
}

// ── 5. The owner's pre-send summary ──────────────────────────────────────────
/**
 * ⛔ THE SEPARATION, SAID OUT LOUD WHEREVER AN OWNER PICKS A TERM.
 *
 * The single most expensive confusion this feature can create is reading
 * "$240 / month" as "one visit per month". It is not: it is what the customer
 * pays per month, and how often anyone attends is decided by the recurrence and
 * dispatch engines, which this module neither reads nor writes.
 *
 * One sentence, one definition, every surface — so it cannot be softened on the
 * screen where it matters and kept on the screen where it does not.
 */
export const BILLING_VS_VISITS =
  'This sets how the work is priced and billed. Visits are still scheduled separately.'

/** Compact owner preview of one offering: "Monthly — $240 / month · Recommended". */
export function offeringSummary(o: Offering): string {
  const price = o.priceText ?? 'No price'
  return `${o.label} — ${price}${o.isRecommended ? ' · Recommended' : ''}`
}

/**
 * The pricing terms a service offers, in the owner's order, as one line:
 * "One-time · Monthly · Seasonal". Used by the builder's collapsed summary and
 * the pre-send preview, so both name the same set the same way.
 */
export function offeringTermsLine(offerings: Offering[] | null | undefined): string {
  const list = offerable(offerings)
  return list.length ? list.map(o => o.label).join(' · ') : 'No priced plans'
}

/** The catalogue label for a term, without going through a priced plan. */
export function termLabel(term: PricingTerm): string {
  return termDef(term).label
}
