'use client'

import { useMemo } from 'react'
import { Crew, Technician } from '@/types'
import {
  assignmentOptions, assigneeValue, parseAssigneeValue, ASSIGNMENT_GROUP_LABELS,
  type Assignee,
} from '@/lib/crewAssignment'
import { Select } from '@/components/ui/Select'

// ── "Assigned to" ────────────────────────────────────────────────────────────
// One control, everywhere work is assigned, so the answer means the same thing
// on the job form, the day board and the dispatch card.
//
// Crews and individuals sit in separate groups on purpose. Jane appearing under
// Individuals while she is also ON Crew A is not a duplicate — they are two
// different instructions, and the hint under the field says which one is
// selected: picking Crew A sends the visit to whoever is on Crew A that day;
// picking Jane sends it to Jane alone. That sentence is the whole reason this
// exists rather than a bare list of crew names.

export function AssigneeSelect({
  value, onChange, crews, technicians, label = 'Assigned to', id, disabled, fieldSize = 'md', className,
}: {
  value: Assignee
  onChange: (next: Assignee) => void
  crews: Crew[]
  technicians: Technician[]
  label?: string
  id?: string
  disabled?: boolean
  fieldSize?: 'sm' | 'md'
  className?: string
}) {
  const options = useMemo(
    () => assignmentOptions({ crews, technicians, current: value }),
    [crews, technicians, value],
  )
  const selected = options.find(o => o.value === assigneeValue(value))

  return (
    <Select
      id={id}
      label={label}
      className={className}
      fieldSize={fieldSize}
      disabled={disabled}
      value={assigneeValue(value)}
      onChange={e => onChange(parseAssigneeValue(e.target.value))}
      // The hint is the load-bearing half: it says what the current choice MEANS.
      hint={selected?.hint ?? undefined}
      options={options.map(o => ({
        value: o.value,
        label: o.label,
        disabled: o.disabled,
        group: o.group === 'none' ? undefined : ASSIGNMENT_GROUP_LABELS[o.group],
      }))}
    />
  )
}
