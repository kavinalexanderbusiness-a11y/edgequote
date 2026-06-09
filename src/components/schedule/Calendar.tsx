'use client'

import { useMemo, useRef, useState, useEffect } from 'react'
import {
  startOfMonth, endOfMonth, startOfWeek, endOfWeek, eachDayOfInterval,
  format, isSameMonth, isSameDay, addDays,
} from 'date-fns'
import { Job, JOB_STATUS_COLORS, JOB_STATUS_LABELS } from '@/types'
import { cn } from '@/lib/utils'
import { Repeat, Check, CheckCircle2, Plus } from 'lucide-react'

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
}

function JobChip({ job, onSelect, onDragStart, recurLabel }: { job: Job; onSelect: (j: Job) => void; onDragStart?: (e: React.PointerEvent, job: Job) => void; recurLabel?: string }) {
  return (
    <button
      onClick={(e) => { e.stopPropagation(); onSelect(job) }}
      onPointerDown={onDragStart ? (e) => onDragStart(e, job) : undefined}
      style={onDragStart ? { touchAction: 'none' } : undefined}
      className={cn(
        'w-full text-left px-1.5 py-0.5 rounded text-[11px] font-medium border truncate transition-opacity hover:opacity-80',
        JOB_STATUS_COLORS[job.status]
      )}
      title={recurLabel ? `${job.title} · ${recurLabel} (recurring)` : job.title}
    >
      <span className="flex items-center gap-0.5">
        {job.status === 'completed' && <Check className="w-2.5 h-2.5 shrink-0" />}
        {job.recurrence_id && <Repeat className="w-2.5 h-2.5 shrink-0 opacity-70" />}
        <span className={cn('truncate', job.status === 'completed' && 'line-through opacity-80')}>{job.start_time ? job.start_time.slice(0, 5) + ' ' : ''}{job.title}</span>
      </span>
    </button>
  )
}

