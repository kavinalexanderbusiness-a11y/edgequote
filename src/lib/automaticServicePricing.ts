import { createHash } from 'node:crypto'

export type AutomaticServiceKey =
  | 'mowing'
  | 'fertilization'
  | 'overseeding'
  | 'topsoil'
  | 'weed_treatment'
  | 'snow'

export type AutomaticServiceCadence = 'one_time' | 'weekly' | 'biweekly' | 'monthly' | 'seasonal'

export interface AutomaticServiceBundleLineInput {
  serviceKey: string
  label: string
  cadence: AutomaticServiceCadence | null
  decision: AutomaticServicePricingDecision | null
}

export interface AutomaticBundlePricingVersion {
  id: string
  userId: string
  version: number
  enabled: boolean
  minimumServices: number
  discountKind: 'none' | 'percentage' | 'fixed'
  discountValue: number
  maximumDiscount: number
  minimumMarginPercent: number
  pricingEngineVersion: string
}

export interface AutomaticServiceBundleLine {
  serviceKey: string
  label: string
  cadence: AutomaticServiceCadence | null
  state: 'priced' | 'written_quote_handoff' | 'review_required' | 'out_of_route'
  price: number | null
  priceLabel: string | null
  decision: AutomaticServicePricingDecision | null
}

export type AutomaticServiceBundleDecision =
  | {
      state: 'priced'
      estimateStatus: 'written_estimate'
      lines: AutomaticServiceBundleLine[]
      subtotal: number
      discount: number
      bundlePrice: number
      bundlePricingVersionId: string | null
      bundlePricingVersion: number | null
      pricingMode: 'single_owner_authorized_line' | 'owner_authorized_bundle'
    }
  | {
      state: 'written_quote_handoff'
      lines: AutomaticServiceBundleLine[]
      pricedSubtotal: number
      bundlePrice: null
      reason: 'non_measurable_service' | 'owner_review_required' | 'bundle_pricing_not_configured'
    }

/**
 * Owner direction captured on 2026-09-23. These are proposed base rows for the
 * next immutable version, not silent runtime defaults. The engine prices only
 * from a saved version supplied in `input.rules`.
 */
export const OWNER_APPROVED_MOWING_BASES_2026_09_23 = Object.freeze({
  weekly: 45,
  biweekly: 55,
  one_time: 65,
})

export interface PricingMaterialInput {
  key: string
  packageCost: number | null
  packageQuantity: number | null
  applicationQuantityPer1000Sqft: number | null
  wastePercent: number | null
  minimumPackages: number | null
}

export interface PricingDurationBand {
  maximumSqft: number | null
  minutes: number
  crewSize: number
}

export interface AutomaticServicePricingVersion {
  id: string
  userId: string
  version: number
  serviceKey: AutomaticServiceKey
  enabled: boolean
  permittedCadences: AutomaticServiceCadence[]
  acceptedMeasurementConfidences: AutomaticMeasurementEvidence['confidence'][]
  acceptedMeasurementSources: string[]
  maximumMeasurementAgeMinutes: number | null
  basePrices: Partial<Record<AutomaticServiceCadence, number>>
  baseLawnSqft: number | null
  additionalPricePer1000Sqft: number | null
  additionalAreaPrice: number | null
  durationCrewBands: PricingDurationBand[]
  loadedLabourCostPerHour: number | null
  materials: PricingMaterialInput[]
  materialsCostBasisConfirmed: boolean
  equipmentCostPerVisit: number | null
  deliveryCostPerVisit: number | null
  disposalCostPerVisit: number | null
  overheadCostPerVisit: number | null
  contingencyPercent: number | null
  vehicleCostPerKm: number | null
  includedRouteKm: number | null
  routePricePerAdditionalKm: number | null
  minimumNearbyJobsForBase: number | null
  isolatedStopPremium: number | null
  maximumAutomaticDistanceKm: number | null
  maximumRoutePremium: number | null
  maximumAutomaticPrice: number | null
  paymentFeePercent: number | null
  paymentFeeFixed: number | null
  minimumMarginPercent: number | null
  priceRoundingIncrement: number | null
  fullCostBasisConfirmed: boolean
  routeRuleVersion: string | null
  pricingEngineVersion: string
}

