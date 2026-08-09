'use client'

import { useEffect, useState } from 'react'
import { createClient } from '@/lib/supabase/client'
import { Crew, Technician } from '@/types'
import { archiveTechnician } from '@/lib/crews'
import { STANDING_LABEL, employeeStanding } from '@/lib/workforceTeam'
import type { CrewAccessRow } from '@/lib/crewInvite'
import { Modal } from '@/components/ui/Modal'
import { Button } from '@/components/ui/Button'
import { Input } from '@/components/ui/Input'
import { Select } from '@/components/ui/Select'
import { Toggle } from '@/components/ui/Toggle'
import { Banner } from '@/components/ui/Banner'
import { CrewAccessControl } from '@/components/dispatch/CrewAccessControl'
import { toast } from '@/lib/toast'
import { confirm } from '@/lib/confirm'
import { UserPlus, UserCog, UserMinus, History } from 'lucide-react'

// ── ONE employee, everything about them ──────────────────────────────────────
// Managing a person used to mean a row of six inline fields on a modal on the
// dispatch board, each saving itself on blur. Two problems with that, and this
// component exists for both:
//
//  1. IT LIED ON FAILURE. Those inputs were uncontrolled (`defaultValue` +
//     onBlur), so a save that failed left the typed value sitting on screen
//     looking saved — and because nothing re-seeds an uncontrolled input, a
//     refetch never corrected it either. Here the form is CONTROLLED, saving is
//     one explicit action, and a failure keeps the dialog open with the error
//     on it. Nothing is dismissed until the database agreed.
//
//  2. IT HAD NO ORDER. Six fields side by side say nothing about what setting
//     somebody up actually involves. This runs in the sequence the job has:
//     who they are → which crew → what they cost → whether they can use the app.
//
// The app-access panel is the SAME component the roster used (CrewAccessControl),
// not a copy: the four states and every RPC behind them stay in one place.

export interface EmployeeEditorProps {
  open: boolean
  onClose: () => void
  /** null = adding somebody new. */
  employee: Technician | null
  crews: Crew[]
  access?: CrewAccessRow | null
  /** The owner's auth id — needed to insert a new row. */
  userId: string
  onSaved: () => void
  onShowWageHistory?: (t: Technician) => void
}

interface Draft { name: string; phone: string; email: string; role: string; crewId: string; wage: string; isActive: boolean }

function draftFrom(t: Technician | null): Draft {
  return {
    name: t?.name ?? '',
    phone: t?.phone ?? '',
    email: t?.email ?? '',
    role: t?.role ?? '',
    crewId: t?.crew_id ?? '',
    wage: t?.hourly_wage != null ? String(t.hourly_wage) : '',
    isActive: t ? t.is_active : true,
  }
}

