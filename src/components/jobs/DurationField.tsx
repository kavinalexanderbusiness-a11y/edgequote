'use client'

// ── Duration: a number and the unit it is spoken in ──────────────────────────
//
// Replaces a single "Duration (minutes)" box. That box was fine for a 45-minute
// service call and wrong for everything larger: a four-day project was "1920",
// and a two-hour job was a small arithmetic problem before it was an estimate.
//
// ⭐ It still stores minutes, and only minutes. The unit is a way of SAYING the
// number, held in local component state and never persisted — `onChange` emits
// `number | null` and the form field it feeds is unchanged. All translation is
// lib/workDuration's; there is none in this file.
//
// ⭐ THE UNIT FOLLOWS THE VALUE. Open a job estimated at 480 minutes on an
// 8-hour-day business and the control reads "1 Workday", not "480 Minutes" —
// `splitDuration` picks the largest unit that says the same number without
// lying. Type 90 in Minutes and it stays 90 Minutes; type 1.5 in Hours and it
// stays 1.5 Hours. Nothing is silently re-expressed under the owner's cursor
// while they are typing: re-derivation happens when the value arrives from
// outside, not on every keystroke.
//
// ⛔ "Workdays" is never 24 hours. It is this business's own working day, from
// `business_settings.daily_capacity_hours` — the same figure the calendar's
// capacity bar and every scheduling engine already read.

import { useEffect, useRef, useState } from 'react'
import { Clock } from 'lucide-react'
import { cn } from '@/lib/utils'
import { fieldBorder } from '@/components/ui/fieldStyles'
import {
  DURATION_UNITS, DurationUnit, describeWorkday, durationValueText,
  formatDuration, splitDuration, toMinutes, workdayIsCustom,
} from '@/lib/workDuration'

interface Props {
  /** Stored minutes. null = not sized — an empty box, never a fabricated 0. */
  value: number | null
  onChange: (minutes: number | null) => void
  /** Minutes in ONE workday for THIS business (lib/workDuration.workdayMinutes). */
  workdayMin: number
  label?: string
  id?: string
  disabled?: boolean
}

export default function DurationField({
  value, onChange, workdayMin, label = 'Duration', id, disabled,
}: Props) {
  const initial = splitDuration(value, workdayMin)
  const [unit, setUnit] = useState<DurationUnit>(initial.unit)
  const [text, setText] = useState(durationValueText(initial.value))
  // What this control last EMITTED. An incoming `value` equal to it is our own
  // change coming back through the form, and must not re-derive the unit — that
  // is what turns "2" in the Hours box into "120" in the Minutes box mid-edit.
  const emitted = useRef<number | null>(value)

  useEffect(() => {
    if (value === emitted.current) return
    emitted.current = value
    const next = splitDuration(value, workdayMin)
    setUnit(next.unit)
    setText(durationValueText(next.value))
  }, [value, workdayMin])

  function emit(nextText: string, nextUnit: DurationUnit) {
    const minutes = toMinutes(nextText, nextUnit, workdayMin)
    emitted.current = minutes
    onChange(minutes)
  }

  const preview = formatDuration(value, workdayMin)
  // Only worth showing when the two readings differ — "2h" under a box that
  // already says 2 Hours is noise. It earns its place on "1.5 Workdays → 1 day 4h".
  const showPreview = !!preview && unit === 'days'

  return (
    <div className="flex flex-col gap-1.5">
      {label && (
        <label htmlFor={id} className="text-xs font-semibold text-ink-muted uppercase tracking-wide">
          {label}
        </label>
      )}
      <div className="flex gap-2">
        <input
          id={id}
          type="number"
          inputMode="decimal"
          // Minutes are whole; hours and days are commonly halves. The step
          // matches what the unit can actually mean, so the phone's stepper and
          // the spinner arrows land on real values.
          step={unit === 'minutes' ? 5 : 0.5}
          min={0}
          disabled={disabled}
          value={text}
          placeholder="0"
          onChange={e => { setText(e.target.value); emit(e.target.value, unit) }}
          className={cn(
            'flex-1 min-w-0 bg-bg-tertiary border text-ink outline-none transition-all',
            'rounded-xl px-3.5 py-3 text-base sm:text-sm',
            fieldBorder(undefined),
          )}
        />
        <select
          aria-label="Duration unit"
          disabled={disabled}
          value={unit}
          onChange={e => {
            const u = e.target.value as DurationUnit
            setUnit(u)
            // The NUMBER the owner typed is kept and re-read in the new unit: 2
            // Hours → 2 Workdays. Converting it instead (2 Hours → 0.25
            // Workdays) answers a question nobody asked — a unit change is a
            // correction to what they meant, not a conversion of what they said.
            emit(text, u)
          }}
          className={cn(
            'w-[7.5rem] shrink-0 bg-bg-tertiary border text-ink outline-none transition-all appearance-none',
            'rounded-xl px-3 py-3 pr-8 text-base sm:text-sm',
            'bg-[url("data:image/svg+xml,%3Csvg xmlns=\'http://www.w3.org/2000/svg\' width=\'14\' height=\'14\' viewBox=\'0 0 24 24\' fill=\'none\' stroke=\'%238A9AB8\' stroke-width=\'2\'%3E%3Cpath d=\'M6 9l6 6 6-6\'/%3E%3C/svg%3E")] bg-no-repeat bg-[right_12px_center]',
            fieldBorder(undefined),
          )}
        >
          {DURATION_UNITS.map(u => (
            <option key={u.value} value={u.value} className="bg-bg-secondary">{u.label}</option>
          ))}
        </select>
      </div>
      {showPreview && (
        <p className="text-xs text-ink-faint flex items-center gap-1.5">
          <Clock className="w-3 h-3 shrink-0" />
          {preview}
          {workdayIsCustom(workdayMin)
            ? ` · your ${describeWorkday(workdayMin)}`
            : ` · an ${describeWorkday(workdayMin)}`}
        </p>
      )}
    </div>
  )
}
