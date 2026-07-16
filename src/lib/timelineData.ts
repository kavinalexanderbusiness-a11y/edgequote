import type { SupabaseClient } from '@supabase/supabase-js'
import { listPhotos } from '@/lib/photos'
import type { Quote, Job, Invoice } from '@/types'
import type {
  TimelineSources, TlMessage, TlPayment, TlServiceRequest, TlMeasurement,
  TlConsentChange, TlPriceChange,
} from '@/lib/timeline'

// ── Loading the rows the timeline engine eats ────────────────────────────────
// lib/timeline.ts is pure and I/O-free; this is the ONE place that knows which
// tables those rows come from. Split in two because the sources are keyed
// differently, not for tidiness:
//   - customer-scoped: askable by customer_id in one parallel batch
//   - job-scoped: expenses link by job_id ONLY, and job_price_changes by job_id —
//     neither can be asked for by customer, so they need the job ids first.
// Callers that already hold quotes/jobs/invoices (the customer page does, for its
// other cards) pass them straight to buildTimeline rather than refetching here.

// PostgREST returns an embedded many-to-one as an object, but supabase-js types it
// as an array — accept either shape rather than betting on one.
type Embed<T> = T | T[] | null
export function one<T>(e: Embed<T>): T | null { return Array.isArray(e) ? (e[0] ?? null) : (e ?? null) }

interface CampaignLogRow { id: string; created_at: string; channel: string | null; status: string | null; detail: string | null; crm_campaigns: Embed<{ name: string | null; kind: string | null }> }
interface ExpenseRow { id: string; description: string | null; amount: number | null; spent_at: string | null; created_at: string; job_id: string | null; expense_categories: Embed<{ name: string | null }> }

/** The sources that can be asked for by customer_id. */
export type CustomerTimelineSources = Pick<TimelineSources,
  'messages' | 'payments' | 'serviceRequests' | 'photos' | 'measurements' | 'consentChanges' | 'campaignLog'>

/** The sources that only exist per job. */
export type JobTimelineSources = Pick<TimelineSources, 'expenses' | 'priceChanges'>

// Every read is capped and every failure degrades to an empty list: a timeline that
// silently drops one source is better than a customer page that won't render.
export async function loadCustomerTimelineSources(
  supabase: SupabaseClient, userId: string, customerId: string,
): Promise<CustomerTimelineSources> {
  const [mRes, payRes, srRes, phRes, meaRes, conRes, camRes] = await Promise.all([
    supabase.from('messages').select('direction, channel, body, created_at').eq('customer_id', customerId).order('created_at', { ascending: false }).limit(50),
    supabase.from('payments').select('amount, status, kind, method, notes, created_at').eq('customer_id', customerId),
    supabase.from('service_requests').select('message, created_at').eq('customer_id', customerId),
    // Photos go through the photos engine so storage_path → URL stays in ONE place.
    listPhotos(supabase, userId, { customerId, limit: 200 }),
    supabase.from('measurements').select('id, created_at, property_id, accepted_sqft, auto_sqft, source, adjusted').eq('customer_id', customerId),
    supabase.from('consent_changes').select('id, created_at, channel, old_value, new_value, source').eq('customer_id', customerId).order('created_at', { ascending: false }).limit(100),
    supabase.from('crm_campaign_log').select('id, created_at, channel, status, detail, crm_campaigns(name, kind)').eq('customer_id', customerId).order('created_at', { ascending: false }).limit(100),
  ])

  return {
    messages: (mRes.data as TlMessage[]) || [],
    payments: (payRes.data as TlPayment[]) || [],
    serviceRequests: (srRes.data as TlServiceRequest[]) || [],
    photos: phRes || [],
    measurements: (meaRes.data as TlMeasurement[]) || [],
    consentChanges: (conRes.data as TlConsentChange[]) || [],
    campaignLog: ((camRes.data as unknown as CampaignLogRow[]) || []).map(r => ({
      id: r.id, created_at: r.created_at, channel: r.channel, status: r.status, detail: r.detail,
      campaign_name: one(r.crm_campaigns)?.name ?? null, campaign_kind: one(r.crm_campaigns)?.kind ?? null,
    })),
  }
}

// A property timeline asks the tables directly by property_id — it does NOT load the
// customer's history and filter it down. That difference is load-bearing: filtering a
// capped customer-wide pull (photos cap at 200) would silently drop this address's
// own photos once a customer has more than the cap across all their properties, and
// would spend five round-trips on messages/payments/consent/campaigns that are
// customer-level by definition and can never survive the narrowing.
//
// Only sources that can name a property are here. Expenses and price changes carry
// just a job_id, so they come via this property's jobs — buildTimeline's job→property
// hop then puts them at the address.
export async function loadPropertyTimelineSources(
  supabase: SupabaseClient, userId: string, propertyId: string,
): Promise<TimelineSources> {
  const [qRes, jRes, iRes, meaRes, photos] = await Promise.all([
    supabase.from('quotes').select('*').eq('property_id', propertyId),
    supabase.from('jobs').select('*').eq('property_id', propertyId),
    supabase.from('invoices').select('*').eq('property_id', propertyId),
    supabase.from('measurements').select('id, created_at, property_id, accepted_sqft, auto_sqft, source, adjusted').eq('property_id', propertyId),
    // Scoped to this address, so the cap is an honest cap on THIS property's photos.
    listPhotos(supabase, userId, { propertyId, limit: 200 }),
  ])
  const jobs = (jRes.data as Job[]) || []
  const jobSources = await loadJobTimelineSources(supabase, jobs.map(j => j.id))
  return {
    quotes: (qRes.data as Quote[]) || [],
    jobs,
    invoices: (iRes.data as Invoice[]) || [],
    measurements: (meaRes.data as TlMeasurement[]) || [],
    photos,
    ...jobSources,
  }
}

export async function loadJobTimelineSources(
  supabase: SupabaseClient, jobIds: string[],
): Promise<JobTimelineSources> {
  if (jobIds.length === 0) return { expenses: [], priceChanges: [] }
  const [expRes, pcRes] = await Promise.all([
    supabase.from('expenses').select('id, description, amount, spent_at, created_at, job_id, expense_categories(name)')
      .in('job_id', jobIds).is('archived_at', null),
    supabase.from('job_price_changes').select('id, old_amount, new_amount, reason, scope, created_at, job_id').in('job_id', jobIds),
  ])
  return {
    expenses: ((expRes.data as unknown as ExpenseRow[]) || []).map(r => ({
      id: r.id, description: r.description, amount: r.amount, spent_at: r.spent_at,
      created_at: r.created_at, job_id: r.job_id, category: one(r.expense_categories)?.name ?? null,
    })),
    priceChanges: (pcRes.data as TlPriceChange[]) || [],
  }
}
