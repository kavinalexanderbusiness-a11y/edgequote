import type { SupabaseClient } from '@supabase/supabase-js'
import {
  decideAutomaticServicePrice,
  decideAutomaticServiceBundle,
  type AutomaticMeasurementEvidence,
  type AutomaticBundlePricingVersion,
  type AutomaticServiceBundleDecision,
  type AutomaticServiceCadence,
  type AutomaticServiceKey,
  type AutomaticServicePricingDecision,
  type AutomaticServicePricingVersion,
  type CanonicalRouteEvidence,
  type PricingDurationBand,
  type PricingMaterialInput,
} from '@/lib/automaticServicePricing'

export interface AutomaticServiceBundleRequest {
  serviceKey: AutomaticServiceKey | string
  label: string
  cadence: AutomaticServiceCadence | null
}

type RuleRow = {
  id: string
  user_id: string
  service_key: string
  version: number
  enabled: boolean
  engine_version: string
  route_rule_version: string
  rules: Record<string, unknown>
}

type BundleRuleRow = {
  id: string
  user_id: string
  version: number
  enabled: boolean
  engine_version: string
  rules: Record<string, unknown>
}

const SERVICE_TEMPLATE_NAMES: Record<AutomaticServiceKey, string[]> = {
  mowing: ['Lawn Mowing', 'Lawn Mowing & Edging', 'Lawn Mowing and Edging'],
  fertilization: ['Lawn Fertilization', 'Fertilization'],
  overseeding: ['Grass Seeding & Overseeding', 'Overseeding'],
  topsoil: ['Topsoil Application', 'Topsoil'],
  weed_treatment: ['Weed Treatment', 'Spot Weed Treatment'],
  snow: ['Snow Removal & Ice Management', 'Snow Removal'],
}

function numberOrNull(value: unknown): number | null {
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : null
}

function strings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === 'string') : []
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown> : {}
}

function durationBands(value: unknown): PricingDurationBand[] {
  if (!Array.isArray(value)) return []
  return value.map(item => record(item)).map(item => ({
    maximumSqft: item.maximum_sqft == null ? null : numberOrNull(item.maximum_sqft),
    minutes: Number(item.minutes),
    crewSize: Number(item.crew_size),
  }))
}

function materials(value: unknown): PricingMaterialInput[] {
  if (!Array.isArray(value)) return []
  return value.map(item => record(item)).map(item => ({
    key: typeof item.key === 'string' ? item.key : '',
    packageCost: numberOrNull(item.package_cost),
    packageQuantity: numberOrNull(item.package_quantity),
    applicationQuantityPer1000Sqft: numberOrNull(item.application_quantity_per_1000_sqft),
    wastePercent: numberOrNull(item.waste_percent),
    minimumPackages: numberOrNull(item.minimum_packages),
  }))
}

function pricingVersion(row: RuleRow): AutomaticServicePricingVersion {
  const rules = record(row.rules)
  const basePrices = record(rules.base_prices)
  return {
    id: row.id,
    userId: row.user_id,
    version: Number(row.version),
    serviceKey: row.service_key as AutomaticServiceKey,
    enabled: row.enabled === true,
    permittedCadences: strings(rules.permitted_cadences) as AutomaticServiceCadence[],
    acceptedMeasurementConfidences: strings(rules.accepted_measurement_confidences) as AutomaticMeasurementEvidence['confidence'][],
    acceptedMeasurementSources: strings(rules.accepted_measurement_sources),
    maximumMeasurementAgeMinutes: numberOrNull(rules.maximum_measurement_age_minutes),
    basePrices: {
      one_time: numberOrNull(basePrices.one_time) ?? undefined,
      weekly: numberOrNull(basePrices.weekly) ?? undefined,
      biweekly: numberOrNull(basePrices.biweekly) ?? undefined,
      monthly: numberOrNull(basePrices.monthly) ?? undefined,
      seasonal: numberOrNull(basePrices.seasonal) ?? undefined,
    },
    baseLawnSqft: numberOrNull(rules.base_lawn_sqft),
    additionalPricePer1000Sqft: numberOrNull(rules.additional_price_per_1000_sqft),
    additionalAreaPrice: numberOrNull(rules.additional_area_price),
    durationCrewBands: durationBands(rules.duration_crew_bands),
    loadedLabourCostPerHour: numberOrNull(rules.loaded_labour_cost_per_hour),
    materials: materials(rules.materials),
    materialsCostBasisConfirmed: rules.materials_cost_basis_confirmed === true,
    equipmentCostPerVisit: numberOrNull(rules.equipment_cost_per_visit),
    deliveryCostPerVisit: numberOrNull(rules.delivery_cost_per_visit),
    disposalCostPerVisit: numberOrNull(rules.disposal_cost_per_visit),
    overheadCostPerVisit: numberOrNull(rules.overhead_cost_per_visit),
    contingencyPercent: numberOrNull(rules.contingency_percent),
    vehicleCostPerKm: numberOrNull(rules.vehicle_cost_per_km),
    includedRouteKm: numberOrNull(rules.included_route_km),
    routePricePerAdditionalKm: numberOrNull(rules.route_price_per_additional_km),
    minimumNearbyJobsForBase: numberOrNull(rules.minimum_nearby_jobs_for_base),
    isolatedStopPremium: numberOrNull(rules.isolated_stop_premium),
    maximumAutomaticDistanceKm: numberOrNull(rules.maximum_automatic_distance_km),
    maximumRoutePremium: numberOrNull(rules.maximum_route_premium),
    maximumAutomaticPrice: numberOrNull(rules.maximum_automatic_price),
    paymentFeePercent: numberOrNull(rules.payment_fee_percent),
    paymentFeeFixed: numberOrNull(rules.payment_fee_fixed),
    minimumMarginPercent: numberOrNull(rules.minimum_margin_percent),
    priceRoundingIncrement: numberOrNull(rules.price_rounding_increment),
    fullCostBasisConfirmed: rules.full_cost_basis_confirmed === true,
    routeRuleVersion: row.route_rule_version,
    pricingEngineVersion: row.engine_version,
  }
}

