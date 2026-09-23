const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/

// This value identifies the exact promotional-email disclosure rendered by the
// Edge Property Services quote form. A caller cannot invent a version label and
// have it accepted as evidence for a disclosure the customer never saw.
export const EMAIL_MARKETING_CONSENT_VERSION = 'marketing-email-2026-09-22'

export interface ClientEstimateClaim {
  source: 'customer_website_estimator'
  trusted_for_pricing: false
  lawn_area_sqft?: string
  lawn_polygon?: unknown
  estimated_quote?: string
  estimate_shown?: string
  mowing_frequency?: string
}

/**
 * Split website-estimator output from the values allowed to enter canonical CRM
 * pricing/measurement fields. The claim stays in raw_submission for owner review;
 * submit_website_lead never sees its reserved canonical keys.
 */
export function isolateClientEstimateClaim(payload: Record<string, unknown>): {
  payload: Record<string, unknown>
  claim: ClientEstimateClaim | null
} {
  const clean = { ...payload }
  const claim: ClientEstimateClaim = {
    source: 'customer_website_estimator',
    trusted_for_pricing: false,
  }
  let found = false
  // A signed measurement is an input to the one server decision only. Do not
  // persist the short-lived envelope in customer-facing raw lead metadata.
  delete clean.measurement_attestation
  delete clean.measurement_confirmation
  for (const key of ['lawn_area_sqft', 'lawn_polygon', 'estimated_quote', 'estimate_shown', 'mowing_frequency'] as const) {
    const value = clean[key]
    delete clean[key]
    if (value !== undefined && value !== '') {
      ;(claim as unknown as Record<string, unknown>)[key] = value
      found = true
    }
  }
  if (found) clean.client_estimate_claim = claim
  return { payload: clean, claim: found ? claim : null }
}

export interface MarketingConsentEvidence {
  affirmative: true
  version: string
  consentedAt: string
  source: string
}

/** An unchecked/omitted box is absence of new consent, never a withdrawal. */
export function affirmativeEmailMarketingConsent(
  payload: Record<string, unknown>,
  source: string,
  nowMs = Date.now(),
): MarketingConsentEvidence | null {
  if (payload.marketing_consent !== 'yes' || !String(payload.email || '').trim()) return null
  const version = String(payload.consent_version || '').trim()
  const consentedAt = String(payload.consent_utc || '').trim()
  const timestamp = Date.parse(consentedAt)
  if (version !== EMAIL_MARKETING_CONSENT_VERSION || !Number.isFinite(timestamp)) return null
  if (timestamp < nowMs - 24 * 60 * 60 * 1000 || timestamp > nowMs + 10 * 60 * 1000) return null
  return { affirmative: true, version, consentedAt: new Date(timestamp).toISOString(), source }
}

type IntakeResultLike = { ok: boolean; body: Record<string, unknown> }

function publicPhotoReport(value: unknown): { received: number; stored: number; failed: number } | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const raw = value as Record<string, unknown>
  const received = Number(raw.received)
  const stored = Number(raw.stored)
  const failed = Number(raw.failed)
  if (![received, stored, failed].every(Number.isInteger)
    || received < 0 || stored < 0 || failed < 0
    || stored + failed > received || received > 6) return null
  return { received, stored, failed }
}

function publicQuoteState(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const raw = value as Record<string, unknown>
  if (raw.state === 'review_required') return { state: 'review_required' }
  if (raw.state !== 'quoted') return null

  const quoteNumber = typeof raw.quote_number === 'string' ? raw.quote_number.trim() : ''
  const price = Number(raw.price)
  const cadence = typeof raw.cadence === 'string' ? raw.cadence : ''
  const priceLabel = typeof raw.price_label === 'string' ? raw.price_label.trim() : ''
  const delivery = raw.portal_delivery
  if (!quoteNumber || quoteNumber.length > 80 || !Number.isFinite(price) || price < 0
    || !['weekly', 'biweekly', 'one_time'].includes(cadence)
    || !priceLabel || priceLabel.length > 100
    || raw.portal_path !== '/portal-access'
    || !['email_if_provided', 'manual_contact_required'].includes(String(delivery))) return null
  return {
    state: 'quoted', quote_number: quoteNumber, price, cadence, price_label: priceLabel,
    portal_path: '/portal-access', portal_delivery: delivery,
  }
}

/**
 * Reduce the internal intake result to the fields a public browser needs.
 * In particular, customer/lead UUIDs and the acquisition source stay server-side.
 */
export function publicWebsiteLeadResponse(result: IntakeResultLike, quote: unknown): Record<string, unknown> {
  if (!result.ok) {
    const message = typeof result.body.error === 'string' && result.body.error.length <= 240
      ? result.body.error
      : 'Could not submit your request. Please try again.'
    return { error: message }
  }

  const out: Record<string, unknown> = { ok: true }
  const photos = publicPhotoReport(result.body.photos)
  if (photos) {
    out.photos = photos
    if (photos.failed > 0) out.warning = `${photos.failed} photo(s) could not be stored`
  }
  const safeQuote = publicQuoteState(quote)
  if (safeQuote) out.quote = safeQuote
  return out
}

export function parsePortalScheduleQuery(input: {
  token?: unknown
  quoteId?: unknown
  date?: unknown
  days?: unknown
}):
  | { ok: true; token: string; quoteId: string; date?: string; days: number }
  | { ok: false; error: string } {
  const token = typeof input.token === 'string' ? input.token.trim() : ''
  const quoteId = typeof input.quoteId === 'string' ? input.quoteId.trim() : ''
  const date = typeof input.date === 'string' ? input.date.trim() : undefined
  const rawDays = typeof input.days === 'string' || typeof input.days === 'number'
    ? Number(input.days) : 30
  if (!token || token.length > 200) return { ok: false, error: 'invalid link' }
  if (!UUID_RE.test(quoteId)) return { ok: false, error: 'invalid quote' }
  if (date && (!DATE_RE.test(date) || Number.isNaN(Date.parse(`${date}T00:00:00Z`)))) {
    return { ok: false, error: 'invalid date' }
  }
  const days = Number.isInteger(rawDays) ? Math.max(1, Math.min(60, rawDays)) : 30
  return { ok: true, token, quoteId, ...(date ? { date } : {}), days }
}
