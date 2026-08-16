'use client'

import { useEffect, useMemo, useState } from 'react'
import { createClient } from '@/lib/supabase/client'
import { Crew, Technician, Job } from '@/types'
import {
  renameCrew, setCrewActive, setCrewLead, setTechnicianCrew, deleteCrew, crewPalette,
} from '@/lib/crews'
import { Modal } from '@/components/ui/Modal'
import { Button } from '@/components/ui/Button'
import { Input } from '@/components/ui/Input'
import { Select } from '@/components/ui/Select'
import { Banner } from '@/components/ui/Banner'
import { toast } from '@/lib/toast'
import { confirm } from '@/lib/confirm'
import { cn } from '@/lib/utils'
import { Users, Star, UserMinus, UserPlus, Power, Trash2, CalendarDays } from 'lucide-react'

// ── One crew, everything about it ────────────────────────────────────────────
// Name · who is on it · who leads it · what it is booked to do · how to stand it
// down. Each change is its OWN explicit save against the one writer in
// lib/crews, because these are independent facts: renaming a crew and removing
// somebody from it are not one edit that should succeed or fail together.
//
// ⭐ Removing somebody changes what happens NEXT and nothing else. Their past
// visits, hours, photos and messages stay exactly as they were — the database
// keeps an append-only record of who was on which crew when, so last Tuesday
// still reads the way it happened. The dialog says so, because an owner has no
// way to know it otherwise.

