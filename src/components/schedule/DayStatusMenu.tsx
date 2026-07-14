'use client'

import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { format } from 'date-fns'
import { cn } from '@/lib/utils'
import { DAY_STATUSES, DAY_STATUS_META, dayStatusLabel, type DayStatus, type DayStatusRow } from '@/lib/dayStatus'
import { RotateCcw, X } from 'lucide-react'

interface Props {
  dates: string[]                  // one date (single day) or many (multi-select)
  current: DayStatusRow | null     // the existing status when a SINGLE day is targeted
  pos: { x: number; y: number }    // where the right-click / long-press happened
  onPick: (status: DayStatus) => void
  onClear: () => void
  onClose: () => void
}

interface Coords { top: number; left: number }

// Day-status context menu: pick a status (Set / Change) or clear it (back to
// Normal). Portaled + viewport-clamped so it's always fully visible; closes on
// Escape or an outside click. Applies to a single day or the whole selection.
export function DayStatusMenu({ dates, current, pos, onPick, onClear, onClose }: Props) {
  const ref = useRef<HTMLDivElement>(null)
  const [coords, setCoords] = useState<Coords | null>(null)
  const multi = dates.length > 1

  const place = () => {
    const w = 248
    const h = ref.current?.offsetHeight ?? 360
    const m = 8
    const vw = window.innerWidth, vh = window.innerHeight
    let left = pos.x
    let top = pos.y
    if (left + w + m > vw) left = vw - w - m
    if (top + h + m > vh) top = Math.max(m, vh - h - m)
    setCoords({ top: Math.max(m, top), left: Math.max(m, left) })
  }
  useLayoutEffect(() => { place() }, []) // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    const onDown = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) onClose() }
    window.addEventListener('keydown', onKey)
    document.addEventListener('mousedown', onDown)
    return () => { window.removeEventListener('keydown', onKey); document.removeEventListener('mousedown', onDown) }
  }, [onClose])

  const heading = multi
    ? `${dates.length} days selected`
    : format(new Date(dates[0] + 'T00:00:00'), 'EEEE, MMM d')
  const sub = current && !multi ? `Change status (now ${dayStatusLabel(current)})` : 'Set day status'

  const menu = (
    <div
      ref={ref}
      role="menu"
      style={{ position: 'fixed', top: coords?.top ?? pos.y, left: coords?.left ?? pos.x, width: 248, visibility: coords ? 'visible' : 'hidden' }}
      className="z-[200] rounded-xl border border-border bg-bg-secondary shadow-2xl overflow-hidden">
      <div className="flex items-center justify-between px-3 py-2 border-b border-border">
        <div className="min-w-0">
          <p className="text-xs font-bold text-ink truncate">{heading}</p>
          <p className="text-[10px] text-ink-faint truncate">{sub}</p>
        </div>
        <button type="button" onClick={onClose} aria-label="Close" className="shrink-0 h-6 w-6 rounded-md flex items-center justify-center text-ink-faint hover:text-ink transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"><X className="w-3.5 h-3.5" /></button>
      </div>
      <div className="p-1.5 grid grid-cols-2 gap-1">
        {DAY_STATUSES.map(s => {
          const meta = DAY_STATUS_META[s]
          const isCurrent = current?.status === s && !multi
          return (
            <button
              key={s}
              role="menuitem"
              onClick={() => onPick(s as DayStatus)}
              className={cn('flex items-center gap-1.5 px-2 py-1.5 rounded-lg text-left text-xs transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40',
                isCurrent ? 'bg-accent/10 text-ink ring-1 ring-accent/40' : 'text-ink-muted hover:bg-surface hover:text-ink')}>
              <span className="shrink-0 text-sm leading-none">{meta.emoji}</span>
              <span className="truncate">{meta.label}</span>
            </button>
          )
        })}
      </div>
      {current && !multi && (
        <div className="p-1.5 border-t border-border">
          <button
            role="menuitem"
            onClick={onClear}
            className="w-full flex items-center gap-2 px-2 py-1.5 rounded-lg text-xs font-medium text-ink-muted hover:bg-surface hover:text-ink transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40">
            <RotateCcw className="w-3.5 h-3.5" /> Clear status (back to Normal)
          </button>
        </div>
      )}
      <p className="px-3 py-1.5 border-t border-border text-[10px] text-ink-faint">
        Blocked days are skipped by Auto Optimize &amp; Weather Ops. You can still drag a job onto one.
      </p>
    </div>
  )

  return createPortal(menu, document.body)
}
