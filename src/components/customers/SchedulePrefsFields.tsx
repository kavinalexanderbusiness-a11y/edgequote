'use client'

import { weekdayShort } from '@/lib/preferences'
import { Input } from '@/components/ui/Input'

// Controlled editor for a set of scheduling preferences (used for both the
// customer-wide default and a per-property override). Preferred and Avoid days
// are mutually exclusive — picking a day for one clears it from the other.
export interface PrefsDraft {
  preferred_days: number[]
  avoid_days: number[]
  pref_time_start: string  // '' = unset
  pref_time_end: string    // '' = unset
}

export const EMPTY_DRAFT: PrefsDraft = { preferred_days: [], avoid_days: [], pref_time_start: '', pref_time_end: '' }

export function toDraft(row: { preferred_days?: number[] | null; avoid_days?: number[] | null; pref_time_start?: string | null; pref_time_end?: string | null } | null | undefined): PrefsDraft {
  return {
    preferred_days: row?.preferred_days ?? [],
    avoid_days: row?.avoid_days ?? [],
    pref_time_start: row?.pref_time_start ?? '',
    pref_time_end: row?.pref_time_end ?? '',
  }
}

// Normalise a draft to the nullable DB shape (empty arrays/strings → null).
export function draftToRow(d: PrefsDraft) {
  return {
    preferred_days: d.preferred_days.length ? [...d.preferred_days].sort((a, b) => a - b) : null,
    avoid_days: d.avoid_days.length ? [...d.avoid_days].sort((a, b) => a - b) : null,
    pref_time_start: d.pref_time_start || null,
    pref_time_end: d.pref_time_end || null,
  }
}

const DAYS = [0, 1, 2, 3, 4, 5, 6]

export function SchedulePrefsFields({ value, onChange }: { value: PrefsDraft; onChange: (next: PrefsDraft) => void }) {
  function toggle(kind: 'preferred' | 'avoid', day: number) {
    const inPref = value.preferred_days.includes(day)
    const inAvoid = value.avoid_days.includes(day)
    if (kind === 'preferred') {
      onChange({
        ...value,
        preferred_days: inPref ? value.preferred_days.filter(d => d !== day) : [...value.preferred_days, day],
        avoid_days: value.avoid_days.filter(d => d !== day), // mutually exclusive
      })
    } else {
      onChange({
        ...value,
        avoid_days: inAvoid ? value.avoid_days.filter(d => d !== day) : [...value.avoid_days, day],
        preferred_days: value.preferred_days.filter(d => d !== day),
      })
    }
  }

  return (
    <div className="space-y-3">
      <DayRow label="Preferred days" tone="accent" selected={value.preferred_days} onToggle={d => toggle('preferred', d)} />
      <DayRow label="Avoid days" tone="amber" selected={value.avoid_days} onToggle={d => toggle('avoid', d)} />
      <div className="grid grid-cols-2 gap-3">
        <Input label="Earliest start" type="time" fieldSize="sm" value={value.pref_time_start}
          onChange={e => onChange({ ...value, pref_time_start: e.target.value })} />
        <Input label="Latest start" type="time" fieldSize="sm" value={value.pref_time_end}
          onChange={e => onChange({ ...value, pref_time_end: e.target.value })} />
      </div>
      <p className="text-[11px] text-ink-faint">Used as soft warnings when scheduling, and to steer the optimizer and best-day picker. Nothing is hard-blocked.</p>
    </div>
  )
}

function DayRow({ label, tone, selected, onToggle }: { label: string; tone: 'accent' | 'amber'; selected: number[]; onToggle: (d: number) => void }) {
  return (
    <div>
      <p className="text-xs font-semibold uppercase tracking-wide text-ink-muted mb-1.5">{label}</p>
      <div className="flex flex-wrap gap-1.5">
        {DAYS.map(d => {
          const on = selected.includes(d)
          const onClasses = tone === 'accent'
            ? 'border-accent bg-accent/15 text-accent-text'
            : 'border-amber-500/50 bg-amber-500/15 text-amber-300'
          return (
            <button key={d} type="button" onClick={() => onToggle(d)} aria-pressed={on}
              className={`w-10 py-1.5 rounded-lg border text-xs font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 ${on ? onClasses : 'border-border-strong bg-surface text-ink-muted hover:border-accent/40'}`}>
              {weekdayShort(d)}
            </button>
          )
        })}
      </div>
    </div>
  )
}
