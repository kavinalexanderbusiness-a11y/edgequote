'use client'

// ── The suggested order, as a proposal you approve ───────────────────────────
// Session 82. Renders lib/daySequence's proposal and NOTHING it did not
// produce — every figure, every sentence and every warning comes off the
// `proposal` object, so this screen cannot be more confident than the engine.
//
// ⛔ IT NEVER WRITES. The only way anything changes is the owner pressing
// "Use this order", which hands the order back to the caller's ONE existing
// route_order writer. A schedule that rearranges itself is a schedule the field
// stops trusting — so the suggestion sits here, next to the day as it stands,
// until somebody says yes.
//
// Reading order is the owner's:
//   1. is this actually better, and why      (the verdict + reasons)
//   2. current vs suggested, side by side    (the two plans, same engine)
//   3. the order itself, with arrival times  (what the day becomes)
//   4. what it still does not fix            (late promises that survive)
//   5. what we left alone, and what we assumed (locks, then caveats)
//
// ⛔ No money. lib/daySequence cannot see revenue and neither can this panel.

import { useMemo } from 'react'
import {
  ArrowRight, Check, Clock, Lightbulb, Lock, Navigation, Route as RouteIcon,
  AlertTriangle, Info, X, CalendarClock,
} from 'lucide-react'
import { cn } from '@/lib/utils'
import { useFocusTrap } from '@/hooks/useFocusTrap'
import { Button } from '@/components/ui/Button'
import { Card, CardBody } from '@/components/ui/Card'
import { minutesToTime12 } from '@/lib/route'
import { travelBasisLabel } from '@/lib/dayPlan'
import { LOCK_LABEL, type DaySequenceProposal } from '@/lib/daySequence'

function fmtMin(min: number): string {
  const m = Math.max(0, Math.round(min))
  if (m < 60) return `${m} min`
  const h = Math.floor(m / 60), r = m % 60
  return r ? `${h}h ${r}m` : `${h}h`
}

interface Props {
  proposal: DaySequenceProposal
  dateLabel: string
  /** Apply the suggested order. Receives ONLY the ids whose position can be
   *  persisted — estimate appointments are excluded by the engine. */
  onApply: (order: string[]) => void | Promise<void>
  applying?: boolean
  /** Estimate appointments on this day that could NOT be placed in the order —
   *  no promised time, or no located property. Disclosed rather than guessed at. */
  unplacedEstimates?: number
  onClose: () => void
}

