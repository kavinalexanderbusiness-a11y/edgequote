'use client'

import { useEffect, useRef, useState } from 'react'
import { createClient } from '@/lib/supabase/client'
import { Job, JobStatus, JobRecurrence, JobLineItem, RecurrenceScope, PRICE_REASONS, JOB_STATUS_LABELS, JOB_STATUS_COLORS } from '@/types'
import { Coord } from '@/lib/geo'
import { RouteStop, OrderedRouteStop, geocodeMissingStops, optimizeRoute, nearestNeighborRoute, roundTripMapsUrl, routeStats, directionsUrl, computeDayEtas, roughFinishEstimate, dayLoad, minutesToTime12, DEFAULT_JOB_MIN } from '@/lib/route'
import { buildRoadDistance } from '@/lib/distance'
import { jobVisitValue, effectiveFreq, quoteVisitAmount } from '@/lib/invoicing'
import { addonsTotal } from '@/lib/jobPricing'
import { formatCurrency, cn, localTodayISO } from '@/lib/utils'
import { Button } from '@/components/ui/Button'
import { JobPhotos } from '@/components/photos/JobPhotos'
import { JobAddons } from '@/components/schedule/JobAddons'
import {
  DollarSign, Clock, CheckCircle2, Check, Repeat, Navigation, ExternalLink,
  MapPin, Plus, Pencil, Move, Route as RouteIcon, ListChecks, Wallet, Hourglass, SlidersHorizontal, AlertTriangle, Trash2, CloudRain, Play, Timer, Camera, PlusCircle,
} from 'lucide-react'

export interface QuoteLite {
  id: string
  total: number | null
  initial_price: number | null
  weekly_price: number | null
  biweekly_price: number | null
  monthly_price: number | null
}

interface Props {
  date: string
  dateLabel: string
  jobs: Job[] // the day's jobs (all statuses)
  quotesById: Record<string, QuoteLite>
  recurrences: Record<string, JobRecurrence>
  baseCoord: Coord | null
  onOpenJob: (job: Job) => void
  onStartJob: (job: Job) => void
  onMarkDone: (job: Job) => void
  onMove: (job: Job, newDateISO: string) => void
  onDeleteJob: (job: Job) => void
  onSetPrice: (job: Job, price: number | null, reason?: string) => Promise<void>
  workStartTime: string
  capacityHours: number
  onRainDelay: () => void
  onAddJob: () => void
  onQuickSave: (job: Job, patch: QuickPatch) => Promise<void>
  // Add-on services per visit + handlers (the JOB is the source of truth; these
  // are additive and flow into the draft invoice automatically).
  addonsByJobId: Record<string, JobLineItem[]>
  onAddLineItem: (job: Job, input: { description: string; amount: number; serviceKey: string; scope: RecurrenceScope }) => Promise<void>
  onDeleteLineItem: (item: JobLineItem) => Promise<void>
  // The previous visit's add-ons (for the one-tap "copy previous" action).
  getPreviousAddons: (job: Job) => { description: string; amount: number; serviceKey: string }[]
  onCopyPreviousAddons: (job: Job) => Promise<void>
}

export interface QuickPatch {
  start_time: string | null
  crew_size: number
  duration_minutes: number | null
  status: JobStatus
  notes: string | null
  price: number | null
}

