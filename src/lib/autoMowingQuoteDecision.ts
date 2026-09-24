import { createHash } from 'node:crypto'
import {
  pricingPackage,
  routeDensityTravel,
  travelFeeForDistance,
  type CadenceKey,
  type PricingConfig,
} from '@/lib/pricing'
import { applyFeeRecovery } from '@/lib/invoiceTotals'

export type AutoMowingCadence = 'one_time' | 'weekly' | 'biweekly'
export type AutoMowingDepositType = 'none' | 'percent' | 'fixed'
export type AutoMowingRouteMode = 'approved_neighborhoods' | 'distance_and_density'

export interface AutoMowingRuleVersion {
  id: string
  userId: string
  version: number
  enabled: boolean
  permittedCadences: AutoMowingCadence[]
  acceptedMeasurementConfidences: Array<'high' | 'medium' | 'low'>
  acceptedMeasurementSources: string[]
  maximumMeasurementAgeMinutes: number
  routeMode: AutoMowingRouteMode
  approvedNeighborhoods: string[]
  maximumBaseDistanceKm: number | null
  minimumNearbyJobs: number | null
  minimumCharge: number
  minimumMarginPercent: number
  fullCostBasisConfirmed: boolean
  materialsCostPerVisit: number
  equipmentCostPerVisit: number
  deliveryDisposalCostPerVisit: number
  contingencyPercent: number
  pricingConfigVersionId: string
  durationCrewBands: Array<{ maximumSqft: number | null; minutes: number; crewSize: number }>
  depositType: AutoMowingDepositType
  depositValue: number | null
  quoteValidDays: number
}

/** The immutable owner-selected row. Values are deliberately unknown until validated. */
export interface ExplicitPricingVersion {
  id: string
  user_id: string
  engine_version: unknown
  source: unknown
  base_charge: unknown
  mow_rate_per_1000: unknown
  budget_mult: unknown
  market_mult: unknown
  recommended_mult: unknown
  premium_mult: unknown
  travel_rate_per_km: unknown
  crew_cost_per_hour: unknown
  fee_recovery_percent: unknown
  payment_fee_strategy: unknown
}

export interface ServerMeasurementEvidence {
  verifiedByServer: boolean
  sqft: number
  confidence: string
  source: string
  measuredAt: string
  lat: number
  lng: number
}

export interface ServerRouteEvidence {
  neighborhood: string | null
  baseDistanceKm: number | null
  nearbyJobs: number
}

export interface AutoMowingQuoteInput {
  tenantId: string
  service: string
  requestedCadence: string
  rules: AutoMowingRuleVersion | null
  pricingVersion: ExplicitPricingVersion | null
  measurement: ServerMeasurementEvidence | null
  route: ServerRouteEvidence | null
  nowMs: number
  leadId: string
  customerId: string
}

export interface ReviewReason {
  code: string
  decision: string
}

export type AutoMowingQuoteDecision =
  | { state: 'review_required'; missing: ReviewReason[] }
  | {
      state: 'supported'
      rulesVersionId: string
      rulesVersion: number
      pricingConfigVersionId: string
      pricingEngineVersion: string
      cadence: AutoMowingCadence
      measuredSqft: number
      hours: number
      crewSize: number
      jobPrice: number
      travelFee: number
      total: number
      nearbyJobs: number
      neighborhood: string | null
      depositType: AutoMowingDepositType
      depositValue: number | null
      quoteValidDays: number
      economics: {
        loadedCrewCost: number
        routeCost: number
        materialsCost: number
        equipmentCost: number
        deliveryDisposalCost: number
        contingencyCost: number
        paymentFeeCost: number
        totalCost: number
        profit: number
        marginPercent: number
        minimumMarginPercent: number
        costBasis: string
      }
      idempotencyKey: string
    }

const MOWING_SERVICE_NAMES = new Set(['lawn mowing', 'lawn mowing & edging', 'lawn mowing and edging'])

function money(n: number): number { return Math.round(n * 100) / 100 }
function dime(n: number): number { return Math.round(n * 10) / 10 }
function finite(v: unknown): number | null {
  const n = Number(v)
  return Number.isFinite(n) ? n : null
}
function positive(v: unknown): number | null {
  const n = finite(v)
  return n != null && n > 0 ? n : null
}
function normalizeText(v: string): string { return v.trim().toLowerCase().replace(/\s+/g, ' ') }

function normalizeCadence(v: string): AutoMowingCadence | null {
  const c = normalizeText(v).replace('-', '')
  if (c === 'once' || c === 'one_time' || c === 'onetime') return 'one_time'
  if (c === 'weekly') return 'weekly'
  if (c === 'biweekly') return 'biweekly'
  return null
}

