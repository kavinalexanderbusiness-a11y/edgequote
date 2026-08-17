'use client'

// ── The day, as a plan you can act on ────────────────────────────────────────
// Session 60. Renders lib/dayPlan's result and NOTHING it did not produce —
// every figure and every sentence here comes off the `plan` object, so the
// screen cannot be more confident than the engine was.
//
// Reading order is the owner's, not the data's:
//   1. what would stop this day happening   (blocking warnings, first)
//   2. what the day IS                      (stops · areas · work · drive · finish)
//   3. what it costs of the day             (the capacity bar, both dimensions)
//   4. what we had to assume to say that    (caveats, last and quiet)
//   5. does the crew have this plan         (the one action that isn't reordering)
//
// ⛔ No money. The engine cannot see revenue and neither can this panel — the
// day's money already has a metric strip directly above it, and putting a
// dollar figure inside a capacity verdict is how "worth it" starts arguing with
// "possible". See lib/dayPlan honesty rule 5.

import {
  AlertTriangle, Clock, Hourglass, MapPin, Navigation, Route as RouteIcon,
  Users, Info, Send, CheckCircle2,
} from 'lucide-react'
import { cn } from '@/lib/utils'
import { minutesToTime12 } from '@/lib/route'
import {
  areasLabel, travelBasisLabel, travelBasisDetail, travelFigureLabel, travelIsEstimated,
  type DayPlan, type DayPlanWarning,
} from '@/lib/dayPlan'
import type { CrewOrderStatus } from '@/lib/fieldStops'

function fmtH(min: number): string {
  const m = Math.max(0, Math.round(min))
  if (m < 60) return `${m}m`
  const h = Math.floor(m / 60), r = m % 60
  return r ? `${h}h ${r}m` : `${h}h`
}

const TONE: Record<DayPlanWarning['severity'], { row: string; icon: string }> = {
  blocking: { row: 'border-red-500/30 bg-red-500/[0.07]', icon: 'text-red-400' },
  warning: { row: 'border-amber-500/30 bg-amber-500/[0.06]', icon: 'text-amber-300' },
  caveat: { row: 'border-border bg-bg-secondary', icon: 'text-ink-faint' },
}

interface Props {
  plan: DayPlan
  /** What a crew account would see for this day, or null when it can't be known. */
  crew: CrewOrderStatus | null
  /** Publish the displayed order so the crew drives it. Absent → no action. */
  onSendOrderToCrew?: () => void
  sendingOrder?: boolean
  /** Route actions that belong in this card's header (Optimize / Open in Maps). */
  actions?: React.ReactNode
  /** Shown instead of the plan while the route is still resolving. */
  resolving?: boolean
  /** Rendered in place of everything when there is no base address. */
  noBase?: boolean
}

