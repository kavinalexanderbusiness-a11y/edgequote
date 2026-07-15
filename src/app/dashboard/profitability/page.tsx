'use client'

import { useEffect, useMemo, useState } from 'react'
import { createClient } from '@/lib/supabase/client'
import { loadAnalyticsCore } from '@/lib/analyticsData'
import { loadTravelModel } from '@/lib/travelLearning'
import { Coord, geocodeAddress } from '@/lib/geo'
import {
  ProfitJob, ProfitQuote, ProfitContext, RecInfo, RouteProfit, Grade, GRADE_COLORS,
  dayProfitability, gradeRoute, improvementSuggestions, neighborhoodProfitability, monthlyTrends,
} from '@/lib/profitability'
import { ProfitMap, ProfitPoint } from '@/components/profitability/ProfitMap'
import { formatCurrency, formatDate, cn } from '@/lib/utils'
import { PageHeader } from '@/components/layout/PageHeader'
import { Card, CardBody } from '@/components/ui/Card'
import { Banner } from '@/components/ui/Banner'
import { InlineEmpty } from '@/components/ui/EmptyState'
import { SkeletonTiles } from '@/components/ui/Skeleton'
import { StatTile } from '@/components/ui/StatTile'
import { parseISO, startOfWeek, format } from 'date-fns'
import { TrendingUp, TrendingDown, Navigation, Clock, DollarSign, MapPin, Lightbulb, Trophy, AlertTriangle, ChevronDown } from 'lucide-react'

type Period = 'day' | 'week' | 'month'

interface AggRow {
  key: string; label: string; revenue: number; driveMin: number; laborMin: number
  driveKm: number; jobs: number; located: number; completed: number; revPerHour: number; revPerKm: number; grade: Grade
}

function aggregate(routes: RouteProfit[], keyOf: (r: RouteProfit) => { key: string; label: string }): AggRow[] {
  const map: Record<string, AggRow> = {}
  for (const r of routes) {
    const { key, label } = keyOf(r)
    const a = (map[key] ||= { key, label, revenue: 0, driveMin: 0, laborMin: 0, driveKm: 0, jobs: 0, located: 0, completed: 0, revPerHour: 0, revPerKm: 0, grade: 'F' })
    a.revenue += r.revenue; a.driveMin += r.driveMinutes; a.laborMin += r.laborMinutes
    a.driveKm += r.driveKm; a.jobs += r.jobsTotal; a.located += r.locatedStops; a.completed += r.jobsCompleted
  }
  return Object.values(map).map(a => {
    const hours = (a.driveMin + a.laborMin) / 60
    const revPerHour = hours > 0 ? Math.round(a.revenue / hours) : 0
    const revPerKm = a.driveKm > 0 ? Math.round((a.revenue / a.driveKm) * 10) / 10 : 0
    // Same located-stop denominator as the per-day engine, so week/month grades
    // match the underlying day grades.
    const avgLeg = a.located > 0 ? a.driveKm / a.located : 0
    return { ...a, driveKm: Math.round(a.driveKm * 10) / 10, revPerHour, revPerKm, grade: gradeRoute(revPerHour, revPerKm, avgLeg, a.driveKm > 0) }
  }).sort((x, y) => y.key.localeCompare(x.key))
}

