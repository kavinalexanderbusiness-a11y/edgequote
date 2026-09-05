'use client'

import { useEffect } from 'react'
import { AlertTriangle, RotateCw, LayoutDashboard } from 'lucide-react'
import { Button, ButtonLink } from '@/components/ui/Button'
import { PageContainer } from '@/components/layout/PageContainer'
import { Card } from '@/components/ui/Card'

// The boundary for every page under /dashboard. Without it a throw fell through
// to Next's bare "Application error" page — no sidebar, no way back. It says only
// what it knows: the page did not load. The thrown message is never rendered
// (it may be a driver or provider string); the digest Next attaches to a
// server-side throw is safe to quote and identifies the failure in the log.
export default function DashboardError({
  error, reset,
}: { error: Error & { digest?: string }; reset: () => void }) {
  useEffect(() => { console.error('[dashboard]', error) }, [error])

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
              We could not load this page. Try again, or return to your dashboard.
            </p>
            <div className="flex flex-wrap items-center gap-2 mt-4">
              <Button onClick={reset}><RotateCw className="w-4 h-4" /> Try again</Button>
              <ButtonLink href="/dashboard" variant="secondary"><LayoutDashboard className="w-4 h-4" /> Go to your dashboard</ButtonLink>
            </div>
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
