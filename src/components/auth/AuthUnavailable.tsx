'use client'

import { Button } from '@/components/ui/Button'
import { CloudOff, RefreshCw } from 'lucide-react'

// ── "We couldn't check" — the third answer, given a face ─────────────────────
// What a server gate renders when the auth server could not be reached. It is
// deliberately NOT the login form: nothing here says the session ended, because
// nobody knows that it did. Saying "signed out" when the truth is "unreachable"
// is the lie this whole change exists to stop — the same root class as the
// portal's "couldn't reach the server" once rendering as an answer.
//
// It shows no data and offers no navigation into the app, so an unverifiable
// request still gets exactly nothing. The only action is to ask again.
export function AuthUnavailable({ reason }: { reason?: string }) {
  return (
    <div className="min-h-screen bg-bg flex items-center justify-center px-4">
      <main className="w-full max-w-sm text-center">
        <div className="w-12 h-12 rounded-2xl bg-surface border border-border-strong flex items-center justify-center mx-auto mb-4">
          <CloudOff className="w-6 h-6 text-ink-muted" />
        </div>
        <h1 className="text-lg font-semibold tracking-tight text-ink">Couldn&apos;t reach the server</h1>
        <p className="mt-2 text-sm text-ink-muted">
          We couldn&apos;t confirm your sign-in just now. You have not been signed out —
          this is almost always a brief connection problem.
        </p>
        <Button className="mt-6 w-full" size="lg" onClick={() => window.location.reload()}>
          <RefreshCw className="w-4 h-4" />
          Try again
        </Button>
        {reason && <p className="mt-4 text-xs text-ink-faint">{reason}</p>}
      </main>
    </div>
  )
}
