'use client'

import { minutesToTime12 } from '@/lib/route'
import { JobStatus } from '@/types'
import { cn } from '@/lib/utils'

export interface TimelineStop {
  jobId: string
  name: string
  arrivalMin: number    // from the route engine's ETA chain
  durMin: number
  status: JobStatus
}

// ── Route Timeline ────────────────────────────────────────────────────────────
// The day drawn as TIME instead of as numbers. Every value here was already
// computed by the ONE route engine — lib/route's computeDayEtas gives each stop
// its arrival minute and the day its finish; the capacity line comes from
// lib/dayStatus. This file does NO route maths of its own: a drive leg is simply
// the gap between one stop's departure and the next one's arrival, so the picture
// can never disagree with the ETAs on the cards below it.
//
// It answers, at a glance, what the metric strip could only state: where the day
// actually goes, how much of it is driving, and whether it runs past capacity.
export function RouteTimeline({ startMin, finishMin, capacityEndMin, stops, nowMin, onSelectStop, omitted, className }: {
  startMin: number
  finishMin: number
  capacityEndMin: number
  stops: TimelineStop[]
  /** Minutes-since-midnight right now — passed only for TODAY. Draws the "now"
   *  line, which is what turns a plan into a live read on whether you're behind. */
  nowMin?: number
  /** Jump to a stop's card. Without this the timeline is a picture you can only
   *  interrogate by hovering — and `title` tooltips never fire on touch, so on a
   *  phone the stop names and arrival times were simply unreadable. */
  onSelectStop?: (jobId: string) => void
  /** Visits on this day that the route couldn't place (no address to geocode).
   *  They're absent from the ETA chain, so they're absent here AND from the
   *  finish time — say so rather than draw a day that quietly leaves work out. */
  omitted?: number
  className?: string
}) {
  if (!stops.length) return null

  const endMin = Math.max(finishMin, capacityEndMin)
  const span = Math.max(60, endMin - startMin)
  const pct = (min: number) => ((min - startMin) / span) * 100
  const over = finishMin > capacityEndMin
  const overMin = Math.round(finishMin - capacityEndMin)
  const showNow = nowMin != null && nowMin >= startMin && nowMin <= endMin

  // Lay the day out: drive → work → drive → work … from the engine's arrivals.
  type Seg =
    | { kind: 'drive'; from: number; to: number }
    | { kind: 'work'; from: number; to: number; stop: TimelineStop; idx: number }
  const segs: Seg[] = []
  let cursor = startMin
  stops.forEach((s, i) => {
    if (s.arrivalMin > cursor) segs.push({ kind: 'drive', from: cursor, to: s.arrivalMin })
    segs.push({ kind: 'work', from: s.arrivalMin, to: s.arrivalMin + s.durMin, stop: s, idx: i })
    cursor = s.arrivalMin + s.durMin
  })

  const driveMin = Math.round(segs.filter(s => s.kind === 'drive').reduce((t, s) => t + (s.to - s.from), 0))
  const ticks: number[] = []
  for (let m = Math.ceil(startMin / 60) * 60; m <= endMin; m += 60) ticks.push(m)

  return (
    <div className={cn('rounded-xl border border-border bg-bg-tertiary px-3 py-2.5', className)}>
      <div className="flex items-center justify-between gap-2 mb-2">
        <span className="text-xs font-semibold text-ink-muted uppercase tracking-wide">Day timeline</span>
        <span className="text-[11px] text-ink-faint tabular-nums">
          {minutesToTime12(startMin)} → <span className={cn('font-semibold', over ? 'text-red-400' : 'text-ink')}>{minutesToTime12(finishMin)}</span>
          {driveMin > 0 && <span className="hidden sm:inline"> · {driveMin} min driving</span>}
        </span>
      </div>

      {/* The bar. Capacity is the reference line: anything past it is time you
          don't have, drawn in red rather than described in a footnote. */}
      <div className="relative h-7 rounded-lg bg-surface border border-border overflow-hidden">
        {/* Past-capacity zone */}
        {over && (
          <div
            className="absolute inset-y-0 bg-red-500/10"
            style={{ left: `${pct(capacityEndMin)}%`, right: 0 }}
            aria-hidden
          />
        )}

        {segs.map((s, i) => {
          const left = pct(s.from)
          const width = Math.max(0.6, pct(s.to) - pct(s.from))
          if (s.kind === 'drive') {
            return (
              <div
                key={`d${i}`}
                className="absolute inset-y-0 flex items-center justify-center"
                style={{ left: `${left}%`, width: `${width}%` }}
                title={`Drive ${Math.round(s.to - s.from)} min`}
              >
                <div className="w-full h-1 bg-ink-faint/40 rounded-full" />
              </div>
            )
          }
          const done = s.stop.status === 'completed'
          const running = s.stop.status === 'in_progress'
          const label = `Stop ${s.idx + 1}: ${s.stop.name} — arrives ${minutesToTime12(s.stop.arrivalMin)}, ${s.stop.durMin} min${done ? ', done' : running ? ', in progress' : ''}`
          const cls = cn(
            'absolute inset-y-1 rounded-md border flex items-center justify-center overflow-hidden',
            done
              ? 'bg-emerald-500/20 border-emerald-500/40 text-emerald-300'
              : running
                ? 'bg-sky-400/25 border-sky-400/50 text-sky-200'
                : 'bg-accent/20 border-accent/45 text-accent',
            onSelectStop && 'cursor-pointer hover:brightness-125 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:z-20',
          )
          const style = { left: `${left}%`, width: `${width}%` }
          const num = <span className="text-[9px] font-bold tabular-nums leading-none px-0.5 truncate">{s.idx + 1}</span>
          // A real button when it can act: the block is then reachable by keyboard
          // and readable by a screen reader, and a tap jumps to the stop's card —
          // which is where the detail lives on a phone, tooltips being hover-only.
          return onSelectStop ? (
            <button
              key={s.stop.jobId}
              type="button"
              onClick={() => onSelectStop(s.stop.jobId)}
              className={cls}
              style={style}
              title={label}
              aria-label={label}
            >
              {num}
            </button>
          ) : (
            <div key={s.stop.jobId} className={cls} style={style} title={label} aria-label={label}>{num}</div>
          )
        })}

        {/* Capacity line — where the day is supposed to end. */}
        {pct(capacityEndMin) <= 100 && (
          <div
            className="absolute inset-y-0 w-px bg-ink-muted/70"
            style={{ left: `${pct(capacityEndMin)}%` }}
            title={`Day capacity ends ${minutesToTime12(capacityEndMin)}`}
            aria-hidden
          />
        )}

        {/* Now — the line that turns the plan into a live read. Against the
            completed/live blocks, being left of your current stop means ahead
            and right of it means behind, with no arithmetic. */}
        {showNow && (
          <div
            className="absolute inset-y-0 w-0.5 bg-ink shadow-[0_0_0_1px_rgba(0,0,0,0.35)] z-10"
            style={{ left: `${pct(nowMin!)}%` }}
            title={`Now — ${minutesToTime12(nowMin!)}`}
          />
        )}
      </div>

      {/* Hour ruler. Labels collide on a phone, so show every second hour there
          and the full set once there's room. */}
      <div className="relative h-3.5 mt-1" aria-hidden>
        {ticks.map((m, i) => (
          <span
            key={m}
            className={cn(
              'absolute top-0 text-[9px] text-ink-faint tabular-nums -translate-x-1/2 whitespace-nowrap',
              i % 2 === 1 && 'hidden sm:inline',
            )}
            style={{ left: `${pct(m)}%` }}
          >
            {minutesToTime12(m).replace(':00', '')}
          </span>
        ))}
      </div>

      {over && (
        <p className="text-[11px] text-red-400 mt-1">
          Runs ~{Math.round(overMin / 6) / 10}h past your day — optimize the route, or move a stop.
        </p>
      )}

      {/* The route can only place stops it can geocode, so an address-less visit is
          missing from the ETA chain — and therefore from this bar and the finish
          time above it. Better to admit the gap than to draw a shorter day than
          the one you actually have. */}
      {!!omitted && omitted > 0 && (
        <p className="text-[11px] text-amber-400 mt-1">
          {omitted} {omitted === 1 ? 'visit has' : 'visits have'} no address — not shown here, and not counted in the finish time.
        </p>
      )}
    </div>
  )
}
