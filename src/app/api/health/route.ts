import { NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'
import { classifyCronHealth, STALE_AFTER_DAYS, type CronVerdict } from '@/lib/cron/heartbeat'
import { appOrigin, isUsableOrigin } from '@/lib/appOrigin'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

// ── Health check ─────────────────────────────────────────────────────────────
// One endpoint that answers "is this deploy actually working?" — for an uptime
// monitor, for the post-deploy smoke test, and for a human at 7am wondering why
// a customer says the portal is broken.
//
// DESIGN RULES, learned the hard way in this codebase:
//  • It must FAIL when the app is broken. A health check that always returns 200
//    is worse than none: it converts an outage into a silent one. So the database
//    is actually queried, not merely configured-check'd.
//  • It must not leak. No keys, no values, no row contents, no error strings from
//    the database (those can carry schema detail). Booleans and durations only.
//  • It must be cheap and unauthenticated — a monitor can't hold a session, and a
//    check that costs real work becomes a self-inflicted load test at 1-minute
//    intervals. The query below is `limit 1` against one narrow column.
//  • Degraded ≠ down. Payments/comms being unconfigured is a real state worth
//    reporting, but it is not an outage — it must not page anyone at 3am.
//
// 200 = ok | degraded. 503 = down (the database is unreachable).
// A monitor should alert on the STATUS CODE; a human reads the body.

interface Check { ok: boolean; ms?: number; detail?: string }

/** What this endpoint reports about the scheduler: the pure verdict, plus the two
 *  facts only the query knows. `readable: false` means the run log could not be
 *  read at all — a question unanswered, never an answer of "nothing ran". */
type CronReport = CronVerdict & { readable: boolean; lastRunAt: string | null }

/** Read the cron heartbeat and report whether the scheduled jobs are actually
 *  running. Cheap: `automation_sweeps` holds one row per job per day and this reads
 *  a few days of it. Never throws — health must survive its own diagnostics.
 *
 *  The DECISION lives in lib/cron/heartbeat's classifyCronHealth, which is pure and
 *  pinned by verify:cron. All that happens here is the select. */
async function cronHealth(url: string | undefined, serviceKey: string | undefined, configured: boolean): Promise<CronReport> {
  const freshCutoff = new Date(Date.now() - STALE_AFTER_DAYS * 86_400_000).toISOString().slice(0, 10)
  // Unknown: report the shape, claim nothing. `operational: false` is the honest
  // default — answering "yes" for a log that was never read is the same always-200
  // failure this file's header warns about, one level down.
  const unknown = (): CronReport => ({
    ...classifyCronHealth([], { configured, freshCutoff }),
    neverRan: [], stale: [], failing: [], customerImpacting: [],
    operational: false, readable: false, lastRunAt: null,
  })

  // Only the service role can read this table's run counts (the owner-facing columns
  // are granted separately). No key → the config check already reports it; don't
  // guess at liveness we cannot see.
  if (!url || !serviceKey) return unknown()

  const since = new Date(Date.now() - (STALE_AFTER_DAYS + 5) * 86_400_000).toISOString().slice(0, 10)
  let rows: { job: string; ok: boolean; ran_on: string; ran_at: string }[]
  try {
    const sb = createClient(url, serviceKey)
    const timeout = new Promise<null>(r => setTimeout(() => r(null), TIMEOUT_MS))
    const query = sb.from('automation_sweeps').select('job, ok, ran_on, ran_at').gte('ran_on', since)
      .then(({ data, error }) => (error ? null : (data as typeof rows | null) ?? []))
    const out = await Promise.race([query, timeout])
    if (out === null) return unknown()
    rows = out
  } catch {
    return unknown()
  }

  return {
    ...classifyCronHealth(rows, { configured, freshCutoff }),
    readable: true,
    lastRunAt: rows.length ? rows.reduce((a, b) => (a.ran_at >= b.ran_at ? a : b)).ran_at : null,
  }
}

// Comfortably above a healthy round trip (~250ms warm, ~1.3s cold) and well
// under the 5s an uptime monitor typically allows, so our 503 is what gets
// recorded rather than the monitor's own timeout.
const TIMEOUT_MS = 3000

export async function GET() {
  const started = Date.now()
  const checks: Record<string, Check> = {}

  // ── Config: are the env vars this deploy needs actually present? ───────────
  // Presence only. Never report a value, a length, or a prefix — those are the
  // breadcrumbs that make a leaked log useful to someone else.
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const anon = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY
  const service = process.env.SUPABASE_SERVICE_ROLE_KEY
  checks.config = {
    ok: !!(url && anon && service),
    detail: [!url && 'supabase url', !anon && 'anon key', !service && 'service key']
      .filter(Boolean).join(', ') || undefined,
  }

  // ── Database: the one check that can declare an outage ─────────────────────
  // Reads one narrow column with limit 1. Chosen because business_settings is
  // tiny, always present, and touched by every real request — if this fails, the
  // app is down for everyone, not just for one feature.
  if (url && anon) {
    const t = Date.now()
    try {
      const sb = createClient(url, anon)
      // BOUNDED ON PURPOSE. Measured: against an unreachable host, supabase-js
      // takes ~7s to give up. A health check that hangs that long during an
      // outage is a liability — a monitor with a 5s timeout records "timeout"
      // instead of reading our 503, so the one request that could have said
      // WHAT was wrong never gets read. Fail fast and say so.
      const timeout = new Promise<'timeout'>(r => setTimeout(() => r('timeout'), TIMEOUT_MS))
      const query = sb.from('business_settings').select('user_id').limit(1).then(({ error }) => error ? 'error' : 'ok')
      const outcome = await Promise.race([query, timeout])
      checks.database = outcome === 'ok'
        ? { ok: true, ms: Date.now() - t }
        // Both messages are deliberately generic: a PostgREST error can name
        // columns and constraints, and this endpoint is public.
        : { ok: false, ms: Date.now() - t, detail: outcome === 'timeout' ? `no response in ${TIMEOUT_MS}ms` : 'query failed' }
    } catch {
      checks.database = { ok: false, ms: Date.now() - t, detail: 'unreachable' }
    }
  } else {
    checks.database = { ok: false, detail: 'not configured' }
  }

  // ── Capabilities: configured or not. Never an outage. ─────────────────────
  // These mirror what the app itself checks before trying to charge or send, so
  // "why did no reminders go out last night?" is answerable in one request.
  const stripe = !!(process.env.STRIPE_SECRET_KEY && process.env.STRIPE_WEBHOOK_SECRET)
  const email = !!(process.env.RESEND_API_KEY && process.env.RESEND_FROM)
  const sms = !!(process.env.TWILIO_ACCOUNT_SID && process.env.TWILIO_AUTH_TOKEN && process.env.TWILIO_FROM)
  const cron = !!process.env.CRON_SECRET
  const maps = !!process.env.GOOGLE_MAPS_API_KEY

  // AutoPay refuses to charge without the webhook secret — money is never taken
  // with no path to mark the invoice paid. Surface that specific half-configured
  // state, because "Stripe is on" would be a lie that costs the owner money.
  const stripeKeyOnly = !!process.env.STRIPE_SECRET_KEY && !process.env.STRIPE_WEBHOOK_SECRET

  // Same shape, and the one this endpoint was missing. vercel.json DECLARES the
  // scheduled jobs, and Vercel runs them against this deploy — but cronSecretOk()
  // opens with `if (!expected) return false`, so with CRON_SECRET absent EVERY
  // cron 403s on every run: reminders, quote follow-ups, AutoPay charges, reports.
  // Not an optional capability switched off — a declared part of the deploy that
  // cannot work, silently, forever. `cron: false` sitting inside a body that says
  // "ok" is exactly the always-200 health check this file's own header warns
  // against, so it degrades. Production only: a local run has no cron scheduler,
  // and degrading there would train everyone to ignore the word.
  const cronsDeclaredButUnusable = process.env.VERCEL_ENV === 'production' && !cron

  // …and the failure the line above CANNOT see. A missing secret is knowable from
  // the environment; a job that authenticates fine and has quietly stopped running
  // is only knowable from its run log. Both end in "the reminders aren't going
  // out", and an endpoint that catches the first and not the second would go green
  // the moment CRON_SECRET is set, whatever the crons then do.
  //
  // Scoped to production for the same reason as above, and deliberately only when
  // the secret EXISTS: with no secret, "no secret" is the precise diagnosis and
  // every job would trivially read as never-run. Say the useful thing, once.
  const crons = await cronHealth(url, service, cron)
  const cronsStopped = process.env.VERCEL_ENV === 'production' && cron && crons.readable && !crons.operational

  // The origin every generated link, every Stripe return URL and every webhook
  // URL we RECONSTRUCT to check a signature is built from. On 2026-08-15 this
  // env var picked up a UTF-8 BOM, which broke Stripe checkout, 403'd every
  // inbound SMS (the signature is computed over the URL) and silently dropped
  // the SMS status callback — three different directions of failure, so no
  // single symptom ever pointed back at the variable.
  //
  // Configured but unusable = every link this deploy sends is broken. That is an
  // outage, and it degrades. Production only, for the same reason as the crons:
  // a local run legitimately has no origin configured, and degrading there would
  // train everyone to ignore the word.
  //
  // Note the asymmetry with the BOM: cleanOrigin REPAIRS a value that merely
  // picked something up in transit, so that case is not an outage and does not
  // degrade — app_url_raw is what exposes it. This catches the value cleaning
  // cannot rescue: a host with no scheme, or something that is not a URL at all.
  const appOriginUnusable = process.env.VERCEL_ENV === 'production'
    && !!process.env.NEXT_PUBLIC_APP_URL?.trim()
    && !isUsableOrigin(process.env.NEXT_PUBLIC_APP_URL)

  const down = !checks.database.ok
  const degraded = !checks.config.ok || stripeKeyOnly || cronsDeclaredButUnusable || cronsStopped || appOriginUnusable

  return NextResponse.json(
    {
      status: down ? 'down' : degraded ? 'degraded' : 'ok',
      // Lets you tell "the deploy is old" from "the deploy is broken" — the two
      // get confused constantly during an incident.
      commit: process.env.VERCEL_GIT_COMMIT_SHA?.slice(0, 7) ?? 'local',
      env: process.env.VERCEL_ENV ?? 'local',
      // The origin this deploy stamps into every generated link — crew invites,
      // password resets, portal/booking URLs. NEXT_PUBLIC_ = already public, so
      // reporting it leaks nothing, and it makes the failure mode "the domain
      // moved but the env var didn't" (every emailed link 404s, silently)
      // visible from one curl instead of from a confused worker's screenshot.
      //
      // Reported RAW and CLEANED. The raw value is what caught a UTF-8 BOM
      // pasted in by a shell on 2026-08-15 — invisible in every dashboard, and
      // enough to break every link. app_url is what links actually carry.
      app_url: appOrigin() || null,
      app_url_raw: process.env.NEXT_PUBLIC_APP_URL || null,
      ...(appOriginUnusable
        ? { app_url_warning: 'NEXT_PUBLIC_APP_URL is set but is not a usable http(s) origin — every generated link, every Stripe return URL and every signature-checked webhook URL is built from it' }
        : {}),
      checks,
      capabilities: {
        payments: stripe,
        payments_webhook: !!process.env.STRIPE_WEBHOOK_SECRET,
        email,
        sms,
        cron,
        maps,
        ...(stripeKeyOnly ? { warning: 'STRIPE_SECRET_KEY set without STRIPE_WEBHOOK_SECRET — AutoPay will refuse to charge' } : {}),
        ...(cronsDeclaredButUnusable ? { cron_warning: 'CRON_SECRET is not set — every scheduled job in vercel.json is rejected with 403 (no reminders, no follow-ups, no AutoPay, no reports)' } : {}),
      },
      // Which jobs, and whether they are actually running. Reported in every
      // environment even though only production degrades on it: "have these ever
      // run?" is a question worth being able to answer from a preview too.
      crons,
      ms: Date.now() - started,
    },
    {
      status: down ? 503 : 200,
      // A cached health check reports the past. Never let anything store this.
      headers: { 'Cache-Control': 'no-store, max-age=0' },
    },
  )
}
