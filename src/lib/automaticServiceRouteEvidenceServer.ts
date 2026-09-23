import type { SupabaseClient } from '@supabase/supabase-js'
import { haversineKm } from '@/lib/geo'
import { densityFor, locatedStops } from '@/lib/routeDensity'
import { serverMapsKey } from '@/lib/mapsKey'
import { localTodayISO } from '@/lib/utils'
import type { AutomaticServiceKey, CanonicalRouteEvidence } from '@/lib/automaticServicePricing'

type Coord = { lat: number; lng: number }

export interface CanonicalPlace {
  placeId: string
  formattedAddress: string
  city: string | null
  province: string | null
  country: string | null
  quadrant: CanonicalRouteEvidence['quadrant']
  lat: number
  lng: number
}

export interface RouteEvidenceProvider {
  verifyPlace(placeId: string): Promise<CanonicalPlace | null>
  distances(origin: Coord, destinations: Coord[]): Promise<Array<number | null>>
}

export type RouteEvidenceResult =
  | { ok: true; evidence: CanonicalRouteEvidence }
  | { ok: false; code: string; decision: string }

const ROUTE_DAY_SERVICES = new Set<AutomaticServiceKey>(['mowing', 'snow'])

function component(
  components: Array<{ long_name?: string; short_name?: string; types?: string[] }>,
  types: string[],
  short = false,
): string | null {
  for (const type of types) {
    const hit = components.find(item => item.types?.includes(type))
    const value = short ? hit?.short_name : hit?.long_name
    if (value) return value
  }
  return null
}

function quadrantFromAddress(address: string): CanonicalRouteEvidence['quadrant'] {
  const match = address.toUpperCase().match(/(?:^|\s)(NW|NE|SW|SE)(?:\s|,|$)/)
  return match ? match[1] as CanonicalRouteEvidence['quadrant'] : null
}

export function googleRouteEvidenceProvider(fetcher: typeof fetch = fetch): RouteEvidenceProvider {
  const key = serverMapsKey()
  return {
    async verifyPlace(placeId) {
      if (!key || !placeId) return null
      const url = new URL('https://maps.googleapis.com/maps/api/geocode/json')
      url.searchParams.set('place_id', placeId)
      url.searchParams.set('key', key)
      const response = await fetcher(url.toString(), { cache: 'no-store' })
      if (!response.ok) return null
      const body = await response.json() as {
        status?: string
        results?: Array<{
          place_id?: string
          formatted_address?: string
          address_components?: Array<{ long_name?: string; short_name?: string; types?: string[] }>
          geometry?: { location?: { lat?: number; lng?: number } }
        }>
      }
      const result = body.status === 'OK' ? body.results?.[0] : null
      const lat = Number(result?.geometry?.location?.lat)
      const lng = Number(result?.geometry?.location?.lng)
      const components = result?.address_components || []
      if (!result || result.place_id !== placeId || !Number.isFinite(lat) || !Number.isFinite(lng)) return null
      const formattedAddress = String(result.formatted_address || '')
      return {
        placeId,
        formattedAddress,
        city: component(components, ['locality', 'postal_town']),
        province: component(components, ['administrative_area_level_1'], true),
        country: component(components, ['country'], true),
        quadrant: quadrantFromAddress(formattedAddress),
        lat,
        lng,
      }
    },
    async distances(origin, destinations) {
      if (!key || !destinations.length || destinations.length > 25) return destinations.map(() => null)
      const url = new URL('https://maps.googleapis.com/maps/api/distancematrix/json')
      url.searchParams.set('origins', `${origin.lat},${origin.lng}`)
      url.searchParams.set('destinations', destinations.map(item => `${item.lat},${item.lng}`).join('|'))
      url.searchParams.set('units', 'metric')
      url.searchParams.set('key', key)
      const response = await fetcher(url.toString(), { cache: 'no-store' })
      if (!response.ok) return destinations.map(() => null)
      const body = await response.json() as {
        status?: string
        rows?: Array<{ elements?: Array<{ status?: string; distance?: { value?: number } }> }>
      }
      if (body.status !== 'OK') return destinations.map(() => null)
      const elements = body.rows?.[0]?.elements || []
      return destinations.map((_, index) => {
        const element = elements[index]
        const metres = Number(element?.distance?.value)
        return element?.status === 'OK' && Number.isFinite(metres)
          ? Math.round(metres / 100) / 10
          : null
      })
    },
  }
}