export interface AutomaticMeasurementEvidence {
  verifiedByServer: boolean
  sqft: number
  areaCount: number
  confidence: 'high' | 'medium' | 'low'
  source: string
  measuredAt: string
}

export interface CanonicalRouteEvidence {
  verifiedByServer: boolean
  provider: 'google_places' | 'owner_verified'
  placeId: string | null
  checkedAt: string
  city: string | null
  province: string | null
  country: string | null
  quadrant: 'NW' | 'NE' | 'SW' | 'SE' | null
  lat: number | null
  lng: number | null
  baseDistanceKm: number | null
  routeTravelKm: number | null
  nearbyJobs: number | null
  eligibleRouteDays: number | null
  routeRuleVersion: string | null
}

export interface AutomaticServicePricingInput {
  tenantId: string
  serviceKey: AutomaticServiceKey
  cadence: AutomaticServiceCadence
  rules: AutomaticServicePricingVersion | null
  measurement: AutomaticMeasurementEvidence | null
  route: CanonicalRouteEvidence | null
  nowMs: number
  difficultyMultiplier?: number | null
  difficultyVerifiedByServer?: boolean
}

export interface AutomaticPricingGap {
  code: string
  decision: string
}

export type AutomaticServicePricingDecision =
  | { state: 'review_required'; missing: AutomaticPricingGap[] }
  | {
      state: 'out_of_route'
      code: 'route_economics_outside_owner_limits'
      decision: string
      requiredPrice: number
      routePremium: number
    }

  | {
      state: 'priced'
      estimateStatus: 'written_estimate'
      serviceKey: AutomaticServiceKey
      cadence: AutomaticServiceCadence
      price: number
      basePrice: number
      measuredSqft: number
      areaCount: number
      pricingVersionId: string
      pricingVersion: number
      pricingEngineVersion: string
      routeRuleVersion: string
      measurementSource: string
      measurementConfidence: AutomaticMeasurementEvidence['confidence']
      route: {
        quadrant: CanonicalRouteEvidence['quadrant']
        baseDistanceKm: number
        routeTravelKm: number
        nearbyJobs: number
        eligibleRouteDays: number
        premium: number
      }
      components: {
        sizeIncrement: number
        additionalAreaIncrement: number
        difficultyIncrement: number
        routePremium: number
        marginFloorAdjustment: number
      }
      economics: {
        labourCost: number
        materialsCost: number
        equipmentCost: number
        deliveryCost: number
        disposalCost: number
        vehicleCost: number
        overheadCost: number
        contingencyCost: number
        paymentFeeCost: number
        totalCost: number
        profit: number
        marginPercent: number
        minimumMarginPercent: number
      }
      idempotencyKey: string
    }

/**
 * Combines separately authorized service decisions without inventing a bundle
 * discount or shared-cost rule. A customer receives a final bundle total only
 * when every selected line has a complete owner-approved price. Any custom,
 * unavailable, out-of-route or incomplete line routes the whole request to a
 * written quote while preserving supported line estimates for owner review.
 */
