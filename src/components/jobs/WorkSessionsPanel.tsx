'use client'

// ── The work history of one job ──────────────────────────────────────────────
//
// Every day this job was worked, what it took, and how many people were on it —
// plus the door to add a day by hand for a business that never presses Start.
//
// ⭐ THE TOTAL IS NOT COMPUTED HERE. `jobs.actual_minutes` is the sum of these
// rows by database rule, so this panel never adds anything up and writes it
// back; it renders the parts and lets the database keep the whole. That is why
// there is no "recalculate" button and no way for this screen to disagree with
// the number the rest of the app shows.
//
// ⚠️ A FAILED READ IS NOT AN EMPTY HISTORY. `load.failed` is checked before any
// "no work recorded yet" copy — otherwise a dropped connection tells the owner
// their crew did nothing, which is the [portal-redesign] defect exactly.
//
// ⚠️ EVERY BUTTON IS type="button". This renders inside JobForm's <form>, where
// a bare <button> submits the visit. `Button` already defaults to type="button";
// the raw <button>s below state it.

import { useCallback, useEffect, useState } from 'react'
import { CalendarDays, Pencil, Plus, Trash2, Users } from 'lucide-react'
import { createClient } from '@/lib/supabase/client'
import { toast } from '@/lib/toast'
import { confirm } from '@/lib/confirm'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/Button'
import { Input } from '@/components/ui/Input'
import type { WorkSession } from '@/types'
import {
  deleteWorkSession, describeLabour, loadWorkSessions, logWorkSession,
  restoreWorkSession, sessionTotals, updateWorkSession, WORK_SESSION_NOTE_MAX,
} from '@/lib/workSession'
import { DurationUnit, formatWorked, toMinutes } from '@/lib/workDuration'

/** Today in the BROWSER's timezone. The database does not know the business's
 *  timezone and must not guess it — the local date is the business's own day. */
