// ── Sentry: server + edge ────────────────────────────────────────────────────
// Next calls register() once per runtime at boot. This covers API routes, server
// components, cron routes and the Stripe webhook — everything that isn't the
// browser.
//
// BEHAVIOUR IS UNCHANGED, deliberately:
//  • With no SENTRY_DSN set, Sentry.init() is inert — it initialises and reports
//    nothing. So this is a no-op in any environment that hasn't opted in, which
//    includes local dev and CI. Nothing to guard, nothing to break.
//  • onRequestError only OBSERVES. It never swallows, rethrows or transforms —
//    the error continues to whatever handler would have received it, and every
//    route returns exactly the status it returned before.

import * as Sentry from '@sentry/nextjs'
import { scrubEvent, isIgnorable } from '@/lib/observability/scrub'

export async function register() {
  const dsn = process.env.SENTRY_DSN
  if (!dsn) return   // not configured → stay completely out of the way

  const common = {
    dsn,
    environment: process.env.VERCEL_ENV ?? 'development',
    // Ties an issue to the exact deploy that caused it — the first question in
    // any incident is "did we just ship this?".
    release: process.env.VERCEL_GIT_COMMIT_SHA,

    // NEVER. This app handles customer addresses, phone numbers and payment
    // records; default PII would sweep IPs, headers and request bodies straight
    // into a third party. Everything we want is available without it.
    sendDefaultPii: false,

    // Errors are cheap and rare — take all of them.
    sampleRate: 1.0,
    // Traces are neither. 10% in production is enough to see a slow route without
    // paying for every cron tick; off elsewhere.
    tracesSampleRate: process.env.VERCEL_ENV === 'production' ? 0.1 : 0,

    beforeSend: (event: Parameters<NonNullable<Sentry.NodeOptions['beforeSend']>>[0]) => {
      const msg = event.exception?.values?.[0]?.value ?? event.message ?? ''
      if (isIgnorable(msg)) return null
      return scrubEvent(event)
    },
    beforeSendTransaction: (event: Parameters<NonNullable<Sentry.NodeOptions['beforeSendTransaction']>>[0]) => scrubEvent(event),
  }

  if (process.env.NEXT_RUNTIME === 'nodejs') {
    Sentry.init(common)
  }
  if (process.env.NEXT_RUNTIME === 'edge') {
    Sentry.init(common)
  }
}

// Next hands us every error thrown by a route/component. Sentry's own helper
// forwards it — it does not intercept the response. This is what gives us API
// route coverage without wrapping a single handler by hand (and therefore without
// any chance of changing what a handler returns).
export const onRequestError = Sentry.captureRequestError