export function OptimizeDayPanel({ proposal, dateLabel, onApply, applying, unplacedEstimates = 0, onClose }: Props) {
  const dialogRef = useFocusTrap<HTMLDivElement>(true, onClose)
  const { current, suggested, accepted } = proposal

  const movedIds = useMemo(() => new Set(proposal.moves.map(m => m.id)), [proposal.moves])
  const lockedById = useMemo(
    () => new Map(proposal.locked.map(l => [l.id, l])),
    [proposal.locked],
  )
  const labelById = useMemo(() => {
    const m = new Map<string, string>()
    for (const mv of proposal.moves) m.set(mv.id, mv.label)
    for (const l of proposal.locked) m.set(l.id, l.label)
    for (const p of proposal.latePromises) m.set(p.id, p.label)
    return m
  }, [proposal])

  // Blocking/warning verdicts the SUGGESTED day still carries. Caveats are
  // about evidence and ride at the bottom with the other assumptions.
  const alerts = suggested.warnings.filter(w => w.severity !== 'caveat')

  return (
    <div className="fixed inset-0 z-overlay overflow-y-auto bg-black/50" onClick={onClose}>
      <div ref={dialogRef} className="min-h-full flex items-start justify-center p-4 sm:p-6">
        <Card role="dialog" aria-modal="true" aria-labelledby="optimize-day-title" tabIndex={-1}
          className="w-full max-w-2xl my-2 shadow-2xl focus:outline-none" onClick={e => e.stopPropagation()}>
          <div className="px-5 py-4 border-b border-border flex items-center justify-between gap-3">
            <h2 id="optimize-day-title" className="text-sm font-semibold tracking-tight text-ink flex items-center gap-2 min-w-0">
              <RouteIcon className="w-4 h-4 text-accent-text shrink-0" aria-hidden />
              <span className="truncate">Optimize day · {dateLabel}</span>
            </h2>
            <button type="button" onClick={onClose} aria-label="Close"
              className="w-9 h-9 -mr-2 flex items-center justify-center text-ink-faint hover:text-ink shrink-0">
              <X className="w-4 h-4" />
            </button>
          </div>

          <CardBody className="space-y-4">
            {!accepted ? (
              // ⭐ The honest empty case. The search ran and could not beat the
              // day as booked — which is a RESULT, not a failure, and saying so
              // plainly is what stops the owner re-running it all morning.
              <div className="rounded-xl border border-emerald-500/30 bg-emerald-500/[0.07] px-3.5 py-3 flex items-start gap-2.5">
                <Check className="w-4 h-4 text-emerald-400 shrink-0 mt-px" aria-hidden />
                <div className="text-xs text-ink-muted space-y-1">
                  <p className="text-sm font-semibold text-emerald-300">This day is already in the best order we can find.</p>
                  <p>
                    Every alternative was timed against the same plan and none of them kept more promises,
                    finished earlier or drove less. The order stays as you have it.
                  </p>
                  {proposal.lateBefore > 0 && (
                    <p className="text-amber-300">
                      {proposal.lateBefore} promised time{proposal.lateBefore !== 1 ? 's' : ''} still cannot be met by
                      re-ordering alone — the work needs more time, more people, or a different day.
                    </p>
                  )}
                </div>
              </div>
            ) : (
              <>
                {/* Why — the engine's own sentences */}
                {proposal.reasons.length > 0 && (
                  <div className="rounded-xl border border-accent/20 bg-accent/5 px-3 py-2.5">
                    <p className="text-[11px] font-semibold uppercase tracking-wide text-accent-text flex items-center gap-1.5 mb-1">
                      <Lightbulb className="w-3.5 h-3.5" aria-hidden /> Why this is better
                    </p>
                    <ul className="space-y-0.5">
                      {proposal.reasons.map((r, i) => <li key={i} className="text-xs text-ink-muted">• {r}</li>)}
                    </ul>
                  </div>
                )}

                {/* Current vs Suggested — both timed by the SAME engine */}
                <div className="grid grid-cols-2 gap-3">
                  <PlanCard
                    title="Current"
                    finish={current.finish}
                    travelMin={current.driveMin}
                    travelLabel={proposal.travelLabel}
                    late={proposal.lateBefore}
                    overrunMin={current.overrunMin}
                  />
                  <PlanCard
                    title="Suggested"
                    finish={suggested.finish}
                    travelMin={suggested.driveMin}
                    travelLabel={proposal.travelLabel}
                    late={proposal.lateAfter}
                    overrunMin={suggested.overrunMin}
                    highlight
                  />
                </div>

                {/* The headline deltas, in the engine's own words */}
                <div className="flex flex-wrap gap-2 text-xs">
                  {proposal.travelSavedMin > 0 && (
                    <Chip tone="emerald"
                      label={`${fmtMin(proposal.travelSavedMin)} less ${proposal.travelLabel}${proposal.travelEstimated ? ' (est.)' : ''}`} />
                  )}
                  {proposal.travelSavedMin < 0 && (
                    <Chip tone="amber"
                      label={`${fmtMin(-proposal.travelSavedMin)} more ${proposal.travelLabel} — buys a kept promise`} />
                  )}
                  {proposal.finishEarlierMin > 0 && <Chip tone="emerald" label={`Finishes ${fmtMin(proposal.finishEarlierMin)} earlier`} />}
                  {proposal.finishEarlierMin < 0 && <Chip tone="amber" label={`Finishes ${fmtMin(-proposal.finishEarlierMin)} later`} />}
                  {proposal.lateAfter < proposal.lateBefore && (
                    <Chip tone="emerald" label={`${proposal.lateBefore - proposal.lateAfter} fewer late arrival${proposal.lateBefore - proposal.lateAfter !== 1 ? 's' : ''}`} />
                  )}
                  <Chip label={`${proposal.moves.length} stop${proposal.moves.length !== 1 ? 's' : ''} moved`} />
                </div>

                {/* The order itself — what the day becomes */}
                <div className="rounded-xl border border-border overflow-hidden">
                  <div className="px-3 py-2 bg-bg-tertiary border-b border-border">
                    <p className="text-[11px] font-semibold uppercase tracking-wide text-ink-faint">Suggested order</p>
                  </div>
                  <ol className="divide-y divide-border max-h-64 overflow-y-auto">
                    {suggested.stops.map((s, i) => {
                      const lock = lockedById.get(s.jobId)
                      const moved = movedIds.has(s.jobId)
                      return (
                        <li key={s.jobId} className="px-3 py-2 flex items-center gap-2.5 text-xs">
                          <span className={cn(
                            'w-6 h-6 rounded-full flex items-center justify-center text-[11px] font-bold shrink-0',
                            moved ? 'bg-accent/15 text-accent-text' : 'bg-bg-tertiary text-ink-faint',
                          )}>{i + 1}</span>
                          <span className="min-w-0 flex-1 truncate font-medium text-ink">
                            {labelById.get(s.jobId) ?? s.jobId}
                          </span>
                          {lock && (
                            <span className="shrink-0 text-[10px] text-ink-faint flex items-center gap-1"
                              title={`Left in place — ${LOCK_LABEL[lock.reason]}`}>
                              <Lock className="w-3 h-3" aria-hidden />
                              <span className="hidden sm:inline">{LOCK_LABEL[lock.reason]}</span>
                            </span>
                          )}
                          {moved && !lock && <span className="shrink-0 text-[10px] font-semibold text-accent-text">moved</span>}
                          <span className="shrink-0 font-semibold text-ink tabular-nums">{s.arrival}</span>
                        </li>
                      )
                    })}
                  </ol>
                </div>

                {/* What actually changed, position to position */}
                {proposal.moves.length > 0 && (
                  <details className="rounded-xl border border-border overflow-hidden">
                    <summary className="px-3 py-2 bg-bg-tertiary text-[11px] font-semibold uppercase tracking-wide text-ink-faint cursor-pointer">
                      What moved · {proposal.moves.length}
                    </summary>
                    <ul className="divide-y divide-border">
                      {proposal.moves.map(m => (
                        <li key={m.id} className="px-3 py-2 flex items-center gap-2 text-xs">
                          <span className="min-w-0 flex-1 truncate text-ink">{m.label}</span>
                          {m.fixesPromise && (
                            <span className="shrink-0 text-[10px] font-semibold text-emerald-400">keeps its promise</span>
                          )}
                          <span className="shrink-0 text-ink-muted tabular-nums">#{m.from}</span>
                          <ArrowRight className="w-3 h-3 text-accent-text shrink-0" aria-hidden />
                          <span className="shrink-0 font-semibold text-ink tabular-nums">#{m.to}</span>
                        </li>
                      ))}
                    </ul>
                  </details>
                )}
              </>
            )}

            {/* Promises the suggested order STILL misses — never buried */}
            {proposal.latePromises.length > 0 && (
              <div className="rounded-xl border border-amber-500/30 bg-amber-500/[0.07] px-3 py-2.5">
                <p className="text-[11px] font-semibold uppercase tracking-wide text-amber-300 flex items-center gap-1.5 mb-1">
                  <AlertTriangle className="w-3.5 h-3.5" aria-hidden /> Promised times still missed
                </p>
                <ul className="space-y-0.5">
                  {proposal.latePromises.map(p => (
                    <li key={p.id} className="text-xs text-amber-200">
                      • <span className="font-semibold">{p.label}</span> is promised {p.promise} — this order arrives {p.arrival}
                      {' '}({fmtMin(p.lateMin)} late).
                    </li>
                  ))}
                </ul>
              </div>
            )}

            {/* Whatever the SUGGESTED day still cannot do — planDay's verdicts */}
            {accepted && alerts.length > 0 && (
              <div className="space-y-1">
                {alerts.map((w, i) => (
                  <p key={i} className={cn('text-[11px] flex items-start gap-1.5',
                    w.severity === 'blocking' ? 'text-red-400' : 'text-amber-400')}>
                    <AlertTriangle className="w-3.5 h-3.5 shrink-0 mt-px" aria-hidden />
                    {w.message}
                  </p>
                ))}
              </div>
            )}

            {/* What we left alone */}
            {proposal.locked.length > 0 && (
              <p className="text-[11px] text-ink-faint flex items-start gap-1.5">
                <Lock className="w-3.5 h-3.5 shrink-0 mt-px" aria-hidden />
                Left exactly where {proposal.locked.length === 1 ? 'it was' : 'they were'}:{' '}
                {proposal.locked.map(l => `${l.label} (${LOCK_LABEL[l.reason]})`).join(' · ')}.
              </p>
            )}

            {/* What we had to assume to say any of it */}
            <div className="space-y-1 pt-0.5">
              <p className="text-[11px] text-ink-faint flex items-start gap-1.5">
                <Navigation className="w-3.5 h-3.5 shrink-0 mt-px" aria-hidden />
                {travelBasisLabel(suggested.travel)}.
                {proposal.travelEstimated && ' Treat the travel figures as a comparison between orders, not as a promise about traffic.'}
              </p>
              {proposal.earlyArrivals > 0 && (
                <p className="text-[11px] text-ink-faint flex items-start gap-1.5">
                  <CalendarClock className="w-3.5 h-3.5 shrink-0 mt-px" aria-hidden />
                  {proposal.earlyArrivals} stop{proposal.earlyArrivals !== 1 ? 's' : ''} arrive
                  {proposal.earlyArrivals === 1 ? 's' : ''} before the promised time. The finish assumes work starts on
                  arrival — if the crew waits, the day ends later than shown.
                </p>
              )}
              <p className="text-[11px] text-ink-faint flex items-start gap-1.5">
                <Info className="w-3.5 h-3.5 shrink-0 mt-px" aria-hidden />
                Breaks are not scheduled here — this product has no break in its planning data, so the gaps between
                stops are travel, not rest.
              </p>
              {unplacedEstimates > 0 && (
                <p className="text-[11px] text-ink-faint flex items-start gap-1.5">
                  <CalendarClock className="w-3.5 h-3.5 shrink-0 mt-px" aria-hidden />
                  {unplacedEstimates} estimate appointment{unplacedEstimates !== 1 ? 's' : ''} on this day
                  {unplacedEstimates === 1 ? ' has' : ' have'} no set time or no address, so
                  {unplacedEstimates === 1 ? ' it is' : ' they are'} not placed in this order and not counted in the
                  finish time.
                </p>
              )}
              {suggested.warnings.filter(w => w.severity === 'caveat').map((w, i) => (
                <p key={i} className="text-[11px] text-ink-faint flex items-start gap-1.5">
                  <Info className="w-3.5 h-3.5 shrink-0 mt-px" aria-hidden />{w.message}
                </p>
              ))}
            </div>

            {/* Actions — nothing has changed until this is pressed */}
            <div className="flex items-center gap-2 pt-1">
              {accepted && (
                <Button onClick={() => onApply(proposal.persistableOrder)} loading={applying}>
                  <Check className="w-4 h-4" /> Use this order
                </Button>
              )}
              <Button variant="ghost" onClick={onClose}>{accepted ? 'Keep current order' : 'Close'}</Button>
              {accepted && <span className="ml-auto text-[11px] text-ink-faint">Undo available after applying</span>}
            </div>
          </CardBody>
        </Card>
      </div>
    </div>
  )
}

