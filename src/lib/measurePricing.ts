import type { MeasurementUnit } from '@/lib/measure/kinds'
import { UNIT_LABELS } from '@/lib/measure/kinds'
import type { PricingDisplayType } from '@/types'

// ── THE measured-service seam ────────────────────────────────────────────────
// One answer to the two questions Measure & Price has to ask about whatever
// service the owner picked:
//
//   1. IS THIS SERVICE MEASURED, AND OF WHAT?     → measurementTypeFor()
//   2. WHAT ARE THE WAYS THE OWNER SELLS IT?      → pricePlans()
//
// ⛔ THE UNIVERSAL-CRM RULE, WHICH THIS FILE EXISTS TO ENFORCE.
// Nothing here reads a service NAME. There is no `if (/snow/i)`, no `if
// (/lawn/i)`, no keyword table and no industry list. A snow contractor, a
// pressure-washing outfit, a flooring installer and a painter configure the same
// two things — a measurement type and a set of price plans — and are answered by
// the same arithmetic. The Price Book is the ONLY source of "how is this sold".
//
// This replaces the gate that used to sit in QuoteMeasure:
//     const lawnPricing = pricingKind === 'lawn_recurring'
// which withheld every price from every other trade and said so out loud —
// "Measures area only — this service isn't priced by lawn cadence". Area was
// being measured perfectly well and then thrown away, because the only pricing
// engine wired to the map was the residential mowing cadence engine.
//
// ⛔ NOT A SECOND PRICING ENGINE. There is one multiplication here
// (unitRatePrice) and lib/servicePricing's area_rate arm now calls it, so the
// quote builder's recommendation and the map's plan prices cannot drift apart.
// The lawn cadence engine (lib/pricing) is untouched and still speaks only for
// the services it can honestly price.

// ── 1. What is measured ──────────────────────────────────────────────────────
/**
 * How a service is measured. `none` is a first-class answer, not a missing one:
 * a furnace inspection is not measured, and Measure & Price should not be
 * offered for it.
 */
export type MeasurementType = 'area' | 'length' | 'count' | 'none'

/** The unit each measurement type is counted in — lib/measure's own vocabulary. */
const UNIT_FOR_TYPE: Record<Exclude<MeasurementType, 'none'>, MeasurementUnit> = {
  area: 'sqft',
  length: 'linear_ft',
  count: 'count',
}

export function unitForMeasurementType(t: MeasurementType): MeasurementUnit | null {
  return t === 'none' ? null : UNIT_FOR_TYPE[t]
}

/** "sq ft" · "linear ft" · "" — reuses lib/measure so nothing re-spells a unit. */
export function unitLabel(t: MeasurementType): string {
  const u = unitForMeasurementType(t)
  return u ? UNIT_LABELS[u] : ''
}

/** "1,392 sq ft" · "86 linear ft" · "3". ONE formatter for every measured figure. */
export function formatMeasured(value: number, t: MeasurementType): string {
  const n = Math.round(value).toLocaleString('en-CA')
  const label = unitLabel(t)
  return label ? `${n} ${label}` : n
}

/** The slice of a service_templates row this module reads. Never the name. */
export interface MeasurableService {
  /** The owner's explicit answer. null = they have not said. */
  measured_by?: MeasurementType | null
  /** Consulted only as the legacy bridge below. */
  pricing_display_type?: PricingDisplayType | null
}

/**
 * How this service is measured.
 *
 * ⭐ THE LEGACY BRIDGE. `measured_by` is the new explicit column, but two of the
 * six pricing display types have ALWAYS implied a measurement — a service priced
 * `per_sqft` is measured by area, and one priced `per_linear_ft` by length; that
 * is what those words mean. Reading them keeps every service an owner has
 * already configured working the day this ships, with nothing to migrate and no
 * second setup step. The explicit column wins when set, so an owner can say
 * "measured by area, sold as a flat monthly plan" — which the display type alone
 * could never express, and which is exactly the snow case.
 */
export function measurementTypeFor(s: MeasurableService | null | undefined): MeasurementType {
  const explicit = s?.measured_by
  if (explicit === 'area' || explicit === 'length' || explicit === 'count' || explicit === 'none') return explicit
  if (s?.pricing_display_type === 'per_sqft') return 'area'
  if (s?.pricing_display_type === 'per_linear_ft') return 'length'
  return 'none'
}

/** Is Measure & Price meaningful for this service at all? */
export function isMeasured(s: MeasurableService | null | undefined): boolean {
  return measurementTypeFor(s) !== 'none'
}

