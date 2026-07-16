'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import Link from 'next/link'
import { addDays, format, startOfMonth, subMonths } from 'date-fns'
import { createClient } from '@/lib/supabase/client'
import { useRealtimeRefresh } from '@/hooks/useRealtime'
import type { BusinessSettings, Crew, Technician, TimeEntry } from '@/types'
import { loadCrews, loadTechnicians } from '@/lib/crews'
import { loadTimeEntries, formatDuration, decimalHours } from '@/lib/timeTracking'
import { payrollRules, payPeriodFor, payrollSummary } from '@/lib/payroll'
import {
  buildLaborContext, laborByJob, laborByCustomer, laborByMonth, laborByCrew,
  technicianUtilization, reconcileToPayroll, directLabourCost,
  crewProfitability, technicianPerformance,
  type LaborBucket, type LaborJobInfo,
} from '@/lib/laborCost'
import { exportRowsToCsv } from '@/lib/csv'
import { PageHeader } from '@/components/layout/PageHeader'
import { Card, CardBody } from '@/components/ui/Card'
import { Button } from '@/components/ui/Button'
import { StatTile } from '@/components/ui/StatTile'
import { FilterPill } from '@/components/ui/FilterPill'
import { Banner } from '@/components/ui/Banner'
import { EmptyState, InlineEmpty } from '@/components/ui/EmptyState'
import { SkeletonTiles, SkeletonRows } from '@/components/ui/Skeleton'
import { toast as notify } from '@/lib/toast'
import { formatCurrency, cn } from '@/lib/utils'
import {
  BarChart3, Clock, DollarSign, Download, HardHat, Wallet, AlertTriangle, Info, Gauge,
} from 'lucide-react'

// ── Labour ───────────────────────────────────────────────────────────────────
// What the clock actually cost, and how much of it reached a job. Every number
// comes from lib/laborCost over lib/timeTracking; the payroll reconciliation
// comes from lib/payroll. This file renders and computes nothing.
//
// The costs here are DIRECT labour (clocked minutes x each shift's own rate).
// They are deliberately NOT the same number as Profitability, which models cost
// from crew_cost_per_hour x estimated minutes. One is the clock, the other is the
// forecast — the banner below says so rather than leaving two totals to collide.

type Slice = 'job' | 'customer' | 'month' | 'crew'
type Range = '1m' | '3m' | '12m'

const SLICES: { key: Slice; label: string }[] = [
  { key: 'job', label: 'By job' },
  { key: 'customer', label: 'By customer' },
  { key: 'month', label: 'By month' },
  { key: 'crew', label: 'By crew' },
]
const RANGES: { key: Range; label: string; months: number }[] = [
  { key: '1m', label: 'This month', months: 0 },
  { key: '3m', label: 'Last 3 months', months: 2 },
  { key: '12m', label: 'Last 12 months', months: 11 },
]

