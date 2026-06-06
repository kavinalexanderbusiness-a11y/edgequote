'use client'

import { useMemo } from 'react'
import {
  startOfMonth, endOfMonth, startOfWeek, endOfWeek, eachDayOfInterval,
  format, isSameMonth, isSameDay, addDays, parseISO,
} from 'date-fns'
import { Job, JOB_STATUS_COLORS } from '@/types'
import { cn } from '@/lib/utils'

export type CalendarView = 'month' | 'week' | 'day'

interface CalendarProps {
  view: CalendarView
  cursor: Date
  jobs: Job[]
  onSelectDay: (date: Date) => void
  onSelectJob: (job: Job) => void
  movingJobId?: string | null
}

function jobsOnDay(jobs: Job[], day: Date): Job[] {
  return jobs
    .filter(j => isSameDay(parseISO(j.scheduled_date), day))
    .sort((a, b) => (a.start_time || '').localeCompare(b.start_time || ''))
}

function JobChip({ job, onSelect, isMoving }: { job: Job; onSelect: (j: Job) => void; isMoving?: boolean }) {
  return (
    <button
      onClick={(e) => { e.stopPropagation(); onSelect(job) }}
      className={cn(
        'w-full text-left px-1.5 py-0.5 rounded text-[11px] font-medium border truncate transition-opacity hover:opacity-80',
        JOB_STATUS_COLORS[job.status],
        isMoving && 'ring-2 ring-accent ring-offset-1 ring-offset-bg opacity-60'
      )}
      title={job.title}
    >
      {job.start_time ? job.start_time.slice(0, 5) + ' ' : ''}{job.title}
    </button>
  )
}

export function Calendar({ view, cursor, jobs, onSelectDay, onSelectJob, movingJobId }: CalendarProps) {
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
            const dayJobs = jobsOnDay(jobs, day)
            const inMonth = isSameMonth(day, cursor)
            const today = isSameDay(day, new Date())
            return (
              <button
                key={i}
                onClick={() => onSelectDay(day)}
                className={cn(
                  'min-h-[96px] border-b border-r border-border p-1.5 text-left align-top transition-colors hover:bg-surface',
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
                    <JobChip key={job.id} job={job} onSelect={onSelectJob} isMoving={job.id === movingJobId} />
                  ))}
                  {dayJobs.length > 3 && (
                    <span className="text-[10px] text-ink-faint px-1">+{dayJobs.length - 3} more</span>
                  )}
                </div>
              </button>
            )
          })}
        </div>
      </div>
    )
  }

  if (view === 'week') {
    return (
      <div className="rounded-card border border-border overflow-hidden">
        <div className="grid grid-cols-7">
          {weekDays.map((day, i) => {
            const dayJobs = jobsOnDay(jobs, day)
            const today = isSameDay(day, new Date())
            return (
              <button
                key={i}
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
                    <JobChip key={job.id} job={job} onSelect={onSelectJob} />
                  ))}
                </div>
              </button>
            )
          })}
        </div>
      </div>
    )
  }

  // Day view
  const dayJobs = jobsOnDay(jobs, cursor)
  return (
    <div className="rounded-card border border-border p-4">
      <div className="mb-3">
        <p className="text-sm font-bold text-ink">{format(cursor, 'EEEE, MMMM d, yyyy')}</p>
        <p className="text-xs text-ink-muted">{dayJobs.length} job{dayJobs.length !== 1 ? 's' : ''} scheduled</p>
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
            <button
              key={job.id}
              onClick={() => onSelectJob(job)}
              className={cn(
                'w-full text-left px-3 py-2.5 rounded-xl border transition-opacity hover:opacity-80',
                JOB_STATUS_COLORS[job.status],
                job.id === movingJobId && 'ring-2 ring-accent ring-offset-1 ring-offset-bg opacity-60'
              )}
            >
              <div className="flex items-center justify-between">
                <span className="text-sm font-semibold">{job.title}</span>
                {job.start_time && (
                  <span className="text-xs">{job.start_time.slice(0, 5)}{job.end_time ? `–${job.end_time.slice(0, 5)}` : ''}</span>
                )}
              </div>
              {job.customers?.name && (
                <p className="text-xs opacity-80 mt-0.5">{job.customers.name}</p>
              )}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}