'use client'

import { useMemo, useState } from 'react'
import { createClient } from '@/lib/supabase/client'
import { Crew, Technician, TECHNICIAN_STATUS_LABELS } from '@/types'
import { CREW_PALETTE, crewPalette, nextCrewColor, TECH_STATUS_META, archiveTechnician } from '@/lib/crews'
import { Modal } from '@/components/ui/Modal'
import { Button } from '@/components/ui/Button'
import { Input } from '@/components/ui/Input'
import { Select } from '@/components/ui/Select'
import { Toggle } from '@/components/ui/Toggle'
import { InlineEmpty } from '@/components/ui/EmptyState'
import { WageHistoryDialog } from '@/components/dispatch/WageHistoryDialog'
import { History } from 'lucide-react'
import { toast as notify } from '@/lib/toast'
import { confirm as confirmDialog } from '@/lib/confirm'
import { cn } from '@/lib/utils'
import { Users, Plus, Trash2, Truck, HardHat, UserMinus } from 'lucide-react'

// Slim equipment view for vehicle assignment — vehicles ARE equipment rows
// (one fleet system); dispatch only sets equipment.crew_id.
export interface AssignableEquipment {
  id: string
  name: string
  category: string
  crew_id: string | null
}

// ── Crew Manager ──────────────────────────────────────────────────────────────
// The dispatch module's roster: crews (identity + colour + capacity),
// technicians (people, home crew), and vehicle/equipment→crew assignment.
// CRUD writes straight to supabase; the board refetches via onChanged and
// realtime keeps other tabs live.
export function CrewManager({ open, onClose, crews, technicians, equipment, onChanged }: {
  open: boolean
  onClose: () => void
  crews: Crew[]
  technicians: Technician[]
  equipment: AssignableEquipment[]
  onChanged: () => void
}) {
  const supabase = useMemo(() => createClient(), [])
  const [newCrew, setNewCrew] = useState('')
  const [newTech, setNewTech] = useState('')
  const [busy, setBusy] = useState<string | null>(null)
  const [wageHistoryFor, setWageHistoryFor] = useState<Technician | null>(null)

  const crewOptions = [
    { value: '', label: 'No crew' },
    ...crews.filter(c => c.is_active).map(c => ({ value: c.id, label: c.name })),
  ]

  async function run(key: string, work: () => PromiseLike<{ error: { message: string } | null }>, okMsg?: string) {
    setBusy(key)
    const { error } = await work()
    setBusy(null)
    if (error) { notify.error('Could not save: ' + error.message); return false }
    if (okMsg) notify.success(okMsg)
    onChanged()
    return true
  }

  async function addCrew() {
    const name = newCrew.trim()
    if (!name) return
    const { data: { session } } = await supabase.auth.getSession()
    if (!session?.user) return
    const ok = await run('add-crew', () => supabase.from('crews').insert({
      user_id: session.user.id, name, color: nextCrewColor(crews),
      sort_order: crews.length,
    }).then(r => ({ error: r.error })), `Crew “${name}” created.`)
    if (ok) setNewCrew('')
  }

  async function addTech() {
    const name = newTech.trim()
    if (!name) return
    const { data: { session } } = await supabase.auth.getSession()
    if (!session?.user) return
    const ok = await run('add-tech', () => supabase.from('technicians').insert({
      user_id: session.user.id, name,
    }).then(r => ({ error: r.error })), `${name} added.`)
    if (ok) setNewTech('')
  }

  async function deleteCrew(crew: Crew) {
    const ok = await confirmDialog({
      title: `Delete ${crew.name}?`,
      message: 'Jobs and technicians assigned to this crew become unassigned. Nothing else is deleted.',
      destructive: true, confirmLabel: 'Delete crew', icon: Users,
    })
    if (!ok) return
    await run(`del-${crew.id}`, () => supabase.from('crews').delete().eq('id', crew.id).then(r => ({ error: r.error })), `${crew.name} deleted.`)
  }

  // Removing someone ARCHIVES them — it never deletes. This replaced a hard
  // `.delete()`, which CASCADE-removed their time_entries, wage_history and
  // pto_entries: the hours they worked and the wage they were paid, records with
  // a statutory retention period (~3yr). The old dialog promised "Job history is
  // untouched" while the database was erasing exactly that.
  // Goes through lib/crews' archiveTechnician — the same engine every other
  // technician mutation uses, not a second write path.
  async function archiveTech(t: Technician) {
    const ok = await confirmDialog({
      title: `Remove ${t.name} from the roster?`,
      message: 'They stop appearing on the board, in pickers and on new pay runs. Their timesheets, wage history and time off are kept — payroll records have to be.',
      confirmLabel: 'Remove from roster', icon: HardHat,
    })
    if (!ok) return
    // archiveTechnician returns a message string; `run` speaks Supabase's error
    // shape. Adapt here rather than widening the engine's return type.
    await run(`arch-${t.id}`, async () => {
      const msg = await archiveTechnician(supabase, t.id)
      return { error: msg ? { message: msg } : null }
    }, `${t.name} removed from the roster.`)
  }

  const vehicles = [...equipment].sort((a, b) =>
    (a.category === 'vehicle' ? 0 : 1) - (b.category === 'vehicle' ? 0 : 1) || a.name.localeCompare(b.name))

  return (
    <Modal open={open} onClose={onClose} title="Crews & roster" icon={Users} size="lg">
      <div className="space-y-6">

        {/* ── Crews ── */}
        <section className="space-y-2.5">
          <p className="text-[10px] font-semibold uppercase tracking-[0.14em] text-ink-faint">Crews</p>
          {crews.length === 0 && (
            <InlineEmpty icon={Users}>No crews yet — name your first one below.</InlineEmpty>
          )}
          {crews.map((crew, i) => {
            const pal = crewPalette(crew.color, i)
            return (
              <div key={crew.id} className={cn('rounded-card border p-3 space-y-2.5', crew.is_active ? 'border-border bg-surface' : 'border-border bg-bg-tertiary opacity-70')}>
                <div className="flex items-center gap-2.5 flex-wrap">
                  {/* Colour picker — the crew's identity everywhere (board, chips, map pins) */}
                  <div className="flex items-center gap-1" role="radiogroup" aria-label={`${crew.name} colour`}>
                    {CREW_PALETTE.map(p => (
                      <button
                        key={p.key} type="button" role="radio" aria-checked={crew.color === p.key}
                        title={p.label} aria-label={p.label}
                        onClick={() => run(`color-${crew.id}`, () => supabase.from('crews').update({ color: p.key }).eq('id', crew.id).then(r => ({ error: r.error })))}
                        className={cn('w-5 h-5 rounded-full transition-transform focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40',
                          p.dot, crew.color === p.key ? 'ring-2 ring-ink scale-110' : 'opacity-50 hover:opacity-90')}
                      />
                    ))}
                  </div>
                  <span className={cn('inline-flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-wide rounded-full px-2 py-0.5 border', pal.chip)}>
                    <span className={cn('w-1.5 h-1.5 rounded-full', pal.dot)} /> {pal.label}
                  </span>
                  <div className="ml-auto flex items-center gap-2">
                    <Toggle checked={crew.is_active} ariaLabel={`${crew.name} active`}
                      onChange={v => run(`act-${crew.id}`, () => supabase.from('crews').update({ is_active: v }).eq('id', crew.id).then(r => ({ error: r.error })))} />
                    <Button variant="ghost" size="sm" type="button" onClick={() => deleteCrew(crew)}
                      loading={busy === `del-${crew.id}`} className="hover:text-red-400" title="Delete crew">
                      <Trash2 className="w-3.5 h-3.5" />
                    </Button>
                  </div>
                </div>
                <div className="grid grid-cols-1 sm:grid-cols-3 gap-2.5">
                  <Input label="Name" defaultValue={crew.name} fieldSize="sm"
                    onBlur={e => { const v = e.target.value.trim(); if (v && v !== crew.name) run(`name-${crew.id}`, () => supabase.from('crews').update({ name: v }).eq('id', crew.id).then(r => ({ error: r.error }))) }} />
                  <Input label="Day start" type="time" defaultValue={crew.day_start?.slice(0, 5) ?? ''} fieldSize="sm"
                    hint="Blank = business default"
                    onBlur={e => { const v = e.target.value || null; if (v !== (crew.day_start?.slice(0, 5) ?? null)) run(`start-${crew.id}`, () => supabase.from('crews').update({ day_start: v }).eq('id', crew.id).then(r => ({ error: r.error }))) }} />
                  <Input label="Capacity (min/day)" type="number" min="0" step="15" defaultValue={crew.capacity_minutes ?? ''} fieldSize="sm"
                    hint="Blank = day window"
                    onBlur={e => { const v = e.target.value === '' ? null : Math.max(0, Math.round(Number(e.target.value))); if (v !== crew.capacity_minutes) run(`cap-${crew.id}`, () => supabase.from('crews').update({ capacity_minutes: v }).eq('id', crew.id).then(r => ({ error: r.error }))) }} />
                </div>
              </div>
            )
          })}
          <div className="flex items-end gap-2">
            <div className="flex-1"><Input label="New crew" placeholder="e.g. North crew" value={newCrew} fieldSize="sm"
              onChange={e => setNewCrew(e.target.value)} onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); addCrew() } }} /></div>
            <Button type="button" size="sm" onClick={addCrew} loading={busy === 'add-crew'} disabled={!newCrew.trim()}>
              <Plus className="w-3.5 h-3.5" /> Add crew
            </Button>
          </div>
        </section>

        {/* ── Technicians ── */}
        <section className="space-y-2.5 border-t border-border pt-5">
          <p className="text-[10px] font-semibold uppercase tracking-[0.14em] text-ink-faint">Technicians</p>
          {technicians.length === 0 && (
            <InlineEmpty icon={HardHat}>No technicians yet — add your people below.</InlineEmpty>
          )}
          {technicians.map(t => (
            <div key={t.id} className={cn('rounded-card border border-border p-3', !t.is_active && 'opacity-70 bg-bg-tertiary')}>
              <div className="grid grid-cols-1 sm:grid-cols-[1.1fr_1fr_1fr_1fr_0.9fr_auto] gap-2.5 items-end">
                <Input label="Name" defaultValue={t.name} fieldSize="sm"
                  onBlur={e => { const v = e.target.value.trim(); if (v && v !== t.name) run(`tname-${t.id}`, () => supabase.from('technicians').update({ name: v }).eq('id', t.id).then(r => ({ error: r.error }))) }} />
                <Input label="Phone" type="tel" defaultValue={t.phone ?? ''} fieldSize="sm"
                  onBlur={e => { const v = e.target.value.trim() || null; if (v !== t.phone) run(`tphone-${t.id}`, () => supabase.from('technicians').update({ phone: v }).eq('id', t.id).then(r => ({ error: r.error }))) }} />
                <Select label="Crew" fieldSize="sm" value={t.crew_id ?? ''} options={crewOptions}
                  onChange={e => run(`tcrew-${t.id}`, () => supabase.from('technicians').update({ crew_id: e.target.value || null }).eq('id', t.id).then(r => ({ error: r.error })))} />
                {/* Job title only — EdgeQuote has no permissions system and
                    technicians don't log in, so this grants nothing. */}
                <Input label="Role" placeholder="e.g. Crew lead" defaultValue={t.role ?? ''} fieldSize="sm"
                  title="A job title for your own records — it does not grant access to anything."
                  onBlur={e => { const v = e.target.value.trim() || null; if (v !== t.role) run(`trole-${t.id}`, () => supabase.from('technicians').update({ role: v }).eq('id', t.id).then(r => ({ error: r.error }))) }} />
                {/* Default rate for the NEXT clock-in only — past shifts keep the
                    rate they were stamped with, so a raise never rewrites history. */}
                <Input label="Wage $/hr" type="number" min="0" step="0.25" fieldSize="sm"
                  defaultValue={t.hourly_wage ?? ''}
                  title="Used for shifts started from now on. Past shifts keep the rate they were clocked in at."
                  onBlur={e => {
                    const raw = e.target.value.trim()
                    const v = raw === '' ? null : Number(raw)
                    if (v != null && (!Number.isFinite(v) || v < 0)) { notify.error('Wage must be 0 or more.'); e.target.value = String(t.hourly_wage ?? ''); return }
                    if (v !== t.hourly_wage) run(`twage-${t.id}`, () => supabase.from('technicians').update({ hourly_wage: v }).eq('id', t.id).then(r => ({ error: r.error })))
                  }} />
                <div className="flex items-center gap-2 pb-1">
                  <Toggle checked={t.is_active} ariaLabel={`${t.name} active`}
                    onChange={v => run(`tact-${t.id}`, () => supabase.from('technicians').update({ is_active: v }).eq('id', t.id).then(r => ({ error: r.error })))} />
                  {/* Every wage change is logged by a DB trigger, so this reads a
                      complete trail no matter where the change came from. */}
                  <Button variant="ghost" size="sm" type="button" onClick={() => setWageHistoryFor(t)}
                    title={`${t.name}'s wage history`} aria-label={`${t.name}'s wage history`}>
                    <History className="w-3.5 h-3.5" />
                  </Button>
                  {/* Archive, not delete — so this is no longer a destructive
                      action and must not wear the destructive affordance. */}
                  <Button variant="ghost" size="sm" type="button" onClick={() => archiveTech(t)}
                    loading={busy === `arch-${t.id}`} title="Remove from roster" aria-label={`Remove ${t.name} from the roster`}>
                    <UserMinus className="w-3.5 h-3.5" />
                  </Button>
                </div>
              </div>
              <p className="text-[11px] text-ink-faint mt-1.5 flex items-center gap-1.5">
                <span className={cn('w-1.5 h-1.5 rounded-full', TECH_STATUS_META[t.status].dot)} />
                {TECHNICIAN_STATUS_LABELS[t.status]} — set day-of status from the board
              </p>
            </div>
          ))}
          <div className="flex items-end gap-2">
            <div className="flex-1"><Input label="New technician" placeholder="e.g. Sam Torres" value={newTech} fieldSize="sm"
              onChange={e => setNewTech(e.target.value)} onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); addTech() } }} /></div>
            <Button type="button" size="sm" onClick={addTech} loading={busy === 'add-tech'} disabled={!newTech.trim()}>
              <Plus className="w-3.5 h-3.5" /> Add technician
            </Button>
          </div>
        </section>

        {/* ── Vehicles & equipment ── */}
        <section className="space-y-2.5 border-t border-border pt-5">
          <p className="text-[10px] font-semibold uppercase tracking-[0.14em] text-ink-faint">Vehicles & equipment</p>
          {vehicles.length === 0 ? (
            <InlineEmpty icon={Truck}>Nothing in Equipment yet — vehicles added there can be assigned to crews here.</InlineEmpty>
          ) : (
            <div className="space-y-1.5">
              {vehicles.map(v => (
                <div key={v.id} className="flex items-center gap-3 rounded-card border border-border px-3 py-2">
                  <Truck className="w-4 h-4 text-ink-faint shrink-0" />
                  <div className="min-w-0 flex-1">
                    <p className="text-sm font-medium text-ink truncate">{v.name}</p>
                    <p className="text-[11px] text-ink-faint capitalize">{v.category.replace(/[_-]/g, ' ')}</p>
                  </div>
                  <div className="w-44 shrink-0">
                    <Select fieldSize="sm" value={v.crew_id ?? ''} options={crewOptions} aria-label={`${v.name} crew`}
                      onChange={e => run(`veh-${v.id}`, () => supabase.from('equipment').update({ crew_id: e.target.value || null }).eq('id', v.id).then(r => ({ error: r.error })))} />
                  </div>
                </div>
              ))}
            </div>
          )}
          <p className="text-[11px] text-ink-faint">Manage the fleet itself in the Equipment module — dispatch only decides who takes what.</p>
        </section>
      </div>

      {wageHistoryFor && (
        <WageHistoryDialog technician={wageHistoryFor} supabase={supabase} onClose={() => setWageHistoryFor(null)} />
      )}
    </Modal>
  )
}
