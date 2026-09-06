// ── Sentry: browser ──────────────────────────────────────────────────────────
// Loaded on every page, INCLUDING the two public ones — /portal/<token> and
// /book/<token>. That is exactly why the scrubbing in lib/observability/scrub is
// not optional: those URLs are credentials, and this runtime is the one that sees
// them in navigation, breadcrumbs and fetch spans.
//
// Uses NEXT_PUBLIC_SENTRY_DSN because a browser DSN must be in the bundle. A
// Sentry DSN is designed to be public (it can only submit events, not read them),
// which is why this is safe and the server DSN is kept separate.

import { scrubEvent, isIgnorable } from '@/lib/observability/scrub'

type RouterTransitionStart = typeof import('@sentry/nextjs')['captureRouterTransitionStart']
let captureRouterTransitionStart: RouterTransitionStart | undefined

// next.config supplies an explicit empty value when unconfigured, so this branch
// and its SDK dependency disappear from the browser build. Keep the configured
// load synchronous: monitoring must be ready before hydration and navigation.
if (process.env.NEXT_PUBLIC_SENTRY_DSN) {
  const Sentry: typeof import('@sentry/nextjs') = require('@sentry/nextjs')
  Sentry.init({
    dsn: process.env.NEXT_PUBLIC_SENTRY_DSN,
    environment: process.env.NEXT_PUBLIC_VERCEL_ENV ?? 'development',
    release: process.env.NEXT_PUBLIC_VERCEL_GIT_COMMIT_SHA,

    // Same rule as the server: this app shows people their invoices. No PII.
    sendDefaultPii: false,

    sampleRate: 1.0,
    tracesSampleRate: process.env.NEXT_PUBLIC_VERCEL_ENV === 'production' ? 0.1 : 0,

    // Session Replay is deliberately OFF. It records the DOM — on a page that
    // displays a customer's address, invoice totals and payment history. Turning
    // it on is a privacy decision for the owner to make knowingly, not a default
    // for an observability task to slip in.
    replaysSessionSampleRate: 0,
    replaysOnErrorSampleRate: 0,

    // Browser extensions and injected scripts generate errors we can neither
    // reproduce nor fix; they only bury the real ones.
    ignoreErrors: [
      'top.GLOBALS', 'chrome-extension://', 'moz-extension://',
      'Failed to fetch', 'NetworkError', 'Load failed',   // offline users, not bugs
    ],

    beforeSend: event => {
      const msg = event.exception?.values?.[0]?.value ?? event.message ?? ''
      if (isIgnorable(msg)) return null
      return scrubEvent(event)
    },
    beforeSendTransaction: event => scrubEvent(event),
    // Breadcrumbs record every navigation — i.e. every portal token — so they get
    // the same treatment as events rather than being trusted.
    beforeBreadcrumb: crumb => {
      if (crumb.data?.url && typeof crumb.data.url === 'string') {
        crumb.data.url = scrubEvent({ request: { url: crumb.data.url } }).request!.url
      }
      return crumb
    },
  })
  captureRouterTransitionStart = Sentry.captureRouterTransitionStart
}

// Next always receives a callable hook; unconfigured builds do no SDK work.
export const onRouterTransitionStart: RouterTransitionStart = (...args) => captureRouterTransitionStart?.(...args)
