'use client'

import { useEffect, useMemo, useState } from 'react'
import { createClient } from '@/lib/supabase/client'
import { loadBusinessIntelligence, BIReport, NamedValue, WeekdayStat, YearComparison } from '@/lib/businessIntelligence'
import { loadLaborInsights, LaborInsights, ServiceAccuracy, ServiceProfit } from '@/lib/labor'
import { PageHeader } from '@/components/layout/PageHeader'
import { Skeleton, SkeletonTiles } from '@/components/ui/Skeleton'
import { EmptyState, InlineEmpty } from '@/components/ui/EmptyState'
import { StatTile } from '@/components/ui/StatTile'
import { Collapsible } from '@/components/ui/Collapsible'
import { readCache, writeCache, CACHE_TTL } from '@/lib/clientCache'
import { AnalyticsWorkspace, WidgetChrome, useWidget } from '@/components/analytics/Workspace'
import type { WidgetId } from '@/lib/analytics/layout'
import { formatCurrency, cn } from '@/lib/utils'
import type { Tone } from '@/lib/tone'
import { TrendingUp, TrendingDown, DollarSign, Gauge, Users, Target, Activity, LineChart, Home, AlertTriangle, CalendarDays, Ban, Briefcase } from 'lucide-react'

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

      {/* Every section below is a workspace widget: arrangeable and hideable, but
          still rendered from the same BIReport, so customising the page can never
          change what a number means — only whether and where you see it. */}
      <AnalyticsWorkspace>

      {/* ── EXECUTIVE ── The highest-altitude read on the page, so it leads: who the
          revenue depends on, whether it's compounding, and how fast it turns into
          cash. Every figure here is YTD. */}
      <Section id="executive" title="Executive" icon={Briefcase}>
        {/* `payingCustomers === 0` is the one check that keeps a wall of "0%" off
            the page — with no YTD revenue there are no shares to take a share of. */}
        {bi.executive.concentration.payingCustomers === 0 ? (
          <div className="rounded-card border border-border bg-bg-secondary p-4">
            <InlineEmpty icon={Briefcase} className="py-3">No revenue yet this year — concentration, mix and collection speed fill in as work completes and invoices are paid.</InlineEmpty>
          </div>
        ) : (
          <div className="grid grid-cols-2 lg:grid-cols-3 gap-3">
            {/* Tint ONLY at >=30%: for a 1-3 person shop, one customer at a third of
                the year's revenue is a dependency risk, not a fun fact. Below that
                it's an unremarkable number and gets no colour. */}
            <Stat label="Top customer share"
              value={bi.executive.concentration.top1Pct != null ? `${bi.executive.concentration.top1Pct}%` : '—'}
              tone={bi.executive.concentration.top1Pct != null && bi.executive.concentration.top1Pct >= 30 ? 'warn' : undefined}
              sub={
                <span className="tabular-nums">
                  {bi.executive.concentration.top1Name ?? 'Top customer'}
                  {bi.executive.concentration.top3Pct != null && ` · top 3 = ${bi.executive.concentration.top3Pct}%`}
                </span>
              } />
            {/* NEW = first ever completed visit falls this year, so last season's
                customer still on the books reads as returning. */}
            <Stat label="Revenue from new customers"
              value={bi.executive.mix.newPct != null ? `${bi.executive.mix.newPct}%` : '—'}
              sub={<span className="tabular-nums">{formatCurrency(bi.executive.mix.newRevenue)} new · {formatCurrency(bi.executive.mix.returningRevenue)} returning</span>} />
            {/* Speed of collection — a median over PAID invoices only. It is NOT
                receivables aging: nothing unpaid is in this number. The sample size
                rides along because a median over 2 invoices isn't a trend. */}
            <Stat label="Median time to get paid"
              value={bi.executive.collection.medianDaysToPay != null ? `${bi.executive.collection.medianDaysToPay} ${bi.executive.collection.medianDaysToPay === 1 ? 'day' : 'days'}` : '—'}
              tone={bi.executive.collection.medianDaysToPay != null && bi.executive.collection.medianDaysToPay > 14 ? 'warn' : undefined}
              sub={
                <span className="tabular-nums">
                  {bi.executive.collection.medianDaysToPay != null
                    ? `across ${bi.executive.collection.paidInvoices} paid invoice${bi.executive.collection.paidInvoices === 1 ? '' : 's'}`
                    : 'No invoices paid yet'}
                </span>
              } />
          </div>
        )}
      </Section>

      {/* ── FINANCIAL ── */}
      <Section id="financial" title="Financial" icon={DollarSign}>
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
          <Stat label="Revenue this month" value={formatCurrency(bi.financial.revenueThisMonth)} delta={bi.financial.monthOverMonthPct} deltaLabel="vs last month" />
          <Stat label="Revenue last month" value={formatCurrency(bi.financial.revenueLastMonth)} />
          <Stat label="Revenue YTD" value={formatCurrency(bi.financial.revenueYTD)} />
          <Stat label="Projected this month" value={formatCurrency(bi.forecasting.projectedThisMonth)} accent />
        </div>
        <TrendBars trend={bi.financial.trend} />
        {/* Average job value, on the SAME 12-month axis as the revenue trend above so
            the two read together month-for-month: revenue rising on flat job value =
            more work; revenue rising on rising job value = better-paid work. Those
            call for opposite responses. Months with no jobs pass through as null and
            TrendBars draws them as a gap — dropping them would slide this chart's
            months out of step with the one directly above it. */}
        <TrendBars label="Average job value"
          trend={bi.financial.trend.map(t => ({ month: t.month, revenue: t.avgJobValue }))} />
        <div className="grid md:grid-cols-3 gap-3">
          <RankList title="By service" items={bi.financial.byService} fmt={formatCurrency} />
          <RankList title="By neighborhood" items={bi.financial.byNeighborhood} fmt={formatCurrency} subFmt={v => `$${v}/hr`} />
          <RankList title="Top customers" items={bi.financial.byCustomer} fmt={formatCurrency} />
        </div>
      </Section>

      {/* ── THIS YEAR VS LAST ── Both sides are SEASON-TO-DATE (the engine cuts last
          year at the same month-day), so the delta is like-for-like and safe as a
          headline. Never label it "vs last year (full)". */}
      <Section id="yearly" title="This year vs last" icon={TrendingUp}>
        <div className="grid grid-cols-2 lg:grid-cols-3 gap-3">
          <Stat label="Revenue this year" value={formatCurrency(bi.yearly.thisYear.revenue)}
            delta={bi.yearly.revenueDeltaPct} deltaLabel="vs last year to date"
            sub={bi.yearly.lastYear ? `${formatCurrency(bi.yearly.lastYear.revenue)} at this point last season` : 'season to date'} />
          <Stat label="Jobs this year" value={String(bi.yearly.thisYear.jobs)}
            delta={bi.yearly.jobsDeltaPct} deltaLabel="vs last year to date"
            sub={bi.yearly.lastYear ? `${bi.yearly.lastYear.jobs} at this point last season` : 'season to date'} />
          <Stat label="Profit this year" value={bi.yearly.thisYear.profit != null ? formatCurrency(bi.yearly.thisYear.profit) : '—'} sub="season to date" accent />
        </div>
        {bi.yearly.lastYear ? (
          <YearMonthList byMonth={bi.yearly.byMonth} thisYear={bi.yearly.thisYear.year} lastYear={bi.yearly.lastYear.year} />
        ) : (
          // First season — a null prior year is "nothing to compare", never −100%.
          <div className="rounded-card border border-border bg-bg-secondary p-4">
            <InlineEmpty icon={LineChart} className="py-3">First season — no prior year to compare yet. Next year this shows your growth month by month.</InlineEmpty>
          </div>
        )}
      </Section>

      {/* ── PROFITABILITY ── */}
      <Section id="profitability" title="Profitability" icon={Gauge}>
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
      <Section id="customers" title="Customers" icon={Users}>
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
          <Stat label="Active customers" value={String(bi.customers.active)} sub={`${bi.customers.total} total`} />
          <Stat label="Retention rate" value={bi.customers.retentionRatePct != null ? `${bi.customers.retentionRatePct}%` : '—'} sub={bi.customers.churnRatePct != null ? `${bi.customers.churnRatePct}% churn` : 'recurring only'} />
          <Stat label="Avg lifetime value" value={formatCurrency(bi.customers.avgLifetimeValue)} sub={`forecast ${formatCurrency(bi.customers.forecastLtv)}`} />
          <Stat label="New this month" value={`+${bi.customers.newThisMonth}`} sub={`avg ${formatCurrency(bi.customers.avgAnnualValue)}/yr`} accent />
        </div>
        <TrendBars trend={bi.customers.growth.map(g => ({ month: g.name, revenue: g.value }))} label="New customers / month" integer />
      </Section>

      {/* ── SALES ── */}
      <Section id="sales" title="Sales" icon={Target}>
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
      <Section id="operations" title="Operations" icon={Activity}>
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

      {/* ── BUSIEST DAYS ── */}
      <Section id="weekday" title="Busiest days" icon={CalendarDays}>
        {/* `busiest` is null exactly when no weekday has a completed job — the one
            check that keeps a table of zeroes off the page. */}
        {bi.weekday.busiest ? (
          <>
            <div className="grid grid-cols-2 gap-3">
              <Stat label="Busiest day" value={bi.weekday.busiest.label}
                sub={`${bi.weekday.busiest.jobs} job${bi.weekday.busiest.jobs === 1 ? '' : 's'} · ${formatCurrency(bi.weekday.busiest.revenue)}`} accent />
              <Stat label="Best-paying day" value={bi.weekday.bestPaying?.label ?? '—'}
                sub={bi.weekday.bestPaying?.revPerHour != null ? `$${bi.weekday.bestPaying.revPerHour}/hr` : 'needs completed work'} />
            </div>
            <WeekdayBreakdown rows={bi.weekday.byWeekday} busiest={bi.weekday.busiest.weekday} />
          </>
        ) : (
          <div className="rounded-card border border-border bg-bg-secondary p-4">
            <InlineEmpty className="py-3">No completed work yet — this fills in as jobs complete.</InlineEmpty>
          </div>
        )}
      </Section>

      {/* ── CANCELLATIONS ── A risk metric: the one section where a tint carries
          alarm rather than confidence. */}
      <Section id="cancellations" title="Cancellations" icon={Ban}>
        {bi.cancellations.cancelledYTD === 0 ? (
          <div className="rounded-card border border-border bg-bg-secondary">
            <EmptyState icon={Ban} tone="positive" className="py-10" title="Nothing cancelled this year"
              description={bi.cancellations.completedYTD > 0
                ? `All ${bi.cancellations.completedYTD} job${bi.cancellations.completedYTD === 1 ? '' : 's'} booked this year went ahead.`
                : 'No cancellations on the books this year.'} />
          </div>
        ) : (
          <>
            <div className="grid grid-cols-2 lg:grid-cols-3 gap-3">
              <Stat label="Cancelled YTD" value={String(bi.cancellations.cancelledYTD)} tone="warn"
                sub={`of ${bi.cancellations.cancelledYTD + bi.cancellations.completedYTD} booked jobs`} />
              <Stat label="Cancellation rate" value={bi.cancellations.cancelRatePct != null ? `${bi.cancellations.cancelRatePct}%` : '—'} tone="warn" sub="of booked jobs this year" />
              <Stat label="Worst month" value={bi.cancellations.worstMonth ? monthLabel(bi.cancellations.worstMonth) : '—'} sub="most jobs lost" />
            </div>
            {/* Same 12-month window as the revenue trend above, so the two line up. */}
            <TrendBars trend={bi.cancellations.trend.map(t => ({ month: t.name, revenue: t.value }))} label="Cancelled jobs / month" integer tone="warn" />
          </>
        )}
      </Section>

      {/* ── LABOUR ACCURACY & CREW EFFICIENCY ── (merged from the former Labor
          Intelligence page). Collapsed by default — it's a deep-dive, not a daily
          decision; the one-line summary keeps the headline number visible. */}
      {/* Not a <Section>, but it IS a block on this page — so it joins the
          workspace too rather than being the one thing that won't move. */}
      <LaborWidget>
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
      </LaborWidget>

      {/* ── FORECASTING ── ("Projected this month" lives once, in Financial above) */}
      <Section id="forecasting" title="Forecasting" icon={LineChart}>
        <div className="grid grid-cols-2 lg:grid-cols-3 gap-3">
          <Stat label="Recurring run-rate" value={formatCurrency(bi.forecasting.projectedRecurringAnnual)} sub="/yr locked in" accent />
          <Stat label="Rest of season" value={formatCurrency(bi.forecasting.projectedSeasonRemaining)} sub="recurring booked" />
          <Stat label="Growth trend" value={bi.forecasting.growthForecastPct != null ? `${bi.forecasting.growthForecastPct > 0 ? '+' : ''}${bi.forecasting.growthForecastPct}%` : '—'} delta={bi.forecasting.growthForecastPct} deltaLabel="3-mo revenue" />
        </div>
      </Section>
      </AnalyticsWorkspace>
    </div>
  )
}

