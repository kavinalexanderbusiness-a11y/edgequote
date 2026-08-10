'use client'

import { useState } from 'react'
import { createClient } from '@/lib/supabase/client'
import { loadCrewDay, partitionCrewStops, type CrewStop } from '@/lib/crewAccess'
import { cn } from '@/lib/utils'
import { ChevronDown, AlertTriangle } from 'lucide-react'

// ── One day on the Week list ─────────────────────────────────────────────────
// The row answers "am I working, how much"; TAPPING it answers "doing what,
// where" — the same crew_day RPC Today runs, for that date, rendered read-only
// (no Start buttons on a day that isn't today; acting on future work is the
// dispatcher's call, not a preview's). Fetched on first expand, kept for the
// session; a failed fetch says so and offers the tap again — it never renders
// an empty, believable day.
//
// The whole row is one ≥56px button — the thumb, not the chevron, is the target.

function timeLabel(t: string | null): string | null {
  if (!t) return null
  const [h, m] = t.split(':')
  const hh = Number(h)
  return `${((hh + 11) % 12) + 1}:${m} ${hh < 12 ? 'am' : 'pm'}`
}

export function CrewWeekDay({ iso, relLabel, weekday, dayNum, stops, doneCount, hours }: {
  iso: string
  /** "Today" / "Tomorrow" — the orientation answer; null for further out. */
  relLabel: string | null
  weekday: string
  dayNum: number
  stops: number
  doneCount: number
  hours: number
}) {
  const supabase = createClient()
  const [open, setOpen] = useState(false)
  const [detail, setDetail] = useState<CrewStop[] | null>(null)
  const [detailFailed, setDetailFailed] = useState(false)
  const [busy, setBusy] = useState(false)

  async function toggle() {
    const next = !open
    setOpen(next)
    if (!next || detail !== null || busy || stops === 0) return
    setBusy(true)
    setDetailFailed(false)
    const res = await loadCrewDay(supabase, iso)
    // 'revoked' can't really reach here (the layout gates the page) — but if it
    // does, showing "couldn't load" beats showing an empty believable day.
    if (res.kind === 'ok') setDetail(res.day.stops)
    else setDetailFailed(true)
    setBusy(false)
  }

  const allDone = doneCount === stops && stops > 0
  const { active, cancelled } = detail ? partitionCrewStops(detail) : { active: [], cancelled: [] }

  return (
    <li className="rounded-card border border-border bg-bg-secondary">
      <button
        type="button"
        onClick={toggle}
        aria-expanded={open}
        className="w-full min-h-[56px] px-3.5 py-3 flex items-center gap-3 text-left rounded-card focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
      >
        <div className="w-11 shrink-0 text-center">
          <p className={cn('text-[10px] font-semibold uppercase tracking-wide', relLabel ? 'text-accent-text' : 'text-ink-faint')}>
            {weekday}
          </p>
          <p className="text-lg font-bold tabular-nums text-ink leading-none">{dayNum}</p>
        </div>
        <div className="min-w-0 flex-1">
          <p className="text-sm font-semibold text-ink">
            {relLabel && <span className="text-accent-text">{relLabel} · </span>}
            {stops === 0 ? 'Nothing booked' : <>{stops} stop{stops === 1 ? '' : 's'}<span className="ml-1.5 font-normal text-ink-muted">· ~{hours}h</span></>}
          </p>
          {doneCount > 0 && (
            <p className={cn('text-[11px]', allDone ? 'text-emerald-400' : 'text-ink-faint')}>
              {allDone ? 'All done' : `${doneCount} done`}
            </p>
          )}
        </div>
        {stops > 0 && (
          <ChevronDown className={cn('w-4 h-4 shrink-0 text-ink-faint transition-transform', open && 'rotate-180')} aria-hidden />
        )}
      </button>

      {open && stops > 0 && (
        <div className="px-3.5 pb-3 border-t border-border/60">
          {busy && <p className="pt-2 text-xs text-ink-faint">Loading…</p>}
          {detailFailed && (
            <p className="pt-2 text-xs text-amber-400 flex items-center gap-1.5">
              <AlertTriangle className="w-3.5 h-3.5 shrink-0" aria-hidden /> Couldn’t load this day — tap to try again.
            </p>
          )}
          {detail && (
            <ul className="pt-2 space-y-1.5">
              {active.map((s, i) => (
                <li key={s.id} className="text-xs flex items-start gap-2">
                  <span className="shrink-0 w-4 text-right tabular-nums text-ink-faint">{i + 1}.</span>
                  <span className="min-w-0">
                    <span className={cn('font-medium', s.status === 'completed' ? 'text-ink-faint line-through' : 'text-ink')}>
                      {s.customer?.name || s.title}
                    </span>
                    {s.property?.address && <span className="text-ink-muted"> — {s.property.address}</span>}
                    <span className="text-ink-faint">
                      {s.service_type ? ` · ${s.service_type}` : ''}
                      {timeLabel(s.start_time) ? ` · ${timeLabel(s.start_time)}` : ''}
                      {s.status === 'completed' ? ' · done' : ''}
                    </span>
                  </span>
                </li>
              ))}
              {cancelled.map(s => (
                <li key={s.id} className="text-xs text-ink-faint line-through pl-6 truncate">
                  {s.customer?.name || s.title}{s.property?.address ? ` — ${s.property.address}` : ''} · cancelled
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </li>
  )
}