export function decideAutomaticServiceBundle(
  input: AutomaticServiceBundleLineInput[],
  bundleRules: AutomaticBundlePricingVersion | null = null,
): AutomaticServiceBundleDecision {
  if (!input.length) {
    return {
      state: 'written_quote_handoff', lines: [], pricedSubtotal: 0,
      bundlePrice: null, reason: 'owner_review_required',
    }
  }
  const seen = new Set<string>()
  const lines = input.map(item => {
    const key = item.serviceKey.trim().toLowerCase()
    const duplicateKey = `${key}|${item.cadence || ''}`
    if (!key || seen.has(duplicateKey) || !item.decision) {
      return {
        serviceKey: key || 'custom', label: item.label.trim() || 'Custom service', cadence: item.cadence,
        state: 'written_quote_handoff' as const, price: null, priceLabel: null, decision: item.decision,
      }
    }
    seen.add(duplicateKey)
    if (item.decision.state === 'priced') {
      return {
        serviceKey: key, label: item.label.trim(), cadence: item.cadence,
        state: 'priced' as const, price: item.decision.price,
        priceLabel: item.decision.cadence === 'one_time' ? 'one-time service' : `${item.decision.cadence} per visit`,
        decision: item.decision,
      }
    }
    return {
      serviceKey: key, label: item.label.trim(), cadence: item.cadence,
      state: item.decision.state as 'review_required' | 'out_of_route',
      price: null, priceLabel: null, decision: item.decision,
    }
  })
  const pricedSubtotal = money(lines.reduce((sum, line) => sum + (line.price ?? 0), 0))
  const handoff = lines.some(line => line.state !== 'priced')
  if (handoff) {
    return {
      state: 'written_quote_handoff', lines, pricedSubtotal, bundlePrice: null,
      reason: lines.some(line => line.state === 'written_quote_handoff')
        ? 'non_measurable_service' : 'owner_review_required',
    }
  }
  if (lines.length > 1) {
    const validRules = bundleRules
      && bundleRules.enabled
      && bundleRules.minimumServices >= 2
      && Number.isInteger(bundleRules.minimumServices)
      && lines.length >= bundleRules.minimumServices
      && Boolean(bundleRules.pricingEngineVersion.trim())
      && Number.isFinite(bundleRules.discountValue) && bundleRules.discountValue >= 0
      && Number.isFinite(bundleRules.maximumDiscount) && bundleRules.maximumDiscount >= 0
      && Number.isFinite(bundleRules.minimumMarginPercent)
      && bundleRules.minimumMarginPercent >= 0 && bundleRules.minimumMarginPercent < 100
      && (bundleRules.discountKind !== 'none' || bundleRules.discountValue === 0)
      && (bundleRules.discountKind !== 'percentage' || bundleRules.discountValue < 100)
    if (!validRules) {
      return {
        state: 'written_quote_handoff', lines, pricedSubtotal,
        bundlePrice: null, reason: 'bundle_pricing_not_configured',
      }
    }
    const rawDiscount = bundleRules.discountKind === 'percentage'
      ? pricedSubtotal * bundleRules.discountValue / 100
      : bundleRules.discountKind === 'fixed' ? bundleRules.discountValue : 0
    const discount = money(Math.min(rawDiscount, bundleRules.maximumDiscount, pricedSubtotal - 0.01))
    if (!Number.isFinite(discount) || discount < 0 || pricedSubtotal - discount <= 0) {
      return {
        state: 'written_quote_handoff', lines, pricedSubtotal,
        bundlePrice: null, reason: 'bundle_pricing_not_configured',
      }
    }
    const bundlePrice = money(pricedSubtotal - discount)
    const totalCost = money(lines.reduce((sum, line) => sum
      + (line.decision?.state === 'priced' ? line.decision.economics.totalCost : 0), 0))
    const marginPercent = bundlePrice > 0 ? dime((bundlePrice - totalCost) / bundlePrice * 100) : -Infinity
    if (marginPercent + 1e-9 < bundleRules.minimumMarginPercent) {
      return {
        state: 'written_quote_handoff', lines, pricedSubtotal,
        bundlePrice: null, reason: 'bundle_pricing_not_configured',
      }
    }
    return {
      state: 'priced', estimateStatus: 'written_estimate', lines,
      subtotal: pricedSubtotal, discount, bundlePrice,
      bundlePricingVersionId: bundleRules.id, bundlePricingVersion: bundleRules.version,
      pricingMode: 'owner_authorized_bundle',
    }
  }
  return {
    state: 'priced', estimateStatus: 'written_estimate', lines,
    subtotal: pricedSubtotal, discount: 0, bundlePrice: pricedSubtotal,
    bundlePricingVersionId: null, bundlePricingVersion: null,
    pricingMode: 'single_owner_authorized_line',
  }
}