function localToday(): string {
  const d = new Date()
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

function dayLabel(iso: string): string {
  const d = new Date(iso + 'T00:00:00')
  if (Number.isNaN(d.getTime())) return iso
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
}

export default function WorkSessionsPanel({
  job, onTotalChange, className,
}: {
  job: { id: string; user_id: string; crew_size: number | null }
  /** The job's new total after any write, straight from the database — so the
   *  form's own "actual" reading follows without recomputing it. */
  onTotalChange?: (actualMinutes: number | null) => void
  className?: string
}) {
  const supabase = createClient()
  const [sessions, setSessions] = useState<WorkSession[]>([])
  const [loading, setLoading] = useState(true)
  const [failed, setFailed] = useState(false)
  const [adding, setAdding] = useState(false)
  const [editing, setEditing] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  // The add/edit form, small enough to live in one state object.
  const [day, setDay] = useState(localToday())
  const [amount, setAmount] = useState('')
  const [unit, setUnit] = useState<DurationUnit>('hours')
  const [workers, setWorkers] = useState(String(job.crew_size || 1))
  const [note, setNote] = useState('')

  const refresh = useCallback(async () => {
    const res = await loadWorkSessions(supabase, job.id)
    setSessions(res.sessions)
    setFailed(res.failed)
    setLoading(false)
  }, [supabase, job.id])

  useEffect(() => { void refresh() }, [refresh])

  const totals = sessionTotals(sessions)

  function resetForm() {
    setDay(localToday()); setAmount(''); setUnit('hours')
    setWorkers(String(job.crew_size || 1)); setNote('')
    setAdding(false); setEditing(null)
  }

  function openEdit(s: WorkSession) {
    setEditing(s.id); setAdding(false)
    setDay(s.worked_on)
    // Shown in the unit that says it cleanly, so correcting "3h" does not mean
    // reading "180" first. Only minutes/hours here — a work session is a real
    // stretch of a real day, never a planning unit.
    if (s.minutes % 60 === 0) { setAmount(String(s.minutes / 60)); setUnit('hours') }
    else { setAmount(String(s.minutes)); setUnit('minutes') }
    setWorkers(String(s.workers))
    setNote(s.note ?? '')
  }

  async function save() {
    // 'days' is never offered for recorded work, so the workday length is not
    // needed and is not read: passing 1 keeps toMinutes total for minutes/hours.
    const minutes = toMinutes(amount, unit, 1)
    if (minutes == null) { toast.error('Enter how long the work took.'); return }
    setBusy(true)
    try {
      const w = Math.max(1, Number(workers) || 1)
      const res = editing
        ? await updateWorkSession(supabase, { id: editing, job_id: job.id },
            { workedOn: day, minutes, workers: w, note })
        : await logWorkSession(supabase, { id: job.id, user_id: job.user_id, crew_size: job.crew_size ?? 1 },
            { workedOn: day, minutes, workers: w, note })
      if (!res.ok) { toast.error(res.error || 'That didn’t save.'); return }
      toast.success(editing ? 'Work session updated.' : `Recorded ${formatWorked(minutes)}.`)
      onTotalChange?.(res.actualMinutes ?? null)
      resetForm()
      await refresh()
    } finally { setBusy(false) }
  }

  async function remove(s: WorkSession) {
    const okay = await confirm({
      title: 'Delete this work session?',
      message: `${formatWorked(s.minutes)} on ${dayLabel(s.worked_on)} will be removed from this job’s recorded time.`,
      confirmLabel: 'Delete',
      destructive: true,
    })
    if (!okay) return
    setBusy(true)
    try {
      const res = await deleteWorkSession(supabase, s)
      if (!res.ok) { toast.error(res.error || 'That couldn’t be deleted.'); return }
      onTotalChange?.(res.actualMinutes ?? null)
      await refresh()
      toast.undo('Work session deleted.', async () => {
        const back = await restoreWorkSession(supabase, s)
        // ⚠️ An undo that reports success on a failed write is worse than no
        // undo — the owner stops looking for the row. Branch on the result.
        if (!back.ok) { toast.error(back.error || 'Couldn’t put that back.'); return }
        onTotalChange?.(back.actualMinutes ?? null)
        await refresh()
      })
    } finally { setBusy(false) }
  }

  const labour = describeLabour(totals)

  return (
    <div className={cn('rounded-xl border border-border bg-bg-tertiary p-4 space-y-3', className)}>
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2 text-xs font-semibold text-ink-muted uppercase tracking-wide">
          <CalendarDays className="w-3.5 h-3.5" /> Work history
        </div>
        {!adding && !editing && (
          <Button type="button" size="sm" variant="ghost" onClick={() => { resetForm(); setAdding(true) }}>
            <Plus className="w-3.5 h-3.5 mr-1" /> Log work
          </Button>
        )}
      </div>

      {loading ? (
        <p className="text-xs text-ink-faint">Loading…</p>
      ) : failed ? (
        // Not "no work recorded" — we do not know that.
        <p className="text-xs text-amber-400">
          Couldn’t load this job’s work history. It hasn’t been changed — check your connection and reopen.
        </p>
      ) : sessions.length === 0 ? (
        <p className="text-xs text-ink-faint">
          No work recorded yet. Press Start on the day, or log a day by hand.
        </p>
      ) : (
        <>
          <ul className="space-y-1.5">
            {sessions.map(s => (
              <li key={s.id} className="flex items-center gap-2 text-sm">
                <span className="w-14 shrink-0 text-xs text-ink-faint tabular-nums">{dayLabel(s.worked_on)}</span>
                <span className="font-medium text-ink tabular-nums">{formatWorked(s.minutes)}</span>
                {s.workers > 1 && (
                  <span className="text-xs text-ink-muted flex items-center gap-1">
                    <Users className="w-3 h-3" />{s.workers}
                  </span>
                )}
                {s.note && <span className="text-xs text-ink-faint truncate flex-1">{s.note}</span>}
                <span className="flex-1" />
                <button type="button" onClick={() => openEdit(s)} disabled={busy}
                  aria-label={`Edit the ${dayLabel(s.worked_on)} work session`}
                  className="tap-target p-1.5 rounded-lg text-ink-faint hover:text-ink hover:bg-black/20">
                  <Pencil className="w-3.5 h-3.5" />
                </button>
                <button type="button" onClick={() => remove(s)} disabled={busy}
                  aria-label={`Delete the ${dayLabel(s.worked_on)} work session`}
                  className="tap-target p-1.5 rounded-lg text-ink-faint hover:text-red-400 hover:bg-black/20">
                  <Trash2 className="w-3.5 h-3.5" />
                </button>
              </li>
            ))}
          </ul>
          <p className="text-xs text-ink-muted border-t border-border pt-2">
            <span className="font-semibold text-ink">{formatWorked(totals.elapsedMinutes)}</span> on site
            {totals.days > 1 && ` over ${totals.days} days`}
            {/* Person-hours, said only when there IS a second person — for a solo
                operator the two numbers are the same and printing both is noise. */}
            {labour && <> · {labour}</>}
          </p>
        </>
      )}

      {(adding || editing) && (
        <div className="rounded-lg border border-border-strong bg-bg-secondary p-3 space-y-2.5">
          <div className="grid grid-cols-2 gap-2">
            <Input label="Day" type="date" fieldSize="sm" value={day} onChange={e => setDay(e.target.value)} />
            <Input label="People" type="number" min="1" max="50" fieldSize="sm"
              value={workers} onChange={e => setWorkers(e.target.value)} />
          </div>
          <div className="flex flex-col gap-1.5">
            <label className="text-xs font-semibold text-ink-muted uppercase tracking-wide">Time worked</label>
            <div className="flex gap-2">
              <Input type="number" inputMode="decimal" min="0" step={unit === 'minutes' ? 5 : 0.5}
                fieldSize="sm" className="flex-1" placeholder="0"
                value={amount} onChange={e => setAmount(e.target.value)} />
              {/* Minutes and hours only. A recorded day is real elapsed time —
                  re-stating it in workdays would push it through a setting that
                  can change tomorrow, and history must not move when it does. */}
              <div className="flex rounded-lg border border-border-strong overflow-hidden shrink-0">
                {(['hours', 'minutes'] as DurationUnit[]).map(u => (
                  <button key={u} type="button" onClick={() => setUnit(u)}
                    className={cn('tap-target px-3 text-xs font-medium transition-colors',
                      unit === u ? 'bg-accent text-black' : 'bg-bg-tertiary text-ink-muted hover:text-ink')}>
                    {u === 'hours' ? 'h' : 'min'}
                  </button>
                ))}
              </div>
            </div>
          </div>
          <Input label="Note (optional)" fieldSize="sm" maxLength={WORK_SESSION_NOTE_MAX}
            placeholder="Ran out of primer · waiting on the part"
            value={note} onChange={e => setNote(e.target.value)} />
          <div className="flex gap-2">
            <Button type="button" size="sm" onClick={save} disabled={busy}>
              {busy ? 'Saving…' : editing ? 'Save changes' : 'Record work'}
            </Button>
            <Button type="button" size="sm" variant="ghost" onClick={resetForm} disabled={busy}>Cancel</Button>
          </div>
        </div>
      )}
    </div>
  )
}
