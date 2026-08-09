'use client'

import { useEffect, useMemo, useState } from 'react'
import { createClient } from '@/lib/supabase/client'
import { Crew, Technician, TECHNICIAN_STATUS_LABELS } from '@/types'
import { CREW_PALETTE, crewPalette, nextCrewColor, TECH_STATUS_META } from '@/lib/crews'
import { Modal } from '@/components/ui/Modal'
import { Button, ButtonLink } from '@/components/ui/Button'
import { Input } from '@/components/ui/Input'
import { Select } from '@/components/ui/Select'
import { Toggle } from '@/components/ui/Toggle'
import { InlineEmpty } from '@/components/ui/EmptyState'
import { CREW_ACCESS_LABEL, type CrewAccessRow } from '@/lib/crewInvite'
import { toTeamMember } from '@/lib/workforceTeam'
import { toast as notify } from '@/lib/toast'
import { confirm as confirmDialog } from '@/lib/confirm'
import { cn } from '@/lib/utils'
import { Users, Plus, Trash2, Truck, HardHat } from 'lucide-react'

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
  const [busy, setBusy] = useState<string | null>(null)

  // App-access state for the whole roster in ONE call. Whether somebody has ever
  // actually signed in lives in auth.users, which no owner client can read — so
  // it comes back through crew_access_states(), a DEFINER read scoped to the
  // caller's own roster. Re-read whenever the roster changes (accessTick) so a
  // fresh invite flips the badge without a page reload.
  const [accessById, setAccessById] = useState<Record<string, CrewAccessRow>>({})
  const [accessTick, setAccessTick] = useState(0)
  useEffect(() => {
    if (!open) return
    let alive = true
    supabase.rpc('crew_access_states').then(({ data, error }) => {
      // A failed read leaves the previous map in place rather than blanking every
      // badge to "No access" — claiming somebody has no login when they do is the
      // one wrong answer here.
      if (!alive || error || !data) return
      setAccessById(data as Record<string, CrewAccessRow>)
    })
    return () => { alive = false }
  }, [open, supabase, accessTick, technicians])

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

  async function deleteCrew(crew: Crew) {
    const ok = await confirmDialog({
      title: `Delete ${crew.name}?`,
      message: 'Jobs and people assigned to this crew become unassigned. Nothing else is deleted.',
      destructive: true, confirmLabel: 'Delete crew', icon: Users,
    })
    if (!ok) return
    await run(`del-${crew.id}`, () => supabase.from('crews').delete().eq('id', crew.id).then(r => ({ error: r.error })), `${crew.name} deleted.`)
  }

  const vehicles = [...equipment].sort((a, b) =>
    (a.category === 'vehicle' ? 0 : 1) - (b.category === 'vehicle' ? 0 : 1) || a.name.localeCompare(b.name))

  return (
    <Modal open={open} onClose={onClose} title="Crews & vehicles" icon={Users} size="lg">
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

        {/* ── The team ──────────────────────────────────────────────────────
            READ-ONLY here, on purpose. This section used to be six inline
            fields per person, each saving itself on blur — and because those
            inputs were UNCONTROLLED (defaultValue + onBlur), a save that FAILED
            left the typed value sitting on screen looking saved, with no
            refetch able to correct it. It was also the app's second employee
            editor, so "where do I change someone's crew" had two answers that
            could drift apart.
            People now live on Workforce, the page named after them. This is the
            glance you want while looking at the board, plus the way through.
            Crews and vehicles stay here — they are board furniture. */}
        <section className="space-y-2.5 border-t border-border pt-5">
          <div className="flex items-center justify-between gap-3">
            <p className="text-[10px] font-semibold uppercase tracking-[0.14em] text-ink-faint">Team</p>
            <ButtonLink href="/dashboard/workforce" variant="secondary" size="sm">
              <HardHat className="w-3.5 h-3.5" /> Manage team
            </ButtonLink>
          </div>
          {technicians.length === 0 ? (
            <InlineEmpty icon={HardHat}>Nobody on the team yet — add your people from Workforce.</InlineEmpty>
          ) : (
            <ul className="rounded-card border border-border divide-y divide-border overflow-hidden">
              {technicians.map(t => {
                const m = toTeamMember(t, crews, accessById[t.id])
                return (
                  <li key={t.id} className={cn('px-3 py-2 flex items-center gap-2.5 flex-wrap', !t.is_active && 'opacity-60')}>
                    <span className={cn('w-1.5 h-1.5 rounded-full shrink-0', TECH_STATUS_META[t.status].dot)} aria-hidden />
                    <span className="text-sm font-medium text-ink truncate">{t.name}</span>
                    <span className="text-[11px] text-ink-faint truncate">
                      {m.crewName ?? 'No crew'} · {TECHNICIAN_STATUS_LABELS[t.status]}
                    </span>
                    {!t.is_active && (
                      <span className="text-[10px] font-semibold uppercase tracking-wide rounded px-1.5 py-0.5 border border-border bg-bg-tertiary text-ink-faint">
                        Inactive
                      </span>
                    )}
                    <span className="ml-auto text-[10px] font-semibold uppercase tracking-wide text-ink-faint">
                      {CREW_ACCESS_LABEL[m.access]}
                    </span>
                  </li>
                )
              })}
            </ul>
          )}
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
    </Modal>
  )
}
