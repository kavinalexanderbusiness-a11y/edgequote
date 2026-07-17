'use client'

import { useMemo, useState } from 'react'
import { format } from 'date-fns'
import type { SupabaseClient } from '@supabase/supabase-js'
import type { TimeEntry } from '@/types'
import { updateTimeEntry, formatDuration } from '@/lib/timeTracking'
import { Modal } from '@/components/ui/Modal'
import { Button } from '@/components/ui/Button'
import { Input } from '@/components/ui/Input'
import { Textarea } from '@/components/ui/Textarea'
import { Banner } from '@/components/ui/Banner'
import { toast as notify } from '@/lib/toast'
import { formatCurrency } from '@/lib/utils'
import { AlertTriangle, Check } from 'lucide-react'

// ── Time entry editor ────────────────────────────────────────────────────────
// Correcting a shift after the fact: a forgotten clock-out, a mistyped start.
// Every write goes through lib/timeTracking.updateTimeEntry — this component
// never touches supabase directly, so the DB's guards keep exactly one owner.
//
// The preview mirrors the DB's generated minutes_worked formula so the owner
// sees the consequence BEFORE saving. It is display only; Postgres remains the
// authority once saved.

/** ISO -> the value a datetime-local input wants (local wall time, no zone). */
function toLocalInput(iso: string): string {
  return format(new Date(iso), "yyyy-MM-dd'T'HH:mm")
}
/** datetime-local (local wall time) -> ISO. '' -> null (an open shift). */
function fromLocalInput(v: string): string | null {
  if (!v) return null
  const d = new Date(v)
  return Number.isNaN(d.getTime()) ? null : d.toISOString()
}

interface Props {
  open: boolean
  entry: TimeEntry
  technicianName: string
  supabase: SupabaseClient
  onClose: () => void
  onSaved: () => void
}

export function TimeEntryEditor({ open, entry, technicianName, supabase, onClose, onSaved }: Props) {
  const [clockIn, setClockIn] = useState(() => toLocalInput(entry.clock_in))
  const [clockOut, setClockOut] = useState(() => (entry.clock_out ? toLocalInput(entry.clock_out) : ''))
  const [breakMin, setBreakMin] = useState(String(entry.break_minutes ?? 0))
  const [notes, setNotes] = useState(entry.notes ?? '')
  const [rate, setRate] = useState(entry.hourly_rate == null ? '' : String(Number(entry.hourly_rate)))
  const [saving, setSaving] = useState(false)

  // Same shape as the generated column: greatest(0, span - break).
  const preview = useMemo(() => {
    const inMs = new Date(clockIn).getTime()
    const outMs = clockOut ? new Date(clockOut).getTime() : NaN
    const brk = Math.max(0, Number(breakMin) || 0)
    if (!Number.isFinite(inMs)) return { error: 'Enter a valid start time.' as string | null, minutes: null as number | null }
    if (!clockOut) return { error: null, minutes: null }
    if (!Number.isFinite(outMs)) return { error: 'Enter a valid end time.', minutes: null }
    if (outMs <= inMs) return { error: 'The shift has to end after it starts.', minutes: null }
    return { error: null, minutes: Math.max(0, Math.floor((outMs - inMs) / 60_000) - brk) }
  }, [clockIn, clockOut, breakMin])

  const rateNum = rate.trim() === '' ? null : Number(rate)
  const rateInvalid = rate.trim() !== '' && (!Number.isFinite(rateNum) || (rateNum as number) < 0)
  const cost = preview.minutes != null && rateNum != null && !rateInvalid
    ? Math.round((preview.minutes / 60) * rateNum * 100) / 100
    : null

  const reopening = !!entry.clock_out && !clockOut
  const rateChanged = (entry.hourly_rate == null ? null : Number(entry.hourly_rate)) !== rateNum

  async function save() {
    if (preview.error || rateInvalid) return
    setSaving(true)
    const res = await updateTimeEntry(supabase, entry.id, {
      clock_in: fromLocalInput(clockIn) ?? entry.clock_in,
      clock_out: fromLocalInput(clockOut),
      break_minutes: Math.max(0, Number(breakMin) || 0),
      notes: notes.trim() || null,
      hourly_rate: rateNum,
    })
    setSaving(false)
    if (!res.ok) { notify.error(res.error); return }
    notify.success(
      res.entry.clock_out
        ? `Shift updated — ${formatDuration(res.entry.minutes_worked ?? 0)} recorded.`
        : `${technicianName} is back on the clock.`,
    )
    onSaved()
    onClose()
  }

  return (
    <Modal open={open} onClose={onClose} title={`Edit ${technicianName}’s shift`} size="md" onSubmit={save}
      footer={
        <div className="flex items-center justify-end gap-2">
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button onClick={save} loading={saving} disabled={!!preview.error || rateInvalid}>
            <Check className="w-3.5 h-3.5" /> Save shift
          </Button>
        </div>
      }>
      <div className="space-y-3">
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <Input label="Clock in" type="datetime-local" value={clockIn} onChange={e => setClockIn(e.target.value)} />
          <Input label="Clock out" type="datetime-local" value={clockOut} onChange={e => setClockOut(e.target.value)}
            hint="Leave empty to put them back on the clock" />
        </div>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <Input label="Break (minutes)" type="number" min="0" step="5" value={breakMin}
            onChange={e => setBreakMin(e.target.value)} hint="Unpaid — subtracted from the shift" />
          {/* Editable so hours clocked before a wage was set can actually be paid.
              Changes THIS shift only — never re-prices anyone else's history. */}
          <Input label="Rate $/hr" type="number" min="0" step="0.25" value={rate}
            onChange={e => setRate(e.target.value)} placeholder="—"
            error={rateInvalid ? 'Rate must be 0 or more' : undefined}
            hint={entry.hourly_rate == null ? 'No rate was stamped — set one to pay these hours' : 'This shift only'} />
        </div>
        <Textarea label="Notes" rows={2} value={notes} onChange={e => setNotes(e.target.value)}
          placeholder="Optional — what this time was for" />

        {preview.error && <Banner tone="danger" icon={AlertTriangle}>{preview.error}</Banner>}

        {reopening && !preview.error && (
          <Banner tone="warn" icon={AlertTriangle}>
            This puts {technicianName} back on the clock. An open shift isn’t paid until it’s closed.
          </Banner>
        )}

        {/* What this shift becomes — the number that reaches payroll. */}
        {!preview.error && preview.minutes != null && (
          <div className="rounded-xl border border-border bg-bg-tertiary px-3.5 py-2.5 flex items-center justify-between">
            <span className="text-xs text-ink-muted">This shift becomes</span>
            <span className="text-sm font-bold text-ink tabular-nums">
              {formatDuration(preview.minutes)}
              {cost != null && <span className="text-accent"> · {formatCurrency(cost)}</span>}
            </span>
          </div>
        )}

        <p className="text-[11px] text-ink-faint">
          {rateChanged && entry.hourly_rate != null
            ? `Changing the rate re-values this one shift. Every other shift keeps the rate it was clocked in at.`
            : entry.hourly_rate == null
              ? 'This shift has no rate, so it records hours but pays $0. Set one above to pay it.'
              : `Stamped at ${formatCurrency(Number(entry.hourly_rate))}/hr when they clocked in. Editing the times never changes the rate on its own.`}
        </p>
      </div>
    </Modal>
  )
}
