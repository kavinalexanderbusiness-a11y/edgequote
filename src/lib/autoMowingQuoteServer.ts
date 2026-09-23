import type { SupabaseClient } from '@supabase/supabase-js'
import { haversineKm } from '@/lib/geo'
import { densityFor, locatedStops } from '@/lib/routeDensity'
import { localTodayISO } from '@/lib/utils'
import { verifyPublicMeasurementAttestation } from '@/lib/publicMeasurementAttestation'
import {
  decideAutomaticMowingQuote,
  type AutoMowingQuoteDecision,
  type AutoMowingRuleVersion,
  type ExplicitPricingVersion,
} from '@/lib/autoMowingQuoteDecision'

type RuleRow = {
  id: string; user_id: string; version: number; enabled: boolean
  permitted_cadences: string[]; accepted_measurement_confidences: string[]
  accepted_measurement_sources: string[]; maximum_measurement_age_minutes: number
  route_mode: string; approved_neighborhoods: string[]
  maximum_base_distance_km: number | null; minimum_nearby_jobs: number | null
  minimum_charge: number; minimum_margin_percent: number; full_cost_basis_confirmed: boolean
  materials_cost_per_visit: number; equipment_cost_per_visit: number
  delivery_disposal_cost_per_visit: number; contingency_percent: number
  pricing_config_version_id: string
  duration_crew_bands: Array<{ maximum_sqft?: number | null; maximumSqft?: number | null; minutes: number; crew_size?: number; crewSize?: number }>
  deposit_type: string; deposit_value: number | null; quote_valid_days: number
}

export type PublicAutoQuoteResult =
  | { state: 'quoted'; quote_number: string; price: number; cadence: string; price_label: string; portal_path: '/portal-access'; portal_delivery: 'email_if_provided' | 'manual_contact_required' }
  | { state: 'review_required'; missing: Array<{ code: string; decision: string }> }

function asRules(row: RuleRow): AutoMowingRuleVersion {
  return {
    id: row.id, userId: row.user_id, version: Number(row.version), enabled: row.enabled === true,
    permittedCadences: (row.permitted_cadences || []) as AutoMowingRuleVersion['permittedCadences'],
    acceptedMeasurementConfidences: (row.accepted_measurement_confidences || []) as AutoMowingRuleVersion['acceptedMeasurementConfidences'],
    acceptedMeasurementSources: row.accepted_measurement_sources || [],
    maximumMeasurementAgeMinutes: Number(row.maximum_measurement_age_minutes),
    routeMode: row.route_mode as AutoMowingRuleVersion['routeMode'],
    approvedNeighborhoods: row.approved_neighborhoods || [],
    maximumBaseDistanceKm: row.maximum_base_distance_km == null ? null : Number(row.maximum_base_distance_km),
    minimumNearbyJobs: row.minimum_nearby_jobs == null ? null : Number(row.minimum_nearby_jobs),
    minimumCharge: Number(row.minimum_charge), minimumMarginPercent: Number(row.minimum_margin_percent),
    fullCostBasisConfirmed: row.full_cost_basis_confirmed === true,
    materialsCostPerVisit: Number(row.materials_cost_per_visit),
    equipmentCostPerVisit: Number(row.equipment_cost_per_visit),
    deliveryDisposalCostPerVisit: Number(row.delivery_disposal_cost_per_visit),
    contingencyPercent: Number(row.contingency_percent), pricingConfigVersionId: row.pricing_config_version_id,
    durationCrewBands: (row.duration_crew_bands || []).map(b => ({
      maximumSqft: b.maximumSqft ?? b.maximum_sqft ?? null,
      minutes: Number(b.minutes), crewSize: Number(b.crewSize ?? b.crew_size),
    })),
    depositType: row.deposit_type as AutoMowingRuleVersion['depositType'],
    depositValue: row.deposit_value == null ? null : Number(row.deposit_value),
    quoteValidDays: Number(row.quote_valid_days),
  }
}

function review(code: string, decision: string): PublicAutoQuoteResult {
  return { state: 'review_required', missing: [{ code, decision }] }
}

/** Count only unique properties attached to future live mowing visits. */
async function verifiedActiveRouteStops(admin: SupabaseClient, tenantId: string): Promise<
  | { ok: true; stops: Array<{ lat: number; lng: number }> }
  | { ok: false }
> {
  const { data, error, count } = await admin.from('jobs')
    .select('property_id,properties(lat,lng)', { count: 'exact' })
    .eq('user_id', tenantId).gte('scheduled_date', localTodayISO())
    .in('status', ['scheduled', 'in_progress']).ilike('service_type', '%mow%').limit(5000)
  if (error || count == null || count !== (data || []).length) return { ok: false }
  const unique = new Map<string, { lat: number; lng: number }>()
  for (const row of (data || []) as unknown as Array<{ property_id: string | null; properties: { lat: number | null; lng: number | null } | null }>) {
    const rawLat = row.properties?.lat; const rawLng = row.properties?.lng
    if (!row.property_id || typeof rawLat !== 'number' || typeof rawLng !== 'number'
      || !Number.isFinite(rawLat) || !Number.isFinite(rawLng)) continue
    const lat = rawLat; const lng = rawLng
    unique.set(row.property_id, { lat, lng })
  }
  return { ok: true, stops: [...unique.values()] }
}