export function DayPlanPanel({ plan, crew, onSendOrderToCrew, sendingOrder, actions, resolving, noBase }: Props) {
  // Blocking + warning ride at the top where they change what you do. Caveats
  // are about EVIDENCE and sit at the bottom, where they qualify the numbers
  // they refer to instead of shouting over them.
  const alerts = plan.warnings.filter(w => w.severity !== 'caveat')
  const caveats = plan.warnings.filter(w => w.severity === 'caveat')

  return (
    <div className="rounded-xl border border-border bg-bg-tertiary">
      {/* Header — the label, and the route actions that were already here */}
      <div className="flex flex-wrap items-center justify-between gap-x-2 gap-y-1.5 px-3 py-2.5">
        <span className="flex items-center gap-1.5 text-xs font-semibold text-ink-muted uppercase tracking-wide">
          <RouteIcon className="w-3.5 h-3.5 text-accent-text" aria-hidden /> Day plan
        </span>
        {actions && <span className="flex items-center gap-3 shrink-0">{actions}</span>}
      </div>

      {noBase ? (
        <p className="px-3 pb-2.5 text-xs text-amber-400">
          Set your base address in Settings to put these stops in a driving order.
        </p>
      ) : resolving ? (
        <p className="px-3 pb-2.5 text-xs text-ink-faint">Working out the route…</p>
      ) : (
        <>
          {/* 1 — what would stop this day happening. Staffing warnings arrive in
              plan.warnings from lib/dayPlan alongside the capacity ones, so this
              list stays the ONE place a day's blocking problems are rendered. */}
          {alerts.length > 0 && (
            <div className="px-3 pb-2.5 space-y-1.5">
              {alerts.map(w => (
                <div key={w.kind} className={cn('flex items-start gap-2 rounded-lg border px-2.5 py-2', TONE[w.severity].row)}>
                  <AlertTriangle className={cn('w-3.5 h-3.5 shrink-0 mt-0.5', TONE[w.severity].icon)} aria-hidden />
                  <p className="text-xs text-ink leading-snug">{w.message}</p>
                </div>
              ))}
            </div>
          )}

          {/* 2 — what the day is. Wraps at 375; nothing here shrinks.
              ⭐ The travel figure is called what the EVIDENCE allows: "driving"
              only when every leg was actually timed, otherwise "route
              overhead". lib/dayPlan owns that word so this line cannot upgrade
              a straight-line allowance into a drive time. */}
          <div className="px-3 pb-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-ink-muted">
            <span className="flex items-center gap-1">
              <MapPin className="w-3 h-3" aria-hidden />
              {plan.stopCount} stop{plan.stopCount === 1 ? '' : 's'} · {areasLabel(plan)}
            </span>
            <span className="flex items-center gap-1">
              <Hourglass className="w-3 h-3" aria-hidden /> ~{fmtH(plan.workMin)} service
            </span>
            <span className="flex items-center gap-1">
              <Navigation className="w-3 h-3" aria-hidden />
              ~{fmtH(plan.driveMin)} {travelFigureLabel(plan.travel)}
              {travelIsEstimated(plan.travel) && <span className="text-ink-faint">(est.)</span>}
              {plan.km != null && plan.travel.basis !== 'estimated' && (
                <span className="text-ink-faint">· {plan.km} km</span>
              )}
            </span>
            <span className="flex items-center gap-1">
              <Clock className="w-3 h-3" aria-hidden /> ends ~<span className="tabular-nums text-ink">{plan.finish}</span>
            </span>
          </div>

          {/* The travel claim, named. This line is the difference between "42
              minutes of driving" as a fact and as a model. */}
          <p className="px-3 pb-2 text-[10px] uppercase tracking-wide text-ink-faint">
            {travelBasisLabel(plan.travel)}
            {travelBasisDetail(plan.travel) && (
              <span className="normal-case tracking-normal"> · {travelBasisDetail(plan.travel)}</span>
            )}
          </p>

          {/* 3 — what it costs of the day */}
          <div className="px-3 pb-2.5">
            <CapacityBar plan={plan} />
          </div>

          {/* 4 — what we assumed */}
          {caveats.length > 0 && (
            <div className="px-3 pb-2.5 space-y-1">
              {caveats.map(w => (
                <p key={w.kind} className="flex items-start gap-1.5 text-[11px] text-ink-faint leading-snug">
                  <Info className="w-3 h-3 shrink-0 mt-0.5" aria-hidden />
                  <span>{w.message}</span>
                </p>
              ))}
            </div>
          )}

          {/* 5 — does the crew have this plan */}
          {crew && <CrewOrderRow crew={crew} onSend={onSendOrderToCrew} sending={sendingOrder} />}
        </>
      )}
    </div>
  )
}

