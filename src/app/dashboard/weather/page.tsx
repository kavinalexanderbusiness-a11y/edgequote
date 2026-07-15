'use client'

import { useEffect, useMemo, useState } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { format, parseISO } from 'date-fns'
import { createClient } from '@/lib/supabase/client'
import { loadWeatherImpact, WeatherImpactReport, DayImpact } from '@/lib/weatherImpact'
import { DayForecast, RAIN_PROB_THRESHOLD, weatherScore, WeatherLevel } from '@/lib/weather'
import { PageHeader } from '@/components/layout/PageHeader'
import { Button } from '@/components/ui/Button'
import { Card } from '@/components/ui/Card'
import { StatTile } from '@/components/ui/StatTile'
import { Skeleton, SkeletonTiles } from '@/components/ui/Skeleton'
import { EmptyState, InlineEmpty } from '@/components/ui/EmptyState'
import { formatCurrency, cn } from '@/lib/utils'
import { CloudRain, Droplets, Wind, Clock, DollarSign, Users, AlertTriangle, ArrowRight, MapPin, Thermometer, CalendarOff, Sun } from 'lucide-react'

const dayLabel = (iso: string, today: string) => iso === today ? 'Today' : format(parseISO(iso + 'T00:00:00'), 'EEE MMM d')

// Green / Yellow / Red traffic-light styling, shared by the score badge and bars.
const LEVEL_STYLE: Record<WeatherLevel, { dot: string; text: string; bar: string; ring: string }> = {
  green: { dot: 'bg-emerald-500', text: 'text-emerald-400', bar: 'bg-emerald-500/60', ring: 'border-emerald-500/30 bg-emerald-500/[0.05]' },
  yellow: { dot: 'bg-amber-500', text: 'text-amber-400', bar: 'bg-amber-500/70', ring: 'border-amber-500/30 bg-amber-500/[0.05]' },
  red: { dot: 'bg-red-500', text: 'text-red-400', bar: 'bg-red-500/70', ring: 'border-red-500/30 bg-red-500/[0.05]' },
}

function ScoreBadge({ f }: { f: DayForecast }) {
  const s = weatherScore(f)
  const st = LEVEL_STYLE[s.level]
  return (
    <span className={cn('inline-flex items-center gap-1.5 text-[11px] font-semibold rounded-full px-2 py-0.5 border', st.ring, st.text)}>
      <span className={cn('w-1.5 h-1.5 rounded-full', st.dot)} /> {s.label}
    </span>
  )
}