// ── 2. How it is sold ────────────────────────────────────────────────────────
/**
 * ⭐⭐ A COMMERCIAL TERM. How the customer BUYS the service and what the money is
 * per — nothing else.
 *
 * ⛔⛔ THIS IS NOT A VISIT SCHEDULE, AND NOTHING MAY TURN IT INTO ONE.
 * Choosing `monthly` does not mean "create four visits a month". Choosing
 * `seasonal` does not mean "create a season's worth of visits". A seasonal snow
 * contract at $900/season might be eight visits or twenty-two — that is decided
 * by the weather and by the canonical recurrence/dispatch engines
 * (lib/recurrence, lib/serviceRecurrence, job_recurrences), which own the
 * operational truth and are not consulted here and not written by here.
 *
 * The two really are independent: a customer can pay monthly for a weekly mow,
 * or per-visit for a service that runs on a season-long agreement. Collapsing
 * them would invent visit counts nobody scheduled and revenue nobody agreed.
 * verify:measure-price asserts that no PricingTerm value is ever handed to a
 * recurrence builder, and that this module imports nothing from the scheduling
 * engines.
 */
export type PricingTerm = 'one_time' | 'weekly' | 'biweekly' | 'monthly' | 'seasonal'

export interface PricingTermDef {
  key: PricingTerm
  /** What the owner ticks, and what the customer reads on the quote. */
  label: string
  /**
   * What the money is PER, in the customer's words. Note that weekly and
   * biweekly are per VISIT, not per week — that is already how this product
   * quotes a cadence (a MeasureApplyPayload's `price` has always been "the
   * selected cadence's per-visit price"), and quoting a mow "per week" when the
   * visit is fortnightly would be a different number wearing the same label.
   */
  priceSuffix: string
}

/**
 * THE catalogue of commercial terms. Ordered as an owner reads them: the
 * one-off first, then tighter commitments. ⛔ Nothing branches on which service
 * this is — every service may offer any subset, and the Price Book decides.
 */
export const PRICING_TERMS: readonly PricingTermDef[] = [
  { key: 'one_time', label: 'One-time', priceSuffix: '/visit' },
  { key: 'weekly', label: 'Weekly', priceSuffix: '/visit' },
  { key: 'biweekly', label: 'Bi-weekly', priceSuffix: '/visit' },
  { key: 'monthly', label: 'Monthly', priceSuffix: '/month' },
  { key: 'seasonal', label: 'Seasonal', priceSuffix: '/season' },
] as const

const TERM_BY_KEY = new Map(PRICING_TERMS.map(t => [t.key, t]))

export function isPricingTerm(v: unknown): v is PricingTerm {
  return typeof v === 'string' && TERM_BY_KEY.has(v as PricingTerm)
}

export function termDef(term: PricingTerm): PricingTermDef {
  const d = TERM_BY_KEY.get(term)
  // Throwing beats defaulting: an unknown term means a migration or a cast went
  // wrong, and quietly calling it "One-time" would put the wrong word — and the
  // wrong price suffix — on a customer's quote.
  if (!d) throw new Error(`Unknown pricing term: ${term}`)
  return d
}

/**
 * How a plan's price is computed.
 *   per_unit  price = rate × the measurement  ($0.08/sq ft × 1,392 sq ft)
 *   flat      price = rate                    ($249/month, whatever the area)
 *
 * These two cover every V1 case in the brief across snow, pressure washing,
 * fertilizer, mulch, sod, cleanups, floor cleaning and painting. Tiers and
 * base-plus-overage were deliberately NOT built: both are expressible as a flat
 * plan the owner prices themselves, and neither can be configured honestly
 * without a tier editor nobody has asked for yet. The smallest model that works
 * broadly, as instructed.
 */
export type PriceBasis = 'per_unit' | 'flat'

/** A row of `service_pricing_plans`. The row existing IS the plan being offered. */
export interface ServicePricingPlan {
  id?: string
  service_template_id: string
  term: PricingTerm
  basis: PriceBasis
  /** $/unit when per_unit, $ when flat. */
  rate: number
  is_recommended?: boolean
  sort_order?: number
}

// ── The one multiplication ───────────────────────────────────────────────────
/**
 * ⭐ THE area/length/count → money step, in one place.
 *
 * Rounded to whole dollars because that is what lib/servicePricing's area_rate
 * arm has always done and what the owner sees quoted; a per-unit rate times a
 * traced polygon otherwise lands on fractions of a cent that no one charges.
 * servicePricing imports this rather than keeping its own `Math.round(rate * x)`
 * so the builder's recommendation and the map's plan price are the same number
 * by construction.
 */
