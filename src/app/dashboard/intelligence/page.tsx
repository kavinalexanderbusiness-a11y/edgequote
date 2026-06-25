'use client'

import { useEffect, useMemo, useState } from 'react'
import { createClient } from '@/lib/supabase/client'
import { loadBusinessIntelligence, BIReport, NamedValue } from '@/lib/businessIntelligence'
import { PageHeader } from '@/components/layout/PageHeader'
import { Skeleton, SkeletonTiles } from '@/components/ui/Skeleton'
import { StatTile } from '@/components/ui/StatTile'
import { InlineEmpty } from '@/components/ui/EmptyState'
import { readCache, writeCache, CACHE_TTL } from '@/lib/clientCache'
import { formatCurrency, cn } from '@/lib/utils'
import { DollarSign, Gauge, Users, Target, Activity, LineChart } from 'lucide-react'

export default function IntelligencePage() {
  const supabase = useMemo(() => createClient(), [])
  const [bi, setBi] = useState<BIReport | null>(() => readCache<BIReport>('bi', CACHE_TTL.medium))
  const [loading, setLoading] = useState(!bi) // cached → render instantly, refresh in background

  useEffect(() => {
    (async () => {
      try { const r = await loadBusinessIntelligence(supabase); if (r) { setBi(r); writeCache('bi', r) } }
      finally { setLoading(false) }
    })()
  }, [supabase])

  if (loading && !bi) {
    return (
      <div className="max-w-6xl space-y-6">
        <PageHeader title="Business Intelligence" description="How your business is performing — and where to focus next." />
        <SkeletonTiles count={4} />
        <Skeleton className="h-32 w-full rounded-card" />
        <div className="grid md:grid-cols-3 gap-3">{[0, 1, 2].map(i => <Skeleton key={i} className="h-40 rounded-card" />)}</div>
        <SkeletonTiles count={4} />
      </div>
    )
  }
  if (!bi) return null

  return (
    <div className="max-w-6xl space-y-6">
      <PageHeader title="Business Intelligence" description={`How your business is performing — and where to focus. As of ${bi.generatedFor}.`} />

      {/* ── FINANCIAL ── */}
      <Section title="Financial" icon={DollarSign}>
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
          <StatTile label="Revenue this month" value={formatCurrency(bi.financial.revenueThisMonth)} delta={bi.financial.monthOverMonthPct} deltaLabel="vs last month" />
          <StatTile label="Revenue last month" value={formatCurrency(bi.financial.revenueLastMonth)} />
          <StatTile label="Revenue YTD" value={formatCurrency(bi.financial.revenueYTD)} />
          <StatTile label="Projected this month" value={formatCurrency(bi.forecasting.projectedThisMonth)} accent />
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
          <StatTile label="Revenue / labor hour" value={`$${bi.profitability.revenuePerLaborHour}`} />
          <StatTile label="Gross profit YTD" value={formatCurrency(bi.profitability.grossProfitYTD)} sub={`${bi.profitability.grossMarginPct}% margin`} />
          <StatTile label="Crew efficiency" value={bi.profitability.crewEfficiencyPct != null ? `${bi.profitability.crewEfficiencyPct}%` : '—'} sub={bi.profitability.crewEfficiencyPct != null ? (bi.profitability.crewEfficiencyPct <= 100 ? 'at/under estimate' : 'over estimate') : 'time more jobs'} />
          <StatTile label="Route $/km" value={`$${bi.profitability.routeRevPerKm}`} sub={bi.profitability.avgGrade ? `avg grade ${bi.profitability.avgGrade}` : undefined} />
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
          <StatTile label="Active customers" value={String(bi.customers.active)} sub={`${bi.customers.total} total`} />
          <StatTile label="Retention rate" value={bi.customers.retentionRatePct != null ? `${bi.customers.retentionRatePct}%` : '—'} sub={bi.customers.churnRatePct != null ? `${bi.customers.churnRatePct}% churn` : 'recurring only'} />
          <StatTile label="Avg lifetime value" value={formatCurrency(bi.customers.avgLifetimeValue)} sub={`forecast ${formatCurrency(bi.customers.forecastLtv)}`} />
          <StatTile label="New this month" value={`+${bi.customers.newThisMonth}`} sub={`avg ${formatCurrency(bi.customers.avgAnnualValue)}/yr`} accent />
        </div>
        <TrendBars trend={bi.customers.growth.map(g => ({ month: g.name, revenue: g.value }))} label="New customers / month" integer />
      </Section>

      {/* ── SALES ── */}
      <Section title="Sales" icon={Target}>
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
          <StatTile label="Quote win rate" value={bi.sales.quoteAcceptancePct != null ? `${bi.sales.quoteAcceptancePct}%` : '—'} sub={`${bi.sales.won} won · ${bi.sales.lost} lost`} />
          <StatTile label="Avg quote value" value={formatCurrency(bi.sales.avgQuoteValue)} />
          <StatTile label="Lost pipeline" value={formatCurrency(bi.sales.lostValue)} sub="quoted but declined" />
          <StatTile label="Top loss reason" value={bi.sales.topLossReasons[0]?.name ? cap(bi.sales.topLossReasons[0].name) : '—'} sub={bi.sales.topLossReasons[0] ? `${bi.sales.topLossReasons[0].value}×` : undefined} />
        </div>
        <div className="grid md:grid-cols-2 gap-3">
          <RankList title="Win rate by service" items={bi.sales.byServiceType} fmt={v => `${v}%`} subFmt={v => `${v} quotes`} />
          <RankList title="Win rate by neighborhood" items={bi.sales.byNeighborhood} fmt={v => `${v}%`} subFmt={v => `${v} quotes`} />
        </div>
      </Section>

      {/* ── OPERATIONS ── */}
      <Section title="Operations" icon={Activity}>
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
          <StatTile label="Capacity used (4 wk)" value={bi.operations.capacityUtilizationPct != null ? `${bi.operations.capacityUtilizationPct}%` : '—'} sub="of workday capacity" />
          <StatTile label="Booked next 2 wk" value={bi.operations.bookedUtilizationPct != null ? `${bi.operations.bookedUtilizationPct}%` : '—'} sub="of capacity" />
          <StatTile label="Labor estimate accuracy" value={bi.operations.laborAccuracyPct != null ? `${bi.operations.laborAccuracyPct}%` : '—'} sub={`${bi.operations.timedJobs} timed jobs`} />
          <StatTile label="Avg route density" value={`${bi.operations.avgRouteDensity}/100`} sub="how clustered you are" />
        </div>
      </Section>

      {/* ── FORECASTING ── */}
      <Section title="Forecasting" icon={LineChart}>
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
          <StatTile label="Projected this month" value={formatCurrency(bi.forecasting.projectedThisMonth)} accent />
          <StatTile label="Recurring run-rate" value={formatCurrency(bi.forecasting.projectedRecurringAnnual)} sub="/yr locked in" />
          <StatTile label="Rest of season" value={formatCurrency(bi.forecasting.projectedSeasonRemaining)} sub="recurring booked" />
          <StatTile label="Growth trend" value={bi.forecasting.growthForecastPct != null ? `${bi.forecasting.growthForecastPct > 0 ? '+' : ''}${bi.forecasting.growthForecastPct}%` : '—'} delta={bi.forecasting.growthForecastPct} deltaLabel="3-mo revenue" />
        </div>
      </Section>
    </div>
  )
}

