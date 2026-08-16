'use client'

import { useMemo } from 'react'
import { addDays, format } from 'date-fns'
import type { PtoEntry, Technician, WorkerAvailability } from '@/types'
import {
  workerDayStates, WORKER_DAY_STATE_LABELS, canWork, isBookedOff,
  type WorkerDayDetail,
} from '@/lib/workerAvailability'
import { Card, CardBody } from '@/components/ui/Card'
import { CalendarRange, HelpCircle } from 'lucide-react'
import { cn } from '@/lib/utils'

// ── "Who works Tuesday?" — the week, answered ────────────────────────────────
// The owner's question is not "how many technicians do I have", it is "when I
// plan Tuesday, who is actually there". This renders the next seven days from
// the SAME engine the day board's warnings use (lib/workerAvailability), so the
// number here and the warning there cannot disagree.
//
// UNKNOWN STAYS UNKNOWN. `states` is null when the availability read failed —
// this renders that as "couldn't be read", never as a staffed week. A worker
// with no recorded pattern renders as ASSUMED, in its own muted tone, because
// "probably there" and "said they'd be there" are different facts.

export interface TeamAvailabilityWeekProps {
  technicians: Technician[]
  /** All pattern rows for the business. Empty = nobody has set a week. */
  patterns: WorkerAvailability[]
  /** Time off. Only APPROVED rows subtract anyone — filtered here, once. */
  ptoEntries: PtoEntry[]
  /** null = the read failed; the panel says so rather than showing a full week. */
  readable?: boolean
  capacityHours?: number | null
  days?: number
}

export function TeamAvailabilityWeek({
  technicians, patterns, ptoEntries, readable = true, capacityHours, days = 7,
}: TeamAvailabilityWeekProps) {
  const week = useMemo(() => {
    const approved = ptoEntries.filter(isBookedOff)
    return Array.from({ length: days }, (_, i) => {
      const date = addDays(new Date(), i)
      const iso = format(date, 'yyyy-MM-dd')
      return {
        iso,
        date,
        states: workerDayStates(iso, technicians, patterns, approved, { capacityHours }),
      }
    })
  }, [technicians, patterns, ptoEntries, capacityHours, days])

  const anyPattern = patterns.length > 0

  return (
    <Card>
      <CardBody className="p-0">
        <div className="px-5 py-3 border-b border-border flex items-center justify-between gap-3">
          <div className="min-w-0">
            <h2 className="text-sm font-semibold text-ink">Who works when</h2>
            <p className="text-[11px] text-ink-faint">
              {anyPattern
                ? 'The next 7 days, from each person’s working days and their time off.'
                : 'Nobody has working days set yet — everyone is assumed available.'}
            </p>
          </div>
          <CalendarRange className="w-4 h-4 shrink-0 text-ink-faint" aria-hidden />
        </div>

        {!readable ? (
          <div className="px-5 py-6 flex items-start gap-3">
            <HelpCircle className="w-4 h-4 shrink-0 text-ink-faint mt-0.5" aria-hidden />
            <p className="text-sm text-ink-muted">
              Availability couldn’t be read, so who’s working isn’t known right now. This is not the
              same as nobody being available — reload to try again.
            </p>
          </div>
        ) : (
          // Scrolls horizontally on a phone rather than crushing seven columns
          // into 375px; the page itself never scrolls sideways.
          <div className="overflow-x-auto">
            <div className="flex min-w-max divide-x divide-border">
              {week.map(d => <DayColumn key={d.iso} date={d.date} states={d.states} />)}
            </div>
          </div>
        )}
      </CardBody>
    </Card>
  )
}

function DayColumn({ date, states }: { date: Date; states: WorkerDayDetail[] }) {
  const ready = states.filter(canWork)
  const assumed = ready.filter(w => w.state === 'assumed').length
  const away = states.filter(w => !canWork(w))

  return (
    <div className="w-40 shrink-0 px-3.5 py-3">
      <p className="text-[11px] font-semibold text-ink">{format(date, 'EEE')}</p>
      <p className="text-[11px] text-ink-faint tabular-nums">{format(date, 'MMM d')}</p>

      <p className={cn('mt-2 text-lg font-bold tabular-nums',
        ready.length === 0 ? 'text-red-400' : 'text-ink')}>
        {ready.length}
      </p>
      <p className="text-[11px] text-ink-faint">
        {ready.length === 1 ? 'person available' : 'people available'}
        {assumed > 0 && ready.length > 0 && (
          <span className="block text-ink-faint/80">{assumed} assumed</span>
        )}
      </p>

      {away.length > 0 && (
        <ul className="mt-2 space-y-1">
          {away.map(w => (
            <li key={w.technicianId} className="text-[11px] text-ink-faint truncate"
              title={`${w.name ?? 'Someone'} — ${WORKER_DAY_STATE_LABELS[w.state]}`}>
              <span className={cn('inline-block w-1.5 h-1.5 rounded-full mr-1.5 align-middle',
                w.state === 'off' ? 'bg-violet-400' : 'bg-border')} />
              {w.name ?? 'Someone'}
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
