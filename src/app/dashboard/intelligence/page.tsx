'use client'

import { useEffect, useMemo, useState } from 'react'
import { createClient } from '@/lib/supabase/client'
import { loadBusinessIntelligence, BIReport, NamedValue } from '@/lib/businessIntelligence'
import { loadLaborInsights, LaborInsights, ServiceAccuracy, ServiceProfit } from '@/lib/labor'
import { PageHeader } from '@/components/layout/PageHeader'
import { Skeleton, SkeletonTiles } from '@/components/ui/Skeleton'
import { EmptyState, InlineEmpty } from '@/components/ui/EmptyState'
import { StatTile } from '@/components/ui/StatTile'
import { Collapsible } from '@/components/ui/Collapsible'
import { readCache, writeCache, CACHE_TTL } from '@/lib/clientCache'
import { formatCurrency, cn } from '@/lib/utils'
import { TrendingUp, TrendingDown, DollarSign, Gauge, Users, Target, Activity, LineChart, Home, AlertTriangle } from 'lucide-react'

export default function IntelligencePage() {
  const supabase = useMemo(() => createClient(), [])
  const [bi, setBi] = useState<BIReport | null>(() => readCache<BIReport>('bi', CACHE_TTL.medium))
  const [loading, setLoading] = useState(!bi) // cached → render instantly, refresh in background
  // Labour accuracy & crew efficiency — loaded alongside, but never blocks the BI report.
  const [labor, setLabor] = useState<LaborInsights | null>(() => readCache<LaborInsights>('labor', CACHE_TTL.medium))

  useEffect(() => {
    (async () => {
      try { const r = await loadBusinessIntelligence(supabase); if (r) { setBi(r); writeCache('bi', r) } }
      finally { setLoading(false) }
    })()
  }, [supabase])

  useEffect(() => {
    (async () => {
      try { const r = await loadLaborInsights(supabase); if (r) { setLabor(r.insights); writeCache('labor', r.insights) } }
      catch { /* labour insights are supplementary — never break the BI report */ }
    })()
  }, [supabase])

  if (loading && !bi) {
    return (
      <div className="max-w-6xl mx-auto space-y-6">
        <PageHeader crumb={{ label: 'Grow', href: '/dashboard/grow' }} title="Business Intelligence" description="How your business is performing — and where to focus next." />
        <SkeletonTiles count={4} />
        <Skeleton className="h-32 w-full rounded-card" />
        <div className="grid md:grid-cols-3 gap-3">{[0, 1, 2].map(i => <Skeleton key={i} className="h-40 rounded-card" />)}</div>
        <SkeletonTiles count={4} />
      </div>
    )
  }
  if (!bi) return null

  return (
    <div className="max-w-6xl mx-auto space-y-6">
      <PageHeader crumb={{ label: 'Grow', href: '/dashboard/grow' }} title="Business Intelligence" description={`How your business is performing — and where to focus. As of ${bi.generatedFor}.`} />

      {/* ── FINANCIAL ── */}
      <Section title="Financial" icon={DollarSign}>
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
          <Stat label="Revenue this month" value={formatCurrency(bi.financial.revenueThisMonth)} delta={bi.financial.monthOverMonthPct} deltaLabel="vs last month" />
          <Stat label="Revenue last month" value={formatCurrency(bi.financial.revenueLastMonth)} />
          <Stat label="Revenue YTD" value={formatCurrency(bi.financial.revenueYTD)} />
          <Stat label="Projected this month" value={formatCurrency(bi.forecasting.projectedThisMonth)} accent />
        </div>
        <TrendBars trend={bi.financial.trend} />
        <div className="grid md:grid-cols-3 gap-3">
          <RankList title="By service" items={bi.financial.byService} fmt={formatCurrency} />
          <RankList title="By neighborhood" items={bi.financial.byNeighborhood} fmt={formatCurrency} subFmt={v => `$${v}/hr`} />
          <RankList title="Top customers" items={bi.financial.byCustomer} fmt={formatCurrency} />
        </div>
      </Section>

      {/* ── PROFITABILITY ── */}
      <Section title="Profitability" icon={Gauge}>
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
          <Stat label="Revenue / labor hour" value={`$${bi.profitability.revenuePerLaborHour}`} />
          <Stat label="Gross profit YTD" value={formatCurrency(bi.profitability.grossProfitYTD)} sub={`${bi.profitability.grossMarginPct}% margin`} />
          <Stat label="Crew efficiency" value={bi.profitability.crewEfficiencyPct != null ? `${bi.profitability.crewEfficiencyPct}%` : '—'} sub={bi.profitability.crewEfficiencyPct != null ? (bi.profitability.crewEfficiencyPct <= 100 ? 'at/under estimate' : 'over estimate') : 'time more jobs'} />
          <Stat label="Route $/km" value={`$${bi.profitability.routeRevPerKm}`} sub={bi.profitability.avgGrade ? `avg grade ${bi.profitability.avgGrade}` : undefined} />
        </div>
        <div className="grid md:grid-cols-3 gap-3">
          <RankList title="Most profitable customers" items={bi.profitability.topCustomers} fmt={formatCurrency} />
          <RankList title="Most profitable neighborhoods" items={bi.profitability.topNeighborhoods} fmt={v => `$${v}/hr`} subFmt={formatCurrency} />
          <RankList title="Most profitable services" items={bi.profitability.topServices} fmt={v => `$${v}/hr`} subFmt={formatCurrency} />
        </div>
      </Section>

      {/* ── CUSTOMERS ── */}
      <Section title="Customers" icon={Users}>
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
          <Stat label="Active customers" value={String(bi.customers.active)} sub={`${bi.customers.total} total`} />
          <Stat label="Retention rate" value={bi.customers.retentionRatePct != null ? `${bi.customers.retentionRatePct}%` : '—'} sub={bi.customers.churnRatePct != null ? `${bi.customers.churnRatePct}% churn` : 'recurring only'} />
          <Stat label="Avg lifetime value" value={formatCurrency(bi.customers.avgLifetimeValue)} sub={`forecast ${formatCurrency(bi.customers.forecastLtv)}`} />
          <Stat label="New this month" value={`+${bi.customers.newThisMonth}`} sub={`avg ${formatCurrency(bi.customers.avgAnnualValue)}/yr`} accent />
        </div>
        <TrendBars trend={bi.customers.growth.map(g => ({ month: g.name, revenue: g.value }))} label="New customers / month" integer />
      </Section>

      {/* ── SALES ── */}
      <Section title="Sales" icon={Target}>
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
          <Stat label="Quote win rate" value={bi.sales.quoteAcceptancePct != null ? `${bi.sales.quoteAcceptancePct}%` : '—'} sub={`${bi.sales.won} won · ${bi.sales.lost} lost`} />
          <Stat label="Avg quote value" value={formatCurrency(bi.sales.avgQuoteValue)} />
          <Stat label="Lost pipeline" value={formatCurrency(bi.sales.lostValue)} sub="quoted but declined" />
          <Stat label="Top loss reason" value={bi.sales.topLossReasons[0]?.name ? cap(bi.sales.topLossReasons[0].name) : '—'} sub={bi.sales.topLossReasons[0] ? `${bi.sales.topLossReasons[0].value}×` : undefined} />
        </div>
        <div className="grid md:grid-cols-2 gap-3">
          <RankList title="Win rate by service" items={bi.sales.byServiceType} fmt={v => `${v}%`} subFmt={v => `${v} quotes`} />
          <RankList title="Win rate by neighborhood" items={bi.sales.byNeighborhood} fmt={v => `${v}%`} subFmt={v => `${v} quotes`} />
        </div>
      </Section>

      {/* ── OPERATIONS ── */}
      <Section title="Operations" icon={Activity}>
        <div className="grid grid-cols-2 lg:grid-cols-3 gap-3">
          {/* "Estimate accuracy" lives ONCE — in the Labour section below (the two
              engines' numbers could disagree, so only the learned one is shown). */}
          <Stat label="Capacity used (4 wk)" value={bi.operations.capacityUtilizationPct != null ? `${bi.operations.capacityUtilizationPct}%` : '—'} sub="of workday capacity" />
          <Stat label="Booked next 2 wk" value={bi.operations.bookedUtilizationPct != null ? `${bi.operations.bookedUtilizationPct}%` : '—'} sub="of capacity" />
          <Stat label="Avg route density" value={String(bi.operations.avgRouteDensity)}
            sub={
              <span className="flex items-center gap-1.5">
                <span className="w-10 h-1 rounded-full bg-bg-tertiary overflow-hidden shrink-0">
                  <span className="block h-full rounded-full bg-accent/80" style={{ width: `${Math.min(100, Math.max(0, bi.operations.avgRouteDensity))}%` }} />
                </span>
                how clustered you are
              </span>
            } />
        </div>
      </Section>

      {/* ── LABOUR ACCURACY & CREW EFFICIENCY ── (merged from the former Labor
          Intelligence page). Collapsed by default — it's a deep-dive, not a daily
          decision; the one-line summary keeps the headline number visible. */}
      <Collapsible title="Labour accuracy & crew efficiency" icon={Gauge}
        summary={labor && labor.trainingJobs >= 1
          ? `${labor.overallAccuracyPct != null ? `${labor.overallAccuracyPct}% estimate accuracy` : ''} · ${labor.trainingJobs} timed job${labor.trainingJobs !== 1 ? 's' : ''}`
          : 'No timed jobs yet — check in/out in Day Ops to start learning'}>
        {labor && labor.trainingJobs >= 1 ? (
          <div className="space-y-3">
            <div className="grid grid-cols-2 lg:grid-cols-3 gap-3">
              <Stat label="Estimate accuracy" value={labor.overallAccuracyPct != null ? `${labor.overallAccuracyPct}%` : '—'} accent />
              <Stat label="Average error" value={labor.avgErrorPct != null ? `${labor.avgErrorPct}%` : '—'} />
              <Stat label="Training jobs" value={String(labor.trainingJobs)} sub="completed & timed" />
            </div>

            <div className="grid md:grid-cols-2 gap-3">
              <LaborAccuracyList title="Most accurate services" icon={Target} items={labor.mostAccurate} good />
              <LaborAccuracyList title="Least accurate services" icon={Target} items={labor.leastAccurate} />
            </div>

            <div className="grid md:grid-cols-2 gap-3">
              <LaborProfitList title="Most profitable services" icon={DollarSign} items={labor.mostProfitable} />
              <LaborProfitList title="Least profitable services" icon={DollarSign} items={labor.leastProfitable} />
            </div>

            {/* Crew efficiency trends (learned) */}
            <LaborCard title="Crew efficiency (learned)" icon={Users}>
              {labor.crewTrends.length === 0 ? <LaborEmpty /> : (
                <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
                  {labor.crewTrends.map(t => (
                    <div key={t.crewSize} className="rounded-lg border border-border bg-bg-tertiary px-3 py-2">
                      <p className="text-[10px] font-semibold uppercase tracking-[0.14em] text-ink-faint">{t.crewSize}-person crew</p>
                      <p className="text-base font-bold text-ink tabular-nums">{t.effectiveWorkers}× <span className="text-[11px] font-normal text-ink-muted">effective</span></p>
                      <p className="text-[10px] text-ink-faint tabular-nums">{t.manMinPer1000} man-min / 1,000 ft²</p>
                    </div>
                  ))}
                </div>
              )}
            </LaborCard>

            <div className="grid md:grid-cols-2 gap-3">
              <LaborCard title="Most accurate properties" icon={Home}>
                {labor.bestProperties.length === 0 ? <LaborEmpty /> : (
                  <ul className="space-y-1.5">
                    {labor.bestProperties.map(p => (
                      <li key={p.propertyId} className="flex items-center justify-between gap-2 text-sm">
                        <span className="text-ink truncate">{p.name}</span>
                        <span className="shrink-0 font-semibold text-emerald-400 tabular-nums">{p.accuracyPct}% <span className="text-[11px] text-ink-faint font-normal">· {p.n}</span></span>
                      </li>
                    ))}
                  </ul>
                )}
              </LaborCard>
              <LaborCard title="Worst prediction misses" icon={AlertTriangle}>
                {labor.worstMisses.length === 0 ? <LaborEmpty /> : (
                  <ul className="space-y-1.5">
                    {labor.worstMisses.map((m, i) => (
                      <li key={i} className="flex items-center justify-between gap-2 text-sm">
                        <span className="text-ink truncate">{m.propertyName} <span className="text-ink-faint text-[11px]">· {m.combo}</span></span>
                        <span className="shrink-0 text-ink-muted text-xs tabular-nums">est {m.estimated} → <span className="font-semibold text-red-400">{m.actual}</span> ({m.errorPct}%)</span>
                      </li>
                    ))}
                  </ul>
                )}
              </LaborCard>
            </div>
          </div>
        ) : (
          <div className="rounded-card border border-border bg-bg-secondary">
            <EmptyState icon={Gauge} className="py-10" title="No timed jobs yet"
              description="Start and complete jobs in Day Ops (check-in / check-out) and the model learns automatically. The Smart Estimate falls back to lawn size until then." />
          </div>
        )}
      </Collapsible>

      {/* ── FORECASTING ── ("Projected this month" lives once, in Financial above) */}
      <Section title="Forecasting" icon={LineChart}>
        <div className="grid grid-cols-2 lg:grid-cols-3 gap-3">
          <Stat label="Recurring run-rate" value={formatCurrency(bi.forecasting.projectedRecurringAnnual)} sub="/yr locked in" accent />
          <Stat label="Rest of season" value={formatCurrency(bi.forecasting.projectedSeasonRemaining)} sub="recurring booked" />
          <Stat label="Growth trend" value={bi.forecasting.growthForecastPct != null ? `${bi.forecasting.growthForecastPct > 0 ? '+' : ''}${bi.forecasting.growthForecastPct}%` : '—'} delta={bi.forecasting.growthForecastPct} deltaLabel="3-mo revenue" />
        </div>
      </Section>
    </div>
  )
}