function cap(s: string) { return s.replace(/_/g, ' ').replace(/^\w/, c => c.toUpperCase()) }

function Section({ title, icon: Icon, children }: { title: string; icon: typeof DollarSign; children: React.ReactNode }) {
  return (
    <div className="space-y-3">
      <p className="text-sm font-bold text-ink flex items-center gap-2"><Icon className="w-4 h-4 text-accent" /> {title}</p>
      {children}
    </div>
  )
}

function RankList({ title, items, fmt, subFmt }: { title: string; items: NamedValue[]; fmt: (v: number) => string; subFmt?: (v: number) => string }) {
  return (
    <div className="rounded-card border border-border bg-surface p-3.5">
      <p className="text-[10px] font-semibold uppercase tracking-wide text-ink-faint mb-2">{title}</p>
      {items.length === 0 ? (
        <InlineEmpty>Not enough data yet</InlineEmpty>
      ) : (
        <ul className="space-y-1.5">
          {items.map((it, i) => (
            <li key={i} className="flex items-center justify-between gap-2 text-sm">
              <span className="text-ink truncate flex items-center gap-1.5">
                <span className="text-[10px] text-ink-faint w-3 shrink-0">{i + 1}</span>
                <span className="truncate">{it.name}</span>
              </span>
              <span className="shrink-0 font-semibold text-ink">
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
  return (
    <div className="rounded-card border border-border bg-surface p-3.5">
      <p className="text-[10px] font-semibold uppercase tracking-wide text-ink-faint mb-2">{label}</p>
      <div className="flex items-end gap-1.5 h-24">
        {trend.map((t, i) => (
          <div key={i} className="flex-1 flex flex-col items-center justify-end gap-1 min-w-0">
            <div className="w-full rounded-t bg-accent/60 hover:bg-accent transition-colors" style={{ height: `${Math.max(2, (t.revenue / max) * 100)}%` }}
              title={`${t.month}: ${integer ? t.revenue : '$' + Math.round(t.revenue).toLocaleString()}`} />
            <span className="text-[8px] text-ink-faint truncate w-full text-center">{t.month.slice(5)}</span>
          </div>
        ))}
      </div>
    </div>
  )
}