export default function ProfitabilityPage() {
  const supabase = createClient()
  const [loading, setLoading] = useState(true)
  const [jobs, setJobs] = useState<ProfitJob[]>([])
  const [ctx, setCtx] = useState<ProfitContext>({ quotesById: {}, recById: {}, base: null, today: format(new Date(), 'yyyy-MM-dd') })
  const [period, setPeriod] = useState<Period>('day')
  const [showUpcoming, setShowUpcoming] = useState(false)
  const [loadError, setLoadError] = useState<string | null>(null)

  useEffect(() => {
    async function load() {
      try {
      const { data: { session } } = await supabase.auth.getSession()
      const user = session?.user
      if (!user) { setLoadError('Session expired — sign in again.'); return }
      const [core, sRes, travel] = await Promise.all([
        loadAnalyticsCore(supabase),
        supabase.from('business_settings').select('base_lat, base_lng, base_address').eq('user_id', user!.id).maybeSingle(),
        loadTravelModel(supabase),
      ])

      const quotesById: Record<string, ProfitQuote> = {}
      for (const q of (core?.quotes as unknown as (ProfitQuote & { id: string })[]) || []) quotesById[q.id] = q
      const recById: Record<string, RecInfo> = {}
      for (const r of (core?.recurrences as unknown as (RecInfo & { id: string })[]) || []) recById[r.id] = { freq: r.freq, interval_unit: r.interval_unit, interval_count: r.interval_count }

      const rows = ((core?.jobs as unknown as Array<Omit<ProfitJob, 'lat' | 'lng' | 'city' | 'postal_code' | 'neighborhood'> & { properties?: { lat: number | null; lng: number | null; city: string | null; postal_code: string | null; neighborhood: string | null } | null }>) || [])
        .map(j => ({
          id: j.id, scheduled_date: j.scheduled_date, status: j.status, service_type: j.service_type,
          quote_id: j.quote_id, recurrence_id: j.recurrence_id, duration_minutes: j.duration_minutes,
          actual_minutes: j.actual_minutes, price: j.price, customer_id: j.customer_id,
          lat: j.properties?.lat ?? null, lng: j.properties?.lng ?? null,
          city: j.properties?.city ?? null, postal_code: j.properties?.postal_code ?? null,
          neighborhood: j.properties?.neighborhood ?? null,
        } as ProfitJob))
      setJobs(rows)

      const s = sRes.data as { base_lat: number | null; base_lng: number | null; base_address: string | null } | null
      let base: Coord | null = s?.base_lat != null && s?.base_lng != null ? { lat: s.base_lat, lng: s.base_lng } : null
      if (!base && s?.base_address) {
        const c = await geocodeAddress(s.base_address)
        if (c) { base = c; await supabase.from('business_settings').update({ base_lat: c.lat, base_lng: c.lng }).eq('user_id', user!.id) }
      }
      setCtx({ quotesById, recById, base, today: format(new Date(), 'yyyy-MM-dd'), speed: travel })
      } catch (e) {
        setLoadError(e instanceof Error ? e.message : 'Could not load profitability data.')
      } finally {
        setLoading(false) // never strand the page on the spinner
      }
    }
    load()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Per-day routes (the atom), most recent first.
  const routes = useMemo(() => {
    const byDate: Record<string, ProfitJob[]> = {}
    for (const j of jobs) (byDate[j.scheduled_date] ||= []).push(j)
    return Object.entries(byDate)
      .map(([date, dj]) => dayProfitability(date, dj, ctx))
      .filter(r => r.jobsTotal > 0)
      .sort((a, b) => b.date.localeCompare(a.date))
  }, [jobs, ctx])

  // Day view splits past performance from future bookings — open-ended recurring
  // series materialize months ahead, and 60 future "Booked" cards were burying
  // every actual past route off-screen.
  const pastRoutes = useMemo(() => routes.filter(r => !r.future), [routes])
  const upcomingRoutes = useMemo(() => routes.filter(r => r.future).sort((a, b) => a.date.localeCompare(b.date)), [routes])

  const weeks = useMemo(() => aggregate(routes, r => {
    const w = startOfWeek(parseISO(r.date))
    return { key: format(w, 'yyyy-MM-dd'), label: `Week of ${format(w, 'MMM d')}` }
  }), [routes])
  const months = useMemo(() => aggregate(routes, r => ({ key: r.date.slice(0, 7), label: format(parseISO(r.date + 'T00:00:00'), 'MMMM yyyy') })), [routes])
  const trends = useMemo(() => monthlyTrends(routes).reverse(), [routes])
  const neighborhoods = useMemo(() => neighborhoodProfitability(jobs, ctx), [jobs, ctx])

  // Opportunity detection.
  const opp = useMemo(() => {
    const withJobs = routes.filter(r => r.jobsTotal > 0)
    const withHours = withJobs.filter(r => r.totalHours > 0 && r.revPerHour > 0)
    const maxBy = <T,>(arr: T[], f: (t: T) => number) => arr.length ? arr.reduce((a, b) => f(b) > f(a) ? b : a) : null
    const minBy = <T,>(arr: T[], f: (t: T) => number) => arr.length ? arr.reduce((a, b) => f(b) < f(a) ? b : a) : null
    return {
      topRevenue: maxBy(withJobs, r => r.revenue),
      lowRevenue: minBy(withJobs, r => r.revenue),
      bestPerHour: maxBy(withHours, r => r.revPerHour),
      worstPerHour: minBy(withHours, r => r.revPerHour),
      bestHood: neighborhoods[0] ?? null,
      worstHood: neighborhoods.length > 1 ? neighborhoods[neighborhoods.length - 1] : null,
    }
  }, [routes, neighborhoods])

  // Map points coloured by their day's grade.
  const mapPoints = useMemo<ProfitPoint[]>(() => {
    const gradeByDate: Record<string, Grade> = {}
    for (const r of routes) gradeByDate[r.date] = r.grade
    return jobs
      .filter(j => j.status !== 'cancelled' && j.lat != null && j.lng != null)
      .map(j => ({ lat: j.lat as number, lng: j.lng as number, grade: gradeByDate[j.scheduled_date] ?? 'C', title: formatDate(j.scheduled_date) }))
  }, [jobs, routes])

  if (loading) return (
    <div className="max-w-6xl mx-auto space-y-6">
      <PageHeader crumb={{ label: 'Grow', href: '/dashboard/grow' }} title="Route Profitability" description="Which routes, days and neighborhoods make the most per hour." />
      <SkeletonTiles count={4} />
    </div>
  )

  return (
    <div className="max-w-6xl mx-auto space-y-6">
      <PageHeader crumb={{ label: 'Grow', href: '/dashboard/grow' }} title="Route Profitability" description="Which routes, days and neighborhoods make the most per hour." />

      {loadError && (
        <Banner tone="danger">
          {loadError} <button onClick={() => window.location.reload()} className="underline font-medium ml-1">Retry</button>
        </Banner>
      )}

      <Banner tone="neutral" className="text-xs">
        <span className="font-medium text-ink">Revenue = booked route value</span> (cadence-priced), not collected cash. $/hr is projected from planned time until you log <span className="text-ink">actual minutes</span>; completion counts only past-due days.
      </Banner>

      {!ctx.base && (
        <Banner tone="warn" className="text-xs">
          Set your base address in Settings — without it, $/km and the letter grade can’t include drive cost (grades are capped at C).
        </Banner>
      )}

      {/* Opportunity detection */}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
        <StatTile icon={Trophy} tone="success" label="Top booked day"
          value={opp.topRevenue ? formatCurrency(opp.topRevenue.revenue) : '—'}
          sub={opp.topRevenue ? `${formatDate(opp.topRevenue.date)} · grade ${opp.topRevenue.grade}` : ''} />
        <StatTile icon={TrendingUp} tone="accent" label="Best revenue/hour"
          value={opp.bestPerHour ? `$${opp.bestPerHour.revPerHour}/h` : '—'}
          sub={opp.bestPerHour ? formatDate(opp.bestPerHour.date) : ''} />
        <StatTile icon={MapPin} tone="success" label="Best neighborhood"
          value={opp.bestHood ? opp.bestHood.key : '—'}
          sub={opp.bestHood ? `${formatCurrency(opp.bestHood.revenue)} · ${opp.bestHood.customers} cust` : ''} />
        <StatTile icon={TrendingDown} tone="warn" label="Lowest booked day"
          value={opp.lowRevenue ? formatCurrency(opp.lowRevenue.revenue) : '—'}
          sub={opp.lowRevenue ? `${formatDate(opp.lowRevenue.date)} · grade ${opp.lowRevenue.grade}` : ''} />
        <StatTile icon={AlertTriangle} tone="danger" label="Worst revenue/hour"
          value={opp.worstPerHour ? `$${opp.worstPerHour.revPerHour}/h` : '—'}
          sub={opp.worstPerHour ? formatDate(opp.worstPerHour.date) : ''} />
        <StatTile icon={MapPin} tone="danger" label="Worst neighborhood"
          value={opp.worstHood ? opp.worstHood.key : '—'}
          sub={opp.worstHood ? `${formatCurrency(opp.worstHood.revenue)} · ${opp.worstHood.customers} cust` : ''} />
      </div>

      {/* Period toggle */}
      <div className="flex items-center gap-1 bg-bg-secondary border border-border rounded-xl p-1 w-fit">
        {(['day', 'week', 'month'] as Period[]).map(p => (
          <button key={p} onClick={() => setPeriod(p)} aria-pressed={period === p}
            className={cn('px-4 py-1.5 rounded-lg text-sm font-medium capitalize transition-all', period === p ? 'bg-accent text-black' : 'text-ink-muted hover:text-ink')}>
            {p}
          </button>
        ))}
      </div>

      {/* Routes */}
      {routes.length === 0 ? (
        <Card><InlineEmpty>No jobs to analyze yet.</InlineEmpty></Card>
      ) : period === 'day' ? (
        <div className="space-y-3">
          {upcomingRoutes.length > 0 && (
            <button onClick={() => setShowUpcoming(v => !v)} aria-expanded={showUpcoming}
              className="w-full text-left rounded-xl border border-border bg-bg-secondary px-4 py-2.5 text-sm text-ink-muted hover:text-ink transition-colors flex items-center gap-1.5">
              <ChevronDown className={cn('w-3.5 h-3.5 shrink-0 transition-transform', !showUpcoming && '-rotate-90')} />
              <span>{upcomingRoutes.length} upcoming booked day{upcomingRoutes.length !== 1 ? 's' : ''} · {formatCurrency(upcomingRoutes.reduce((s, r) => s + r.revenue, 0))} on the books</span>
            </button>
          )}
          {showUpcoming && upcomingRoutes.slice(0, 30).map((r, i) => (
            <div key={r.date} className={cn('animate-rise', i < 6 && `stagger-${i + 1}`)}><RouteCard r={r} /></div>
          ))}
          {pastRoutes.length === 0 ? (
            <Card><InlineEmpty>No completed days yet — past routes appear here once you work them.</InlineEmpty></Card>
          ) : pastRoutes.slice(0, 60).map((r, i) => (
            <div key={r.date} className={cn('animate-rise', i < 6 && `stagger-${i + 1}`)}><RouteCard r={r} /></div>
          ))}
        </div>
      ) : (
        <div className="space-y-2">
          {(period === 'week' ? weeks : months).map((a, i) => (
            <div key={a.key} className={cn('animate-rise', i < 6 && `stagger-${i + 1}`)}><AggCard a={a} /></div>
          ))}
        </div>
      )}

      {/* Historical trends (monthly) */}
      {trends.length > 0 && (
        <Card>
          <div className="px-4 py-3 border-b border-border flex items-center gap-2.5">
            <span className="w-6 h-6 rounded-md bg-accent/10 border border-accent/20 flex items-center justify-center shrink-0">
              <Clock className="w-3.5 h-3.5 text-accent-text" />
            </span>
            <h2 className="text-sm font-semibold tracking-tight text-ink">Monthly trends</h2>
            <span className="flex-1 h-px bg-border" aria-hidden />
          </div>
          <CardBody className="overflow-x-auto p-0">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-[10px] uppercase tracking-[0.14em] text-ink-faint border-b border-border">
                  <th className="text-left font-semibold px-4 py-2">Month</th>
                  <th className="text-right font-semibold px-3 py-2">Revenue</th>
                  <th className="text-right font-semibold px-3 py-2">$/hr</th>
                  <th className="text-right font-semibold px-3 py-2">$/km</th>
                  <th className="text-right font-semibold px-3 py-2">Drive</th>
                  <th className="text-right font-semibold px-4 py-2">Labor</th>
                </tr>
              </thead>
              <tbody>
                {trends.map(t => (
                  <tr key={t.month} className="border-b border-border last:border-0">
                    <td className="px-4 py-2 text-ink font-medium">{format(parseISO(t.month + '-01'), 'MMM yyyy')}</td>
                    <td className="px-3 py-2 text-right text-ink font-semibold tabular-nums">{formatCurrency(t.revenue)}</td>
                    <td className="px-3 py-2 text-right text-ink-muted tabular-nums">${t.revPerHour}</td>
                    <td className="px-3 py-2 text-right text-ink-muted tabular-nums">${t.revPerKm}</td>
                    <td className="px-3 py-2 text-right text-ink-muted tabular-nums">{Math.round(t.driveMinutes / 60 * 10) / 10}h</td>
                    <td className="px-4 py-2 text-right text-ink-muted tabular-nums">{Math.round(t.laborMinutes / 60 * 10) / 10}h</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </CardBody>
        </Card>
      )}

      {/* Profitability map */}
      {mapPoints.length > 0 && (
        <div className="space-y-2">
          <div className="flex items-center gap-2.5">
            <span className="w-6 h-6 rounded-md bg-accent/10 border border-accent/20 flex items-center justify-center shrink-0">
              <MapPin className="w-3.5 h-3.5 text-accent-text" />
            </span>
            <h2 className="text-sm font-semibold tracking-tight text-ink">Profitability map</h2>
            <span className="flex-1 h-px bg-border" aria-hidden />
          </div>
          <ProfitMap points={mapPoints} />
        </div>
      )}
    </div>
  )
}

function GradeBadge({ grade }: { grade: Grade }) {
  return (
    <div className="w-10 h-10 rounded-xl flex items-center justify-center text-lg font-black shrink-0"
      style={{ backgroundColor: GRADE_COLORS[grade] + '22', color: GRADE_COLORS[grade], border: `1px solid ${GRADE_COLORS[grade]}55` }}>
      {grade}
    </div>
  )
}

function RouteCard({ r }: { r: RouteProfit }) {
  const tips = r.grade === 'D' || r.grade === 'F' || r.revPerHour < 60 ? improvementSuggestions(r) : []
  return (
    <Card>
      <CardBody className="space-y-3">
        <div className="flex items-start gap-3">
          <GradeBadge grade={r.grade} />
          <div className="min-w-0 flex-1">
            <div className="flex items-center justify-between gap-2">
              <p className="text-sm font-bold text-ink flex items-center gap-2">
                {formatDate(r.date)}
                {r.future && <span className="text-[10px] font-semibold uppercase tracking-wide text-blue-400 border border-blue-500/30 rounded px-1.5 py-0.5">Booked</span>}
              </p>
              <p className="text-lg font-bold text-accent-text tabular-nums">{formatCurrency(r.revenue)}</p>
            </div>
            <div className="grid grid-cols-3 sm:grid-cols-6 gap-2 mt-2 text-xs">
              <Metric label={r.hasDriveData ? '$/hr' : '$/hr*'} value={`$${r.revPerHour}`} />
              <Metric label="$/km" value={r.hasDriveData ? `$${r.revPerKm}` : '—'} />
              <Metric label="$/stop" value={`$${r.revPerStop}`} />
              <Metric label="Hours" value={`${r.totalHours}h`} />
              <Metric label="Stops" value={String(r.stops)} />
              <Metric label="Done" value={r.future ? '—' : `${r.completionPct}%`} />
            </div>
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1 mt-2 text-[11px] text-ink-faint">
              <span className="flex items-center gap-1"><Navigation className="w-3 h-3" /> {r.driveKm} km · {r.driveMinutes} min drive</span>
              <span className="flex items-center gap-1"><Clock className="w-3 h-3" /> {Math.round(r.laborMinutes / 60 * 10) / 10}h on site</span>
              <span className="flex items-center gap-1"><DollarSign className="w-3 h-3" /> {r.future ? `${r.jobsTotal} booked` : `${r.jobsCompleted}/${r.jobsTotal} done`}</span>
            </div>
          </div>
        </div>
        {tips.length > 0 && (
          <Banner tone="warn" icon={Lightbulb} className="items-start">
            <p className="text-[11px] font-semibold uppercase tracking-wide">Improve this route</p>
            {tips.map((t, i) => <p key={i} className="text-xs text-ink-muted">• {t}</p>)}
          </Banner>
        )}
      </CardBody>
    </Card>
  )
}

function AggCard({ a }: { a: AggRow }) {
  return (
    <Card>
      <CardBody>
        <div className="flex items-center gap-3">
          <GradeBadge grade={a.grade} />
          <div className="min-w-0 flex-1">
            <div className="flex items-center justify-between gap-2">
              <p className="text-sm font-bold text-ink">{a.label}</p>
              <p className="text-lg font-bold text-accent-text tabular-nums">{formatCurrency(a.revenue)}</p>
            </div>
            <div className="grid grid-cols-3 sm:grid-cols-5 gap-2 mt-1.5 text-xs">
              <Metric label="$/hr" value={`$${a.revPerHour}`} />
              <Metric label="$/km" value={`$${a.revPerKm}`} />
              <Metric label="Drive" value={`${Math.round(a.driveMin / 60 * 10) / 10}h`} />
              <Metric label="Labor" value={`${Math.round(a.laborMin / 60 * 10) / 10}h`} />
              <Metric label="Jobs" value={`${a.completed}/${a.jobs}`} />
            </div>
          </div>
        </div>
      </CardBody>
    </Card>
  )
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg border border-border bg-bg-tertiary px-2 py-1.5">
      <p className="text-[10px] font-semibold uppercase tracking-[0.14em] text-ink-faint">{label}</p>
      <p className="text-sm font-bold text-ink mt-0.5 tabular-nums">{value}</p>
    </div>
  )
}
