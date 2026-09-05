// ── Only the newest request may commit ──────────────────────────────────────
//
// A list whose SCOPE is chosen on the server — a date range, a status filter —
// refetches when the owner changes it. Those fetches are async and unordered, so
// whichever RESOLVES last wins the state, not whichever was ASKED for last.
//
// ⛔ THE USER-VISIBLE FAILURE, on /dashboard/payments: pick "Last 365 days" (a big,
// slow query), then immediately pick "Last 30 days" (small, fast). The 30-day rows
// arrive and render. A moment later the 365-day response lands and overwrites them.
// The control now reads "Last 30 days" while the table shows a year of payments —
// and the money summary above it, derived from those rows, shows a year's takings
// under a 30-day heading. Nothing looks broken; the number is just wrong.
//
// Four things trigger that fetch — the range control, the realtime subscription,
// saving a deposit, and the Retry button — so any two of them overlapping does it.
//
// ⭐ The gate is a counter, not a cancellation: the in-flight request still
// finishes, it simply may no longer speak. That keeps it independent of the
// transport (no AbortController plumbing through the Supabase client) and works
// the same for every commit point in a handler, including its error branches.

export interface RequestGate {
  /** Claim the newest slot. Call once, at the top of the handler. */
  begin(): number
  /** True only while no later request has begun. Check before EVERY commit. */
  isCurrent(token: number): boolean
}

export function createRequestGate(): RequestGate {
  let current = 0
  return {
    begin: () => ++current,
    // ⛔ Strict equality on the token, not `>=`: a request is current or it is
    // superseded. There is no "close enough" — the whole point is that a stale
    // response has no claim on the screen however recently it was asked for.
    isCurrent: (token: number) => token === current,
  }
}