export function unitRatePrice(rate: number, quantity: number): number {
  return Math.round(rate * quantity)
}

/** Per-unit rates always show cents — that precision is the point of a $/unit. */
function unitRateText(n: number): string {
  return new Intl.NumberFormat('en-CA', {
    style: 'currency', currency: 'CAD', minimumFractionDigits: 2, maximumFractionDigits: 2,
  }).format(n)
}

function moneyText(n: number): string {
  return new Intl.NumberFormat('en-CA', {
    style: 'currency', currency: 'CAD',
    minimumFractionDigits: Number.isInteger(n) ? 0 : 2, maximumFractionDigits: 2,
  }).format(n)
}

/** A plan, priced against a measurement — or honestly unable to be. */
export interface PricedPlan {
  term: PricingTerm
  label: string
  priceSuffix: string
  basis: PriceBasis
  rate: number
  /**
   * ⭐⭐ null means UNKNOWN, and null is the whole point of this type.
   *
   * A plan whose rate the owner never configured, or a per-unit plan with
   * nothing measured yet, has no price — and an unknown price is not $0. Showing
   * zero would put "Snow Removal — $0.00 / visit" in front of a customer, which
   * is not a cheap quote, it is a wrong one. Every reader must render the
   * `unpriced` sentence instead; verify:measure-price mutation-tests this by
   * changing `null` to `0` and requiring the guard to fail.
   */
  price: number | null
  /** Plain-language provenance, always shown beside the number. */
  basisText: string
  isRecommended: boolean
}

/**
 * Price ONE plan against a measurement.
 *
 * A rate of zero or less is treated as UNCONFIGURED rather than free. An owner
 * who has genuinely decided a plan costs nothing is describing an inclusion, not
 * a plan the customer buys, and the cost of guessing wrong in the other
 * direction — quoting $0 for real work — is the failure this whole file is
 * against.
 */
export function pricePlan(
  plan: ServicePricingPlan,
  measuredValue: number | null,
  type: MeasurementType,
): PricedPlan {
  const def = termDef(plan.term)
  const rate = Number(plan.rate)
  const base = {
    term: plan.term, label: def.label, priceSuffix: def.priceSuffix,
    basis: plan.basis, rate: Number.isFinite(rate) ? rate : 0,
    isRecommended: !!plan.is_recommended,
  }

  if (!Number.isFinite(rate) || rate <= 0) {
    return { ...base, price: null, basisText: 'No rate configured for this plan' }
  }

  if (plan.basis === 'flat') {
    return { ...base, price: rate, basisText: `Flat ${moneyText(rate)} ${def.priceSuffix.replace('/', 'per ')}`.trim() }
  }

  // per_unit — needs a real measurement. Nothing traced yet is not zero area.
  const v = Number(measuredValue)
  if (!Number.isFinite(v) || v <= 0) {
    return { ...base, price: null, basisText: `${unitRateText(rate)}/${unitLabel(type) || 'unit'} — measure to price` }
  }
  return {
    ...base,
    price: unitRatePrice(rate, v),
    basisText: `${unitRateText(rate)}/${unitLabel(type) || 'unit'} × ${formatMeasured(v, type)}`,
  }
}

/**
 * Every plan the owner offers for this service, priced against this measurement,
 * in the owner's own order. Recommended-first is NOT imposed: an owner who put
 * One-time first meant to, exactly as with quote options.
 */
export function pricePlans(
  plans: ServicePricingPlan[] | null | undefined,
  measuredValue: number | null,
  type: MeasurementType,
): PricedPlan[] {
  return [...(plans || [])]
    .sort((a, b) => (a.sort_order ?? 0) - (b.sort_order ?? 0))
    .map(p => pricePlan(p, measuredValue, type))
}

/** The plan a chooser should land on: the owner's recommended one, else the first. */
export function defaultPlan(priced: PricedPlan[] | null | undefined): PricedPlan | null {
  const list = priced || []
  if (!list.length) return null
  return list.find(p => p.isRecommended) ?? list[0]
}

/** Plans that actually carry a number — the only ones that may reach a customer. */
export function pricedOnly(priced: PricedPlan[] | null | undefined): PricedPlan[] {
  return (priced || []).filter(p => p.price != null)
}