const MATERIAL_SERVICES = new Set<AutomaticServiceKey>([
  'fertilization', 'overseeding', 'topsoil', 'weed_treatment',
])
const ROUTE_DAY_SERVICES = new Set<AutomaticServiceKey>(['mowing', 'snow'])

function finite(value: unknown): number | null {
  const number = Number(value)
  return Number.isFinite(number) ? number : null
}

function nonNegative(value: unknown): number | null {
  const number = finite(value)
  return number != null && number >= 0 ? number : null
}

function positive(value: unknown): number | null {
  const number = finite(value)
  return number != null && number > 0 ? number : null
}

function money(value: number): number { return Math.round(value * 100) / 100 }
function dime(value: number): number { return Math.round(value * 10) / 10 }

function stable(value: unknown): string {
  if (value == null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`
  const object = value as Record<string, unknown>
  return `{${Object.keys(object).sort().map(key => `${JSON.stringify(key)}:${stable(object[key])}`).join(',')}}`
}

function fingerprint(value: unknown): string {
  return createHash('sha256').update(stable(value)).digest('hex')
}

function roundedUp(value: number, increment: number): number {
  return money(Math.ceil((value - 1e-9) / increment) * increment)
}

function materialCostForSqft(material: PricingMaterialInput, sqft: number): number | null {
  const packageCost = positive(material.packageCost)
  const packageQuantity = positive(material.packageQuantity)
  const application = positive(material.applicationQuantityPer1000Sqft)
  const waste = nonNegative(material.wastePercent)
  const minimumPackages = nonNegative(material.minimumPackages)
  if (packageCost == null || packageQuantity == null || application == null || waste == null
    || waste > 100 || minimumPackages == null || !Number.isInteger(minimumPackages)) return null
  const neededQuantity = sqft / 1000 * application * (1 + waste / 100)
  const packages = Math.max(minimumPackages, Math.ceil(neededQuantity / packageQuantity))
  return money(packages * packageCost)
}

function readDurationBand(rules: AutomaticServicePricingVersion, sqft: number): PricingDurationBand | null {
  const sorted = [...rules.durationCrewBands]
    .sort((a, b) => (a.maximumSqft ?? Infinity) - (b.maximumSqft ?? Infinity))
  if (!sorted.length || sorted.some(b => positive(b.minutes) == null
    || !Number.isInteger(b.crewSize) || b.crewSize < 1
    || (b.maximumSqft != null && positive(b.maximumSqft) == null))) return null
  return sorted.find(b => b.maximumSqft == null || sqft <= b.maximumSqft) ?? null
}

/**
 * Calculates an owner-authorized estimate. It has no pricing defaults: every
 * commercial input must arrive from one immutable saved version. Missing or
 * stale evidence returns the complete owner-review checklist in one response.
 */
export function decideAutomaticServicePrice(
  input: AutomaticServicePricingInput,
): AutomaticServicePricingDecision {
  const missing: AutomaticPricingGap[] = []
  const add = (code: string, decision: string) => {
    if (!missing.some(item => item.code === code)) missing.push({ code, decision })
  }
  const rules = input.rules
  if (!rules) add('pricing_version_missing', `Save an immutable ${input.serviceKey} pricing version.`)
  else {
    if (rules.userId !== input.tenantId) add('pricing_tenant_mismatch', 'Use a pricing version owned by this business.')
    if (rules.serviceKey !== input.serviceKey) add('pricing_service_mismatch', 'Use the pricing version for the selected service.')
    if (!rules.enabled) add('automatic_pricing_disabled', `Enable automatic ${input.serviceKey} estimates.`)
    if (!rules.permittedCadences.includes(input.cadence)) add('cadence_not_permitted', `Enable ${input.cadence} for this service.`)
    if (!rules.pricingEngineVersion.trim()) add('pricing_engine_version_missing', 'Save the pricing engine version.')
    if (!rules.routeRuleVersion?.trim()) add('route_rule_version_missing', 'Save the route rule version used by this pricing version.')
  }

  const measurement = input.measurement
  if (!measurement?.verifiedByServer) add('measurement_not_server_verified', 'Create a fresh server-verified property measurement.')
  if (measurement) {
    if (positive(measurement.sqft) == null) add('measurement_invalid', 'Use a positive server-measured service area.')
    if (!Number.isInteger(measurement.areaCount) || measurement.areaCount < 1) add('area_count_invalid', 'Save the number of measured service areas.')
    const stamp = Date.parse(measurement.measuredAt)
    const maximumAgeMinutes = rules ? positive(rules.maximumMeasurementAgeMinutes) : null
    if (rules && maximumAgeMinutes == null) add('measurement_maximum_age_missing', 'Save the maximum measurement age.')
    if (!Number.isFinite(stamp) || stamp > input.nowMs + 60_000
      || (maximumAgeMinutes != null && input.nowMs - stamp > maximumAgeMinutes * 60_000)) {
      add('measurement_stale', 'Create a fresh server measurement within the owner-approved age limit.')
    }
    if (rules && !rules.acceptedMeasurementConfidences.includes(measurement.confidence)) {
      add('measurement_confidence_not_accepted', 'Review this measurement confidence or approve it in the pricing version.')
    }
    if (rules && !rules.acceptedMeasurementSources.includes(measurement.source)) {
      add('measurement_source_not_accepted', 'Review this measurement source or approve it in the pricing version.')
    }
  }

  const route = input.route
  if (!route?.verifiedByServer) add('route_not_server_verified', 'Verify the selected Google or owner-approved address on the server.')
  if (route) {
    const routeStamp = Date.parse(route.checkedAt)
    if (!Number.isFinite(routeStamp) || routeStamp > input.nowMs + 60_000 || input.nowMs - routeStamp > 30 * 60_000) {
      add('route_evidence_stale', 'Refresh route and capacity evidence before pricing.')
    }
    if (!route.city || !route.province || !route.country) add('canonical_address_incomplete', 'Use a canonical address with city, province and country.')
    if (route.provider === 'google_places' && !route.placeId?.trim()) add('canonical_place_id_missing', 'Use the selected Google place ID for server address verification.')
    if (route.lat == null || !Number.isFinite(route.lat) || route.lat < -90 || route.lat > 90
      || route.lng == null || !Number.isFinite(route.lng) || route.lng < -180 || route.lng > 180) {
      add('canonical_coordinates_missing', 'Use the server-verified canonical coordinates.')
    }
    if (route.baseDistanceKm == null || nonNegative(route.baseDistanceKm) == null) add('base_distance_missing', 'Calculate road distance from the saved business base.')
    if (route.routeTravelKm == null || nonNegative(route.routeTravelKm) == null) add('route_travel_missing', 'Calculate the route kilometres allocated to this stop.')
    if (route.nearbyJobs == null || !Number.isInteger(route.nearbyJobs) || route.nearbyJobs < 0) add('route_density_missing', 'Count current nearby EdgeHQ route stops.')
    if (rules?.routeRuleVersion && route.routeRuleVersion !== rules.routeRuleVersion) add('route_rules_changed', 'Recalculate the estimate with the current route rules.')
    if (ROUTE_DAY_SERVICES.has(input.serviceKey)
      && (route.eligibleRouteDays == null || !Number.isInteger(route.eligibleRouteDays))) {
      add('route_day_capacity_unknown', 'Check EdgeHQ route-day and capacity rules.')
    } else if (ROUTE_DAY_SERVICES.has(input.serviceKey) && Number(route.eligibleRouteDays) < 1) {
      add('no_eligible_route_day', 'No eligible service day currently has route capacity; owner review is required.')
    }
  }

  if (rules) {
    if (!rules.fullCostBasisConfirmed) add('full_cost_basis_not_confirmed', 'Confirm labour, materials, travel, equipment, overhead, contingency and payment fees.')
    if (positive(rules.basePrices[input.cadence]) == null) add('base_price_missing', `Save a positive ${input.cadence} base price.`)
    if (positive(rules.baseLawnSqft) == null) add('base_lawn_threshold_missing', 'Save the lawn size included in the base price.')
    if (nonNegative(rules.additionalPricePer1000Sqft) == null) add('size_increment_missing', 'Save the price for each additional 1,000 sq ft.')
    if (nonNegative(rules.additionalAreaPrice) == null) add('additional_area_price_missing', 'Save the price for each additional disconnected service area.')
    if (positive(rules.loadedLabourCostPerHour) == null) add('loaded_labour_cost_missing', 'Save loaded labour cost including owner labour and payroll burden.')
    if (nonNegative(rules.equipmentCostPerVisit) == null) add('equipment_cost_missing', 'Save per-visit equipment cost.')
    if (nonNegative(rules.deliveryCostPerVisit) == null) add('delivery_cost_missing', 'Save per-visit delivery cost, including zero when genuinely not applicable.')
    if (nonNegative(rules.disposalCostPerVisit) == null) add('disposal_cost_missing', 'Save per-visit disposal cost, including zero when genuinely not applicable.')
    if (nonNegative(rules.overheadCostPerVisit) == null) add('overhead_cost_missing', 'Save allocated business overhead per visit.')
    if (nonNegative(rules.vehicleCostPerKm) == null) add('vehicle_cost_missing', 'Save the vehicle cost per route kilometre.')
    if (nonNegative(rules.includedRouteKm) == null) add('included_route_km_missing', 'Save the route kilometres included in base pricing.')
    if (nonNegative(rules.routePricePerAdditionalKm) == null) add('route_price_missing', 'Save the customer price per additional route kilometre.')
    if (rules.minimumNearbyJobsForBase == null || !Number.isInteger(rules.minimumNearbyJobsForBase) || rules.minimumNearbyJobsForBase < 0) add('route_density_threshold_missing', 'Save the nearby-job threshold for base route pricing.')
    if (nonNegative(rules.isolatedStopPremium) == null) add('isolated_stop_premium_missing', 'Save the isolated-stop premium, including zero if intentionally waived.')
    if (positive(rules.maximumAutomaticDistanceKm) == null) add('maximum_auto_distance_missing', 'Save the maximum distance eligible for automatic pricing.')
    if (nonNegative(rules.maximumRoutePremium) == null) add('maximum_route_premium_missing', 'Save the largest route premium allowed automatically.')
    if (positive(rules.maximumAutomaticPrice) == null) add('maximum_auto_price_missing', 'Save the largest customer price allowed automatically.')
    if (nonNegative(rules.contingencyPercent) == null || Number(rules.contingencyPercent) > 100) add('contingency_missing', 'Save contingency between 0% and 100%.')
    if (nonNegative(rules.paymentFeePercent) == null || Number(rules.paymentFeePercent) >= 100) add('payment_fee_percent_missing', 'Save the payment fee percentage.')
    if (nonNegative(rules.paymentFeeFixed) == null) add('payment_fee_fixed_missing', 'Save the fixed payment fee, including zero if not applicable.')
    if (nonNegative(rules.minimumMarginPercent) == null || Number(rules.minimumMarginPercent) >= 100) add('minimum_margin_missing', 'Save a contribution-margin floor between 0% and 100%.')
    if (positive(rules.priceRoundingIncrement) == null) add('price_rounding_missing', 'Save a positive customer-price rounding increment.')
    if (!readDurationBand(rules, measurement?.sqft ?? 0)) add('duration_crew_mapping_missing', 'Save valid duration and crew bands covering this property size.')
    if (MATERIAL_SERVICES.has(input.serviceKey)) {
      if (!rules.materialsCostBasisConfirmed) add('materials_cost_basis_not_confirmed', 'Confirm product, package size, application rate, waste and minimum packages.')
      if (!rules.materials.length) add('materials_missing', `Save material inputs for ${input.serviceKey}.`)
      rules.materials.forEach(material => {
        if (!material.key.trim()) add('material_key_missing', 'Name each material cost input.')
        if (materialCostForSqft(material, measurement?.sqft ?? 0) == null) {
          add(`material_${material.key || 'unnamed'}_incomplete`, `Complete package cost, package quantity, application rate, waste and minimum packages for ${material.key || 'the material'}.`)
        }
      })
    }
  }

  if (missing.length || !rules || !measurement || !route) return { state: 'review_required', missing }
  const band = readDurationBand(rules, measurement.sqft)
  if (!band) return { state: 'review_required', missing: [{ code: 'duration_crew_mapping_missing', decision: 'Save a duration and crew band covering this property.' }] }

  const basePrice = Number(rules.basePrices[input.cadence])
  const overBaseSqft = Math.max(0, measurement.sqft - Number(rules.baseLawnSqft))
  const sizeIncrement = money(Math.ceil(overBaseSqft / 1000) * Number(rules.additionalPricePer1000Sqft))
  const additionalAreaIncrement = money(Math.max(0, measurement.areaCount - 1) * Number(rules.additionalAreaPrice))
  const difficultyMultiplier = input.difficultyMultiplier == null ? 1 : Number(input.difficultyMultiplier)
  if (!Number.isFinite(difficultyMultiplier) || difficultyMultiplier < 1 || difficultyMultiplier > 3) {
    return { state: 'review_required', missing: [{ code: 'difficulty_not_verified', decision: 'Review the property difficulty before pricing.' }] }
  }
  if (difficultyMultiplier !== 1 && input.difficultyVerifiedByServer !== true) {
    return { state: 'review_required', missing: [{ code: 'difficulty_not_server_verified', decision: 'Verify the difficult-property adjustment on the server before pricing.' }] }
  }
  const preDifficulty = basePrice + sizeIncrement + additionalAreaIncrement
  const difficultyIncrement = money(preDifficulty * (difficultyMultiplier - 1))
  const extraKm = Math.max(0, Number(route.routeTravelKm) - Number(rules.includedRouteKm))
  const densityPremium = Number(route.nearbyJobs) < Number(rules.minimumNearbyJobsForBase)
    ? Number(rules.isolatedStopPremium) : 0
  const routePremium = money(extraKm * Number(rules.routePricePerAdditionalKm) + densityPremium)

  const labourCost = money(band.minutes / 60 * band.crewSize * Number(rules.loadedLabourCostPerHour))
  const materialsCost = money(rules.materials.reduce((sum, material) => sum + (materialCostForSqft(material, measurement.sqft) ?? 0), 0))
  const equipmentCost = money(Number(rules.equipmentCostPerVisit))
  const deliveryCost = money(Number(rules.deliveryCostPerVisit))
  const disposalCost = money(Number(rules.disposalCostPerVisit))
  const vehicleCost = money(Number(route.routeTravelKm) * Number(rules.vehicleCostPerKm))
  const overheadCost = money(Number(rules.overheadCostPerVisit))
  const directCost = labourCost + materialsCost + equipmentCost + deliveryCost + disposalCost + vehicleCost + overheadCost
  const contingencyCost = money(directCost * Number(rules.contingencyPercent) / 100)
  const costBeforePaymentFee = directCost + contingencyCost
  const marginFraction = Number(rules.minimumMarginPercent) / 100
  const paymentFraction = Number(rules.paymentFeePercent) / 100
  const denominator = 1 - marginFraction - paymentFraction
  if (!(denominator > 0)) {
    return { state: 'review_required', missing: [{ code: 'margin_and_fee_infeasible', decision: 'Reduce the margin target or payment-fee assumption below 100% combined.' }] }
  }
  const marginFloorPrice = money((costBeforePaymentFee + Number(rules.paymentFeeFixed)) / denominator)
  const commercialPrice = money(preDifficulty + difficultyIncrement + routePremium)
  const requiredPrice = roundedUp(Math.max(commercialPrice, marginFloorPrice), Number(rules.priceRoundingIncrement))
  const marginFloorAdjustment = money(Math.max(0, requiredPrice - commercialPrice))

  if (Number(route.baseDistanceKm) > Number(rules.maximumAutomaticDistanceKm)
    || routePremium > Number(rules.maximumRoutePremium)
    || requiredPrice > Number(rules.maximumAutomaticPrice)) {
    return {
      state: 'out_of_route',
      code: 'route_economics_outside_owner_limits',
      decision: 'The verified route or required margin falls outside the owner-approved automatic limits. Review or decline manually.',
      requiredPrice,
      routePremium,
    }
  }

  const paymentFeeCost = money(requiredPrice * paymentFraction + Number(rules.paymentFeeFixed))
  const totalCost = money(costBeforePaymentFee + paymentFeeCost)
  const profit = money(requiredPrice - totalCost)
  const marginPercent = requiredPrice > 0 ? dime(profit / requiredPrice * 100) : -Infinity
  if (marginPercent + 1e-9 < Number(rules.minimumMarginPercent)) {
    return { state: 'review_required', missing: [{ code: 'price_below_margin_floor', decision: 'Review rounding and saved costs because the result fell below the contribution-margin floor.' }] }
  }
  const identity = {
    tenantId: input.tenantId,
    serviceKey: input.serviceKey,
    cadence: input.cadence,
    pricingVersion: { id: rules.id, version: rules.version, engine: rules.pricingEngineVersion },
    routeRuleVersion: rules.routeRuleVersion,
    measurement: { sqft: measurement.sqft, areaCount: measurement.areaCount, source: measurement.source, confidence: measurement.confidence, measuredAt: measurement.measuredAt },
    route: { placeId: route.placeId, lat: route.lat, lng: route.lng, quadrant: route.quadrant, baseDistanceKm: route.baseDistanceKm, routeTravelKm: route.routeTravelKm, nearbyJobs: route.nearbyJobs, eligibleRouteDays: route.eligibleRouteDays },
    components: { basePrice, sizeIncrement, additionalAreaIncrement, difficultyIncrement, routePremium, marginFloorAdjustment },
    economics: { labourCost, materialsCost, equipmentCost, deliveryCost, disposalCost, vehicleCost, overheadCost, contingencyCost, paymentFeeCost, totalCost, profit, marginPercent },
  }
  return {
    state: 'priced', estimateStatus: 'written_estimate', serviceKey: input.serviceKey,
    cadence: input.cadence, price: requiredPrice, basePrice, measuredSqft: measurement.sqft,
    areaCount: measurement.areaCount, pricingVersionId: rules.id, pricingVersion: rules.version,
    pricingEngineVersion: rules.pricingEngineVersion, routeRuleVersion: rules.routeRuleVersion!,
    measurementSource: measurement.source, measurementConfidence: measurement.confidence,
    route: {
      quadrant: route.quadrant, baseDistanceKm: Number(route.baseDistanceKm),
      routeTravelKm: Number(route.routeTravelKm), nearbyJobs: Number(route.nearbyJobs),
      eligibleRouteDays: Number(route.eligibleRouteDays ?? 0), premium: routePremium,
    },
    components: { sizeIncrement, additionalAreaIncrement, difficultyIncrement, routePremium, marginFloorAdjustment },
    economics: {
      labourCost, materialsCost, equipmentCost, deliveryCost, disposalCost, vehicleCost,
      overheadCost, contingencyCost, paymentFeeCost, totalCost, profit, marginPercent,
      minimumMarginPercent: Number(rules.minimumMarginPercent),
    },
    idempotencyKey: fingerprint(identity),
  }
}
