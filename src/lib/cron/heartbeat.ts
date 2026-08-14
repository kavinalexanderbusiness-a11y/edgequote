import type { NextRequest, NextResponse } from 'next/server'
import type { SupabaseClient } from '@supabase/supabase-js'
import { serviceClient } from './guard'
import { localTodayISO } from '@/lib/utils'

// ── The cron heartbeat — proof a scheduled job ran ───────────────────────────
// `automation_sweeps` already answers "did this cron run, and did it work?" for
// three jobs. Nine others were declared in vercel.json and wrote nothing durable
// at all, so the only record they ever ran was a Vercel log line nobody reads —
// including AutoPay, the one that moves money.
//
// That gap is not theoretical. CRON_SECRET has never been set in production, so
// every one of the twelve has been answering 403 to the scheduler since the day
// it was declared, and `automation_sweeps` is empty. Nothing in the product said
// so, because "swept and found nothing" and "never authenticated once" are the
// same silence (the lesson RUN-2026-07-15-automation-sweeps.sql was written for,
// applied to nine more jobs).
//
// THREE writers became one. signals/, engine/ and integrations/ each hand-rolled
// this upsert with slightly different shapes — integrations keyed its day off UTC
// while the other two used the server's local date, so two jobs could file rows
// under different days for the same night. One writer, one day key, one contract.
//
// WHAT IS DELIBERATELY NOT RECORDED: an unauthenticated request. A 401/403 writes
// nothing — a stranger must not be able to fill this table, or learn from response
// timing that they hit a real job. So a cron that cannot authenticate leaves NO
// row, which is exactly how /api/health tells "declared but dead" from "ran and
// found nothing to do". The absence IS the signal.

/** Every job declared in vercel.json, keyed by its route folder name.
 *  THE canonical list — /api/health reads it to decide what should have run, and
 *  scripts/verify-cron.ts pins it against vercel.json so a cron added to one and
 *  not the other cannot ship. */
export const CRON_JOBS = {
  autopay: '/api/cron/autopay',
  campaigns: '/api/cron/campaigns',
  engine: '/api/cron/engine',
  integrations: '/api/cron/integrations',
  'invoice-reminders': '/api/cron/invoice-reminders',
  'marketing-draft': '/api/cron/marketing-draft',
  notifications: '/api/cron/notifications',
  publish: '/api/cron/publish',
  'quote-followup': '/api/cron/quote-followup',
  reports: '/api/cron/reports',
  'scheduled-messages': '/api/cron/scheduled-messages',
  signals: '/api/cron/signals',
} as const

export type CronJob = keyof typeof CRON_JOBS

/** The jobs that can reach a customer or a card. Health names these first when the
 *  scheduler is dead: "marketing drafts aren't being prepared" and "nobody is being
 *  billed" are not the same outage. */
export const CUSTOMER_FACING_JOBS: readonly CronJob[] = [
  'autopay', 'campaigns', 'invoice-reminders', 'notifications', 'quote-followup', 'reports', 'scheduled-messages',
]

/** The cross-tenant counters on `automation_sweeps`. Optional everywhere: a job
 *  with nothing meaningful to count files nulls rather than a misleading zero. */
export interface SweepCounts {
  owners?: number | null
  detected?: number | null
  written?: number | null
}

/** Pull the counters out of a job's own response body. Each job words its tally in
 *  its own nouns, so the mapping stays with the route rather than being guessed
 *  from field names here. */
export type CountsFrom = (body: Record<string, unknown>) => SweepCounts

const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null)

/** Read a count out of a response body by name — for the common case where the
 *  job already calls it what the column calls it. */
export const counts = (body: Record<string, unknown>, owners?: string, detected?: string, written?: string): SweepCounts => ({
  owners: owners ? num(body[owners]) : null,
  detected: detected ? num(body[detected]) : null,
  written: written ? num(body[written]) : null,
})

