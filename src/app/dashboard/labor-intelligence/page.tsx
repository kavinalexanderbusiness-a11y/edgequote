'use client'

import { useEffect, useMemo, useState } from 'react'
import { createClient } from '@/lib/supabase/client'
import { loadLaborInsights, LaborInsights, ServiceAccuracy, ServiceProfit } from '@/lib/labor'
import { PageHeader } from '@/components/layout/PageHeader'
import { Skeleton, SkeletonTiles } from '@/components/ui/Skeleton'
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
      <div className="max-w-5xl">
        <PageHeader title="Labor Intelligence" description="How accurate your time estimates are — and where they're learning fastest." />
        <div className="rounded-card border border-border bg-bg-secondary p-8 text-center">
          <Gauge className="w-10 h-10 text-ink-faint mx-auto mb-3" />
          <p className="text-sm font-medium text-ink">No timed jobs yet</p>
          <p className="text-xs text-ink-muted mt-1">Start and complete jobs in Day Ops (check-in / check-out) and the model learns automatically. The Smart Estimate falls back to lawn size until then.</p>
        </div>
      </div>
    )
  }

  return (
    <div className="max-w-5xl space-y-6">
      <PageHeader title="Labor Intelligence" description="How accurate your time estimates are — and where they're learning fastest." />

      <div className="grid grid-cols-2 lg:grid-cols-3 gap-3">
        <Tile label="Estimate accuracy" value={ins.overallAccuracyPct != null ? `${ins.overallAccuracyPct}%` : '—'} accent />
        <Tile label="Average error" value={ins.avgErrorPct != null ? `${ins.avgErrorPct}%` : '—'} />
        <Tile label="Training jobs" value={String(ins.trainingJobs)} sub="completed & timed" />
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
        {ins.crewTrends.length === 0 ? <Empty /> : (
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
            {ins.crewTrends.map(t => (
              <div key={t.crewSize} className="rounded-lg border border-border bg-bg-tertiary px-3 py-2">
                <p className="text-[10px] uppercase tracking-wide text-ink-faint">{t.crewSize}-person crew</p>
                <p className="text-base font-bold text-ink">{t.effectiveWorkers}× <span className="text-[11px] font-normal text-ink-muted">effective</span></p>
                <p className="text-[10px] text-ink-faint">{t.manMinPer1000} man-min / 1,000 ft²</p>
              </div>
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

function Tile({ label, value, sub, accent }: { label: string; value: string; sub?: string; accent?: boolean }) {
  return (
    <div className={cn('rounded-card border p-3.5', accent ? 'border-accent/30 bg-accent/[0.05]' : 'border-border bg-bg-secondary')}>
      <p className="text-[10px] uppercase tracking-wide text-ink-faint">{label}</p>
      <p className={cn('text-xl font-black mt-1', accent ? 'text-accent' : 'text-ink')}>{value}</p>
      {sub && <p className="text-[11px] text-ink-muted mt-0.5">{sub}</p>}
    </div>
  )
}
function Section({ title, icon: Icon, children }: { title: string; icon: typeof Gauge; children: React.ReactNode }) {
  return (
    <div className="rounded-card border border-border bg-bg-secondary p-4">
      <p className="text-[10px] uppercase tracking-wide text-ink-faint mb-2 flex items-center gap-1.5"><Icon className="w-3.5 h-3.5" /> {title}</p>
      {children}
    </div>
  )
}
function Empty() { return <p className="text-xs text-ink-faint py-3 text-center">Not enough data yet</p> }

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