function explicitPricingConfig(row: ExplicitPricingVersion): {
  config: PricingConfig
  engine: string
  crewCostPerHour: number
  feeRecoveryPercent: number
  paymentFeeStrategy: 'absorb' | 'global_price_increase' | 'etransfer_discount'
} | null {
  const engine = typeof row.engine_version === 'string' ? row.engine_version.trim() : ''
  const source = typeof row.source === 'string' ? row.source.trim() : ''
  const baseCharge = positive(row.base_charge)
  const mowRate = positive(row.mow_rate_per_1000)
  const budget = positive(row.budget_mult)
  const market = positive(row.market_mult)
  const recommended = positive(row.recommended_mult)
  const premium = positive(row.premium_mult)
  const travel = finite(row.travel_rate_per_km)
  const crewCost = positive(row.crew_cost_per_hour)
  const feeRecovery = finite(row.fee_recovery_percent)
  const feeStrategy = typeof row.payment_fee_strategy === 'string' ? row.payment_fee_strategy.trim() : ''
  if (!engine || source !== 'recorded' || baseCharge == null || mowRate == null
    || budget == null || market == null || recommended == null || premium == null
    || travel == null || travel < 0 || crewCost == null || feeRecovery == null || feeRecovery < 0 || feeRecovery > 25
    || !['absorb', 'global_price_increase', 'etransfer_discount'].includes(feeStrategy)) return null
  return {
    engine,
    crewCostPerHour: crewCost,
    feeRecoveryPercent: feeRecovery,
    paymentFeeStrategy: feeStrategy as 'absorb' | 'global_price_increase' | 'etransfer_discount',
    config: {
      baseCharge,
      mowRatePer1000: mowRate,
      budgetMult: budget,
      marketMult: market,
      recommendedMult: recommended,
      premiumMult: premium,
      travelRatePerKm: travel,
    },
  }
}

