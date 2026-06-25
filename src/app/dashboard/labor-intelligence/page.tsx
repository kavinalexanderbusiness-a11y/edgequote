'use client'

import { useEffect, useMemo, useState } from 'react'
import { createClient } from '@/lib/supabase/client'
import { loadLaborInsights, LaborInsights, ServiceAccuracy, ServiceProfit } from '@/lib/labor'
import { PageHeader } from '@/components/layout/PageHeader'
import { Skeleton, SkeletonTiles } from '@/components/ui/Skeleton'
import { Card } from '@/components/ui/Card'
import { StatTile } from '@/components/ui/StatTile'
import { SectionHeading } from '@/components/ui/SectionHeading'
import { EmptyState, InlineEmpty } from '@/components/ui/EmptyState'
import { readCache, writeCache, CACHE_TTL } from '@/lib/clientCache'
import { formatCurrency, cn } from '@/lib/utils'
import { Gauge, Target, DollarSign, Home, AlertTriangle, Users } from 'lucide-react'

export default function LaborIntelligencePage() {
  const supabase = useMemo(() => createClient(), [])
  const [ins, setIns] = useState<LaborInsights | null>(() => readCache<LaborInsights>('labor', CACHE_TTL.medium))
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    (async () => {
      try { const r = await loadLaborInsights(supabase); if (r) { setIns(r.insights); writeCache('labor', r.insights) } }
      finally { setLoading(false) }
    })()
  }, [supabase])

  if (loading && !ins) {
    return (
      <div className="max-w-5xl space-y-6">
        <PageHeader title="Labor Intelligence" description="How accurate your time estimates are — and where they're learning fastest." />
        <SkeletonTiles count={3} />
        <div className="grid md:grid-cols-2 gap-3">{[0, 1].map(i => <Skeleton key={i} className="h-40 rounded-card" />)}</div>
      </div>
    )
  }
  if (!ins) return null

  if (ins.trainingJobs < 1) {
    return (
      <div className="max-w-5xl space-y-6">
        <PageHeader title="Labor Intelligence" description="How accurate your time estimates are — and where they're learning fastest." />
        <EmptyState
          icon={Gauge}
          title="No timed jobs yet"
          description="Start and complete jobs in Day Ops (check-in / check-out) and the model learns automatically. The Smart Estimate falls back to lawn size until then."
        />
      </div>
    )
  }

  return (
    <div className="max-w-5xl space-y-6">
      <PageHeader title="Labor Intelligence" description="How accurate your time estimates are — and where they're learning fastest." />

      <div className="grid grid-cols-2 lg:grid-cols-3 gap-3">
        <StatTile label="Estimate accuracy" value={ins.overallAccuracyPct != null ? `${ins.overallAccuracyPct}%` : '—'} accent />
        <StatTile label="Average error" value={ins.avgErrorPct != null ? `${ins.avgErrorPct}%` : '—'} />
        <StatTile label="Training jobs" value={String(ins.trainingJobs)} sub="completed & timed" />
      </div>

      <div className="grid md:grid-cols-2 gap-3">
        <AccuracyList title="Most accurate services" icon={Target} items={ins.mostAccurate} good />
        <AccuracyList title="Least accurate services" icon={Target} items={ins.leastAccurate} />
      </div>

      <div className="grid md:grid-cols-2 gap-3">
        <ProfitList title="Most profitable services" icon={DollarSign} items={ins.mostProfitable} />
        <ProfitList title="Least profitable services" icon={DollarSign} items={ins.leastProfitable} />
      </div>

      {/* Crew efficiency trends (learned) */}
      <Section title="Crew efficiency (learned)" icon={Users}>
        {ins.crewTrends.length === 0 ? <InlineEmpty>Not enough data yet</InlineEmpty> : (
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
            {ins.crewTrends.map(t => (
              <StatTile
                key={t.crewSize}
                label={`${t.crewSize}-person crew`}
                value={<>{t.effectiveWorkers}× <span className="text-[11px] font-normal text-ink-muted">effective</span></>}
                sub={`${t.manMinPer1000} man-min / 1,000 ft²`}
              />
            ))}
          </div>
        )}
      </Section>

      <div className="grid md:grid-cols-2 gap-3">
        <Section title="Most accurate properties" icon={Home}>
          {ins.bestProperties.length === 0 ? <Empty /> : (
            <ul className="space-y-1.5">
              {ins.bestProperties.map(p => (
                <li key={p.propertyId} className="flex items-center justify-between gap-2 text-sm">
                  <span className="text-ink truncate">{p.name}</span>
                  <span className="shrink-0 font-semibold text-emerald-400">{p.accuracyPct}% <span className="text-[11px] text-ink-faint font-normal">· {p.n}</span></span>
                </li>
              ))}
            </ul>
          )}
        </Section>
        <Section title="Worst prediction misses" icon={AlertTriangle}>
          {ins.worstMisses.length === 0 ? <Empty /> : (
            <ul className="space-y-1.5">
              {ins.worstMisses.map((m, i) => (
                <li key={i} className="flex items-center justify-between gap-2 text-sm">
                  <span className="text-ink truncate">{m.propertyName} <span className="text-ink-faint text-[11px]">· {m.combo}</span></span>
                  <span className="shrink-0 text-ink-muted text-xs">est {m.estimated} → <span className="font-semibold text-red-400">{m.actual}</span> ({m.errorPct}%)</span>
                </li>
              ))}
            </ul>
          )}
        </Section>
      </div>
    </div>
  )
}

function Section({ title, icon: Icon, children }: { title: string; icon: typeof Gauge; children: React.ReactNode }) {
  return (
    <Card className="p-4">
      <SectionHeading icon={Icon} title={title} className="mb-2" />
      {children}
    </Card>
  )
}
function Empty() { return <InlineEmpty>Not enough data yet</InlineEmpty> }

function AccuracyList({ title, icon, items, good }: { title: string; icon: typeof Gauge; items: ServiceAccuracy[]; good?: boolean }) {
  return (
    <Section title={title} icon={icon}>
      {items.length === 0 ? <Empty /> : (
        <ul className="space-y-1.5">
          {items.map(s => (
            <li key={s.combo} className="flex items-center justify-between gap-2 text-sm">
              <span className="text-ink truncate">{s.label} <span className="text-[11px] text-ink-faint">· {s.n}</span></span>
              <span className={cn('shrink-0 font-semibold', good ? 'text-emerald-400' : s.accuracyPct < 70 ? 'text-amber-400' : 'text-ink')}>{s.accuracyPct}%</span>
            </li>
          ))}
        </ul>
      )}
    </Section>
  )
}
function ProfitList({ title, icon, items }: { title: string; icon: typeof Gauge; items: ServiceProfit[] }) {
  return (
    <Section title={title} icon={icon}>
      {items.length === 0 ? <Empty /> : (
        <ul className="space-y-1.5">
          {items.map(s => (
            <li key={s.combo} className="flex items-center justify-between gap-2 text-sm">
              <span className="text-ink truncate">{s.label} <span className="text-[11px] text-ink-faint">· {s.n}</span></span>
              <span className="shrink-0 font-semibold text-ink">${s.revPerHour}/hr <span className="text-[11px] text-ink-faint font-normal">{formatCurrency(s.profit)}</span></span>
            </li>
          ))}
        </ul>
      )}
    </Section>
  )
}