export function CrewEditor({
  open, onClose, crew, technicians, jobs, todayISO, ptoTodayIds, onSaved,
}: {
  open: boolean
  onClose: () => void
  crew: Crew | null
  /** The full active roster — members are derived, not passed in. */
  technicians: Technician[]
  /** Visits in the loaded window, for "what is this crew booked to do". */
  jobs: Job[]
  todayISO: string
  /** Technician ids booked off today. null = availability unknown, never empty. */
  ptoTodayIds: string[] | null
  onSaved: () => void
}) {
  const supabase = createClient()
  const [name, setName] = useState(crew?.name ?? '')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [addId, setAddId] = useState('')

  // Re-seed only when the dialog opens on a different crew — never on the
  // object, so a background refetch can't erase what is being typed.
  const key = crew?.id ?? 'none'
  useEffect(() => {
    if (open) { setName(crew?.name ?? ''); setError(null); setAddId('') }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, key])

  const members = useMemo(
    () => technicians.filter(t => t.is_active && !t.archived_at && crew && t.crew_id === crew.id)
      .sort((a, b) => a.name.localeCompare(b.name)),
    [technicians, crew],
  )
  const addable = useMemo(
    () => technicians.filter(t => t.is_active && !t.archived_at && (!crew || t.crew_id !== crew.id))
      .sort((a, b) => a.name.localeCompare(b.name)),
    [technicians, crew],
  )
  const crewJobs = useMemo(
    () => (crew ? jobs.filter(j => j.crew_id === crew.id && j.status !== 'cancelled') : []),
    [jobs, crew],
  )
  const todayJobs = crewJobs.filter(j => j.scheduled_date === todayISO)
  const upcoming = crewJobs.filter(j => j.scheduled_date > todayISO)
  const availableToday = ptoTodayIds == null ? null : members.filter(m => !ptoTodayIds.includes(m.id)).length

  if (!crew) return null
  const pal = crewPalette(crew.color)

  const run = async (fn: () => Promise<string | null>, ok: string) => {
    if (busy) return
    setBusy(true)
    setError(null)
    const msg = await fn()
    setBusy(false)
    if (msg) { setError(msg); return }
    toast.success(ok)
    onSaved()
  }

  const saveName = () => {
    const clean = name.trim()
    if (!clean) { setError('A crew needs a name.'); return }
    if (clean === crew.name) return
    void run(() => renameCrew(supabase, crew.id, clean), `Renamed to ${clean}.`)
  }

  const addMember = (technicianId: string) => {
    const person = technicians.find(t => t.id === technicianId)
    if (!person) return
    // Moving somebody who is already on another crew is a MOVE, and it says so —
    // a person belongs to one crew, so joining this one leaves that one.
    void run(() => setTechnicianCrew(supabase, technicianId, crew.id),
      person.crew_id && person.crew_id !== crew.id
        ? `${person.name} moved to ${crew.name}.`
        : `${person.name} added to ${crew.name}.`)
    setAddId('')
  }

  const removeMember = async (t: Technician) => {
    const ok = await confirm({
      title: `Take ${t.name} off ${crew.name}?`,
      message: 'They stop getting this crew’s work on their phone from now on. Everything they have already done — visits, hours, photos and messages — stays exactly as it is.',
      confirmLabel: 'Take them off',
      icon: UserMinus,
    })
    if (!ok) return
    void run(() => setTechnicianCrew(supabase, t.id, null), `${t.name} is no longer on ${crew.name}.`)
  }

  const toggleActive = async () => {
    if (crew.is_active) {
      const ok = await confirm({
        title: `Deactivate ${crew.name}?`,
        message: upcoming.length > 0
          ? `${upcoming.length} upcoming ${upcoming.length === 1 ? 'visit is' : 'visits are'} still booked to this crew. Deactivating stops it taking NEW work — move those visits to another crew or a person first, or they will have nobody to do them.`
          : 'It stops taking new work and drops out of the assignment lists. Everything it has already done is kept, and you can bring it back any time.',
        confirmLabel: 'Deactivate crew',
        icon: Power,
      })
      if (!ok) return
    }
    void run(() => setCrewActive(supabase, crew.id, !crew.is_active),
      crew.is_active ? `${crew.name} deactivated.` : `${crew.name} is running again.`)
  }

  const removeCrew = async () => {
    const ok = await confirm({
      title: `Delete ${crew.name}?`,
      message: 'This only works for a crew that has never run any work. Anything with history is kept — deactivate that instead.',
      confirmLabel: 'Delete crew',
      destructive: true,
      icon: Trash2,
    })
    if (!ok) return
    setBusy(true)
    const msg = await deleteCrew(supabase, crew.id)
    setBusy(false)
    if (msg) { setError(msg); return }
    toast.success(`${crew.name} deleted.`)
    onSaved()
    onClose()
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={crew.name}
      icon={Users}
      size="md"
      footer={
        <div className="flex items-center gap-2 flex-wrap">
          <Button variant="ghost" onClick={onClose} disabled={busy}>Done</Button>
          <Button variant="ghost" onClick={toggleActive} disabled={busy} className="ml-auto">
            <Power className="w-3.5 h-3.5" /> {crew.is_active ? 'Deactivate' : 'Reactivate'}
          </Button>
          {crewJobs.length === 0 && members.length === 0 && (
            <Button variant="ghost" onClick={removeCrew} disabled={busy}
              title="Only possible while a crew has never run work">
              <Trash2 className="w-3.5 h-3.5" /> Delete
            </Button>
          )}
        </div>
      }
    >
      <div className="space-y-5">
        {error && <Banner tone="danger">{error}</Banner>}
        {!crew.is_active && (
          <Banner tone="warn">
            This crew is deactivated. It takes no new work, and its past visits stay as they are.
          </Banner>
        )}

        {/* 1 — what it is called */}
        <section className="space-y-3">
          <div className="flex items-end gap-2">
            <Input
              label="Crew name"
              value={name}
              fieldSize="sm"
              className="flex-1"
              onChange={e => { setName(e.target.value); setError(null) }}
              onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); saveName() } }}
            />
            <Button size="sm" variant="secondary" onClick={saveName}
              disabled={busy || !name.trim() || name.trim() === crew.name}>
              Rename
            </Button>
          </div>
        </section>

        {/* 2 — who is on it */}
        <section className="space-y-2">
          <div className="flex items-center gap-2">
            <h3 className="text-xs font-semibold text-ink-muted uppercase tracking-wide">
              On this crew
            </h3>
            <span className={cn('text-[11px] rounded px-1.5 py-0.5 border', pal.chip)}>
              {members.length === 0 ? 'Nobody yet' : `${members.length} ${members.length === 1 ? 'person' : 'people'}`}
              {availableToday != null && members.length > 0 && availableToday < members.length &&
                ` · ${members.length - availableToday} off today`}
            </span>
          </div>

          {members.length === 0 ? (
            <p className="text-sm text-ink-muted">
              Nobody is on this crew, so work assigned to it reaches no one’s phone.
            </p>
          ) : (
            <ul className="divide-y divide-border rounded-lg border border-border overflow-hidden">
              {members.map(m => {
                const isLead = crew.lead_technician_id === m.id
                const off = ptoTodayIds?.includes(m.id) ?? false
                return (
                  <li key={m.id} className="flex items-center gap-2 px-3 py-2.5 bg-bg-tertiary/30">
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2 flex-wrap">
                        <span className="text-sm text-ink truncate">{m.name}</span>
                        {isLead && (
                          <span className="inline-flex items-center gap-1 text-[10px] font-semibold uppercase tracking-wide rounded px-1.5 py-0.5 border border-amber-500/30 bg-amber-500/10 text-amber-400">
                            <Star className="w-3 h-3" aria-hidden /> Lead
                          </span>
                        )}
                        {off && (
                          <span className="text-[10px] rounded px-1.5 py-0.5 border border-border bg-bg-tertiary text-ink-faint">
                            Booked off today
                          </span>
                        )}
                      </div>
                      {m.role && <p className="text-[11px] text-ink-faint truncate">{m.role}</p>}
                    </div>
                    <Button size="sm" variant="ghost" disabled={busy}
                      onClick={() => void run(
                        () => setCrewLead(supabase, crew.id, isLead ? null : m.id),
                        isLead ? `${m.name} is no longer the lead.` : `${m.name} leads ${crew.name}.`)}
                      title={isLead ? 'Remove as crew lead' : 'Make crew lead'}>
                      <Star className={cn('w-3.5 h-3.5', isLead && 'text-amber-400')} />
                      <span className="sr-only">{isLead ? 'Remove as lead' : 'Make lead'}</span>
                    </Button>
                    <Button size="sm" variant="ghost" disabled={busy}
                      onClick={() => void removeMember(m)} title={`Take ${m.name} off this crew`}>
                      <UserMinus className="w-3.5 h-3.5" />
                      <span className="sr-only">Take off crew</span>
                    </Button>
                  </li>
                )
              })}
            </ul>
          )}

          {addable.length > 0 && (
            <div className="flex items-end gap-2 pt-1">
              <Select
                label="Add somebody"
                fieldSize="sm"
                className="flex-1"
                value={addId}
                placeholder="Choose a person…"
                onChange={e => setAddId(e.target.value)}
                options={addable.map(t => ({
                  value: t.id,
                  label: t.crew_id ? `${t.name} — moves from their crew` : t.name,
                }))}
              />
              <Button size="sm" variant="secondary" disabled={busy || !addId}
                onClick={() => addMember(addId)}>
                <UserPlus className="w-3.5 h-3.5" /> Add
              </Button>
            </div>
          )}
        </section>

        {/* 3 — what it is booked to do */}
        <section className="space-y-1.5">
          <h3 className="text-xs font-semibold text-ink-muted uppercase tracking-wide">Work</h3>
          <div className="flex items-center gap-2 text-sm text-ink-muted flex-wrap">
            <CalendarDays className="w-3.5 h-3.5 text-ink-faint" aria-hidden />
            <span className="tabular-nums">
              {todayJobs.length === 0 ? 'Nothing booked today' : `${todayJobs.length} today`}
            </span>
            <span className="text-ink-faint">·</span>
            <span className="tabular-nums">
              {upcoming.length === 0 ? 'nothing upcoming' : `${upcoming.length} upcoming`}
            </span>
          </div>
          {members.length === 0 && todayJobs.length > 0 && (
            <Banner tone="danger">
              {todayJobs.length} {todayJobs.length === 1 ? 'visit is' : 'visits are'} booked to this
              crew today and nobody is on it.
            </Banner>
          )}
          {availableToday === 0 && members.length > 0 && todayJobs.length > 0 && (
            <Banner tone="warn">
              Everyone on this crew is booked off today, and {todayJobs.length}{' '}
              {todayJobs.length === 1 ? 'visit is' : 'visits are'} still on them.
            </Banner>
          )}
        </section>

        <p className="text-[11px] text-ink-faint">
          Taking somebody off a crew changes what they get from now on. Their finished visits,
          hours, photos and messages are never rewritten.
        </p>
      </div>
    </Modal>
  )
}
