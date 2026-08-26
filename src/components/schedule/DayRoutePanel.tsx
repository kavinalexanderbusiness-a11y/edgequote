'use client'

// ── Today's route — ONE sequence for everything the day drives to ────────────
// Session 110.
//
// Before this, an owner planning a day read two lists that never mentioned each
// other: the estimate visits above, the work board below. The route between
// them is one route — you cannot drive to the 10 AM estimate without it costing
// the visit either side of it — so planning it in two places meant planning it
// in neither.
//
// ══ WHY THIS IS A SEQUENCE AND NOT A MERGED CARD LIST ═══════════════════════
// ⛔ Estimates are deliberately NOT rendered through DayOpsPanel's job card.
// Session 79 refused that and was right: that card is a thousand lines of
// operations that only mean something for work — prices, add-ons, change
// orders, work sessions, mark-done — and rendering an estimate through it means
// making every one of them conditional. The first one anybody forgets is the
// day an estimate visit invoices somebody.
//
// So the two surfaces are split by QUESTION rather than by record type:
//
//   this panel        → what ORDER am I driving today?  (jobs AND estimates)
//   the boards below  → what do I DO at this stop?      (each kind, its own doors)
//
// The owner gets the one operational sequence they asked for; a job affordance
// still cannot reach an estimate, because it is not rendered anywhere near one.
// Tapping a row jumps to that stop's real card.
//
// ══ IT PROPOSES; THE OWNER DISPOSES ═════════════════════════════════════════
// ⛔ Nothing here re-orders the day on its own. Pinning or dragging a stop does
// NOT silently reshuffle the rest — it offers, and waits. A schedule that
// rearranges itself is a schedule the field stops trusting.

import { useRef, useState } from 'react'
import {
  Lock, LockOpen, ChevronUp, ChevronDown, Route as RouteIcon, Ruler,
  Wand2, Sparkles, MapPin, GripVertical, Info,
} from 'lucide-react'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/Button'
import { LOCK_LABEL, isReleasable, type LockReason } from '@/lib/daySequence'
import { pinSummary, type RoutePin, type RouteStopKind } from '@/lib/routePins'

/**
 * One stop in the day's driving order, reduced to what SEQUENCING needs.
 *
 * ⛔ Deliberately absent: price, status transitions, anything a job can be DONE
 * to. This shape cannot express an invoice, so this panel cannot draft one.
 */
export interface RouteSequenceStop {
  id: string
  kind: RouteStopKind
  /** Who this stop is for, as the owner would say it. */
  label: string
  /** Street address, when the property has one. */
  address?: string | null
  /** A committed time, already formatted. Null when nothing was promised. */
  promise?: string | null
  /** Arrival in the plan as it currently stands, already formatted. */
  arrival?: string | null
  /** Why it cannot move, INCLUDING the owner's own pin. Null = free. */
  lock: LockReason | null
  /** False when the address could not be placed — it cannot be sequenced. */
  located: boolean
  /** True for work that is finished, so the row can recede. */
  done?: boolean
}

interface Props {
  stops: RouteSequenceStop[]
  pins: RoutePin[]
  /** Pin or release one stop at the seat it currently occupies. */
  onTogglePin: (stop: RouteSequenceStop) => void
  onClearPins: () => void
  onMove: (id: string, dir: -1 | 1) => void
  onDropOn: (fromId: string, toId: string) => void
  /** Re-order everything that is not pinned or locked. */
  onOptimizeRemaining: () => void
  /** Re-order everything, pins included — the owner explicitly lets them go. */
  onOptimizeAll: () => void
  /** Bring a stop's real card into view. */
  onJump: (stop: RouteSequenceStop) => void
  /**
   * The owner changed the order or the pins and has not optimized since. Drives
   * the offer — never an automatic re-run.
   */
  dirty: boolean
  onDismissDirty: () => void
  busy?: boolean
  /**
   * ⚠️ Whether a pin OUTLIVES this screen. False today: there is no column or
   * table in which a pin can be stored (see the Session 110 handoff), so pins
   * last while the day is open. Stated in the panel rather than discovered on
   * refresh — a durability claim the schema cannot keep is worse than none.
   */
  pinsPersist: boolean
  /** Estimates that hold time but could not be placed, for disclosure. */
  unplacedEstimates?: number
}

