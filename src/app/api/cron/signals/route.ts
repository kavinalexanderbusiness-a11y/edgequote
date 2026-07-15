import { NextRequest, NextResponse } from 'next/server'
import { cronSecretOk, serviceClient } from '@/lib/cron/guard'
import { settingsToSeasons, ServiceSeasons } from '@/lib/seasons'
import { cadenceDays, churnRisk, daysBetween, isSeasonallyDormant, ranOut } from '@/lib/signals'
import { localTodayISO } from '@/lib/utils'

export const dynamic = 'force-dynamic'
// The only cron with an O(owners) sequential loop — each owner costs two paginated
// reads — so it is the last one that should keep the 60s default. 300 is what every
// other shipped cron asks for.
export const maxDuration = 300

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
interface OwnerRow { user_id: string; service_seasons: unknown }

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

// The owner list was the one unbounded read in this file — so at 1001 owners, owner
// #1001 silently stopped being swept forever, behind a green cron. The detectors
// below were all carefully paged while the loop that feeds them was not.
// No `id` tiebreak here, unlike the two above: business_settings.user_id carries a
// UNIQUE constraint (business_settings_user_id_key), so it is already a total order.
// The jobs/recurrences pages need one because scheduled_date is not unique.
async function fetchAllOwners(supabase: Client): Promise<{ rows: OwnerRow[]; error: string | null }> {
  const rows: OwnerRow[] = []
  for (let from = 0; ; from += PAGE_ROWS) {
    const { data, error } = await supabase
      .from('business_settings')
      .select('user_id, service_seasons')
      .order('user_id')
      .range(from, from + PAGE_ROWS - 1)
    if (error) return { rows, error: error.message }
    const batch = (data as OwnerRow[] | null) || []
    rows.push(...batch)
    if (batch.length < PAGE_ROWS) return { rows, error: null }
  }
}

// The heartbeat. Wrapped because logging the failure must never BE the failure: a
// sweep that worked is not allowed to report failure because its proof-of-life row
// didn't land (see chase.ts on the same trap). Console is the last resort — no
// heartbeat row, but the run's real outcome survives.
async function heartbeat(supabase: Client, row: Record<string, unknown>): Promise<void> {
  try {
    const { error } = await supabase.from('automation_sweeps').upsert(row, { onConflict: 'job,ran_on' })
    if (error) console.error('[cron/signals] heartbeat write failed:', error.message)
  } catch (e) {
    console.error('[cron/signals] heartbeat write threw:', e instanceof Error ? e.message : e)
  }
}