/**
 * Write the heartbeat. Wrapped in every direction because RECORDING A RUN MUST
 * NEVER BECOME THE RUN'S FAILURE — a night's reminders that went out are not
 * allowed to report failure because their proof-of-life row didn't land (the same
 * trap chase.ts documents). Console is the last resort: no row, but the work stands.
 */
export async function recordSweep(
  sb: SupabaseClient,
  job: CronJob,
  row: { ok: boolean; ms: number; error?: string | null; requestId?: string | null } & SweepCounts,
): Promise<void> {
  try {
    const { error } = await sb.from('automation_sweeps').upsert(
      {
        job,
        ran_on: localTodayISO(),
        // Set explicitly, never left to `default now()`: the PK is (job, ran_on), so
        // a second run today UPDATEs — and a column default only fires on INSERT.
        // Without this the row would carry the first run's timestamp beside the
        // latest run's verdict.
        ran_at: new Date().toISOString(),
        ok: row.ok,
        owners: row.owners ?? null,
        detected: row.detected ?? null,
        written: row.written ?? null,
        ms: row.ms,
        error: row.error ? row.error.slice(0, 200) : null,
        request_id: row.requestId ?? null,
      },
      { onConflict: 'job,ran_on' },
    )
    if (error) console.error(`[cron/${job}] heartbeat write failed:`, error.message)
  } catch (e) {
    console.error(`[cron/${job}] heartbeat write threw:`, e instanceof Error ? e.message : e)
  }
}

/** One heartbeat row, as much of it as liveness needs. */
export interface SweepRow { job: string; ok: boolean; ran_on: string }

/** What /api/health says about the scheduler. */
export interface CronVerdict {
  declared: number
  /** Is CRON_SECRET set at all? False → every job 403s and nothing can run. */
  configured: boolean
  /** Every declared job has a recent successful run. */
  operational: boolean
  /** Declared jobs with no heartbeat EVER. On a deploy that has never authenticated
   *  this is all of them — the absence is the evidence, which is exactly why a 403
   *  writes no row. */
  neverRan: CronJob[]
  /** Ran at some point, but not SUCCESSFULLY within the freshness window. */
  stale: CronJob[]
  /** The most recent run reported a failure. */
  failing: CronJob[]
  /** Of the above, the ones that reach a customer or a card. */
  customerImpacting: CronJob[]
}

/** Every declared cron is daily, so one missed night is within tolerance (a late run,
 *  a clock skewed either side of midnight) and two is not. Deliberately generous:
 *  this must not cry wolf, or it joins the warnings people learn to dismiss — the
 *  exact failure automation_sweeps was created to avoid. */
export const STALE_AFTER_DAYS = 2

/**
 * Turn heartbeat rows into "is the scheduler working?".
 *
 * Pure, so /api/health's answer can be pinned without a database — the I/O half of
 * that endpoint is a `select`, and this is the half that can be wrong.
 *
 * `freshCutoff` is passed in rather than read from the clock here for the same
 * reason: a date-sensitive verdict that reads `new Date()` internally can only be
 * tested on the day someone happens to run the suite.
 */
export function classifyCronHealth(
  rows: SweepRow[],
  opts: { configured: boolean; freshCutoff: string },
): CronVerdict {
  const declared = Object.keys(CRON_JOBS) as CronJob[]
  const neverRan: CronJob[] = [], stale: CronJob[] = [], failing: CronJob[] = []

  for (const job of declared) {
    const mine = rows.filter(r => r.job === job)
    if (mine.length === 0) { neverRan.push(job); continue }
    const latest = mine.reduce((a, b) => (a.ran_on >= b.ran_on ? a : b))
    if (!latest.ok) failing.push(job)
    // Staleness keys on the last SUCCESSFUL run: a job failing every night is not
    // fresh just because it failed recently.
    if (!mine.some(r => r.ok && r.ran_on >= opts.freshCutoff)) stale.push(job)
  }

  const broken = new Set<string>([...neverRan, ...stale, ...failing])
  return {
    declared: declared.length,
    configured: opts.configured,
    // A scheduler with no secret cannot be operational however good the rows look —
    // those rows would be history from before the secret was removed.
    operational: opts.configured && broken.size === 0,
    neverRan, stale, failing,
    customerImpacting: CUSTOMER_FACING_JOBS.filter(j => broken.has(j)),
  }
}