// ── The capacity bar ─────────────────────────────────────────────────────────
// Two constraints, drawn as one bar plus one line — because a day can finish on
// time and still be impossible to staff, and the owner needs to see WHICH one
// bit. The bar is the clock; the line under it is the people.
function CapacityBar({ plan }: { plan: DayPlan }) {
  const pct = plan.capacityMin > 0 ? Math.round((plan.usedClockMin / plan.capacityMin) * 100) : 100
  const over = plan.usedClockMin > plan.capacityMin
  const width = Math.min(100, pct)

  return (
    <div>
      <div className="flex items-center justify-between gap-2 text-[11px] mb-1">
        <span className="text-ink-muted">
          <span className="tabular-nums text-ink font-medium">{fmtH(plan.usedClockMin)}</span> of {fmtH(plan.capacityMin)}
          <span className="text-ink-faint"> · starts {minutesToTime12(plan.startMin)}</span>
        </span>
        <span className={cn('tabular-nums font-semibold', over ? 'text-red-400' : plan.spareClockMin < 60 ? 'text-amber-300' : 'text-emerald-400')}>
          {over ? `${fmtH(plan.usedClockMin - plan.capacityMin)} over` : `${fmtH(plan.spareClockMin)} left`}
        </span>
      </div>
      <div className="h-1.5 rounded-full bg-bg-secondary overflow-hidden" role="img"
        aria-label={`Day is ${pct}% booked${over ? ', over capacity' : ''}`}>
        <div className={cn('h-full rounded-full transition-all', over ? 'bg-red-500' : pct >= 90 ? 'bg-amber-400' : 'bg-accent')}
          style={{ width: `${width}%` }} />
      </div>

      {/* The people dimension. Absent workforce says so rather than showing a
          reassuring blank. */}
      <p className="mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[11px] text-ink-muted">
        <span className="flex items-center gap-1">
          <Users className="w-3 h-3" aria-hidden />
          {plan.workers == null
            ? 'People available: not known'
            : `${plan.workers} ${plan.workers === 1 ? 'person' : 'people'} available`}
        </span>
        {plan.maxCrewSize > 1 && (
          <span className="text-ink-faint">· a visit here needs {plan.maxCrewSize}</span>
        )}
        {plan.workers != null && plan.laborUsedMin != null && plan.laborCapMin != null && plan.workers > 1 && (
          <span className="text-ink-faint tabular-nums">
            · {fmtH(plan.laborUsedMin)} of {fmtH(plan.laborCapMin)} of their time
          </span>
        )}
      </p>
    </div>
  )
}

// ── Does the crew have this plan? ────────────────────────────────────────────
// The owner's board resolves an order every time it renders. The crew's phone
// cannot: it gets whatever `crew_day` sorts, which is `route_order` when one is
// saved and booking order when none is. So the plan on this screen reaches the
// field only if it is SAVED, and this row is the only place that is ever said.
function CrewOrderRow({ crew, onSend, sending }: { crew: CrewOrderStatus; onSend?: () => void; sending?: boolean }) {
  // Nothing on the day is assigned to a crew: the order is not the problem, and
  // offering to "send" it would be theatre. Say what is actually true.
  if (crew.assignedStops === 0) {
    return (
      <div className="border-t border-border px-3 py-2">
        <p className="flex items-start gap-1.5 text-[11px] text-ink-faint leading-snug">
          <Info className="w-3 h-3 shrink-0 mt-0.5" aria-hidden />
          <span>No stop on this day is assigned to a crew, so no crew screen shows it — assign them on the dispatch board first.</span>
        </p>
      </div>
    )
  }

  const partial = crew.assignedStops < crew.totalStops
  const partialNote = partial
    ? ` ${crew.assignedStops} of ${crew.totalStops} stops are assigned to a crew.`
    : ''

  if (crew.matchesPlan) {
    return (
      <div className="border-t border-border px-3 py-2">
        <p className="flex items-start gap-1.5 text-[11px] text-emerald-400 leading-snug">
          <CheckCircle2 className="w-3 h-3 shrink-0 mt-0.5" aria-hidden />
          <span>
            The crew sees this order.
            {partialNote && <span className="text-ink-faint">{partialNote}</span>}
          </span>
        </p>
      </div>
    )
  }

  return (
    <div className="border-t border-border px-3 py-2 flex flex-wrap items-center justify-between gap-x-2 gap-y-1.5">
      <p className="flex items-start gap-1.5 text-[11px] text-amber-300 leading-snug min-w-0">
        <AlertTriangle className="w-3 h-3 shrink-0 mt-0.5" aria-hidden />
        <span>
          {crew.unset
            ? 'The crew’s screen lists these stops in the order they were booked, not this one.'
            : 'The crew’s screen is showing a different order to this one.'}
          {partialNote && <span className="text-ink-faint">{partialNote}</span>}
        </span>
      </p>
      {onSend && (
        <button type="button" onClick={onSend} disabled={sending}
          className="shrink-0 text-xs font-medium rounded-lg border border-border-strong text-ink-muted hover:text-ink hover:bg-surface-raised px-2.5 py-1 flex items-center gap-1 transition-colors disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40">
          <Send className="w-3 h-3" aria-hidden /> {sending ? 'Sending…' : 'Send this order'}
        </button>
      )}
    </div>
  )
}
