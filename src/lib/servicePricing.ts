import type { PricingDisplayType } from '@/types'
import { serviceKey } from './labor'

// ── Service pricing formatter ───────────────────────────────────────────────────
// THE single place service-template prices become a display string. Every surface
// that shows a service's price (templates editor, quote builder service picker,
// suggested pricing, PDFs, portal, website, Marketing Studio, …) calls this — so
// we never hardcode "/hr" or "$X" labels again. Pricing math (quote totals, the
// lawn pricing engine, invoices) is untouched; this is display only.
//
//   starting_from            → "Starting from $65"
//   starting_from_materials  → "Starting from $250 + materials"
//   hourly                   → "$95/hr"
//   hourly_materials         → "$95/hr + materials"
//   per_sqft                 → "$3.00/sq ft"
//   per_linear_ft            → "$8.00/linear ft"

export interface PriceableService {
  pricing_display_type: PricingDisplayType
  default_rate: number
}

// Whole-dollar amounts (starting prices, hourly rates) drop the cents when even
// ("$65", "$95"); fractional values keep them ("$65.50").
function dollars(n: number): string {
  const whole = Number.isInteger(n)
  return new Intl.NumberFormat('en-CA', {
    style: 'currency', currency: 'CAD',
    minimumFractionDigits: whole ? 0 : 2, maximumFractionDigits: 2,
  }).format(n)
}

// Per-unit rates always show cents ("$3.00", "$8.00") — that precision is the point.
function unitRate(n: number): string {
  return new Intl.NumberFormat('en-CA', {
    style: 'currency', currency: 'CAD',
    minimumFractionDigits: 2, maximumFractionDigits: 2,
  }).format(n)
}

export function formatServicePrice(s: PriceableService): string {
  const p = Number(s.default_rate) || 0
  switch (s.pricing_display_type) {
    case 'hourly': return `${dollars(p)}/hr`
    case 'hourly_materials': return `${dollars(p)}/hr + materials`
    case 'per_sqft': return `${unitRate(p)}/sq ft`
    case 'per_linear_ft': return `${unitRate(p)}/linear ft`
    case 'starting_from_materials': return `Starting from ${dollars(p)} + materials`
    case 'starting_from':
    default: return `Starting from ${dollars(p)}`
  }
}

// The price input's label in the editor, so it reads correctly per type.
export function priceInputLabel(t: PricingDisplayType): string {
  switch (t) {
    case 'hourly':
    case 'hourly_materials': return 'Hourly Rate'
    case 'per_sqft': return 'Price per Sq Ft'
    case 'per_linear_ft': return 'Price per Linear Ft'
    case 'starting_from_materials':
    case 'starting_from':
    default: return 'Default Starting Price'
  }
}

// Sensible number-input step per type (per-unit rates step in cents).
export function priceInputStep(t: PricingDisplayType): string {
  return t === 'per_sqft' || t === 'per_linear_ft' ? '0.25' : '5'
}

// The basis a COST must be entered on — the mirror of priceInputLabel above.
// A margin only means something when both sides share a unit: $/hr judged against
// $/hr, $/ft² against $/ft². Labelling the cost fields with this (instead of a
// generic "unit cost") is what stops an owner entering a whole-job cost against an
// hourly rate and reading back a nonsense margin.
export function costBasisLabel(t: PricingDisplayType): string {
  switch (t) {
    case 'hourly':
    case 'hourly_materials': return 'per hour'
    case 'per_sqft': return 'per sq ft'
    case 'per_linear_ft': return 'per linear ft'
    case 'starting_from_materials':
    case 'starting_from':
    default: return 'per job'
  }
}

// ── Service pricing KIND ────────────────────────────────────────────────────────
// Which pricing structure a service uses — decides WHICH recommendation engine
// speaks (the lawn cadence engine vs area-rate vs labour) and which quote fields
// an Accept populates. The owner's template display type wins when it's explicit
// about the structure; otherwise THE shared serviceKey() normalizer decides.
//   lawn_recurring → sqft cadence engine (pricingPackage): One-Time/Weekly/Bi-Weekly
//   per_area       → template $/sq ft × measured area (mulch, rock, per-sqft services)
//   labour         → hours × crew × rate (cleanups, hedge, gutter, one-off work)
export type ServicePricingKind = 'lawn_recurring' | 'per_area' | 'labour'

// Does the LAWN CADENCE engine price this service? Read narrowly: pricingPackage()
// charges `base + (lawn_sqft/1000 × mow_rate)` on a Weekly/Bi-Weekly cadence — a
// sentence about mowing a lawn. Route "String Trimming" here and the owner is
// quoted a mowing price, on a mowing cadence, for trimming.
//
// Deliberately NOT serviceKey()'s 'mowing' bucket: that one also catches
// trim/string/edg/cut so a trimming visit's minutes still teach the mowing crew's
// labour model — right for LEARNING, wrong for PRICING. Narrow it there and the
// learning regresses; those are two questions, not one.
//
// Applied INSIDE the 'mowing' arm, never before it — SERVICE_DEFS is ordered, so a
// name carrying two services ("mow + prune") resolves to the earlier def, 'hedge'.
// Matching this pattern up front would promote it to a lawn cadence and reprice
// it. Only ever narrows 'mowing'; pinned in verify-pricing.ts §13.
const LAWN_CADENCE_SERVICE = /mow|grass[\s-]*cut|lawn[\s-]*cut/i

