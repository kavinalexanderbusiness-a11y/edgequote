import type { SupabaseClient } from '@supabase/supabase-js'

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
  /** City/province/postal ride along so a NEW customer created at conversion
   *  keeps the location fields the intake door already captured — dropping them
   *  made a lead-born property poorer than the lead it came from. */
  city?: string | null
  province?: string | null
  postalCode?: string | null
  /** The customer's own words about money/timing/how to reach them. Not price
   *  inputs — shown to the owner in the builder so the three facts that shape
   *  the CALL don't die at the handoff. */
  budget?: string | null
  preferredSchedule?: string | null
  preferredContact?: string | null
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

// ── Closing a lead ───────────────────────────────────────────────────────────
// THE one place an open website lead is closed. It was a pair of inline writes
// in the Quote Builder, reachable only through the sessionStorage prefill door —
// so quoting the same person from the customer profile, the quotes list, the
// command palette, or any of the ~14 other Quote Builder entry points left the
// lead status='new' FOREVER: the inbox chip, the Website-leads filter, the
// dashboard "Respond to a new lead" priority and the LeadCard all kept demanding
// a response the owner had already given. A phantom badge that never clears
// trains the owner to ignore the one count that must be trusted.
//
// Closing is keyed on the CUSTOMER (every open lead for them), not the handoff:
// the quote IS the response, whichever door it came through. When the precise
// lead is known (the prefill path), its row also gets the quote_id link.
//
// 'dismissed' is the same close for a lead the owner won't quote (wrong area,
// spam, changed their mind) — without it, Build-quote was the ONLY exit, and a
// junk lead nagged forever. Deliberately NOT a pipeline: two terminal states,
// one open state, nothing else.
export type LeadCloseStatus = 'quoted' | 'dismissed'

export interface CloseLeadsResult {
  ok: boolean
  /** Present when !ok — plain language, for a toast. */
  error?: string
}

/**
 * Close every open website lead for these customers, and clear their
 * conversations' open-lead chip. Every write is CHECKED — a quote toast must
 * never imply the lead badge cleared when the write failed.
 */
export async function closeOpenLeads(sb: SupabaseClient, p: {
  userId: string
  customerIds: (string | null | undefined)[]
  status: LeadCloseStatus
  /** The precise lead (prefill path) — also gets quote_id stamped. */
  leadId?: string | null
  quoteId?: string | null
}): Promise<CloseLeadsResult> {
  const ids = [...new Set(p.customerIds.filter((c): c is string => !!c))]
  const errs: string[] = []

  // The precise row first: it carries the quote link, and it may belong to a
  // customer OUTSIDE `ids` (the owner retargeted the quote to someone else —
  // the lead that prompted it is still answered).
  if (p.leadId) {
    const { error } = await sb.from('website_leads')
      .update({ status: p.status, ...(p.quoteId ? { quote_id: p.quoteId } : {}) })
      .eq('id', p.leadId).eq('user_id', p.userId)
    if (error) errs.push(error.message)
  }

  if (ids.length) {
    // Sweep: any OTHER still-open lead from these customers. `.eq('status','new')`
    // keeps this from touching history — a quoted/dismissed lead is settled.
    const { error: lErr } = await sb.from('website_leads')
      .update({ status: p.status, ...(p.quoteId ? { quote_id: p.quoteId } : {}) })
      .eq('user_id', p.userId).in('customer_id', ids).eq('status', 'new')
    if (lErr) errs.push(lErr.message)

    const { error: cErr } = await sb.from('conversations')
      .update({ lead_status: null })
      .eq('user_id', p.userId).in('customer_id', ids).eq('lead_status', 'new')
    if (cErr) errs.push(cErr.message)
  }

  return errs.length ? { ok: false, error: errs[0] } : { ok: true }
}

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
    city: lead.city,
    province: lead.province,
    postalCode: lead.postal_code,
    budget: lead.budget,
    preferredSchedule: lead.preferred_schedule,
    preferredContact: lead.preferred_contact,
    sqft: Number(lead.lawn_sqft) || 0,
    sections: lead.sections || null,
    // Only what the lead actually asked for. When they stated nothing, leave it EMPTY
    // rather than naming a trade for them: /dashboard/quotes/new already falls back to
    // the owner's first service template (their primary offering, in their own order).
    // A hardcoded 'Lawn Mowing' here was always truthy, so that catalog fallback could
    // never run — and a roofer's lead became a mowing quote.
    serviceType: lead.requested_services || '',
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