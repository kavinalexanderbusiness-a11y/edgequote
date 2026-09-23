import { NextRequest, NextResponse } from 'next/server'
import { submitLead } from '@/lib/intake'
import {
  consumePublicIntakeLimit, corsHeaders, originAllowed, requestOrigin,
  resolveWebsiteLeadSite, validateWebsiteLeadPayload,
} from '@/lib/publicIntakeSecurity'
import {
  affirmativeEmailMarketingConsent, isolateClientEstimateClaim, publicWebsiteLeadResponse,
} from '@/lib/publicBookingContract'
import { createAdminClient } from '@/lib/supabase/admin'
import { logSafeServerError, logSecurityEvent } from '@/lib/serverError'
import { attemptAutomaticMowingQuote } from '@/lib/autoMowingQuoteServer'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

export async function OPTIONS(req: NextRequest) {
  const site = await resolveWebsiteLeadSite(new URL(req.url).searchParams.get('site') || '')
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
  const site = await resolveWebsiteLeadSite(siteId)
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

  const bookingIntent = checked.payload.booking_intent === 'ready_to_book'
  const existingNotes = String(checked.payload.notes || '').trim()
  const { payload: claimSafePayload, claim } = isolateClientEstimateClaim(checked.payload)
  const claimNote = claim
    ? `CUSTOMER-SUPPLIED WEBSITE MEASUREMENT — canonical pricing may use it only after server-attestation verification.${claim.lawn_area_sqft ? ` Claimed lawn area: ${claim.lawn_area_sqft} sq ft.` : ''}${claim.estimated_quote ? ` Estimate displayed: $${claim.estimated_quote}.` : ''}`
    : ''
  const noteParts = [
    bookingIntent ? 'READY TO BOOK — written quote acceptance, route approval, deposit and live schedule check still required.' : '',
    claimNote,
    existingNotes,
  ].filter(Boolean)
  const payload = {
    ...claimSafePayload,
    ...(bookingIntent ? {
      booking_intent: 'ready_to_book',
    } : {}),
    ...(noteParts.length ? { notes: noteParts.join('\n\n') } : {}),
    consent_source: 'edgepropertyservicesyyc.ca quote form',
    submitted_utc: new Date().toISOString(),
  }
  const r = await submitLead({ token: site.token, source: 'Website', payload })
  if (r.status < 200 || r.status >= 300) {
    logSafeServerError('website_lead.submit_failed', null, { site: site.id, status: r.status })
  }
  // Opt-in is a second, append-only action after the lead/customer is durable.
  // Only an affirmative box with bounded evidence can turn email marketing on;
  // "no" and omission deliberately do nothing, preserving any earlier consent.
  const consent = affirmativeEmailMarketingConsent(
    checked.payload,
    'edgepropertyservicesyyc.ca free quote form',
  )
  const customerId = typeof r.body.customer_id === 'string' ? r.body.customer_id : ''
  const leadId = typeof r.body.lead_id === 'string' ? r.body.lead_id : ''
  const admin = r.ok && customerId ? createAdminClient() : null
  let quoteState: Record<string, unknown> | null = null
  if (admin && leadId) {
    let automatic: Awaited<ReturnType<typeof attemptAutomaticMowingQuote>>
    try {
      automatic = await attemptAutomaticMowingQuote({
        admin,
        bookingToken: site.token,
        customerId,
        leadId,
        address: String(checked.payload.address || ''),
        service: String(checked.payload.services_needed || ''),
        cadence: String(checked.payload.mowing_frequency || ''),
        emailProvided: Boolean(String(checked.payload.email || '').trim()),
        measurementAttestation: checked.payload.measurement_attestation,
        measurementConfirmation: checked.payload.measurement_confirmation,
        claimedSqft: checked.payload.lawn_area_sqft,
        claimedPolygon: checked.payload.lawn_polygon,
      })
    } catch (error) {
      logSafeServerError('website_lead.auto_quote_unavailable', error, { site: site.id })
      automatic = {
        state: 'review_required',
        missing: [{ code: 'automatic_quote_unavailable', decision: 'Review the lead because automatic quote verification was unavailable.' }],
      }
    }
    if (automatic.state === 'quoted') quoteState = automatic
    else {
      const { data, error } = await admin.rpc('ensure_public_lead_quote', {
        p_token: site.token,
        p_customer_id: customerId,
        p_lead_id: leadId,
      })
      if (error || !data) logSafeServerError('website_lead.review_quote_not_created', error, { site: site.id })
      const reviewQuote = data && typeof data === 'object' && !Array.isArray(data)
        ? data as Record<string, unknown> : null
      const reviewQuoteId = typeof reviewQuote?.quote_id === 'string' ? reviewQuote.quote_id : ''
      if (reviewQuoteId) {
        const { data: recorded, error: recordError } = await admin.rpc('record_auto_mowing_review_reasons', {
          p_token: site.token,
          p_lead_id: leadId,
          p_quote_id: reviewQuoteId,
          p_missing: automatic.missing,
        })
        if (recordError || recorded !== true) {
          logSafeServerError('website_lead.review_reasons_not_recorded', recordError, { site: site.id })
        }
      }
      // Public callers learn only that owner review is required. Cost, margin,
      // pricing-version and route-policy gaps stay in the tenant-scoped quote.
      quoteState = { state: 'review_required' }
    }
  }
  if (admin && consent && customerId) {
    const { error } = await admin.rpc('record_public_email_marketing_consent', {
      p_token: site.token,
      p_customer_id: customerId,
      p_consent: true,
      p_version: consent.version,
      p_consented_at: consent.consentedAt,
      p_source: consent.source,
    })
    if (error) logSafeServerError('website_lead.marketing_consent_not_recorded', error, { site: site.id })
  }
  return NextResponse.json(publicWebsiteLeadResponse(r, quoteState), { status: r.status, headers })
}