function cap(s: string) { return s.replace(/_/g, ' ').replace(/^\w/, c => c.toUpperCase()) }

function Section({ title, icon: Icon, children }: { title: string; icon: typeof DollarSign; children: React.ReactNode }) {
  return (
    <div className="space-y-3 animate-rise">
      <div className="flex items-center gap-2.5">
        <span className="w-6 h-6 rounded-md bg-accent/10 border border-accent/20 flex items-center justify-center shrink-0">
          <Icon className="w-3.5 h-3.5 text-accent" />
        </span>
        <p className="text-sm font-bold tracking-tight text-ink">{title}</p>
        <span className="flex-1 h-px bg-border" aria-hidden />
      </div>
      {children}
    </div>
  )
}

// Thin adapter over the ONE shared KPI tile — the delta (▲/▼ vs last period)
// renders as the tile's `sub` node, so the change is highlighted right under
// the number without a second tile style existing anywhere.
function Stat({ label, value, sub, delta, deltaLabel, accent }: { label: string; value: string; sub?: React.ReactNode; delta?: number | null; deltaLabel?: string; accent?: boolean }) {
  const deltaNode = delta != null ? (
    <span className={cn('font-semibold inline-flex items-center gap-1 tabular-nums', delta >= 0 ? 'text-emerald-400' : 'text-red-400')}>
      {delta >= 0 ? <TrendingUp className="w-3 h-3" /> : <TrendingDown className="w-3 h-3" />}
      {delta > 0 ? '+' : ''}{delta}% {deltaLabel && <span className="text-ink-faint font-normal">{deltaLabel}</span>}
    </span>
  ) : null
  return <StatTile label={label} value={<span className="tabular-nums">{value}</span>} accent={accent} sub={deltaNode ?? sub} />
}

