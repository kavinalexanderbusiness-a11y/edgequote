import { NextRequest, NextResponse } from 'next/server'
import type { SupabaseClient } from '@supabase/supabase-js'
import { cronSecretOk, serviceClient } from '@/lib/cron/guard'
import { addDaysISO, safeTimeZone, tenantMoment } from '@/lib/tenantTime'
import {
  buildOwnerReminder, dueOwnerReminderSlots,
  type OwnerReminderEquipment, type OwnerReminderInvoice, type OwnerReminderJob,
  type OwnerReminderPrefs, type OwnerReminderSettings,
} from '@/lib/ownerReminders'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'
export const maxDuration = 300

// This route is safe for an HOURLY scheduler: each tenant's own IANA timezone and
// configured workday decide whether a morning or close digest is due. Supabase
// Cron owns that cadence because this project's Vercel Hobby plan rejects
// sub-daily expressions at deploy time (see the paired migration).

const MAX_SUBSCRIPTIONS = 1000
const MAX_ROWS = 1000

interface SettingsRow {
  user_id: string
  timezone: string | null
  work_start_time: string | null
  daily_capacity_hours: number | string | null
  gst_percent: number | string | null
  notif_prefs: OwnerReminderPrefs | null
}

interface JobRow {
  id: string
  scheduled_date: string
  status: string
  start_time: string | null
  end_time: string | null
  duration_minutes: number | null
  crew_id: string | null
  notes: string | null
  no_charge_at: string | null
}

interface InvoiceRow {
  id: string
  job_id: string | null
  status: string
  amount: number | string
  amount_paid: number | string | null
  due_date: string | null
  discount_type: 'amount' | 'percent' | null
  discount_value: number | string | null
}

async function loadOwnerData(sb: SupabaseClient, settings: OwnerReminderSettings, now: Date) {
  const today = tenantMoment(settings.timeZone, now).date
  const tomorrow = addDaysISO(today, 1)
  const { data: jobsData, error: jobsError } = await sb.from('jobs')
    .select('id, scheduled_date, status, start_time, end_time, duration_minutes, crew_id, notes, no_charge_at')
    .eq('user_id', settings.userId).in('scheduled_date', [today, tomorrow])
    .in('status', ['scheduled', 'in_progress', 'completed']).order('id').limit(MAX_ROWS + 1)
  if (jobsError) throw new Error(`jobs: ${jobsError.message}`)
  const jobs = (jobsData as JobRow[] | null) ?? []
  if (jobs.length > MAX_ROWS) throw new Error(`jobs: more than ${MAX_ROWS} rows for ${today}/${tomorrow}`)

  const crewIds = [...new Set(jobs.map(j => j.crew_id).filter((id): id is string => !!id))]
  const [openInvoicesRes, jobInvoicesRes, crewsRes, equipmentRes] = await Promise.all([
    sb.from('invoices').select('id, job_id, status, amount, amount_paid, due_date, discount_type, discount_value')
      .eq('user_id', settings.userId).in('status', ['draft', 'unpaid', 'sent', 'partial']).order('id').limit(MAX_ROWS + 1),
    jobs.length
      ? sb.from('invoices').select('id, job_id, status, amount, amount_paid, due_date, discount_type, discount_value')
          .eq('user_id', settings.userId).in('job_id', jobs.map(j => j.id)).order('id').limit(MAX_ROWS + 1)
      : Promise.resolve({ data: [], error: null }),
    crewIds.length
      ? sb.from('crews').select('id, name').eq('user_id', settings.userId).in('id', crewIds).limit(MAX_ROWS + 1)
      : Promise.resolve({ data: [], error: null }),
    crewIds.length
      ? sb.from('equipment').select('name, crew_id, status').eq('user_id', settings.userId).in('crew_id', crewIds).eq('status', 'active').limit(MAX_ROWS + 1)
      : Promise.resolve({ data: [], error: null }),
  ])
  const failed = [openInvoicesRes.error, jobInvoicesRes.error, crewsRes.error, equipmentRes.error].find(Boolean)
  if (failed) throw new Error(`owner data: ${failed?.message}`)
  for (const [name, rows] of [
    ['open invoices', openInvoicesRes.data], ['job invoices', jobInvoicesRes.data],
    ['crews', crewsRes.data], ['equipment', equipmentRes.data],
  ] as const) if ((rows?.length ?? 0) > MAX_ROWS) throw new Error(`${name}: more than ${MAX_ROWS} rows`)

  const crewNames = new Map(((crewsRes.data ?? []) as { id: string; name: string }[]).map(c => [c.id, c.name]))
  const mappedJobs: OwnerReminderJob[] = jobs.map(j => ({
    id: j.id, scheduledDate: j.scheduled_date, status: j.status,
    startTime: j.start_time, endTime: j.end_time, durationMinutes: j.duration_minutes,
    crewId: j.crew_id, crewName: j.crew_id ? crewNames.get(j.crew_id) ?? null : null,
    // We deliberately do not put note text on a lock screen. Its presence tells
    // the owner to open the authenticated day plan for equipment/material detail.
    hasPrepNotes: !!j.notes?.trim(), noCharge: !!j.no_charge_at,
  }))
  const byId = new Map<string, InvoiceRow>()
  for (const row of [...((openInvoicesRes.data ?? []) as InvoiceRow[]), ...((jobInvoicesRes.data ?? []) as InvoiceRow[])]) byId.set(row.id, row)
  const invoices: OwnerReminderInvoice[] = [...byId.values()].map(i => ({
    id: i.id, jobId: i.job_id, status: i.status,
    amount: Number(i.amount) || 0, amountPaid: Number(i.amount_paid) || 0, dueDate: i.due_date,
    discountType: i.discount_type, discountValue: Number(i.discount_value) || null,
  }))
  const equipment: OwnerReminderEquipment[] = ((equipmentRes.data ?? []) as { name: string; crew_id: string | null; status: string }[])
    .map(e => ({ name: e.name, crewId: e.crew_id, status: e.status }))
  return {
    todayJobs: mappedJobs.filter(j => j.scheduledDate === today),
    tomorrowJobs: mappedJobs.filter(j => j.scheduledDate === tomorrow),
    invoices, equipment,
  }
}

