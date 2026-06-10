'use client'

import { useEffect, useState } from 'react'
import { format, parseISO } from 'date-fns'
import { createClient } from '@/lib/supabase/client'
import { Job, JobRecurrence } from '@/types'
import { Coord } from '@/lib/geo'
import { optimizeSchedule, OptimizationResult, OptimizeMode, OptJob, PlannedMove } from '@/lib/optimizer'
import { localTodayISO, formatCurrency, cn } from '@/lib/utils'
import { Button } from '@/components/ui/Button'
import { Card, CardBody } from '@/components/ui/Card'
import { Rocket, X, Trophy, Scale, DollarSign, Target, ArrowRight, Repeat, Check, Navigation, Clock, Gauge, CalendarDays } from 'lucide-react'

const MODES: { key: OptimizeMode; label: string; sub: string; Icon: typeof Trophy }[] = [
  { key: 'recommended', label: 'Recommended', sub: 'Best overall combination', Icon: Target },
  { key: 'density', label: 'Max Route Density', sub: 'Minimize driving', Icon: Trophy },
  { key: 'balanced', label: 'Balanced Workload', sub: 'Even hours across days', Icon: Scale },
  { key: 'revenue', label: 'Revenue Efficiency', sub: 'Best revenue per hour', Icon: DollarSign },
]

interface Props {
  jobs: Job[]
  recurrences: Record<string, JobRecurrence>
  valueByJobId: Record<string, number>
  baseCoord: Coord | null
  preferredWorkDays: number[]
  capacityHours: number
  onApply: (moves: PlannedMove[]) => Promise<void>
  onClose: () => void
}

