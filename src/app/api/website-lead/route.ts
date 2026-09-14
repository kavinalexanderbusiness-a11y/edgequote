import { NextRequest, NextResponse } from 'next/server'
import { submitLead } from '@/lib/intake'
import {
  consumePublicIntakeLimit, corsHeaders, originAllowed, requestOrigin,
  validateWebsiteLeadPayload, websiteLeadSite,
} from '@/lib/publicIntakeSecurity'
import { logSafeServerError, logSecurityEvent } from '@/lib/serverError'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

export function OPTIONS(req: NextRequest) {
  const site = websiteLeadSite(new URL(req.url).searchParams.get('site') || '')
  const origin = requestOrigin(req)
  const headers = corsHeaders(origin, site)
  if (!site || !originAllowed(origin, site)) {
    logSecurityEvent('website_lead_origin_rejected', { site: site?.id ?? 'unknown', method: 'OPTIONS' })
    return new NextResponse(null, { status: 403, headers })
  }
  return new NextResponse(null, { status: 204, headers })
}

export async function POST(req: NextRequest) {
  const siteId = new URL(req.url).searchParams.get('site') || ''
  const site = websiteLeadSite(siteId)
  const origin = requestOrigin(req)
  const headers = corsHeaders(origin, site)
  if (!site || !originAllowed(origin, site)) {
    logSecurityEvent('website_lead_origin_rejected', { site: site?.id ?? 'unknown', method: 'POST' })
    return NextResponse.json({ error: 'forbidden' }, { status: 403, headers })
  }

  const length = Number(req.headers.get('content-length') || 0)
  if (length > 5 * 1024 * 1024) {
    logSecurityEvent('website_lead_request_rejected', { site: site.id, reason: 'content_length' })
    return NextResponse.json({ error: 'request too large' }, { status: 413, headers })
  }
  const text = await req.text().catch(() => '')
  if (!text || text.length > 5 * 1024 * 1024) {
    logSecurityEvent('website_lead_request_rejected', { site: site.id, reason: text ? 'body_length' : 'empty_body' })
    return NextResponse.json({ error: 'bad request' }, { status: 400, headers })
  }
  const body = (() => { try { return JSON.parse(text) as unknown } catch { return null } })()
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    logSecurityEvent('website_lead_request_rejected', { site: site.id, reason: 'invalid_json' })
    return NextResponse.json({ error: 'bad request' }, { status: 400, headers })
  }
  const raw = body as Record<string, unknown>

  // A filled honeypot is acknowledged without creating a customer or revealing
  // the spam rule. The field is never persisted.
  if (typeof raw._gotcha === 'string' && raw._gotcha.trim()) {
    logSecurityEvent('website_lead_honeypot', { site: site.id })
    return NextResponse.json({ ok: true }, { status: 200, headers })
  }
  delete raw._gotcha
  delete raw.site
  delete raw.token
  delete raw.booking_token
  delete raw.source

  const checked = validateWebsiteLeadPayload(raw)
  if (!checked.ok) {
    logSecurityEvent('website_lead_request_rejected', { site: site.id, reason: 'schema' })
    return NextResponse.json({ error: checked.error }, { status: 400, headers })
  }

  const rate = await consumePublicIntakeLimit(req, site)
  if (rate === 'limited') {
    logSecurityEvent('website_lead_rate_limited', { site: site.id })
    return NextResponse.json({ error: 'Too many requests. Please try again shortly.' }, { status: 429, headers })
  }
  if (rate === 'unavailable') {
    logSafeServerError('website_lead.rate_limit_unavailable', null, { site: site.id })
    return NextResponse.json({ error: 'Form temporarily unavailable. Please call or text us.' }, { status: 503, headers })
  }

  const payload = {
    ...checked.payload,
    consent_source: 'edgepropertyservicesyyc.ca quote form',
    submitted_utc: new Date().toISOString(),
  }
  const r = await submitLead({ token: site.token, source: 'Website', payload })
  if (r.status < 200 || r.status >= 300) {
    logSafeServerError('website_lead.submit_failed', null, { site: site.id, status: r.status })
  }
  return NextResponse.json(r.body, { status: r.status, headers })
}