/**
 * Should this response be recorded, and what verdict does it carry?
 *
 * Pulled out of the wrapper because it is the whole risk surface — everything else
 * there is plumbing — and because a decision this load-bearing should be testable
 * without a database, a network or a Next runtime. scripts/verify-cron.ts pins every
 * branch of it.
 *
 * `ok` is the job's OWN verdict, not merely its status code: signals and engine
 * report a partially-failed night as `{ok: false}` behind an HTTP 200 on purpose —
 * the work that could be done was done and is durable, and a 500 would ask the
 * scheduler to treat a mostly-good night as a broken deploy. Both halves count, so a
 * job cannot be recorded as healthy by returning 200 while saying it failed.
 */
export function sweepVerdict(
  status: number,
  body: Record<string, unknown> | null,
): { record: boolean; ok: boolean; error: string | null } {
  // Unauthenticated: no row, deliberately. A stranger must not be able to fill this
  // table, and a cron that cannot authenticate must leave the ABSENCE that /api/health
  // reads as "declared but dead".
  if (status === 401 || status === 403) return { record: false, ok: false, error: null }
  const httpOk = status >= 200 && status < 300
  const selfReportedOk = body && typeof body.ok === 'boolean' ? body.ok : true
  return {
    record: true,
    ok: httpOk && selfReportedOk,
    error: body && typeof body.error === 'string' ? body.error : null,
  }
}

/**
 * Wrap a cron handler so it files a heartbeat, whatever it returns.
 *
 * BEHAVIOUR-PRESERVING BY CONSTRUCTION, which is the entire point of doing it out
 * here rather than editing twelve routes' control flow:
 *   • The handler's own NextResponse is returned UNTOUCHED. The body is read from
 *     `res.clone()`, so nothing downstream sees a consumed stream.
 *   • A throw is recorded and then RE-THROWN, so Next's onRequestError still hands
 *     it to Sentry and the route still fails exactly as it did.
 *   • 401/403 writes nothing (see the note at the top of this file).
 *
 * The verdict itself is sweepVerdict's, above.
 */
export function withCronSweep(
  job: CronJob,
  handler: (req: NextRequest) => Promise<NextResponse>,
  countsFrom?: CountsFrom,
): (req: NextRequest) => Promise<NextResponse> {
  return async (req: NextRequest): Promise<NextResponse> => {
    const started = Date.now()
    const requestId = req.headers.get('x-vercel-id')

    let res: NextResponse
    try {
      res = await handler(req)
    } catch (e) {
      const sb = serviceClient()
      if (sb) await recordSweep(sb, job, { ok: false, ms: Date.now() - started, error: e instanceof Error ? e.message : String(e), requestId })
      throw e   // the route fails exactly as it did — this only observes
    }

    // Cheap check first: an unauthenticated request must cost neither a client nor a
    // body read.
    if (res.status === 401 || res.status === 403) return res

    const sb = serviceClient()
    // No service key is the one failure the heartbeat can never record, because
    // writing the row needs the client we don't have. The routes that care already
    // say so on their own console line.
    if (!sb) return res

    // `clone()` so the caller's response body is never consumed. A non-JSON or
    // empty body is not a failure — it just means no counters and no verdict
    // beyond the status code.
    const body = await res.clone().json().catch(() => null) as Record<string, unknown> | null
    const verdict = sweepVerdict(res.status, body)
    if (!verdict.record) return res

    await recordSweep(sb, job, {
      ok: verdict.ok,
      ms: Date.now() - started,
      error: verdict.error,
      requestId,
      ...(body && countsFrom ? countsFrom(body) : {}),
    })
    return res
  }
}
