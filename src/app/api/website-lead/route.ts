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
import {
  attemptAutomaticServiceBundleEstimate,
  issueAutomaticServiceBundleQuote,
  loadAutomaticServiceCapacityRequirement,
  publicAutomaticServiceBundleEstimate,
  type AutomaticServiceBundleRequest,
} from '@/lib/automaticServicePricingServer'
import { collectAutomaticServiceRouteEvidence } from '@/lib/automaticServiceRouteEvidenceServer'
import { verifyPublicMeasurementAttestation } from '@/lib/publicMeasurementAttestation'
import type {
  AutomaticMeasurementEvidence,
  AutomaticServiceCadence,
  AutomaticServiceKey,
  CanonicalRouteEvidence,
} from '@/lib/automaticServicePricing'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

const AUTOMATIC_SERVICE_KEYS = new Set<AutomaticServiceKey>([
  'mowing', 'fertilization', 'overseeding', 'topsoil', 'weed_treatment', 'snow',
])

function serviceSelections(payload: Record<string, unknown>): AutomaticServiceBundleRequest[] {
  if (Array.isArray(payload.service_selections)) {
    return payload.service_selections.map(raw => {
      const item = raw as { key: string; label: string; cadence: AutomaticServiceCadence | null }
      return { serviceKey: item.key, label: item.label, cadence: item.cadence }
    })
  }
  const service = String(payload.services_needed || '')
  const cadence = String(payload.mowing_frequency || '')
  if (/mow|lawn cut|grass cut/i.test(service) && ['weekly', 'biweekly', 'once'].includes(cadence)) {
    return [{
      serviceKey: 'mowing', label: 'Lawn Mowing & Edging',
      cadence: cadence === 'once' ? 'one_time' : cadence as AutomaticServiceCadence,
    }]
  }
  return service ? [{ serviceKey: 'custom', label: service.slice(0, 100), cadence: null }] : []
}

function bundleReviewReasons(decision: Awaited<ReturnType<typeof attemptAutomaticServiceBundleEstimate>>) {
  const reasons: Array<{ code: string; decision: string }> = []
  if (decision.state === 'written_quote_handoff') {
    for (const line of decision.lines) {
      if (line.decision?.state === 'review_required') reasons.push(...line.decision.missing)
      else if (line.decision?.state === 'out_of_route') reasons.push({ code: line.decision.code, decision: line.decision.decision })
      else if (!line.decision) reasons.push({ code: 'written_quote_service', decision: `${line.label} needs a written owner-reviewed quote.` })
    }
    if (!reasons.length) reasons.push({ code: decision.reason, decision: 'Review the complete service bundle before confirming a written price.' })
  }
  return reasons.slice(0, 30)
}

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
    let reviewReasons: Array<{ code: string; decision: string }> = []
    // Old embedded forms remain on their separately-versioned mowing path.
    // The current multi-service form always sends the structured selection list.
    if (!Array.isArray(checked.payload.service_selections)) {
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
      else reviewReasons = automatic.missing
    } else {
      try {
        const selections = serviceSelections(checked.payload)
        const verified = verifyPublicMeasurementAttestation({
          token: checked.payload.measurement_attestation,
          confirmation: checked.payload.measurement_confirmation,
          submittedAddress: checked.payload.address,
          submittedSqft: checked.payload.lawn_area_sqft,
          submittedPolygon: checked.payload.lawn_polygon,
        })
        const measurementByService: Partial<Record<AutomaticServiceKey, AutomaticMeasurementEvidence | null>> = {}
        const routeByService: Partial<Record<AutomaticServiceKey, CanonicalRouteEvidence | null>> = {}
        const lawnServices = new Set<AutomaticServiceKey>([
          'mowing', 'fertilization', 'overseeding', 'topsoil', 'weed_treatment',
        ])
        const commonMeasurement: AutomaticMeasurementEvidence | null = verified.ok ? {
          verifiedByServer: true,
          sqft: verified.measurement.sqft,
          areaCount: Array.isArray(checked.payload.lawn_polygon)
            ? Math.max(1, checked.payload.lawn_polygon.length) : 1,
          confidence: verified.measurement.confidence,
          source: verified.measurement.source,
          measuredAt: verified.measurement.measuredAt,
        } : null
        for (const selected of selections) {
          const key = String(selected.serviceKey) as AutomaticServiceKey
          if (!AUTOMATIC_SERVICE_KEYS.has(key)) continue
          measurementByService[key] = lawnServices.has(key) ? commonMeasurement : null
          if (!verified.ok || !commonMeasurement) continue
          const requirement = await loadAutomaticServiceCapacityRequirement({
            admin, bookingToken: site.token, serviceKey: key, measuredSqft: commonMeasurement.sqft,
          })
          if (!requirement.ok) continue
          const route = await collectAutomaticServiceRouteEvidence({
            admin,
            bookingToken: site.token,
            serviceKey: key,
            placeId: String(checked.payload.address_place_id || checked.payload.place_id || ''),
            measurementCentre: { lat: verified.measurement.lat, lng: verified.measurement.lng },
            routeRuleVersion: requirement.routeRuleVersion,
            requiredDurationMinutes: requirement.durationMinutes,
          })
          if (route.ok) routeByService[key] = route.evidence
        }
        const decision = await attemptAutomaticServiceBundleEstimate({
          admin, bookingToken: site.token, services: selections,
          measurementByService, routeByService,
        })
        if (decision.state === 'priced' && verified.ok) {
          const write = await issueAutomaticServiceBundleQuote({
            admin,
            bookingToken: site.token,
            customerId,
            leadId,
            decision,
            measurement: {
              sqft: verified.measurement.sqft,
              polygon_hash: verified.measurement.polygonHash,
              polygon: checked.payload.lawn_polygon,
              confidence: verified.measurement.confidence,
              source: verified.measurement.source,
              measured_at: verified.measurement.measuredAt,
              lat: verified.measurement.lat,
              lng: verified.measurement.lng,
              verified_by: 'hmac_city_measurement_attestation',
              customer_confirmation: checked.payload.measurement_confirmation,
            },
            routeByService,
          })
          if (write.state === 'quoted') {
            quoteState = {
              ...publicAutomaticServiceBundleEstimate(decision),
              quote_number: write.quote_number,
              portal_path: '/portal-access',
              portal_delivery: String(checked.payload.email || '').trim()
                ? 'email_if_provided' : 'manual_contact_required',
            }
          } else reviewReasons = [{ code: write.code, decision: write.decision }]
        } else {
          reviewReasons = bundleReviewReasons(decision)
          if (!verified.ok) reviewReasons.unshift({ code: verified.code, decision: verified.decision })
          quoteState = publicAutomaticServiceBundleEstimate(decision)
        }
      } catch (error) {
        logSafeServerError('website_lead.automatic_service_bundle_unavailable', error, { site: site.id })
        reviewReasons = [{ code: 'automatic_bundle_unavailable', decision: 'Review the lead because automatic bundle pricing was unavailable.' }]
      }
    }
    if (!quoteState || quoteState.state === 'review_required' || quoteState.state === 'written_quote_handoff') {
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
          p_missing: reviewReasons.length ? reviewReasons : [{
            code: 'written_quote_handoff', decision: 'Review the complete request before confirming a written price.',
          }],
        })
        if (recordError || recorded !== true) {
          logSafeServerError('website_lead.review_reasons_not_recorded', recordError, { site: site.id })
        }
      }
      // Public callers learn only that owner review is required. Cost, margin,
      // pricing-version and route-policy gaps stay in the tenant-scoped quote.
      if (!quoteState) quoteState = { state: 'review_required' }
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
