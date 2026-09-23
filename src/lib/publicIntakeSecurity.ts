import { createHmac } from 'crypto'
import type { NextRequest } from 'next/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { EMAIL_MARKETING_CONSENT_VERSION } from '@/lib/publicBookingContract'

const SITE_RE = /^[a-z0-9][a-z0-9-]{2,63}$/
const DEFAULT_ORIGINS = [
  'https://edgepropertyservicesyyc.ca',
  'https://www.edgepropertyservicesyyc.ca',
]
const EDGE_PROPERTY_SERVICES_SITE_ID = 'edge-property-services-yyc'
const EDGE_PROPERTY_SERVICES_OWNER_ID = 'a12a0549-7210-4b6c-829e-3ed9feb380b3'

export interface WebsiteLeadSite {
  id: string
  token: string
  origins: string[]
}

function cleanOrigins(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  const out: string[] = []
  for (const item of value) {
    if (typeof item !== 'string') continue
    try {
      const url = new URL(item)
      if (url.protocol !== 'https:' && url.hostname !== 'localhost') continue
      out.push(url.origin)
    } catch { /* ignore malformed configuration */ }
  }
  return [...new Set(out)]
}

/** Resolve a public site id to a server-only booking token and exact origins. */
export function websiteLeadSite(siteId: string): WebsiteLeadSite | null {
  const id = siteId.trim().toLowerCase()
  if (!SITE_RE.test(id)) return null

  const raw = process.env.WEBSITE_LEAD_SITES_JSON
  if (raw) {
    try {
      const all = JSON.parse(raw) as Record<string, { token?: unknown; origins?: unknown }>
      const found = all[id]
      const token = typeof found?.token === 'string' ? found.token.trim() : ''
      const origins = cleanOrigins(found?.origins)
      if (token && origins.length) return { id, token, origins }
    } catch { /* fail closed below */ }
  }

  // Single-site configuration keeps Edge simple while the JSON map supports other
  // tenants. The token remains a server environment value and never ships in HTML.
  if (id === EDGE_PROPERTY_SERVICES_SITE_ID) {
    const token = (process.env.EDGE_WEBSITE_LEAD_TOKEN || '').trim()
    if (token) return { id, token, origins: DEFAULT_ORIGINS }
  }
  return null
}

/**
 * Resolve the configured site without requiring the booking token in public
 * website code. The environment mapping remains the first choice. The EPS
 * fallback reads the already-existing token with the service-role client and a
 * fixed tenant id, so a deployment can recover safely if the dedicated Vercel
 * variable is absent. This lookup never returns the token to the browser.
 */
export async function resolveWebsiteLeadSite(siteId: string): Promise<WebsiteLeadSite | null> {
  const configured = websiteLeadSite(siteId)
  if (configured) return configured

  const id = siteId.trim().toLowerCase()
  if (id !== EDGE_PROPERTY_SERVICES_SITE_ID) return null
  const admin = createAdminClient()
  if (!admin) return null
  const { data, error } = await admin.from('business_settings')
    .select('booking_token, booking_enabled')
    .eq('user_id', EDGE_PROPERTY_SERVICES_OWNER_ID)
    .maybeSingle()
  const token = typeof data?.booking_token === 'string' ? data.booking_token.trim() : ''
  if (error || !data?.booking_enabled || !token) return null
  return { id, token, origins: DEFAULT_ORIGINS }
}

export function requestOrigin(req: NextRequest): string | null {
  const raw = req.headers.get('origin')
  if (!raw) return null
  try { return new URL(raw).origin } catch { return null }
}

export function originAllowed(origin: string | null, site: WebsiteLeadSite): boolean {
  // No Origin is permitted for trusted server-to-server callers. Browser callers
  // always send Origin for this cross-origin JSON request.
  return origin === null || site.origins.includes(origin)
}

export function corsHeaders(origin: string | null, site: WebsiteLeadSite | null): Record<string, string> {
  const headers: Record<string, string> = {
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Max-Age': '600',
    'Vary': 'Origin',
    'Cache-Control': 'no-store',
  }
  if (site && origin && site.origins.includes(origin)) headers['Access-Control-Allow-Origin'] = origin
  return headers
}

function clientIp(req: NextRequest): string {
  const vercel = req.headers.get('x-vercel-forwarded-for')
  const forwarded = req.headers.get('x-forwarded-for')
  return (vercel || forwarded || 'unknown').split(',')[0].trim().slice(0, 128)
}

