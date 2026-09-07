import { redirect } from 'next/navigation'
import { createClient } from '@/lib/supabase/server'
import { readUser } from '@/lib/authState'
import { AuthUnavailable } from '@/components/auth/AuthUnavailable'
import { PropertyEstimator } from '@/components/quotes/PropertyEstimator'
import { measurementTypeFor } from '@/lib/measurePricing'
import type { ServiceTemplate, ServicePricingPlanRow } from '@/types'

export const dynamic = 'force-dynamic'

type EstimateService = Pick<ServiceTemplate, 'id' | 'name' | 'measured_by' | 'pricing_display_type'>
type EstimatePlan = Pick<ServicePricingPlanRow, 'id' | 'service_template_id' | 'term' | 'basis' | 'rate' | 'is_recommended' | 'sort_order'>

export default async function PropertyEstimatePage() {
  const supabase = await createClient()
  const auth = await readUser(supabase)
  if (auth.kind === 'signed-out') redirect('/login')
  if (auth.kind === 'unavailable') return <AuthUnavailable reason={auth.reason} />
  const ownerId = auth.user.id
  let businessName = 'Your business'

  const unavailable = (loadError: string) => (
    <PropertyEstimator key={ownerId} ownerId={ownerId} businessName={businessName}
      services={[]} plans={[]} loadError={loadError} />
  )

  try {
    // A verified account alone is not owner authority. Crew accounts have no
    // own business row; no catalogue is read until this prerequisite succeeds.
    const business = await supabase.from('business_settings')
      .select('user_id, company_name').eq('user_id', ownerId).maybeSingle()
    if (business.error) return unavailable('Could not load your business. Try again.')
    if (!business.data || business.data.user_id !== ownerId) {
      return unavailable('Open this estimator from your business owner account.')
    }
    businessName = business.data.company_name?.trim() || businessName

    const [serviceResult, planResult] = await Promise.all([
      supabase.from('service_templates')
        .select('id, name, measured_by, pricing_display_type')
        .eq('user_id', ownerId).eq('is_active', true).order('sort_order'),
      supabase.from('service_pricing_plans')
        .select('id, service_template_id, term, basis, rate, is_recommended, sort_order')
        .eq('user_id', ownerId).order('sort_order'),
    ])
    if (serviceResult.error || planResult.error ||
      !Array.isArray(serviceResult.data) || !Array.isArray(planResult.data)) {
      return unavailable('Could not load your service pricing. Try again.')
    }

    const services = (serviceResult.data as EstimateService[])
      .filter(service => measurementTypeFor(service) === 'area')
    const serviceIds = new Set(services.map(service => service.id))
    const plans = (planResult.data as EstimatePlan[])
      .filter(plan => serviceIds.has(plan.service_template_id))

    return <PropertyEstimator key={ownerId} ownerId={ownerId} businessName={businessName}
      services={services} plans={plans} />
  } catch {
    return unavailable('Could not load your service pricing. Try again.')
  }
}