export function Calendar({ view, cursor, jobs, onSelectDay, onSelectJob, onMarkDone, onMoveJob, recurrenceLabels }: CalendarProps) {
  const recurLabelFor = (job: Job) => job.recurrence_id ? recurrenceLabels?.[job.recurrence_id] : undefined
  const weekdayLabels = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']

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

  // ── P1: true pointer drag-and-drop across days ───────────────────────────────
  // The ghost + drop-target highlight are driven imperatively (refs + classList)
  // so a drag doesn't re-render the whole grid on every pointer move.
  const ghostRef = useRef<HTMLDivElement>(null)
  const dragRef = useRef<{ job: Job; startX: number; startY: number; active: boolean; over: HTMLElement | null } | null>(null)
  const justDragged = useRef(false)
  const [dragging, setDragging] = useState(false)

  function startDrag(e: React.PointerEvent, job: Job) {
    if (!onMoveJob) return
    dragRef.current = { job, startX: e.clientX, startY: e.clientY, active: false, over: null }
  }

  useEffect(() => {
    if (!onMoveJob) return
    function setOver(el: HTMLElement | null) {
      const d = dragRef.current; if (!d) return
      if (d.over === el) return
      d.over?.classList.remove('ring-2', 'ring-accent', 'ring-inset', 'bg-accent/5')
      if (el && el.dataset.date !== d.job.scheduled_date) el.classList.add('ring-2', 'ring-accent', 'ring-inset', 'bg-accent/5')
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
        ghostRef.current.textContent = d.job.title
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
        if (targetDate && targetDate !== d.job.scheduled_date) onMoveJob!(d.job, targetDate)
        justDragged.current = true
        setTimeout(() => { justDragged.current = false }, 0)
      }
      setDragging(false)
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
    return () => { window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up) }
  }, [onMoveJob])

  // Suppress the click that follows a drag (so dropping doesn't open the job).
  const selectJob = (job: Job) => { if (justDragged.current) return; onSelectJob(job) }

  const ghost = onMoveJob ? (
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
            const inMonth = isSameMonth(day, cursor)
            const today = isSameDay(day, new Date())
            return (
              <button
                key={i}
                data-date={format(day, 'yyyy-MM-dd')}
                onClick={() => onSelectDay(day)}
                className={cn(
                  'min-h-[96px] border-b border-r border-border p-1.5 text-left align-top transition-colors hover:bg-surface rounded-sm',
                  !inMonth && 'bg-bg-secondary/40',
                  (i + 1) % 7 === 0 && 'border-r-0'
                )}
              >
                <div className="flex items-center justify-between mb-1">
                  <span className={cn(
                    'text-xs font-medium w-6 h-6 flex items-center justify-center rounded-full',
                    today ? 'bg-accent text-black font-bold' : inMonth ? 'text-ink' : 'text-ink-faint'
                  )}>
                    {format(day, 'd')}
                  </span>
                </div>
                <div className="space-y-0.5">
                  {dayJobs.slice(0, 3).map(job => (
                    <JobChip key={job.id} job={job} onSelect={selectJob} onDragStart={onMoveJob ? startDrag : undefined} recurLabel={recurLabelFor(job)} />
                  ))}
                  {dayJobs.length > 3 && (
                    <span className="text-[10px] text-ink-faint px-1">+{dayJobs.length - 3} more</span>
                  )}
                </div>
              </button>
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
            const today = isSameDay(day, new Date())
            return (
              <button
                key={i}
                data-date={format(day, 'yyyy-MM-dd')}
                onClick={() => onSelectDay(day)}
                className={cn(
                  'min-h-[320px] border-r border-border p-2 text-left align-top transition-colors hover:bg-surface',
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
                </div>
                <div className="space-y-1">
                  {dayJobs.map(job => (
                    <JobChip key={job.id} job={job} onSelect={selectJob} onDragStart={onMoveJob ? startDrag : undefined} recurLabel={recurLabelFor(job)} />
                  ))}
                </div>
              </button>
            )
          })}
        </div>
        {ghost}
      </div>
    )
  }

  // Day view
  const dayJobs = dayJobsFor(cursor)
  const totalMin = dayJobs.reduce((s, j) => s + (j.duration_minutes || 0), 0)
  const estHours = Math.round((totalMin / 60) * 10) / 10
  const doneCount = dayJobs.filter(j => j.status === 'completed').length
  const locatedCount = dayJobs.filter(j => j.properties?.lat != null && j.properties?.lng != null).length
  return (
    <div className="rounded-card border border-border p-4">
      <div className="mb-3 flex items-start justify-between gap-3">
        <div>
          <p className="text-sm font-bold text-ink">{format(cursor, 'EEEE, MMMM d, yyyy')}</p>
          {/* Daily operations summary — plan the day at a glance */}
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1 mt-1 text-xs text-ink-muted">
            <span className="font-semibold text-ink">{dayJobs.length} job{dayJobs.length !== 1 ? 's' : ''}</span>
            {doneCount > 0 && <span className="text-emerald-400">{doneCount} done</span>}
            {totalMin > 0 && <span>~{estHours}h on site</span>}
            {locatedCount > 0 && <span>{locatedCount} mapped stop{locatedCount !== 1 ? 's' : ''}</span>}
          </div>
        </div>
        <button
          onClick={() => onSelectDay(cursor)}
          className="shrink-0 h-9 px-3 rounded-lg bg-accent text-black text-xs font-semibold flex items-center gap-1 hover:opacity-90 active:scale-95 transition-transform"
        >
          <Plus className="w-4 h-4" /> Add job
        </button>
      </div>
      {dayJobs.length === 0 ? (
        <button
          onClick={() => onSelectDay(cursor)}
          className="w-full text-center py-12 text-sm text-ink-muted hover:text-ink transition-colors"
        >
          No jobs scheduled. Click to add one.
        </button>
      ) : (
        <div className="space-y-2">
          {dayJobs.map(job => (
            <div
              key={job.id}
              onClick={() => onSelectJob(job)}
              className={cn(
                'w-full text-left px-3 py-2.5 rounded-xl border transition-opacity hover:opacity-90 cursor-pointer',
                JOB_STATUS_COLORS[job.status]
              )}
            >
              <div className="flex items-center justify-between gap-2">
                <span className="flex items-center gap-1.5 text-sm font-semibold min-w-0">
                  {job.status === 'completed' && <CheckCircle2 className="w-3.5 h-3.5 shrink-0" />}
                  {job.recurrence_id && <Repeat className="w-3 h-3 shrink-0 opacity-70" />}
                  <span className={cn('truncate', job.status === 'completed' && 'line-through opacity-80')}>{job.title}</span>
                </span>
                {job.start_time && (
                  <span className="text-xs shrink-0">{job.start_time.slice(0, 5)}{job.end_time ? `–${job.end_time.slice(0, 5)}` : ''}</span>
                )}
              </div>
              <div className="flex items-center justify-between gap-2 mt-1">
                <div className="flex items-center gap-1.5 text-xs opacity-80 min-w-0 flex-wrap">
                  {job.customers?.name && <span className="truncate">{job.customers.name}</span>}
                  {job.service_type && <span className="truncate">· {job.service_type}</span>}
                  <span className="px-1.5 py-0.5 rounded border border-current/30 text-[10px] font-semibold uppercase tracking-wide">{JOB_STATUS_LABELS[job.status]}</span>
                  {recurLabelFor(job) && <span className="text-[10px]">· {recurLabelFor(job)}</span>}
                </div>
                {onMarkDone && job.status !== 'completed' && job.status !== 'cancelled' && (
                  <button
                    onClick={(e) => { e.stopPropagation(); onMarkDone(job) }}
                    className="shrink-0 h-9 px-3 rounded-lg bg-emerald-500/15 border border-emerald-500/30 text-emerald-300 text-xs font-semibold flex items-center gap-1 hover:bg-emerald-500/25 active:scale-95 transition-transform"
                  >
                    <Check className="w-4 h-4" /> Done
                  </button>
                )}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}