/** Consume a durable, server-only per-IP limit before the business-wide RPC limit. */
export async function consumePublicIntakeLimit(
  req: NextRequest,
  site: WebsiteLeadSite,
  scope = 'website-lead',
  limit = 8,
): Promise<'allowed' | 'limited' | 'unavailable'> {
  return consumeTokenIntakeLimit(req, site.token, scope, limit)
}

export async function consumeTokenIntakeLimit(
  req: NextRequest,
  token: string,
  scope: string,
  limit: number,
): Promise<'allowed' | 'limited' | 'unavailable'> {
  const dedicatedSalt = (process.env.WEBSITE_LEAD_IP_SALT || '').trim()
  const serviceRoleKey = (process.env.SUPABASE_SERVICE_ROLE_KEY || '').trim()
  const admin = createAdminClient()
  if ((!dedicatedSalt && !serviceRoleKey) || !admin) return 'unavailable'
  const salt = dedicatedSalt || createHmac('sha256', serviceRoleKey)
    .update('edgehq-public-intake-ip-salt-v1')
    .digest('hex')
  const ipHash = createHmac('sha256', salt).update(clientIp(req)).digest('hex')
  const { data, error } = await admin.rpc('consume_public_intake_rate_limit', {
    p_token: token,
    p_ip_hash: ipHash,
    p_scope: scope,
    p_limit: limit,
    p_window_seconds: 3600,
  })
  if (error || typeof data !== 'boolean') return 'unavailable'
  return data ? 'allowed' : 'limited'
}

const TEXT_LIMITS: Record<string, number> = {
  first_name: 80, last_name: 80, phone: 40, email: 254, address: 300,
  budget_range: 80, description: 2_000, notes: 2_000, place_id: 200,
  lawn_area_sqft: 30, driveway_area_sqft: 30, lawn_polygon: 30_000,
  map_link: 1_000, travel_distance_km: 30, travel_fee: 30,
  marketing_consent: 8, estimate_shown: 1_000, photos_meta: 300,
  address_source: 30, address_place_id: 200, address_city: 100,
  address_province: 80, address_country: 80, address_quadrant: 8,
  address_latitude: 30, address_longitude: 30, address_checked_at: 40,
  route_review_status: 30,
  estimated_quote: 30, mowing_frequency: 30, booking_intent: 30,
  measurement_attestation: 8_000, measurement_confirmation: 30,
  consent_version: 60, consent_utc: 40,
}
const ALLOWED = new Set([...Object.keys(TEXT_LIMITS), 'services_needed', 'photos'])
const NUMERIC_TEXT_RANGES: Record<string, readonly [number, number]> = {
  lawn_area_sqft: [0, 10_000_000],
  driveway_area_sqft: [0, 10_000_000],
  travel_distance_km: [0, 5_000],
  travel_fee: [0, 1_000_000],
  estimated_quote: [0, 1_000_000],
}
const COORDINATE_RANGES: Record<string, readonly [number, number]> = {
  address_latitude: [-90, 90],
  address_longitude: [-180, 180],
}