export function DayRoutePanel({
  stops, pins, onTogglePin, onClearPins, onMove, onDropOn,
  onOptimizeRemaining, onOptimizeAll, onJump, dirty, onDismissDirty,
  busy, pinsPersist, unplacedEstimates = 0,
}: Props) {
  const [draggingId, setDraggingId] = useState<string | null>(null)
  const [dragOverId, setDragOverId] = useState<string | null>(null)
  const dragId = useRef<string | null>(null)

  // A day with one stop has no ordering question, and neither has an empty one.
  if (stops.length === 0) return null

  const reorderable = stops.length > 1
  const pinCount = pins.length
  const estimateCount = stops.filter(s => s.kind === 'appointment').length

  return (
    <div className="rounded-card border border-border bg-bg-secondary overflow-hidden">
      <div className="px-3 py-2.5 border-b border-border flex flex-wrap items-center gap-x-3 gap-y-2">
        <p className="text-[11px] font-semibold uppercase tracking-wide text-ink-faint flex items-center gap-1.5 mr-auto">
          <RouteIcon className="w-3.5 h-3.5 text-accent-text" aria-hidden />
          Today&rsquo;s route
          <span className="text-ink-faint/70 normal-case font-normal">
            · {stops.length} stop{stops.length === 1 ? '' : 's'}
            {estimateCount > 0 && `, ${estimateCount} estimate${estimateCount === 1 ? '' : 's'}`}
          </span>
        </p>
        {pinCount > 0 && (
          <span className="text-[11px] font-semibold text-accent-text flex items-center gap-1">
            <Lock className="w-3 h-3" aria-hidden /> {pinSummary(pins)}
          </span>
        )}
      </div>

      {/* The offer. ⛔ Never an automatic re-run — the owner asked for this stop
          to be where they put it, so moving the others is their call too. */}
      {dirty && (
        <div className="px-3 py-2.5 border-b border-border bg-accent/5 flex flex-wrap items-center gap-2">
          <p className="text-xs text-ink-muted mr-auto min-w-0">
            Route changed — re-order the stops that are not pinned?
          </p>
          <Button size="sm" onClick={onOptimizeRemaining} loading={busy}>
            <Sparkles className="w-3.5 h-3.5" /> Optimize remaining
          </Button>
          <Button size="sm" variant="ghost" onClick={onDismissDirty}>Not now</Button>
        </div>
      )}

      <ol className="divide-y divide-border">
        {stops.map((s, i) => {
          // ⭐ "Can the owner take this lock back?" is lib/daySequence's
          // question, not this panel's — so the Unpin control appears on
          // exactly the locks that can actually be released.
          const pinned = !!s.lock && isReleasable(s.lock)
          const canPin = !s.lock || pinned
          const isEstimate = s.kind === 'appointment'
          return (
            <li
              key={s.id}
              draggable={reorderable && canPin}
              onDragStart={() => { dragId.current = s.id; setDraggingId(s.id) }}
              onDragEnd={() => { setDraggingId(null); setDragOverId(null) }}
              onDragOver={e => { e.preventDefault(); if (dragOverId !== s.id) setDragOverId(s.id) }}
              onDragLeave={() => { if (dragOverId === s.id) setDragOverId(null) }}
              onDrop={() => {
                const from = dragId.current
                dragId.current = null
                setDraggingId(null); setDragOverId(null)
                if (from && from !== s.id) onDropOn(from, s.id)
              }}
              className={cn(
                'flex items-center gap-2 px-2 py-2 transition-colors',
                s.done && 'opacity-55',
                reorderable && canPin && 'cursor-grab active:cursor-grabbing',
                draggingId === s.id && 'opacity-50',
                draggingId && draggingId !== s.id && dragOverId === s.id && 'ring-2 ring-accent ring-inset',
                pinned && 'bg-accent/[0.06]',
              )}
            >
              {reorderable && (
                <GripVertical className="w-3.5 h-3.5 text-ink-faint/50 shrink-0 hidden sm:block" aria-hidden />
              )}

              <span className={cn(
                'w-6 h-6 rounded-full flex items-center justify-center text-[11px] font-bold shrink-0 tabular-nums',
                pinned ? 'bg-accent text-black' : 'bg-bg-tertiary text-ink-faint',
              )}>{i + 1}</span>

              <button
                type="button"
                onClick={() => onJump(s)}
                className="min-w-0 flex-1 text-left min-h-[44px] sm:min-h-0 flex flex-col justify-center"
              >
                <span className="flex items-center gap-1.5 min-w-0">
                  {isEstimate && (
                    <span className="shrink-0 text-[9px] font-bold uppercase tracking-wide px-1 py-px rounded border border-violet-500/30 bg-violet-500/10 text-violet-300 flex items-center gap-0.5">
                      <Ruler className="w-2.5 h-2.5" aria-hidden /> Estimate
                    </span>
                  )}
                  <span className={cn('truncate text-sm font-medium text-ink', s.done && 'line-through')}>
                    {s.label}
                  </span>
                  {pinned && <Lock className="w-3 h-3 text-accent-text shrink-0" aria-hidden />}
                </span>
                <span className="flex items-center gap-1.5 text-[11px] text-ink-faint min-w-0">
                  {s.promise && <span className="shrink-0 font-semibold text-ink-muted tabular-nums">{s.promise}</span>}
                  {s.arrival && !s.promise && <span className="shrink-0 tabular-nums">arrives {s.arrival}</span>}
                  {!s.located && (
                    <span className="shrink-0 text-amber-400 flex items-center gap-0.5">
                      <MapPin className="w-2.5 h-2.5" aria-hidden /> no address
                    </span>
                  )}
                  {s.address && <span className="truncate">{s.address}</span>}
                </span>
              </button>

              {/* Why it is held, when the owner cannot take it back. */}
              {s.lock && !pinned && (
                <span className="shrink-0 text-[10px] text-ink-faint flex items-center gap-1"
                  title={`Held in place — ${LOCK_LABEL[s.lock]}`}>
                  <Lock className="w-3 h-3" aria-hidden />
                  <span className="hidden md:inline">{LOCK_LABEL[s.lock]}</span>
                </span>
              )}

              <div className="flex items-center shrink-0">
                {reorderable && canPin && (
                  <>
                    <button type="button" onClick={() => onMove(s.id, -1)} disabled={i === 0}
                      aria-label={`Move ${s.label} up`}
                      className="w-11 h-11 sm:w-8 sm:h-8 flex items-center justify-center text-ink-faint hover:text-ink disabled:opacity-25">
                      <ChevronUp className="w-4 h-4" />
                    </button>
                    <button type="button" onClick={() => onMove(s.id, 1)} disabled={i === stops.length - 1}
                      aria-label={`Move ${s.label} down`}
                      className="w-11 h-11 sm:w-8 sm:h-8 flex items-center justify-center text-ink-faint hover:text-ink disabled:opacity-25">
                      <ChevronDown className="w-4 h-4" />
                    </button>
                  </>
                )}
                {canPin && (
                  <button
                    type="button"
                    onClick={() => onTogglePin(s)}
                    aria-label={pinned ? `Unpin ${s.label}` : `Pin ${s.label} at position ${i + 1}`}
                    aria-pressed={pinned}
                    title={pinned ? 'Unpin — the optimizer may move it again' : 'Pin here — optimizing will not move it'}
                    className={cn('w-11 h-11 sm:w-8 sm:h-8 flex items-center justify-center rounded-lg transition-colors',
                      pinned ? 'text-accent-text' : 'text-ink-faint hover:text-ink')}
                  >
                    {pinned ? <Lock className="w-4 h-4" /> : <LockOpen className="w-4 h-4" />}
                  </button>
                )}
              </div>
            </li>
          )
        })}
      </ol>

      <div className="px-3 py-2.5 border-t border-border flex flex-wrap items-center gap-2">
        <Button size="sm" variant="secondary" onClick={onOptimizeRemaining} loading={busy}>
          <Sparkles className="w-3.5 h-3.5" /> Optimize remaining
        </Button>
        <Button size="sm" variant="ghost" onClick={onOptimizeAll} loading={busy}>
          <Wand2 className="w-3.5 h-3.5" /> Optimize all
        </Button>
        {pinCount > 0 && (
          <Button size="sm" variant="ghost" onClick={onClearPins}>
            <LockOpen className="w-3.5 h-3.5" /> Clear pins
          </Button>
        )}
      </div>

      {/* What this screen had to assume to say any of it. */}
      {(pinCount > 0 || unplacedEstimates > 0) && (
        <div className="px-3 pb-2.5 space-y-1">
          {pinCount > 0 && !pinsPersist && (
            <p className="text-[11px] text-ink-faint flex items-start gap-1.5">
              <Info className="w-3.5 h-3.5 shrink-0 mt-px" aria-hidden />
              Pins last while this day is open. The ORDER you apply is saved; which stops you pinned is not
              yet something this product can store.
            </p>
          )}
          {unplacedEstimates > 0 && (
            <p className="text-[11px] text-ink-faint flex items-start gap-1.5">
              <Ruler className="w-3.5 h-3.5 shrink-0 mt-px" aria-hidden />
              {unplacedEstimates} estimate{unplacedEstimates === 1 ? '' : 's'} on this day
              {unplacedEstimates === 1 ? ' has' : ' have'} no address, so
              {unplacedEstimates === 1 ? ' it is' : ' they are'} not placed in this route.
              Drag {unplacedEstimates === 1 ? 'it' : 'them'} into the order to plan around
              {unplacedEstimates === 1 ? ' it' : ' them'}.
            </p>
          )}
        </div>
      )}
    </div>
  )
}
