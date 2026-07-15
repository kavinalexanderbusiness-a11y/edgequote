'use client'

import { useEffect, useMemo, useState } from 'react'
import { format, parseISO } from 'date-fns'
import { createClient } from '@/lib/supabase/client'
import { Job, JobRecurrence } from '@/types'
import { Coord } from '@/lib/geo'
import { optimizeSchedule, metricsWithMoves, manualCadenceCheck, OptimizationResult, OptimizeMode, OptimizeScope, OptJob, PlannedMove, CadenceVisit, CadenceRecs } from '@/lib/optimizer'
import { loadTravelModel, DEFAULT_TRAVEL_MODEL, type TravelModel } from '@/lib/travelLearning'
import type { DayStatusMap } from '@/lib/dayStatus'
import { resolvePrefs } from '@/lib/preferences'
import { localTodayISO, formatCurrency, cn } from '@/lib/utils'
import { useFocusTrap } from '@/hooks/useFocusTrap'
import { Button } from '@/components/ui/Button'
import { Card, CardBody } from '@/components/ui/Card'
import { Rocket, X, Trophy, Scale, DollarSign, Target, ArrowRight, Repeat, Check, Navigation, Clock, Gauge, CalendarDays, Lightbulb, AlertTriangle, ShieldCheck, Loader2 } from 'lucide-react'

const MODES: { key: OptimizeMode; label: string; sub: string; Icon: typeof Trophy }[] = [
  { key: 'recommended', label: 'Smart recommended', sub: 'Best overall balance', Icon: Target },
  { key: 'revenue', label: 'Max profit', sub: 'Revenue per hour, fill clusters', Icon: DollarSign },
  { key: 'density', label: 'Max density', sub: 'Least driving, tightest routes', Icon: Trophy },
  { key: 'balanced', label: 'Balanced workload', sub: 'Even hours, no overloads', Icon: Scale },
]

const SCOPES: { key: OptimizeScope; label: string }[] = [
  { key: 'day', label: 'Selected day' },
  { key: 'weekend', label: 'Weekend' },
  { key: 'week', label: 'This week' },
  { key: 'month', label: 'This month' },
  { key: 'future', label: 'All future' },
]

interface Props {
  jobs: Job[]
  recurrences: Record<string, JobRecurrence>
  valueByJobId: Record<string, number>
  baseCoord: Coord | null
  preferredWorkDays: number[]
  capacityHours: number
  anchorDate: string                 // the day/week/month the scope centers on (cursor)
  initialScope?: OptimizeScope
  initialMode?: OptimizeMode
  autoRun?: boolean                  // run immediately on open (from a suggestion)
  // Future jobs that already have an invoice (immutable locks). Passed from the
  // page so the modal and the proactive cards read the SAME locks; falls back to
  // its own fetch when omitted.
  invoicedIds?: Set<string>
  // Cached real-road distance lookup (page-built, shared with the cards) so the
  // optimizer plans on real driving distance. Omitted → straight-line.
  roadDist?: (a: Coord, b: Coord) => number
  // Owner-blocked days (Rain / Vacation / …) — the optimizer never moves a job onto one.
  dayStatusMap?: DayStatusMap
  // Per-day capacity (Day Settings crew/hours overrides).
  capacityForDate?: (dateISO: string) => number
  // Duplicate stops the optimizer CAN'T fix by moving (they need deleting in
  // Schedule Health) — reported so the owner resolves them first.
  duplicateNote?: { stops: number; minutes: number }
  onApply: (moves: PlannedMove[]) => Promise<void>
  onClose: () => void
}