export default function LaborPage() {
  const supabase = useMemo(() => createClient(), [])
  const [uid, setUid] = useState<string | null>(null)
  const [settings, setSettings] = useState<BusinessSettings | null>(null)
  const [techs, setTechs] = useState<Technician[]>([])
  const [crews, setCrews] = useState<Crew[]>([])
  const [jobs, setJobs] = useState<LaborJobInfo[]>([])
  const [customers, setCustomers] = useState<{ id: string; name: string }[]>([])
  const [entries, setEntries] = useState<TimeEntry[]>([])
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [slice, setSlice] = useState<Slice>('job')
  const [range, setRange] = useState<Range>('3m')

  const window_ = useMemo(() => {
    const months = RANGES.find(r => r.key === range)!.months
    const from = startOfMonth(subMonths(new Date(), months))
    return { from, to: addDays(new Date(), 1) }
  }, [range])

  const fetchAll = useCallback(async () => {
    try {
      const { data: { session } } = await supabase.auth.getSession()
      const user = session?.user
      if (!user) { setLoadError('Session expired — sign in again.'); return }
      setUid(user.id)
      const [sRes, t, c, jRes, custRes, e] = await Promise.all([
        supabase.from('business_settings').select('*').eq('user_id', user.id).maybeSingle(),
        loadTechnicians(supabase, user.id),
        loadCrews(supabase, user.id),
        supabase.from('jobs').select('id, customer_id, scheduled_date, service_type, price, duration_minutes').eq('user_id', user.id),
        supabase.from('customers').select('id, name').eq('user_id', user.id),
        loadTimeEntries(supabase, user.id, { fromISO: window_.from.toISOString(), toISO: window_.to.toISOString() }),
      ])
      setSettings(sRes.data as BusinessSettings | null)
      setTechs(t)
      setCrews(c)
      setJobs((jRes.data as LaborJobInfo[]) ?? [])
      setCustomers((custRes.data as { id: string; name: string }[]) ?? [])
      setEntries(e)
      setLoadError(null)
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : 'Could not load labour.')
    } finally {
      setLoading(false)
    }
  }, [supabase, window_.from, window_.to])

  useEffect(() => { fetchAll() }, [fetchAll])
  useRealtimeRefresh('time_entries', uid ? `user_id=eq.${uid}` : null, fetchAll)

  const ctx = useMemo(
    () => buildLaborContext({ jobs, customers, technicians: techs, crews }),
    [jobs, customers, techs, crews],
  )

  const buckets: LaborBucket[] = useMemo(() => {
    switch (slice) {
      case 'job': return laborByJob(entries, ctx)
      case 'customer': return laborByCustomer(entries, ctx)
      case 'month': return laborByMonth(entries)
      case 'crew': return laborByCrew(entries, ctx)
    }
  }, [slice, entries, ctx])

  const util = useMemo(() => technicianUtilization(entries, ctx), [entries, ctx])
  const crewProfit = useMemo(() => crewProfitability(entries, ctx), [entries, ctx])
  const perf = useMemo(() => technicianPerformance(entries, ctx), [entries, ctx])
  const direct = useMemo(() => directLabourCost(entries), [entries])
  const totalMinutes = useMemo(() => buckets.reduce((s, b) => s + b.minutes, 0), [buckets])
  const jobMinutes = useMemo(() => util.reduce((s, u) => s + u.jobMinutes, 0), [util])
  const overallUtil = totalMinutes > 0 ? Math.round((jobMinutes / totalMinutes) * 1000) / 10 : null

  // Reconciliation against THE payroll engine for the CURRENT pay period only —
  // proving these rollups and payroll describe the same money. Derived by
  // subtraction from payroll's own total; no overtime rule is re-implemented.
  const rules = useMemo(() => payrollRules(settings), [settings])
  const reconcile = useMemo(() => {
    const period = payPeriodFor(new Date(), rules)
    const inPeriodEntries = entries.filter(e => {
      const t = new Date(e.clock_in).getTime()
      return t >= period.start.getTime() && t < addDays(period.end, 1).getTime()
    })
    const pay = payrollSummary(inPeriodEntries, techs, rules, period)
    return { period, ...reconcileToPayroll(inPeriodEntries, pay.totalPay) }
  }, [entries, techs, rules])

  function exportBuckets() {
    if (!buckets.length) { notify.error('Nothing to export in this view.'); return }
    const label = SLICES.find(s => s.key === slice)!.label.replace('By ', '')
    exportRowsToCsv(`labour-by-${label}-${format(window_.from, 'yyyy-MM-dd')}-to-${format(new Date(), 'yyyy-MM-dd')}`, buckets, [
      { label: label.charAt(0).toUpperCase() + label.slice(1), value: b => b.label },
      { label: 'Detail', value: b => b.sub ?? '' },
      { label: 'Hours', value: b => decimalHours(b.minutes) },
      { label: 'Direct labour cost', value: b => b.cost },
      { label: 'Shifts', value: b => b.entries },
      { label: 'Revenue', value: b => b.revenue ?? '' },
      { label: 'Labour as % of revenue', value: b => (b.revenue && b.revenue > 0 ? Math.round((b.cost / b.revenue) * 1000) / 10 : '') },
    ])
    notify.success(`Exported ${buckets.length} row${buckets.length !== 1 ? 's' : ''} to CSV.`)
  }

  function exportUtil() {
    if (!util.length) { notify.error('No utilization to export.'); return }
    exportRowsToCsv(`utilization-${format(window_.from, 'yyyy-MM-dd')}-to-${format(new Date(), 'yyyy-MM-dd')}`, util, [
      { label: 'Employee', value: u => u.name },
      { label: 'Crew', value: u => u.crewName ?? 'No crew' },
      { label: 'Total paid hours', value: u => decimalHours(u.totalMinutes) },
      { label: 'Hours on jobs', value: u => decimalHours(u.jobMinutes) },
      { label: 'General hours', value: u => decimalHours(u.generalMinutes) },
      { label: 'Utilization %', value: u => u.utilizationPct ?? '' },
      { label: 'Direct labour cost', value: u => u.cost },
      { label: 'Cost on jobs', value: u => u.jobCost },
    ])
    notify.success(`Exported ${util.length} employee${util.length !== 1 ? 's' : ''} to CSV.`)
  }

  function exportPerf() {
    if (!perf.length) { notify.error('No productivity data to export.'); return }
    exportRowsToCsv(`productivity-${format(window_.from, 'yyyy-MM-dd')}-to-${format(new Date(), 'yyyy-MM-dd')}`, perf, [
      { label: 'Employee', value: p => p.name },
      { label: 'Crew', value: p => p.crewName ?? 'No crew' },
      { label: 'Paid hours', value: p => decimalHours(p.totalMinutes) },
      { label: 'Hours on jobs', value: p => decimalHours(p.jobMinutes) },
      { label: 'Utilization %', value: p => p.utilizationPct ?? '' },
      { label: 'Jobs touched', value: p => p.jobsTouched },
      { label: 'Revenue share', value: p => p.revenueShare },
      { label: 'Revenue per paid hour', value: p => p.revPerHour ?? '' },
      { label: 'Estimate variance % (job-level)', value: p => p.estimateVariancePct ?? '' },
      { label: 'Direct labour cost', value: p => p.cost },
    ])
    notify.success(`Exported ${perf.length} employee${perf.length !== 1 ? 's' : ''} to CSV.`)
  }

  function exportCrewProfit() {
    if (!crewProfit.length) { notify.error('No crew data to export.'); return }
    exportRowsToCsv(`crew-profitability-${format(window_.from, 'yyyy-MM-dd')}-to-${format(new Date(), 'yyyy-MM-dd')}`, crewProfit, [
      { label: 'Crew', value: c => c.name },
      { label: 'People', value: c => c.technicians },
      { label: 'Jobs', value: c => c.jobs },
      { label: 'Hours', value: c => decimalHours(c.minutes) },
      { label: 'Revenue (share by hours)', value: c => c.revenue },
      { label: 'Direct labour cost', value: c => c.cost },
      { label: 'Profit', value: c => c.profit },
      { label: 'Margin %', value: c => c.marginPct ?? '' },
      { label: 'Revenue per labour hour', value: c => c.revPerHour ?? '' },
    ])
    notify.success(`Exported ${crewProfit.length} crew${crewProfit.length !== 1 ? 's' : ''} to CSV.`)
  }

  if (loading) {
    return (
      <div className="max-w-5xl space-y-5">
        <PageHeader crumb={{ label: 'Timesheet', href: '/dashboard/dispatch/time' }} title="Labour"
          description="What the clock actually cost, and how much of it reached a job." />
        <SkeletonTiles count={4} />
        <SkeletonRows count={5} />
      </div>
    )
  }

  return (
    <div className="max-w-5xl space-y-5">
      <PageHeader
        crumb={{ label: 'Timesheet', href: '/dashboard/dispatch/time' }}
        title="Labour"
        description="What the clock actually cost, and how much of it reached a job."
        action={
          <Link href="/dashboard/dispatch/payroll">
            <Button variant="secondary" size="sm"><Wallet className="w-3.5 h-3.5" /> Payroll</Button>
          </Link>
        }
      />

      {loadError && (
        <Banner tone="danger" icon={AlertTriangle}
          action={<Button size="sm" variant="secondary" onClick={() => { setLoading(true); fetchAll() }}>Retry</Button>}>
          {loadError}
        </Banner>
      )}

      <div className="flex items-center gap-1.5 flex-wrap">
        {RANGES.map(r => (
          <FilterPill key={r.key} active={range === r.key} onClick={() => setRange(r.key)}>{r.label}</FilterPill>
        ))}
        <span className="ml-auto text-[11px] text-ink-faint tabular-nums">
          since {format(window_.from, 'MMM d, yyyy')}
        </span>
      </div>

      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        <StatTile label="Hours worked" icon={Clock} value={formatDuration(totalMinutes)}
          sub={`${decimalHours(totalMinutes)} h`} />
        <StatTile label="Direct labour" icon={DollarSign} value={formatCurrency(direct)}
          sub="Clocked hours × their rate" accent />
        <StatTile label="On jobs" icon={Gauge}
          value={overallUtil == null ? '—' : `${overallUtil}%`}
          sub={overallUtil == null ? 'Nothing clocked yet' : `${formatDuration(jobMinutes)} of ${formatDuration(totalMinutes)}`} />
        <StatTile label="People" icon={HardHat} value={String(util.length)}
          sub={`${crews.length} crew${crews.length !== 1 ? 's' : ''}`} />
      </div>

      {/* The one thing that stops two labour numbers quietly disagreeing. */}
      <Banner tone="info" icon={Info}>
        These are <span className="font-semibold">direct labour</span> costs — clocked minutes at each
        shift’s own rate. Overtime’s extra {formatCurrency(Math.max(0, reconcile.otPremium))} this pay
        period isn’t charged to any single job (it’s caused by the week, not the job), so it lives on{' '}
        <Link href="/dashboard/dispatch/payroll" className="underline font-semibold">Payroll</Link>.
        Profitability models cost differently again — it estimates, this counts the clock.
      </Banner>

      {/* ── Utilization ── */}
      <Card>
        <CardBody className="p-0">
          <div className="px-5 py-3 border-b border-border flex items-center justify-between gap-3">
            <div className="min-w-0">
              <h2 className="text-sm font-semibold text-ink">Utilization</h2>
              <p className="text-[11px] text-ink-faint">Share of paid time booked to a job — the rest is yard, travel and shop.</p>
            </div>
            <Button variant="secondary" size="sm" onClick={exportUtil} disabled={!util.length} className="shrink-0">
              <Download className="w-3.5 h-3.5" /> CSV
            </Button>
          </div>
          {util.length === 0 ? (
            <InlineEmpty icon={HardHat}>No hours clocked in this window.</InlineEmpty>
          ) : (
            <div className="divide-y divide-border">
              {util.map(u => (
                <div key={u.technicianId} className="px-5 py-3 flex items-center gap-3">
                  <div className="min-w-0 flex-1">
                    <p className="text-sm font-medium text-ink truncate">
                      {u.name}
                      {u.crewName && <span className="text-[11px] font-normal text-ink-faint"> · {u.crewName}</span>}
                    </p>
                    <p className="text-[11px] text-ink-faint tabular-nums">
                      {formatDuration(u.jobMinutes)} on jobs · {formatDuration(u.generalMinutes)} general · {formatCurrency(u.cost)}
                    </p>
                  </div>
                  {/* A meter, not just a number — read at a glance. */}
                  <div className="flex items-center gap-2 shrink-0">
                    <span className="w-16 h-1.5 rounded-full bg-border overflow-hidden hidden sm:block">
                      <span className="block h-full rounded-full bg-accent/80"
                        style={{ width: `${Math.min(100, Math.max(2, u.utilizationPct ?? 0))}%` }} />
                    </span>
                    <span className={cn('text-sm font-bold tabular-nums w-14 text-right',
                      u.utilizationPct == null ? 'text-ink-faint' : 'text-ink')}>
                      {u.utilizationPct == null ? '—' : `${u.utilizationPct}%`}
                    </span>
                  </div>
                </div>
              ))}
            </div>
          )}
        </CardBody>
      </Card>

      {/* ── Crew profitability ── */}
      {crewProfit.length > 0 && (
        <Card>
          <CardBody className="p-0">
            <div className="px-5 py-3 border-b border-border flex items-center justify-between gap-3">
              <div className="min-w-0">
                <h2 className="text-sm font-semibold text-ink">Crew profitability</h2>
                <p className="text-[11px] text-ink-faint">
                  Revenue shared between crews by the hours each actually clocked on a job.
                </p>
              </div>
              <Button variant="secondary" size="sm" onClick={exportCrewProfit} className="shrink-0">
                <Download className="w-3.5 h-3.5" /> CSV
              </Button>
            </div>
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-border">
                    <th className="text-left px-5 py-2.5 text-[10px] font-semibold text-ink-faint uppercase tracking-wide">Crew</th>
                    <th className="text-right px-3 py-2.5 text-[10px] font-semibold text-ink-faint uppercase tracking-wide">Revenue</th>
                    <th className="text-right px-3 py-2.5 text-[10px] font-semibold text-ink-faint uppercase tracking-wide">Labour</th>
                    <th className="text-right px-3 py-2.5 text-[10px] font-semibold text-ink-faint uppercase tracking-wide hidden sm:table-cell">Rev/hr</th>
                    <th className="text-right px-5 py-2.5 text-[10px] font-semibold text-ink-faint uppercase tracking-wide">Profit</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border">
                  {crewProfit.map(c => (
                    <tr key={c.crewId} className="hover:bg-surface-raised transition-colors">
                      <td className="px-5 py-3">
                        <p className="font-medium text-ink truncate">{c.name}</p>
                        <p className="text-[11px] text-ink-faint tabular-nums">
                          {c.technicians} {c.technicians !== 1 ? 'people' : 'person'} · {c.jobs} job{c.jobs !== 1 ? 's' : ''} · {formatDuration(c.minutes)}
                        </p>
                      </td>
                      <td className="px-3 py-3 text-right tabular-nums text-ink">{formatCurrency(c.revenue)}</td>
                      <td className="px-3 py-3 text-right tabular-nums text-ink-muted">{formatCurrency(c.cost)}</td>
                      <td className="px-3 py-3 text-right tabular-nums text-ink-muted hidden sm:table-cell">
                        {c.revPerHour == null ? '—' : `${formatCurrency(c.revPerHour)}/h`}
                      </td>
                      <td className="px-5 py-3 text-right tabular-nums">
                        <span className={cn('font-bold', c.profit >= 0 ? 'text-ink' : 'text-red-400')}>
                          {formatCurrency(c.profit)}
                        </span>
                        {c.marginPct != null && (
                          <span className="block text-[11px] text-ink-faint">{c.marginPct}% margin</span>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </CardBody>
        </Card>
      )}

      {/* ── Productivity ── */}
      {perf.length > 0 && (
        <Card>
          <CardBody className="p-0">
            <div className="px-5 py-3 border-b border-border flex items-center justify-between gap-3">
              <div className="min-w-0">
                <h2 className="text-sm font-semibold text-ink">Productivity</h2>
                <p className="text-[11px] text-ink-faint">Sorted by hours worked — deliberately not ranked.</p>
              </div>
              <Button variant="secondary" size="sm" onClick={exportPerf} className="shrink-0">
                <Download className="w-3.5 h-3.5" /> CSV
              </Button>
            </div>
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-border">
                    <th className="text-left px-5 py-2.5 text-[10px] font-semibold text-ink-faint uppercase tracking-wide">Person</th>
                    <th className="text-right px-3 py-2.5 text-[10px] font-semibold text-ink-faint uppercase tracking-wide">Jobs</th>
                    <th className="text-right px-3 py-2.5 text-[10px] font-semibold text-ink-faint uppercase tracking-wide hidden sm:table-cell">Rev/hr</th>
                    <th className="text-right px-5 py-2.5 text-[10px] font-semibold text-ink-faint uppercase tracking-wide">Vs estimate</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border">
                  {perf.map(p => (
                    <tr key={p.technicianId} className="hover:bg-surface-raised transition-colors">
                      <td className="px-5 py-3">
                        <p className="font-medium text-ink truncate">
                          {p.name}
                          {p.crewName && <span className="text-[11px] font-normal text-ink-faint"> · {p.crewName}</span>}
                        </p>
                        <p className="text-[11px] text-ink-faint tabular-nums">
                          {formatDuration(p.totalMinutes)} paid · {p.utilizationPct ?? '—'}% on jobs
                        </p>
                      </td>
                      <td className="px-3 py-3 text-right tabular-nums text-ink">
                        {p.jobsTouched}
                        <span className="block text-[11px] text-ink-faint">{formatCurrency(p.revenueShare)}</span>
                      </td>
                      <td className="px-3 py-3 text-right tabular-nums text-ink-muted hidden sm:table-cell">
                        {p.revPerHour == null ? '—' : `${formatCurrency(p.revPerHour)}/h`}
                      </td>
                      <td className="px-5 py-3 text-right tabular-nums">
                        {p.estimateVariancePct == null ? <span className="text-ink-faint">—</span> : (
                          <span className={cn(p.estimateVariancePct > 15 ? 'text-amber-400 font-semibold' : 'text-ink-muted')}>
                            {p.estimateVariancePct > 0 ? '+' : ''}{p.estimateVariancePct}%
                          </span>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {/* These numbers get used in conversations about people's pay. Say
                what they can't tell you, right where they're read. */}
            <div className="px-5 py-3 border-t border-border">
              <p className="text-[11px] text-ink-faint">
                Read these together, not as a score. Revenue per hour reflects the jobs someone was
                <em> given</em>, not how fast they work. “Vs estimate” compares a whole job against its
                estimate — it judges the estimate as much as the person, and a job with two people on it
                shares one estimate. EdgeQuote won’t rank your crew for you.
              </p>
            </div>
          </CardBody>
        </Card>
      )}

      {/* ── Cost breakdown ── */}
      <Card>
        <CardBody className="p-0">
          <div className="px-5 py-3 border-b border-border flex items-center justify-between gap-3 flex-wrap">
            <h2 className="text-sm font-semibold text-ink">Labour cost</h2>
            <div className="flex items-center gap-1.5 flex-wrap">
              {SLICES.map(s => (
                <FilterPill key={s.key} active={slice === s.key} onClick={() => setSlice(s.key)}>{s.label}</FilterPill>
              ))}
              <Button variant="secondary" size="sm" onClick={exportBuckets} disabled={!buckets.length}>
                <Download className="w-3.5 h-3.5" /> CSV
              </Button>
            </div>
          </div>

          {buckets.length === 0 ? (
            techs.length === 0 ? (
              <EmptyState icon={HardHat} className="py-12" title="No one on the roster yet"
                description="Add your people under Crews & roster on the dispatch board, then clock them in." />
            ) : (
              <EmptyState icon={BarChart3} className="py-12" title="No labour yet"
                description="Clock someone in on the timesheet — once shifts are closed, their cost shows up here." />
            )
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-border">
                    <th className="text-left px-5 py-2.5 text-[10px] font-semibold text-ink-faint uppercase tracking-wide">
                      {SLICES.find(s => s.key === slice)!.label.replace('By ', '')}
                    </th>
                    <th className="text-right px-3 py-2.5 text-[10px] font-semibold text-ink-faint uppercase tracking-wide">Hours</th>
                    <th className="text-right px-3 py-2.5 text-[10px] font-semibold text-ink-faint uppercase tracking-wide hidden sm:table-cell">Revenue</th>
                    <th className="text-right px-3 py-2.5 text-[10px] font-semibold text-ink-faint uppercase tracking-wide hidden sm:table-cell">Labour %</th>
                    <th className="text-right px-5 py-2.5 text-[10px] font-semibold text-ink-faint uppercase tracking-wide">Cost</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border">
                  {buckets.map(b => {
                    const pct = b.revenue && b.revenue > 0 ? Math.round((b.cost / b.revenue) * 1000) / 10 : null
                    return (
                      <tr key={b.key} className="hover:bg-surface-raised transition-colors">
                        <td className="px-5 py-3">
                          <p className="font-medium text-ink truncate">{b.label}</p>
                          {b.sub && <p className="text-[11px] text-ink-faint truncate">{b.sub}</p>}
                        </td>
                        <td className="px-3 py-3 text-right tabular-nums text-ink">
                          {formatDuration(b.minutes)}
                          <span className="block text-[11px] text-ink-faint">{b.entries} shift{b.entries !== 1 ? 's' : ''}</span>
                        </td>
                        <td className="px-3 py-3 text-right tabular-nums text-ink-muted hidden sm:table-cell">
                          {b.revenue == null ? '—' : formatCurrency(b.revenue)}
                        </td>
                        <td className="px-3 py-3 text-right tabular-nums hidden sm:table-cell">
                          {pct == null ? <span className="text-ink-faint">—</span> : (
                            // Labour eating >50% of a job's price is worth a look, not an alarm.
                            <span className={cn(pct > 50 ? 'text-amber-400 font-semibold' : 'text-ink-muted')}>{pct}%</span>
                          )}
                        </td>
                        <td className="px-5 py-3 text-right font-bold text-ink tabular-nums">{formatCurrency(b.cost)}</td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
          )}
        </CardBody>
      </Card>

      <p className="text-[11px] text-ink-faint text-center">
        Only closed shifts have a cost — someone still on the clock hasn’t finished the hour yet.
        Hours with no wage set count as time but cost $0.
      </p>
    </div>
  )
}
