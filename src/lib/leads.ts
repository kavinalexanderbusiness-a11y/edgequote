// ── Website lead → Quote Builder mapping ─────────────────────────────────────
// A website quote-form submission is stored (raw + structured) in public.website_leads
// and folded into the Messages inbox as a conversation. When the owner clicks
// "Build Quote", we hand the structured fields to the Quote Builder through the same
// sessionStorage channel the in-app measurement uses (key 'eq_lead_prefill'). This
// module is the single source of truth for that mapping.

export type LeadCadence = 'one_time' | 'weekly' | 'biweekly' | 'monthly'

// The website_leads row shape the UI reads (structured projection of the submission).
export interface WebsiteLead {
  id: string
  created_at: string
  customer_id: string | null
  conversation_id: string | null
  quote_id: string | null
  status: string
  raw_submission: Record<string, unknown> | null
  submitted_at: string | null
  contact_first: string | null
  contact_last: string | null
  contact_name: string | null
  phone: string | null
  email: string | null
  preferred_contact: string | null
  address: string | null
  city: string | null
  province: string | null
  postal_code: string | null
  place_id: string | null
  maps_url: string | null
  lat: number | null
  lng: number | null
  lawn_sqft: number | null
  lawn_polygon: unknown
  sections: Record<string, number> | null
  travel_distance_km: number | null
  travel_fee: number | null
  requested_services: string | null
  frequency: string | null
  yard_condition: string | null
  website_estimated_price: number | null
  budget: string | null
  preferred_schedule: string | null
  notes: string | null
}

// The handoff payload consumed by /dashboard/quotes/new (sessionStorage 'eq_lead_prefill').
export interface LeadPrefillPayload {
  leadId: string
  customerId: string | null
  customerName: string
  customerPhone: string
  customerEmail: string
  address: string
  sqft: number
  sections?: Record<string, number> | null
  serviceType: string
  initialPrice: number
  weekly?: number | null
  biweekly?: number | null
  monthly?: number | null
  cadence?: LeadCadence | null
  travelFee?: number
  travelDistanceKm?: number | null
  placeId?: string | null
  mapsUrl?: string | null
  lat?: number | null
  lng?: number | null
  lawnPolygon?: unknown
  overgrowth?: number
  notes?: string
}

export const LEAD_PREFILL_KEY = 'eq_lead_prefill'

function cadenceOf(freq: string | null | undefined): LeadCadence | null {
  const f = (freq || '').toLowerCase()
  if (f.includes('week') && f.includes('bi')) return 'biweekly'
  if (f === 'biweekly' || f.includes('bi-week') || f.includes('every other')) return 'biweekly'
  if (f.includes('month')) return 'monthly'
  if (f.includes('week')) return 'weekly'
  if (f.includes('one') || f.includes('once') || f.includes('single')) return 'one_time'
  return null
}

// Map a free-text/condition label to the engine's overgrowth multiplier (1 = normal).
function overgrowthOf(cond: string | null | undefined): number {
  const c = (cond || '').toLowerCase().trim()
  if (!c) return 1
  const n = Number(c)
  if (Number.isFinite(n) && n >= 1 && n <= 3) return n           // already a multiplier
  if (c.includes('overgrow') || c.includes('very') || c.includes('severe')) return 1.3
  if (c.includes('long') || c.includes('tall') || c.includes('thick')) return 1.2
  return 1
}

// Build the Quote Builder prefill from a website lead. Prices are RAW (the builder
// applies fee-recovery at insert) — never pre-marked-up here.
export function leadToPrefill(lead: WebsiteLead): LeadPrefillPayload {
  const est = Number(lead.website_estimated_price) || 0
  const cadence = cadenceOf(lead.frequency)
  return {
    leadId: lead.id,
    customerId: lead.customer_id,
    customerName: lead.contact_name || [lead.contact_first, lead.contact_last].filter(Boolean).join(' ') || '',
    customerPhone: lead.phone || '',
    customerEmail: lead.email || '',
    address: lead.address || '',
    sqft: Number(lead.lawn_sqft) || 0,
    sections: lead.sections || null,
    serviceType: lead.requested_services || 'Lawn Mowing',
    initialPrice: est,
    weekly: cadence === 'weekly' ? est : null,
    biweekly: cadence === 'biweekly' ? est : null,
    monthly: cadence === 'monthly' ? est : null,
    cadence,
    travelFee: Number(lead.travel_fee) || 0,
    travelDistanceKm: lead.travel_distance_km ?? null,
    placeId: lead.place_id,
    mapsUrl: lead.maps_url,
    lat: lead.lat,
    lng: lead.lng,
    lawnPolygon: lead.lawn_polygon ?? null,
    overgrowth: overgrowthOf(lead.yard_condition),
    notes: lead.notes || '',
  }
}