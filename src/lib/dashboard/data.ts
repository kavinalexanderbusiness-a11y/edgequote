// ── THE dashboard loader ─────────────────────────────────────────────────────
// One fetch for the whole morning command center. Before this, the dashboard was
// four independent components each loading its own copy of the same tables —
// quotes ×5, jobs ×4, business_settings ×4, job_recurrences ×3, ~26 queries for
// one screen, and three separate skeletons popping in on their own timelines.
//
// Now every shared table is read ONCE, server-side, and handed to the existing
// pure engines (ledger, reactivation, priorities, day plan, weather impact). The
// page paints complete on first byte: no spinners, no waterfall, no figure that
// can disagree with another because two components fetched at different moments.
//
// This file fetches and delegates. It contains no business math of its own.

import type { SupabaseClient } from '@supabase/supabase-js'
import type { Invoice, Quote } from '@/types'
import { invoiceBalance, displayInvoiceStatus, collectedBetween, dayBoundsIso } from '@/lib/payments/ledger'
import type { ReachCustomer } from '@/lib/comms/reach'
import { computeLeadsNeedingResponse, type LeadConvRow, type LeadQuoteRow } from '@/lib/leadResponse'
import { loadWeatherImpact, type WeatherImpactReport } from '@/lib/weatherImpact'
import { settingsToSeasons } from '@/lib/seasons'
import { localTodayISO } from '@/lib/utils'
import { computePriorities, type Priority } from '@/lib/dashboard/priorities'
import { computeDayPlan, type DayPlan, type PlanJob } from '@/lib/dashboard/dayPlan'
import { pageAll } from '@/lib/supabase/pageAll'
import type { RJob, RRecurrence } from '@/lib/reactivation'
import type { MoneyBandValues } from '@/components/dashboard/MoneyBand'

type InvoiceRow = Pick<Invoice, 'amount' | 'status' | 'amount_paid' | 'discount_type' | 'discount_value' | 'due_date'>
// One conversations read serves two consumers: the lead union (all non-archived)
// and the messages priority row (the unread subset).
type ConvRow = LeadConvRow & { unread: number }

// The union every downstream consumer actually reads — money/KPIs (status, total,
// amount fields), priorities (status/total), needsFollowUp (sent_at,
// last_followed_up_at), reactivation (cadence prices, created_at) and dayPlan's
// jobVisitValue. `select('*')` shipped all 45 columns for these 14.
const QUOTE_COLUMNS =
  'id, customer_id, customer_name, status, total, service_type, created_at, sent_at, last_followed_up_at, initial_price, weekly_price, biweekly_price, monthly_price, lead_meta'

export interface DashboardData {
  money: MoneyBandValues
  priorities: Priority[]
  dayPlan: DayPlan
  // conversionRate is null with NO decided quotes — "0%" would be a claim we
  // haven't earned the data to make.
  kpis: { collected: number; jobsThisMonth: number; conversionRate: number | null }
  weather: WeatherImpactReport | null
  greeting: string
  dateLine: string
}

type SettingsRow = {
  gst_percent: number | null
  service_seasons: unknown
  preferred_work_days: number[] | null
  work_start_time: string | null
  daily_capacity_hours: number | null
  // Read for the weather engine, which is handed this row instead of re-reading
  // it. Declared here so the type can't silently drift from the select and leave
  // rain risk quietly computed against the default Calgary location.
  base_lat: number | null
  base_lng: number | null
  base_address: string | null
}