export function DayOpsPanel({
  date, dateLabel, jobs, quotesById, recurrences, baseCoord,
  onOpenJob, onStartJob, onMarkDone, onMove, onDeleteJob, onSetPrice, workStartTime, capacityHours, onRainDelay, onAddJob, onQuickSave,
  addonsByJobId, onAddLineItem, onDeleteLineItem, getPreviousAddons, onCopyPreviousAddons,
}: Props) {
  const supabase = createClient()
  const [quickId, setQuickId] = useState<string | null>(null)
  const [moveId, setMoveId] = useState<string | null>(null)
  const [qv, setQv] = useState<{ start_time: string; crew_size: number; duration_minutes: number; status: JobStatus; notes: string; price: number }>({ start_time: '', crew_size: 1, duration_minutes: 0, status: 'scheduled', notes: '', price: 0 })
  const [savingQuick, setSavingQuick] = useState(false)
  // First-class price: a dedicated, price-only inline editor on every card.
  const [priceId, setPriceId] = useState<string | null>(null)
  const [priceVal, setPriceVal] = useState('')
  const [priceReason, setPriceReason] = useState('')
  const [savingPrice, setSavingPrice] = useState(false)
  // Which job's before/after photo panel is open.
  const [photoId, setPhotoId] = useState<string | null>(null)
  // Which job's add-on services panel is open.
  const [addonsId, setAddonsId] = useState<string | null>(null)

  function openPrice(job: Job) {
    setQuickId(null); setMoveId(null); setPhotoId(null); setAddonsId(null)
    setPriceId(job.id)
    setPriceVal(job.price != null ? String(job.price) : '')
    setPriceReason('')
  }
  async function savePrice(job: Job) {
    setSavingPrice(true)
    const t = priceVal.trim()
    const next = t === '' ? null : (Number(t) > 0 ? Number(t) : null)
    // A reason is only meaningful on an increase (the user's rule); send it only then.
    const isIncrease = next != null && next > Math.round(jobValue(job))
    await onSetPrice(job, next, isIncrease ? (priceReason.trim() || undefined) : undefined)
    setSavingPrice(false)
    setPriceId(null)
  }
  // The quote-derived value for a job, ignoring any manual override — so the
  // editor can show "from quote" and offer a one-tap revert.
  function quoteValueFor(job: Job): number {
    const q = job.quote_id ? quotesById[job.quote_id] : null
    if (!q) return 0
    const rec = job.recurrence_id ? recurrences[job.recurrence_id] : null
    const freq = rec ? effectiveFreq(rec.freq, rec.interval_unit, rec.interval_count) : null
    // The anchor visit derives the quote's INITIAL price, not the cadence price.
    return quoteVisitAmount(q as unknown as Record<string, unknown>, job.is_initial_visit ? null : freq)
  }
  function cadenceLabelFor(job: Job): string {
    if (job.is_initial_visit) return 'initial visit'
    const rec = job.recurrence_id ? recurrences[job.recurrence_id] : null
    const freq = rec ? effectiveFreq(rec.freq, rec.interval_unit, rec.interval_count) : null
    return freq ?? 'first visit'
  }

  function openQuick(job: Job) {
    setPriceId(null); setMoveId(null)
    setQuickId(job.id)
    setQv({
      start_time: job.start_time || '',
      crew_size: job.crew_size,
      duration_minutes: job.duration_minutes || 0,
      status: job.status,
      notes: job.notes || '',
      price: Number(job.price) || 0,
    })
  }
  async function saveQuick(job: Job) {
    setSavingQuick(true)
    await onQuickSave(job, {
      start_time: qv.start_time || null,
      crew_size: Number(qv.crew_size) || 1,
      duration_minutes: qv.duration_minutes ? Number(qv.duration_minutes) : null,
      status: qv.status,
      notes: qv.notes || null,
      price: qv.price ? Number(qv.price) : null,
    })
    setSavingQuick(false)
    setQuickId(null)
  }
  const [route, setRoute] = useState<{ ordered: OrderedRouteStop[]; totalKm: number; mapsUrl: string | null; usedGoogle: boolean; usedRoad: boolean } | null>(null)
  const [routing, setRouting] = useState(false)
  const lastKey = useRef<string>('')

  // The BASE value of one visit, from its quote/price (cadence-aware). One engine.
  function jobValue(job: Job): number {
    const q = job.quote_id ? quotesById[job.quote_id] : null
    const rec = job.recurrence_id ? recurrences[job.recurrence_id] : null
    const freq = rec ? effectiveFreq(rec.freq, rec.interval_unit, rec.interval_count) : null
    return jobVisitValue(job.price, q as unknown as Record<string, unknown>, freq, job.is_initial_visit)
  }
  // Add-ons on a visit + the TOTAL job value (base + add-ons) — the number the
  // invoice will bill. Shown everywhere money is shown.
  function addonsFor(job: Job): JobLineItem[] { return addonsByJobId[job.id] || [] }
  function jobTotal(job: Job): number { return jobValue(job) + addonsTotal(addonsFor(job)) }

  const active = jobs.filter(j => j.status !== 'cancelled')
  const completed = active.filter(j => j.status === 'completed')
  const remaining = active.filter(j => j.status !== 'completed')
  const totalMin = active.reduce((s, j) => s + (j.duration_minutes || 0), 0)
  const estHours = Math.round((totalMin / 60) * 10) / 10
  const totalRevenue = active.reduce((s, j) => s + jobTotal(j), 0)
  const revenueCompleted = completed.reduce((s, j) => s + jobTotal(j), 0)
  const revenueRemaining = remaining.reduce((s, j) => s + jobTotal(j), 0)
  const locatedCoords = active
    .filter(j => j.properties?.lat != null && j.properties?.lng != null)
    .map(j => ({ lat: j.properties!.lat as number, lng: j.properties!.lng as number }))
  const totalStops = locatedCoords.length
  const completionPct = active.length ? Math.round((completed.length / active.length) * 100) : 0

  // Optimize the day's route via the shared engine. Re-runs only when the set of
  // active jobs (or the base) changes — not when a status flips — so marking Done
  // doesn't re-hit the routing API.
  useEffect(() => {
    const key = date + '|' + (baseCoord ? `${baseCoord.lat},${baseCoord.lng}` : 'no-base') + '|' + active.map(j => j.id).join(',')
    if (key === lastKey.current) return
    lastKey.current = key
    let alive = true
    async function run() {
      if (!baseCoord || active.length === 0) { setRoute(null); return }
      setRouting(true)
      const stops: RouteStop[] = active.map(job => ({
        jobId: job.id,
        title: job.customers?.name || job.title,
        address: job.properties?.address || job.title,
        propertyId: job.properties?.id ?? null,
        lat: job.properties?.lat ?? null,
        lng: job.properties?.lng ?? null,
      }))
      await geocodeMissingStops(supabase, stops)
      const located = stops.filter(s => s.lat != null && s.lng != null)
      // Prefer cached real-road distances (fetched once, reused) for ordering and
      // km; fall back to the Directions API / haversine when none are available.
      const { data: { user } } = await supabase.auth.getUser()
      if (user && located.length > 1) {
        const { dist, usedRoad } = await buildRoadDistance(supabase, user.id, [baseCoord, ...located.map(s => ({ lat: s.lat as number, lng: s.lng as number }))])
        if (usedRoad) {
          const nn = nearestNeighborRoute(baseCoord, located, dist)
          if (alive) setRoute({ ordered: nn.ordered, totalKm: nn.totalKm, mapsUrl: roundTripMapsUrl(baseCoord, nn.ordered), usedGoogle: true, usedRoad: true })
          if (alive) setRouting(false)
          return
        }
      }
      const res = await optimizeRoute(baseCoord, stops)
      if (alive) setRoute({ ordered: res.ordered, totalKm: res.totalKm, mapsUrl: res.mapsUrl, usedGoogle: res.usedGoogle, usedRoad: false })
      if (alive) setRouting(false)
    }
    run()
    return () => { alive = false }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [date, baseCoord?.lat, baseCoord?.lng, active.map(j => j.id).join(',')])

  const orderByJobId = new Map(route?.ordered.map(s => [s.jobId, s.order]) ?? [])
  const sortedJobs = [...active].sort((a, b) => {
    const oa = orderByJobId.get(a.id) ?? 999
    const ob = orderByJobId.get(b.id) ?? 999
    if (oa !== ob) return oa - ob
    return (a.start_time || '').localeCompare(b.start_time || '')
  })
  const stats = route && totalStops > 0 ? routeStats(locatedCoords, route.totalKm) : null

  // Real-world timing: work start + route order + drive legs + job durations →
  // an arrival time per stop and the day's estimated finish (ONE engine, lib/route).
  const durByJob: Record<string, number> = {}
  for (const j of active) durByJob[j.id] = j.duration_minutes || DEFAULT_JOB_MIN
  const etas = route && route.ordered.length > 0 ? computeDayEtas(workStartTime, route.ordered, durByJob) : null
  const etaByJob: Record<string, string> = {}
  if (etas) for (const s of etas.stops) etaByJob[s.jobId] = s.arrival
  const laborTotalMin = active.reduce((s, j) => s + (j.duration_minutes || DEFAULT_JOB_MIN), 0)
  const load = dayLoad(laborTotalMin + (stats ? stats.driveMinutes : active.length * 10), capacityHours)

  // ── Live day tracking (check-in/check-out data) ──
  const isToday = date === localTodayISO()
  const inProgress = active.find(j => j.status === 'in_progress') ?? null
  const tsTo12 = (iso: string) => { const t = new Date(iso); return minutesToTime12(t.getHours() * 60 + t.getMinutes()) }
  const elapsedMin = (iso: string) => Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 60000))
  const firstStart = active.map(j => j.started_at).filter(Boolean).sort()[0] as string | undefined
  const workedMin = completed.reduce((s, j) => s + (j.actual_minutes || 0), 0)
    + (inProgress?.started_at ? elapsedMin(inProgress.started_at) : 0)
  const live = isToday && (!!inProgress || (!!firstStart && completed.length > 0))
  // Re-render each minute while a job is running so elapsed/finish stay current.
  const [, setTick] = useState(0)
  useEffect(() => {
    if (!isToday || !inProgress) return
    const t = setInterval(() => setTick(x => x + 1), 60000)
    return () => clearInterval(t)
  }, [isToday, inProgress])
  // Finish estimate: live (now + what's left) once the day is underway, else the
  // planned route ETAs from work start.
  let estFinish: string
  if (active.length === 0) estFinish = '—'
  else if (remaining.length === 0) estFinish = 'Done'
  else if (live) {
    const now = new Date()
    const curElapsed = inProgress?.started_at ? elapsedMin(inProgress.started_at) : 0
    const remainingLabor = remaining.reduce((s, j) => s + (j.duration_minutes || DEFAULT_JOB_MIN), 0)
      - (inProgress ? Math.min(curElapsed, inProgress.duration_minutes || DEFAULT_JOB_MIN) : 0)
    const remainingLegs = remaining.filter(j => j.id !== inProgress?.id).length * 10
    estFinish = minutesToTime12(now.getHours() * 60 + now.getMinutes() + Math.max(5, remainingLabor) + remainingLegs)
  } else {
    estFinish = etas?.finish ?? roughFinishEstimate(workStartTime, laborTotalMin, active.length).finish
  }

  return (
    <div className="rounded-card border border-border bg-bg-secondary overflow-hidden">
      {/* Header: date + add */}
      <div className="px-4 py-3 border-b border-border flex items-center justify-between gap-3 bg-gradient-to-r from-accent/5 to-transparent">
        <div className="min-w-0 flex items-center gap-2">
          <p className="text-sm font-bold text-ink truncate">{dateLabel}</p>
          {active.length > 0 && (
            <span className={cn(
              'text-[10px] font-semibold uppercase tracking-wide rounded px-1.5 py-0.5 border shrink-0',
              load.state === 'overloaded' ? 'text-red-400 border-red-500/30 bg-red-500/10'
                : load.state === 'room' ? 'text-emerald-400 border-emerald-500/30 bg-emerald-500/10'
                : 'text-ink-muted border-border bg-bg-tertiary'
            )}>
              {load.state === 'overloaded' ? `Over by ${Math.round(-load.spareMin / 6) / 10}h`
                : load.state === 'room' ? `Room for ~${Math.round(load.spareMin / 6) / 10}h`
                : 'Full day'}
            </span>
          )}
        </div>
        <div className="flex items-center gap-2 shrink-0">
          {remaining.length > 0 && (
            <Button size="sm" variant="secondary" onClick={onRainDelay} title="Bump all remaining jobs to your next work day">
              <CloudRain className="w-4 h-4" /> Rain delay
            </Button>
          )}
          <Button size="sm" onClick={onAddJob}><Plus className="w-4 h-4" /> Add job</Button>
        </div>
      </div>

      {/* Daily revenue forecast — the first thing you see */}
      <div className="grid grid-cols-3 sm:grid-cols-5 sm:divide-x divide-border border-b border-border">
        <Metric icon={DollarSign} label="Planned" value={formatCurrency(totalRevenue)} tone="text-accent" />
        <Metric icon={Wallet} label="Completed" value={formatCurrency(revenueCompleted)} tone="text-emerald-400" />
        <Metric icon={DollarSign} label="Remaining" value={formatCurrency(revenueRemaining)} tone="text-amber-400" />
        <Metric icon={ListChecks} label="Jobs left" value={String(remaining.length)} />
        <Metric icon={Hourglass} label="Est. finish" value={estFinish} />
      </div>

      {/* Live day tracking — appears once the day is underway */}
      {live && (
        <div className="px-4 py-2 border-b border-border bg-sky-400/5 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs">
          <span className="flex items-center gap-1.5 font-semibold text-sky-300"><Timer className="w-3.5 h-3.5" /> Live</span>
          {firstStart && <span className="text-ink-muted">Started <span className="text-ink font-medium">{tsTo12(firstStart)}</span></span>}
          {inProgress && (
            <span className="text-ink-muted">Now at <span className="text-ink font-medium">{inProgress.customers?.name || inProgress.title}</span>
              {inProgress.started_at && <span className="text-sky-300"> · {elapsedMin(inProgress.started_at)}m</span>}
            </span>
          )}
          <span className="text-ink-muted">Done <span className="text-ink font-medium">{completed.length}/{active.length}</span></span>
          <span className="text-ink-muted">Worked <span className="text-ink font-medium">{Math.floor(workedMin / 60)}h {workedMin % 60}m</span></span>
          <span className="text-ink-muted">Finish <span className="text-ink font-medium">~{estFinish}</span></span>
        </div>
      )}

      {active.length === 0 ? (
        <button onClick={onAddJob} className="w-full text-center py-12 text-sm text-ink-muted hover:text-ink transition-colors">
          No jobs this day. Tap to add one.
        </button>
      ) : (
        <div className="p-4 space-y-4">
          {/* Day operations breakdown */}
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 text-xs">
            <Stat label="Jobs done" value={`${completed.length} / ${active.length}`} />
            <Stat label="Completion" value={`${completionPct}%`} tone={completionPct === 100 && active.length > 0 ? 'text-emerald-400' : undefined} />
            <Stat label="Est. hours" value={totalMin > 0 ? `${estHours}h` : '—'} />
            <Stat label="Stops" value={String(totalStops)} />
          </div>

          {/* Route intelligence */}
          <div className="rounded-xl border border-border bg-bg-tertiary px-3 py-2.5">
            <div className="flex items-center justify-between gap-2">
              <span className="flex items-center gap-1.5 text-xs font-semibold text-ink-muted uppercase tracking-wide">
                <RouteIcon className="w-3.5 h-3.5 text-accent" /> Route
              </span>
              {route?.mapsUrl && (
                <a href={route.mapsUrl} target="_blank" rel="noopener noreferrer" className="text-xs text-accent font-medium flex items-center gap-1 hover:underline">
                  <ExternalLink className="w-3 h-3" /> Open in Maps
                </a>
              )}
            </div>
            {!baseCoord ? (
              <p className="text-xs text-amber-400 mt-1.5">Set your base address in Settings to optimize the route.</p>
            ) : routing ? (
              <p className="text-xs text-ink-faint mt-1.5">Optimizing route…</p>
            ) : route && stats ? (
              <div className="flex flex-wrap items-center gap-x-4 gap-y-1 mt-1.5 text-xs text-ink-muted">
                <span className="flex items-center gap-1"><Navigation className="w-3 h-3" /> ~{route.totalKm} km</span>
                {route.usedRoad && <span className="text-[10px] font-semibold uppercase tracking-wide text-emerald-400 border border-emerald-500/30 bg-emerald-500/10 rounded px-1.5 py-0.5">Real-road</span>}
                <span className="flex items-center gap-1"><Clock className="w-3 h-3" /> ~{stats.driveMinutes} min driving</span>
                <span className="flex items-center gap-1"><MapPin className="w-3 h-3" /> {stats.clusters} cluster{stats.clusters !== 1 ? 's' : ''}</span>
                <span>{stats.avgLegKm} km avg between stops</span>
              </div>
            ) : (
              <p className="text-xs text-ink-faint mt-1.5">No locatable stops yet.</p>
            )}
          </div>

          {/* Jobs in route order, with one-tap actions */}
          <div className="space-y-2">
            {sortedJobs.map(job => {
              const order = orderByJobId.get(job.id)
              const done = job.status === 'completed'
              const value = jobValue(job)            // base
              const addons = addonsFor(job)
              const total = value + addonsTotal(addons)  // base + add-ons (billed amount)
              const qVal = quoteValueFor(job)
              return (
                <div key={job.id} className={cn('rounded-xl border px-3 py-2.5', JOB_STATUS_COLORS[job.status])}>
                  <div className="flex items-start gap-2.5">
                    <div className={cn(
                      'w-7 h-7 rounded-full flex items-center justify-center text-xs font-bold shrink-0 mt-0.5',
                      done ? 'bg-emerald-500/20 text-emerald-300'
                        : job.status === 'in_progress' ? 'bg-sky-400 text-black animate-pulse'
                        : 'bg-accent text-black'
                    )}>
                      {done ? <Check className="w-4 h-4" /> : job.status === 'in_progress' ? <Play className="w-3.5 h-3.5 fill-current" /> : (order ?? '–')}
                    </div>
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center justify-between gap-2">
                        <span className="flex items-center gap-1.5 text-sm font-semibold min-w-0">
                          {job.recurrence_id && <Repeat className="w-3 h-3 shrink-0 opacity-70" />}
                          <span className={cn('truncate', done && 'line-through opacity-80')}>{job.customers?.name || job.title}</span>
                        </span>
                        <div className="flex items-center gap-1.5 shrink-0">
                          {total > 0
                            ? <button onClick={e => { e.stopPropagation(); priceId === job.id ? setPriceId(null) : openPrice(job) }}
                                title={addons.length ? `Base ${formatCurrency(value)} + add-ons ${formatCurrency(addonsTotal(addons))} · tap to edit base price` : 'Edit price'}
                                className="flex items-center gap-1 text-sm font-bold text-ink rounded-md px-1.5 py-0.5 hover:bg-black/10 transition-colors">
                                {formatCurrency(total)}<Pencil className="w-3 h-3 opacity-40" />
                              </button>
                            : <button onClick={e => { e.stopPropagation(); priceId === job.id ? setPriceId(null) : openPrice(job) }}
                                title="Set price"
                                className="text-[10px] font-semibold uppercase tracking-wide text-amber-400 border border-amber-500/30 bg-amber-500/10 rounded px-1.5 py-0.5 flex items-center gap-1 hover:bg-amber-500/20">
                                <AlertTriangle className="w-3 h-3" /> Set price
                              </button>}
                          <button
                            onClick={e => { e.stopPropagation(); onDeleteJob(job) }}
                            title="Delete job" aria-label="Delete job"
                            className="h-7 w-7 rounded-lg border border-red-500/30 bg-red-500/15 text-red-400 hover:bg-red-500/25 flex items-center justify-center active:scale-95 transition-transform"
                          >
                            <Trash2 className="w-3.5 h-3.5" />
                          </button>
                        </div>
                      </div>

                      {/* Clean price-only editor — first-class, opens inline */}
                      {priceId === job.id && (
                        <div className="mt-2 rounded-lg border border-border bg-bg-secondary p-2.5 space-y-2" onClick={e => e.stopPropagation()}>
                          {job.recurrence_id && (
                            <div className="flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-wide text-accent">
                              <Repeat className="w-3 h-3" /> Recurring series pricing
                            </div>
                          )}
                          <label className="text-[10px] uppercase tracking-wide text-ink-faint block">Price ($/visit)
                            <input type="number" min="0" step="5" autoFocus
                              placeholder={qVal > 0 ? `${qVal} from quote` : 'e.g. 55'}
                              value={priceVal}
                              onChange={e => setPriceVal(e.target.value)}
                              onKeyDown={e => { if (e.key === 'Enter') savePrice(job) }}
                              className="w-full mt-0.5 bg-bg-tertiary border border-border-strong rounded-lg px-2 py-1.5 text-sm text-ink outline-none focus:border-accent" />
                          </label>
                          {/* Decision-first: the change at a glance (Original → New). */}
                          {(() => {
                            const current = value
                            const next = priceVal.trim() ? Number(priceVal) : qVal
                            if (!(next > 0) || Math.round(next) === Math.round(current)) return null
                            return (
                              <p className="text-xs text-ink">
                                <span className="text-ink-faint">{formatCurrency(current)}</span>
                                <span className="text-ink-faint mx-1">→</span>
                                <span className="font-semibold text-accent">{formatCurrency(next)}</span>
                              </p>
                            )
                          })()}
                          {/* Reason is only asked on an INCREASE (audit trail for
                              upsells/surcharges); decreases & corrections save instantly. */}
                          {(() => {
                            const next = priceVal.trim() ? Number(priceVal) : qVal
                            const isIncrease = next > 0 && Math.round(next) > Math.round(value)
                            if (!isIncrease) return null
                            const presets = PRICE_REASONS.filter(r => r !== 'Custom')
                            const isCustom = priceReason !== '' && !presets.includes(priceReason as typeof presets[number])
                            return (
                              <div className="space-y-1.5">
                                <p className="text-[10px] uppercase tracking-wide text-ink-faint">Reason for increase</p>
                                <div className="flex flex-wrap gap-1.5">
                                  {presets.map(r => (
                                    <button key={r} type="button" onClick={() => setPriceReason(r)}
                                      className={cn('text-[11px] font-medium rounded-full px-2 py-0.5 border transition-colors',
                                        priceReason === r ? 'bg-accent text-black border-accent' : 'border-border text-ink-muted hover:text-ink')}>
                                      {r}
                                    </button>
                                  ))}
                                  <button type="button" onClick={() => setPriceReason(isCustom ? '' : ' ')}
                                    className={cn('text-[11px] font-medium rounded-full px-2 py-0.5 border transition-colors',
                                      isCustom ? 'bg-accent text-black border-accent' : 'border-border text-ink-muted hover:text-ink')}>
                                    Custom
                                  </button>
                                </div>
                                {isCustom && (
                                  <input type="text" autoFocus value={priceReason.trim()} onChange={e => setPriceReason(e.target.value || ' ')}
                                    placeholder="Describe the increase" className="w-full bg-bg-tertiary border border-border-strong rounded-lg px-2 py-1.5 text-xs text-ink outline-none focus:border-accent" />
                                )}
                              </div>
                            )
                          })()}
                          {qVal > 0 && (
                            <div className="flex items-center justify-between gap-2 text-[11px]">
                              <span className="text-ink-faint">From quote · {cadenceLabelFor(job)}: <span className="text-ink-muted font-medium">{formatCurrency(qVal)}</span></span>
                              <button type="button" onClick={() => setPriceVal('')} className="text-accent hover:underline font-medium">Use quote price</button>
                            </div>
                          )}
                          <div className="flex items-center gap-2">
                            <Button size="sm" onClick={() => savePrice(job)} loading={savingPrice}>Save price</Button>
                            <Button size="sm" variant="ghost" onClick={() => setPriceId(null)}>Cancel</Button>
                            {job.price != null
                              ? <span className="text-[10px] text-amber-400 ml-auto">Manual override</span>
                              : qVal > 0 ? <span className="text-[10px] text-ink-faint ml-auto">Auto from quote</span> : null}
                          </div>
                          <p className="text-[10px] text-ink-faint">Saving updates this visit's draft invoice automatically.</p>
                        </div>
                      )}
                      <div className="flex items-center gap-1.5 text-xs opacity-80 mt-0.5 flex-wrap">
                        {job.status === 'scheduled' && etaByJob[job.id] && (
                          <span className="font-semibold text-accent shrink-0">ETA {etaByJob[job.id]}</span>
                        )}
                        {job.status === 'in_progress' && job.started_at && (
                          <span className="font-semibold text-sky-300 shrink-0">▶ {tsTo12(job.started_at)} · {elapsedMin(job.started_at)}m</span>
                        )}
                        {done && job.started_at && job.completed_at && (
                          <span className="font-semibold text-emerald-300 shrink-0">{tsTo12(job.started_at)}–{tsTo12(job.completed_at)} · {job.actual_minutes ?? '?'}m</span>
                        )}
                        {done && job.actual_minutes != null && job.duration_minutes != null && job.duration_minutes > 0 && (
                          <span className={cn('text-[10px] font-semibold shrink-0', job.actual_minutes > job.duration_minutes ? 'text-amber-400' : 'text-emerald-400')}>
                            ({job.actual_minutes > job.duration_minutes ? '+' : ''}{job.actual_minutes - job.duration_minutes}m vs est {job.duration_minutes}m)
                          </span>
                        )}
                        {job.service_type && <span className="truncate">{job.service_type}</span>}
                        {job.start_time && <span>· {job.start_time.slice(0, 5)}</span>}
                        {/* At-a-glance add-on indicator — names when few, else count */}
                        {addons.length > 0 && (
                          <button onClick={e => { e.stopPropagation(); setQuickId(null); setMoveId(null); setPriceId(null); setPhotoId(null); setAddonsId(addonsId === job.id ? null : job.id) }}
                            title={addons.map(a => `${a.description} ${formatCurrency(Number(a.amount))}`).join(' · ')}
                            className="text-[10px] font-semibold text-accent border border-accent/30 bg-accent/10 rounded px-1.5 py-0.5 shrink-0 hover:bg-accent/20">
                            +{addons.length <= 2 ? addons.map(a => a.description).join(' + ') : `${addons.length} services`}
                          </button>
                        )}
                        <span className="px-1.5 py-0.5 rounded border border-current/30 text-[10px] font-semibold uppercase tracking-wide">{JOB_STATUS_LABELS[job.status]}</span>
                      </div>

                      {/* One-tap actions */}
                      <div className="flex items-center gap-1.5 mt-2 flex-wrap">
                        {job.status === 'scheduled' && <ActionBtn onClick={() => onStartJob(job)} icon={Play} label="Start" tone="sky" />}
                        {job.status === 'in_progress' && <ActionBtn onClick={() => onMarkDone(job)} icon={CheckCircle2} label="Complete" tone="emerald" />}
                        <ActionBtn onClick={() => (quickId === job.id ? setQuickId(null) : openQuick(job))} icon={SlidersHorizontal} label="Quick" />
                        <ActionBtn onClick={() => onOpenJob(job)} icon={Pencil} label="Open" />
                        <ActionBtn onClick={() => { setQuickId(null); setMoveId(null); setPriceId(null); setAddonsId(null); setPhotoId(photoId === job.id ? null : job.id) }} icon={Camera} label="Photos" />
                        <ActionBtn onClick={() => { setQuickId(null); setMoveId(null); setPriceId(null); setPhotoId(null); setAddonsId(addonsId === job.id ? null : job.id) }} icon={PlusCircle} label={addons.length ? `Services (${addons.length})` : 'Services'} />
                        <ActionBtn onClick={() => setMoveId(moveId === job.id ? null : job.id)} icon={Move} label="Move" />
                        <a
                          href={directionsUrl({ lat: job.properties?.lat ?? null, lng: job.properties?.lng ?? null, address: job.properties?.address }, baseCoord)}
                          target="_blank" rel="noopener noreferrer"
                          className="h-8 px-2.5 rounded-lg border border-current/30 text-xs font-medium flex items-center gap-1 hover:bg-black/10"
                        >
                          <Navigation className="w-3.5 h-3.5" /> Route to
                        </a>
                      </div>

                      {/* Move to another day — drag isn't available within a single day */}
                      {moveId === job.id && (
                        <div className="mt-2 flex items-center gap-2 flex-wrap" onClick={e => e.stopPropagation()}>
                          <span className="text-xs text-ink-muted">Move to</span>
                          <input type="date" defaultValue={date}
                            onChange={e => { if (e.target.value && e.target.value !== date) { onMove(job, e.target.value); setMoveId(null) } }}
                            className="bg-bg-secondary border border-border-strong rounded-lg px-2 py-1.5 text-sm text-ink outline-none focus:border-accent" />
                          <button onClick={() => setMoveId(null)} className="text-xs text-ink-faint hover:text-ink">Cancel</button>
                        </div>
                      )}

                      {/* Before/after photos for this visit — proof of work + service history */}
                      {photoId === job.id && (
                        job.property_id ? (
                          <div className="mt-2 rounded-lg border border-border bg-bg-secondary p-2.5" onClick={e => e.stopPropagation()}>
                            <JobPhotos propertyId={job.property_id} jobId={job.id} customerId={job.customer_id} variant="visit" />
                          </div>
                        ) : (
                          <p className="mt-2 text-xs text-amber-400">Link a property to this job to attach photos.</p>
                        )
                      )}

                      {/* Extra services for this visit — add-ons flow into the invoice */}
                      {addonsId === job.id && (
                        <div className="mt-2 rounded-lg border border-border bg-bg-secondary p-2.5" onClick={e => e.stopPropagation()}>
                          <p className="text-[10px] uppercase tracking-wide text-ink-faint mb-2 flex items-center gap-1"><PlusCircle className="w-3 h-3" /> Extra services</p>
                          <JobAddons
                            baseValue={value}
                            items={addons}
                            isRecurring={!!job.recurrence_id}
                            onAdd={(input) => onAddLineItem(job, input)}
                            onDelete={onDeleteLineItem}
                            previousAddons={getPreviousAddons(job)}
                            onCopyPrevious={() => onCopyPreviousAddons(job)}
                          />
                        </div>
                      )}

                      {/* Inline quick edit — small changes without the full form */}
                      {quickId === job.id && (
                        <div className="mt-2 rounded-lg border border-border bg-bg-secondary p-2.5 space-y-2" onClick={e => e.stopPropagation()}>
                          <div className="grid grid-cols-3 gap-2">
                            <label className="text-[10px] uppercase tracking-wide text-ink-faint">Time
                              <input type="time" value={qv.start_time} onChange={e => setQv(v => ({ ...v, start_time: e.target.value }))}
                                className="w-full mt-0.5 bg-bg-tertiary border border-border-strong rounded-lg px-2 py-1.5 text-sm text-ink outline-none focus:border-accent" />
                            </label>
                            <label className="text-[10px] uppercase tracking-wide text-ink-faint">Crew
                              <input type="number" min="1" value={qv.crew_size} onChange={e => setQv(v => ({ ...v, crew_size: Number(e.target.value) || 1 }))}
                                className="w-full mt-0.5 bg-bg-tertiary border border-border-strong rounded-lg px-2 py-1.5 text-sm text-ink outline-none focus:border-accent" />
                            </label>
                            <label className="text-[10px] uppercase tracking-wide text-ink-faint">Mins
                              <input type="number" min="0" step="5" value={qv.duration_minutes} onChange={e => setQv(v => ({ ...v, duration_minutes: Number(e.target.value) || 0 }))}
                                className="w-full mt-0.5 bg-bg-tertiary border border-border-strong rounded-lg px-2 py-1.5 text-sm text-ink outline-none focus:border-accent" />
                            </label>
                          </div>
                          <label className="text-[10px] uppercase tracking-wide text-ink-faint block">Status
                            <select value={qv.status} onChange={e => setQv(v => ({ ...v, status: e.target.value as JobStatus }))}
                              className="w-full mt-0.5 bg-bg-tertiary border border-border-strong rounded-lg px-2 py-1.5 text-sm text-ink outline-none focus:border-accent">
                              {(['scheduled', 'in_progress', 'completed', 'cancelled'] as JobStatus[]).map(s => (
                                <option key={s} value={s} className="bg-bg-secondary">{JOB_STATUS_LABELS[s]}</option>
                              ))}
                            </select>
                          </label>
                          <textarea value={qv.notes} onChange={e => setQv(v => ({ ...v, notes: e.target.value }))} placeholder="Notes" rows={2}
                            className="w-full bg-bg-tertiary border border-border-strong rounded-lg px-2 py-1.5 text-sm text-ink outline-none focus:border-accent" />
                          <div className="flex items-center gap-2">
                            <Button size="sm" onClick={() => saveQuick(job)} loading={savingQuick}>Save</Button>
                            <Button size="sm" variant="ghost" onClick={() => setQuickId(null)}>Cancel</Button>
                            <span className="text-[10px] text-ink-faint ml-auto">This visit only · use Open for more</span>
                          </div>
                        </div>
                      )}
                    </div>
                  </div>
                </div>
              )
            })}
          </div>
        </div>
      )}
    </div>
  )
}

