'use client'

import { useEffect, useMemo, useState } from 'react'
import { PageContainer } from '@/components/layout/PageContainer'
import { createClient } from '@/lib/supabase/client'
import { loadRevenueIntel, recordRecommendation, RevenueIntelReport, Opportunity, FeedbackRow } from '@/lib/revenueIntelligence'
import { PageHeader } from '@/components/layout/PageHeader'
import { Skeleton, SkeletonTiles, SkeletonRows } from '@/components/ui/Skeleton'
import { readCache, writeCache, CACHE_TTL } from '@/lib/clientCache'
import { RevenueIntelligenceView } from './RevenueIntelligenceView'

// ── Data wiring only ─────────────────────────────────────────────────────────
// Loads the report, records feedback, and hands everything to
// RevenueIntelligenceView (same folder), which owns the entire screen. The
// split exists so the view can also be rendered from synthetic props in
// src/app/dev/growth-visual-fixture — the presentation is NOT duplicated there.

export default function RevenueIntelligencePage() {
  const supabase = useMemo(() => createClient(), [])
  const [report, setReport] = useState<RevenueIntelReport | null>(() => readCache<RevenueIntelReport>('revintel', CACHE_TTL.medium))
  const [feedback, setFeedback] = useState<Record<string, FeedbackRow>>({})
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState<string | null>(null)

  async function load() {
    try {
      const res = await loadRevenueIntel(supabase)
      if (res) { setReport(res.report); setFeedback(res.feedback); writeCache('revintel', res.report) }
    } finally { setLoading(false) }
  }
  useEffect(() => { load() }, []) // eslint-disable-line react-hooks/exhaustive-deps

  // ⭐ `result_value` is seeded from the FORECAST (`o.expectedValue`), not from
  // any invoice/payment evidence — there is no collections feed into this table
  // at all. "Marking won" records the owner's own claim that the play landed;
  // it does not verify what was actually charged or collected. Kept exactly as
  // the forecast on purpose (a "how much did they actually pay" flow would be a
  // different, real-money feature — invoicing/payments own that, not this
  // advisor), but every surface reading this value must say "marked won", never
  // "revenue" or "collected". See the `wonValue` tile in RevenueIntelligenceView.
  async function act(o: Opportunity, status: 'acted' | 'dismissed' | 'won') {
    setBusy(o.key)
    setFeedback(prev => ({ ...prev, [o.key]: { opportunity_key: o.key, kind: o.kind, status, expected_value: o.expectedValue, result_value: status === 'won' ? o.expectedValue : null } }))
    await recordRecommendation(supabase, o, status, status === 'won' ? o.expectedValue : undefined)
    setBusy(null)
  }

  if (loading && !report) {
    return (
      <PageContainer>
        <PageHeader crumb={{ label: 'Grow', href: '/dashboard/grow' }} title="Who to call next" description="Every customer scored for the moves that grow revenue — ranked by expected impact." />
        <SkeletonTiles count={4} />
        <Skeleton className="h-20 w-full rounded-card" />
        <SkeletonRows count={5} />
      </PageContainer>
    )
  }
  // A failed load must not render a literally blank page — say so, offer retry.
  if (!report) return (
    <PageContainer width="wide">
      <PageHeader crumb={{ label: 'Grow', href: '/dashboard/grow' }} title="Who to call next" />
      <p className="text-sm text-ink-muted">
        Could not load revenue intelligence — check your connection and{' '}
        <button type="button" onClick={() => window.location.reload()} className="text-accent-text underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 rounded">try again</button>.
      </p>
    </PageContainer>
  )

  return <RevenueIntelligenceView report={report} feedback={feedback} busy={busy} onAct={act} onRefresh={load} />
}