function isoPlusDays(date: string, days: number): string {
  const parsed = new Date(`${date}T12:00:00Z`)
  parsed.setUTCDate(parsed.getUTCDate() + days)
  return parsed.toISOString().slice(0, 10)
}

function routeServiceMatch(service: AutomaticServiceKey, value: unknown): boolean {
  const text = String(value || '').toLowerCase()
  if (service === 'mowing') return /mow|lawn cut|grass cut/.test(text)
  if (service === 'snow') return /snow|ice/.test(text)
  if (service === 'fertilization') return /fertili/.test(text)
  if (service === 'overseeding') return /seed/.test(text)
  if (service === 'topsoil') return /topsoil/.test(text)
  return /weed/.test(text)
}

function fail(code: string, decision: string): RouteEvidenceResult {
  return { ok: false, code, decision }
}

/**
 * Produces fresh server-owned address, road-distance, density and capacity
 * evidence. The browser's route status, coordinates, distance and price fields
 * are deliberately ignored.
 */
export async function collectAutomaticServiceRouteEvidence(input: {
  admin: SupabaseClient
  bookingToken: string
  serviceKey: AutomaticServiceKey
  placeId: string
  measurementCentre: Coord
  routeRuleVersion: string
  requiredDurationMinutes: number | null
  nowMs?: number
  provider?: RouteEvidenceProvider
}): Promise<RouteEvidenceResult> {
  const nowMs = input.nowMs ?? Date.now()
  if (!input.placeId.trim()) return fail('canonical_place_id_missing', 'Select a verified Google address before automatic pricing.')
  if (!input.routeRuleVersion.trim()) return fail('route_rule_version_missing', 'Save an owner-approved route rule version.')
  if (ROUTE_DAY_SERVICES.has(input.serviceKey)
    && (!Number.isInteger(input.requiredDurationMinutes) || Number(input.requiredDurationMinutes) <= 0)) {
    return fail('capacity_requirement_missing', 'Save the service duration needed for route-capacity checks.')
  }

  const { data: settings, error: settingsError } = await input.admin.from('business_settings')
    .select('user_id,base_lat,base_lng,preferred_work_days,daily_capacity_hours')
    .eq('booking_token', input.bookingToken).eq('booking_enabled', true).maybeSingle()
  const base = { lat: Number(settings?.base_lat), lng: Number(settings?.base_lng) }
  if (settingsError || !settings?.user_id || !Number.isFinite(base.lat) || !Number.isFinite(base.lng)) {
    return fail('route_base_unavailable', 'Review the request because the saved business base could not be verified.')
  }
  const tenantId = String(settings.user_id)
  const provider = input.provider ?? googleRouteEvidenceProvider()
  const canonical = await provider.verifyPlace(input.placeId).catch(() => null)
  if (!canonical || canonical.country !== 'CA' || canonical.province !== 'AB' || canonical.city?.toLowerCase() !== 'calgary') {
    return fail('canonical_address_unavailable', 'Review the request because Google could not verify a complete Calgary address.')
  }
  if (haversineKm(canonical, input.measurementCentre) > 0.2) {
    return fail('address_measurement_mismatch', 'Review the request because the selected address and measured property do not match.')
  }

  const today = localTodayISO()
  const horizon = isoPlusDays(today, 28)
  const { data: jobs, error: jobsError, count } = await input.admin.from('jobs')
    .select('property_id,service_type,scheduled_date,duration_minutes,properties(lat,lng)', { count: 'exact' })
    .eq('user_id', tenantId).gte('scheduled_date', today).lte('scheduled_date', horizon)
    .in('status', ['scheduled', 'in_progress']).limit(5000)
  if (jobsError || count == null || count !== (jobs || []).length) {
    return fail('route_jobs_unavailable', 'Review the request because the current EdgeHQ route could not be verified.')
  }
  const typedJobs = (jobs || []) as unknown as Array<{
    property_id: string | null
    service_type: string | null
    scheduled_date: string
    duration_minutes: number | null
    properties: { lat: number | null; lng: number | null } | null
  }>
  const routeJobs = typedJobs.filter(job => routeServiceMatch(input.serviceKey, job.service_type))
  const stops = locatedStops(routeJobs.map(job => ({
    lat: typeof job.properties?.lat === 'number' ? job.properties.lat : null,
    lng: typeof job.properties?.lng === 'number' ? job.properties.lng : null,
  }))).slice(0, 23)
  const target = { lat: canonical.lat, lng: canonical.lng }
  const baseRoad = (await provider.distances(base, [target, ...stops]).catch(() => []))
  const targetRoad = (await provider.distances(target, [base, ...stops]).catch(() => []))
  const baseDistanceKm = baseRoad[0]
  const returnDistanceKm = targetRoad[0]
  if (baseDistanceKm == null || returnDistanceKm == null) {
    return fail('road_distance_unavailable', 'Review the request because Google road distance could not be verified.')
  }
  let routeTravelKm = baseDistanceKm + returnDistanceKm
  for (let index = 0; index < stops.length; index += 1) {
    const baseToStop = baseRoad[index + 1]
    const targetToStop = targetRoad[index + 1]
    if (baseToStop == null || targetToStop == null) continue
    routeTravelKm = Math.min(routeTravelKm, Math.max(0, baseDistanceKm + targetToStop - baseToStop))
  }
  routeTravelKm = Math.round(routeTravelKm * 10) / 10
  const density = densityFor(target, stops)

  let eligibleRouteDays: number | null = null
  if (ROUTE_DAY_SERVICES.has(input.serviceKey)) {
    const preferredDays = Array.isArray(settings.preferred_work_days)
      ? settings.preferred_work_days.map(Number).filter(day => Number.isInteger(day) && day >= 0 && day <= 6)
      : []
    const capacityHours = Number(settings.daily_capacity_hours)
    if (!preferredDays.length || !Number.isFinite(capacityHours) || capacityHours <= 0) {
      return fail('capacity_settings_unavailable', 'Save preferred route days and daily capacity before automatic route pricing.')
    }
    const { data: dayStatuses, error: statusError } = await input.admin.from('day_statuses')
      .select('date,blocks,starts_at,ends_at,crew_size').eq('user_id', tenantId)
      .gte('date', today).lte('date', horizon)
    if (statusError) return fail('day_status_unavailable', 'Review the request because blocked days could not be verified.')
    const dayMap = new Map((dayStatuses || []).map(row => [String(row.date), row]))
    const used = new Map<string, number>()
    for (const job of typedJobs) {
      used.set(job.scheduled_date, (used.get(job.scheduled_date) || 0) + Math.max(0, Number(job.duration_minutes) || 0))
    }
    eligibleRouteDays = 0
    for (let offset = 1; offset <= 21; offset += 1) {
      const date = isoPlusDays(today, offset)
      const weekday = new Date(`${date}T12:00:00Z`).getUTCDay()
      const status = dayMap.get(date) as { blocks?: boolean; starts_at?: string | null; ends_at?: string | null } | undefined
      if (!preferredDays.includes(weekday) || status?.blocks === true) continue
      const availableMinutes = Math.round(capacityHours * 60) - (used.get(date) || 0)
      if (availableMinutes >= Number(input.requiredDurationMinutes)) eligibleRouteDays += 1
    }
  }

  return {
    ok: true,
    evidence: {
      verifiedByServer: true,
      provider: 'google_places',
      placeId: canonical.placeId,
      checkedAt: new Date(nowMs).toISOString(),
      city: canonical.city,
      province: canonical.province,
      country: canonical.country,
      quadrant: canonical.quadrant,
      lat: canonical.lat,
      lng: canonical.lng,
      baseDistanceKm: Math.round(baseDistanceKm * 10) / 10,
      routeTravelKm,
      nearbyJobs: density.within2km,
      eligibleRouteDays,
      routeRuleVersion: input.routeRuleVersion,
    },
  }
}
