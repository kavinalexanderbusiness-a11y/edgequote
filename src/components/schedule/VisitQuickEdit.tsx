'use client'

import { useEffect, useState } from 'react'
import { Modal } from '@/components/ui/Modal'
import { Input } from '@/components/ui/Input'
import { Select } from '@/components/ui/Select'
import { Textarea } from '@/components/ui/Textarea'
import { Button } from '@/components/ui/Button'
import { confirm } from '@/lib/confirm'
import { AUDIENCE_COPY } from '@/lib/noteScope'
import { Crew, Job, JobStatus, Technician, JOB_STATUS_LABELS } from '@/types'
import { AssigneeSelect } from '@/components/schedule/AssigneeSelect'
import { assigneeOf, assigneeColumns, parseAssigneeValue, assigneeValue } from '@/lib/crewAssignment'
import { AlertTriangle, SlidersHorizontal, Trash2 } from 'lucide-react'

// ── The one quick-edit patch ──────────────────────────────────────────────────
// Every key is OPTIONAL and the save applies ONLY the keys present: a quick
// editor that renders six fields must never be able to null the columns it
// does not render. (The full-form save is safe for the opposite reason — it
// seeds every field it patches from the loaded row. A partial editor has no
// such seed for hidden columns, so absence-means-untouched is the contract.)
// ⛔ Money and identity stay out: no price, no quote_id, no recurrence_id, no
// is_initial_visit, no actual_minutes — those belong to their own engines
// (setJobPrice / the completion doors / the recurrence scope machinery).
export interface QuickPatch {
  start_time?: string | null
  crew_size?: number
  duration_minutes?: number | null
  status?: JobStatus
  notes?: string | null
  service_type?: string | null
  /** Who is coming — the two assignment columns, ALWAYS sent as a pair
   *  (lib/crewAssignment.assigneeColumns; jobs_one_assignee refuses half a
   *  write). Applied with the same route_order reset as lib/crews.assignJob —
   *  one reassignment semantic, however many doors. */
  crew_id?: string | null
  technician_id?: string | null
}

interface Props {
  /** The visit being edited, or null when the sheet is closed. */
  job: Job | null
  crews: Crew[]
  technicians: Technician[]
  onClose: () => void
  /** Field save — the page's quickSaveJob engine (status transitions keep
   *  routing through the completion/uncomplete engines there). */
  onSave: (job: Job, patch: QuickPatch) => Promise<void>
  /** Date changes are a RESCHEDULE, not a field write. They route through the
   *  page's existing move engine — cadence/preference warnings, the scope
   *  dialog for a recurring visit, the undo toast — never a bare column
   *  update. This is what keeps rescheduling explicit. */
  onMove: (job: Job, newDate: string) => void | Promise<void>
}

const STATUS_ORDER: JobStatus[] = ['scheduled', 'in_progress', 'completed', 'cancelled']

type Draft = {
  service_type: string
  scheduled_date: string
  start_time: string
  duration_minutes: string
  /** AssigneeSelect's stable string ('unassigned' | 'crew:<id>' | 'person:<id>')
   *  — parsed back to the TWO columns only at save time, so the draft can never
   *  hold half an assignment. */
  assignee: string
  crew_size: string
  status: JobStatus
  notes: string
}

function draftFrom(job: Job): Draft {
  return {
    service_type: job.service_type || '',
    scheduled_date: job.scheduled_date,
    start_time: job.start_time || '',
    duration_minutes: job.duration_minutes ? String(job.duration_minutes) : '',
    assignee: assigneeValue(assigneeOf(job)),
    crew_size: String(job.crew_size || 1),
    status: job.status,
    notes: job.notes || '',
  }
}

