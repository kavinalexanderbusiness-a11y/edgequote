import { NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'

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

  const down = !checks.database.ok
  const degraded = !checks.config.ok || stripeKeyOnly

  return NextResponse.json(
    {
      status: down ? 'down' : degraded ? 'degraded' : 'ok',
      // Lets you tell "the deploy is old" from "the deploy is broken" — the two
      // get confused constantly during an incident.
      commit: process.env.VERCEL_GIT_COMMIT_SHA?.slice(0, 7) ?? 'local',
      env: process.env.VERCEL_ENV ?? 'local',
      checks,
      capabilities: {
        payments: stripe,
        payments_webhook: !!process.env.STRIPE_WEBHOOK_SECRET,
        email,
        sms,
        cron,
        maps,
        ...(stripeKeyOnly ? { warning: 'STRIPE_SECRET_KEY set without STRIPE_WEBHOOK_SECRET — AutoPay will refuse to charge' } : {}),
      },
      ms: Date.now() - started,
    },
    {
      status: down ? 503 : 200,
      // A cached health check reports the past. Never let anything store this.
      headers: { 'Cache-Control': 'no-store, max-age=0' },
    },
  )
}
