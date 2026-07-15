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
import { loadLeadsNeedingResponse } from '@/lib/leadResponse'
import { loadWeatherImpact, type WeatherImpactReport } from '@/lib/weatherImpact'
import { settingsToSeasons } from '@/lib/seasons'
import { localTodayISO } from '@/lib/utils'
import { computePriorities, type Priority } from '@/lib/dashboard/priorities'
import { computeDayPlan, type DayPlan, type PlanJob } from '@/lib/dashboard/dayPlan'
import type { RJob, RRecurrence } from '@/lib/reactivation'
import type { MoneyBandValues } from '@/components/dashboard/MoneyBand'

export interface DashboardData {
  money: MoneyBandValues
  priorities: Priority[]
  dayPlan: DayPlan
  kpis: { collected: number; jobsThisMonth: number; conversionRate: number }
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

  const [
    invRes, jobRes, planJobRes, quoteRes, recRes, convRes, custRes, setRes,
    todayCash, weekCash, leads, weather,
  ] = await Promise.all([
    sb.from('invoices').select('amount, status, amount_paid, discount_type, discount_value, due_date').eq('user_id', userId),
    // Every job, lean columns — feeds priorities (missed/unscheduled) + reactivation.
    sb.from('jobs').select('quote_id, customer_id, status, scheduled_date, recurrence_id, price, service_type').eq('user_id', userId),
    // The day plan needs joins + times, but only for the days it shows, so it is a
    // separate NARROW read rather than widening the full-history query above.
    sb.from('jobs')
      .select('id, scheduled_date, start_time, service_type, duration_minutes, price, quote_id, recurrence_id, customers(name, phone), properties(address)')
      .eq('user_id', userId)
      .gte('scheduled_date', today)
      .lte('scheduled_date', isoPlusDays(today, 21))
      .in('status', ['scheduled', 'in_progress'])
      .order('start_time', { nullsFirst: true }),
    sb.from('quotes').select('*').eq('user_id', userId),
    sb.from('job_recurrences').select('id, freq, interval_unit, interval_count').eq('user_id', userId),
    sb.from('conversations').select('unread').eq('user_id', userId).is('archived_at', null).gt('unread', 0),
    sb.from('customers').select('id').eq('user_id', userId).is('archived_at', null),
    sb.from('business_settings').select('gst_percent, service_seasons, preferred_work_days, work_start_time, daily_capacity_hours').eq('user_id', userId).maybeSingle(),
    collectedBetween(sb, { userId, startIso: dayB.start, endIso: dayB.end }),
    collectedBetween(sb, { userId, startIso: weekB.start, endIso: dayB.end }),
    loadLeadsNeedingResponse(sb),
    // Weather is the one slow dependency (external forecast). It rides along in the
    // same Promise.all so it never blocks the rest, and a failure degrades to null
    // rather than taking the morning down with it.
    loadWeatherImpact(sb).catch(() => null),
  ])

  const settings = (setRes.data as SettingsRow | null)
  type InvoiceRow = Pick<Invoice, 'amount' | 'status' | 'amount_paid' | 'discount_type' | 'discount_value' | 'due_date'>
  const invoices = (invRes.data as InvoiceRow[]) || []
  const quotes = (quoteRes.data as Quote[]) || []
  const jobs = (jobRes.data as RJob[]) || []
  const recById: Record<string, RRecurrence> = {}
  for (const r of (recRes.data as RRecurrence[]) || []) recById[r.id] = r

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
    customers: (custRes.data as { id: string }[]) || [],
    conversations: (convRes.data as { unread: number }[]) || [],
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
      conversionRate: decided > 0 ? Math.round((accepted / decided) * 100) : 0,
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
