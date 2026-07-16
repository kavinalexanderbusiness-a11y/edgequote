'use client'

import { Crew, Technician, JobStatus, JOB_STATUS_LABELS } from '@/types'
import { crewPalette, UNASSIGNED_ID, UNASSIGNED_LANE } from '@/lib/crews'
import { AssignableEquipment } from '@/components/dispatch/CrewManager'
import { FilterPill } from '@/components/ui/FilterPill'
import { cn } from '@/lib/utils'
import { X } from 'lucide-react'

// ── Dispatch filters ─────────────────────────────────────────────────────────
// Narrows what the BOARD SHOWS — never what the route engines compute. A lane's
// ETAs/finish always come from its full stop list; filtering hides rows and
// lanes, and each lane says how much it's hiding. Crew/tech/vehicle narrow
// lanes; status narrows stop rows.

export interface DispatchFilterState {
  crewIds: string[]        // lane ids (crew id or UNASSIGNED_ID); empty = all
  statuses: JobStatus[]    // empty = all
  technicianId: string     // '' = any
  vehicleId: string        // '' = any
}

export const EMPTY_DISPATCH_FILTER: DispatchFilterState = { crewIds: [], statuses: [], technicianId: '', vehicleId: '' }

export function hasActiveFilter(f: DispatchFilterState): boolean {
  return f.crewIds.length > 0 || f.statuses.length > 0 || !!f.technicianId || !!f.vehicleId
}

// The statuses a dispatcher actually toggles between mid-day.
const STATUS_OPTIONS: JobStatus[] = ['scheduled', 'in_progress', 'completed']

export function DispatchFilters({ value, onChange, crews, technicians, equipment }: {
  value: DispatchFilterState
  onChange: (next: DispatchFilterState) => void
  crews: Crew[]
  technicians: Technician[]
  equipment: AssignableEquipment[]
}) {
  const activeCrews = crews.filter(c => c.is_active)
  const toggleIn = (list: string[], id: string) => (list.includes(id) ? list.filter(x => x !== id) : [...list, id])

  const compactSelect = (v: string, set: (nv: string) => void, options: { value: string; label: string }[], placeholder: string, ariaLabel: string) => (
    <select
      value={v}
      onChange={e => set(e.target.value)}
      aria-label={ariaLabel}
      className={cn(
        'rounded-full border px-3 py-1.5 pr-7 text-xs font-medium bg-surface appearance-none transition-all cursor-pointer',
        'bg-[url("data:image/svg+xml,%3Csvg xmlns=\'http://www.w3.org/2000/svg\' width=\'12\' height=\'12\' viewBox=\'0 0 24 24\' fill=\'none\' stroke=\'%238A9AB8\' stroke-width=\'2\'%3E%3Cpath d=\'M6 9l6 6 6-6\'/%3E%3C/svg%3E")] bg-no-repeat bg-[right_10px_center]',
        'focus-visible:outline-none focus:ring-2 focus:ring-accent/40',
        v ? 'border-accent text-ink' : 'border-border text-ink-muted hover:border-border-strong hover:text-ink',
      )}
    >
      <option value="" className="bg-bg-secondary">{placeholder}</option>
      {options.map(o => <option key={o.value} value={o.value} className="bg-bg-secondary">{o.label}</option>)}
    </select>
  )

  return (
    <div className="flex items-center gap-1.5 flex-wrap" role="group" aria-label="Dispatch filters">
      {activeCrews.map((c, i) => {
        const pal = crewPalette(c.color, i)
        return (
          <FilterPill
            key={c.id}
            active={value.crewIds.includes(c.id)}
            onClick={() => onChange({ ...value, crewIds: toggleIn(value.crewIds, c.id) })}
            title={`Show only ${c.name}`}
          >
            <span className={cn('w-1.5 h-1.5 rounded-full', pal.dot)} aria-hidden /> {c.name}
          </FilterPill>
        )
      })}
      {activeCrews.length > 0 && (
        <FilterPill
          active={value.crewIds.includes(UNASSIGNED_ID)}
          onClick={() => onChange({ ...value, crewIds: toggleIn(value.crewIds, UNASSIGNED_ID) })}
          title="Show only unassigned visits"
        >
          <span className={cn('w-1.5 h-1.5 rounded-full', UNASSIGNED_LANE.dot)} aria-hidden /> Unassigned
        </FilterPill>
      )}

      <span className="w-px h-4 bg-border mx-0.5" aria-hidden />

      {STATUS_OPTIONS.map(s => (
        <FilterPill
          key={s}
          active={value.statuses.includes(s)}
          onClick={() => onChange({ ...value, statuses: toggleIn(value.statuses, s) as JobStatus[] })}
        >
          {JOB_STATUS_LABELS[s]}
        </FilterPill>
      ))}

      {technicians.filter(t => t.is_active).length > 0 && (
        <>
          <span className="w-px h-4 bg-border mx-0.5" aria-hidden />
          {compactSelect(
            value.technicianId,
            id => onChange({ ...value, technicianId: id }),
            technicians.filter(t => t.is_active).map(t => ({ value: t.id, label: t.name })),
            'Any technician', 'Filter by technician',
          )}
        </>
      )}
      {equipment.length > 0 && compactSelect(
        value.vehicleId,
        id => onChange({ ...value, vehicleId: id }),
        equipment.map(e => ({ value: e.id, label: e.name })),
        'Any vehicle', 'Filter by vehicle',
      )}

      {hasActiveFilter(value) && (
        <button
          type="button"
          onClick={() => onChange(EMPTY_DISPATCH_FILTER)}
          className="inline-flex items-center gap-1 text-xs font-medium text-ink-faint hover:text-ink rounded-full px-2 py-1.5 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
        >
          <X className="w-3.5 h-3.5" aria-hidden /> Clear
        </button>
      )}
    </div>
  )
}
