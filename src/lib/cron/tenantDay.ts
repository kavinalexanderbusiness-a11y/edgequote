// ── The date contract BETWEEN two crons ─────────────────────────────────────
//
// `cron/signals` (the producer, 11:00 UTC) writes `automation_signals.detected_on`
// under each tenant's OWN calendar date. `cron/engine` (the consumer, 11:30 UTC)
// reads those rows back. Both halves of that handshake live here so they cannot
// drift apart — the first version of this fix moved the producer alone and left
// the consumer matching on the server's date, which reads ZERO rows for exactly
// the tenants the fix exists to serve, with no error and no log line.
//
// ⛔ WHY A LIB AND NOT AN EXPORT FROM THE ROUTE. A Next App Router `route.ts` may
// only export HTTP handlers and a small set of recognised config values; an
// arbitrary named export is not part of that contract and is subject to Next's
// route typegen. Shared logic belongs in a pure module both routes import — which
// is also the only shape a guard can drive directly.
//
// ⭐⭐ THE HARD CASE IS NOT THE TIME ZONE — IT IS THE TWO INSTANTS.
// Giving the consumer per-tenant dates is necessary and NOT sufficient. The two
// crons capture different instants thirty minutes apart, so a tenant whose local
// midnight falls in that gap gets date D from the producer and D+1 from the
// consumer. Both are correctly "that tenant's today"; they are simply not the
// same day. A consumer that matches only its own date still drops those rows.
//
// Real example — Pacific/Chatham, UTC+12:45:
//   11:00 UTC → 23:45 local, day D      → producer writes detected_on = D
//   11:30 UTC → 00:15 local, day D+1    → consumer's own date is D+1
// Equality on per-tenant dates loses the row. The consumer must accept the small,
// bounded set of dates the producer could have stamped.

import { safeTimeZone, tenantDateISO, addDaysISO } from '@/lib/tenantTime'

/**
 * THE producer's date for one tenant. Both crons derive tenant dates through
 * this one function so "what day is it for this business" has a single answer.
 */
export function ownerDateISO(timezone: string | null | undefined, instant: Date): string {
  return tenantDateISO(safeTimeZone(timezone), instant)
}

/**
 * How far back a consumer must look to cover the producing sweep.
 *
 * ⭐ Derived from the SCHEDULE, not guessed: vercel.json runs signals at
 * `0 11 * * *` and engine at `30 11 * * *` — a 30-minute gap. 90 minutes gives
 * 3× slack for a slow sweep or a retried run while staying far below the 24 hours
 * that would start pulling in a genuinely older day.
 *
 * ⛔ This is a LOOKBACK, not a window width. It never reaches back a whole day, so
 * it cannot resurrect yesterday's signals on an ordinary run — see
 * `signalDatesFor`, which returns ONE date whenever no local midnight fell inside
 * the lookback. Widening this to ≥24h would make every signal eligible twice and
 * silently double the evaluation log.
 */
export const PRODUCER_LOOKBACK_MS = 90 * 60 * 1000

/**
 * The `detected_on` values a consumer must accept for ONE tenant.
 *
 * Exactly one date on an ordinary run. Two — and only two — when a local midnight
 * fell inside the lookback, which is precisely when the producer stamped the
 * earlier day. Nothing is widened for tenants that did not straddle, so an
 * ordinary tenant's signals are still read on exactly one run.
 */
export function signalDatesFor(
  timezone: string | null | undefined,
  now: Date,
  lookbackMs: number = PRODUCER_LOOKBACK_MS,
): string[] {
  const zone = safeTimeZone(timezone)
  const nowDate = tenantDateISO(zone, now)
  const backDate = tenantDateISO(zone, new Date(now.getTime() - lookbackMs))
  return backDate === nowDate ? [nowDate] : [backDate, nowDate]
}

/**
 * The `detected_on` values worth asking the DATABASE for, across all tenants.
 *
 * ⭐ A prefilter, not the decision. Every real zone is within ±14 hours of UTC, so
 * a tenant's calendar date is always the server's date ±1 — three values, which
 * keeps the read bounded and indexed instead of scanning the table. The per-tenant
 * decision is still made by `acceptTenantSignals` once each row's zone is known;
 * this only avoids fetching days nobody could possibly be on.
 */
export function serverDateWindow(now: Date): string[] {
  const mid = tenantDateISO('UTC', now)
  return [addDaysISO(mid, -1), mid, addDaysISO(mid, 1)]
}

/**
 * Keep only the rows whose `detected_on` is one their own tenant could be on now.
 *
 * ⭐⭐ THIS IS THE CONSUMER'S ACTUAL SELECTION RULE, in a pure function, so it can
 * be driven directly by a test with real fixtures rather than asserted about from
 * a distance. `cron/engine` calls this and does nothing else to choose rows.
 *
 * A tenant with no zone on record resolves through `safeTimeZone` to the shared
 * fallback — the same policy the producer used when it stamped the row, so the two
 * halves agree about an unset zone as well as a set one.
 */
export function acceptTenantSignals<T extends { user_id: string; detected_on: string }>(
  rows: readonly T[],
  zones: ReadonlyMap<string, string>,
  now: Date,
  lookbackMs: number = PRODUCER_LOOKBACK_MS,
): T[] {
  const allowed = new Map<string, string[]>()
  return rows.filter(r => {
    let dates = allowed.get(r.user_id)
    if (!dates) {
      dates = signalDatesFor(zones.get(r.user_id) ?? null, now, lookbackMs)
      allowed.set(r.user_id, dates)
    }
    return dates.includes(r.detected_on)
  })
}
