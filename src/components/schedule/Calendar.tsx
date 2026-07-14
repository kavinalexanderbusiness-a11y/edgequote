'use client'

import { useMemo, useRef, useState, useEffect } from 'react'
import {
  startOfMonth, endOfMonth, startOfWeek, endOfWeek, eachDayOfInterval,
  format, isSameMonth, isSameDay, addDays,
} from 'date-fns'
import { Job, JOB_STATUS_COLORS } from '@/types'
import { ScheduleItem, ITEM_META } from '@/lib/scheduleItems'
import { cn } from '@/lib/utils'
import { DayStatusMap, dayStatusMeta, dayStatusLabel, isDayBlocked } from '@/lib/dayStatus'
import { toast } from '@/lib/toast'
import { Repeat, Check } from 'lucide-react'

export type CalendarView = 'month' | 'week' | 'day'

interface CalendarProps {
  view: CalendarView
  cursor: Date
  jobs: Job[]
  onSelectDay: (date: Date) => void
  onSelectJob: (job: Job) => void
  onMarkDone?: (job: Job) => void
  onMoveJob?: (job: Job, newDateISO: string) => void
  recurrenceLabels?: Record<string, string>
  valueByJobId?: Record<string, number>
  // Number of add-on services per job → a compact "+N" badge on the chip so the
  // owner sees at a glance why a visit is worth more than usual.
  addonCountByJobId?: Record<string, number>
  // Non-job schedule items (estimate / callback / appointment / task / reminder),
  // merged into the SAME calendar. Optional so the calendar still works standalone.
  scheduleItems?: ScheduleItem[]
  onSelectItem?: (item: ScheduleItem) => void
  onMoveItem?: (item: ScheduleItem, newDateISO: string) => void
  // Day Status (per-day availability): shade days that have a status, show the
  // status, open the day menu on right-click / long-press, and support multi-day
  // selection (cmd/ctrl-click). All optional so the calendar still works standalone.
  dayStatusMap?: DayStatusMap
  onDayMenu?: (dateISO: string, pos: { x: number; y: number }) => void
  selectedDays?: Set<string>
  onToggleDaySelect?: (dateISO: string) => void
}

// What a pointer-drag is carrying — generalised so a Job and a ScheduleItem share
// the SAME drag engine (one implementation, no second drag system).
interface DragPayload { title: string; fromDate: string; commit: (toDate: string) => void }

// The ONE signature every chip's drag-start handler uses. A chip only forwards the
// pointer event; the parent decides what (job or item) is being dragged. Job and
// ScheduleItem chips are therefore interchangeable from the drag engine's view.
type ChipDragStart = (e: React.PointerEvent) => void

function JobChip({ job, onSelect, onDragStart, recurLabel, value, addonCount, onMarkDone }: { job: Job; onSelect: (j: Job) => void; onDragStart?: ChipDragStart; recurLabel?: string; value?: number; addonCount?: number; onMarkDone?: (j: Job) => void }) {
  // One-tap Done from month/week — a small sibling button (not nested in the chip
  // button) so it's valid markup, works on touch, and never starts a drag.
  const canComplete = !!onMarkDone && job.status !== 'completed' && job.status !== 'cancelled'
  return (
    <div className="relative">
      <button
        data-chip
        onClick={(e) => { e.stopPropagation(); onSelect(job) }}
        onPointerDown={onDragStart}
        style={onDragStart ? { touchAction: 'none' } : undefined}
        className={cn(
          'w-full text-left px-1.5 py-0.5 rounded text-[11px] font-medium border truncate transition-opacity hover:opacity-80',
          canComplete && 'pr-6',
          JOB_STATUS_COLORS[job.status],
          job.status === 'completed' && 'opacity-60' // done work recedes; active work commands attention
        )}
        title={recurLabel ? `${job.customers?.name || job.title} · ${recurLabel} (recurring)` : (job.customers?.name || job.title)}
      >
        <span className="flex items-center gap-0.5">
          {job.status === 'completed' && <Check className="w-2.5 h-2.5 shrink-0" />}
          {job.recurrence_id && <Repeat className="w-2.5 h-2.5 shrink-0 opacity-70" />}
          {/* Customer name, matching the day board — the same visit must read the
              same in every view. */}
          <span className={cn('truncate', job.status === 'completed' && 'line-through opacity-80')}>{job.start_time ? job.start_time.slice(0, 5) + ' ' : ''}{job.customers?.name || job.title}</span>
          {addonCount != null && addonCount > 0 && (
            <span className="shrink-0 text-[9px] font-bold text-accent" title={`${addonCount} add-on service${addonCount !== 1 ? 's' : ''}`}>+{addonCount}</span>
          )}
          {value != null && <span className={cn('ml-auto shrink-0 pl-1 font-semibold', value > 0 ? 'opacity-90' : 'text-amber-400')}>{value > 0 ? `$${value}` : '$?'}</span>}
        </span>
      </button>
      {canComplete && (
        <button
          type="button"
          onClick={(e) => { e.stopPropagation(); onMarkDone!(job) }}
          onPointerDown={(e) => e.stopPropagation()}
          title="Mark done"
          aria-label={`Mark ${job.title} done`}
          className="absolute top-1/2 -translate-y-1/2 right-0 w-5 h-5 rounded-full bg-emerald-500/20 border border-emerald-500/40 text-emerald-300 hover:bg-emerald-500 hover:text-black flex items-center justify-center transition-colors"
        >
          <Check className="w-3 h-3" />
        </button>
      )}
    </div>
  )
}

