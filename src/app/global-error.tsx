'use client'

// ── Last-resort error boundary ───────────────────────────────────────────────
// Catches render errors that escape every other boundary — the "white screen"
// class. Deliberately minimal: no data fetching, no shared components, no design
// tokens — this file must render when the app itself is broken. It promises
// only what it knows: captureException is a silent no-op without a DSN, so it
// does not claim anyone was told; it cannot see what was on screen, so it does
// not claim nothing was lost. The digest identifies the failure in the log.

import * as Sentry from '@sentry/nextjs'
import { useEffect } from 'react'

export default function GlobalError({ error, reset }: {
  error: Error & { digest?: string }
  reset: () => void
}) {
  useEffect(() => {
    // No-op when Sentry isn't configured — captureException on an uninitialised
    // SDK is safe and silent.
    Sentry.captureException(error)
  }, [error])

  return (
    <html lang="en">
      <body style={{
        margin: 0, minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center',
        background: '#0E1116', color: '#E6EAF0', padding: '24px',
        fontFamily: "system-ui, 'Segoe UI', Arial, sans-serif",
      }}>
        <div style={{ maxWidth: 420, textAlign: 'center' }}>
          <h1 style={{ fontSize: 18, fontWeight: 700, margin: '0 0 8px' }}>Something went wrong</h1>
          <p style={{ fontSize: 14, lineHeight: 1.6, color: '#9AA4B2', margin: '0 0 20px' }}>
            We could not show this page. Try again, or return to your dashboard.
          </p>
          <div style={{ display: 'flex', gap: 10, justifyContent: 'center', flexWrap: 'wrap' }}>
            <button
              onClick={reset}
              style={{
                background: '#0B8C68', color: '#fff', border: 0, borderRadius: 10,
                padding: '10px 18px', fontSize: 14, fontWeight: 600, cursor: 'pointer',
              }}
            >
              Try again
            </button>
            {/* A plain anchor: a full navigation with no dependency on the failed tree. */}
            <a
              href="/dashboard"
              style={{
                display: 'inline-block', background: 'transparent', color: '#E6EAF0',
                border: '1px solid #2A313B', borderRadius: 10, padding: '10px 18px',
                fontSize: 14, fontWeight: 600, textDecoration: 'none',
              }}
            >
              Go to your dashboard
            </a>
          </div>
          {error.digest && (
            <p style={{ fontSize: 11, color: '#5B6672', marginTop: 16 }}>
              If this keeps happening, quote reference {error.digest}.
            </p>
          )}
        </div>
      </body>
    </html>
  )
}
