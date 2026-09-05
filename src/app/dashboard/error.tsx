'use client'

import { useEffect } from 'react'
import * as Sentry from '@sentry/nextjs'
import { AlertTriangle, RotateCw, LayoutDashboard } from 'lucide-react'
import { Button, ButtonLink } from '@/components/ui/Button'
import { PageContainer } from '@/components/layout/PageContainer'
import { Card } from '@/components/ui/Card'

// Without this boundary any throw inside /dashboard fell through to Next's
// built-in one: a bare, unstyled "Application error: a server-side exception has
// occurred" — no sidebar, no nav, no way back. The dev overlay hides that, so it
// would only ever have been seen in production.
//
// It is the boundary for EVERY page under /dashboard — quotes, jobs, customers,
// invoices, settings — not only the home screen, so it speaks about "this page",
// promises nothing it cannot know (it cannot see the data, so it does not vouch
// for it), and never prints the thrown message: a driver or provider string is
// not something a customer-facing screen should relay. The digest Next attaches
// to a server-side throw is safe to show — it identifies the incident in the
// server log without describing it — and it is the one thing worth quoting.
//
// It still matters most for loadDashboard, which THROWS on a failed read instead
// of rendering zeros: "this didn't load" has to be visible and retryable,
// because the alternative — a calm $0 dashboard — is the one outcome the owner
// must never be shown.
export default function DashboardError({
  error, reset,
}: { error: Error & { digest?: string }; reset: () => void }) {
  useEffect(() => {
    console.error('[dashboard]', error)
    // A render or client-side throw under /dashboard is not seen by the server's
    // automatic instrumentation; report it here. No-op when Sentry is not
    // configured — captureException on an uninitialised SDK is safe and silent.
    Sentry.captureException(error)
  }, [error])

  return (
    <PageContainer width="wide">
      <Card className="p-6 sm:p-8 border-amber-500/30 bg-amber-500/[0.04] max-w-xl">
        <div className="flex items-start gap-3.5">
          <span className="w-9 h-9 rounded-lg bg-amber-500/10 border border-amber-500/25 flex items-center justify-center shrink-0">
            <AlertTriangle className="w-4.5 h-4.5 text-amber-400" />
          </span>
          <div className="min-w-0">
            <h1 className="text-base font-bold tracking-tight text-ink">This page didn&rsquo;t load</h1>
            <p className="text-sm text-ink-muted mt-1">
              Something went wrong while loading it, so nothing is shown rather than a figure that couldn&rsquo;t be read.
              Try again, or go back to your dashboard.
            </p>
            <div className="flex flex-wrap items-center gap-2 mt-4">
              <Button onClick={reset}><RotateCw className="w-4 h-4" /> Try again</Button>
              <ButtonLink href="/dashboard" variant="secondary"><LayoutDashboard className="w-4 h-4" /> Go to your dashboard</ButtonLink>
            </div>
            {/* The digest ties this screen to the server log entry for the same
                failure. Shown instead of the message: it identifies, it does not
                describe. */}
            {error.digest && (
              <p className="text-xs text-ink-faint mt-3">
                If this keeps happening, quote reference <span className="font-mono">{error.digest}</span>.
              </p>
            )}
          </div>
        </div>
      </Card>
    </PageContainer>
  )
}
