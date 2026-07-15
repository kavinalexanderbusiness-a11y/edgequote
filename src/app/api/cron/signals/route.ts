import { NextRequest, NextResponse } from 'next/server'
import { cronSecretOk, serviceClient } from '@/lib/cron/guard'
import { settingsToSeasons, ServiceSeasons } from '@/lib/seasons'
import { effectiveFreq } from '@/lib/invoicing'
import { cadenceDays, churnRisk, daysBetween, isSeasonallyDormant, ranOut } from '@/lib/signals'
import { localTodayISO } from '@/lib/utils'

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

type Client = NonNullable<ReturnType<typeof serviceClient>>

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

// PostgREST caps a response at 1000 rows and does NOT raise an error, so an
// unbounded select silently drops everything past the cap. The schedule page hit
// this exact bug (see fetchAllJobs in dashboard/schedule/page.tsx). It is worse in
// a detector: with no ORDER BY, *which* 1000 rows come back is arbitrary and may
// differ between runs, so a customer's ran-out/churn signal appears and vanishes
// night to night with no change in the data behind it. `id` is the stable tiebreak
// — dozens of jobs share one scheduled_date, and without it the row order across
// pages isn't deterministic, so rows repeat or are skipped at a page boundary.
const PAGE_ROWS = 1000

async function fetchAllJobs(supabase: Client, uid: string): Promise<{ rows: JobRow[]; error: string | null }> {
  const rows: JobRow[] = []
  for (let from = 0; ; from += PAGE_ROWS) {
    const { data, error } = await supabase
      .from('jobs')
      .select('customer_id, scheduled_date, status, service_type, recurrence_id')
      .eq('user_id', uid)
      .order('scheduled_date')
      .order('id')
      .range(from, from + PAGE_ROWS - 1)
    if (error) return { rows, error: error.message }
    const batch = (data as JobRow[] | null) || []
    rows.push(...batch)
    if (batch.length < PAGE_ROWS) return { rows, error: null }
  }
}

async function fetchAllRecurrences(supabase: Client, uid: string): Promise<{ rows: RecRow[]; error: string | null }> {
  const rows: RecRow[] = []
  for (let from = 0; ; from += PAGE_ROWS) {
    const { data, error } = await supabase
      .from('job_recurrences')
      .select('id, freq, interval_unit, interval_count')
      .eq('user_id', uid)
      .order('id')
      .range(from, from + PAGE_ROWS - 1)
    if (error) return { rows, error: error.message }
    const batch = (data as RecRow[] | null) || []
    rows.push(...batch)
    if (batch.length < PAGE_ROWS) return { rows, error: null }
  }
}