export function EmployeeEditor({
  open, onClose, employee, crews, access, userId, onSaved, onShowWageHistory,
}: EmployeeEditorProps) {
  const supabase = createClient()
  const [draft, setDraft] = useState<Draft>(() => draftFrom(employee))
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // Re-seed when the dialog opens on a different person — and ONLY then. Keying
  // on the id (not the object) means a background refetch cannot overwrite what
  // the owner is halfway through typing, which is this codebase's recurring bug.
  const key = employee?.id ?? 'new'
  useEffect(() => {
    if (open) { setDraft(draftFrom(employee)); setError(null) }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, key])

  const isNew = !employee
  const set = <K extends keyof Draft>(k: K, v: Draft[K]) => setDraft(d => ({ ...d, [k]: v }))

  const crewOptions = [
    { value: '', label: 'No crew yet' },
    ...crews.filter(c => c.is_active).map(c => ({ value: c.id, label: c.name })),
  ]

  async function save() {
    const name = draft.name.trim()
    if (!name) { setError('Give them a name so you can find them on the board.'); return }
    const wage = draft.wage.trim() === '' ? null : Number(draft.wage)
    if (wage != null && (!Number.isFinite(wage) || wage < 0)) { setError('A wage has to be 0 or more.'); return }

    setSaving(true)
    setError(null)
    const row = {
      name,
      phone: draft.phone.trim() || null,
      email: draft.email.trim() || null,
      role: draft.role.trim() || null,
      crew_id: draft.crewId || null,
      hourly_wage: wage,
      is_active: draft.isActive,
    }
    const { error: err } = isNew
      ? await supabase.from('technicians').insert({ user_id: userId, ...row })
      : await supabase.from('technicians').update(row).eq('id', employee!.id)
    setSaving(false)
    if (err) {
      // Stay open, keep every keystroke, say what happened. The old inline
      // fields showed a toast and left the wrong value on screen.
      setError(`Couldn’t save: ${err.message}`)
      return
    }
    toast.success(isNew ? `${name} added to the team.` : `${name} saved.`)
    onSaved()
    onClose()
  }

  async function remove() {
    if (!employee) return
    const ok = await confirm({
      title: `Remove ${employee.name} from the team?`,
      message: 'They stop appearing on the board, in pickers and on new pay runs, and lose the crew app. Their timesheets, wage history and time off are kept — payroll records have to be.',
      confirmLabel: 'Remove from team',
      icon: UserMinus,
    })
    if (!ok) return
    setSaving(true)
    const msg = await archiveTechnician(supabase, employee.id)
    setSaving(false)
    if (msg) { setError(`Couldn’t remove them: ${msg}`); return }
    toast.success(`${employee.name} removed from the team.`)
    onSaved()
    onClose()
  }

  const standing = employee ? employeeStanding(employee) : 'working'

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={isNew ? 'Add an employee' : employee!.name}
      icon={isNew ? UserPlus : UserCog}
      size="md"
      onSubmit={save}
      footer={
        <div className="flex items-center gap-2">
          <Button onClick={save} loading={saving} className="flex-1 sm:flex-none">
            {isNew ? 'Add employee' : 'Save'}
          </Button>
          <Button variant="ghost" onClick={onClose} disabled={saving}>Cancel</Button>
          {!isNew && standing !== 'former' && (
            <Button variant="ghost" onClick={remove} disabled={saving} className="ml-auto"
              title="Take them off the team — timesheets and pay history are kept">
              <UserMinus className="w-3.5 h-3.5" /> Remove
            </Button>
          )}
        </div>
      }
    >
      <div className="space-y-5">
        {error && <Banner tone="danger">{error}</Banner>}

        {/* 1 — who they are */}
        <section className="space-y-3">
          <Input label="Name" value={draft.name} onChange={e => set('name', e.target.value)}
            placeholder="e.g. Sam Torres" autoFocus={isNew} required />
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <Input label="Mobile" type="tel" inputMode="tel" value={draft.phone}
              onChange={e => set('phone', e.target.value)} placeholder="Optional" />
            <Input label="Email" type="email" inputMode="email" value={draft.email}
              onChange={e => set('email', e.target.value)} placeholder="Optional"
              hint="Used to invite them to the app." />
          </div>
          <Input label="Job title" value={draft.role} onChange={e => set('role', e.target.value)}
            placeholder="e.g. Crew lead"
            hint="For your own records. It grants nothing — app access is set below." />
        </section>

        {/* 2 — where they work */}
        <section className="space-y-3 border-t border-border pt-4">
          <Select label="Crew" value={draft.crewId} onChange={e => set('crewId', e.target.value)}
            options={crewOptions}
            hint={crews.filter(c => c.is_active).length === 0
              ? 'No crews yet — you can add them to one later from the dispatch board.'
              : 'Which crew’s day they work. Their app shows that crew’s visits.'} />
        </section>

        {/* 3 — what they cost */}
        <section className="space-y-3 border-t border-border pt-4">
          <Input label="Wage ($/hr)" type="number" inputMode="decimal" min="0" step="0.25"
            value={draft.wage} onChange={e => set('wage', e.target.value)} placeholder="Optional"
            hint="Applies to shifts started from now on — past shifts keep the rate they were clocked in at." />
          {!isNew && onShowWageHistory && (
            <button type="button" onClick={() => onShowWageHistory(employee!)}
              className="text-xs font-medium text-accent-text hover:underline inline-flex items-center gap-1">
              <History className="w-3.5 h-3.5" aria-hidden /> Wage history
            </button>
          )}
        </section>

        {/* 4 — working right now? */}
        <section className="border-t border-border pt-4">
          <div className="flex items-start gap-3">
            <Toggle checked={draft.isActive} onChange={v => set('isActive', v)}
              ariaLabel="Currently working" />
            <div className="min-w-0">
              <p className="text-sm font-medium text-ink">
                {draft.isActive ? 'Currently working' : 'Not working right now'}
              </p>
              <p className="text-[11px] text-ink-faint leading-relaxed">
                {draft.isActive
                  ? 'They appear on the board and in pickers, and can use the crew app.'
                  : 'They stay on the team with all their history, but drop off the board — and the crew app closes to them immediately, even on a phone that’s already signed in.'}
              </p>
            </div>
          </div>
        </section>

        {/* 5 — the app. Only once they exist: there is no row to attach a login
            to until the first save, and saying so beats a button that fails. */}
        <section className="border-t border-border pt-4">
          <p className="text-[10px] font-semibold uppercase tracking-[0.14em] text-ink-faint">EdgeQuote app</p>
          {isNew ? (
            <p className="mt-1.5 text-[11px] leading-relaxed text-ink-faint">
              Add them first, then you can invite them — they get their own login that shows only their
              crew’s visits. Never prices, invoices, customers or settings.
            </p>
          ) : (
            <CrewAccessControl tech={employee!} access={access} onChanged={onSaved} />
          )}
        </section>
      </div>
    </Modal>
  )
}