function cap(s: string) { return s.replace(/_/g, ' ').replace(/^\w/, c => c.toUpperCase()) }
/** 'yyyy-MM' → 'Jun 2026'. Same formatting path as `generatedFor`. */
function monthLabel(key: string) { return new Date(`${key}-01T00:00:00`).toLocaleString('en-US', { month: 'short', year: 'numeric' }) }
/** 1-12 → 'Jun'. */
function monthShort(m: number) { return new Date(2000, m - 1, 1).toLocaleString('en-US', { month: 'short' }) }

// The Labour block is a <Collapsible>, not a <Section>, so it gets a thin wrapper
// to join the workspace rather than being the one block that refuses to move.
function LaborWidget({ children }: { children: React.ReactNode }) {
  const { style, className, dragProps } = useWidget('labor')
  return (
    <div style={style} className={cn('animate-rise', className)} {...dragProps}>
      <div className="flex items-center justify-end -mb-1"><WidgetChrome id="labor" /></div>
      {children}
    </div>
  )
}

// Sections are the workspace's widgets. `id` is all a section needs to become
// arrangeable — order, hiding and drag all come from the workspace context, so
// the markup below stays exactly where it is and doesn't know it can move.
function Section({ id, title, icon: Icon, children }: { id: WidgetId; title: string; icon: typeof DollarSign; children: React.ReactNode }) {
  const { style, className, dragProps } = useWidget(id)
  return (
    <div style={style} className={cn('space-y-3 animate-rise', className)} {...dragProps}>
      <div className="flex items-center gap-2.5">
        <span className="w-6 h-6 rounded-md bg-accent/10 border border-accent/20 flex items-center justify-center shrink-0">
          <Icon className="w-3.5 h-3.5 text-accent-text" />
        </span>
        <p className="text-sm font-semibold tracking-tight text-ink">{title}</p>
        <span className="flex-1 h-px bg-border" aria-hidden />
        <WidgetChrome id={id} />
      </div>
      {children}
    </div>
  )
}

