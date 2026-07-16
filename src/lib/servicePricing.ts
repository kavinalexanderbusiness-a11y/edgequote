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

// ── Service pricing KIND ────────────────────────────────────────────────────────
// Which pricing structure a service uses — decides WHICH recommendation engine
// speaks (the lawn cadence engine vs area-rate vs labour) and which quote fields
// an Accept populates. The owner's template display type wins when it's explicit
// about the structure; otherwise THE shared serviceKey() normalizer decides.
//   lawn_recurring → sqft cadence engine (pricingPackage): One-Time/Weekly/Bi-Weekly
//   per_area       → template $/sq ft × measured area (mulch, rock, per-sqft services)
//   labour         → hours × crew × rate (cleanups, hedge, gutter, one-off work)
export type ServicePricingKind = 'lawn_recurring' | 'per_area' | 'labour'

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
  const key = serviceKey(serviceType || '')
  if (key === 'mowing') return 'lawn_recurring'
  if (key === 'mulch' || key === 'rock') return 'per_area'
  // Everything else named — window cleaning, snow, gutters, a trade we've never
  // heard of — is labour. (A LABOUR_KEYS set of lawn/landscaping terms used to sit
  // here listing a dozen of them; it was dead. Every key it caught is non-empty, so
  // this same line already returned 'labour' for it. Removing it changes no
  // outcome and stops implying the engine has to recognise a trade to price it.)
  return serviceType?.trim() ? 'labour' : 'lawn_recurring'
}