function RankList({ title, items, fmt, subFmt }: { title: string; items: NamedValue[]; fmt: (v: number) => string; subFmt?: (v: number) => string }) {
  return (
    <div className="rounded-card border border-border bg-bg-secondary p-4">
      <p className="text-[10px] font-semibold uppercase tracking-[0.14em] text-ink-faint mb-2.5">{title}</p>
      {items.length === 0 ? (
        <InlineEmpty className="py-3">Not enough data yet — this fills in as jobs complete.</InlineEmpty>
      ) : (
        <ul className="space-y-2">
          {items.map((it, i) => (
            <li key={i} className="flex items-center justify-between gap-2 text-sm">
              <span className="text-ink truncate flex items-center gap-2">
                <span className={cn(
                  'w-4 h-4 rounded text-[9px] font-bold flex items-center justify-center shrink-0 tabular-nums',
                  i === 0 ? 'bg-accent/15 text-accent' : 'bg-bg-tertiary text-ink-faint'
                )}>{i + 1}</span>
                <span className={cn('truncate', i === 0 && 'font-medium')}>{it.name}</span>
              </span>
              <span className="shrink-0 font-semibold text-ink tabular-nums">
                {fmt(it.value)}
                {subFmt && it.sub != null && <span className="text-[11px] text-ink-faint font-normal ml-1.5">{subFmt(it.sub)}</span>}
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

function TrendBars({ trend, label = 'Revenue / month', integer = false }: { trend: { month: string; revenue: number }[]; label?: string; integer?: boolean }) {
  if (!trend.length) return null
  const max = Math.max(1, ...trend.map(t => t.revenue))
  const best = trend.reduce((m, t) => Math.max(m, t.revenue), 0)
  const fmt = (v: number) => integer ? String(v) : '$' + Math.round(v).toLocaleString()
  const latest = trend[trend.length - 1]
  return (
    <div className="rounded-card border border-border bg-bg-secondary p-4">
      <div className="flex items-baseline justify-between gap-3 mb-3">
        <p className="text-[10px] font-semibold uppercase tracking-[0.14em] text-ink-faint">{label}</p>
        {latest && <p className="text-xs text-ink-muted tabular-nums">{latest.month.slice(5)}: <span className="font-semibold text-ink">{fmt(latest.revenue)}</span></p>}
      </div>
      <div className="flex items-end gap-1.5 h-24">
        {trend.map((t, i) => {
          const current = i === trend.length - 1
          return (
            <div key={i} className="flex-1 flex flex-col items-center justify-end gap-1.5 min-w-0 group/bar">
              <div
                className={cn(
                  'w-full rounded-t-md transition-all duration-200 group-hover/bar:opacity-100',
                  current
                    ? 'bg-gradient-to-t from-accent/70 to-accent'
                    : t.revenue === best && best > 0
                      ? 'bg-gradient-to-t from-accent/35 to-accent/70 opacity-90'
                      : 'bg-gradient-to-t from-accent/20 to-accent/50 opacity-80',
                )}
                style={{ height: `${Math.max(3, (t.revenue / max) * 100)}%` }}
                title={`${t.month}: ${fmt(t.revenue)}`}
              />
              <span className={cn('text-[9px] truncate w-full text-center tabular-nums', current ? 'text-ink-muted font-semibold' : 'text-ink-faint')}>{t.month.slice(5)}</span>
            </div>
          )
        })}
      </div>
    </div>
  )
}

// ── Labour accuracy & crew efficiency helpers (merged from the former Labor Intelligence page) ──
function LaborCard({ title, icon: Icon, children }: { title: string; icon: typeof Gauge; children: React.ReactNode }) {
  return (
    <div className="rounded-card border border-border bg-bg-secondary p-4">
      <p className="text-[10px] font-semibold uppercase tracking-[0.14em] text-ink-faint mb-2 flex items-center gap-1.5"><Icon className="w-3.5 h-3.5" /> {title}</p>
      {children}
    </div>
  )
}
function LaborEmpty() { return <InlineEmpty className="py-3">Not enough data yet</InlineEmpty> }

function LaborAccuracyList({ title, icon, items, good }: { title: string; icon: typeof Gauge; items: ServiceAccuracy[]; good?: boolean }) {
  return (
    <LaborCard title={title} icon={icon}>
      {items.length === 0 ? <LaborEmpty /> : (
        <ul className="space-y-1.5">
          {items.map(s => (
            <li key={s.combo} className="flex items-center justify-between gap-2 text-sm">
              <span className="text-ink truncate">{s.label} <span className="text-[11px] text-ink-faint">· {s.n}</span></span>
              <span className={cn('shrink-0 font-semibold tabular-nums', good ? 'text-emerald-400' : s.accuracyPct < 70 ? 'text-amber-400' : 'text-ink')}>{s.accuracyPct}%</span>
            </li>
          ))}
        </ul>
      )}
    </LaborCard>
  )
}
function LaborProfitList({ title, icon, items }: { title: string; icon: typeof Gauge; items: ServiceProfit[] }) {
  return (
    <LaborCard title={title} icon={icon}>
      {items.length === 0 ? <LaborEmpty /> : (
        <ul className="space-y-1.5">
          {items.map(s => (
            <li key={s.combo} className="flex items-center justify-between gap-2 text-sm">
              <span className="text-ink truncate">{s.label} <span className="text-[11px] text-ink-faint">· {s.n}</span></span>
              <span className="shrink-0 font-semibold text-ink tabular-nums">${s.revPerHour}/hr <span className="text-[11px] text-ink-faint font-normal">{formatCurrency(s.profit)}</span></span>
            </li>
          ))}
        </ul>
      )}
    </LaborCard>
  )
}