export function servicePricingKind(
  serviceType: string | null | undefined,
  template?: Pick<PriceableService, 'pricing_display_type'> | null,
): ServicePricingKind {
  // The owner's CONFIGURED display type wins first — this is the path any service
  // business is on once it has set its templates up, and it knows nothing about
  // lawns.
  const t = template?.pricing_display_type
  if (t === 'per_sqft') return 'per_area'
  if (t === 'hourly' || t === 'hourly_materials' || t === 'per_linear_ft') return 'labour'
  // Otherwise fall back to the shared serviceKey() normalizer. Only two families
  // get special treatment, because only they have a bespoke engine to route to:
  // mowing has the sqft cadence engine, mulch/rock have area math.
  const s = (serviceType || '').trim()
  const key = serviceKey(s)
  // The cadence engine only speaks for services it can actually price (above).
  // A 'mowing'-bucketed service that isn't literally mowing — "String Trimming",
  // "Lawn Edging" — falls through to labour like any other one-off.
  if (key === 'mowing' && LAWN_CADENCE_SERVICE.test(s)) return 'lawn_recurring'
  if (key === 'mulch' || key === 'rock') return 'per_area'
  // Everything else named — window cleaning, snow, gutters, a trade we've never
  // heard of — is labour. (A LABOUR_KEYS set of lawn/landscaping terms used to sit
  // here listing a dozen of them; it was dead. Every key it caught is non-empty, so
  // this same line already returned 'labour' for it. Removing it changes no
  // outcome and stops implying the engine has to recognise a trade to price it.)
  //
  // An UNNAMED service is not a lawn. This line used to read
  //   `return serviceType?.trim() ? 'labour' : 'lawn_recurring'`
  // so an empty service_type — the state EVERY quote starts in, before the owner
  // has picked anything — fell into the grass cadence engine. On a customer whose
  // property already has a saved measurement (sqft auto-fills), that rendered the
  // full Weekly/Bi-Weekly mowing panel on a quote for a service nobody had chosen
  // yet. 'labour' is the honest neutral: no bespoke engine, price it from hours,
  // and with no hours entered there is nothing to recommend — which is exactly
  // what an empty form should say.
  return 'labour'
}

// ── The service's own recommendation ───────────────────────────────────────────
// THE seam that answers "what can we honestly recommend for this service?" — it
// does not price anything itself. Every number it returns comes from an engine or
// a column that already exists:
//   area_rate     → the owner's own $/unit template rate × a real measurement
//   labour        → lib/pricing's laborSuggestion (passed in — this file must not
//                   import pricing.ts, and pricing.ts must never learn about
//                   templates)
//   catalog_price → the owner's own "starting from" price for this exact service
//
// It returns null when none of those hold. That null is the whole point. The
// builder used to fall back to `2 hr × 1 crew × $50` — numbers nobody entered —
// and render the result as a confirmed price. An unknown price is not $100, the
// same way an unknown cost is not $0 (see lib/margin.ts). When we have no basis,
// we say so and leave the field empty.
export type ServiceRecSource = 'area_rate' | 'labour' | 'catalog_price'

export interface ServiceRec {
  price: number
  /** Plain-language "where this number came from" — always shown next to it. */
  basis: string
  materials: boolean
  source: ServiceRecSource
}

export interface ServiceRecInput {
  kind: ServicePricingKind
  template: (PriceableService & { name: string }) | null
  measuredSqft: number
  /** From lib/pricing's laborSuggestion. null when hours or rate are unknown —
   *  callers must NOT substitute a default; that is the bug this replaces. */
  labour: { price: number; hours: number; crewSize: number; rate: number } | null
}

export function serviceRecommendation(i: ServiceRecInput): ServiceRec | null {
  const materials = (i.template?.pricing_display_type || '').includes('materials')

  // 1. Area rate — the most specific thing we can say: the owner's configured
  //    $/sq ft against a measurement that actually exists.
  if (i.kind === 'per_area' && i.template?.pricing_display_type === 'per_sqft') {
    const rate = Number(i.template.default_rate) || 0
    if (rate > 0 && i.measuredSqft > 0) {
      return {
        price: Math.round(rate * i.measuredSqft),
        basis: `${unitRate(rate)}/sq ft × ${Math.round(i.measuredSqft).toLocaleString()} sq ft`,
        materials, source: 'area_rate',
      }
    }
  }

  // 2. Labour — hours × crew × rate, and ONLY when both hours and rate are real.
  //    Hours come from the learned estimator or the owner's own typing; the rate
  //    from an hourly template or the business's configured Default Labour Rate.
  if (i.labour && i.labour.hours > 0 && i.labour.rate > 0 && i.labour.price > 0) {
    const { hours, crewSize, rate } = i.labour
    return {
      price: i.labour.price,
      basis: `${hours} hr × ${crewSize} crew × ${dollars(rate)}/hr`,
      materials, source: 'labour',
    }
  }

  // 3. The owner's catalogued starting price. Not a guess — they typed it against
  //    this exact service. This is what "Furnace Repair, starting from $189" should
  //    quote before anyone estimates hours; the old code ignored it and proposed
  //    $100 from the fabricated defaults, 47% under the business's own price.
  if (i.template?.pricing_display_type === 'starting_from' || i.template?.pricing_display_type === 'starting_from_materials') {
    const price = Number(i.template.default_rate) || 0
    if (price > 0) {
      return { price, basis: `Your starting price for ${i.template.name}`, materials, source: 'catalog_price' }
    }
  }

  // 4. Nothing honest to say. The caller must render that, not a number.
  return null
}
