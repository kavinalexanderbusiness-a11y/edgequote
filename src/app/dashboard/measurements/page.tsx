'use client'

import { useEffect, useState } from 'react'
import { createClient } from '@/lib/supabase/client'
import { measurementStats, MeasureStats } from '@/lib/autoMeasure'
import { PageHeader } from '@/components/layout/PageHeader'
import { Card, CardBody } from '@/components/ui/Card'
import { cn } from '@/lib/utils'
import { Ruler, TrendingUp, Target, MapPin, Gauge } from 'lucide-react'

export default function MeasurementsPage() {
  const [stats, setStats] = useState<MeasureStats | null>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    (async () => {
      const supabase = createClient()
      const { data: { user } } = await supabase.auth.getUser()
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
    <div className="max-w-4xl space-y-6">
      <PageHeader title="Measurement Accuracy" description="How well auto-measure performs — and how it's learning your neighborhoods." />

      {loading ? (
        <div className="text-center py-16 text-sm text-ink-muted">Loading…</div>
      ) : !stats || stats.autoTotal === 0 ? (
        <Card><CardBody className="text-center py-14 text-sm text-ink-muted">
          No auto-measurements yet. As you measure quotes and properties, the accuracy and per-neighborhood learning will show up here.
        </CardBody></Card>
      ) : (
        <>
          {/* Headline stats */}
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
            <Stat icon={Target} label="Accepted as-is" value={`${stats.acceptanceRate}%`} sub={`${stats.acceptedAsIs}/${stats.autoTotal} estimates`} />
            <Stat icon={TrendingUp} label="Avg adjustment" value={`±${stats.avgAdjustmentPct}%`} sub="when changed" />
            <Stat icon={Ruler} label="Auto-measurements" value={String(stats.autoTotal)} sub="recorded" />
            <Stat icon={Gauge} label="Calibrated areas" value={`${calibrated}/${hoods}`} sub="≥5 measurements" />
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
            <p className="text-sm font-semibold text-ink flex items-center gap-2 mb-2"><Gauge className="w-4 h-4 text-accent" /> Accuracy by confidence level</p>
            <div className="divide-y divide-border">
              {stats.byConfidence.sort((a, b) => a.confidence.localeCompare(b.confidence)).map(c => (
                <div key={c.confidence} className="flex items-center justify-between gap-3 py-2 text-sm">
                  <span className="capitalize text-ink font-medium w-20">{c.confidence}</span>
                  <span className="text-ink-muted">{c.n} measurement{c.n !== 1 ? 's' : ''}</span>
                  <span className="text-ink-muted">{c.acceptanceRate}% kept</span>
                  <span className="text-ink font-semibold w-16 text-right">±{c.avgAbsDiffPct}%</span>
                </div>
              ))}
            </div>
          </CardBody></Card>

          {/* Neighborhoods */}
          <div className="grid sm:grid-cols-2 gap-4">
            <HoodList title="Most accurate areas" tone="text-emerald-400" rows={mostAccurate} />
            <HoodList title="Least accurate areas" tone="text-amber-400" rows={leastAccurate} />
          </div>
        </>
      )}
    </div>
  )
}

function Stat({ icon: Icon, label, value, sub }: { icon: typeof Ruler; label: string; value: string; sub: string }) {
  return (
    <Card><CardBody>
      <p className="text-[10px] uppercase tracking-wide text-ink-faint flex items-center gap-1"><Icon className="w-3 h-3" /> {label}</p>
      <p className="text-2xl font-bold text-ink mt-0.5">{value}</p>
      <p className="text-[11px] text-ink-faint">{sub}</p>
    </CardBody></Card>
  )
}

function HoodList({ title, tone, rows }: { title: string; tone: string; rows: { neighborhood: string; n: number; avgAbsDiffPct: number }[] }) {
  return (
    <Card><CardBody>
      <p className={cn('text-sm font-semibold flex items-center gap-2 mb-2', tone)}><MapPin className="w-4 h-4" /> {title}</p>
      {rows.length === 0 ? (
        <p className="text-xs text-ink-muted">Need ≥3 measurements in an area to rank it.</p>
      ) : (
        <div className="divide-y divide-border">
          {rows.map(h => (
            <div key={h.neighborhood} className="flex items-center justify-between gap-3 py-1.5 text-sm">
              <span className="text-ink truncate">{h.neighborhood}</span>
              <span className="text-ink-faint text-xs shrink-0">{h.n}×</span>
              <span className="font-semibold text-ink w-14 text-right">±{h.avgAbsDiffPct}%</span>
            </div>
          ))}
        </div>
      )}
    </CardBody></Card>
  )
}