async function handler(req: NextRequest) {
  if (!cronSecretOk(req)) return NextResponse.json({ error: 'forbidden' }, { status: 403 })
  const sb = serviceClient()
  if (!sb) return NextResponse.json({ ok: false, error: 'admin-unavailable' }, { status: 503 })
  const now = new Date()

  // Target only users who have explicitly enabled Web Push on at least one device.
  const { data: subs, error: subsError } = await sb.from('push_subscriptions')
    .select('user_id').order('user_id').limit(MAX_SUBSCRIPTIONS + 1)
  if (subsError) return NextResponse.json({ ok: false, error: `subscriptions: ${subsError.message}` }, { status: 500 })
  if ((subs?.length ?? 0) > MAX_SUBSCRIPTIONS) {
    return NextResponse.json({ ok: false, error: `more than ${MAX_SUBSCRIPTIONS} push subscriptions; refusing a partial sweep` }, { status: 503 })
  }
  const userIds = [...new Set(((subs ?? []) as { user_id: string }[]).map(s => s.user_id))]
  if (!userIds.length) return NextResponse.json({ ok: true, owners: 0, due: 0, created: 0, duplicate: 0, errors: 0 })

  const { data: settingsData, error: settingsError } = await sb.from('business_settings')
    .select('user_id, timezone, work_start_time, daily_capacity_hours, gst_percent, notif_prefs')
    .in('user_id', userIds).order('user_id').limit(MAX_SUBSCRIPTIONS + 1)
  if (settingsError) return NextResponse.json({ ok: false, error: `settings: ${settingsError.message}` }, { status: 500 })

  let due = 0, created = 0, duplicate = 0, errors = 0
  for (const row of (settingsData as SettingsRow[] | null) ?? []) {
    const settings: OwnerReminderSettings = {
      userId: row.user_id, timeZone: safeTimeZone(row.timezone), workStartTime: row.work_start_time,
      dailyCapacityHours: Number(row.daily_capacity_hours) || null,
      gstPercent: Number(row.gst_percent) || null, prefs: row.notif_prefs,
    }
    const slots = dueOwnerReminderSlots(settings, now)
    if (!slots.length) continue
    due++
    try {
      const data = await loadOwnerData(sb, settings, now)
      for (const slot of slots) {
        const planned = buildOwnerReminder({ settings, now, ...data }, slot)
        if (!planned) continue
        const { error } = await sb.from('notifications').insert({
          id: planned.id, user_id: settings.userId, type: planned.type,
          title: planned.title, body: planned.body, href: planned.href,
          entity_type: 'owner_reminder',
        })
        if (!error) created++
        else if (error.code === '23505') duplicate++
        else { errors++; console.error(`[cron/owner-reminders] insert failed for ${settings.userId}/${slot}:`, error.message) }
      }
    } catch (error) {
      errors++
      console.error(`[cron/owner-reminders] owner ${settings.userId} failed:`, error)
    }
  }
  return NextResponse.json({ ok: errors === 0, owners: userIds.length, due, created, duplicate, errors })
}

export const GET = handler
export const POST = handler