function itemTimeLabel(item: ScheduleItem): string {
  if (item.start_time) return item.start_time.slice(0, 5) + ' '
  if (item.due_at) { try { return format(new Date(item.due_at), 'HH:mm') + ' ' } catch { return '' } }
  return ''
}

function ItemChip({ item, onSelect, onDragStart }: { item: ScheduleItem; onSelect: (i: ScheduleItem) => void; onDragStart?: ChipDragStart }) {
  const meta = ITEM_META[item.type]
  const done = item.status === 'completed'
  return (
    <button
      data-chip
      onClick={(e) => { e.stopPropagation(); onSelect(item) }}
      onPointerDown={onDragStart}
      style={onDragStart ? { touchAction: 'none' } : undefined}
      className={cn('w-full text-left px-1.5 py-0.5 rounded text-[11px] font-medium border truncate transition-opacity hover:opacity-80', meta.chip)}
      title={`${meta.label}: ${item.title}`}
    >
      <span className="flex items-center gap-0.5">
        {done ? <Check className="w-2.5 h-2.5 shrink-0" /> : <meta.icon className="w-2.5 h-2.5 shrink-0 opacity-80" />}
        <span className={cn('truncate', done && 'line-through opacity-80')}>{itemTimeLabel(item)}{item.title}</span>
      </span>
    </button>
  )
}

