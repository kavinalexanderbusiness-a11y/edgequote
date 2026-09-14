import { createHmac } from 'crypto'
import type { NextRequest } from 'next/server'
import { createAdminClient } from '@/lib/supabase/admin'

const SITE_RE = /^[a-z0-9][a-z0-9-]{2,63}$/
const DEFAULT_ORIGINS = [
  'https://edgepropertyservicesyyc.ca',
  'https://www.edgepropertyservicesyyc.ca',
]

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
  if (id === 'edge-property-services-yyc') {
    const token = (process.env.EDGE_WEBSITE_LEAD_TOKEN || '').trim()
    if (token) return { id, token, origins: DEFAULT_ORIGINS }
  }
  return null
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
  const salt = process.env.WEBSITE_LEAD_IP_SALT
  const admin = createAdminClient()
  if (!salt || !admin) return 'unavailable'
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
  consent_version: 60, consent_utc: 40,
}
const ALLOWED = new Set([...Object.keys(TEXT_LIMITS), 'services_needed', 'photos'])

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
      out[key] = values
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
  return { ok: true, payload: out }
}