export async function attemptAutomaticMowingQuote(input: {
  admin: SupabaseClient; bookingToken: string; customerId: string; leadId: string
  address: string; service: string; cadence: string; emailProvided: boolean
  measurementAttestation: unknown; measurementConfirmation: unknown
  claimedSqft: unknown; claimedPolygon: unknown; nowMs?: number
}): Promise<PublicAutoQuoteResult> {
  const nowMs = input.nowMs ?? Date.now()
  const verified = verifyPublicMeasurementAttestation({
    token: input.measurementAttestation, confirmation: input.measurementConfirmation,
    submittedAddress: input.address, submittedSqft: input.claimedSqft,
    submittedPolygon: input.claimedPolygon, nowMs,
  })
  if (!verified.ok) return review(verified.code, verified.decision)

  const { data: settings, error: settingsError } = await input.admin.from('business_settings')
    .select('user_id,base_lat,base_lng').eq('booking_token', input.bookingToken).eq('booking_enabled', true).maybeSingle()
  if (settingsError || !settings?.user_id) return review('site_settings_unavailable', 'Review the lead because business settings could not be verified.')
  const tenantId = String(settings.user_id)
  const { data: publishedMowing, error: publishedMowingError } = await input.admin.from('service_templates')
    .select('id,name')
    .eq('user_id', tenantId)
    .eq('is_active', true)
    .not('published_at', 'is', null)
    .in('name', ['Lawn Mowing', 'Lawn Mowing & Edging', 'Lawn Mowing and Edging'])
    .order('sort_order', { ascending: true })
    .limit(1)
  if (publishedMowingError || !publishedMowing?.length) {
    return review('service_not_published', 'Publish mowing in EdgeHQ before allowing automatic customer quotes.')
  }
  const { data: ruleRow, error: ruleError } = await input.admin.from('auto_mowing_quote_rule_versions')
    .select('*').eq('user_id', tenantId).eq('is_active', true).maybeSingle()
  if (ruleError) return review('rules_unavailable', 'Review the lead because automatic pricing rules could not be verified.')
  const rules = ruleRow ? asRules(ruleRow as RuleRow) : null
  const pricingId = rules?.pricingConfigVersionId || ''
  const { data: pricingRow, error: pricingError } = pricingId
    ? await input.admin.from('pricing_config_versions').select('*').eq('user_id', tenantId).eq('id', pricingId).maybeSingle()
    : { data: null, error: null }
  if (pricingError) return review('pricing_version_unavailable', 'Review the lead because the selected pricing version could not be verified.')

  const activeRoute = await verifiedActiveRouteStops(input.admin, tenantId)
  if (!activeRoute.ok) return review('route_not_verified', 'Review the lead because active EdgeHQ route stops could not be verified.')
  const target = { lat: verified.measurement.lat, lng: verified.measurement.lng }
  const density = densityFor(target, locatedStops(activeRoute.stops))
  const baseLat = Number(settings.base_lat); const baseLng = Number(settings.base_lng)
  const baseDistanceKm = Number.isFinite(baseLat) && Number.isFinite(baseLng)
    ? Math.round(haversineKm(target, { lat: baseLat, lng: baseLng }) * 10) / 10 : null
  const decision: AutoMowingQuoteDecision = decideAutomaticMowingQuote({
    tenantId, service: input.service, requestedCadence: input.cadence, rules,
    pricingVersion: pricingRow as ExplicitPricingVersion | null,
    measurement: {
      verifiedByServer: true, sqft: verified.measurement.sqft,
      confidence: verified.measurement.confidence, source: verified.measurement.source,
      measuredAt: verified.measurement.measuredAt, lat: verified.measurement.lat, lng: verified.measurement.lng,
    },
    // City parcel data does not attest a community name; neighbourhood rules
    // therefore fail closed until a matching server source is added.
    route: { neighborhood: null, baseDistanceKm, nearbyJobs: density.within2km },
    nowMs, leadId: input.leadId, customerId: input.customerId,
  })
  if (decision.state === 'review_required') return decision

  const { data, error } = await input.admin.rpc('issue_auto_mowing_quote', {
    p_token: input.bookingToken, p_customer_id: input.customerId, p_lead_id: input.leadId,
    p_rules_version_id: decision.rulesVersionId, p_decision: decision,
    p_measurement: {
      sqft: decision.measuredSqft, polygon_hash: verified.measurement.polygonHash,
      polygon: input.claimedPolygon,
      confidence: verified.measurement.confidence, source: verified.measurement.source,
      measured_at: verified.measurement.measuredAt, lat: verified.measurement.lat, lng: verified.measurement.lng,
      verified_by: 'hmac_city_measurement_attestation', customer_confirmation: 'looks_right',
    },
    p_route: {
      neighborhood: null, base_distance_km: baseDistanceKm, nearby_jobs: density.within2km,
      density_tier: density.tier, evidence: 'unique_future_scheduled_or_in_progress_mowing_properties',
    },
  })
  const result = data && typeof data === 'object' && !Array.isArray(data) ? data as Record<string, unknown> : null
  if (error || result?.state !== 'quoted') return review('quote_write_failed', 'Review the lead because the written quote could not be created atomically.')
  return {
    state: 'quoted', quote_number: String(result.quote_number || ''), price: decision.total,
    cadence: decision.cadence,
    price_label: decision.cadence === 'one_time' ? 'one-time visit' : `${decision.cadence} per visit`,
    portal_path: '/portal-access',
    portal_delivery: input.emailProvided ? 'email_if_provided' : 'manual_contact_required',
  }
}