// The fast door on a stop card: the six things an owner changes constantly —
// service, date, time, duration, assignee, note (plus status and headcount) —
// in one small sheet, without opening the full job editor. Built on the shared
// Modal (mobile bottom-sheet, focus trap, Escape, scroll lock) instead of the
// old hand-styled inline panel, so every touch/keyboard rule is inherited
// rather than re-implemented.
export function VisitQuickEdit({ job, crews, technicians, onClose, onSave, onMove }: Props) {
  const [draft, setDraft] = useState<Draft | null>(null)
  const [seed, setSeed] = useState<Draft | null>(null)
  const [saving, setSaving] = useState(false)

  // Re-seed whenever a different visit opens. The seed is kept verbatim so
  // dirtiness is a comparison, never a guess.
  useEffect(() => {
    if (!job) { setDraft(null); setSeed(null); return }
    const d = draftFrom(job)
    setDraft(d)
    setSeed(d)
  }, [job?.id]) // eslint-disable-line react-hooks/exhaustive-deps

  const dirty = !!draft && !!seed && (Object.keys(draft) as (keyof Draft)[]).some(k => draft[k] !== seed[k])

  // A dirty sheet survives an accidental tab close — same protection the
  // settings page carries. Registered only while there is something to lose.
  useEffect(() => {
    if (!dirty) return
    const onBeforeUnload = (e: BeforeUnloadEvent) => { e.preventDefault() }
    window.addEventListener('beforeunload', onBeforeUnload)
    return () => window.removeEventListener('beforeunload', onBeforeUnload)
  }, [dirty])

  async function requestClose() {
    if (saving) return
    if (!dirty) { onClose(); return }
    const ok = await confirm({
      title: 'Discard these changes?',
      message: 'You’ve changed this visit. Closing now throws the changes away — nothing is saved until you tap Save.',
      confirmLabel: 'Discard',
      cancelLabel: 'Keep editing',
      destructive: true,
      icon: Trash2,
    })
    if (ok) onClose()
  }

  async function save() {
    if (!job || !draft || !seed || saving) return
    setSaving(true)
    try {
      // ONLY the changed keys — absence means untouched (see QuickPatch).
      const patch: QuickPatch = {}
      if (draft.service_type !== seed.service_type) patch.service_type = draft.service_type.trim() || null
      if (draft.start_time !== seed.start_time) patch.start_time = draft.start_time || null
      if (draft.duration_minutes !== seed.duration_minutes) patch.duration_minutes = Number(draft.duration_minutes) > 0 ? Number(draft.duration_minutes) : null
      if (draft.crew_size !== seed.crew_size) patch.crew_size = Math.max(1, Number(draft.crew_size) || 1)
      if (draft.status !== seed.status) patch.status = draft.status
      if (draft.notes !== seed.notes) patch.notes = draft.notes || null
      if (draft.assignee !== seed.assignee) {
        // Both columns, always together — lib/crewAssignment's write shape.
        const cols = assigneeColumns(parseAssigneeValue(draft.assignee))
        patch.crew_id = cols.crew_id
        patch.technician_id = cols.technician_id
      }

      if (Object.keys(patch).length > 0) await onSave(job, patch)
      // The reschedule half, through the page's move engine (may open the scope
      // dialog for a recurring visit AFTER the sheet closes — that question is
      // the explicitness, not an extra step to engineer away).
      if (draft.scheduled_date && draft.scheduled_date !== seed.scheduled_date) {
        await onMove(job, draft.scheduled_date)
      }
      onClose()
    } finally {
      setSaving(false)
    }
  }

  const hasRoster = crews.length > 0 || technicians.length > 0
  const open = !!job && !!draft
  const dateChanged = !!draft && !!seed && draft.scheduled_date !== seed.scheduled_date
  const serviceChanged = !!draft && !!seed && draft.service_type !== seed.service_type

  return (
    <Modal
      open={open}
      onClose={requestClose}
      title="Quick edit · this visit"
      icon={SlidersHorizontal}
      size="md"
      onSubmit={save}
      footer={
        <>
          {dirty && !saving && (
            <span role="status" className="mr-auto text-xs text-amber-400 flex items-center gap-1.5">
              <span className="w-1.5 h-1.5 rounded-full bg-amber-400 inline-block" aria-hidden="true" />
              Unsaved changes
            </span>
          )}
          <Button variant="ghost" onClick={requestClose} disabled={saving}>Cancel</Button>
          <Button onClick={save} loading={saving} disabled={!dirty}>Save</Button>
        </>
      }
    >
      {draft && job && (
        <div className="space-y-4">
          <Input label="Service" placeholder="What's being done"
            value={draft.service_type}
            onChange={e => setDraft(d => d && { ...d, service_type: e.target.value })} />

          {/* ── Financial truth ──────────────────────────────────────────────
              Renaming the service never re-prices the visit (price is the
              manual override or the quote-derived value — lib/visitValue).
              Said here because the silent version of this fact is how a
              mislabelled amount reaches an invoice. */}
          {serviceChanged && job.quote_id && (
            <p className="text-xs text-sky-300 -mt-2.5 flex items-start gap-1.5">
              <AlertTriangle className="w-3.5 h-3.5 shrink-0 mt-px" />
              <span>The linked quote still sets the price — changing the service changes the label, never the amount.</span>
            </p>
          )}

          <div className="grid grid-cols-2 gap-4">
            <Input label="Date" type="date"
              value={draft.scheduled_date}
              onChange={e => setDraft(d => d && { ...d, scheduled_date: e.target.value })} />
            <Input label="Start time" type="time"
              value={draft.start_time}
              onChange={e => setDraft(d => d && { ...d, start_time: e.target.value })} />
          </div>

          {dateChanged && (
            <p className="text-xs text-ink-muted -mt-2.5">
              {job.recurrence_id
                ? 'Reschedules on save — you’ll choose which visits move.'
                : 'Reschedules this visit on save (with undo).'}
            </p>
          )}

          <div className="grid grid-cols-2 gap-4">
            <Input label="Duration (min)" type="number" min="0" step="5"
              value={draft.duration_minutes}
              onChange={e => setDraft(d => d && { ...d, duration_minutes: e.target.value })} />
            <Input label="Crew size" type="number" min="1"
              value={draft.crew_size}
              onChange={e => setDraft(d => d && { ...d, crew_size: e.target.value })} />
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            {hasRoster && (
              /* THE chooser — crew XOR person (lib/crewAssignment), same
                 control as the job form and the dispatch board. */
              <AssigneeSelect
                crews={crews}
                technicians={technicians}
                value={parseAssigneeValue(draft.assignee)}
                onChange={next => setDraft(d => d && { ...d, assignee: assigneeValue(next) })}
              />
            )}
            <Select label="Status"
              value={draft.status}
              onChange={e => setDraft(d => d && { ...d, status: e.target.value as JobStatus })}
              options={STATUS_ORDER.map(s => ({ value: s, label: JOB_STATUS_LABELS[s] }))} />
          </div>

          <Textarea label={AUDIENCE_COPY.crew.label} rows={2}
            placeholder="Gate code, access, crew notes…"
            value={draft.notes}
            onChange={e => setDraft(d => d && { ...d, notes: e.target.value })} />

          <p className="text-[11px] text-ink-faint">This visit only — use Edit job for price, repeat &amp; everything else.</p>
        </div>
      )}
    </Modal>
  )
}
