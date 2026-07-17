'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import Link from 'next/link'
import { addDays, format, startOfWeek, endOfWeek, subMonths, startOfMonth } from 'date-fns'
import { createClient } from '@/lib/supabase/client'
import { useRealtimeRefresh } from '@/hooks/useRealtime'
import type { BusinessSettings, Crew, PayRun, PtoEntry, Technician, TimeEntry, WageHistoryEntry } from '@/types'
import { loadCrews, loadTechnicians } from '@/lib/crews'
import { loadTimeEntries, decimalHours, formatDuration } from '@/lib/timeTracking'
import { payrollRules, payPeriodFor, overtimeOff } from '@/lib/payroll'
import { buildDraftPayRun } from '@/lib/payRun'
import { buildLaborContext } from '@/lib/laborCost'
import {
  availabilityToday, overtimeInsight, workloadBalance, crewUtilization,
  laborTrend, forecastNextPeriod, ptoAnalytics, wageTrends, payRunStats,
} from '@/lib/workforce'
import { PageHeader } from '@/components/layout/PageHeader'
import { Card, CardBody } from '@/components/ui/Card'
import { Button } from '@/components/ui/Button'
import { StatTile } from '@/components/ui/StatTile'
import { Banner } from '@/components/ui/Banner'
import { EmptyState, InlineEmpty } from '@/components/ui/EmptyState'
import { SkeletonTiles, SkeletonRows } from '@/components/ui/Skeleton'
import { formatCurrency, cn } from '@/lib/utils'
import {
  HardHat, Clock, Wallet, Timer, AlertTriangle, Palmtree, BarChart3, TrendingUp, TrendingDown,
  Lock, ArrowRight, Gauge, Scale, CalendarDays, Info, History,
} from 'lucide-react'

// ── Workforce ────────────────────────────────────────────────────────────────
// The landing page for everything about your people. It EXISTS largely because
// payroll didn't: it was 3–5 clicks deep inside Dispatch, absent from the sidebar
// and invisible to ⌘K. This is now a registered module (lib/modules), so the
// sidebar, the palette and the Modules manager all find it from one definition.
//
// Every number is read from lib/workforce, which itself only re-slices
// lib/payroll / lib/payRun / lib/laborCost / lib/pto. No maths lives here, and no
// payroll maths lives in lib/workforce either — if a figure here disagreed with
// the Payroll page, that would be a bug, not a different opinion.