export default function WeatherPage() {
  const supabase = useMemo(() => createClient(), [])
  const router = useRouter()
  const [r, setR] = useState<WeatherImpactReport | null>(null)
  const [loading, setLoading] = useState(true)
  const today = useMemo(() => new Date().toISOString().slice(0, 10), [])

  useEffect(() => { (async () => { setLoading(true); try { setR(await loadWeatherImpact(supabase)) } finally { setLoading(false) } })() }, [supabase])

  if (loading) {
    return (
      <div className="max-w-5xl mx-auto space-y-6">
        <PageHeader crumb={{ label: 'Schedule', href: '/dashboard/schedule' }} title="Weather" description="Rain risk to your booked work — and the best dry days to move it." />
        <Skeleton className="h-7 w-64 rounded-full" />
        <div className="grid grid-cols-2 gap-3">
          <Skeleton className="h-32 rounded-card" />
          <Skeleton className="h-32 rounded-card" />
        </div>
        <Skeleton className="h-48 rounded-card" />
        <SkeletonTiles count={4} />
      </div>
    )
  }
  if (!r) return null

  if (!r.hasBase) {
    return (
      <div className="max-w-5xl mx-auto space-y-6">
        <PageHeader crumb={{ label: 'Schedule', href: '/dashboard/schedule' }} title="Weather" description="Rain risk to your booked work — and the best dry days to move it." />
        <EmptyState
          icon={MapPin}
          title="Set your base location first"
          description="Add your business base address in Settings so we can pull the local forecast."
          action={{ label: 'Open settings', onClick: () => router.push('/dashboard/settings') }}
        />
      </div>
    )
  }
  if (r.forecast.length === 0) {
    return (
      <div className="max-w-5xl mx-auto space-y-6">
        <PageHeader crumb={{ label: 'Schedule', href: '/dashboard/schedule' }} title="Weather" description="Rain risk to your booked work — and the best dry days to move it." />
        <InlineEmpty>Couldn’t reach the forecast service right now. Try again shortly.</InlineEmpty>
      </div>
    )
  }

  return (
    <div className="max-w-5xl mx-auto space-y-6">
      <PageHeader crumb={{ label: 'Schedule', href: '/dashboard/schedule' }} title="Weather" description="Rain risk to your booked work — and the best dry days to move it." />

      {/* Which location the forecast is for — always visible so you know it's right */}
      <div className="flex flex-wrap items-center gap-2">
        <span className="inline-flex items-center gap-1.5 text-sm font-semibold rounded-full px-3 py-1 border border-accent/30 bg-accent/10 text-accent-text">
          <MapPin className="w-3.5 h-3.5" /> Forecast for {r.locationLabel}
        </span>
        {r.usingDefaultLocation && (
          <Link href="/dashboard/settings" className="text-xs text-ink-muted hover:text-ink underline decoration-dotted">
            Using the Calgary, AB default — set your business address in Settings for your local forecast
          </Link>
        )}
      </div>

      {/* Headline recommendation */}
      {r.headline && (
        <div className={cn('rounded-card border px-4 py-3 flex items-center gap-3',
          r.atRiskDays.some(d => d.recommendation.action === 'delay') ? LEVEL_STYLE.red.ring
            : r.atRiskDays.some(d => d.recommendation.action === 'monitor') ? LEVEL_STYLE.yellow.ring : LEVEL_STYLE.green.ring)}>
          <CloudRain className="w-4 h-4 shrink-0 text-ink-muted" />
          <p className="text-sm font-semibold text-ink">{r.headline}</p>
          {r.totals.days > 0 && <Link href="/dashboard/schedule" className="ml-auto shrink-0"><Button size="sm">Open Weather Ops <ArrowRight className="w-3.5 h-3.5" /></Button></Link>}
        </div>
      )}

      {/* Days the owner manually marked unavailable — explained, not just skipped */}
      {r.blockedDays.length > 0 && (
        <Card className="p-4">
          <p className="text-[10px] font-semibold uppercase tracking-wide text-ink-faint mb-2 flex items-center gap-1.5"><CalendarOff className="w-3.5 h-3.5" /> Days you&apos;ve marked off</p>
          <div className="space-y-1">
            {r.blockedDays.map(b => (
              <p key={b.date} className="text-sm text-ink-muted">
                <span className="font-semibold text-ink">{format(parseISO(b.date + 'T00:00:00'), 'EEEE, MMM d')}</span> is unavailable ({b.label} — manually blocked)
              </p>
            ))}
          </div>
          <p className="text-[10px] text-ink-faint mt-2">Weather Ops won&apos;t recommend these days. Re-enable a day from the schedule calendar.</p>
        </Card>
      )}

      {/* Today / tomorrow */}
      <div className="grid grid-cols-2 gap-3">
        {r.today && <WeatherCard f={r.today} label="Today" />}
        {r.tomorrow && <WeatherCard f={r.tomorrow} label={dayLabel(r.tomorrow.date, today)} />}
      </div>

      {/* 7-day outlook — rain %, wind, temp, severe, with a work-score colour */}
      <Card className="p-4">
        <p className="text-[10px] font-semibold uppercase tracking-wide text-ink-faint mb-2 flex items-center gap-1.5"><Droplets className="w-3.5 h-3.5" /> 7-day outlook</p>
        <div className="flex items-end gap-1.5 h-28">
          {r.forecast.map(f => {
            const lvl = weatherScore(f).level
            return (
              <div key={f.date} className="flex-1 flex flex-col items-center justify-end gap-1 min-w-0">
                <span className="text-[10px] text-ink-faint tabular-nums">{f.precipProbability}%</span>
                <div className={cn('w-full rounded-t', LEVEL_STYLE[lvl].bar)} style={{ height: `${Math.max(4, f.precipProbability)}%` }} title={`${f.label} · ${f.precipMm}mm · wind ${f.windKph} km/h`} />
                <span className="text-base leading-none">{f.emoji}</span>
                <span className="text-[10px] text-ink-faint truncate w-full text-center">{f.date === today ? 'Now' : format(parseISO(f.date + 'T00:00:00'), 'EEE')}</span>
              </div>
            )
          })}
        </div>
        {/* Per-day detail: wind + temp + severe */}
        <div className="grid grid-cols-7 gap-1.5 mt-3">
          {r.forecast.map(f => (
            <div key={f.date} className="text-center">
              <p className="text-[9px] text-ink-faint flex items-center justify-center gap-0.5"><Wind className="w-2.5 h-2.5" /> {f.windKph}</p>
              {f.tempMax != null && <p className="text-[9px] text-ink-muted flex items-center justify-center gap-0.5"><Thermometer className="w-2.5 h-2.5" /> {f.tempMax}°</p>}
              {f.severe && <p className="flex items-center justify-center"><AlertTriangle className="w-2.5 h-2.5 text-red-400" /></p>}
            </div>
          ))}
        </div>
        <p className="text-[10px] text-ink-faint mt-2 flex items-center gap-3">
          <span className="flex items-center gap-1"><span className="w-2 h-2 rounded-full bg-emerald-500" /> Good</span>
          <span className="flex items-center gap-1"><span className="w-2 h-2 rounded-full bg-amber-500" /> Monitor</span>
          <span className="flex items-center gap-1"><span className="w-2 h-2 rounded-full bg-red-500" /> Delay</span>
          <span className="ml-auto">Rain ≥ {RAIN_PROB_THRESHOLD}% or wind/severe → flagged.</span>
        </p>
      </Card>

      {/* Impact totals */}
      {r.atRiskDays.length === 0 ? (
        <EmptyState
          icon={Sun}
          tone="positive"
          title="No rain risk to your booked work this week"
          description="No scheduled jobs fall on a likely-rainy day in the next 7 days."
        />
      ) : (
        <>
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
            <StatTile label="Jobs at risk" value={String(r.totals.jobs)} icon={CloudRain} accent />
            <StatTile label="Labor hours at risk" value={`${r.totals.laborHours}h`} icon={Clock} />
            <StatTile label="Revenue at risk" value={formatCurrency(r.totals.revenue)} icon={DollarSign} />
            <StatTile label="Customers affected" value={String(r.totals.customers)} icon={Users} />
          </div>

          <div className="space-y-3">
            <div className="flex items-center gap-2">
              <span className="w-6 h-6 rounded-md bg-accent/10 border border-accent/20 flex items-center justify-center shrink-0"><AlertTriangle className="w-3.5 h-3.5 text-accent-text" /></span>
              <h2 className="text-sm font-semibold text-ink tracking-tight">Days at risk</h2>
              <span className="flex-1 h-px bg-border" aria-hidden />
            </div>
            {r.atRiskDays.map(d => <RiskRow key={d.date} d={d} today={today} />)}
          </div>
        </>
      )}

      <p className="text-[11px] text-ink-faint text-center">
        Rescheduling uses your existing Rain Delay Center — it recalculates routes, drive time and recurring visits, and moves only that occurrence.
      </p>
    </div>
  )
}