function Metric({ icon: Icon, label, value, tone }: { icon: typeof DollarSign; label: string; value: string; tone?: string }) {
  return (
    <div className="px-3 py-2.5 sm:px-4 sm:py-3">
      <div className="flex items-center gap-1.5 text-[10px] sm:text-[11px] font-semibold text-ink-muted uppercase tracking-wide">
        <Icon className="w-3.5 h-3.5 shrink-0" /> <span className="truncate">{label}</span>
      </div>
      <p className={cn('text-lg sm:text-xl font-bold tracking-tight mt-0.5 truncate', tone || 'text-ink')}>{value}</p>
    </div>
  )
}

function Stat({ label, value, tone }: { label: string; value: string; tone?: string }) {
  return (
    <div className="rounded-lg border border-border bg-bg-tertiary px-3 py-2">
      <p className="text-[10px] uppercase tracking-wide text-ink-faint">{label}</p>
      <p className={cn('text-sm font-bold mt-0.5', tone || 'text-ink')}>{value}</p>
    </div>
  )
}

function ActionBtn({ onClick, icon: Icon, label, tone }: { onClick: () => void; icon: typeof Pencil; label: string; tone?: 'emerald' | 'sky' }) {
  return (
    <button
      onClick={onClick}
      className={cn(
        'h-8 px-2.5 rounded-lg border text-xs font-medium flex items-center gap-1 active:scale-95 transition-transform',
        tone === 'emerald'
          ? 'bg-emerald-500/15 border-emerald-500/30 text-emerald-300 hover:bg-emerald-500/25'
          : tone === 'sky'
            ? 'bg-sky-400/15 border-sky-400/30 text-sky-300 hover:bg-sky-400/25'
            : 'border-current/30 hover:bg-black/10'
      )}
    >
      <Icon className="w-3.5 h-3.5" /> {label}
    </button>
  )
}
