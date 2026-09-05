// ── The hydrated Customize-sheet fixture page (investigation tool, not a guard) ──
// ONE composition shared by the server render (dashboard-hydrated-harness.tsx)
// and the browser entry (dashboard-hydrated-entry.tsx), so what React hydrates
// is exactly what was rendered: the REAL header action pair as
// app/dashboard/page.tsx composes it — PageHeader + CustomizeDashboard +
// ButtonLink — and the REAL Toaster the dashboard layout mounts once.
//
// Synthetic props only. There is no data path here and no session: the bands
// below the header are deliberately absent (they are server-rendered from the
// one loadDashboard batch and have nothing to do with the sheet's behaviour),
// and the Supabase env the bundle sees is a closed loopback port, so Save can
// only ever reach the "Not signed in" refusal the component already owns.
import React, { useEffect } from 'react'
import { PageHeader } from '../src/components/layout/PageHeader'
import { CustomizeDashboard } from '../src/components/dashboard/CustomizeDashboard'
import { ButtonLink } from '../src/components/ui/Button'
import { Toaster } from '../src/components/ui/Toaster'
import { DEFAULT_DASHBOARD_LAYOUT } from '../src/lib/dashboard/layout'
import { Plus } from 'lucide-react'

// Renders nothing; its effect runs only in the browser, only after React has
// committed the hydrated tree — the prover waits for this attribute before it
// presses a single key, so "the click did nothing" can never mean "not hydrated
// yet".
function HydrationMark() {
  useEffect(() => { document.documentElement.setAttribute('data-hydrated', '1') }, [])
  return null
}

export function App() {
  return (
    <main className="max-w-6xl mx-auto space-y-6 px-4 sm:px-6 py-6">
      <PageHeader title="Good afternoon" description="Thursday, September 4" action={
        <div className="flex items-center gap-2">
          <CustomizeDashboard initial={DEFAULT_DASHBOARD_LAYOUT} />
          <ButtonLink href="/dashboard/quotes/new"><Plus className="w-4 h-4" /> New quote</ButtonLink>
        </div>
      } />
      <p className="text-sm text-ink-muted">
        Hydrated fixture: the Customize control above is the shipping component running under the real React runtime.
        The dashboard bands are omitted on purpose.
      </p>
      <Toaster />
      <HydrationMark />
    </main>
  )
}