export function validateWebsiteLeadPayload(input: Record<string, unknown>):
  { ok: true; payload: Record<string, unknown> } | { ok: false; error: string } {
  const out: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(input)) {
    if (!ALLOWED.has(key)) return { ok: false, error: 'unexpected field' }
    if (key === 'photos') {
      if (!Array.isArray(value) || value.length > 6) return { ok: false, error: 'invalid photos' }
      out[key] = value
      continue
    }
    if (key === 'services_needed') {
      const values = Array.isArray(value) ? value : [value]
      if (values.length > 12 || values.some(v => typeof v !== 'string' || v.length > 100)) {
        return { ok: false, error: 'invalid services' }
      }
      // submit_website_lead reads this with ->>, so persist plain service text
      // rather than a JSON-formatted array string in the lead and quote builder.
      out[key] = values.map(v => String(v).trim()).filter(Boolean).join(', ')
      continue
    }
    if (key === 'lawn_polygon') {
      if (typeof value !== 'string' || value.length > TEXT_LIMITS.lawn_polygon) {
        return { ok: false, error: 'invalid field' }
      }
      // The public form always renders this hidden field. Skipping measurement
      // submits an empty string, which means "no polygon", not an invalid shape.
      if (!value.trim()) continue
      try {
        const polygon = JSON.parse(value) as unknown
        const valid = Array.isArray(polygon) && polygon.length <= 12 && polygon.every(section => {
          if (!section || typeof section !== 'object' || Array.isArray(section)) return false
          const item = section as { section?: unknown; ring?: unknown }
          return typeof item.section === 'string' && item.section.length <= 40
            && Array.isArray(item.ring) && item.ring.length >= 3 && item.ring.length <= 100
            && item.ring.every(point => {
              if (!point || typeof point !== 'object' || Array.isArray(point)) return false
              const p = point as { lat?: unknown; lng?: unknown }
              return typeof p.lat === 'number' && Number.isFinite(p.lat) && p.lat >= -90 && p.lat <= 90
                && typeof p.lng === 'number' && Number.isFinite(p.lng) && p.lng >= -180 && p.lng <= 180
            })
        })
        if (!valid) {
          return { ok: false, error: 'invalid field' }
        }
        // Store a JSON object rather than a JSON-encoded string so downstream
        // measurement and quote-builder code receives the canonical shape.
        out[key] = polygon
      } catch {
        return { ok: false, error: 'invalid field' }
      }
      continue
    }
    if (key in NUMERIC_TEXT_RANGES || key in COORDINATE_RANGES) {
      if (typeof value !== 'string' || value.length > (TEXT_LIMITS[key] || 0)) {
        return { ok: false, error: 'invalid field' }
      }
      const clean = value.trim()
      if (!clean) continue
      const signed = key in COORDINATE_RANGES
      const pattern = signed ? /^-?(?:\d+(?:\.\d*)?|\.\d+)$/ : /^(?:\d+(?:\.\d*)?|\.\d+)$/
      if (!pattern.test(clean)) {
        return { ok: false, error: 'invalid field' }
      }
      const numeric = Number(clean)
      const [min, max] = COORDINATE_RANGES[key] || NUMERIC_TEXT_RANGES[key]
      if (!Number.isFinite(numeric) || numeric < min || numeric > max) {
        return { ok: false, error: 'invalid field' }
      }
      out[key] = clean
      continue
    }
    if (typeof value !== 'string' || value.length > (TEXT_LIMITS[key] || 0)) {
      return { ok: false, error: 'invalid field' }
    }
    out[key] = value.trim()
  }
  if (!String(out.first_name || '').trim() || !String(out.address || '').trim()) {
    return { ok: false, error: 'name and address are required' }
  }
  if (!String(out.phone || '').trim() && !String(out.email || '').trim()) {
    return { ok: false, error: 'phone or email is required' }
  }
  if (out.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(out.email))) {
    return { ok: false, error: 'invalid email' }
  }
  if (out.booking_intent && out.booking_intent !== 'ready_to_book') {
    return { ok: false, error: 'invalid booking intent' }
  }
  if (out.address_source && !['manual', 'google_places', 'city_of_calgary'].includes(String(out.address_source))) {
    return { ok: false, error: 'invalid address source' }
  }
  if (out.address_quadrant && !['NW', 'NE', 'SW', 'SE'].includes(String(out.address_quadrant))) {
    return { ok: false, error: 'invalid address quadrant' }
  }
  if (out.route_review_status && !['required', 'review_required', 'eligible', 'outside_route'].includes(String(out.route_review_status))) {
    return { ok: false, error: 'invalid route review status' }
  }
  if (out.address_checked_at && !Number.isFinite(Date.parse(String(out.address_checked_at)))) {
    return { ok: false, error: 'invalid address checked time' }
  }
  if (out.mowing_frequency && !['weekly', 'biweekly', 'once'].includes(String(out.mowing_frequency))) {
    return { ok: false, error: 'invalid mowing frequency' }
  }
  if (out.measurement_confirmation && !['automatic_applied', 'looks_right', 'corrected', 'rejected'].includes(String(out.measurement_confirmation))) {
    return { ok: false, error: 'invalid measurement confirmation' }
  }
  if (out.marketing_consent && !['yes', 'no'].includes(String(out.marketing_consent))) {
    return { ok: false, error: 'invalid marketing consent' }
  }
  if (out.marketing_consent === 'yes') {
    if (!String(out.email || '').trim()) return { ok: false, error: 'email is required for email marketing consent' }
    const version = String(out.consent_version || '').trim()
    const consentedAt = String(out.consent_utc || '').trim()
    const stamp = Date.parse(consentedAt)
    if (version !== EMAIL_MARKETING_CONSENT_VERSION || !Number.isFinite(stamp)) {
      return { ok: false, error: 'invalid marketing consent evidence' }
    }
    const now = Date.now()
    if (stamp < now - 24 * 60 * 60 * 1000 || stamp > now + 10 * 60 * 1000) {
      return { ok: false, error: 'expired marketing consent evidence' }
    }
  }
  return { ok: true, payload: out }
}
