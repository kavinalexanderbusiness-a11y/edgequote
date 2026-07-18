'use client'

import { useEffect } from 'react'
import { AlertTriangle, RotateCw } from 'lucide-react'
import { Button } from '@/components/ui/Button'
import { PageContainer } from '@/components/layout/PageContainer'
import { Card } from '@/components/ui/Card'

// Without this boundary any throw inside /dashboard fell through to Next's
// built-in one: a bare, unstyled "Application error: a server-side exception has
// occurred" — no sidebar, no nav, no way back. The dev overlay hides that, so it
// would only ever have been seen in production.
//
// It matters most now that loadDashboard THROWS on a failed read instead of
// rendering zeros: "we couldn't load your morning" has to be visible and
// retryable, because the alternative — a calm $0 dashboard — is the one outcome
// the owner must never be shown.
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
            <h1 className="text-base font-bold tracking-tight text-ink">Your dashboard didn&rsquo;t load</h1>
            <p className="text-sm text-ink-muted mt-1">
              Something went wrong fetching this morning&rsquo;s numbers, so we&rsquo;re not showing any —
              a figure we couldn&rsquo;t read is worse than none. Nothing is wrong with your data.
            </p>
            {error.message && (
              <p className="text-xs text-ink-faint mt-2.5 font-mono break-words">{error.message}</p>
            )}
            <div className="flex items-center gap-2 mt-4">
              <Button onClick={reset}><RotateCw className="w-4 h-4" /> Try again</Button>
            </div>
          </div>
        </div>
      </Card>
    </PageContainer>
  )
}
