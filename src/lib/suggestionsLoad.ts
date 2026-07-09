import type { SupabaseClient } from '@supabase/supabase-js'
import { Job, Quote, JobRecurrence, Property, Customer, JobLineItem } from '@/types'
import { localTodayISO } from '@/lib/utils'
import { pricingConfigFromSettings } from '@/lib/pricing'
import { crewCostPerHour } from '@/lib/economics'
import { settingsToSeasons } from '@/lib/seasons'
import { buildSuggestions, SuggestionContext, Suggestion } from '@/lib/suggestions'
import { loadTravelModel } from '@/lib/travelLearning'

// Load EVERYTHING the advisor composes, in one parallel fetch, and return the
// ranked suggestions. Shared by the Grow page Suggestions Center and the
// dashboard top-3 widget so they never diverge.
export async function loadSuggestions(supabase: SupabaseClient): Promise<Suggestion[]> {
  // Local session read — no auth round-trip before the parallel advisor fetch below.
  const { data: { session } } = await supabase.auth.getSession()
  const user = session?.user
  if (!user) return []
  const uid = user.id

  // One parallel round-trip for the whole advisor. Line items are fetched by
  // user_id directly (not by the jobs' ids) so they no longer serialize AFTER the
  // jobs query — every read fires at once. Dismissals load here too.
  const today = localTodayISO()
  const [jRes, qRes, rRes, pRes, cRes, iRes, nRes, sRes, liRes, dRes, woRes, travelM] = await Promise.all([
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
      .select('crew_cost_per_hour, target_rev_per_hour, pricing_base_charge, pricing_mow_rate, pricing_recommended_mult, pricing_premium_mult, pricing_travel_rate, preferred_work_days, daily_capacity_hours, work_start_time, base_lat, base_lng, service_seasons')
      .eq('user_id', uid).maybeSingle(),
    supabase.from('job_line_items').select('*').eq('user_id', uid).order('created_at', { ascending: true }),
    supabase.from('suggestion_dismissals').select('suggestion_key, snooze_until').eq('user_id', uid),
    supabase.from('quote_outcomes').select('quote_id, reason, detail, competitor_price').eq('user_id', uid),
    loadTravelModel(supabase),
  ])

  const jobs = (jRes.data as Job[]) || []
  const settings = sRes.data as Record<string, unknown> | null

  const recurrences: Record<string, JobRecurrence> = {}
  for (const r of (rRes.data as JobRecurrence[]) || []) recurrences[r.id] = r

  const invoiceRows = (iRes.data as { job_id: string | null; status: string; amount: number | null; property_id: string | null; customer_id: string | null }[]) || []
  const invoicedJobIds = new Set(invoiceRows.map(i => i.job_id).filter(Boolean) as string[])

  // Group line items by job locally (was a separate serial query).
  const lineItemsByJob: Record<string, JobLineItem[]> = {}
  for (const it of (liRes.data as JobLineItem[]) || []) (lineItemsByJob[it.job_id] ||= []).push(it)

  // Resolve which dismissals are STILL active: snooze_until null = forever; a date
  // hides the card only until that day (>= today), then it can resurface.
  const dismissedKeys = new Set<string>()
  for (const d of (dRes.data as { suggestion_key: string; snooze_until: string | null }[]) || []) {
    if (d.snooze_until == null || d.snooze_until >= today) dismissedKeys.add(d.suggestion_key)
  }

  const baseLat = settings?.base_lat as number | null | undefined
  const baseLng = settings?.base_lng as number | null | undefined

  const ctx: SuggestionContext = {
    today,
    crewCost: crewCostPerHour(settings?.crew_cost_per_hour as number | null | undefined),
    targetRevPerHour: Number(settings?.target_rev_per_hour) > 0 ? Number(settings!.target_rev_per_hour) : 60,
    pricingConfig: pricingConfigFromSettings(settings as Parameters<typeof pricingConfigFromSettings>[0]),
    seasons: settingsToSeasons(settings?.service_seasons),
    baseCoord: baseLat != null && baseLng != null ? { lat: baseLat, lng: baseLng } : null,
    preferredDays: (settings?.preferred_work_days as number[] | null)?.length ? (settings!.preferred_work_days as number[]) : [5, 6, 0],
    capacityHours: Number(settings?.daily_capacity_hours) > 0 ? Number(settings!.daily_capacity_hours) : 8,
    workStart: (settings?.work_start_time as string | null) || '08:00',
    speed: travelM,
    jobs,
    quotes: (qRes.data as Quote[]) || [],
    recurrences,
    properties: (pRes.data as Property[]) || [],
    customers: (cRes.data as Customer[]) || [],
    invoices: invoiceRows.map(i => ({ status: i.status, amount: i.amount, property_id: i.property_id, customer_id: i.customer_id })),
    lineItemsByJob,
    neighborLeads: (nRes.data as { status: string | null; neighborhood: string | null }[]) || [],
    invoicedJobIds,
    dismissedKeys,
    quoteOutcomes: (woRes.data as { quote_id: string; reason: string; detail: string | null; competitor_price: number | null }[]) || [],
  }

  return buildSuggestions(ctx)
}
