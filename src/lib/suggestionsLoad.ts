import type { SupabaseClient } from '@supabase/supabase-js'
import { Job, Quote, JobRecurrence, Property, Customer } from '@/types'
import { localTodayISO } from '@/lib/utils'
import { pricingConfigFromSettings } from '@/lib/pricing'
import { crewCostPerHour } from '@/lib/economics'
import { settingsToSeasons } from '@/lib/seasons'
import { listLineItemsByJob } from '@/lib/jobPricing'
import { buildSuggestions, SuggestionContext, Suggestion } from '@/lib/suggestions'

// Load EVERYTHING the advisor composes, in one parallel fetch, and return the
// ranked suggestions. Shared by the Grow page Suggestions Center and the
// dashboard top-3 widget so they never diverge.
export async function loadSuggestions(supabase: SupabaseClient): Promise<Suggestion[]> {
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return []
  const uid = user.id

  const [jRes, qRes, rRes, pRes, cRes, iRes, nRes, sRes] = await Promise.all([
    supabase.from('jobs')
      .select('*, customers(id, name, phone, preferred_days, avoid_days, pref_time_start, pref_time_end), properties(id, address, lat, lng, neighborhood, preferred_days, avoid_days, pref_time_start, pref_time_end)')
      .eq('user_id', uid),
    supabase.from('quotes').select('*').eq('user_id', uid),
    supabase.from('job_recurrences').select('*').eq('user_id', uid),
    supabase.from('properties').select('*').eq('user_id', uid),
    supabase.from('customers').select('*').eq('user_id', uid),
    supabase.from('invoices').select('job_id, status, amount, property_id, customer_id').eq('user_id', uid),
    supabase.from('neighbor_leads').select('status, neighborhood').eq('user_id', uid),
    supabase.from('business_settings')
      .select('crew_cost_per_hour, target_rev_per_hour, pricing_base_charge, pricing_mow_rate, pricing_recommended_mult, pricing_premium_mult, pricing_travel_rate, preferred_work_days, daily_capacity_hours, base_lat, base_lng, service_seasons')
      .eq('user_id', uid).maybeSingle(),
  ])

  const jobs = (jRes.data as Job[]) || []
  const settings = sRes.data as Record<string, unknown> | null

  const recurrences: Record<string, JobRecurrence> = {}
  for (const r of (rRes.data as JobRecurrence[]) || []) recurrences[r.id] = r

  const invoiceRows = (iRes.data as { job_id: string | null; status: string; amount: number | null; property_id: string | null; customer_id: string | null }[]) || []
  const invoicedJobIds = new Set(invoiceRows.map(i => i.job_id).filter(Boolean) as string[])

  const lineItemsByJob = await listLineItemsByJob(supabase, uid, jobs.map(j => j.id))

  const baseLat = settings?.base_lat as number | null | undefined
  const baseLng = settings?.base_lng as number | null | undefined

  const ctx: SuggestionContext = {
    today: localTodayISO(),
    crewCost: crewCostPerHour(settings?.crew_cost_per_hour as number | null | undefined),
    targetRevPerHour: Number(settings?.target_rev_per_hour) > 0 ? Number(settings!.target_rev_per_hour) : 60,
    pricingConfig: pricingConfigFromSettings(settings as Parameters<typeof pricingConfigFromSettings>[0]),
    seasons: settingsToSeasons(settings?.service_seasons),
    baseCoord: baseLat != null && baseLng != null ? { lat: baseLat, lng: baseLng } : null,
    preferredDays: (settings?.preferred_work_days as number[] | null)?.length ? (settings!.preferred_work_days as number[]) : [5, 6, 0],
    capacityHours: Number(settings?.daily_capacity_hours) > 0 ? Number(settings!.daily_capacity_hours) : 8,
    jobs,
    quotes: (qRes.data as Quote[]) || [],
    recurrences,
    properties: (pRes.data as Property[]) || [],
    customers: (cRes.data as Customer[]) || [],
    invoices: invoiceRows.map(i => ({ status: i.status, amount: i.amount, property_id: i.property_id, customer_id: i.customer_id })),
    lineItemsByJob,
    neighborLeads: (nRes.data as { status: string | null; neighborhood: string | null }[]) || [],
    invoicedJobIds,
  }

  return buildSuggestions(ctx)
}