export async function GET(req: NextRequest) {
  if (!cronSecretOk(req)) return NextResponse.json({ error: 'forbidden' }, { status: 403 })
  const supabase = serviceClient()
  if (!supabase) {
    // The one deliberate no-op: no service key configured → 200, because nothing is
    // broken. Every OTHER failure below is a broken deploy and must be non-2xx.
    return NextResponse.json({ ok: true, skipped: true, note: 'Set SUPABASE_SERVICE_ROLE_KEY to enable the signal sweep.' })
  }

  const today = localTodayISO()

  // Owners to sweep. business_settings is the one row-per-owner table every cron
  // already keys off, and it carries the seasons the detectors need.
  const { data: settingsRows, error: sErr } = await supabase.from('business_settings').select('user_id, service_seasons')
  if (sErr) return NextResponse.json({ ok: false, error: sErr.message }, { status: 500 })
  const owners = (settingsRows as { user_id: string; service_seasons: unknown }[] | null) || []
  if (!owners.length) return NextResponse.json({ ok: true, owners: 0, signals: 0 })

  const rows: SignalRow[] = []

  for (const owner of owners) {
    const uid = owner.user_id
    const seasons: ServiceSeasons = settingsToSeasons(owner.service_seasons)

    const [jRes, rRes] = await Promise.all([fetchAllJobs(supabase, uid), fetchAllRecurrences(supabase, uid)])
    // A truncated read is a WRONG read, not a smaller one: it would emit ran-out for
    // a customer whose upcoming visit happened to be on a page we never fetched.
    // Fail the run rather than write signals derived from half the data.
    if (jRes.error) return NextResponse.json({ ok: false, error: jRes.error }, { status: 500 })
    if (rRes.error) return NextResponse.json({ ok: false, error: rRes.error }, { status: 500 })
    const jobs = jRes.rows
    const recById: Record<string, RecRow> = {}
    for (const r of rRes.rows) recById[r.id] = r

    const byCust: Record<string, JobRow[]> = {}
    for (const j of jobs) if (j.customer_id) (byCust[j.customer_id] ||= []).push(j)

    for (const [customerId, cj] of Object.entries(byCust)) {
      // Same shape every screen builds — the DETECTORS are shared, the aggregates
      // are each caller's own (see lib/signals' contract).
      const recJob = cj.filter(j => j.recurrence_id).sort((a, b) => b.scheduled_date.localeCompare(a.scheduled_date))[0]
      if (!recJob) continue
      const hasUpcoming = cj.some(j => j.scheduled_date >= today && (j.status === 'scheduled' || j.status === 'in_progress'))
      // A series whose every visit is cancelled is not a series. `recJob` only proves
      // the customer was EVER recurring, so passing hasRecurring:true swept a
      // cancelled-outright customer as live and re-booked them forever.
      const hasRecurring = cj.some(j => j.recurrence_id && j.status !== 'cancelled')
      const completed = cj.filter(j => j.status === 'completed').map(j => j.scheduled_date).sort()
      const pastReal = cj.filter(j => j.status !== 'cancelled' && j.scheduled_date <= today).map(j => j.scheduled_date).sort()
      const lastServiceDate = completed.length ? completed[completed.length - 1] : (pastReal.length ? pastReal[pastReal.length - 1] : null)

      const rec = recJob.recurrence_id ? recById[recJob.recurrence_id] : null
      const freq = rec ? effectiveFreq(rec.freq, rec.interval_unit, rec.interval_count) : null
      const cadence = cadenceDays(freq, rec)
      const dormant = isSeasonallyDormant(recJob.service_type ?? null, seasons, today)

      const ro = ranOut({ hasRecurring, hasUpcoming, lastServiceDate, cadenceDays: cadence, seasonallyDormant: dormant, today })
      if (ro.isRanOut) {
        rows.push({
          user_id: uid, signal: 'recurring_ran_out', subject_type: 'customer', subject_id: customerId, detected_on: today,
          payload: { daysSince: ro.daysSince, cadenceDays: cadence, cadence: freq, urgent: ro.isUrgent, lastServiceDate },
        })
      }

      // These two inputs are the difference between churn_risk MEANING something and
      // being a second name for ran-out.
      //  • hasActiveRecurring was `hasUpcoming || !!recJob` — but recJob is proven
      //    truthy three lines up, so it was ALWAYS true and hasUpcoming was never
      //    consulted: a series dead for two years read as "on a rhythm".
      //  • daysSinceLastService was `ro.daysSince`, which is non-null ONLY when
      //    ran-out fired — so churn_risk fired if and only if ran-out fired, and the
      //    customer this rule exists for (drifting past cadence but still holding a
      //    booking) could never be flagged.
      // Both are computed from the source now, the way revenueIntelligence does it.
      const churn = churnRisk({
        hasActiveRecurring: hasUpcoming,
        daysSinceLastService: lastServiceDate ? daysBetween(lastServiceDate, today) : null,
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
    // A missing table IS a broken deploy, and Vercel Cron only surfaces non-2xx —
    // answering 200 here bought nine green checks a night while the sweep wrote
    // nothing at all. Fail loudly; the note still says which migration to run.
    if (error) return NextResponse.json({ ok: false, error: error.message, note: 'Run RUN-2026-07-14-automation-signals.sql', detected: rows.length }, { status: 500 })
    written += chunk.length
  }

  return NextResponse.json({ ok: true, owners: owners.length, detected: rows.length, written, sent: 0 })
}
