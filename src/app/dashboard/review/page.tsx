'use client'

import { useEffect, useMemo, useState } from 'react'
import Link from 'next/link'
import { createClient } from '@/lib/supabase/client'
import { loadTravelModel } from '@/lib/travelLearning'
import { Quote } from '@/types'
import { format, subDays, parseISO } from 'date-fns'
import { Coord, geocodeAddress } from '@/lib/geo'
import {
  ProfitJob, ProfitQuote, ProfitContext, RecInfo, Grade, GRADE_COLORS,
  dayProfitability, neighborhoodProfitability, jobValue,
} from '@/lib/profitability'
import { needsFollowUp } from '@/lib/followup'
import { effectiveFreq } from '@/lib/invoicing'
import { settingsToSeasons, ServiceSeasons } from '@/lib/seasons'
import { ranOut as ranOutSignal, cadenceDays, isSeasonallyDormant } from '@/lib/signals'
import { localTodayISO, formatCurrency, formatDate, cn } from '@/lib/utils'
import { PageHeader } from '@/components/layout/PageHeader'
import { SkeletonTiles } from '@/components/ui/Skeleton'
import { StatTile } from '@/components/ui/StatTile'
import { Card, CardBody } from '@/components/ui/Card'
import { Banner } from '@/components/ui/Banner'
import {
  CalendarCheck, DollarSign, Gauge, MapPin, Bell, HeartPulse, Sprout, ArrowRight, TrendingUp, TrendingDown, AlertTriangle,
} from 'lucide-react'

type SatJob = ProfitJob & { start_time?: string | null }