export async function GET(req: NextRequest) {
  if (!cronSecretOk(req)) return NextResponse.json({ error: 'forbidden' }, { status: 403 })
  const startedAt = Date.now()
  // Vercel's own request id, so a log line and its heartbeat row can be pinned to the
  // one invocation that wrote them.
  const requestId = req.headers.get('x-vercel-id')

  const supabase = serviceClient()
  if (!supabase) {
    // A missing key is a BROKEN DEPLOY, not a no-op: this answered 200 while sweeping
    // nothing, which is the failure the heartbeat exists to expose — and the one
    // failure it can never record, because writing the row needs the client we don't
    // have. The console line and the non-2xx are the only evidence that can exist.
    console.error('[cron/signals] SUPABASE_SERVICE_ROLE_KEY is missing or unreadable — the sweep did not run, and it cannot write an automation_sweeps row to say so. This log line is the only record.')
    return NextResponse.json(
      { ok: false, error: 'no service client', note: 'Set SUPABASE_SERVICE_ROLE_KEY to enable the signal sweep.' },
      { status: 503 },
    )
  }

  const today = localTodayISO()

  // Every exit lands here: one log line and one heartbeat row, unconditionally. The
  // four shipped crons guard their log with `if (batch.length > 0)` so quiet runs stay
  // quiet — the opposite is right for a detection sweep, where the quiet night is
  // exactly the night that needs proof it happened at all.
  const finish = async (r: {
    ok: boolean; owners: number; ownersFailed: number; detected: number; written: number
    error?: string; note?: string; status?: number
  }): Promise<NextResponse> => {
    const ms = Date.now() - startedAt
    const summary = {
      ok: r.ok, owners: r.owners, ownersFailed: r.ownersFailed,
      detected: r.detected, written: r.written, ms, requestId,
      ...(r.error ? { error: r.error } : {}),
    }
    console.log('[cron/signals] run:', JSON.stringify(summary))
    await heartbeat(supabase, {
      job: 'signals', ran_on: today, ok: r.ok,
      owners: r.owners, detected: r.detected, written: r.written, ms,
      error: r.error ? r.error.slice(0, 200) : null,
      request_id: requestId,
      // Set explicitly, not left to the column default: the PK is (job, ran_on), so a
      // re-run today UPDATEs, and `default now()` only fires on INSERT. Without this the
      // row would carry the first run's timestamp beside the latest run's verdict.
      ran_at: new Date().toISOString(),
    })
    return NextResponse.json(
      { ok: r.ok, owners: r.owners, ownersFailed: r.ownersFailed, detected: r.detected, written: r.written, sent: 0, ...(r.error ? { error: r.error } : {}), ...(r.note ? { note: r.note } : {}) },
      { status: r.status ?? 200 },
    )
  }

  const oRes = await fetchAllOwners(supabase)
  if (oRes.error) {
    console.error('[cron/signals] owner list query failed:', oRes.error)
    return finish({ ok: false, owners: 0, ownersFailed: 0, detected: 0, written: 0, error: oRes.error, status: 500 })
  }
  const owners = oRes.rows
  if (!owners.length) return finish({ ok: true, owners: 0, ownersFailed: 0, detected: 0, written: 0 })

  const rows: SignalRow[] = []
  let ownersFailed = 0

  for (const owner of owners) {
    const uid = owner.user_id
    try {
      // Accumulated per owner and merged only on success. A half-swept owner's rows
      // are derived from data we already know is incomplete — the same reason a
      // truncated read is rejected outright below.
      const mine: SignalRow[] = []
      const seasons: ServiceSeasons = settingsToSeasons(owner.service_seasons)

      const [jRes, rRes] = await Promise.all([fetchAllJobs(supabase, uid), fetchAllRecurrences(supabase, uid)])
      // A truncated read is a WRONG read, not a smaller one: it would emit ran-out for
      // a customer whose upcoming visit happened to be on a page we never fetched.
      // Skip this owner rather than write signals derived from half their data.
      if (jRes.error) throw new Error(`jobs: ${jRes.error}`)
      if (rRes.error) throw new Error(`recurrences: ${rRes.error}`)
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
        // A PRICING BUCKET IS NOT A CADENCE. This used to read
        //   cadenceDays(effectiveFreq(rec.freq, rec.interval_unit, rec.interval_count), rec)
        // but effectiveFreq is lossy BY DESIGN (see lib/invoicing): it resolves a custom
        // interval to the NEAREST STANDARD PRICE bucket — unit='month' → 'monthly'
        // whatever the count, unit='week' count=3 → 'biweekly'. Right for money, wrong
        // for time. cadenceDays then matches 'monthly' on its FIRST branch and returns
        // 30, never reaching the `rec` branch that reads interval_count.
        // A bi-monthly customer (true cadence 60d) therefore got 30: at 45 days the true
        // ratio is 0.75 ('none') but the computed one is 1.5 → a FALSE churn_risk.
        // Every-3-weeks (21d) got 14 → false 'high'. Cadence also sizes ran-out's urgent
        // window, so BOTH signals inherited the error.
        // The raw freq keeps legacy weekly/biweekly/monthly rows on their exact branches
        // and lets every custom interval (freq is null for those) fall through to the
        // precise `rec` branch.
        //
        // NOTE: customerHealth / revenueIntelligence / businessIntelligence still compose
        // it the lossy way, so for custom cadences the SCREENS still disagree with this
        // sweep. Changing them shifts numbers on live dashboards — a separate owner call.
        const freq = rec?.freq ?? null
        const cadence = cadenceDays(freq, rec)
        const dormant = isSeasonallyDormant(recJob.service_type ?? null, seasons, today)

        const ro = ranOut({ hasRecurring, hasUpcoming, lastServiceDate, cadenceDays: cadence, seasonallyDormant: dormant, today })
        if (ro.isRanOut) {
          mine.push({
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
          mine.push({
            user_id: uid, signal: 'churn_risk', subject_type: 'customer', subject_id: customerId, detected_on: today,
            payload: { level: churn.level, ratio: Math.round(churn.ratio * 100) / 100, overdueDays: churn.overdueDays, cadenceDays: cadence },
          })
        }
      }

      rows.push(...mine)
    } catch (e) {
      // ONE BAD OWNER MUST NOT ABORT THE SWEEP. This used to `return` a 500 from inside
      // the loop, before the single write at the end — so one owner's transient read
      // error discarded the whole night's detection for EVERY owner, including the ones
      // already swept clean. Record them, skip them, sweep the rest.
      ownersFailed++
      console.error(`[cron/signals] owner ${uid} was skipped:`, e instanceof Error ? e.message : e)
    }
  }

  // Every owner failing is not a quiet night — it is a failed run that happens to have
  // written nothing, and the two must not look alike to the scheduler.
  if (ownersFailed === owners.length) {
    return finish({
      ok: false, owners: owners.length, ownersFailed, detected: 0, written: 0,
      error: `all ${owners.length} owner(s) failed`, status: 500,
    })
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
    // nothing at all. Fail loudly. The note is for an operator, and the scheduler
    // throws the body away, so it has to go to the log to be reachable at all.
    if (error) {
      console.error('[cron/signals] writing automation_signals failed:', error.message, '— run RUN-2026-07-14-automation-signals.sql if the table is missing.')
      return finish({
        ok: false, owners: owners.length, ownersFailed, detected: rows.length, written,
        error: error.message, note: 'Run RUN-2026-07-14-automation-signals.sql', status: 500,
      })
    }
    written += chunk.length
  }

  // A run that swept some owners and lost others is not a clean run: `ok` tracks
  // whether the sweep was COMPLETE, not whether it survived. A skipped owner is
  // undetected-for until tomorrow, which is the whole failure this heartbeat exists to
  // surface — so it is reported with a reason rather than hidden behind a green tick.
  // The status stays 2xx: the work that could be done was done and is durable, and a
  // 500 would ask the scheduler to treat a mostly-good night as a broken deploy.
  return finish({
    ok: ownersFailed === 0,
    owners: owners.length, ownersFailed, detected: rows.length, written,
    error: ownersFailed > 0 ? `${ownersFailed} of ${owners.length} owner(s) failed and were skipped` : undefined,
  })
}
