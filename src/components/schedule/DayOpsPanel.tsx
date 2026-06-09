'use client'

import { useEffect, useRef, useState } from 'react'
import { createClient } from '@/lib/supabase/client'
import { Job, JobStatus, JobRecurrence, JOB_STATUS_LABELS, JOB_STATUS_COLORS } from '@/types'
import { Coord } from '@/lib/geo'
import { RouteStop, OrderedRouteStop, geocodeMissingStops, optimizeRoute, routeStats, directionsUrl } from '@/lib/route'
import { jobVisitValue, effectiveFreq } from '@/lib/invoicing'
import { formatCurrency, cn } from '@/lib/utils'
import { format } from 'date-fns'
import { Button } from '@/components/ui/Button'
import {
  DollarSign, Clock, CheckCircle2, Check, Repeat, Navigation, ExternalLink,
  MapPin, Plus, Pencil, Move, Route as RouteIcon, ListChecks, Wallet, Hourglass, SlidersHorizontal, AlertTriangle, Trash2,
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
  onMarkDone: (job: Job) => void
  onMove: (job: Job, newDateISO: string) => void
  onDeleteJob: (job: Job) => void
  onAddJob: () => void
  onQuickSave: (job: Job, patch: QuickPatch) => Promise<void>
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
  onOpenJob, onMarkDone, onMove, onDeleteJob, onAddJob, onQuickSave,
}: Props) {
  const supabase = createClient()
  const [quickId, setQuickId] = useState<string | null>(null)
  const [moveId, setMoveId] = useState<string | null>(null)
  const [qv, setQv] = useState<{ start_time: string; crew_size: number; duration_minutes: number; status: JobStatus; notes: string; price: number }>({ start_time: '', crew_size: 1, duration_minutes: 0, status: 'scheduled', notes: '', price: 0 })
  const [savingQuick, setSavingQuick] = useState(false)

  function openQuick(job: Job) {
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
  const [route, setRoute] = useState<{ ordered: OrderedRouteStop[]; totalKm: number; mapsUrl: string | null; usedGoogle: boolean } | null>(null)
  const [routing, setRouting] = useState(false)
  const lastKey = useRef<string>('')

  // The value of one visit of a job, from its quote (cadence-aware). One engine.
  function jobValue(job: Job): number {
    const q = job.quote_id ? quotesById[job.quote_id] : null
    const rec = job.recurrence_id ? recurrences[job.recurrence_id] : null
    const freq = rec ? effectiveFreq(rec.freq, rec.interval_unit, rec.interval_count) : null
    return jobVisitValue(job.price, q as unknown as Record<string, unknown>, freq)
  }

  const active = jobs.filter(j => j.status !== 'cancelled')
  const completed = active.filter(j => j.status === 'completed')
  const remaining = active.filter(j => j.status !== 'completed')
  const totalMin = active.reduce((s, j) => s + (j.duration_minutes || 0), 0)
  const estHours = Math.round((totalMin / 60) * 10) / 10
  const totalRevenue = active.reduce((s, j) => s + jobValue(j), 0)
  const revenueCompleted = completed.reduce((s, j) => s + jobValue(j), 0)
  const revenueRemaining = remaining.reduce((s, j) => s + jobValue(j), 0)
  const locatedCoords = active
    .filter(j => j.properties?.lat != null && j.properties?.lng != null)
    .map(j => ({ lat: j.properties!.lat as number, lng: j.properties!.lng as number }))
  const totalStops = locatedCoords.length
  const completionPct = active.length ? Math.round((completed.length / active.length) * 100) : 0
  const remainingMin = remaining.reduce((s, j) => s + (j.duration_minutes || 0), 0)
  const estFinish = active.length === 0 ? '—'
    : remaining.length === 0 ? 'Done'
    : remainingMin > 0 ? format(new Date(Date.now() + remainingMin * 60000), 'h:mm a') : 'Now'

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
      const res = await optimizeRoute(baseCoord, stops)
      if (alive) setRoute({ ordered: res.ordered, totalKm: res.totalKm, mapsUrl: res.mapsUrl, usedGoogle: res.usedGoogle })
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

  return (
    <div className="rounded-card border border-border bg-bg-secondary overflow-hidden">
      {/* Header: date + add */}
      <div className="px-4 py-3 border-b border-border flex items-center justify-between gap-3 bg-gradient-to-r from-accent/5 to-transparent">
        <p className="text-sm font-bold text-ink">{dateLabel}</p>
        <Button size="sm" onClick={onAddJob}><Plus className="w-4 h-4" /> Add job</Button>
      </div>

      {/* Daily revenue forecast — the first thing you see */}
      <div className="grid grid-cols-3 sm:grid-cols-5 divide-x divide-border border-b border-border">
        <Metric icon={DollarSign} label="Planned" value={formatCurrency(totalRevenue)} tone="text-accent" />
        <Metric icon={Wallet} label="Done" value={formatCurrency(revenueCompleted)} tone="text-emerald-400" />
        <Metric icon={DollarSign} label="Remaining" value={formatCurrency(revenueRemaining)} tone="text-amber-400" />
        <Metric icon={ListChecks} label="Jobs left" value={String(remaining.length)} />
        <Metric icon={Hourglass} label="Est. finish" value={estFinish} />
      </div>

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
              const value = jobValue(job)
              return (
                <div key={job.id} className={cn('rounded-xl border px-3 py-2.5', JOB_STATUS_COLORS[job.status])}>
                  <div className="flex items-start gap-2.5">
                    <div className={cn(
                      'w-7 h-7 rounded-full flex items-center justify-center text-xs font-bold shrink-0 mt-0.5',
                      done ? 'bg-emerald-500/20 text-emerald-300' : 'bg-accent text-black'
                    )}>
                      {done ? <Check className="w-4 h-4" /> : (order ?? '–')}
                    </div>
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center justify-between gap-2">
                        <span className="flex items-center gap-1.5 text-sm font-semibold min-w-0">
                          {job.recurrence_id && <Repeat className="w-3 h-3 shrink-0 opacity-70" />}
                          <span className={cn('truncate', done && 'line-through opacity-80')}>{job.customers?.name || job.title}</span>
                        </span>
                        <div className="flex items-center gap-1.5 shrink-0">
                          {value > 0
                            ? <span className="text-sm font-bold">{formatCurrency(value)}</span>
                            : <button onClick={e => { e.stopPropagation(); openQuick(job) }} className="text-[10px] font-semibold uppercase tracking-wide text-amber-400 border border-amber-500/30 bg-amber-500/10 rounded px-1.5 py-0.5 flex items-center gap-1 hover:bg-amber-500/20">
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
                      <div className="flex items-center gap-1.5 text-xs opacity-80 mt-0.5 flex-wrap">
                        {job.service_type && <span className="truncate">{job.service_type}</span>}
                        {job.start_time && <span>· {job.start_time.slice(0, 5)}</span>}
                        <span className="px-1.5 py-0.5 rounded border border-current/30 text-[10px] font-semibold uppercase tracking-wide">{JOB_STATUS_LABELS[job.status]}</span>
                      </div>

                      {/* One-tap actions */}
                      <div className="flex items-center gap-1.5 mt-2 flex-wrap">
                        <ActionBtn onClick={() => (quickId === job.id ? setQuickId(null) : openQuick(job))} icon={SlidersHorizontal} label="Quick" />
                        <ActionBtn onClick={() => onOpenJob(job)} icon={Pencil} label="Open" />
                        {!done && <ActionBtn onClick={() => onMarkDone(job)} icon={CheckCircle2} label="Done" tone="emerald" />}
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

                      {/* Inline quick edit — small changes without the full form */}
                      {quickId === job.id && (
                        <div className="mt-2 rounded-lg border border-border bg-bg-secondary p-2.5 space-y-2" onClick={e => e.stopPropagation()}>
                          <label className="text-[10px] uppercase tracking-wide text-ink-faint block">Price ($/visit)
                            <input type="number" min="0" step="5" placeholder="e.g. 55" value={qv.price || ''} onChange={e => setQv(v => ({ ...v, price: Number(e.target.value) || 0 }))}
                              className="w-full mt-0.5 bg-bg-tertiary border border-border-strong rounded-lg px-2 py-1.5 text-sm text-ink outline-none focus:border-accent" />
                          </label>
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
    <div className="px-4 py-3">
      <div className="flex items-center gap-1.5 text-[11px] font-semibold text-ink-muted uppercase tracking-wide">
        <Icon className="w-3.5 h-3.5" /> {label}
      </div>
      <p className={cn('text-xl font-bold tracking-tight mt-0.5', tone || 'text-ink')}>{value}</p>
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

function ActionBtn({ onClick, icon: Icon, label, tone }: { onClick: () => void; icon: typeof Pencil; label: string; tone?: 'emerald' }) {
  return (
    <button
      onClick={onClick}
      className={cn(
        'h-8 px-2.5 rounded-lg border text-xs font-medium flex items-center gap-1 active:scale-95 transition-transform',
        tone === 'emerald'
          ? 'bg-emerald-500/15 border-emerald-500/30 text-emerald-300 hover:bg-emerald-500/25'
          : 'border-current/30 hover:bg-black/10'
      )}
    >
      <Icon className="w-3.5 h-3.5" /> {label}
    </button>
  )
}