export default function WorkforcePage() {
  const supabase = useMemo(() => createClient(), [])
  const [uid, setUid] = useState<string | null>(null)
  const [settings, setSettings] = useState<BusinessSettings | null>(null)
  const [techs, setTechs] = useState<Technician[]>([])
  const [crews, setCrews] = useState<Crew[]>([])
  const [entries, setEntries] = useState<TimeEntry[]>([])
  const [ptoEntries, setPtoEntries] = useState<PtoEntry[]>([])
  const [runs, setRuns] = useState<PayRun[]>([])
  const [wageHistory, setWageHistory] = useState<WageHistoryEntry[]>([])
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState<string | null>(null)

  const fetchAll = useCallback(async () => {
    try {
      const { data: { session } } = await supabase.auth.getSession()
      const user = session?.user
      if (!user) { setLoadError('Session expired — sign in again.'); return }
      setUid(user.id)
      // A year back covers the trend + forecast window and the PTO year.
      const from = startOfMonth(subMonths(new Date(), 12))
      const [sRes, t, c, e, pRes, rRes, wRes] = await Promise.all([
        supabase.from('business_settings').select('*').eq('user_id', user.id).maybeSingle(),
        loadTechnicians(supabase, user.id),
        loadCrews(supabase, user.id),
        loadTimeEntries(supabase, user.id, { fromISO: from.toISOString(), toISO: addDays(new Date(), 1).toISOString() }),
        supabase.from('pto_entries').select('*').eq('user_id', user.id).gte('date', format(from, 'yyyy-MM-dd')),
        supabase.from('pay_runs').select('*').eq('user_id', user.id).order('period_start', { ascending: false }),
        supabase.from('wage_history').select('*').eq('user_id', user.id).order('seq', { ascending: false }).limit(200),
      ])
      setSettings(sRes.data as BusinessSettings | null)
      setTechs(t); setCrews(c); setEntries(e)
      setPtoEntries((pRes.data as PtoEntry[]) ?? [])
      setRuns((rRes.data as PayRun[]) ?? [])
      setWageHistory((wRes.data as WageHistoryEntry[]) ?? [])
      setLoadError(null)
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : 'Could not load workforce.')
    } finally {
      setLoading(false)
    }
  }, [supabase])

  useEffect(() => { fetchAll() }, [fetchAll])
  useRealtimeRefresh('time_entries', uid ? `user_id=eq.${uid}` : null, fetchAll)

  const rules = useMemo(() => payrollRules(settings), [settings])
  const ctx = useMemo(
    () => buildLaborContext({ jobs: [], customers: [], technicians: techs, crews }),
    [techs, crews],
  )

  const period = useMemo(() => payPeriodFor(new Date(), rules), [rules])
  const draft = useMemo(
    () => buildDraftPayRun({ entries, ptoEntries, technicians: techs, rules, period }),
    [entries, ptoEntries, techs, rules, period],
  )

  const weekStart = useMemo(() => startOfWeek(new Date(), { weekStartsOn: rules.weekStartsOn }), [rules.weekStartsOn])
  const weekEnd = useMemo(() => endOfWeek(new Date(), { weekStartsOn: rules.weekStartsOn }), [rules.weekStartsOn])

  const availability = useMemo(
    () => availabilityToday({ technicians: techs, entries, ptoEntries, ctx }),
    [techs, entries, ptoEntries, ctx],
  )
  const otInsight = useMemo(
    () => overtimeInsight({ technicians: techs, entries, rules, weekStart, weekEnd }),
    [techs, entries, rules, weekStart, weekEnd],
  )
  const weekEntries = useMemo(
    () => entries.filter(e => {
      const t = new Date(e.clock_in).getTime()
      return t >= weekStart.getTime() && t < addDays(weekEnd, 1).getTime()
    }),
    [entries, weekStart, weekEnd],
  )
  const balance = useMemo(() => workloadBalance(weekEntries, techs, ctx), [weekEntries, techs, ctx])
  const crewUtil = useMemo(() => crewUtilization(weekEntries, ctx), [weekEntries, ctx])
  const trend = useMemo(
    () => laborTrend({ entries, ptoEntries, technicians: techs, rules, periods: 6 }),
    [entries, ptoEntries, techs, rules],
  )
  const forecast = useMemo(() => forecastNextPeriod(trend), [trend])
  const pto = useMemo(() => ptoAnalytics(ptoEntries, techs, new Date().getFullYear()), [ptoEntries, techs])
  const wages = useMemo(() => wageTrends({ technicians: techs, history: wageHistory }), [techs, wageHistory])
  const runStats = useMemo(() => payRunStats(runs, rules), [runs, rules])

  const onClock = availability.filter(a => a.state === 'on_clock')
  const offToday = availability.filter(a => a.state === 'time_off')
  const activeTechs = techs.filter(t => t.is_active)

  if (loading) {
    return (
      <div className="max-w-6xl space-y-5">
        <PageHeader title="Workforce" description="Your people: hours, pay, time off and what the crew costs." />
        <SkeletonTiles count={4} />
        <SkeletonRows count={5} />
      </div>
    )
  }

  if (activeTechs.length === 0) {
    return (
      <div className="max-w-6xl space-y-5">
        <PageHeader title="Workforce" description="Your people: hours, pay, time off and what the crew costs." />
        <Card>
          <EmptyState icon={HardHat} className="py-16" title="No one on the roster yet"
            description="Add the people who work for you. Once they're on the roster you can clock them in, track time off, and run payroll."
            action={{ label: 'Add your people', href: '/dashboard/dispatch?roster=1' }} />
        </Card>
      </div>
    )
  }

  return (
    <div className="max-w-6xl space-y-5">
      <PageHeader
        title="Workforce"
        description="Your people: hours, pay, time off and what the crew costs."
        action={
          <div className="flex items-center gap-2">
            <Link href="/dashboard/dispatch/time"><Button variant="secondary" size="sm"><Clock className="w-3.5 h-3.5" /> Timesheet</Button></Link>
            <Link href="/dashboard/dispatch/time-off"><Button variant="secondary" size="sm"><Palmtree className="w-3.5 h-3.5" /> Time off</Button></Link>
            <Link href="/dashboard/dispatch/payroll"><Button size="sm"><Wallet className="w-3.5 h-3.5" /> Payroll</Button></Link>
          </div>
        }
      />

      {loadError && (
        <Banner tone="danger" icon={AlertTriangle}
          action={<Button size="sm" variant="secondary" onClick={() => { setLoading(true); fetchAll() }}>Retry</Button>}>
          {loadError}
        </Banner>
      )}

      {/* ── The KPI row: this pay period ── */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        <StatTile label="On the clock" icon={HardHat} value={String(onClock.length)}
          sub={onClock.length ? onClock.map(a => a.name).join(', ') : `${activeTechs.length} on the roster`}
          tone={onClock.length ? 'success' : undefined} tonedSurface={onClock.length > 0} />
        <StatTile label="Hours this period" icon={Clock}
          value={formatDuration(draft.regularMinutes + draft.otMinutes)}
          sub={`${decimalHours(draft.regularMinutes + draft.otMinutes)} h · ${period.label}`} />
        <StatTile label="Overtime this week" icon={Timer} value={formatDuration(otInsight.otMinutesThisWeek)}
          sub={overtimeOff(rules) ? 'No OT rule set' : otInsight.premiumThisWeek > 0 ? `${formatCurrency(otInsight.premiumThisWeek)} extra` : 'None yet'}
          tone={otInsight.otMinutesThisWeek > 0 ? 'warn' : undefined} tonedSurface={otInsight.otMinutesThisWeek > 0} />
        <StatTile label="Payroll this period" icon={Wallet} value={formatCurrency(draft.grossPay)}
          sub="Worked + time off, gross" accent
          onClick={() => { window.location.href = '/dashboard/dispatch/payroll' }} />
      </div>

      {/* Nudges that are actionable, not decorative. */}
      {runStats.periodsSinceLastRun != null && runStats.periodsSinceLastRun >= 1 && (
        <Banner tone="warn" icon={Lock}
          action={<Link href="/dashboard/dispatch/payroll" className="shrink-0 text-xs font-semibold underline">Finalize</Link>}>
          {runStats.periodsSinceLastRun} pay period{runStats.periodsSinceLastRun !== 1 ? 's have' : ' has'} finished since you last
          finalized a pay run. Finalizing freezes what you paid so it can’t drift later.
        </Banner>
      )}
      {wages.missingWage.length > 0 && (
        <Banner tone="warn" icon={AlertTriangle}
          action={<Link href="/dashboard/dispatch?roster=1" className="shrink-0 text-xs font-semibold underline">Set wages</Link>}>
          {wages.missingWage.join(', ')} {wages.missingWage.length !== 1 ? 'have' : 'has'} no wage set, so their hours record time
          but cost $0.
        </Banner>
      )}

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-5">
        {/* ── Availability: the three systems, finally joined ── */}
        <Card>
          <CardBody className="p-0">
            <div className="px-5 py-3 border-b border-border flex items-center justify-between">
              <div>
                <h2 className="text-sm font-semibold text-ink">Today</h2>
                <p className="text-[11px] text-ink-faint">Who’s working, who’s off, and who’s free.</p>
              </div>
              <span className="text-[11px] text-ink-faint tabular-nums">{format(new Date(), 'EEE MMM d')}</span>
            </div>
            <div className="divide-y divide-border max-h-80 overflow-y-auto">
              {availability.map(a => (
                <div key={a.technicianId} className="px-5 py-2.5 flex items-center gap-3">
                  <span className={cn('w-1.5 h-1.5 rounded-full shrink-0',
                    a.state === 'on_clock' ? 'bg-emerald-400'
                      : a.state === 'time_off' ? 'bg-violet-400'
                        : a.state === 'available' ? 'bg-ink-faint' : 'bg-border')} />
                  <div className="min-w-0 flex-1">
                    <p className={cn('text-sm font-medium truncate', a.state === 'inactive' ? 'text-ink-faint' : 'text-ink')}>
                      {a.name}
                      {a.crewName && <span className="text-[11px] font-normal text-ink-faint"> · {a.crewName}</span>}
                    </p>
                    <p className="text-[11px] text-ink-faint tabular-nums">{a.detail}</p>
                  </div>
                  {a.onClockMinutes != null && (
                    <span className="text-sm font-bold text-emerald-400 tabular-nums shrink-0">{formatDuration(a.onClockMinutes)}</span>
                  )}
                </div>
              ))}
            </div>
            {offToday.length > 0 && (
              <div className="px-5 py-2.5 border-t border-border">
                <p className="text-[11px] text-ink-faint">
                  {offToday.map(a => a.name).join(', ')} {offToday.length !== 1 ? 'are' : 'is'} booked off today — that’s
                  why {offToday.length !== 1 ? 'they’re' : 'they’re'} not on the clock.
                </p>
              </div>
            )}
          </CardBody>
        </Card>

        {/* ── Overtime watch ── */}
        <Card>
          <CardBody className="p-0">
            <div className="px-5 py-3 border-b border-border">
              <h2 className="text-sm font-semibold text-ink">Overtime this week</h2>
              <p className="text-[11px] text-ink-faint">
                {overtimeOff(rules)
                  ? 'No overtime rule is set, so every hour is regular time.'
                  : `Over ${otInsight.weeklyThresholdHours} h in a week costs ${rules.multiplier}× — this is the only place to catch it before it's owed.`}
              </p>
            </div>
            {overtimeOff(rules) ? (
              <div className="px-5 py-4">
                <Banner tone="info" icon={Info}
                  action={<Link href="/dashboard/settings#payroll" className="shrink-0 text-xs font-semibold underline">Set rules</Link>}>
                  Overtime law differs by province, so EdgeQuote won’t guess a threshold for you.
                </Banner>
              </div>
            ) : otInsight.watch.length === 0 ? (
              <InlineEmpty icon={Timer}>No hours clocked this week yet.</InlineEmpty>
            ) : (
              <div className="divide-y divide-border max-h-80 overflow-y-auto">
                {otInsight.watch.map(w => {
                  const thresholdMin = (otInsight.weeklyThresholdHours ?? 0) * 60
                  const pct = thresholdMin > 0 ? Math.min(100, (w.minutesSoFar / thresholdMin) * 100) : 0
                  return (
                    <div key={w.technicianId} className="px-5 py-2.5">
                      <div className="flex items-center gap-3">
                        <div className="min-w-0 flex-1">
                          <p className="text-sm font-medium text-ink truncate">{w.name}</p>
                          <p className="text-[11px] text-ink-faint tabular-nums">
                            {decimalHours(w.minutesSoFar)} h worked
                            {w.inOvertime
                              ? <span className="text-amber-400"> · {decimalHours(w.otMinutesSoFar)} h over · {formatCurrency(w.premiumSoFar)} extra</span>
                              : w.minutesToThreshold != null && ` · ${decimalHours(w.minutesToThreshold)} h before overtime`}
                          </p>
                        </div>
                      </div>
                      <span className="mt-1.5 block w-full h-1.5 rounded-full bg-border overflow-hidden">
                        <span className={cn('block h-full rounded-full', w.inOvertime ? 'bg-amber-400' : 'bg-accent/70')}
                          style={{ width: `${Math.max(2, pct)}%` }} />
                      </span>
                    </div>
                  )
                })}
              </div>
            )}
          </CardBody>
        </Card>

        {/* ── Workload balance ── */}
        <Card>
          <CardBody className="p-0">
            <div className="px-5 py-3 border-b border-border flex items-center justify-between">
              <div>
                <h2 className="text-sm font-semibold text-ink">Who’s carrying the week</h2>
                <p className="text-[11px] text-ink-faint">Share of the team’s hours.</p>
              </div>
              <Scale className="w-4 h-4 text-ink-faint" />
            </div>
            {balance.shares.length === 0 ? (
              <InlineEmpty icon={Scale}>No hours clocked this week yet.</InlineEmpty>
            ) : (
              <>
                <div className="divide-y divide-border">
                  {balance.shares.map(s => (
                    <div key={s.technicianId} className="px-5 py-2.5 flex items-center gap-3">
                      <div className="min-w-0 flex-1">
                        <p className="text-sm font-medium text-ink truncate">{s.name}</p>
                        <p className="text-[11px] text-ink-faint tabular-nums">
                          {formatDuration(s.minutes)} · {s.sharePct}% of the week
                          {balance.people > 1 && s.vsEvenPct !== 0 && (
                            <span className={s.vsEvenPct > 0 ? 'text-amber-400' : 'text-ink-faint'}>
                              {' '}· {s.vsEvenPct > 0 ? '+' : ''}{s.vsEvenPct}pp vs even
                            </span>
                          )}
                        </p>
                      </div>
                      <span className="w-20 h-1.5 rounded-full bg-border overflow-hidden shrink-0 hidden sm:block">
                        <span className="block h-full rounded-full bg-accent/70" style={{ width: `${Math.max(2, s.sharePct)}%` }} />
                      </span>
                    </div>
                  ))}
                </div>
                {/* An uneven split is normal on a small crew. Report, don't judge. */}
                <div className="px-5 py-2.5 border-t border-border">
                  <p className="text-[11px] text-ink-faint">
                    {balance.people === 1
                      ? 'One person worked this week, so there’s nothing to balance.'
                      : `An even split would be ${balance.evenSharePct}% each. Uneven isn’t wrong — part-timers and different start dates make it uneven on purpose.`}
                  </p>
                </div>
              </>
            )}
          </CardBody>
        </Card>

        {/* ── Crew utilization ── */}
        <Card>
          <CardBody className="p-0">
            <div className="px-5 py-3 border-b border-border flex items-center justify-between">
              <div>
                <h2 className="text-sm font-semibold text-ink">Crew utilization</h2>
                <p className="text-[11px] text-ink-faint">Paid time that reached a job.</p>
              </div>
              <Gauge className="w-4 h-4 text-ink-faint" />
            </div>
            {crewUtil.length === 0 ? (
              <InlineEmpty icon={Gauge}>No hours clocked this week yet.</InlineEmpty>
            ) : (
              <div className="divide-y divide-border">
                {crewUtil.map(c => (
                  <div key={c.crewId} className="px-5 py-2.5 flex items-center gap-3">
                    <div className="min-w-0 flex-1">
                      <p className="text-sm font-medium text-ink truncate">{c.name}</p>
                      <p className="text-[11px] text-ink-faint tabular-nums">
                        {c.people} {c.people !== 1 ? 'people' : 'person'} · {formatDuration(c.jobMinutes)} on jobs of {formatDuration(c.totalMinutes)} · {formatCurrency(c.cost)}
                      </p>
                    </div>
                    <span className="text-sm font-bold text-ink tabular-nums shrink-0 w-14 text-right">
                      {c.utilizationPct == null ? '—' : `${c.utilizationPct}%`}
                    </span>
                  </div>
                ))}
              </div>
            )}
          </CardBody>
        </Card>
      </div>

      {/* ── Labour cost trend + forecast ── */}
      <Card>
        <CardBody className="p-0">
          <div className="px-5 py-3 border-b border-border flex items-center justify-between gap-3">
            <div className="min-w-0">
              <h2 className="text-sm font-semibold text-ink">Payroll over time</h2>
              <p className="text-[11px] text-ink-faint">Your last finished pay periods.</p>
            </div>
            {trend.changePct != null && (
              <span className={cn('text-xs font-semibold tabular-nums flex items-center gap-1 shrink-0',
                trend.changePct > 0 ? 'text-amber-400' : trend.changePct < 0 ? 'text-emerald-400' : 'text-ink-faint')}>
                {trend.changePct > 0 ? <TrendingUp className="w-3.5 h-3.5" /> : trend.changePct < 0 ? <TrendingDown className="w-3.5 h-3.5" /> : null}
                {trend.changePct > 0 ? '+' : ''}{trend.changePct}% vs previous
              </span>
            )}
          </div>

          {!trend.hasTrend ? (
            <div className="px-5 py-6">
              <InlineEmpty icon={BarChart3}>
                Not enough finished pay periods yet to show a trend. Once a few have gone by, this
                shows what payroll is doing.
              </InlineEmpty>
            </div>
          ) : (
            <div className="px-5 py-4">
              {/* A plain bar chart — the shape is the message. */}
              <div className="flex items-end gap-1.5 h-28">
                {trend.points.map(p => {
                  const max = Math.max(...trend.points.map(x => x.grossPay), 1)
                  const h = Math.max(2, (p.grossPay / max) * 100)
                  return (
                    <div key={p.startISO} className="flex-1 flex flex-col items-center gap-1 min-w-0">
                      <span className="text-[9px] text-ink-faint tabular-nums truncate w-full text-center">
                        {p.grossPay > 0 ? formatCurrency(p.grossPay) : ''}
                      </span>
                      <span className="w-full rounded-t bg-accent/60 hover:bg-accent transition-colors"
                        style={{ height: `${h}%` }}
                        title={`${p.label}: ${formatCurrency(p.grossPay)}${p.otMinutes > 0 ? ` · ${decimalHours(p.otMinutes)} h OT` : ''}`} />
                    </div>
                  )
                })}
              </div>
              <div className="flex gap-1.5 mt-1.5">
                {trend.points.map(p => (
                  <span key={p.startISO} className="flex-1 text-[9px] text-ink-faint text-center truncate">
                    {format(new Date(`${p.startISO}T00:00:00`), 'MMM d')}
                  </span>
                ))}
              </div>
              <p className="text-[11px] text-ink-faint mt-3 tabular-nums">
                Averaging {formatCurrency(trend.averageGross)} a period.
                {trend.points.some(p => p.otMinutes > 0) &&
                  ` Overtime ran ${trend.points[trend.points.length - 1].otSharePct}% of worked hours last period.`}
              </p>
            </div>
          )}

          {/* ── Forecast: refuses more often than it answers ── */}
          <div className="px-5 py-3 border-t border-border">
            {forecast.expected == null ? (
              <div className="flex items-start gap-2">
                <Info className="w-3.5 h-3.5 text-ink-faint mt-0.5 shrink-0" />
                <p className="text-[11px] text-ink-faint">
                  <span className="font-semibold text-ink-muted">Next period: not enough to say.</span>{' '}
                  {forecast.basis}
                </p>
              </div>
            ) : (
              <div className="flex items-start gap-2">
                <BarChart3 className="w-3.5 h-3.5 text-accent mt-0.5 shrink-0" />
                <p className="text-[11px] text-ink-faint">
                  <span className="font-semibold text-ink">Next period: about {formatCurrency(forecast.expected)}</span>
                  {forecast.low != null && forecast.high != null && forecast.high > forecast.low && (
                    <span className="tabular-nums"> ({formatCurrency(forecast.low)}–{formatCurrency(forecast.high)})</span>
                  )}
                  {' — '}{forecast.basis}
                </p>
              </div>
            )}
          </div>
        </CardBody>
      </Card>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-5">
        {/* ── PTO analytics ── */}
        <Card>
          <CardBody className="p-0">
            <div className="px-5 py-3 border-b border-border flex items-center justify-between">
              <div>
                <h2 className="text-sm font-semibold text-ink">Time off this year</h2>
                <p className="text-[11px] text-ink-faint">{pto.paidHours} h paid · {formatCurrency(pto.cost)}</p>
              </div>
              <Link href="/dashboard/dispatch/time-off">
                <Button variant="ghost" size="sm"><ArrowRight className="w-3.5 h-3.5" /></Button>
              </Link>
            </div>
            {pto.byKind.length === 0 ? (
              <InlineEmpty icon={Palmtree}>No time off booked this year.</InlineEmpty>
            ) : (
              <div className="px-5 py-3 space-y-2">
                {pto.byKind.map(k => (
                  <div key={k.kind} className="flex items-center gap-3">
                    <span className="text-xs text-ink-muted capitalize w-24 shrink-0">{k.kind}</span>
                    <span className="flex-1 h-1.5 rounded-full bg-border overflow-hidden">
                      <span className="block h-full rounded-full bg-violet-400/70" style={{ width: `${Math.max(2, k.pct)}%` }} />
                    </span>
                    <span className="text-xs text-ink tabular-nums w-16 text-right shrink-0">{k.hours} h</span>
                  </div>
                ))}
                {pto.unpaidHours > 0 && (
                  <p className="text-[11px] text-ink-faint pt-1">{pto.unpaidHours} h unpaid leave (tracked, not paid).</p>
                )}
                {pto.overAllowance.length > 0 && (
                  <p className="text-[11px] text-amber-400 pt-1">
                    Over their allowance: {pto.overAllowance.map(o => `${o.name} by ${o.overBy} h`).join(', ')}.
                  </p>
                )}
                {pto.neverTakenAny.length > 0 && (
                  <p className="text-[11px] text-ink-faint pt-1">
                    {pto.neverTakenAny.join(', ')} {pto.neverTakenAny.length !== 1 ? 'have' : 'has'} an allowance but
                    hasn’t taken any time off this year.
                  </p>
                )}
              </div>
            )}
          </CardBody>
        </Card>

        {/* ── Wages + pay runs ── */}
        <Card>
          <CardBody className="p-0">
            <div className="px-5 py-3 border-b border-border flex items-center justify-between">
              <div>
                <h2 className="text-sm font-semibold text-ink">Wages &amp; pay runs</h2>
                <p className="text-[11px] text-ink-faint">
                  {wages.averageWage == null ? 'No wages set yet' : `${formatCurrency(wages.averageWage)}/hr average`}
                </p>
              </div>
              <Link href="/dashboard/dispatch/payroll/history">
                <Button variant="ghost" size="sm"><History className="w-3.5 h-3.5" /></Button>
              </Link>
            </div>
            <div className="px-5 py-3 space-y-2.5">
              <Row label={`Gross paid ${new Date().getFullYear()}`} value={formatCurrency(runStats.ytdGross)}
                sub={`${runStats.runs} pay run${runStats.runs !== 1 ? 's' : ''}`} />
              <Row label="Overtime share" value={runStats.ytdOtSharePct == null ? '—' : `${runStats.ytdOtSharePct}%`}
                sub={runStats.ytdOtSharePct == null ? 'No finalized runs yet' : 'of hours worked, year to date'} />
              <Row label="Raises" value={String(wages.raises)}
                sub={wages.averageRaisePct == null ? 'None recorded' : `averaging +${wages.averageRaisePct}%`} />
              {wages.lastChange && (
                <Row label="Last wage change" value={
                  wages.lastChange.from == null
                    ? `${wages.lastChange.to == null ? '—' : formatCurrency(wages.lastChange.to)}`
                    : `${formatCurrency(wages.lastChange.from)} → ${wages.lastChange.to == null ? '—' : formatCurrency(wages.lastChange.to)}`
                } sub={`${wages.lastChange.name} · ${format(new Date(wages.lastChange.at), 'MMM d, yyyy')}`} />
              )}
              {runStats.lastRun && (
                <Row label="Last pay run" value={formatCurrency(Number(runStats.lastRun.gross_pay))}
                  sub={`${format(new Date(`${runStats.lastRun.period_start.slice(0, 10)}T00:00:00`), 'MMM d')} – ${format(new Date(`${runStats.lastRun.period_end.slice(0, 10)}T00:00:00`), 'MMM d, yyyy')}`} />
              )}
            </div>
          </CardBody>
        </Card>
      </div>

      <div className="flex flex-wrap items-center justify-center gap-2 pt-1">
        <Link href="/dashboard/dispatch/labor">
          <Button variant="secondary" size="sm"><BarChart3 className="w-3.5 h-3.5" /> Labour cost &amp; profitability</Button>
        </Link>
        <Link href="/dashboard/dispatch/payroll/history">
          <Button variant="secondary" size="sm"><History className="w-3.5 h-3.5" /> Payroll history</Button>
        </Link>
        <Link href="/dashboard/dispatch?roster=1">
          <Button variant="secondary" size="sm"><HardHat className="w-3.5 h-3.5" /> Roster &amp; crews</Button>
        </Link>
        <Link href="/dashboard/settings#payroll">
          <Button variant="secondary" size="sm"><CalendarDays className="w-3.5 h-3.5" /> Payroll settings</Button>
        </Link>
      </div>

      <p className="text-[11px] text-ink-faint text-center">
        Every figure here comes from the same engine that runs payroll — if it says it here, that’s
        what the cheque says. Gross, before tax and deductions.
      </p>
    </div>
  )
}

function Row({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className="flex items-center justify-between gap-3">
      <div className="min-w-0">
        <p className="text-xs text-ink-muted truncate">{label}</p>
        {sub && <p className="text-[11px] text-ink-faint tabular-nums truncate">{sub}</p>}
      </div>
      <span className="text-sm font-bold text-ink tabular-nums shrink-0">{value}</span>
    </div>
  )
}
