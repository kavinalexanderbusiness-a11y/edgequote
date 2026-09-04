'use client'

// ── The Growth visual fixture ─────────────────────────────────────────────────
//
// ⭐⭐ WHAT MAKES THIS A PROOF AND NOT A MOCK-UP. The screen below is drawn by
// the SHIPPING view — `RevenueIntelligenceView`, imported from where the
// dashboard page imports it — over a report produced by the SHIPPING engine
// (`computeRevenueIntel`, see fixtureData.ts). Nothing here re-implements a
// tile, a card, a sentence or a figure. If the view changes, this page changes
// with it; if someone reverts the honesty fixes, this page shows the defects.
//
// The only things faked are the WIRE and the SHELL:
//   • `window.fetch` is replaced by a deny-by-default stub that records every
//     attempt and refuses it. Only Next's own same-origin dev traffic under
//     /_next/ passes through — that is the framework, not the fixture. The
//     violation count is rendered so the CDP run can assert on it: a run that
//     quietly reached a network cannot pass.
//   • The dashboard shell is not mounted (it needs a session); its GEOMETRY is.
//     The same gutters (`p-4 pb-28 lg:p-8`), the same `overflow-auto` main and
//     the same 15rem sidebar reservation at `lg`, taken from
//     src/app/dashboard/layout.tsx and components/layout/Sidebar.tsx, so the
//     content column here is exactly as wide as on the real page at every width.
//
// ⛔ No Supabase client, no credential, no cache, no request. `onAct` and
// `onRefresh` only record that they fired; nothing is written anywhere.

import { useEffect, useMemo, useState } from 'react'
import { RevenueIntelligenceView } from '@/app/dashboard/revenue-intelligence/RevenueIntelligenceView'
import { buildFixture, SCENARIOS, FIXTURE_TODAY } from './fixtureData'

type Violation = { method: string; url: string }

function installFetchStub(onViolation: (v: Violation) => void) {
  if (typeof window === 'undefined') return
  const w = window as Window & { __growthFixtureFetch?: boolean }
  if (w.__growthFixtureFetch) return
  w.__growthFixtureFetch = true
  const real = window.fetch.bind(window)
  window.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
    const method = (init?.method || (input instanceof Request ? input.method : 'GET')).toUpperCase()
    const nextOwn = url.startsWith('/_next/') || url.startsWith('/__nextjs') || url.startsWith(`${window.location.origin}/_next/`)
    if (nextOwn) return real(input, init)
    // ⛔ EVERYTHING ELSE IS REFUSED, LOUDLY. Recorded first so the page shows it
    // even though the throw stops the caller.
    onViolation({ method, url })
    throw new Error(`growth visual fixture: refusing a real request to ${method} ${url}`)
  }
}

export function GrowthVisualFixture() {
  const [violations, setViolations] = useState<Violation[]>([])
  const [fired, setFired] = useState<string[]>([])
  const [ready, setReady] = useState(false)

  // Installed during the first render, before any child can mount an effect.
  useState(() => { installFetchStub(v => setViolations(p => [...p, v])); return null })
  const { report, feedback } = useMemo(() => buildFixture(), [])
  useEffect(() => { setReady(true) }, [])

  return (
    <div className="min-h-screen bg-bg text-ink">
      <header className="border-b border-border px-4 py-3 text-xs text-ink-muted space-y-1">
        <h1 className="text-sm font-bold text-ink">Growth visual fixture</h1>
        <p>Shipping view, shipping engine, synthetic rows dated {FIXTURE_TODAY}. No database, no session, no credential.</p>
        {/* ⭐ The safety readouts the CDP run asserts on. "0" is the claim that
            nothing left this page and nothing was recorded; anything else is
            named, in red, on the page itself. */}
        <p id="fixture-network" data-count={violations.length}>
          network violations: <span className="font-bold tabular-nums">{violations.length}</span>
          {violations.map((v, i) => <span key={i} className="block text-red-400">{v.method} {v.url}</span>)}
        </p>
        <p id="fixture-actions" data-count={fired.length}>
          actions fired: <span className="font-bold tabular-nums">{fired.length}</span>
          {fired.length > 0 && <span className="text-red-400"> ({fired.join(', ')})</span>}
        </p>
        <p id="fixture-ready" data-ready={ready ? '1' : '0'} className="sr-only">{ready ? 'ready' : 'mounting'}</p>
        <details>
          <summary className="cursor-pointer">What to look for</summary>
          <ol className="list-decimal pl-5 space-y-0.5 mt-1">
            {SCENARIOS.map(s => <li key={s.id} id={`expect-${s.id}`}>{s.expect}</li>)}
          </ol>
        </details>
      </header>

      {/* Shell GEOMETRY only — see the header comment for where each class comes from. */}
      <div className="lg:flex">
        <div aria-hidden="true" className="hidden lg:block w-60 shrink-0" />
        <main id="fixture-main" className="flex-1 min-w-0 p-4 pb-28 lg:p-8 bg-bg overflow-auto">
          <RevenueIntelligenceView
            report={report}
            feedback={feedback}
            busy={null}
            onAct={(o, status) => setFired(p => [...p, `${status}:${o.key}`])}
            onRefresh={() => setFired(p => [...p, 'refresh'])}
          />
        </main>
      </div>
    </div>
  )
}