function WeatherCard({ f, label }: { f: DayForecast; label: string }) {
  return (
    <Card className={cn('p-4', LEVEL_STYLE[weatherScore(f).level].ring)}>
      <div className="flex items-center justify-between gap-2">
        <p className="text-[10px] font-semibold uppercase tracking-wide text-ink-faint">{label}</p>
        <ScoreBadge f={f} />
      </div>
      <div className="flex items-center gap-3 mt-1">
        <span className="text-3xl leading-none">{f.emoji}</span>
        <div>
          <p className="text-sm font-bold text-ink">{f.label}</p>
          <p className="text-[11px] text-ink-muted">{f.precipProbability}% rain · {f.precipMm}mm{f.tempMax != null ? ` · ${f.tempMax}°/${f.tempMin}°` : ''}</p>
          <p className="text-[11px] text-ink-muted flex items-center gap-1 mt-0.5"><Wind className="w-3 h-3" /> {f.windKph} km/h</p>
        </div>
      </div>
      {f.severe && <p className="text-[11px] font-semibold text-red-400 mt-2 flex items-center gap-1"><AlertTriangle className="w-3 h-3" /> Severe — strong reschedule signal</p>}
    </Card>
  )
}

function RiskRow({ d, today }: { d: DayImpact; today: string }) {
  return (
    <Card className="p-4">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-sm font-bold text-ink flex items-center gap-1.5 flex-wrap">
            <span className="text-lg leading-none">{d.forecast.emoji}</span>
            {dayLabel(d.date, today)} — {d.forecast.label}
            <ScoreBadge f={d.forecast} />
          </p>
          <p className="text-[11px] text-ink-muted mt-0.5">{d.forecast.precipProbability}% rain · {d.forecast.precipMm}mm · wind {d.forecast.windKph} km/h · {d.jobs} job{d.jobs !== 1 ? 's' : ''} · {d.laborHours}h · {formatCurrency(d.revenue)} · {d.customers} customer{d.customers !== 1 ? 's' : ''}</p>
        </div>
        <Link href="/dashboard/schedule" className="shrink-0"><Button size="sm" variant="secondary">Open Weather Ops <ArrowRight className="w-3.5 h-3.5" /></Button></Link>
      </div>

      {/* The action recommendation — Delay N / Monitor / Keep */}
      <p className={cn('text-xs font-semibold mt-2 flex items-center gap-1.5', LEVEL_STYLE[d.score.level].text)}>
        <span className={cn('w-1.5 h-1.5 rounded-full shrink-0', LEVEL_STYLE[d.score.level].dot)} /> {d.recommendation.text}
      </p>

      <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 mt-3">
        <Mini label="Booked" value={`${d.laborHours}h`} />
        <Mini label="Capacity" value={`${d.capacityHours}h`} />
        <Mini label="Utilization" value={`${d.utilizationPct}%`} tone={d.overbooked ? 'text-red-400' : undefined} />
        <Mini label="Best dry day" value={d.recommendedDay ? format(parseISO(d.recommendedDay + 'T00:00:00'), 'EEE d') : '—'} tone="text-emerald-400" />
      </div>
      <p className={cn('text-[11px] mt-2 flex items-center gap-1.5', d.recommendedOverbooks ? 'text-amber-400' : 'text-ink-muted')}>
        {d.recommendedOverbooks && <AlertTriangle className="w-3 h-3 shrink-0" />}{d.recommendedNote}
      </p>
    </Card>
  )
}

function Mini({ label, value, tone }: { label: string; value: string; tone?: string }) {
  return (
    <div className="rounded-md bg-bg-tertiary border border-border px-2 py-1.5 text-center">
      <p className="text-[9px] uppercase tracking-wide text-ink-faint">{label}</p>
      <p className={cn('text-sm font-bold text-ink tabular-nums', tone)}>{value}</p>
    </div>
  )
}