function bundlePricingVersion(row: BundleRuleRow): AutomaticBundlePricingVersion {
  const rules = record(row.rules)
  return {
    id: row.id,
    userId: row.user_id,
    version: Number(row.version),
    enabled: row.enabled === true,
    minimumServices: Number(rules.minimum_services),
    discountKind: String(rules.discount_kind || '') as AutomaticBundlePricingVersion['discountKind'],
    discountValue: Number(rules.discount_value),
    maximumDiscount: Number(rules.maximum_discount),
    minimumMarginPercent: Number(rules.minimum_margin_percent),
    pricingEngineVersion: row.engine_version,
  }
}

function review(code: string, decision: string): AutomaticServicePricingDecision {
  return { state: 'review_required', missing: [{ code, decision }] }
}

/**
 * Loads the one owner-authorized version and runs the pure fail-closed engine.
 * Canonical address, route and measurement evidence must be produced by the
 * server integrations before this function is called. Browser-provided route or
 * price values are never accepted here.
 */
export async function attemptAutomaticServiceEstimate(input: {
  admin: SupabaseClient
  bookingToken: string
  serviceKey: AutomaticServiceKey
  cadence: AutomaticServiceCadence
  measurement: AutomaticMeasurementEvidence | null
  route: CanonicalRouteEvidence | null
  difficultyMultiplier?: number | null
  difficultyVerifiedByServer?: boolean
  nowMs?: number
}): Promise<AutomaticServicePricingDecision> {
  const { data: settings, error: settingsError } = await input.admin.from('business_settings')
    .select('user_id').eq('booking_token', input.bookingToken).eq('booking_enabled', true).maybeSingle()
  if (settingsError || !settings?.user_id) {
    return review('site_settings_unavailable', 'Review the request because the business settings could not be verified.')
  }
  const tenantId = String(settings.user_id)
  const names = SERVICE_TEMPLATE_NAMES[input.serviceKey]
  const { data: service, error: serviceError } = await input.admin.from('service_templates')
    .select('id').eq('user_id', tenantId).eq('is_active', true).not('published_at', 'is', null)
    .in('name', names).limit(1)
  if (serviceError || !service?.length) {
    return review('service_not_published', `Publish ${input.serviceKey} in EdgeHQ before automatic estimates.`)
  }
  const { data: ruleRow, error: ruleError } = await input.admin.from('automatic_service_pricing_versions')
    .select('id,user_id,service_key,version,enabled,engine_version,route_rule_version,rules')
    .eq('user_id', tenantId).eq('service_key', input.serviceKey).eq('is_active', true).maybeSingle()
  if (ruleError) return review('pricing_version_unavailable', 'Review the request because the active pricing version could not be verified.')
  return decideAutomaticServicePrice({
    tenantId,
    serviceKey: input.serviceKey,
    cadence: input.cadence,
    rules: ruleRow ? pricingVersion(ruleRow as RuleRow) : null,
    measurement: input.measurement,
    route: input.route,
    difficultyMultiplier: input.difficultyMultiplier,
    difficultyVerifiedByServer: input.difficultyVerifiedByServer,
    nowMs: input.nowMs ?? Date.now(),
  })
}