export function Calendar({ view, cursor, jobs, onSelectDay, onSelectJob, onMarkDone, onMoveJob, recurrenceLabels, valueByJobId, addonCountByJobId, scheduleItems, onSelectItem, onMoveItem, dayStatusMap, onDayMenu, selectedDays, onToggleDaySelect }: CalendarProps) {
  const recurLabelFor = (job: Job) => job.recurrence_id ? recurrenceLabels?.[job.recurrence_id] : undefined
  const weekdayLabels = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
  const dragEnabled = !!(onMoveJob || onMoveItem)

  // Latest dayStatusMap for the drag-drop closure (which only re-binds on dragEnabled).
  const dayStatusRef = useRef(dayStatusMap)
  dayStatusRef.current = dayStatusMap

  // Right-click (desktop) / long-press (touch) → the day menu. Long-press is
  // ignored when the press starts on a chip (that's a drag) or with a mouse
  // (mouse uses right-click). A fired long-press suppresses the following click.
  const longPressRef = useRef<{ timer: ReturnType<typeof setTimeout>; x: number; y: number } | null>(null)
  const suppressClick = useRef(false)
  const cancelLongPress = () => { if (longPressRef.current) { clearTimeout(longPressRef.current.timer); longPressRef.current = null } }
  function dayHandlers(dateISO: string, day: Date) {
    // The ONE activation path — mouse click and Enter/Space share it exactly.
    const activate = (e: { metaKey: boolean; ctrlKey: boolean }) => {
      if ((e.metaKey || e.ctrlKey) && onToggleDaySelect) { onToggleDaySelect(dateISO); return }
      onSelectDay(day)
    }
    return {
      onClick: (e: React.MouseEvent) => {
        if (suppressClick.current) { suppressClick.current = false; return }
        activate(e)
      },
      onKeyDown: (e: React.KeyboardEvent) => {
        // Only the cell itself — chips inside are real buttons with their own keys.
        if (e.target !== e.currentTarget) return
        if (e.key !== 'Enter' && e.key !== ' ') return
        e.preventDefault()
        activate(e)
      },
      onContextMenu: onDayMenu ? (e: React.MouseEvent) => { e.preventDefault(); onDayMenu(dateISO, { x: e.clientX, y: e.clientY }) } : undefined,
      onPointerDown: onDayMenu ? (e: React.PointerEvent) => {
        if (e.pointerType === 'mouse') return
        if ((e.target as HTMLElement).closest('[data-chip]')) return
        const x = e.clientX, y = e.clientY
        const timer = setTimeout(() => { longPressRef.current = null; suppressClick.current = true; onDayMenu(dateISO, { x, y }) }, 480)
        longPressRef.current = { timer, x, y }
      } : undefined,
      onPointerMove: (e: React.PointerEvent) => { const l = longPressRef.current; if (l && Math.hypot(e.clientX - l.x, e.clientY - l.y) > 8) cancelLongPress() },
      onPointerUp: cancelLongPress,
      onPointerLeave: cancelLongPress,
    }
  }

  const monthDays = useMemo(() => {
    const start = startOfWeek(startOfMonth(cursor))
    const end = endOfWeek(endOfMonth(cursor))
    return eachDayOfInterval({ start, end })
  }, [cursor])

  const weekDays = useMemo(() => {
    const start = startOfWeek(cursor)
    return eachDayOfInterval({ start, end: addDays(start, 6) })
  }, [cursor])

  // P7: index jobs by date ONCE per jobs change, instead of filtering per cell.
  const jobsByDate = useMemo(() => {
    const m: Record<string, Job[]> = {}
    for (const j of jobs) (m[j.scheduled_date] ||= []).push(j)
    for (const k in m) m[k].sort((a, b) => (a.start_time || '').localeCompare(b.start_time || ''))
    return m
  }, [jobs])
  const dayJobsFor = (day: Date) => jobsByDate[format(day, 'yyyy-MM-dd')] || []

  const itemsByDate = useMemo(() => {
    const m: Record<string, ScheduleItem[]> = {}
    for (const it of (scheduleItems || [])) (m[it.scheduled_date] ||= []).push(it)
    for (const k in m) m[k].sort((a, b) => (a.start_time || a.due_at || '').localeCompare(b.start_time || b.due_at || ''))
    return m
  }, [scheduleItems])
  const dayItemsFor = (day: Date) => itemsByDate[format(day, 'yyyy-MM-dd')] || []

  // ── P1: true pointer drag-and-drop across days (jobs AND items share it) ───────
  const ghostRef = useRef<HTMLDivElement>(null)
  const dragRef = useRef<{ payload: DragPayload; startX: number; startY: number; active: boolean; over: HTMLElement | null } | null>(null)
  const justDragged = useRef(false)
  const [dragging, setDragging] = useState(false)

  function startDrag(e: React.PointerEvent, payload: DragPayload) {
    if (!dragEnabled) return
    dragRef.current = { payload, startX: e.clientX, startY: e.clientY, active: false, over: null }
  }
  // Per-entry drag starters — build the real commit closure for this job/item, then
  // hand the chip a plain ChipDragStart (single-arg) closure at the render site.
  const jobDragStart = onMoveJob ? (e: React.PointerEvent, job: Job) => startDrag(e, { title: job.title, fromDate: job.scheduled_date, commit: (to) => onMoveJob(job, to) }) : undefined
  const itemDragStart = onMoveItem ? (e: React.PointerEvent, item: ScheduleItem) => startDrag(e, { title: item.title, fromDate: item.scheduled_date, commit: (to) => onMoveItem(item, to) }) : undefined

  useEffect(() => {
    if (!dragEnabled) return
    function setOver(el: HTMLElement | null) {
      const d = dragRef.current; if (!d) return
      if (d.over === el) return
      d.over?.classList.remove('ring-2', 'ring-accent', 'ring-inset', 'bg-accent/5')
      if (el && el.dataset.date !== d.payload.fromDate) el.classList.add('ring-2', 'ring-accent', 'ring-inset', 'bg-accent/5')
      d.over = el
    }
    function move(e: PointerEvent) {
      const d = dragRef.current; if (!d) return
      if (!d.active) {
        if (Math.hypot(e.clientX - d.startX, e.clientY - d.startY) < 6) return
        d.active = true
        setDragging(true)
        document.body.style.userSelect = 'none'
      }
      if (ghostRef.current) {
        ghostRef.current.textContent = d.payload.title
        ghostRef.current.style.transform = `translate(${e.clientX + 10}px, ${e.clientY + 10}px)`
      }
      const el = document.elementFromPoint(e.clientX, e.clientY) as HTMLElement | null
      setOver((el?.closest('[data-date]') as HTMLElement | null) ?? null)
    }
    function up() {
      const d = dragRef.current
      dragRef.current = null
      document.body.style.userSelect = ''
      if (d?.active) {
        const targetDate = d.over?.dataset.date
        d.over?.classList.remove('ring-2', 'ring-accent', 'ring-inset', 'bg-accent/5')
        if (targetDate && targetDate !== d.payload.fromDate) {
          // Manual moves are still allowed onto a blocked day — commit it (the move
          // itself offers Undo from the schedule page) and warn non-blockingly
          // instead of interrupting the drag with a native confirm.
          if (isDayBlocked(dayStatusRef.current, targetDate)) {
            const meta = dayStatusMeta(dayStatusRef.current!.byDate[targetDate]?.status || 'custom')
            const label = format(new Date(targetDate + 'T00:00:00'), 'EEE, MMM d')
            d.payload.commit(targetDate)
            toast(`Moved “${d.payload.title}” to ${label} — that day is marked ${meta.label}.`)
          } else {
            d.payload.commit(targetDate)
          }
        }
        justDragged.current = true
        setTimeout(() => { justDragged.current = false }, 0)
      }
      setDragging(false)
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
    return () => { window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up) }
  }, [dragEnabled])

  // Suppress the click that follows a drag (so dropping doesn't open the entry).
  const selectJob = (job: Job) => { if (justDragged.current) return; onSelectJob(job) }
  const selectItem = (item: ScheduleItem) => { if (justDragged.current) return; onSelectItem?.(item) }

  const ghost = dragEnabled ? (
    <div
      ref={ghostRef}
      className={cn(
        'fixed top-0 left-0 z-50 pointer-events-none px-2 py-1 rounded-lg bg-accent text-black text-xs font-semibold shadow-lg max-w-[180px] truncate',
        !dragging && 'hidden'
      )}
    />
  ) : null

  if (view === 'month') {
    return (
      <div className="rounded-card border border-border overflow-hidden">
        <div className="grid grid-cols-7 bg-bg-secondary border-b border-border">
          {weekdayLabels.map(d => (
            <div key={d} className="px-2 py-2 text-[11px] font-semibold text-ink-muted uppercase tracking-wide text-center">
              {d}
            </div>
          ))}
        </div>
        <div className="grid grid-cols-7">
          {monthDays.map((day, i) => {
            const dayJobs = dayJobsFor(day)
            const dayItems = dayItemsFor(day)
            const inMonth = isSameMonth(day, cursor)
            const today = isSameDay(day, new Date())
            const shownJobs = dayJobs.slice(0, 3)
            const shownItems = dayItems.slice(0, 2)
            const overflow = (dayJobs.length - shownJobs.length) + (dayItems.length - shownItems.length)
            const dateISO = format(day, 'yyyy-MM-dd')
            const statusRow = dayStatusMap?.byDate[dateISO]
            const selected = !!selectedDays?.has(dateISO)
            return (
              // div[role=button], not <button> — the cell CONTAINS chip/Done
              // buttons, and nested buttons are invalid markup that breaks AT.
              <div
                key={i}
                role="button"
                tabIndex={0}
                data-date={dateISO}
                {...dayHandlers(dateISO, day)}
                className={cn(
                  'min-h-[108px] border-b border-r border-border p-1.5 text-left align-top transition-colors hover:bg-surface rounded-sm relative cursor-pointer',
                  !inMonth && 'bg-bg-secondary/40',
                  statusRow && dayStatusMeta(statusRow.status).shade,
                  selected && 'ring-2 ring-accent ring-inset z-10',
                  (i + 1) % 7 === 0 && 'border-r-0'
                )}
              >
                <div className="flex items-center justify-between mb-1 gap-1">
                  <span className={cn(
                    'text-xs font-medium w-6 h-6 flex items-center justify-center rounded-full shrink-0',
                    today ? 'bg-accent text-black font-bold' : inMonth ? 'text-ink' : 'text-ink-faint'
                  )}>
                    {format(day, 'd')}
                  </span>
                  {statusRow && (
                    <span className={cn('min-w-0 text-[9px] leading-none px-1 py-0.5 rounded border font-semibold inline-flex items-center gap-0.5', dayStatusMeta(statusRow.status).badge)} title={dayStatusLabel(statusRow)}>
                      <span className="shrink-0">{dayStatusMeta(statusRow.status).emoji}</span>
                      <span className="truncate">{dayStatusLabel(statusRow)}</span>
                    </span>
                  )}
                </div>
                <div className="space-y-0.5">
                  {shownJobs.map(job => (
                    <JobChip key={job.id} job={job} onSelect={selectJob} onDragStart={jobDragStart ? (e) => jobDragStart(e, job) : undefined} recurLabel={recurLabelFor(job)} value={valueByJobId?.[job.id]} addonCount={addonCountByJobId?.[job.id]} onMarkDone={onMarkDone} />
                  ))}
                  {shownItems.map(item => (
                    <ItemChip key={item.id} item={item} onSelect={selectItem} onDragStart={itemDragStart ? (e) => itemDragStart(e, item) : undefined} />
                  ))}
                  {overflow > 0 && (
                    <span className="block text-[10px] font-medium text-ink-faint px-1 pt-0.5">+{overflow} more</span>
                  )}
                </div>
              </div>
            )
          })}
        </div>
        {ghost}
      </div>
    )
  }

  if (view === 'week') {
    return (
      <div className="rounded-card border border-border overflow-hidden">
        <div className="grid grid-cols-7">
          {weekDays.map((day, i) => {
            const dayJobs = dayJobsFor(day)
            const dayItems = dayItemsFor(day)
            const today = isSameDay(day, new Date())
            const dateISO = format(day, 'yyyy-MM-dd')
            const statusRow = dayStatusMap?.byDate[dateISO]
            const selected = !!selectedDays?.has(dateISO)
            return (
              // div[role=button] — the cell contains chip/Done buttons (see month grid).
              <div
                key={i}
                role="button"
                tabIndex={0}
                data-date={dateISO}
                {...dayHandlers(dateISO, day)}
                className={cn(
                  'min-h-[320px] border-r border-border p-2 text-left align-top transition-colors hover:bg-surface cursor-pointer',
                  statusRow && dayStatusMeta(statusRow.status).shade,
                  selected && 'ring-2 ring-accent ring-inset z-10',
                  i === 6 && 'border-r-0'
                )}
              >
                <div className="text-center mb-2 pb-2 border-b border-border">
                  <p className="text-[11px] font-semibold text-ink-muted uppercase">{weekdayLabels[day.getDay()]}</p>
                  <p className={cn(
                    'text-sm font-bold mt-0.5 w-7 h-7 mx-auto flex items-center justify-center rounded-full',
                    today ? 'bg-accent text-black' : 'text-ink'
                  )}>
                    {format(day, 'd')}
                  </p>
                  {statusRow && (
                    <span className={cn('mt-1 max-w-full text-[10px] px-1.5 py-0.5 rounded border font-semibold inline-flex items-center gap-1', dayStatusMeta(statusRow.status).badge)} title={dayStatusLabel(statusRow)}>
                      <span className="shrink-0">{dayStatusMeta(statusRow.status).emoji}</span>
                      <span className="truncate">{dayStatusLabel(statusRow)}</span>
                    </span>
                  )}
                </div>
                <div className="space-y-1">
                  {dayJobs.map(job => (
                    <JobChip key={job.id} job={job} onSelect={selectJob} onDragStart={jobDragStart ? (e) => jobDragStart(e, job) : undefined} recurLabel={recurLabelFor(job)} value={valueByJobId?.[job.id]} addonCount={addonCountByJobId?.[job.id]} onMarkDone={onMarkDone} />
                  ))}
                  {dayItems.map(item => (
                    <ItemChip key={item.id} item={item} onSelect={selectItem} onDragStart={itemDragStart ? (e) => itemDragStart(e, item) : undefined} />
                  ))}
                </div>
              </div>
            )
          })}
        </div>
        {ghost}
      </div>
    )
  }

  // 'day' is rendered by DayOpsPanel (the schedule page never mounts Calendar for
  // it) — the old divergent fallback day view here is gone, ONE day surface.
  return null
}