function stable(value: unknown): string {
  if (value == null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`
  const object = value as Record<string, unknown>
  return `{${Object.keys(object).sort().map(k => `${JSON.stringify(k)}:${stable(object[k])}`).join(',')}}`
}

function fingerprint(value: unknown): string {
  return createHash('sha256').update(stable(value)).digest('hex')
}

/**
 * The only automatic mowing decision. It never substitutes code defaults for an
 * owner decision and reports every missing decision in one response.
 */
export function decideAutomaticMowingQuote(input: AutoMowingQuoteInput): AutoMowingQuoteDecision {
  const missing: ReviewReason[] = []
  const add = (code: string, decision: string) => missing.push({ code, decision })
  const rules = input.rules
  const cadence = normalizeCadence(input.requestedCadence)

  if (!MOWING_SERVICE_NAMES.has(normalizeText(input.service))) add('unsupported_service', 'Request only Lawn Mowing or Lawn Mowing & Edging for automatic pricing.')
  if (!rules) add('rules_not_saved', 'Save an automatic mowing pricing ruleset.')
  else {
    if (rules.userId !== input.tenantId) add('tenant_mismatch', 'Use a ruleset owned by this business.')
    if (!rules.enabled) add('auto_pricing_disabled', 'Enable automatic mowing pricing.')
    if (!cadence || !rules.permittedCadences.includes(cadence)) add('cadence_not_permitted', 'Permit this mowing cadence in automatic pricing settings.')
  }

  const measurement = input.measurement
  if (!measurement?.verifiedByServer) add('measurement_not_server_verified', 'Remeasure the confirmed address on the server.')
  if (measurement) {
    if (!(measurement.sqft > 0)) add('measurement_invalid', 'Obtain a positive server measurement.')
    const measuredAt = Date.parse(measurement.measuredAt)
    if (!Number.isFinite(measuredAt) || measuredAt > input.nowMs + 60_000) add('measurement_time_invalid', 'Obtain a measurement with a valid server timestamp.')
    if (rules && Number.isFinite(measuredAt)
      && input.nowMs - measuredAt > rules.maximumMeasurementAgeMinutes * 60_000) {
      add('measurement_too_old', 'Remeasure the address within the allowed measurement age.')
    }
    if (rules && !rules.acceptedMeasurementConfidences.includes(measurement.confidence as never)) {
      add('measurement_confidence_not_accepted', 'Accept this measurement confidence or review the lawn manually.')
    }
    if (rules && !rules.acceptedMeasurementSources.map(normalizeText).includes(normalizeText(measurement.source))) {
      add('measurement_source_not_accepted', 'Accept this server measurement source or review the lawn manually.')
    }
  }

  const route = input.route
  if (!route) add('route_not_verified', 'Verify route fit from current EdgeHQ stops.')
  if (rules && route) {
    if (rules.routeMode === 'approved_neighborhoods') {
      const allowed = rules.approvedNeighborhoods.map(normalizeText)
      if (!route.neighborhood || !allowed.includes(normalizeText(route.neighborhood))) {
        add('neighborhood_not_approved', 'Approve this neighbourhood for automatic mowing quotes.')
      }
    } else {
      if (rules.maximumBaseDistanceKm == null || rules.minimumNearbyJobs == null) {
        add('route_limits_not_saved', 'Save both maximum base distance and minimum nearby jobs.')
      } else {
        if (route.baseDistanceKm == null || route.baseDistanceKm > rules.maximumBaseDistanceKm) {
          add('route_too_far', 'Review this property because it exceeds the saved route distance.')
        }
        if (route.nearbyJobs < rules.minimumNearbyJobs) {
          add('route_density_too_low', 'Review this property because it lacks the saved nearby-job density.')
        }
      }
    }
  }

  let config: {
    config: PricingConfig
    engine: string
    crewCostPerHour: number
    feeRecoveryPercent: number
    paymentFeeStrategy: 'absorb' | 'global_price_increase' | 'etransfer_discount'
  } | null = null
  const pricingVersion = input.pricingVersion
  if (!rules?.pricingConfigVersionId) add('pricing_version_not_selected', 'Select an explicit saved pricing configuration version.')
  if (!pricingVersion) add('pricing_version_missing', 'Save and select a pricing configuration version.')
  else {
    if (pricingVersion.user_id !== input.tenantId) add('pricing_tenant_mismatch', 'Use a pricing version owned by this business.')
    if (rules && pricingVersion.id !== rules.pricingConfigVersionId) add('pricing_version_changed', 'Review and save the current pricing version in automatic pricing settings.')
    config = explicitPricingConfig(pricingVersion)
    if (!config) add('pricing_version_incomplete', 'Use a recorded pricing version with every mowing and route rate explicitly set.')
  }

  let band: AutoMowingRuleVersion['durationCrewBands'][number] | undefined
  if (rules && measurement) {
    const bands = [...rules.durationCrewBands].sort((a, b) => (a.maximumSqft ?? Infinity) - (b.maximumSqft ?? Infinity))
    if (!bands.length || bands.some(b => !(b.minutes > 0) || !Number.isInteger(b.crewSize) || b.crewSize < 1)) {
      add('duration_crew_mapping_invalid', 'Save valid mowing duration and crew-size bands.')
    } else {
      band = bands.find(b => b.maximumSqft == null || measurement.sqft <= b.maximumSqft)
      if (!band) add('duration_crew_mapping_missing', 'Add a duration and crew-size band covering this lawn size.')
    }
  }
  if (rules) {
    if (!(rules.minimumCharge > 0)) add('minimum_charge_missing', 'Save a positive automatic mowing minimum charge.')
    if (!(rules.minimumMarginPercent >= 0 && rules.minimumMarginPercent < 100)) add('minimum_margin_missing', 'Save an automatic quote minimum margin between 0% and 100%.')
    if (!rules.fullCostBasisConfirmed) add('full_cost_basis_not_confirmed', 'Confirm the loaded crew rate and per-visit costs cover the complete mowing cost basis.')
    for (const [value, code, label] of [
      [rules.materialsCostPerVisit, 'materials_cost_invalid', 'materials'],
      [rules.equipmentCostPerVisit, 'equipment_cost_invalid', 'equipment'],
      [rules.deliveryDisposalCostPerVisit, 'delivery_disposal_cost_invalid', 'delivery and disposal'],
      [rules.contingencyPercent, 'contingency_invalid', 'contingency percentage'],
    ] as const) {
      if (!Number.isFinite(value) || value < 0) add(code, `Save a non-negative ${label} cost.`)
    }
    if (!Number.isInteger(rules.quoteValidDays) || rules.quoteValidDays < 1 || rules.quoteValidDays > 90) add('quote_validity_invalid', 'Save quote validity between 1 and 90 days.')
    if (rules.depositType === 'percent' && (!(Number(rules.depositValue) > 0) || Number(rules.depositValue) > 100)) add('deposit_rule_invalid', 'Save a deposit percentage between 0 and 100.')
    if (rules.depositType === 'fixed' && !(Number(rules.depositValue) > 0)) add('deposit_rule_invalid', 'Save a positive fixed deposit amount.')
    if (rules.depositType === 'none' && rules.depositValue != null) add('deposit_rule_invalid', 'Clear the deposit value when no deposit is required.')
  }

  if (missing.length || !rules || !cadence || !measurement || !route || !config || !band) return { state: 'review_required', missing }

  const pkg = pricingPackage(measurement.sqft, config.config, {
    nearbyCount: route.nearbyJobs,
    neighborhoodName: route.neighborhood,
  })
  const cadencePrice = cadence === 'one_time'
    ? pkg.oneTime
    : pkg.options.find(option => option.cadence === cadence)?.price
  if (!(cadencePrice && cadencePrice > 0)) {
    return { state: 'review_required', missing: [{ code: 'canonical_price_unavailable', decision: 'Review the canonical mowing price for this cadence.' }] }
  }
  const travel = routeDensityTravel(travelFeeForDistance(route.baseDistanceKm, config.config), route.nearbyJobs).fee
  const beforeFeeRecovery = Math.max(rules.minimumCharge, cadencePrice + travel)
  const recovered = applyFeeRecovery(beforeFeeRecovery, {
    payment_fee_strategy: config.paymentFeeStrategy,
    fee_recovery_percent: config.feeRecoveryPercent,
  })
  const total = money(Number(recovered))
  const jobPrice = money(total - travel)
  const loadedCrewCost = (band.minutes / 60) * band.crewSize * config.crewCostPerHour
  // The saved loaded rate covers labour, payroll burden, routine fuel/vehicle,
  // routine equipment and allocated overhead. The density-adjusted travel amount
  // is the additional route cost assigned to this stop, so it is counted once.
  const routeCost = travel
  const directCost = loadedCrewCost + routeCost + rules.materialsCostPerVisit
    + rules.equipmentCostPerVisit + rules.deliveryDisposalCostPerVisit
  const contingencyCost = directCost * rules.contingencyPercent / 100
  const paymentFeeCost = total * config.feeRecoveryPercent / 100
  const totalCost = directCost + contingencyCost + paymentFeeCost
  const profit = total - totalCost
  const marginPercent = total > 0 ? profit / total * 100 : -Infinity
  if (marginPercent + 1e-9 < rules.minimumMarginPercent) {
    return {
      state: 'review_required',
      missing: [{
        code: 'price_below_margin_floor',
        decision: `Review the quote because the canonical price yields ${dime(marginPercent)}% margin, below the saved ${dime(rules.minimumMarginPercent)}% floor.`,
      }],
    }
  }
  const economics = {
    loadedCrewCost: dime(loadedCrewCost),
    routeCost: dime(routeCost),
    materialsCost: dime(rules.materialsCostPerVisit),
    equipmentCost: dime(rules.equipmentCostPerVisit),
    deliveryDisposalCost: dime(rules.deliveryDisposalCostPerVisit),
    contingencyCost: dime(contingencyCost),
    paymentFeeCost: dime(paymentFeeCost),
    totalCost: dime(totalCost),
    profit: dime(profit),
    marginPercent: dime(marginPercent),
    minimumMarginPercent: dime(rules.minimumMarginPercent),
    costBasis: 'Owner-confirmed loaded crew rate (labour, payroll burden, routine fuel/vehicle, routine equipment and allocated overhead) plus saved per-visit costs, route allocation, contingency and payment fees.',
  }
  const decisionIdentity = {
    tenant: input.tenantId,
    customer: input.customerId,
    rules: { id: rules.id, version: rules.version },
    pricing: { id: pricingVersion!.id, engine: config.engine },
    cadence,
    measurement: { sqft: measurement.sqft, source: measurement.source, confidence: measurement.confidence, measuredAt: measurement.measuredAt, lat: measurement.lat, lng: measurement.lng },
    route,
    amount: { jobPrice, travel, total },
    economics,
  }
  return {
    state: 'supported',
    rulesVersionId: rules.id,
    rulesVersion: rules.version,
    pricingConfigVersionId: pricingVersion!.id,
    pricingEngineVersion: config.engine,
    cadence,
    measuredSqft: measurement.sqft,
    hours: money(band.minutes / 60),
    crewSize: band.crewSize,
    jobPrice,
    travelFee: travel,
    total,
    nearbyJobs: route.nearbyJobs,
    neighborhood: route.neighborhood,
    depositType: rules.depositType,
    depositValue: rules.depositType === 'none' ? null : money(Number(rules.depositValue)),
    quoteValidDays: rules.quoteValidDays,
    economics,
    idempotencyKey: fingerprint(decisionIdentity),
  }
}