// 🚀 The whole-schedule optimizer UI: pick a mode, see Current vs Optimized,
// review every proposed move, then Apply (undo-able) or Cancel.
export function OptimizeSchedule({ jobs, recurrences, valueByJobId, baseCoord, preferredWorkDays, capacityHours, onApply, onClose }: Props) {
  const supabase = createClient()
  const [mode, setMode] = useState<OptimizeMode>('recommended')
  const [invoicedIds, setInvoicedIds] = useState<Set<string> | null>(null)
  const [running, setRunning] = useState(false)
  const [applying, setApplying] = useState(false)
  const [result, setResult] = useState<OptimizationResult | null>(null)

  // Billed jobs are immutable — fetch which future jobs already have an invoice.
  useEffect(() => {
    let active = true
    async function load() {
      const { data } = await supabase.from('invoices').select('job_id').not('job_id', 'is', null)
      if (active) setInvoicedIds(new Set(((data as { job_id: string }[]) || []).map(r => r.job_id)))
    }
    load()
    return () => { active = false }
  }, [supabase])

  function run(selected: OptimizeMode) {
    setMode(selected)
    setRunning(true)
    setResult(null)
    // Yield a frame so the spinner paints before the synchronous search runs.
    setTimeout(() => {
      const optJobs: OptJob[] = jobs.map(j => ({
        id: j.id,
        scheduled_date: j.scheduled_date,
        status: j.status,
        recurrence_id: j.recurrence_id,
        start_time: j.start_time,
        duration_minutes: j.duration_minutes,
        lat: j.properties?.lat ?? null,
        lng: j.properties?.lng ?? null,
        value: valueByJobId[j.id] || 0,
        invoiced: invoicedIds?.has(j.id) ?? false,
        title: j.title,
        customerName: j.customers?.name || j.title,
      }))
      const recs: Record<string, { freq: string | null; interval_unit: string | null; interval_count: number | null }> = {}
      for (const [id, r] of Object.entries(recurrences)) recs[id] = { freq: r.freq, interval_unit: r.interval_unit, interval_count: r.interval_count }
      setResult(optimizeSchedule(optJobs, {
        mode: selected,
        today: localTodayISO(),
        base: baseCoord,
        preferredDays: preferredWorkDays,
        capacityHours,
        recurrences: recs,
      }))
      setRunning(false)
    }, 30)
  }

  async function apply() {
    if (!result || result.moves.length === 0) return
    setApplying(true)
    await onApply(result.moves)
    setApplying(false)
    onClose()
  }

  const fmtDay = (iso: string) => format(parseISO(iso + 'T00:00:00'), 'EEE, MMM d')
  const fmtDrive = (min: number) => min >= 60 ? `${Math.floor(min / 60)}h ${min % 60}m` : `${min}m`

  return (
    <div className="fixed inset-0 z-50 overflow-y-auto bg-black/60 backdrop-blur-sm" onClick={onClose}>
      <div className="min-h-full flex items-start justify-center p-4 sm:p-6">
        <Card className="w-full max-w-2xl my-2 shadow-2xl" onClick={e => e.stopPropagation()}>
          <div className="px-5 py-4 border-b border-border flex items-center justify-between">
            <h2 className="text-sm font-semibold text-ink flex items-center gap-2"><Rocket className="w-4 h-4 text-accent" /> Optimize Schedule</h2>
            <button onClick={onClose} className="w-9 h-9 -mr-2 flex items-center justify-center text-ink-faint hover:text-ink"><X className="w-4 h-4" /></button>
          </div>
          <CardBody className="space-y-4">
            <p className="text-xs text-ink-muted">
              Analyzes every future job as one schedule — route density, drive time, workload, capacity and cadence —
              and proposes moves. Completed, billed, past and time-committed jobs are never touched.
            </p>

            {/* Mode picker */}
            <div className="grid grid-cols-2 gap-2">
              {MODES.map(({ key, label, sub, Icon }) => (
                <button key={key} onClick={() => run(key)} disabled={running || invoicedIds === null}
                  className={cn('rounded-xl border p-3 text-left transition-colors disabled:opacity-60',
                    mode === key && result ? 'border-accent bg-accent/10' : 'border-border-strong bg-surface hover:border-accent/50')}>
                  <p className="text-sm font-semibold text-ink flex items-center gap-1.5"><Icon className="w-4 h-4 text-accent" /> {label}</p>
                  <p className="text-[11px] text-ink-faint mt-0.5">{sub}</p>
                </button>
              ))}
            </div>

            {invoicedIds === null && <p className="text-xs text-ink-faint text-center py-2">Checking billed jobs…</p>}
            {running && <p className="text-sm text-ink-muted text-center py-4">Optimizing your whole schedule…</p>}

            {result && !running && (
              <div className="space-y-4">
                {/* Before / after */}
                <div className="grid grid-cols-2 gap-3">
                  <CompareCard title="Current schedule" m={result.before} fmtDrive={fmtDrive} />
                  <CompareCard title="Optimized" m={result.after} fmtDrive={fmtDrive} highlight />
                </div>

                {result.moves.length === 0 ? (
                  <div className="text-center py-4 text-sm text-emerald-400 flex items-center justify-center gap-2">
                    <Check className="w-4 h-4" /> Your schedule is already well optimized for this mode.
                  </div>
                ) : (
                  <>
                    {/* Impact summary */}
                    <div className="flex flex-wrap gap-2 text-xs">
                      <Chip label={`${result.moves.length} job${result.moves.length !== 1 ? 's' : ''} moved`} />
                      <Chip label={`${result.daysAffected} day${result.daysAffected !== 1 ? 's' : ''} affected`} />
                      {result.minutesSaved > 0 && <Chip tone="emerald" label={`${fmtDrive(result.minutesSaved)} driving saved`} />}
                      {result.kmSaved > 0 && <Chip tone="emerald" label={`${result.kmSaved} km saved`} />}
                      {result.after.revPerHour !== result.before.revPerHour && (
                        <Chip tone={result.after.revPerHour > result.before.revPerHour ? 'emerald' : 'amber'}
                          label={`${formatCurrency(result.before.revPerHour)}/h → ${formatCurrency(result.after.revPerHour)}/h`} />
                      )}
                      {result.before.overloadedDays > result.after.overloadedDays && (
                        <Chip tone="emerald" label={`${result.before.overloadedDays - result.after.overloadedDays} overloaded day${result.before.overloadedDays - result.after.overloadedDays !== 1 ? 's' : ''} fixed`} />
                      )}
                    </div>

                    {/* Review changes */}
                    <div className="rounded-xl border border-border overflow-hidden">
                      <p className="px-3 py-2 text-[11px] font-semibold uppercase tracking-wide text-ink-faint bg-bg-tertiary border-b border-border">Review changes</p>
                      <div className="max-h-56 overflow-y-auto divide-y divide-border">
                        {result.moves.map(m => (
                          <div key={m.jobId} className="px-3 py-2 flex items-center gap-2 text-xs">
                            <span className="min-w-0 flex-1 flex items-center gap-1.5">
                              {m.recurring && <Repeat className="w-3 h-3 text-ink-faint shrink-0" />}
                              <span className="font-medium text-ink truncate">{m.customerName}</span>
                              {m.value > 0 && <span className="text-ink-faint shrink-0">{formatCurrency(m.value)}</span>}
                            </span>
                            <span className="text-ink-muted shrink-0">{fmtDay(m.from)}</span>
                            <ArrowRight className="w-3 h-3 text-accent shrink-0" />
                            <span className="text-ink font-medium shrink-0">{fmtDay(m.to)}</span>
                          </div>
                        ))}
                      </div>
                    </div>
                  </>
                )}

                {(result.lockedTimes > 0 || result.lockedBilled > 0) && (
                  <p className="text-[11px] text-ink-faint">
                    Left untouched: {[
                      result.lockedTimes > 0 ? `${result.lockedTimes} job${result.lockedTimes !== 1 ? 's' : ''} with a set start time` : null,
                      result.lockedBilled > 0 ? `${result.lockedBilled} already billed` : null,
                    ].filter(Boolean).join(' · ')} — plus all completed and past work.
                  </p>
                )}

                {/* Actions */}
                <div className="flex items-center gap-2 pt-1">
                  <Button onClick={apply} loading={applying} disabled={result.moves.length === 0}>
                    <Check className="w-4 h-4" /> Apply {result.moves.length > 0 ? `${result.moves.length} change${result.moves.length !== 1 ? 's' : ''}` : 'changes'}
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

function CompareCard({ title, m, fmtDrive, highlight }: { title: string; m: OptimizationResult['before']; fmtDrive: (n: number) => string; highlight?: boolean }) {
  return (
    <div className={cn('rounded-xl border p-3 space-y-1.5', highlight ? 'border-accent/50 bg-accent/5' : 'border-border bg-bg-tertiary')}>
      <p className={cn('text-[11px] font-semibold uppercase tracking-wide', highlight ? 'text-accent' : 'text-ink-faint')}>{title}</p>
      <Row Icon={Clock} label="Drive time" value={fmtDrive(m.driveMinutes)} />
      <Row Icon={Navigation} label="Distance" value={`${m.totalKm} km`} />
      <Row Icon={Gauge} label="Density score" value={`${m.densityScore}/100`} />
      <Row Icon={DollarSign} label="Revenue / hour" value={`$${m.revPerHour}`} />
      <Row Icon={CalendarDays} label="Days · overloaded" value={`${m.activeDays} · ${m.overloadedDays}`} />
    </div>
  )
}

function Row({ Icon, label, value }: { Icon: typeof Clock; label: string; value: string }) {
  return (
    <div className="flex items-center justify-between text-xs">
      <span className="flex items-center gap-1.5 text-ink-muted"><Icon className="w-3 h-3" /> {label}</span>
      <span className="font-semibold text-ink">{value}</span>
    </div>
  )
}

function Chip({ label, tone }: { label: string; tone?: 'emerald' | 'amber' }) {
  return (
    <span className={cn('px-2 py-1 rounded-lg border font-medium',
      tone === 'emerald' ? 'text-emerald-400 border-emerald-500/30 bg-emerald-500/10'
        : tone === 'amber' ? 'text-amber-400 border-amber-500/30 bg-amber-500/10'
        : 'text-ink-muted border-border bg-bg-tertiary')}>
      {label}
    </span>
  )
}
