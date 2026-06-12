'use client'

import { useEffect, useMemo, useState } from 'react'
import { addDays, format, parseISO } from 'date-fns'
import { createClient } from '@/lib/supabase/client'
import { Job, JobRecurrence } from '@/types'
import { Coord } from '@/lib/geo'
import { planRainDelay, OptJob, RainDelayPlan } from '@/lib/optimizer'
import { localTodayISO, formatCurrency, cn } from '@/lib/utils'
import { Button } from '@/components/ui/Button'
import { Card, CardBody } from '@/components/ui/Card'
import { CloudRain, X, ArrowRight, Check, Clock, Navigation, AlertTriangle, Repeat } from 'lucide-react'

interface Props {
  jobs: Job[]
  recurrences: Record<string, JobRecurrence>
  valueByJobId: Record<string, number>
  baseCoord: Coord | null
  preferredWorkDays: number[]
  capacityHours: number
  onApply: (moves: { jobId: string; from: string; to: string }[]) => Promise<void>
  onClose: () => void
}

// 🌧 Rain Delay Center: pick a rained-out day (tomorrow / next 3 days), see the
// affected revenue & hours, and bump everything to the next work days — capacity-
// aware, series-safe, billed jobs untouched. Apply is one tap with Undo.
export function RainDelayCenter({ jobs, recurrences, valueByJobId, baseCoord, preferredWorkDays, capacityHours, onApply, onClose }: Props) {
  const supabase = createClient()
  const [invoicedIds, setInvoicedIds] = useState<Set<string> | null>(null)
  const [selectedDay, setSelectedDay] = useState<string>(format(addDays(parseISO(localTodayISO()), 1), 'yyyy-MM-dd'))
  const [applying, setApplying] = useState(false)

  useEffect(() => {
    let active = true
    async function load() {
      const { data } = await supabase.from('invoices').select('job_id').not('job_id', 'is', null)
      if (active) setInvoicedIds(new Set(((data as { job_id: string }[]) || []).map(r => r.job_id)))
    }
    load()
    return () => { active = false }
  }, [supabase])

  const today = localTodayISO()
  const optJobs = useMemo<OptJob[]>(() => jobs.map(j => ({
    id: j.id, scheduled_date: j.scheduled_date, status: j.status,
    recurrence_id: j.recurrence_id, start_time: j.start_time, duration_minutes: j.duration_minutes,
    lat: j.properties?.lat ?? null, lng: j.properties?.lng ?? null,
    value: valueByJobId[j.id] || 0, invoiced: invoicedIds?.has(j.id) ?? false,
    title: j.title, customerName: j.customers?.name || j.title, customerId: j.customer_id,
  })), [jobs, valueByJobId, invoicedIds])

  // The next 3 candidate rain days (tomorrow + 2), with their at-a-glance load.
  const dayChips = useMemo(() => {
    return [1, 2, 3].map(n => {
      const date = format(addDays(parseISO(today), n), 'yyyy-MM-dd')
      const dj = jobs.filter(j => j.scheduled_date === date && j.status !== 'cancelled' && j.status !== 'completed')
      return {
        date,
        label: n === 1 ? 'Tomorrow' : format(parseISO(date + 'T00:00:00'), 'EEE, MMM d'),
        jobs: dj.length,
        revenue: Math.round(dj.reduce((s, j) => s + (valueByJobId[j.id] || 0), 0)),
        hours: Math.round((dj.reduce((s, j) => s + (j.duration_minutes || 45), 0) / 60) * 10) / 10,
      }
    })
  }, [jobs, valueByJobId, today])

  const recs = useMemo(() => {
    const m: Record<string, { freq: string | null; interval_unit: string | null; interval_count: number | null }> = {}
    for (const [id, r] of Object.entries(recurrences)) m[id] = { freq: r.freq, interval_unit: r.interval_unit, interval_count: r.interval_count }
    return m
  }, [recurrences])

  const plan: RainDelayPlan | null = useMemo(() => {
    if (invoicedIds === null) return null
    return planRainDelay(optJobs, selectedDay, {
      today, base: baseCoord, preferredDays: preferredWorkDays, capacityHours, recurrences: recs,
    })
  }, [optJobs, selectedDay, invoicedIds, baseCoord, preferredWorkDays, capacityHours, recs, today])

  async function apply() {
    if (!plan || plan.moves.length === 0) return
    setApplying(true)
    await onApply(plan.moves.map(m => ({ jobId: m.jobId, from: m.from, to: m.to })))
    setApplying(false)
    onClose()
  }

  const fmtDay = (iso: string) => format(parseISO(iso + 'T00:00:00'), 'EEE, MMM d')
  const fmtH = (min: number) => `${Math.round((min / 60) * 10) / 10}h`

  return (
    <div className="fixed inset-0 z-50 overflow-y-auto bg-black/60 backdrop-blur-sm" onClick={onClose}>
      <div className="min-h-full flex items-start justify-center p-4 sm:p-6">
        <Card className="w-full max-w-2xl my-2 shadow-2xl" onClick={e => e.stopPropagation()}>
          <div className="px-5 py-4 border-b border-border flex items-center justify-between">
            <h2 className="text-sm font-semibold text-ink flex items-center gap-2"><CloudRain className="w-4 h-4 text-sky-400" /> Rain Delay Center</h2>
            <button onClick={onClose} className="w-9 h-9 -mr-2 flex items-center justify-center text-ink-faint hover:text-ink"><X className="w-4 h-4" /></button>
          </div>
          <CardBody className="space-y-4">
            {/* Which day is rained out? */}
            <div className="grid grid-cols-3 gap-2">
              {dayChips.map(c => (
                <button key={c.date} onClick={() => setSelectedDay(c.date)}
                  className={cn('rounded-xl border p-3 text-left transition-colors',
                    selectedDay === c.date ? 'border-sky-400/60 bg-sky-400/10' : 'border-border-strong bg-surface hover:border-sky-400/40')}>
                  <p className="text-sm font-semibold text-ink">{c.label}</p>
                  <p className="text-[11px] text-ink-muted mt-0.5">
                    {c.jobs === 0 ? 'No jobs' : `${c.jobs} job${c.jobs !== 1 ? 's' : ''} · ${c.hours}h · ${formatCurrency(c.revenue)}`}
                  </p>
                </button>
              ))}
            </div>

            {invoicedIds === null && <p className="text-xs text-ink-faint text-center py-2">Checking billed jobs…</p>}

            {plan && plan.day.jobs === 0 && (
              <p className="text-sm text-ink-muted text-center py-6">Nothing scheduled on {fmtDay(selectedDay)} — no delay needed.</p>
            )}

            {plan && plan.day.jobs > 0 && (
              <div className="space-y-4">
                {/* Affected */}
                <div className="rounded-xl border border-sky-400/30 bg-sky-400/5 px-3.5 py-3 flex flex-wrap items-center gap-x-5 gap-y-1">
                  <p className="text-sm font-bold text-ink">🌧 {fmtDay(plan.day.date)}</p>
                  <span className="text-xs text-ink-muted">{plan.day.jobs} job{plan.day.jobs !== 1 ? 's' : ''} affected</span>
                  <span className="text-xs text-ink-muted flex items-center gap-1"><Clock className="w-3 h-3" /> {fmtH(plan.day.laborMin)} on-site</span>
                  <span className="text-xs font-semibold text-sky-300">{formatCurrency(plan.day.revenue)} at stake</span>
                </div>

                {/* Current vs Rescheduled */}
                {plan.targets.length > 0 && (
                  <div className="rounded-xl border border-border overflow-hidden">
                    <p className="px-3 py-2 text-[11px] font-semibold uppercase tracking-wide text-ink-faint bg-bg-tertiary border-b border-border">Current → Rescheduled</p>
                    <div className="divide-y divide-border">
                      {plan.targets.map(t => (
                        <div key={t.date} className="px-3 py-2.5 flex items-center gap-3 text-xs">
                          <span className="font-semibold text-ink w-28 shrink-0">{fmtDay(t.date)}</span>
                          <span className="text-ink-muted">{fmtH(t.beforeMin)} · {t.beforeKm} km</span>
                          <ArrowRight className="w-3 h-3 text-accent shrink-0" />
                          <span className={cn('font-semibold', t.overCapacity ? 'text-amber-400' : 'text-ink')}>
                            {fmtH(t.afterMin)} · {t.afterKm} km · +{t.added} job{t.added !== 1 ? 's' : ''}
                          </span>
                          {t.overCapacity && <span className="ml-auto text-[10px] font-semibold uppercase text-amber-400">over capacity</span>}
                        </div>
                      ))}
                    </div>
                    <p className="px-3 py-2 text-[11px] text-ink-faint border-t border-border">
                      Drive: {plan.driveKmBefore} km freed from {fmtDay(plan.day.date)} · {plan.driveKmAfter} km added to the new days
                      {plan.driveKmAfter < plan.driveKmBefore && <span className="text-emerald-400"> ({Math.round((plan.driveKmBefore - plan.driveKmAfter) * 10) / 10} km saved by merging routes)</span>}
                    </p>
                  </div>
                )}

                {/* Moves */}
                {plan.moves.length > 0 && (
                  <div className="rounded-xl border border-border overflow-hidden">
                    <p className="px-3 py-2 text-[11px] font-semibold uppercase tracking-wide text-ink-faint bg-bg-tertiary border-b border-border">Review moves</p>
                    <div className="max-h-48 overflow-y-auto divide-y divide-border">
                      {plan.moves.map(m => (
                        <div key={m.jobId} className="px-3 py-2 flex items-center gap-2 text-xs">
                          <span className="min-w-0 flex-1 flex items-center gap-1.5">
                            {m.recurring && <Repeat className="w-3 h-3 text-ink-faint shrink-0" />}
                            <span className="font-medium text-ink truncate">{m.customerName}</span>
                            {m.value > 0 && <span className="text-ink-faint shrink-0">{formatCurrency(m.value)}</span>}
                            {m.hasSetTime && <span className="text-[10px] font-semibold uppercase text-amber-400 shrink-0">set time — confirm</span>}
                          </span>
                          <span className="text-ink-muted shrink-0">{fmtDay(m.from)}</span>
                          <ArrowRight className="w-3 h-3 text-accent shrink-0" />
                          <span className="text-ink font-medium shrink-0">{fmtDay(m.to)}</span>
                        </div>
                      ))}
                    </div>
                  </div>
                )}

                {plan.unmovable.length > 0 && (
                  <div className="rounded-xl border border-amber-500/20 bg-amber-500/5 px-3 py-2.5">
                    <p className="text-[11px] font-semibold uppercase tracking-wide text-amber-400 flex items-center gap-1 mb-1"><AlertTriangle className="w-3 h-3" /> Can&apos;t be moved</p>
                    {plan.unmovable.map(u => (
                      <p key={u.jobId} className="text-[11px] text-ink-muted">• {u.customerName} — {u.reason}</p>
                    ))}
                  </div>
                )}

                <div className="flex items-center gap-2 pt-1">
                  <Button onClick={apply} loading={applying} disabled={plan.moves.length === 0}>
                    <Check className="w-4 h-4" /> Rain delay — move {plan.moves.length} job{plan.moves.length !== 1 ? 's' : ''}
                  </Button>
                  <Button variant="ghost" onClick={onClose}>Cancel</Button>
                  <span className="ml-auto text-[11px] text-ink-faint">Undo available after applying</span>
                </div>
              </div>
            )}
          </CardBody>
        </Card>
      </div>
    </div>
  )
}
