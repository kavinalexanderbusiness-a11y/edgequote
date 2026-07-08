// Shared portal data shape + defensive normalizer. Imported by BOTH the server page
// (which fetches get_portal_data server-side for an instant first paint) and PortalClient
// (which revalidates after a payment / card-save). Plain module — no 'use client' — so a
// Server Component can import it without pulling in the client bundle.

export interface PortalQuote { id: string; quote_number: string; service_type: string; address: string; total: number; initial_price: number | null; subtotal: number | null; weekly_price: number | null; biweekly_price: number | null; monthly_price: number | null; notes: string | null; status: string; created_at: string; issued_date: string | null; crew_size: number | null; hours: number | null; travel_fee: number | null }
export interface PortalInvoice { id: string; invoice_number: string; service_type: string | null; amount: number; status: string; issued_date: string | null; due_date: string | null; notes: string | null; address: string | null; line_items: { description: string; amount: number; kind: string }[] | null; job_id: string | null; created_at: string }
export interface PortalJob { id: string; recurrence_id: string | null; service_type: string | null; title: string; scheduled_date: string; status: string; on_my_way_at: string | null; started_at: string | null; completed_at: string | null; notes: string | null }
export interface PortalRec { id: string; freq: string | null; interval_unit: string | null; interval_count: number | null; end_date: string | null }
export interface PortalPhoto { id: string; job_id: string | null; storage_path: string; kind: string; caption: string | null; taken_at: string }
export interface PortalPayment { id: string; amount: number; status: string; paid_at: string | null; provider: string; invoice_id: string | null; created_at: string }
export interface PortalCard { brand: string | null; last4: string | null; exp_month: number | null; exp_year: number | null }
export interface PortalData {
  customer: { id: string; name: string; email: string | null; phone: string | null; address: string | null; city: string | null; sms_opt_in?: boolean | null; email_opt_in?: boolean | null; reviewed_at?: string | null; autopay_enabled?: boolean | null }
  business: { company_name: string | null; owner_name: string | null; phone: string | null; email_primary: string | null; email_secondary: string | null; website: string | null; logo_url: string | null; logo_scale: number | null; base_address: string | null; terms_text: string | null; review_url?: string | null; gst_percent?: number | null } | null
  property: { address: string | null; city: string | null; province: string | null; lawn_sqft: number | null; fence_length: number | null; neighborhood: string | null; notes: string | null } | null
  quotes: PortalQuote[]; invoices: PortalInvoice[]; jobs: PortalJob[]; recurrences: PortalRec[]; photos: PortalPhoto[]; payments: PortalPayment[]
  payment_method?: PortalCard | null
}

// Defensive normalize: an OLDER get_portal_data — or a customer with no rows in a section
// — can return null/undefined for a collection (Postgres json_agg is null, not []). Coerce
// EVERY array so the portal can never white-screen on a missing field, no matter how
// current the database's RPC is.
export function normalizePortalData(raw: unknown): PortalData | null {
  const r = (raw ?? null) as Partial<PortalData> | null
  if (!r) return null
  return {
    customer: r.customer ?? { id: '', name: 'Customer', email: null, phone: null, address: null, city: null },
    business: r.business ?? null,
    property: r.property ?? null,
    quotes: Array.isArray(r.quotes) ? r.quotes : [],
    invoices: Array.isArray(r.invoices) ? r.invoices : [],
    jobs: Array.isArray(r.jobs) ? r.jobs : [],
    recurrences: Array.isArray(r.recurrences) ? r.recurrences : [],
    photos: Array.isArray(r.photos) ? r.photos : [],
    payments: Array.isArray(r.payments) ? r.payments : [],
    payment_method: r.payment_method ?? null,
  }
}