function PlanCard({ title, finish, travelMin, travelLabel, late, overrunMin, highlight }: {
  title: string
  finish: string
  travelMin: number
  travelLabel: string
  late: number
  overrunMin: number
  highlight?: boolean
}) {
  return (
    <div className={cn('rounded-xl border p-3 space-y-1.5',
      highlight ? 'border-accent/50 bg-accent/5' : 'border-border bg-bg-tertiary')}>
      <p className={cn('text-[11px] font-semibold uppercase tracking-wide', highlight ? 'text-accent-text' : 'text-ink-faint')}>{title}</p>
      <Row Icon={Clock} label="Finishes" value={finish} />
      <Row Icon={Navigation} label={travelLabel === 'driving' ? 'Driving' : 'Route overhead'} value={fmtMin(travelMin)} />
      <Row Icon={AlertTriangle} label="Late promises" value={String(late)} tone={late > 0 ? 'amber' : undefined} />
      <Row Icon={CalendarClock} label="Past day's hours"
        value={overrunMin > 0 ? fmtMin(overrunMin) : '—'} tone={overrunMin > 0 ? 'amber' : undefined} />
    </div>
  )
}

function Row({ Icon, label, value, tone }: { Icon: typeof Clock; label: string; value: string; tone?: 'amber' }) {
  return (
    <div className="flex items-center justify-between gap-2 text-xs">
      <span className="flex items-center gap-1.5 text-ink-muted min-w-0"><Icon className="w-3 h-3 shrink-0" aria-hidden /><span className="truncate">{label}</span></span>
      <span className={cn('font-semibold shrink-0 tabular-nums', tone === 'amber' ? 'text-amber-400' : 'text-ink')}>{value}</span>
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
