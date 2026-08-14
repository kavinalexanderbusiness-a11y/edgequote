'use client'

// ── Stop for today ───────────────────────────────────────────────────────────
//
// ⭐⭐ THE ONE THING THIS SCREEN MUST NEVER DO IS COMPLETE THE JOB. Everything
// about it is shaped by that: the word "Complete" does not appear on it, the
// primary button says exactly what it does, and the copy states what stays true
// (nothing is billed, the customer is not told anything). "Stop" secretly
// meaning "done" would draft an invoice and text a customer that work is
// finished when the crew is coming back on Thursday.
//
// ⭐ SMALL ON PURPOSE. This gets tapped standing on a driveway in the rain, so
// there are three decisions and only one of them is required: when you're back
// (chips, one tap), how many people were here (pre-filled from the crew size, and
// hidden entirely for a solo operator, who has nothing to answer), and a note
// (collapsed until asked for). The minutes are NOT a decision — they came off
// the clock and are shown as a fact, correctable afterwards in the job's work
// history rather than in the way now.
//
// ⚠️ NOT SCHEDULED YET is a real, offered answer. Defaulting to "tomorrow" would
// put work on a day nobody agreed to and quietly fill a day the calendar thinks
// is free; the job simply stays where it is and reads as unfinished.

import { useState } from 'react'
import { CalendarDays, PauseCircle } from 'lucide-react'
import { Modal } from '@/components/ui/Modal'
import { Button } from '@/components/ui/Button'
import { Input } from '@/components/ui/Input'
import { cn } from '@/lib/utils'
import { formatWorked } from '@/lib/workDuration'
import { WORK_SESSION_NOTE_MAX, type StopForTodayInput } from '@/lib/workSession'

function addDays(iso: string, n: number): string {
  const d = new Date(iso + 'T00:00:00')
  d.setDate(d.getDate() + n)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

function localToday(): string {
  const d = new Date()
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

export default function StopForTodaySheet({
  open, onClose, onStop, jobTitle, crewSize, runningSince, busy,
}: {
  open: boolean
  onClose: () => void
  onStop: (input: StopForTodayInput) => void | Promise<void>
  jobTitle: string
  crewSize: number | null
  /** jobs.started_at — the clock about to be banked. null when the job was
   *  already paused, in which case nothing is banked and the sheet says so. */
  runningSince: string | null
  busy?: boolean
}) {
  const today = localToday()
  const [nextDate, setNextDate] = useState<string | null>(addDays(today, 1))
  const [picking, setPicking] = useState(false)
  const [workers, setWorkers] = useState(String(crewSize || 1))
  const [note, setNote] = useState('')
  const [showNote, setShowNote] = useState(false)

  // Rounded down to the minute the same way the database's own cast does, so the
  // figure on this sheet is the figure that lands in the record.
  const bankedMin = runningSince
    ? Math.max(1, Math.floor((Date.now() - Date.parse(runningSince)) / 60_000))
    : null

  const chips: { key: string; label: string; date: string | null }[] = [
    { key: 'tomorrow', label: 'Tomorrow', date: addDays(today, 1) },
    { key: 'pick', label: 'Pick a day', date: null },
    { key: 'later', label: 'Not yet', date: null },
  ]

  function chooseChip(key: string, date: string | null) {
    if (key === 'pick') { setPicking(true); setNextDate(addDays(today, 1)); return }
    setPicking(false)
    setNextDate(date)
  }

  const activeChip = picking ? 'pick' : nextDate === addDays(today, 1) ? 'tomorrow' : nextDate === null ? 'later' : 'pick'

  return (
    <Modal open={open} onClose={onClose} size="sm" icon={PauseCircle}
      title="Stop for today"
      onSubmit={() => { if (!busy) void onStop({ nextDate, workers: Number(workers) || 1, note }) }}
      footer={
        <div className="flex gap-2">
          <Button type="button" variant="ghost" onClick={onClose} disabled={busy}>Cancel</Button>
          <Button type="button" className="flex-1" disabled={busy}
            onClick={() => void onStop({ nextDate, workers: Number(workers) || 1, note })}>
            {busy ? 'Saving…' : 'Stop for today'}
          </Button>
        </div>
      }>
      <div className="space-y-4">
        <div>
          <p className="text-sm text-ink">{jobTitle}</p>
          {bankedMin != null ? (
            <p className="text-2xl font-semibold text-ink tabular-nums mt-1">{formatWorked(bankedMin)}</p>
          ) : (
            <p className="text-sm text-ink-muted mt-1">No timer running — nothing new will be recorded.</p>
          )}
          {/* Says the two things the owner is actually worried about. */}
          <p className="text-xs text-ink-faint mt-1">
            {bankedMin != null ? 'Recorded against this job. ' : ''}
            The job stays in progress — nothing is invoiced and the customer isn’t told anything.
          </p>
        </div>

        <div className="space-y-2">
          <p className="text-xs font-semibold text-ink-muted uppercase tracking-wide flex items-center gap-1.5">
            <CalendarDays className="w-3.5 h-3.5" /> Back on it
          </p>
          <div className="flex gap-2">
            {chips.map(c => (
              <button key={c.key} type="button" onClick={() => chooseChip(c.key, c.date)}
                className={cn(
                  'tap-target flex-1 rounded-lg border px-2 py-2 text-xs font-medium transition-colors',
                  activeChip === c.key
                    ? 'border-accent bg-accent/10 text-accent-text'
                    : 'border-border-strong text-ink-muted hover:text-ink',
                )}>
                {c.label}
              </button>
            ))}
          </div>
          {picking && (
            <Input type="date" fieldSize="sm" min={today} value={nextDate ?? ''}
              onChange={e => setNextDate(e.target.value || null)} />
          )}
          {nextDate === null && !picking && (
            <p className="text-xs text-ink-faint">It stays on today’s list as unfinished until you give it a day.</p>
          )}
        </div>

        {/* A solo operator has nothing to answer here, so they are not asked. */}
        {(crewSize ?? 1) > 1 && (
          <Input label="People on it today" type="number" min="1" max="50" fieldSize="sm"
            hint="Sets the labour hours for today — the time on site doesn’t change."
            value={workers} onChange={e => setWorkers(e.target.value)} />
        )}

        {showNote ? (
          <Input label="Why it stopped (optional)" fieldSize="sm" maxLength={WORK_SESSION_NOTE_MAX}
            placeholder="Waiting on the part · ran out of daylight"
            value={note} onChange={e => setNote(e.target.value)} />
        ) : (
          <button type="button" onClick={() => setShowNote(true)}
            className="text-xs font-medium text-accent-text hover:underline">
            + Add a note
          </button>
        )}

      </div>
    </Modal>
  )
}