// 🚀 The whole-schedule optimizer UI: pick a mode, see Current vs Optimized,
// review every proposed move, then Apply (undo-able) or Cancel.
export function OptimizeSchedule({ jobs, recurrences, valueByJobId, baseCoord, preferredWorkDays, capacityHours, anchorDate, initialScope, initialMode, autoRun, invoicedIds: invoicedIdsProp, roadDist, dayStatusMap, capacityForDate, duplicateNote, onApply, onClose }: Props) {
  const supabase = createClient()
  // Dialog focus management (this overlay mounts/unmounts rather than toggling an
  // `open` prop, so the trap is active for its whole lifetime).
  const dialogRef = useFocusTrap<HTMLDivElement>(true, onClose)
  const [mode, setMode] = useState<OptimizeMode>(initialMode ?? 'recommended')
  // Default blast radius = THIS WEEK (same as every other door into the
  // optimizer) — "all future" is an explicit choice, never the default.
  const [scope, setScope] = useState<OptimizeScope>(initialScope ?? 'week')
  const [invoicedIds, setInvoicedIds] = useState<Set<string> | null>(invoicedIdsProp ?? null)
  const [running, setRunning] = useState(false)
  const [applying, setApplying] = useState(false)
  const [result, setResult] = useState<OptimizationResult | null>(null)
  // Learned drive speed — the optimizer's capacity/drive-time math sharpens over time.
  const [travel, setTravel] = useState<TravelModel>(DEFAULT_TRAVEL_MODEL)
  useEffect(() => { loadTravelModel(supabase).then(setTravel) }, [supabase])
  // Cherry-picking: moves the owner has UNTICKED (default = everything applies).
  const [deselected, setDeselected] = useState<Set<string>>(new Set())
  // The exact job snapshot the result was computed from — selection metrics and
  // subset cadence validation must read the same data the engine saw.
  const [lastOptJobs, setLastOptJobs] = useState<OptJob[] | null>(null)

  const recs = useMemo<CadenceRecs>(() => {
    const m: CadenceRecs = {}
    for (const [id, r] of Object.entries(recurrences)) m[id] = { freq: r.freq, interval_unit: r.interval_unit, interval_count: r.interval_count }
    return m
  }, [recurrences])

  // Billed jobs are immutable. Prefer the page-supplied set (so the modal and the
  // proactive cards share the SAME locks); otherwise fetch it ourselves.
  useEffect(() => {
    if (invoicedIdsProp) { setInvoicedIds(invoicedIdsProp); return }
    let active = true
    async function load() {
      const { data } = await supabase.from('invoices').select('job_id').not('job_id', 'is', null)
      if (active) setInvoicedIds(new Set(((data as { job_id: string }[]) || []).map(r => r.job_id)))
    }
    load()
    return () => { active = false }
  }, [supabase, invoicedIdsProp])

  function run(selectedMode: OptimizeMode, selectedScope: OptimizeScope) {
    setMode(selectedMode)
    setScope(selectedScope)
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
        customerId: j.customer_id,
        serviceType: j.service_type,
        neighborhood: j.properties?.neighborhood ?? null,
        ...(() => { const p = resolvePrefs(j.customers, j.properties); return { preferredDays: p.preferredDays, avoidDays: p.avoidDays } })(),
      }))
      setLastOptJobs(optJobs)
      setDeselected(new Set())
      setResult(optimizeSchedule(optJobs, {
        mode: selectedMode,
        scope: selectedScope,
        anchorDate,
        today: localTodayISO(),
        base: baseCoord,
        preferredDays: preferredWorkDays,
        capacityHours,
        recurrences: recs,
        roadDist,
        dayStatusMap,
        capacityForDate,
        minPerKm: travel.minPerKm,
      }))
      setRunning(false)
    }, 30)
  }

  // ── Cherry-pick state derived from the current selection ──
  const selectedMoves = useMemo(
    () => (result ? result.moves.filter(m => !deselected.has(m.jobId)) : []),
    [result, deselected],
  )
  // Applying a SUBSET changes the timeline the moves were validated against
  // (e.g. A moves onto the day B was supposed to leave). Re-validate every
  // selected move against the partially-applied timeline and flag conflicts.
  const subsetIssues = useMemo(() => {
    const issues = new Map<string, string>()
    if (!result || !lastOptJobs || deselected.size === 0) return issues
    const selTo = new Map(selectedMoves.map(m => [m.jobId, m.to]))
    const visits: CadenceVisit[] = lastOptJobs.map(j => ({
      id: j.id, scheduled_date: selTo.get(j.id) ?? j.scheduled_date, status: j.status,
      customerId: j.customerId, recurrence_id: j.recurrence_id, serviceType: j.serviceType, customerName: j.customerName,
    }))
    const byId = new Map(lastOptJobs.map(j => [j.id, j]))
    for (const m of selectedMoves) {
      const j = byId.get(m.jobId)
      if (!j) continue
      const r = manualCadenceCheck({ id: j.id, customerId: j.customerId, recurrence_id: j.recurrence_id, serviceType: j.serviceType }, m.to, visits, recs)
      if (r.status !== 'ok' && r.message) issues.set(m.jobId, r.message)
    }
    return issues
  }, [result, lastOptJobs, deselected, selectedMoves, recs])
  // Live "Optimized" metrics for the selection (identical to result.after when
  // everything is ticked — metricsWithMoves shares the engine's math).
  const effAfter = useMemo(() => {
    if (!result) return null
    if (deselected.size === 0 || !lastOptJobs) return result.after
    return metricsWithMoves(lastOptJobs, {
      scope: result.scope, anchorDate, today: localTodayISO(), base: baseCoord, capacityHours, roadDist, capacityForDate, minPerKm: travel.minPerKm,
    }, selectedMoves)
  }, [result, lastOptJobs, deselected, selectedMoves, anchorDate, baseCoord, capacityHours, roadDist, capacityForDate, travel.minPerKm])
  const selKmSaved = result && effAfter ? Math.round((result.before.totalKm - effAfter.totalKm) * 10) / 10 : 0
  const selMinSaved = result && effAfter ? result.before.driveMinutes - effAfter.driveMinutes : 0
  const selDaysAffected = new Set(selectedMoves.flatMap(m => [m.from, m.to])).size

  function toggleMove(jobId: string) {
    setDeselected(prev => {
      const next = new Set(prev)
      if (next.has(jobId)) next.delete(jobId)
      else next.add(jobId)
      return next
    })
  }

  // Auto-run when launched from an overload/cluster suggestion.
  useEffect(() => {
    if (autoRun && invoicedIds !== null && !result && !running) {
      run(initialMode ?? 'recommended', initialScope ?? 'week')
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoRun, invoicedIds])

  async function apply() {
    if (!result || selectedMoves.length === 0 || subsetIssues.size > 0) return
    setApplying(true)
    await onApply(selectedMoves)
    setApplying(false)
    onClose()
  }

  const fmtDay = (iso: string) => format(parseISO(iso + 'T00:00:00'), 'EEE, MMM d')
  const fmtDrive = (min: number) => min >= 60 ? `${Math.floor(min / 60)}h ${min % 60}m` : `${min}m`

  return (
    <div className="fixed inset-0 z-overlay overflow-y-auto bg-black/50" onClick={onClose}>
      <div ref={dialogRef} className="min-h-full flex items-start justify-center p-4 sm:p-6">
        <Card role="dialog" aria-modal="true" aria-labelledby="optimize-title" tabIndex={-1} className="w-full max-w-2xl my-2 shadow-2xl focus:outline-none" onClick={e => e.stopPropagation()}>
          <div className="px-5 py-4 border-b border-border flex items-center justify-between">
            <h2 id="optimize-title" className="text-sm font-semibold tracking-tight text-ink flex items-center gap-2"><Rocket className="w-4 h-4 text-accent-text" aria-hidden="true" /> Optimize Schedule</h2>
            <button type="button" onClick={onClose} aria-label="Close" className="w-9 h-9 -mr-2 flex items-center justify-center text-ink-faint hover:text-ink"><X className="w-4 h-4" /></button>
          </div>
          <CardBody className="space-y-4">
            <p className="text-xs text-ink-muted">
              Pick what to optimize and the goal. Route density, drive time, workload, capacity, cadence and route
              stability are weighed together. Completed, billed, past and time-committed jobs are never touched.
            </p>

            {duplicateNote && (
              <div className="rounded-xl border border-amber-500/30 bg-amber-500/10 px-3 py-2.5 flex items-start gap-2">
                <AlertTriangle className="w-4 h-4 text-amber-400 shrink-0 mt-px" />
                <p className="text-xs text-amber-200">
                  Resolving {duplicateNote.stops} duplicate visit{duplicateNote.stops !== 1 ? 's' : ''} in <span className="font-semibold">Schedule Health</span> would remove {duplicateNote.stops} stop{duplicateNote.stops !== 1 ? 's' : ''}
                  {duplicateNote.minutes > 0 && <> and save ~{duplicateNote.minutes} min</>} — the optimizer can move visits but can't delete duplicates, so fix those first for the best result.
                </p>
              </div>
            )}

            {/* Scope picker — optimize only the area you care about */}
            <div>
              <p className="text-[11px] font-semibold uppercase tracking-wide text-ink-faint mb-1.5">Optimize</p>
              <div className="flex flex-wrap gap-1.5">
                {SCOPES.map(s => (
                  <button key={s.key} onClick={() => setScope(s.key)} disabled={running}
                    className={cn('text-xs font-medium px-2.5 py-1.5 rounded-lg border transition-colors disabled:opacity-60',
                      scope === s.key ? 'border-accent bg-accent/10 text-accent-text' : 'border-border-strong bg-surface text-ink-muted hover:border-accent/50')}>
                    {s.label}
                  </button>
                ))}
              </div>
            </div>

            {/* Goal picker — runs immediately */}
            <div>
              <p className="text-[11px] font-semibold uppercase tracking-wide text-ink-faint mb-1.5">Goal</p>
              <div className="grid grid-cols-2 gap-2">
                {MODES.map(({ key, label, sub, Icon }) => (
                  <button key={key} onClick={() => run(key, scope)} disabled={running || invoicedIds === null}
                    title={invoicedIds === null ? 'Loading job data…' : undefined}
                    className={cn('rounded-xl border p-3 text-left transition-colors disabled:opacity-60',
                      mode === key && result ? 'border-accent bg-accent/10' : 'border-border-strong bg-surface hover:border-accent/50')}>
                    <p className="text-sm font-semibold text-ink flex items-center gap-1.5"><Icon className="w-4 h-4 text-accent-text" /> {label}</p>
                    <p className="text-[11px] text-ink-faint mt-0.5">{sub}</p>
                  </button>
                ))}
              </div>
            </div>

            {invoicedIds === null && <p className="text-xs text-ink-faint text-center py-2 flex items-center justify-center gap-1.5"><Loader2 className="w-3.5 h-3.5 animate-spin" /> Checking billed jobs…</p>}
            {running && <p className="text-sm text-ink-muted text-center py-4 flex items-center justify-center gap-2"><Loader2 className="w-4 h-4 animate-spin" /> Optimizing {SCOPES.find(s => s.key === scope)?.label.toLowerCase()}…</p>}

            {result && !running && (
              <div className="space-y-4">
                {/* Before / after — reflects the current SELECTION of moves */}
                <div className="grid grid-cols-2 gap-3">
                  <CompareCard title="Current schedule" m={result.before} fmtDrive={fmtDrive} />
                  <CompareCard title={deselected.size > 0 ? `Optimized (${selectedMoves.length} of ${result.moves.length})` : 'Optimized'} m={effAfter ?? result.after} fmtDrive={fmtDrive} highlight />
                </div>

                {result.moves.length === 0 ? (
                  <div className="text-center py-4 text-sm text-emerald-400 flex items-center justify-center gap-2">
                    <Check className="w-4 h-4" /> {result.reasons[0] ?? 'Already well optimized for this goal.'}
                  </div>
                ) : (
                  <>
                    {/* Impact summary — live with the selection */}
                    <div className="flex flex-wrap gap-2 text-xs">
                      <Chip label={`${selectedMoves.length} job${selectedMoves.length !== 1 ? 's' : ''} moved`} />
                      <Chip label={`${selDaysAffected} day${selDaysAffected !== 1 ? 's' : ''} affected`} />
                      {selMinSaved > 0 && <Chip tone="emerald" label={`${fmtDrive(selMinSaved)} driving saved`} />}
                      {selKmSaved > 0 && <Chip tone="emerald" label={`${selKmSaved} km saved`} />}
                      {effAfter && effAfter.revPerHour !== result.before.revPerHour && (
                        <Chip tone={effAfter.revPerHour > result.before.revPerHour ? 'emerald' : 'amber'}
                          label={`${formatCurrency(result.before.revPerHour)}/h → ${formatCurrency(effAfter.revPerHour)}/h`} />
                      )}
                      {effAfter && result.before.overloadedDays > effAfter.overloadedDays && (
                        <Chip tone="emerald" label={`${result.before.overloadedDays - effAfter.overloadedDays} overloaded day${result.before.overloadedDays - effAfter.overloadedDays !== 1 ? 's' : ''} fixed`} />
                      )}
                    </div>

                    {/* Why — plain-language explanation */}
                    {result.reasons.length > 0 && (
                      <div className="rounded-xl border border-accent/20 bg-accent/5 px-3 py-2.5">
                        <p className="text-[11px] font-semibold uppercase tracking-wide text-accent-text flex items-center gap-1.5 mb-1">
                          <Lightbulb className="w-3.5 h-3.5" /> Why this is better
                        </p>
                        <ul className="space-y-0.5">
                          {result.reasons.map((reason, i) => <li key={i} className="text-xs text-ink-muted">• {reason}</li>)}
                        </ul>
                        {result.stableKept > 0 && (
                          <p className="text-[11px] text-ink-faint mt-1.5">Route stability protected — recurring customers stay on their established day unless the gain is substantial.</p>
                        )}
                      </div>
                    )}

                    {/* Review changes — tick exactly the moves you want */}
                    <div className="rounded-xl border border-border overflow-hidden">
                      <div className="px-3 py-2 flex items-center justify-between gap-2 bg-bg-tertiary border-b border-border">
                        <p className="text-[11px] font-semibold uppercase tracking-wide text-ink-faint">
                          Review changes · {selectedMoves.length} of {result.moves.length} selected
                        </p>
                        <div className="flex items-center gap-2 text-[11px] font-medium">
                          <button onClick={() => setDeselected(new Set())} className="text-accent-text hover:underline">All</button>
                          <span className="text-ink-faint">·</span>
                          <button onClick={() => setDeselected(new Set(result.moves.map(m => m.jobId)))} className="text-accent-text hover:underline">None</button>
                        </div>
                      </div>
                      <div className="max-h-56 overflow-y-auto divide-y divide-border">
                        {result.moves.map(m => {
                          const on = !deselected.has(m.jobId)
                          const issue = subsetIssues.get(m.jobId)
                          return (
                            <div key={m.jobId} className={cn('px-3 py-2', !on && 'opacity-50')}>
                              <label className="flex items-center gap-2 text-xs cursor-pointer">
                                <input type="checkbox" checked={on} onChange={() => toggleMove(m.jobId)}
                                  className="w-3.5 h-3.5 shrink-0 accent-accent" />
                                <span className="min-w-0 flex-1 flex items-center gap-1.5">
                                  {m.recurring && <Repeat className="w-3 h-3 text-ink-faint shrink-0" />}
                                  <span className="font-medium text-ink truncate">{m.customerName}</span>
                                  {m.value > 0 && <span className="text-ink-faint shrink-0">{formatCurrency(m.value)}</span>}
                                </span>
                                <span className="text-ink-muted shrink-0">{fmtDay(m.from)}</span>
                                <ArrowRight className="w-3 h-3 text-accent-text shrink-0" />
                                <span className="text-ink font-medium shrink-0">{fmtDay(m.to)}</span>
                              </label>
                              {on && issue && (
                                <p className="mt-1 ml-6 text-[11px] text-amber-400 flex items-start gap-1.5">
                                  <AlertTriangle className="w-3 h-3 shrink-0 mt-px" />
                                  {issue} Select its partner move too, or untick this one.
                                </p>
                              )}
                            </div>
                          )
                        })}
                      </div>
                    </div>
                  </>
                )}

                {/* Recurring-series safety gate — shown before Apply */}
                {result.warnings.length > 0 && (
                  <div className="space-y-1">
                    {result.warnings.map((wmsg, i) => {
                      const blocked = result.blockedMoves > 0 && i === 0
                      return (
                        <p key={i} className={cn('text-[11px] flex items-start gap-1.5',
                          blocked ? 'text-amber-400' : 'text-emerald-400')}>
                          {blocked ? <AlertTriangle className="w-3.5 h-3.5 shrink-0 mt-px" /> : <ShieldCheck className="w-3.5 h-3.5 shrink-0 mt-px" />}
                          {wmsg}
                        </p>
                      )
                    })}
                  </div>
                )}

                {(result.lockedTimes > 0 || result.lockedBilled > 0) && (
                  <p className="text-[11px] text-ink-faint">
                    Left untouched: {[
                      result.lockedTimes > 0 ? `${result.lockedTimes} job${result.lockedTimes !== 1 ? 's' : ''} with a set start time` : null,
                      result.lockedBilled > 0 ? `${result.lockedBilled} already billed` : null,
                    ].filter(Boolean).join(' · ')} — plus all completed and past work.
                  </p>
                )}

                {/* Actions — applies only the TICKED moves */}
                {subsetIssues.size > 0 && (
                  <p className="text-[11px] text-amber-400 flex items-start gap-1.5">
                    <AlertTriangle className="w-3.5 h-3.5 shrink-0 mt-px" />
                    {subsetIssues.size} selected move{subsetIssues.size !== 1 ? 's' : ''} conflict{subsetIssues.size === 1 ? 's' : ''} with this partial selection — fix the flagged rows to apply.
                  </p>
                )}
                <div className="flex items-center gap-2 pt-1">
                  <Button onClick={apply} loading={applying} disabled={selectedMoves.length === 0 || subsetIssues.size > 0}>
                    <Check className="w-4 h-4" /> Apply {selectedMoves.length > 0
                      ? (selectedMoves.length === result.moves.length
                        ? `${selectedMoves.length} change${selectedMoves.length !== 1 ? 's' : ''}`
                        : `${selectedMoves.length} of ${result.moves.length}`)
                      : 'changes'}
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
      <p className={cn('text-[11px] font-semibold uppercase tracking-wide', highlight ? 'text-accent-text' : 'text-ink-faint')}>{title}</p>
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
