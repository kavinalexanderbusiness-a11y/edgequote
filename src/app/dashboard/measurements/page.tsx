'use client'

import { useEffect, useState } from 'react'
import { createClient } from '@/lib/supabase/client'
import { measurementStats, MeasureStats } from '@/lib/autoMeasure'
import { PageHeader } from '@/components/layout/PageHeader'
import { Card, CardBody } from '@/components/ui/Card'
import { StatTile } from '@/components/ui/StatTile'
import { EmptyState, InlineEmpty } from '@/components/ui/EmptyState'
import { SkeletonTiles } from '@/components/ui/Skeleton'
import { Ruler, TrendingUp, Target, MapPin, Gauge } from 'lucide-react'

export default function MeasurementsPage() {
  const [stats, setStats] = useState<MeasureStats | null>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    (async () => {
      const supabase = createClient()
      const { data: { session } } = await supabase.auth.getSession()
      const user = session?.user
      if (user) setStats(await measurementStats(supabase, user.id))
      setLoading(false)
    })()
  }, [])

  const meaningful = (stats?.byNeighborhood || []).filter(h => h.n >= 3)
  const mostAccurate = meaningful.slice(0, 5)
  const leastAccurate = [...meaningful].reverse().slice(0, 5)
  const calibrated = (stats?.byNeighborhood || []).filter(h => h.n >= 5).length
  const hoods = (stats?.byNeighborhood || []).length

  return (
    <div className="max-w-6xl mx-auto space-y-6">
      <PageHeader crumb={{ label: 'Grow', href: '/dashboard/grow' }} title="Measurement Accuracy" description="How well auto-measure performs — and how it's learning your neighborhoods. Each property's own measurements live on its card in Properties." />

      {loading ? (
        <SkeletonTiles count={4} />
      ) : !stats || stats.autoTotal === 0 ? (
        <Card><EmptyState icon={Ruler} title="No auto-measurements yet"
          description="As you measure quotes and properties, the accuracy and per-neighborhood learning will show up here."
          action={{ label: 'Measure a property', href: '/dashboard/properties' }} /></Card>
      ) : (
        <>
          {/* Headline stats */}
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
            <StatTile icon={Target} label="Accepted as-is" value={`${stats.acceptanceRate}%`} sub={`${stats.acceptedAsIs}/${stats.autoTotal} estimates`} />
            <StatTile icon={TrendingUp} label="Avg adjustment" value={`±${stats.avgAdjustmentPct}%`} sub="when changed" />
            <StatTile icon={Ruler} label="Auto-measurements" value={String(stats.autoTotal)} sub="recorded" />
            <StatTile icon={Gauge} label="Calibrated areas" value={`${calibrated}/${hoods}`} sub="≥5 measurements" />
          </div>

          {/* Calibration progress */}
          <Card><CardBody>
            <p className="text-sm font-semibold text-ink mb-1">Calibration progress</p>
            <p className="text-xs text-ink-muted mb-2">A neighborhood becomes “calibrated” (Medium confidence) after 5 measurements — the estimate then uses your real lawn:building ratio there.</p>
            <div className="h-2 rounded-full bg-bg-tertiary overflow-hidden">
              <div className="h-full bg-accent" style={{ width: `${hoods ? Math.round((calibrated / hoods) * 100) : 0}%` }} />
            </div>
            <p className="text-[11px] text-ink-faint mt-1">{calibrated} of {hoods} neighborhood{hoods !== 1 ? 's' : ''} calibrated</p>
          </CardBody></Card>

          {/* By confidence */}
          <Card><CardBody>
            <div className="flex items-center gap-2 mb-2">
              <span className="w-6 h-6 rounded-md bg-accent/10 border border-accent/20 flex items-center justify-center shrink-0">
                <Gauge className="w-3.5 h-3.5 text-accent-text" />
              </span>
              <p className="text-sm font-semibold text-ink tracking-tight">Accuracy by confidence level</p>
              <span className="flex-1 h-px bg-border" aria-hidden />
            </div>
            <div className="divide-y divide-border">
              {stats.byConfidence.sort((a, b) => a.confidence.localeCompare(b.confidence)).map(c => (
                <div key={c.confidence} className="flex items-center justify-between gap-3 py-2 text-sm">
                  <span className="capitalize text-ink font-medium w-20">{c.confidence}</span>
                  <span className="text-ink-muted tabular-nums">{c.n} measurement{c.n !== 1 ? 's' : ''}</span>
                  <span className="text-ink-muted tabular-nums">{c.acceptanceRate}% kept</span>
                  <span className="text-ink font-semibold w-16 text-right tabular-nums">±{c.avgAbsDiffPct}%</span>
                </div>
              ))}
            </div>
          </CardBody></Card>

          {/* Neighborhoods */}
          <div className="grid sm:grid-cols-2 gap-4">
            <HoodList title="Most accurate areas" rows={mostAccurate} />
            <HoodList title="Least accurate areas" rows={leastAccurate} />
          </div>
        </>
      )}
    </div>
  )
}

function HoodList({ title, rows }: { title: string; rows: { neighborhood: string; n: number; avgAbsDiffPct: number }[] }) {
  return (
    <Card><CardBody>
      <div className="flex items-center gap-2 mb-2">
        <span className="w-6 h-6 rounded-md bg-accent/10 border border-accent/20 flex items-center justify-center shrink-0">
          <MapPin className="w-3.5 h-3.5 text-accent-text" />
        </span>
        <p className="text-sm font-semibold text-ink tracking-tight">{title}</p>
        <span className="flex-1 h-px bg-border" aria-hidden />
      </div>
      {rows.length === 0 ? (
        <InlineEmpty className="py-3">Need ≥3 measurements in an area to rank it.</InlineEmpty>
      ) : (
        <div className="divide-y divide-border">
          {rows.map(h => (
            <div key={h.neighborhood} className="flex items-center justify-between gap-3 py-1.5 text-sm">
              <span className="text-ink truncate">{h.neighborhood}</span>
              <span className="text-ink-faint text-xs shrink-0">{h.n}×</span>
              <span className="font-semibold text-ink w-14 text-right tabular-nums">±{h.avgAbsDiffPct}%</span>
            </div>
          ))}
        </div>
      )}
    </CardBody></Card>
  )
}