/**
 * Prices each measurable service through its own immutable owner-confirmed
 * rules. Unsupported/custom services deliberately have no synthetic decision;
 * the bundle combiner converts them to a written-quote handoff.
 */
export async function attemptAutomaticServiceBundleEstimate(input: {
  admin: SupabaseClient
  bookingToken: string
  services: AutomaticServiceBundleRequest[]
  measurementByService: Partial<Record<AutomaticServiceKey, AutomaticMeasurementEvidence | null>>
  routeByService: Partial<Record<AutomaticServiceKey, CanonicalRouteEvidence | null>>
  nowMs?: number
}): Promise<AutomaticServiceBundleDecision> {
  const supported = new Set<AutomaticServiceKey>([
    'mowing', 'fertilization', 'overseeding', 'topsoil', 'weed_treatment', 'snow',
  ])
  const lines = []
  for (const service of input.services.slice(0, 12)) {
    const serviceKey = String(service.serviceKey).trim().toLowerCase()
    const automatic = supported.has(serviceKey as AutomaticServiceKey) && service.cadence != null
    const decision = automatic
      ? await attemptAutomaticServiceEstimate({
          admin: input.admin,
          bookingToken: input.bookingToken,
          serviceKey: serviceKey as AutomaticServiceKey,
          cadence: service.cadence!,
          // Lawn services may deliberately share one server-attested lawn
          // measurement. Snow must receive its own driveway/service-area
          // evidence; this API never substitutes lawn area for it.
          measurement: input.measurementByService[serviceKey as AutomaticServiceKey] ?? null,
          route: input.routeByService[serviceKey as AutomaticServiceKey] ?? null,
          nowMs: input.nowMs,
        })
      : null
    lines.push({
      serviceKey,
      label: service.label,
      cadence: service.cadence,
      decision,
    })
  }
  const needsBundleRules = lines.length > 1
    && lines.every(line => line.decision?.state === 'priced')
  let bundleRules: AutomaticBundlePricingVersion | null = null
  if (needsBundleRules) {
    const { data: settings, error: settingsError } = await input.admin.from('business_settings')
      .select('user_id').eq('booking_token', input.bookingToken).eq('booking_enabled', true).maybeSingle()
    if (!settingsError && settings?.user_id) {
      const { data: row, error } = await input.admin.from('automatic_bundle_pricing_versions')
        .select('id,user_id,version,enabled,engine_version,rules')
        .eq('user_id', settings.user_id).eq('is_active', true).maybeSingle()
      if (!error && row) bundleRules = bundlePricingVersion(row as BundleRuleRow)
    }
  }
  return decideAutomaticServiceBundle(lines, bundleRules)
}

/** Public response contains the supported price, never the internal cost model. */
export function publicAutomaticServiceEstimate(decision: AutomaticServicePricingDecision): Record<string, unknown> {
  if (decision.state === 'priced') {
    return {
      state: 'priced',
      estimate_status: decision.estimateStatus,
      service: decision.serviceKey,
      cadence: decision.cadence,
      price: decision.price,
      price_label: decision.cadence === 'one_time' ? 'one-time service' : `${decision.cadence} per visit`,
      measured_sqft: decision.measuredSqft,
      measurement_confidence: decision.measurementConfidence,
      may_request_day: true,
      booking_status: 'not_booked',
    }
  }
  if (decision.state === 'out_of_route') {
    return { state: 'out_of_route', message: 'This property needs a manual route review before we can confirm a price.' }
  }
  return { state: 'review_required', message: 'We need to review this property before confirming a price.' }
}

/** Public multi-service response: no internal costs, margins, rule IDs or gaps. */
export function publicAutomaticServiceBundleEstimate(
  decision: AutomaticServiceBundleDecision,
): Record<string, unknown> {
  const lines = decision.lines.map(line => ({
    service: line.serviceKey,
    label: line.label,
    cadence: line.cadence,
    state: line.state,
    price: line.price,
    price_label: line.priceLabel,
  }))
  if (decision.state === 'priced') {
    return {
      state: 'priced',
      estimate_status: decision.estimateStatus,
      lines,
      subtotal: decision.subtotal,
      bundle_discount: decision.discount,
      bundle_price: decision.bundlePrice,
      bundle_price_label: 'combined service total',
      booking_status: 'not_booked',
    }
  }
  return {
    state: 'written_quote_handoff',
    lines,
    bundle_price: null,
    message: 'We need to review the complete service bundle before confirming one written price.',
    booking_status: 'not_booked',
  }
}