// The Sunday screen: how did the week go, and what should next week's moves be.
// Pure composition of the existing engines — same numbers as every other page.
export default function WeeklyReviewPage() {
  const supabase = createClient()
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [jobs, setJobs] = useState<SatJob[]>([])
  const [quotes, setQuotes] = useState<Quote[]>([])
  const [ranOutCount, setRanOutCount] = useState(0)
  const [ctx, setCtx] = useState<ProfitContext>({ quotesById: {}, recById: {}, base: null, today: localTodayISO() })

  useEffect(() => {
    async function load() {
      try {
        const { data: { session } } = await supabase.auth.getSession()
        const user = session?.user
        if (!user) { setLoadError('Session expired — sign in again.'); return }
        const [jRes, qRes, rRes, sRes, travel] = await Promise.all([
          supabase.from('jobs').select('id, scheduled_date, status, service_type, quote_id, recurrence_id, duration_minutes, actual_minutes, price, customer_id, properties(lat, lng, city, postal_code, neighborhood)').eq('user_id', user.id),
          supabase.from('quotes').select('*').eq('user_id', user.id),
          supabase.from('job_recurrences').select('id, freq, interval_unit, interval_count').eq('user_id', user.id),
          supabase.from('business_settings').select('base_lat, base_lng, base_address, service_seasons').eq('user_id', user.id).maybeSingle(),
          loadTravelModel(supabase),
        ])
        const quotesById: Record<string, ProfitQuote> = {}
        for (const q of (qRes.data as (ProfitQuote & { id: string })[]) || []) quotesById[q.id] = q
        const recById: Record<string, RecInfo> = {}
        for (const r of (rRes.data as (RecInfo & { id: string })[]) || []) recById[r.id] = { freq: r.freq, interval_unit: r.interval_unit, interval_count: r.interval_count }

        const rows: SatJob[] = ((jRes.data as unknown as Array<Record<string, any>>) || []).map(j => ({
          id: j.id, scheduled_date: j.scheduled_date, status: j.status, service_type: j.service_type,
          quote_id: j.quote_id, recurrence_id: j.recurrence_id, duration_minutes: j.duration_minutes,
          actual_minutes: j.actual_minutes, price: j.price, customer_id: j.customer_id,
          lat: j.properties?.lat ?? null, lng: j.properties?.lng ?? null,
          city: j.properties?.city ?? null, postal_code: j.properties?.postal_code ?? null,
          neighborhood: j.properties?.neighborhood ?? null,
        }))
        setJobs(rows)
        setQuotes((qRes.data as Quote[]) || [])

        // Ran-out recurring customers — THE shared detector, so this is literally the
        // same queue Reactivation alarms on: season-gated, actually-serviced only, and
        // only while the series is plausibly still active.
        const today = localTodayISO()
        const seasons: ServiceSeasons = settingsToSeasons((sRes.data as { service_seasons: unknown } | null)?.service_seasons)
        const byCust: Record<string, SatJob[]> = {}
        for (const j of rows) if (j.customer_id) (byCust[j.customer_id] ||= []).push(j)
        let ranOut = 0
        for (const list of Object.values(byCust)) {
          // Most RECENT recurring activity — DB order can pick a dead series over the
          // customer's current cadence.
          const recJob = list.filter(j => j.recurrence_id).sort((a, b) => b.scheduled_date.localeCompare(a.scheduled_date))[0]
          const upcoming = list.some(j => j.scheduled_date >= today && (j.status === 'scheduled' || j.status === 'in_progress'))
          const completed = list.filter(j => j.status === 'completed').map(j => j.scheduled_date).sort()
          const pastReal = list.filter(j => j.status !== 'cancelled' && j.scheduled_date <= today).map(j => j.scheduled_date).sort()
          const lastDate = completed.length ? completed[completed.length - 1]
            : (pastReal.length ? pastReal[pastReal.length - 1] : null)
          const rec = recJob?.recurrence_id ? recById[recJob.recurrence_id] : null
          const freq = rec ? effectiveFreq(rec.freq, rec.interval_unit, rec.interval_count) : null
          const signal = ranOutSignal({
            hasRecurring: !!recJob,
            hasUpcoming: upcoming,
            lastServiceDate: lastDate,
            cadenceDays: cadenceDays(freq, rec),
            seasonallyDormant: isSeasonallyDormant(recJob?.service_type ?? null, seasons, today),
            today,
          })
          if (signal.isRanOut && signal.isUrgent) ranOut++
        }
        setRanOutCount(ranOut)

        const s = sRes.data as { base_lat: number | null; base_lng: number | null; base_address: string | null } | null
        let base: Coord | null = s?.base_lat != null && s?.base_lng != null ? { lat: s.base_lat, lng: s.base_lng } : null
        if (!base && s?.base_address) base = await geocodeAddress(s.base_address)
        setCtx({ quotesById, recById, base, today, speed: travel })
      } catch (e) {
        setLoadError(e instanceof Error ? e.message : 'Could not load the review.')
      } finally {
        setLoading(false)
      }
    }
    load()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const m = useMemo(() => {
    const today = localTodayISO()
    const weekStart = format(subDays(parseISO(today), 6), 'yyyy-MM-dd')
    const weekJobs = jobs.filter(j => j.scheduled_date >= weekStart && j.scheduled_date <= today && j.status !== 'cancelled')
    const completed = weekJobs.filter(j => j.status === 'completed')
    const revenue = Math.round(completed.reduce((s, j) => s + jobValue(j, ctx), 0))
    const missed = weekJobs.filter(j => j.status === 'scheduled' || j.status === 'in_progress').length

    // Average route grade across the week's worked days (the ONE day engine).
    const byDate: Record<string, ProfitJob[]> = {}
    for (const j of weekJobs) (byDate[j.scheduled_date] ||= []).push(j)
    const dayRoutes = Object.entries(byDate).map(([date, dj]) => dayProfitability(date, dj, ctx)).filter(r => r.jobsTotal > 0)
    const gradeVal: Record<Grade, number> = { A: 4, B: 3, C: 2, D: 1, F: 0 }
    const avgGradeNum = dayRoutes.length ? dayRoutes.reduce((s, r) => s + gradeVal[r.grade], 0) / dayRoutes.length : null
    const avgGrade: Grade | null = avgGradeNum == null ? null
      : avgGradeNum >= 3.5 ? 'A' : avgGradeNum >= 2.5 ? 'B' : avgGradeNum >= 1.5 ? 'C' : avgGradeNum >= 0.5 ? 'D' : 'F'

    // Best / worst neighborhood over the WEEK's jobs (real names).
    const hoodsWeek = neighborhoodProfitability(weekJobs, ctx).filter(h => h.key !== 'Unknown')
    const best = hoodsWeek[0] ?? null
    const worst = hoodsWeek.length > 1 ? hoodsWeek[hoodsWeek.length - 1] : null

    // Next week's opportunities.
    const followUps = quotes.filter(needsFollowUp)
    const followUpValue = Math.round(followUps.reduce((s, q) => s + Number(q.total || 0), 0))
    const pending = quotes.filter(q => q.status === 'draft' || q.status === 'sent')
    const pendingValue = Math.round(pending.reduce((s, q) => s + Number(q.total || 0), 0))

    // Growth: strongest all-time hood with room (≤2 customers) or warm demand.
    const hoodsAll = neighborhoodProfitability(jobs.filter(j => j.status !== 'cancelled'), ctx).filter(h => h.key !== 'Unknown')
    const growth = hoodsAll.find(h => h.customers <= 2 && h.revPerJob > 0) ?? hoodsAll[0] ?? null

    return { weekStart, today, revenue, completedCount: completed.length, missed, dayRoutes, avgGrade, best, worst, followUps: followUps.length, followUpValue, pending: pending.length, pendingValue, growth }
  }, [jobs, quotes, ctx])

  // Skeleton lands inside the SAME container + header as the loaded page, so
  // nothing jumps when the numbers arrive.
  if (loading) {
    return (
      <div className="max-w-5xl mx-auto space-y-6">
        <PageHeader crumb={{ label: 'Grow', href: '/dashboard/grow' }}
          title="Weekly Review"
          description="How the week went, and next week's moves." />
        <SkeletonTiles count={3} className="grid-cols-3 lg:grid-cols-3" />
        <SkeletonTiles count={2} className="grid-cols-1 sm:grid-cols-2 lg:grid-cols-2" />
      </div>
    )
  }

  return (
    <div className="max-w-5xl mx-auto space-y-6">
      <PageHeader crumb={{ label: 'Grow', href: '/dashboard/grow' }}
        title="Weekly Review"
        description={`${formatDate(m.weekStart)} – ${formatDate(m.today)} · how the week went, and next week's moves`}
      />

      {loadError && (
        <Banner tone="danger" icon={AlertTriangle}
          action={<button type="button" onClick={() => window.location.reload()} className="shrink-0 underline font-semibold">Retry</button>}>
          {loadError}
        </Banner>
      )}

      {/* The week in numbers */}
      <div className="grid grid-cols-3 gap-3">
        <StatTile icon={DollarSign} label="Revenue earned" value={formatCurrency(m.revenue)} accent />
        <StatTile icon={CalendarCheck} label="Jobs completed"
          value={<>{m.completedCount}{m.missed > 0 && <span className="text-sm font-semibold text-amber-400"> · {m.missed} open</span>}</>} />
        <StatTile icon={Gauge} label="Avg route grade"
          value={m.avgGrade ? <span style={{ color: GRADE_COLORS[m.avgGrade] }}>{m.avgGrade}</span> : '—'} />
      </div>

      {/* Best / worst neighborhood this week */}
      <div className="grid sm:grid-cols-2 gap-3">
        <Card className="p-4">
          <p className="text-[10px] font-semibold uppercase tracking-[0.14em] text-ink-muted flex items-center gap-1.5"><TrendingUp className="w-3.5 h-3.5 text-emerald-400" /> Best neighborhood</p>
          {m.best ? (
            <>
              <p className="text-lg font-bold text-ink mt-1 flex items-center gap-1.5"><MapPin className="w-4 h-4 text-emerald-400" /> {m.best.key}</p>
              <p className="text-xs text-ink-muted mt-0.5 tabular-nums">{formatCurrency(m.best.revenue)} · {m.best.jobs} job{m.best.jobs !== 1 ? 's' : ''} · ${m.best.revPerHour}/hr</p>
            </>
          ) : <p className="text-sm text-ink-faint mt-1">No worked areas this week.</p>}
        </Card>
        <Card className="p-4">
          <p className="text-[10px] font-semibold uppercase tracking-[0.14em] text-ink-muted flex items-center gap-1.5"><TrendingDown className="w-3.5 h-3.5 text-red-400" /> Worst neighborhood</p>
          {m.worst ? (
            <>
              <p className="text-lg font-bold text-ink mt-1 flex items-center gap-1.5"><MapPin className="w-4 h-4 text-red-400" /> {m.worst.key}</p>
              <p className="text-xs text-ink-muted mt-0.5 tabular-nums">{formatCurrency(m.worst.revenue)} · {m.worst.jobs} job{m.worst.jobs !== 1 ? 's' : ''} · ${m.worst.revPerHour}/hr</p>
            </>
          ) : <p className="text-sm text-ink-faint mt-1">Only one area worked — nothing to compare.</p>}
        </Card>
      </div>

      {/* Day-by-day grades */}
      {m.dayRoutes.length > 0 && (
        <Card>
          <CardBody className="flex items-center gap-2 flex-wrap">
            {m.dayRoutes.sort((a, b) => a.date.localeCompare(b.date)).map(r => (
              <div key={r.date} className="rounded-lg border border-border bg-bg-tertiary px-2.5 py-1.5 text-center">
                <p className="text-[10px] uppercase tracking-wide text-ink-faint">{format(parseISO(r.date + 'T00:00:00'), 'EEE')}</p>
                <p className="text-sm font-black" style={{ color: GRADE_COLORS[r.grade] }}>{r.grade}</p>
                <p className="text-[10px] text-ink-muted tabular-nums">{formatCurrency(r.revenue)}</p>
              </div>
            ))}
          </CardBody>
        </Card>
      )}

      {/* Next week's moves */}
      <Card>
        <div className="px-4 py-3 border-b border-border flex items-center gap-2">
          <span className="w-6 h-6 rounded-md bg-accent/10 border border-accent/20 flex items-center justify-center shrink-0"><CalendarCheck className="w-3.5 h-3.5 text-accent" /></span>
          <h2 className="text-sm font-semibold text-ink tracking-tight">Next week&apos;s moves</h2>
          <span className="flex-1 h-px bg-border" aria-hidden />
        </div>
        <CardBody className="p-0">
          <div className="divide-y divide-border">
            <ReviewRow icon={Bell} tone="text-amber-400" label="Follow-ups waiting"
              value={m.followUps > 0 ? `${m.followUps} quote${m.followUps !== 1 ? 's' : ''} · ${formatCurrency(m.followUpValue)}` : 'All caught up'}
              href="/dashboard/quotes?followup=1" cta={m.followUps > 0 ? 'Chase them' : undefined} />
            <ReviewRow icon={HeartPulse} tone="text-red-400" label="Reactivation opportunities"
              value={ranOutCount > 0 ? `${ranOutCount} recurring customer${ranOutCount !== 1 ? 's' : ''} with no next visit` : 'No recurring customers adrift'}
              href="/dashboard/reactivation" cta={ranOutCount > 0 ? 'Re-book them' : undefined} />
            <ReviewRow icon={Sprout} tone="text-violet-300" label="Growth opportunity"
              value={m.growth ? `${m.growth.key} — ${formatCurrency(m.growth.revPerJob)}/job, ${m.growth.customers} customer${m.growth.customers !== 1 ? 's' : ''}` : 'Add located, priced jobs to surface one'}
              href="/dashboard/neighbors" cta={m.growth ? 'Knock doors' : undefined} />
            <ReviewRow icon={DollarSign} tone="text-accent" label="Pending quote pipeline"
              value={m.pending > 0 ? `${m.pending} open · ${formatCurrency(m.pendingValue)}` : 'No open quotes'}
              href="/dashboard/quotes?status=sent" cta={m.pending > 0 ? 'Close them' : undefined} />
          </div>
        </CardBody>
      </Card>
    </div>
  )
}

function ReviewRow({ icon: Icon, tone, label, value, href, cta }: {
  icon: typeof Bell; tone: string; label: string; value: string; href: string; cta?: string
}) {
  return (
    <div className="group px-4 py-3 flex items-center gap-3">
      <Icon className={cn('w-4 h-4 shrink-0', tone)} />
      <div className="min-w-0 flex-1">
        <p className="text-xs text-ink-faint">{label}</p>
        <p className="text-sm font-medium text-ink truncate tabular-nums">{value}</p>
      </div>
      {cta && (
        <Link href={href} className="shrink-0 text-xs font-semibold text-accent flex items-center gap-1 hover:underline">
          {cta} <ArrowRight className="w-3 h-3 transition-transform group-hover:translate-x-0.5" />
        </Link>
      )}
    </div>
  )
}
