import { NextRequest, NextResponse } from 'next/server'
import { cronSecretOk, serviceClient } from '@/lib/cron/guard'
import { settingsToSeasons, ServiceSeasons } from '@/lib/seasons'
import { effectiveFreq } from '@/lib/invoicing'
import { cadenceDays, churnRisk, isSeasonallyDormant, ranOut } from '@/lib/signals'

export const dynamic = 'force-dynamic'
export const maxDuration = 60

// ── Signal sweep (Vercel Cron → see vercel.json) ─────────────────────────────
// THE detection half of the automation engine.
//
// The problem it exists for: EdgeQuote has ~75 detectors and, before this, three
// of them ran without a browser open. Ran-out, churn risk, VIP-at-risk and the
// rest were computed in a useEffect — so an owner who stopped opening the app was
// never told a $2,400/yr customer was slipping, while the birthday cron cheerfully
// texted them. Detection that only exists while someone is looking cannot drive an
// automation.
//
// This sweeps the server-runnable detectors in lib/signals and records what it
// found in `automation_signals`. It DOES NOT SEND, notify, or mutate anything a
// customer or owner can see. It is the seam future automations read from: a rule
// consumes a signal row, it never re-derives the condition (that is how six
// screens ended up disagreeing about who had churned).
//
// Idempotent: one row per (user, signal, subject, day) — re-running is a no-op.
// Nothing consumes these rows yet, by design; see AUTOMATION_ARCHITECTURE.md.

interface JobRow {
  customer_id: string | null
  scheduled_date: string
  status: string
  service_type: string | null
  recurrence_id: string | null
}
interface RecRow { id: string; freq: string | null; interval_unit: string | null; interval_count: number | null }

type SignalRow = {
  user_id: string
  signal: string
  subject_type: string
  subject_id: string
  detected_on: string
  payload: Record<string, unknown>
}

function localToday(): string {
  const d = new Date()
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

export async function GET(req: NextRequest) {
  if (!cronSecretOk(req)) return NextResponse.json({ error: 'forbidden' }, { status: 403 })
  const supabase = serviceClient()
  if (!supabase) {
    return NextResponse.json({ ok: true, skipped: true, note: 'Set SUPABASE_SERVICE_ROLE_KEY to enable the signal sweep.' })
  }

  const today = localToday()

  // Owners to sweep. business_settings is the one row-per-owner table every cron
  // already keys off, and it carries the seasons the detectors need.
  const { data: settingsRows } = await supabase.from('business_settings').select('user_id, service_seasons')
  const owners = (settingsRows as { user_id: string; service_seasons: unknown }[] | null) || []
  if (!owners.length) return NextResponse.json({ ok: true, owners: 0, signals: 0 })

  const rows: SignalRow[] = []

  for (const owner of owners) {
    const uid = owner.user_id
    const seasons: ServiceSeasons = settingsToSeasons(owner.service_seasons)

    const [jRes, rRes] = await Promise.all([
      supabase.from('jobs').select('customer_id, scheduled_date, status, service_type, recurrence_id').eq('user_id', uid),
      supabase.from('job_recurrences').select('id, freq, interval_unit, interval_count').eq('user_id', uid),
    ])
    const jobs = (jRes.data as JobRow[] | null) || []
    const recById: Record<string, RecRow> = {}
    for (const r of (rRes.data as RecRow[] | null) || []) recById[r.id] = r

    const byCust: Record<string, JobRow[]> = {}
    for (const j of jobs) if (j.customer_id) (byCust[j.customer_id] ||= []).push(j)

    for (const [customerId, cj] of Object.entries(byCust)) {
      // Same shape every screen builds — the DETECTORS are shared, the aggregates
      // are each caller's own (see lib/signals' contract).
      const recJob = cj.filter(j => j.recurrence_id).sort((a, b) => b.scheduled_date.localeCompare(a.scheduled_date))[0]
      if (!recJob) continue
      const hasUpcoming = cj.some(j => j.scheduled_date >= today && (j.status === 'scheduled' || j.status === 'in_progress'))
      const completed = cj.filter(j => j.status === 'completed').map(j => j.scheduled_date).sort()
      const pastReal = cj.filter(j => j.status !== 'cancelled' && j.scheduled_date <= today).map(j => j.scheduled_date).sort()
      const lastServiceDate = completed.length ? completed[completed.length - 1] : (pastReal.length ? pastReal[pastReal.length - 1] : null)

      const rec = recJob.recurrence_id ? recById[recJob.recurrence_id] : null
      const freq = rec ? effectiveFreq(rec.freq, rec.interval_unit, rec.interval_count) : null
      const cadence = cadenceDays(freq, rec)
      const dormant = isSeasonallyDormant(recJob.service_type ?? null, seasons, today)

      const ro = ranOut({ hasRecurring: true, hasUpcoming, lastServiceDate, cadenceDays: cadence, seasonallyDormant: dormant, today })
      if (ro.isRanOut) {
        rows.push({
          user_id: uid, signal: 'recurring_ran_out', subject_type: 'customer', subject_id: customerId, detected_on: today,
          payload: { daysSince: ro.daysSince, cadenceDays: cadence, cadence: freq, urgent: ro.isUrgent, lastServiceDate },
        })
      }

      const churn = churnRisk({
        hasActiveRecurring: hasUpcoming || !!recJob,
        daysSinceLastService: ro.daysSince,
        cadenceDays: cadence,
        seasonallyDormant: dormant,
      })
      if (churn.level !== 'none') {
        rows.push({
          user_id: uid, signal: 'churn_risk', subject_type: 'customer', subject_id: customerId, detected_on: today,
          payload: { level: churn.level, ratio: Math.round(churn.ratio * 100) / 100, overdueDays: churn.overdueDays, cadenceDays: cadence },
        })
      }
    }
  }

  // One row per (user, signal, subject, day) — the unique index makes a re-run a
  // no-op rather than a pile of duplicates.
  let written = 0
  for (let i = 0; i < rows.length; i += 500) {
    const chunk = rows.slice(i, i + 500)
    const { error } = await supabase
      .from('automation_signals')
      .upsert(chunk, { onConflict: 'user_id,signal,subject_id,detected_on', ignoreDuplicates: false })
    // A missing table must not fail the sweep loudly every night before the
    // migration is applied — report it instead.
    if (error) return NextResponse.json({ ok: false, error: error.message, note: 'Run RUN-2026-07-14-automation-signals.sql', detected: rows.length }, { status: 200 })
    written += chunk.length
  }

  return NextResponse.json({ ok: true, owners: owners.length, detected: rows.length, written, sent: 0 })
}