// Thin adapter over the ONE shared KPI tile — the delta (▲/▼ vs last period)
// renders as the tile's `sub` node, so the change is highlighted right under
// the number without a second tile style existing anywhere.
function Stat({ label, value, sub, delta, deltaLabel, accent, tone }: { label: string; value: string; sub?: React.ReactNode; delta?: number | null; deltaLabel?: string; accent?: boolean; tone?: Tone }) {
  const deltaNode = delta != null ? (
    <span className={cn('font-semibold inline-flex items-center gap-1 tabular-nums', delta >= 0 ? 'text-emerald-400' : 'text-red-400')}>
      {delta >= 0 ? <TrendingUp className="w-3 h-3" /> : <TrendingDown className="w-3 h-3" />}
      {delta > 0 ? '+' : ''}{delta}% {deltaLabel && <span className="text-ink-faint font-normal">{deltaLabel}</span>}
    </span>
  ) : null
  return <StatTile label={label} value={<span className="tabular-nums">{value}</span>} accent={accent} tone={tone} sub={deltaNode ?? sub} />
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
                  'w-4 h-4 rounded text-[10px] font-bold flex items-center justify-center shrink-0 tabular-nums',
                  i === 0 ? 'bg-accent/15 text-accent-text' : 'bg-bg-tertiary text-ink-faint'
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

// Bar palette. `accent` is the default everywhere; `warn` exists only for RISK
// series (cancellations) — the design language reserves tint for alarm, never
// for confidence. Literal class strings so Tailwind keeps them.
const BAR_TONE = {
  accent: {
    current: 'bg-gradient-to-t from-accent/70 to-accent',
    peak: 'bg-gradient-to-t from-accent/35 to-accent/70 opacity-90',
    rest: 'bg-gradient-to-t from-accent/20 to-accent/50 opacity-80',
  },
  warn: {
    current: 'bg-gradient-to-t from-amber-500/70 to-amber-400',
    peak: 'bg-gradient-to-t from-amber-500/35 to-amber-500/70 opacity-90',
    rest: 'bg-gradient-to-t from-amber-500/20 to-amber-500/50 opacity-80',
  },
} as const

// `revenue: null` = NO DATA for that month, which is not the same story as $0 — a
// month you never worked must read as a gap, not a floored stub labelled zero.
// Nullable so every chart on this page can keep the SAME 12-month axis: filtering
// empty months out instead would silently shift one chart's months out of step
// with the one beside it, and make "latest" name a month that isn't the latest.
function TrendBars({ trend, label = 'Revenue / month', integer = false, tone = 'accent' }: { trend: { month: string; revenue: number | null }[]; label?: string; integer?: boolean; tone?: keyof typeof BAR_TONE }) {
  if (!trend.length) return null
  const values = trend.map(t => t.revenue).filter((v): v is number => v != null)
  if (!values.length) return null
  const max = Math.max(1, ...values)
  const best = Math.max(0, ...values)
  const fmt = (v: number) => integer ? String(v) : '$' + Math.round(v).toLocaleString()
  const latest = trend[trend.length - 1]
  return (
    <div className="rounded-card border border-border bg-bg-secondary p-4">
      <div className="flex items-baseline justify-between gap-3 mb-3">
        <p className="text-[10px] font-semibold uppercase tracking-[0.14em] text-ink-faint">{label}</p>
        {latest && <p className="text-xs text-ink-muted tabular-nums">{latest.month.slice(5)}: <span className="font-semibold text-ink">{latest.revenue != null ? fmt(latest.revenue) : '—'}</span></p>}
      </div>
      <div className="flex items-end gap-1.5 h-24">
        {trend.map((t, i) => {
          const current = i === trend.length - 1
          // No data → a hairline on the baseline, never a bar. It holds the month's
          // slot on the axis (so this chart stays aligned with its neighbours) while
          // reading as "nothing here", which a 3%-floored stub would not.
          if (t.revenue == null) {
            return (
              <div key={i} className="flex-1 flex flex-col items-center justify-end gap-1.5 min-w-0">
                <div className="w-full h-px bg-border rounded-full" title={`${t.month}: no jobs`} />
                <span className="text-[10px] truncate w-full text-center tabular-nums text-ink-faint/60">{t.month.slice(5)}</span>
              </div>
            )
          }
          return (
            <div key={i} className="flex-1 flex flex-col items-center justify-end gap-1.5 min-w-0 group/bar">
              <div
                className={cn(
                  'w-full rounded-t-md transition-all duration-200 group-hover/bar:opacity-100',
                  current
                    ? BAR_TONE[tone].current
                    : t.revenue === best && best > 0
                      ? BAR_TONE[tone].peak
                      : BAR_TONE[tone].rest,
                )}
                style={{ height: `${Math.max(3, (t.revenue / max) * 100)}%` }}
                title={`${t.month}: ${fmt(t.revenue)}`}
              />
              <span className={cn('text-[10px] truncate w-full text-center tabular-nums', current ? 'text-ink-muted font-semibold' : 'text-ink-faint')}>{t.month.slice(5)}</span>
            </div>
          )
        })}
      </div>
    </div>
  )
}

// Sun..Sat in calendar order — NOT a ranking, so it deliberately skips RankList's
// numbered badges (a chronological list with 1..7 medals would read as a league
// table). Zero-job days stay in place to show the shape of the week, but their
// money columns render '—': a day you never work isn't a $0/hr day.
function WeekdayBreakdown({ rows, busiest }: { rows: WeekdayStat[]; busiest: number }) {
  return (
    <div className="rounded-card border border-border bg-bg-secondary p-4">
      <p className="text-[10px] font-semibold uppercase tracking-[0.14em] text-ink-faint mb-2.5">Every weekday</p>
      <ul className="space-y-2">
        {rows.map(w => {
          const worked = w.jobs > 0
          return (
            <li key={w.weekday} className="flex items-center justify-between gap-2 text-sm">
              <span className={cn('truncate', !worked ? 'text-ink-faint' : w.weekday === busiest ? 'text-ink font-medium' : 'text-ink')}>{w.label}</span>
              <span className="shrink-0 flex items-center gap-3 tabular-nums">
                <span className={cn('text-xs w-14 text-right', worked ? 'text-ink-muted' : 'text-ink-faint')}>{w.jobs} job{w.jobs === 1 ? '' : 's'}</span>
                <span className={cn('w-20 text-right font-semibold', worked ? 'text-ink' : 'text-ink-faint font-normal')}>{worked ? formatCurrency(w.revenue) : '—'}</span>
                <span className="w-16 text-right text-[11px] text-ink-faint font-normal">{w.revPerHour != null ? `$${w.revPerHour}/hr` : '—'}</span>
              </span>
            </li>
          )
        })}
      </ul>
    </div>
  )
}

// This year vs last, month by month. A null `lastYear` is NO DATA (an unworked
// month and a $0 month are different stories) — it renders as a gap, never a zero.
// Months with nothing on either side are dropped: they're padding, not signal.
function YearMonthList({ byMonth, thisYear, lastYear }: { byMonth: YearComparison['byMonth']; thisYear: string; lastYear: string }) {
  const rows = byMonth.filter(m => m.thisYear > 0 || (m.lastYear ?? 0) > 0)
  return (
    <div className="rounded-card border border-border bg-bg-secondary p-4">
      <div className="flex items-baseline justify-between gap-3 mb-2.5">
        <p className="text-[10px] font-semibold uppercase tracking-[0.14em] text-ink-faint">Revenue by month</p>
        <p className="text-xs text-ink-faint tabular-nums">{thisYear} vs {lastYear}</p>
      </div>
      {rows.length === 0 ? (
        <InlineEmpty className="py-3">No revenue recorded in either year yet.</InlineEmpty>
      ) : (
        <ul className="space-y-2">
          {rows.map(m => (
            <li key={m.month} className="flex items-center justify-between gap-2 text-sm">
              <span className="text-ink truncate">{monthShort(m.month)}</span>
              <span className="shrink-0 tabular-nums">
                <span className="font-semibold text-ink">{formatCurrency(m.thisYear)}</span>
                <span className="text-[11px] text-ink-faint font-normal ml-1.5">
                  {m.lastYear != null ? `vs ${formatCurrency(m.lastYear)}` : 'no data last year'}
                </span>
              </span>
            </li>
          ))}
        </ul>
      )}
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