/** "$55.00 / visit" — one place, so the map, the builder and the PDF agree. */
export function formatPlanPrice(p: PricedPlan): string | null {
  return p.price == null ? null : `${moneyText(p.price)} ${p.priceSuffix}`
}

// ── What to say when there is no price ───────────────────────────────────────
/**
 * Why this service cannot be priced from a measurement, in the owner's language,
 * or null when it can. The UI renders this INSTEAD of a number — never a $0, and
 * never a silent empty field.
 */
export type UnpricedReason = 'not_measured' | 'no_plans' | 'no_measurement' | 'no_rates'

export function unpricedReason(
  service: MeasurableService | null | undefined,
  plans: ServicePricingPlan[] | null | undefined,
  measuredValue: number | null,
): UnpricedReason | null {
  if (measurementTypeFor(service) === 'none') return 'not_measured'
  if (!plans?.length) return 'no_plans'
  const priced = pricePlans(plans, measuredValue, measurementTypeFor(service))
  if (pricedOnly(priced).length) return null
  // Distinguish "nothing traced yet" from "the owner never set a rate" — one is
  // the owner's next action on this screen, the other is a trip to the Price Book.
  const needsMeasurement = priced.some(p => p.basis === 'per_unit' && p.rate > 0)
  return needsMeasurement && !(Number(measuredValue) > 0) ? 'no_measurement' : 'no_rates'
}

export const UNPRICED_COPY: Record<UnpricedReason, string> = {
  not_measured: 'This service isn’t measured. Set a measurement type in the Price Book to price it from the map.',
  no_plans: 'Area measured — pricing not configured. Add a pricing plan for this service in the Price Book.',
  no_measurement: 'Trace the area to price this service.',
  no_rates: 'Area measured — pricing not configured. This service’s plans have no rate set yet.',
}

// ── The frozen record ────────────────────────────────────────────────────────
/**
 * ⭐⭐ WHAT A QUOTE REMEMBERS ABOUT A MEASUREMENT, AND WHY IT IS A SNAPSHOT.
 *
 * Everything here is COPIED at the moment the owner uses the measurement, never
 * re-derived on read. The rate, the basis and the term are recorded as they were
 * — so an owner who raises $0.08/sq ft to $0.11 next winter does not silently
 * rewrite what a customer already accepted. This is the same freeze pattern job
 * forms use for checklist labels (Session 69): the live configuration is for the
 * NEXT quote; an issued one carries its own copy.
 *
 * `shapes` is kept because it is the only way to answer "what did we actually
 * agree to clear?" months later, and it is small — a handful of lat/lng rings.
 * No geospatial infrastructure, no PostGIS: it is a record, not an index.
 */
export interface MeasurementSnapshotV2 {
  /** Schema tag, so a later shape can be told apart without guessing. */
  v: 2
  type: MeasurementType
  unit: MeasurementUnit
  /** The total, in `unit`. */
  value: number
  /** Each traced piece, so "driveway 1,180 + walkway 172" survives. */
  parts: Array<{ label: string | null; value: number; ring?: Array<{ lat: number; lng: number }> }>
  measuredAt: string
  /** Which catalogue row priced it — null for a free-text service. */
  serviceTemplateId: string | null
  serviceName: string | null
  /** The commercial term chosen, and the rule that produced the money. */
  term: PricingTerm | null
  basis: PriceBasis | null
  rate: number | null
  /** The resulting price. null when the owner used the measurement without one. */
  price: number | null
}

export function buildMeasurementSnapshot(input: {
  type: MeasurementType
  value: number
  parts: Array<{ label: string | null; value: number; ring?: Array<{ lat: number; lng: number }> }>
  measuredAt: string
  serviceTemplateId: string | null
  serviceName: string | null
  plan: PricedPlan | null
}): MeasurementSnapshotV2 {
  const unit = unitForMeasurementType(input.type)
  return {
    v: 2,
    type: input.type,
    // A snapshot of a non-measured service should never have been built; 'sqft'
    // is the least-wrong fallback and the type above still records the truth.
    unit: unit ?? 'sqft',
    value: input.value,
    parts: input.parts,
    measuredAt: input.measuredAt,
    serviceTemplateId: input.serviceTemplateId,
    serviceName: input.serviceName,
    term: input.plan?.term ?? null,
    basis: input.plan?.basis ?? null,
    rate: input.plan?.rate ?? null,
    price: input.plan?.price ?? null,
  }
}
