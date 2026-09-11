/** Canonical plan preview. Prices describe future opt-in billing, never access. */
export type ProductPlanId = 'base' | 'plus' | 'premium'
export type ProductFeatureId =
  | 'customers' | 'quotes_invoices' | 'scheduling'
  | 'recurring_visits' | 'team_crews' | 'time_tracking' | 'job_cost'
  | 'advanced_insights' | 'operational_suggestions'

export interface ProductPlanFeature {
  readonly id: ProductFeatureId
  readonly label: string
}

export interface ProductPlan {
  readonly id: ProductPlanId
  readonly name: string
  readonly summary: string
  readonly monthlyPriceCents: 2900 | 5900 | 9900
  readonly currency: 'CAD'
  readonly billingCadence: 'month'
  readonly features: readonly ProductPlanFeature[]
}

export const PRODUCT_PLAN_STATUS = Object.freeze({
  status: 'preview',
  billingActive: false,
  enforcementEnabled: false,
} as const)

const feature = (id: ProductFeatureId, label: string): ProductPlanFeature => Object.freeze({ id, label })
const baseFeatures = Object.freeze([
  feature('customers', 'Customers and service locations'),
  feature('quotes_invoices', 'Quotes and invoices'),
  feature('scheduling', 'Visit scheduling'),
])
const plusFeatures = Object.freeze([
  ...baseFeatures,
  feature('recurring_visits', 'Recurring visits and service plans'),
  feature('team_crews', 'Team, crews and assignments'),
  feature('time_tracking', 'Time tracking and timesheets'),
  feature('job_cost', 'Job and crew labour-cost insights'),
])
const premiumFeatures = Object.freeze([
  ...plusFeatures,
  feature('advanced_insights', 'Advanced business insights'),
  feature('operational_suggestions', 'Rebooking and operational suggestions'),
])

// Cumulative features make inheritance explicit for every consumer. This is a
// catalogue, not a licence, a provider grant or proof of a paid subscription.
// No seats, scanning or provider-credit allowances are assigned here.
export const PRODUCT_PLANS: readonly ProductPlan[] = Object.freeze([
  Object.freeze({
    id: 'base', name: 'Base', summary: 'The everyday tools to run your business.',
    monthlyPriceCents: 2900, currency: 'CAD', billingCadence: 'month', features: baseFeatures,
  } as const),
  Object.freeze({
    id: 'plus', name: 'Plus', summary: 'Keep recurring work and your team organized.',
    monthlyPriceCents: 5900, currency: 'CAD', billingCadence: 'month', features: plusFeatures,
  } as const),
  Object.freeze({
    id: 'premium', name: 'Premium', summary: 'See the bigger picture and decide what to do next.',
    monthlyPriceCents: 9900, currency: 'CAD', billingCadence: 'month', features: premiumFeatures,
  } as const),
])
