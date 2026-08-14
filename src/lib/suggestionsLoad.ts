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
//
// Returns NULL when a load-bearing read fails. supabase-js RESOLVES {data:null,
// error}, so coercing every read with `|| []` let a dead connection look like a
// spotless business: the feed said "Nothing needs your attention" under a green
// check. The two PARTIAL failures are worse than the total one —
//   • invoices fail → invoicedJobIds empties → every completed job reads as
//     UNBILLED, so the advisor tells the owner to invoice already-invoiced work.
//   • quote_outcomes fail → priceLossRate falls to 0, DISABLING the "losing
//     mostly on price → never tell them to raise" suppression, so the advisor
//     recommends a price rise to a business that is losing quotes on price.
// Enrichment reads stay deliberately tolerant — see the split below.
export async function loadSuggestions(supabase: SupabaseClient): Promise<Suggestion[] | null> {
  // Local session read — no auth round-trip before the parallel advisor fetch below.
  const { data: { session } } = await supabase.auth.getSession()
  const user = session?.user
  if (!user) return null
  const uid = user.id

  // One parallel round-trip for the whole advisor. Line items are fetched by
  // user_id directly (not by the jobs' ids) so they no longer serialize AFTER the
  // jobs query — every read fires at once. Dismissals load here too.
  //
  // COLUMN LISTS, NOT select('*'): these are full-history reads of the account's
  // widest tables (quotes alone is ~45 columns incl. lead_meta intake payloads
  // the advisor never opens), so every unused column crossed the wire on each
  // Grow visit. Each list below is the traced union of what buildSuggestions and
  // every engine it hands rows to actually reads — including the indirect
  // consumers: visitValue (the five quote price fields), winLoss WLQuote
  // (property_id), followup quoteIsQuiet (sent_at, last_followed_up_at),
  // preferences resolvePrefs (the embed pref fields), duration.ts
  // (actual/duration_minutes), signals/* (recurrence freq/interval fields),
  // sqftFor (properties.measurement_history — jsonb, wide, genuinely read).
  // Rows are blind-cast to app types, so a MISSED column fails silently as
  // undefined (the context-starvation bug class) — if you add a field read in
  // suggestions.ts or its engines, add the column here in the same commit.
  const JOB_COLS = 'id, customer_id, property_id, quote_id, recurrence_id, title, service_type, status, scheduled_date, start_time, duration_minutes, actual_minutes, price, is_initial_visit, crew_size'
  const QUOTE_COLS = 'id, status, total, initial_price, weekly_price, biweekly_price, monthly_price, property_id, sent_at, last_followed_up_at'
  const PROPERTY_COLS = 'id, customer_id, lat, lng, neighborhood, city, postal_code, lawn_sqft, measurement_history'
  const CUSTOMER_COLS = 'id, name, created_at, referred_by_customer_id'
  const RECURRENCE_COLS = 'id, freq, interval_unit, interval_count'
  const LINE_ITEM_COLS = 'id, job_id, amount, service_key, description, created_at'
  const today = localTodayISO()
  const [jRes, qRes, rRes, pRes, cRes, iRes, nRes, sRes, liRes, dRes, woRes, tplRes, travelM] = await Promise.all([
    supabase.from('jobs')
      .select(`${JOB_COLS}, customers(id, name, phone, preferred_days, avoid_days, pref_time_start, pref_time_end), properties(id, address, lat, lng, neighborhood, preferred_days, avoid_days, pref_time_start, pref_time_end)`)
      .eq('user_id', uid),
    supabase.from('quotes').select(QUOTE_COLS).eq('user_id', uid),
    supabase.from('job_recurrences').select(RECURRENCE_COLS).eq('user_id', uid),
    supabase.from('properties').select(PROPERTY_COLS).eq('user_id', uid),
    supabase.from('customers').select(CUSTOMER_COLS).eq('user_id', uid),
    supabase.from('invoices').select('job_id, status, amount, property_id, customer_id').eq('user_id', uid),
    supabase.from('neighbor_leads').select('status, neighborhood').eq('user_id', uid),
    supabase.from('business_settings')
      .select('crew_cost_per_hour, target_rev_per_hour, pricing_base_charge, pricing_mow_rate, pricing_recommended_mult, pricing_premium_mult, pricing_travel_rate, preferred_work_days, daily_capacity_hours, work_start_time, base_lat, base_lng, service_seasons')
      .eq('user_id', uid).maybeSingle(),
    supabase.from('job_line_items').select(LINE_ITEM_COLS).eq('user_id', uid).order('created_at', { ascending: true }),
    supabase.from('suggestion_dismissals').select('suggestion_key, snooze_until').eq('user_id', uid),
    supabase.from('quote_outcomes').select('quote_id, reason, detail, competitor_price').eq('user_id', uid),
    supabase.from('service_templates').select('name, recurrence').eq('user_id', uid),
    loadTravelModel(supabase),
  ])

  // ── The honesty gate ──
  // These eight decide WHAT the advisor claims: the work, the money, the people
  // and the settings every figure is computed against. If any one of them failed
  // we do not know the answer, and "we don't know" must not render as "nothing to
  // do". Same all-or-nothing rule the dashboard loader uses.
  const failed =
    jRes.error || qRes.error || rRes.error || pRes.error ||
    cRes.error || iRes.error || liRes.error || woRes.error || sRes.error ||
    // Templates carry recurrence ELIGIBILITY (Session 46). A failed read would
    // resurrect "make this recurring" for a service the owner marked one-time —
    // the exact suggestion the configuration exists to forbid. Load-bearing.
    tplRes.error
  if (failed) return null
  // DELIBERATELY TOLERANT — these degrade honestly rather than lying:
  //   nRes (neighbour leads)  → one growth idea goes missing; the feed UNDER-claims.
  //   dRes (dismissals)       → a dismissed card resurfaces; noise, not a false
  //                             all-clear, and re-dismissing costs one tap.
  //   travelM                 → falls back to its own documented default model.

  const jobs = (jRes.data as unknown as Job[]) || []
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
    serviceTemplates: (tplRes.data as { name: string; recurrence: string | null }[]) || [],
  }

  return buildSuggestions(ctx)
}
