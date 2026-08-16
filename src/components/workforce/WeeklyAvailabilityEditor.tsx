'use client'

import { useEffect, useState } from 'react'
import type { WorkerAvailability } from '@/types'
import { WEEKDAY_LABELS, DEFAULT_WORK_WINDOW, patternWindowMinutes } from '@/lib/workerAvailability'
import { Toggle } from '@/components/ui/Toggle'
import { Input } from '@/components/ui/Input'
import { Banner } from '@/components/ui/Banner'
import { CalendarClock, Info } from 'lucide-react'

// ── One person's standard week ───────────────────────────────────────────────
// The SAME control the owner uses on a team member and the worker uses on
// themselves — one component, two callers, so the two can never drift into
// disagreeing about what a week means or what "unavailable" looks like.
//
// It is deliberately seven rows and nothing more. A shift engine (rotations,
// alternating weeks, split shifts) is the thing this is designed NOT to be: the
// business asking for it is asking a scheduling question, and the honest answer
// for those days is a dated exception — time off — not a richer pattern.
//
// SAVING IS PER DAY, and each row reports its own state. That matters on a
// phone: a worker toggling Wednesday off on a bus should not have the other six
// days riding on the same request. `onSave` returns whether the write landed;
// a false keeps the row's previous value on screen rather than showing an edit
// that did not persist (the uncontrolled-input bug EmployeeEditor was built to
// end — see components/workforce/EmployeeEditor.tsx).

export interface WeeklyAvailabilityEditorProps {
  /** Existing rows for ONE worker. Empty = no pattern recorded yet. */
  rows: WorkerAvailability[]
  /** Persist one weekday. Return true when the database agreed. */
  onSave: (weekday: number, available: boolean, start: string | null, end: string | null) => Promise<boolean>
  /** Read-only rendering (a manager glancing at someone else's week). */
  disabled?: boolean
  /** Whose week this is, for the assumption banner's wording. */
  subject?: 'self' | 'worker'
}

interface RowState { available: boolean; start: string; end: string }

const hhmm = (t: string | null | undefined, fallback: string) =>
  t ? t.slice(0, 5) : fallback

function seed(rows: WorkerAvailability[]): RowState[] {
  return WEEKDAY_LABELS.map((_, wd) => {
    const row = rows.find(r => r.weekday === wd)
    return {
      available: !!row?.available,
      start: hhmm(row?.start_time, DEFAULT_WORK_WINDOW.start),
      end: hhmm(row?.end_time, DEFAULT_WORK_WINDOW.end),
    }
  })
}

export function WeeklyAvailabilityEditor({ rows, onSave, disabled, subject = 'worker' }: WeeklyAvailabilityEditorProps) {
  const [state, setState] = useState<RowState[]>(() => seed(rows))
  const [busy, setBusy] = useState<number | null>(null)
  const [error, setError] = useState<string | null>(null)

  // Re-seed when a different person's rows arrive. Keyed on the ROW CONTENT so a
  // background refetch of the same week cannot interrupt an edit in progress.
  const key = rows.map(r => `${r.technician_id}:${r.weekday}:${r.available}:${r.start_time}:${r.end_time}`).join('|')
  useEffect(() => { setState(seed(rows)); setError(null)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key])

  const recorded = rows.length > 0

  async function commit(wd: number, next: RowState) {
    if (disabled) return
    const prev = state[wd]
    setState(s => s.map((r, i) => (i === wd ? next : r)))
    setBusy(wd); setError(null)
    const ok = await onSave(
      wd, next.available,
      next.available ? next.start : null,
      next.available ? next.end : null,
    )
    setBusy(null)
    if (!ok) {
      // The write did not land — put the row back rather than leaving an edit
      // on screen that the database never accepted.
      setState(s => s.map((r, i) => (i === wd ? prev : r)))
      setError('That didn’t save. Check your connection and try again.')
    }
  }

  return (
    <div className="space-y-3">
      {!recorded && (
        <Banner tone="info" icon={Info}>
          {subject === 'self'
            ? 'You don’t have working days set yet, so the office assumes you’re available any day. Set your week and the schedule will plan around it.'
            : 'No working days set, so this person is assumed available any day. That assumption is shown wherever the schedule counts on them.'}
        </Banner>
      )}

      {error && <Banner tone="danger">{error}</Banner>}

      <ul className="rounded-card border border-border bg-bg-secondary divide-y divide-border">
        {WEEKDAY_LABELS.map((label, wd) => {
          const row = state[wd]
          const window = row.available ? patternWindowMinutes({ start_time: row.start, end_time: row.end }) : null
          const badWindow = row.available && window == null
          return (
            <li key={wd} className="px-3.5 py-3">
              {/* Wraps to one column on a phone: the toggle and the two time
                  fields each keep a full-width tap target rather than being
                  squeezed onto one 375px line. */}
              <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
                <div className="flex items-center gap-3 min-w-0 flex-1">
                  <CalendarClock className="w-4 h-4 shrink-0 text-ink-faint" aria-hidden />
                  <span className="text-sm font-medium text-ink w-24 shrink-0">{label}</span>
                  <Toggle
                    checked={row.available}
                    disabled={disabled || busy === wd}
                    onChange={v => commit(wd, { ...row, available: v })}
                    label={row.available ? 'Working' : 'Not working'}
                  />
                </div>

                {row.available && (
                  <div className="flex items-center gap-2 w-full sm:w-auto">
                    <Input
                      type="time" fieldSize="sm" aria-label={`${label} start`}
                      value={row.start} disabled={disabled || busy === wd}
                      onChange={e => setState(s => s.map((r, i) => (i === wd ? { ...r, start: e.target.value } : r)))}
                      onBlur={() => { if (!badWindow) commit(wd, row) }}
                      className="flex-1 sm:w-28"
                    />
                    <span className="text-xs text-ink-faint">to</span>
                    <Input
                      type="time" fieldSize="sm" aria-label={`${label} end`}
                      value={row.end} disabled={disabled || busy === wd}
                      onChange={e => setState(s => s.map((r, i) => (i === wd ? { ...r, end: e.target.value } : r)))}
                      onBlur={() => { if (!badWindow) commit(wd, row) }}
                      className="flex-1 sm:w-28"
                    />
                  </div>
                )}
              </div>
              {badWindow && (
                <p className="mt-1.5 text-[11px] text-red-400">
                  The finish time has to be after the start time — this day isn’t saved yet.
                </p>
              )}
            </li>
          )
        })}
      </ul>

      <p className="text-[11px] text-ink-faint">
        This is the standard week. A one-off day away is time off, not a change here — so changing
        a Monday now never rewrites the Mondays already worked.
      </p>
    </div>
  )
}