export async function loadDashboard(sb: SupabaseClient, userId: string): Promise<DashboardData> {
  const today = localTodayISO()

  // Rolling 7 days INCLUDING today, not a calendar week: on a Monday a calendar
  // week would read $0 and look broken.
  const weekStart = new Date(`${today}T00:00:00`)
  weekStart.setDate(weekStart.getDate() - 6)
  const weekStartISO = `${weekStart.getFullYear()}-${String(weekStart.getMonth() + 1).padStart(2, '0')}-${String(weekStart.getDate()).padStart(2, '0')}`
  const dayB = dayBoundsIso(today)
  const weekB = dayBoundsIso(weekStartISO)

  // ── Phase 1: read every table ONCE, all in parallel ──
  const [
    invRes, jobRes, planJobRes, quoteRes, recRes, convRes, custRes, setRes,
    todayCash, weekCash,
  ] = await Promise.all([
    // The three full-history reads are PAGED. An unbounded select silently stops
    // at 1000 rows, which would understate Owed/Collected and — via
    // priorities' scheduledQuoteIds — tell the owner to schedule work that is
    // already booked. At ~200 jobs/wk `jobs` crosses the cap within weeks.
    pageAll<InvoiceRow>(() => sb.from('invoices').select('id, amount, status, amount_paid, discount_type, discount_value, due_date').eq('user_id', userId)),
    // Every job, lean columns — feeds priorities (missed/unscheduled) + reactivation.
    pageAll<RJob>(() => sb.from('jobs').select('id, quote_id, customer_id, status, scheduled_date, recurrence_id, price, service_type').eq('user_id', userId)),
    // The day plan needs joins + times, but only for the days it shows, so it is a
    // separate NARROW read rather than widening the full-history query above.
    // Widened with the columns the weather engine needs (crew_size, property_id,
    // is_initial_visit, lawn_sqft) so this ONE read serves the day plan AND the
    // rain-risk model. Weather's own window (today→+8d, non-cancelled/completed)
    // is a strict subset of this one, and it ignores dates outside its forecast.
    sb.from('jobs')
      .select('id, scheduled_date, start_time, status, service_type, duration_minutes, price, quote_id, recurrence_id, crew_size, property_id, customer_id, is_initial_visit, customers(name, phone), properties(address, lawn_sqft)')
      .eq('user_id', userId)
      .gte('scheduled_date', today)
      .lte('scheduled_date', isoPlusDays(today, 21))
      .in('status', ['scheduled', 'in_progress'])
      .order('start_time', { nullsFirst: true }),
    // Explicit columns, not '*': quotes has 45 of them and every one crossed the
    // wire and got serialized into the RSC payload. This is the union actually
    // consumed by money/KPIs, priorities, needsFollowUp, reactivation and dayPlan.
    pageAll<Quote>(() => sb.from('quotes').select(QUOTE_COLUMNS).eq('user_id', userId)),
    sb.from('job_recurrences').select('id, freq, interval_unit, interval_count').eq('user_id', userId),
    // ALL non-archived conversations (not just unread): the lead union needs the
    // full set, and the messages row filters unread>0 from it in memory. One read
    // instead of two overlapping ones.
    sb.from('conversations')
      .select('id, customer_id, unread, lead_status, last_direction, last_message_at, created_at, customers(name)')
      .eq('user_id', userId).is('archived_at', null),
    // Exactly the fields lib/comms/reach needs to answer "would a message to this
    // person actually go out" — so the follow-up row can tell the owner which
    // chases are real. Rides along in the batch that was already going out; the
    // reactivation engine only reads `id` and ignores the rest.
    sb.from('customers').select('id, phone, email, sms_opt_in, email_opt_in, message_prefs').eq('user_id', userId).is('archived_at', null),
    // Widened with base_* so the weather engine doesn't re-read this same row.
    sb.from('business_settings').select('gst_percent, service_seasons, preferred_work_days, work_start_time, daily_capacity_hours, base_lat, base_lng, base_address').eq('user_id', userId).maybeSingle(),
    collectedBetween(sb, { userId, startIso: dayB.start, endIso: dayB.end }),
    collectedBetween(sb, { userId, startIso: weekB.start, endIso: dayB.end }),
  ])

  // Never render a number we didn't actually read. Supabase RESOLVES on failure
  // (it returns {data: null, error}), so without this a transient outage paints
  // the most reassuring screen in the app — $0 owed, "All settled", "You're all
  // caught up" — while the truth is simply unknown. Throwing hands it to
  // dashboard/error.tsx, which tells the owner the morning didn't load.
  const failure =
    invRes.error ? `invoices: ${invRes.error}`
    : jobRes.error ? `jobs: ${jobRes.error}`
    : quoteRes.error ? `quotes: ${quoteRes.error}`
    : planJobRes.error ? `today's jobs: ${planJobRes.error.message}`
    : recRes.error ? `recurrences: ${recRes.error.message}`
    : convRes.error ? `conversations: ${convRes.error.message}`
    : custRes.error ? `customers: ${custRes.error.message}`
    : setRes.error ? `settings: ${setRes.error.message}`
    : todayCash.error ? `today's payments: ${todayCash.error}`
    : weekCash.error ? `this week's payments: ${weekCash.error}`
    : null
  if (failure) throw new Error(`Dashboard could not load — ${failure}`)

  const settings = (setRes.data as SettingsRow | null)
  const invoices = invRes.rows
  const quotes = quoteRes.rows
  const jobs = jobRes.rows
  const recurrences = (recRes.data as RRecurrence[]) || []
  const recById: Record<string, RRecurrence> = {}
  for (const r of recurrences) recById[r.id] = r
  const conversations = (convRes.data as unknown as ConvRow[]) || []

  // ── Phase 2: derive, feeding the engines rows we already hold ──
  // Both of these used to re-read tables Phase 1 just read. Leads is now pure,
  // and weather takes the same PAGED quotes — so a truncated read can no longer
  // misprice its revenue-at-risk figure.
  const leads = computeLeadsNeedingResponse({
    conversations,
    quotes: quotes as unknown as LeadQuoteRow[],
  })
  // Weather is the one slow dependency (an external forecast). A failure must
  // degrade to `null` rather than take the morning down — but null means
  // "we couldn't check", NOT "no rain risk", and the strip says exactly that.
  const weather = await loadWeatherImpact(sb, {
    settings: settings ?? null,
    jobs: (planJobRes.data as unknown[]) || [],
    quotes: quotes as unknown as { id: string }[],
    recurrences,
  }).catch(() => null)

  // ── Money (THE ledger engine) ──
  const issued = invoices.filter(i => i.status !== 'draft' && i.status !== 'cancelled')
  const owing = issued.filter(i => invoiceBalance(i, settings).balance > 0.01)
  const outstanding = owing.reduce((s, i) => s + Math.max(0, invoiceBalance(i, settings).balance), 0)
  // Same display overlay the Invoices page renders, so the count matches its filter.
  const overdueInv = owing.filter(i => displayInvoiceStatus(i, settings, today) === 'overdue')
  const overdue = overdueInv.reduce((s, i) => s + Math.max(0, invoiceBalance(i, settings).balance), 0)

  // ── Priorities (THE queue engine) ──
  const priorities = computePriorities({
    quotes, invoices, jobs, recById,
    customers: (custRes.data as (ReachCustomer & { id: string })[]) || [],
    // Only the unread ones are a "reply to messages" job. customer_id must
    // survive — the messages row uses it to exclude people leads already counted.
    conversations: conversations.filter(c => Number(c.unread || 0) > 0),
    leads,
    seasons: settingsToSeasons(settings?.service_seasons),
    feeSettings: settings,
    today,
  })

  // ── Day plan (THE day-plan engine) ──
  const quotesById: Record<string, Record<string, unknown>> = {}
  for (const q of quotes) quotesById[q.id] = q as unknown as Record<string, unknown>
  const dayPlan = computeDayPlan({
    jobs: normalizePlanJobs(planJobRes.data),
    quotesById, recById,
    preferredWorkDays: settings?.preferred_work_days ?? null,
    workStart: settings?.work_start_time || '08:00',
    capacityHours: settings?.daily_capacity_hours && settings.daily_capacity_hours > 0 ? settings.daily_capacity_hours : 8,
    today,
  })

  // ── KPIs ──
  const now = new Date()
  const monthStart = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-01`
  const allJobsForKpi = jobs as unknown as { status: string; scheduled_date: string }[]
  const accepted = quotes.filter(q => q.status === 'accepted').length
  const decided = quotes.filter(q => q.status !== 'draft').length
  const hour = now.getHours()

  return {
    money: {
      today: todayCash.total, todayCount: todayCash.count,
      week: weekCash.total, weekLabel: 'Last 7 days',
      owed: outstanding, owedCount: owing.length,
      overdue, overdueCount: overdueInv.length,
    },
    priorities,
    dayPlan,
    kpis: {
      collected: invoices.reduce((s, i) => s + (Number(i.amount_paid) || 0), 0),
      jobsThisMonth: allJobsForKpi.filter(j => j.status === 'completed' && j.scheduled_date >= monthStart).length,
      conversionRate: decided > 0 ? Math.round((accepted / decided) * 100) : null,
    },
    weather,
    greeting: hour < 12 ? 'Good morning' : hour < 17 ? 'Good afternoon' : 'Good evening',
    dateLine: now.toLocaleDateString('en-CA', { weekday: 'long', month: 'long', day: 'numeric' }),
  }
}

function isoPlusDays(iso: string, days: number): string {
  const d = new Date(`${iso}T00:00:00`)
  d.setDate(d.getDate() + days)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

// Supabase types an embedded to-one relation as object-or-array depending on how
// it infers the relationship — normalise both shapes.
function normalizePlanJobs(rows: unknown): PlanJob[] {
  type Raw = Omit<PlanJob, 'customers' | 'properties'> & {
    customers: PlanJob['customers'] | PlanJob['customers'][] | null
    properties: PlanJob['properties'] | PlanJob['properties'][] | null
  }
  return ((rows as Raw[]) || []).map(r => ({
    ...r,
    customers: Array.isArray(r.customers) ? r.customers[0] ?? null : r.customers,
    properties: Array.isArray(r.properties) ? r.properties[0] ?? null : r.properties,
  }))
}
