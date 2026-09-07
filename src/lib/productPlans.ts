/** Proposed product packaging only. This catalogue never decides access. */
export type ProposedPlanId = 'starter' | 'pro' | 'premium'

export interface ProposedPlanFeature {
  id: string
  label: string
  availability: 'available' | 'planned'
}

export interface ProposedProductPlan {
  id: ProposedPlanId
  name: string
  summary: string
  status: 'proposed'
  price: null
  billingCadence: null
  scanAllowance: null
  seatLimit: null
  features: readonly ProposedPlanFeature[]
}

export const PRODUCT_PLAN_STATUS = {
  status: 'proposed',
  enforcementEnabled: false,
} as const

export const PROPOSED_PRODUCT_PLANS: readonly ProposedProductPlan[] = [
  {
    id: 'starter', name: 'Starter', summary: 'The everyday tools to run your business.',
    status: 'proposed', price: null, billingCadence: null, scanAllowance: null, seatLimit: null,
    features: [
      { id: 'customers', label: 'Customers and properties', availability: 'available' },
      { id: 'quotes', label: 'Quotes and invoices', availability: 'available' },
      { id: 'schedule', label: 'Visit scheduling', availability: 'available' },
      { id: 'manual-estimates', label: 'Property estimates from measurements you enter', availability: 'available' },
    ],
  },
  {
    id: 'pro', name: 'Pro', summary: 'Starter tools, with more help preparing and following up on work.',
    status: 'proposed', price: null, billingCadence: null, scanAllowance: null, seatLimit: null,
    features: [
      { id: 'quote-options', label: 'Multiple quote options', availability: 'available' },
      { id: 'image-scanner', label: 'Assisted image measurement', availability: 'available' },
      { id: 'automation', label: 'Follow-up and automation tools', availability: 'available' },
      { id: 'automatic-scans', label: 'Automatic lawn and driveway scans — allowance to be decided', availability: 'planned' },
    ],
  },
  {
    id: 'premium', name: 'Premium', summary: 'Pro tools, with more for teams and customer self-service.',
    status: 'proposed', price: null, billingCadence: null, scanAllowance: null, seatLimit: null,
    features: [
      { id: 'workforce', label: 'Workforce tools', availability: 'available' },
      { id: 'reporting', label: 'Business reporting', availability: 'available' },
      { id: 'higher-scan-allowance', label: 'Higher automatic scan allowance — amount to be decided', availability: 'planned' },
      { id: 'branded-quoter', label: 'Branded customer lawn and driveway quoter', availability: 'planned' },
    ],
  },
]
