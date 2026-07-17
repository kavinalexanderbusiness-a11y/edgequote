'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import Link from 'next/link'
import { format } from 'date-fns'
import { createClient } from '@/lib/supabase/client'
import type { Holiday, PtoEntry, PtoKind, Technician } from '@/types'
import { PTO_KIND_LABELS } from '@/types'
import { loadTechnicians } from '@/lib/crews'
import { ptoBalances, holidayPtoRows, ptoPay, parseDateOnly } from '@/lib/pto'
import { exportRowsToCsv } from '@/lib/csv'
import { PageHeader } from '@/components/layout/PageHeader'
import { Card, CardBody } from '@/components/ui/Card'
import { Button } from '@/components/ui/Button'
import { Input } from '@/components/ui/Input'
import { Select } from '@/components/ui/Select'
import { Toggle } from '@/components/ui/Toggle'
import { Modal } from '@/components/ui/Modal'
import { StatTile } from '@/components/ui/StatTile'
import { FilterPill } from '@/components/ui/FilterPill'
import { Banner } from '@/components/ui/Banner'
import { EmptyState, InlineEmpty } from '@/components/ui/EmptyState'
import { SkeletonTiles, SkeletonRows } from '@/components/ui/Skeleton'
import { toast as notify } from '@/lib/toast'
import { confirm } from '@/lib/confirm'
import { formatCurrency, cn } from '@/lib/utils'
import {
  Palmtree, Plus, Trash2, AlertTriangle, Download, HardHat, CalendarDays, Info, Wallet, Check,
} from 'lucide-react'

// ── Time off ─────────────────────────────────────────────────────────────────
// PTO balances, the leave ledger, and the holiday calendar. All maths from
// lib/pto; this file renders and persists.
//
// PTO lives here and NOT on the timesheet on purpose: the timesheet is hours
// WORKED (time_entries). Time off is hours NOT worked. Keeping the two apart on
// screen mirrors why they're apart in the database — so a vacation day can never
// be mistaken for worked time and trigger overtime.

type Tab = 'balances' | 'entries' | 'holidays'

export default function TimeOffPage() {
  const supabase = useMemo(() => createClient(), [])
  const [uid, setUid] = useState<string | null>(null)
  const [techs, setTechs] = useState<Technician[]>([])
  const [entries, setEntries] = useState<PtoEntry[]>([])
  const [holidays, setHolidays] = useState<Holiday[]>([])
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [tab, setTab] = useState<Tab>('balances')
  const [year, setYear] = useState(() => new Date().getFullYear())
  const [addOpen, setAddOpen] = useState(false)
  const [holidayOpen, setHolidayOpen] = useState(false)
  const [busy, setBusy] = useState(false)

  const fetchAll = useCallback(async () => {
    try {
      const { data: { session } } = await supabase.auth.getSession()
      const user = session?.user
      if (!user) { setLoadError('Session expired — sign in again.'); return }
      setUid(user.id)
      const [t, pRes, hRes] = await Promise.all([
        loadTechnicians(supabase, user.id),
        supabase.from('pto_entries').select('*').eq('user_id', user.id).order('date', { ascending: false }),
        supabase.from('holidays').select('*').eq('user_id', user.id).order('date'),
      ])
      setTechs(t)
      setEntries((pRes.data as PtoEntry[]) ?? [])
      setHolidays((hRes.data as Holiday[]) ?? [])
      setLoadError(null)
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : 'Could not load time off.')
    } finally {
      setLoading(false)
    }
  }, [supabase])

  useEffect(() => { fetchAll() }, [fetchAll])

  const active = useMemo(() => techs.filter(t => t.is_active), [techs])
  const balances = useMemo(() => ptoBalances(entries, active, year), [entries, active, year])
  const yearEntries = useMemo(
    () => entries.filter(e => parseDateOnly(e.date).getFullYear() === year),
    [entries, year],
  )
  const techById = useMemo(() => Object.fromEntries(techs.map(t => [t.id, t])), [techs])
  const years = useMemo(() => {
    const s = new Set<number>([new Date().getFullYear()])
    for (const e of entries) s.add(parseDateOnly(e.date).getFullYear())
    return Array.from(s).sort((a, b) => b - a)
  }, [entries])

  const totals = useMemo(() => ({
    paidHours: Math.round(yearEntries.filter(e => e.is_paid).reduce((s, e) => s + Number(e.hours), 0) * 100) / 100,
    unpaidHours: Math.round(yearEntries.filter(e => !e.is_paid).reduce((s, e) => s + Number(e.hours), 0) * 100) / 100,
    cost: Math.round(yearEntries.reduce((s, e) => s + ptoPay(e), 0) * 100) / 100,
  }), [yearEntries])

  async function deleteEntry(e: PtoEntry) {
    const { error } = await supabase.from('pto_entries').delete().eq('id', e.id)
    if (error) { notify.error('Could not delete: ' + error.message); return }
    setEntries(prev => prev.filter(x => x.id !== e.id))
    notify.success('Time off removed.')
  }

  async function deleteHoliday(h: Holiday) {
    const ok = await confirm({
      title: `Remove ${h.name}?`,
      message: 'This removes it from the holiday calendar. Time off already given to people for this day stays — remove those separately if you need to.',
      confirmLabel: 'Remove holiday',
      destructive: true,
    })
    if (!ok) return
    const { error } = await supabase.from('holidays').delete().eq('id', h.id)
    if (error) { notify.error('Could not remove: ' + error.message); return }
    fetchAll()
  }

  // Apply a holiday to the roster — previewed by the engine, written here.
  async function applyHoliday(h: Holiday) {
    const rows = holidayPtoRows(h, active, entries)
    if (!rows.length) { notify.error('Everyone eligible already has this holiday.'); return }
    setBusy(true)
    const { error } = await supabase.from('pto_entries').insert(rows.map(r => ({ ...r, user_id: uid })))
    setBusy(false)
    if (error) { notify.error('Could not apply: ' + error.message); return }
    const cost = rows.reduce((s, r) => s + (r.is_paid && r.hourly_rate != null ? r.hours * r.hourly_rate : 0), 0)
    notify.success(`${h.name} given to ${rows.length} ${rows.length !== 1 ? 'people' : 'person'}${cost > 0 ? ` — ${formatCurrency(cost)}` : ''}.`)
    fetchAll()
  }

  function exportEntries() {
    if (!yearEntries.length) { notify.error('No time off to export.'); return }
    exportRowsToCsv(`time-off-${year}`, yearEntries, [
      { label: 'Employee', value: e => techById[e.technician_id]?.name ?? 'Removed technician' },
      { label: 'Date', value: e => e.date.slice(0, 10) },
      { label: 'Kind', value: e => PTO_KIND_LABELS[e.kind] },
      { label: 'Hours', value: e => Number(e.hours) },
      { label: 'Paid', value: e => (e.is_paid ? 'Yes' : 'No') },
      { label: 'Rate', value: e => e.hourly_rate ?? '' },
      { label: 'Pay', value: e => ptoPay(e) },
      { label: 'Notes', value: e => e.notes ?? '' },
    ])
    notify.success(`Exported ${yearEntries.length} row${yearEntries.length !== 1 ? 's' : ''} to CSV.`)
  }

  if (loading) {
    return (
      <div className="max-w-5xl space-y-5">
        <PageHeader crumb={{ label: 'Workforce', href: '/dashboard/workforce' }} title="Time off"
          description="Vacation, sick days and holidays — and what they cost." />
        <SkeletonTiles count={3} />
        <SkeletonRows count={4} />
      </div>
    )
  }

  return (
    <div className="max-w-5xl space-y-5">
      <PageHeader
        crumb={{ label: 'Workforce', href: '/dashboard/workforce' }}
        title="Time off"
        description="Vacation, sick days and holidays — and what they cost."
        action={
          <div className="flex items-center gap-2">
            <Button variant="secondary" size="sm" onClick={() => setHolidayOpen(true)}>
              <CalendarDays className="w-3.5 h-3.5" /> Add holiday
            </Button>
            <Button size="sm" onClick={() => setAddOpen(true)} disabled={!active.length}>
              <Plus className="w-3.5 h-3.5" /> Book time off
            </Button>
          </div>
        }
      />

      {loadError && (
        <Banner tone="danger" icon={AlertTriangle}
          action={<Button size="sm" variant="secondary" onClick={() => { setLoading(true); fetchAll() }}>Retry</Button>}>
          {loadError}
        </Banner>
      )}

      {active.length === 0 ? (
        <Card>
          <EmptyState icon={HardHat} className="py-12" title="No one on the roster yet"
            description="Add the people who work for you, then you can book their time off here."
            action={{ label: 'Add your people', href: '/dashboard/dispatch?roster=1' }} />
        </Card>
      ) : (
        <>
          <div className="grid grid-cols-3 gap-3">
            <StatTile label={`Paid time off ${year}`} value={`${totals.paidHours} h`} sub={formatCurrency(totals.cost)} icon={Palmtree} accent />
            <StatTile label="Unpaid leave" value={`${totals.unpaidHours} h`} sub={totals.unpaidHours ? 'Tracked, not paid' : 'None'} icon={CalendarDays} />
            <StatTile label="Holidays" value={String(holidays.filter(h => parseDateOnly(h.date).getFullYear() === year).length)} sub={`in ${year}`} icon={CalendarDays} />
          </div>

          {/* Overtime is the thing people get wrong here — say it once, clearly. */}
          <Banner tone="info" icon={Info}>
            Time off is <span className="font-semibold">not hours worked</span>, so it never counts
            toward an overtime threshold — 40 hours worked plus a vacation day is 40 hours for
            overtime, not 48. It’s paid at each person’s rate and shows up on their{' '}
            <Link href="/dashboard/dispatch/payroll" className="underline font-semibold">payroll</Link>.
          </Banner>

          <div className="flex items-center gap-1.5 flex-wrap">
            <FilterPill active={tab === 'balances'} onClick={() => setTab('balances')}>Balances</FilterPill>
            <FilterPill active={tab === 'entries'} onClick={() => setTab('entries')}>Booked ({yearEntries.length})</FilterPill>
            <FilterPill active={tab === 'holidays'} onClick={() => setTab('holidays')}>Holidays ({holidays.length})</FilterPill>
            <div className="ml-auto flex items-center gap-1.5">
              {years.length > 1 && (
                <Select fieldSize="sm" value={String(year)} onChange={e => setYear(Number(e.target.value))}
                  options={years.map(y => ({ value: String(y), label: String(y) }))} aria-label="Year" />
              )}
              {tab === 'entries' && (
                <Button variant="secondary" size="sm" onClick={exportEntries} disabled={!yearEntries.length}>
                  <Download className="w-3.5 h-3.5" /> CSV
                </Button>
              )}
            </div>
          </div>

          {/* ── Balances ── */}
          {tab === 'balances' && (
            <Card>
              <CardBody className="p-0">
                <div className="divide-y divide-border">
                  {balances.map(b => (
                    <div key={b.technicianId} className="px-5 py-3 flex items-center gap-3">
                      <div className="min-w-0 flex-1">
                        <p className="text-sm font-medium text-ink truncate">{b.name}</p>
                        <p className="text-[11px] text-ink-faint tabular-nums">
                          {b.usedHours} h used
                          {b.byKind.holiday > 0 && ` · ${b.byKind.holiday} h holiday`}
                          {b.unpaidHours > 0 && ` · ${b.unpaidHours} h unpaid`}
                          {b.allowanceHours == null && ' · no allowance set'}
                        </p>
                      </div>
                      {b.allowanceHours == null ? (
                        <span className="text-[11px] text-ink-faint shrink-0">Tracking usage only</span>
                      ) : (
                        <div className="flex items-center gap-2 shrink-0">
                          <span className="w-16 h-1.5 rounded-full bg-border overflow-hidden hidden sm:block">
                            <span className={cn('block h-full rounded-full',
                              (b.remainingHours ?? 0) < 0 ? 'bg-red-400' : 'bg-accent/80')}
                              style={{ width: `${Math.min(100, Math.max(2, (b.usedHours / Math.max(1, b.allowanceHours)) * 100))}%` }} />
                          </span>
                          <span className={cn('text-sm font-bold tabular-nums w-20 text-right',
                            (b.remainingHours ?? 0) < 0 ? 'text-red-400' : 'text-ink')}>
                            {b.remainingHours} h left
                          </span>
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              </CardBody>
            </Card>
          )}

          {/* ── Entries ── */}
          {tab === 'entries' && (
            <Card>
              <CardBody className="p-0">
                {yearEntries.length === 0 ? (
                  <InlineEmpty icon={Palmtree}>No time off booked in {year}.</InlineEmpty>
                ) : (
                  <div className="divide-y divide-border">
                    {yearEntries.map(e => (
                      <div key={e.id} className="px-5 py-3 flex items-center gap-3">
                        <div className="min-w-0 flex-1">
                          <p className="text-sm font-medium text-ink truncate">
                            {techById[e.technician_id]?.name ?? 'Removed technician'}
                            <span className="text-[11px] font-normal text-ink-faint"> · {PTO_KIND_LABELS[e.kind]}</span>
                            {!e.is_paid && <span className="text-[11px] font-normal text-amber-400"> · unpaid</span>}
                          </p>
                          <p className="text-[11px] text-ink-faint tabular-nums">
                            {format(parseDateOnly(e.date), 'EEE MMM d, yyyy')} · {Number(e.hours)} h
                            {e.hourly_rate != null && e.is_paid && ` · ${formatCurrency(Number(e.hourly_rate))}/hr`}
                            {e.notes && ` · ${e.notes}`}
                          </p>
                        </div>
                        <span className="text-sm font-bold text-ink tabular-nums shrink-0">
                          {e.is_paid && e.hourly_rate == null ? '—' : formatCurrency(ptoPay(e))}
                        </span>
                        <Button variant="ghost" size="sm" onClick={() => deleteEntry(e)}
                          className="hover:text-red-400 shrink-0" title="Remove">
                          <Trash2 className="w-3.5 h-3.5" />
                        </Button>
                      </div>
                    ))}
                  </div>
                )}
              </CardBody>
            </Card>
          )}

          {/* ── Holidays ── */}
          {tab === 'holidays' && (
            <Card>
              <CardBody className="p-0">
                {holidays.length === 0 ? (
                  <EmptyState icon={CalendarDays} className="py-10" title="No holidays yet"
                    description="Add the days your business treats as holidays. EdgeQuote doesn't assume them — which days are paid, and who qualifies, differs by province."
                    action={{ label: 'Add holiday', onClick: () => setHolidayOpen(true) }} />
                ) : (
                  <div className="divide-y divide-border">
                    {holidays.map(h => {
                      const given = entries.filter(e => e.holiday_id === h.id).length
                      return (
                        <div key={h.id} className="px-5 py-3 flex items-center gap-3 flex-wrap">
                          <div className="min-w-0 flex-1">
                            <p className="text-sm font-medium text-ink truncate">
                              {h.name}
                              {!h.is_paid && <span className="text-[11px] font-normal text-ink-faint"> · unpaid</span>}
                            </p>
                            <p className="text-[11px] text-ink-faint tabular-nums">
                              {format(parseDateOnly(h.date), 'EEE MMM d, yyyy')} · {Number(h.default_hours)} h
                              {given > 0 && ` · given to ${given} ${given !== 1 ? 'people' : 'person'}`}
                            </p>
                          </div>
                          <Button variant="secondary" size="sm" loading={busy} onClick={() => applyHoliday(h)} className="shrink-0">
                            <Check className="w-3.5 h-3.5" /> {given > 0 ? 'Apply to the rest' : 'Give to everyone'}
                          </Button>
                          <Button variant="ghost" size="sm" onClick={() => deleteHoliday(h)}
                            className="hover:text-red-400 shrink-0" title="Remove holiday">
                            <Trash2 className="w-3.5 h-3.5" />
                          </Button>
                        </div>
                      )
                    })}
                  </div>
                )}
              </CardBody>
            </Card>
          )}
        </>
      )}

      <p className="text-[11px] text-ink-faint text-center">
        Time off is paid at the rate stamped when it was booked, so a raise never re-values a
        vacation day someone already took. EdgeQuote doesn’t decide statutory holiday eligibility.
      </p>

      {addOpen && uid && (
        <BookTimeOffDialog supabase={supabase} userId={uid} technicians={active}
          onClose={() => setAddOpen(false)} onSaved={fetchAll} />
      )}
      {holidayOpen && uid && (
        <AddHolidayDialog supabase={supabase} userId={uid}
          onClose={() => setHolidayOpen(false)} onSaved={fetchAll} />
      )}
    </div>
  )
}

// ── Book time off ────────────────────────────────────────────────────────────
function BookTimeOffDialog({ supabase, userId, technicians, onClose, onSaved }: {
  supabase: ReturnType<typeof createClient>; userId: string; technicians: Technician[]
  onClose: () => void; onSaved: () => void
}) {
  const [techId, setTechId] = useState(technicians[0]?.id ?? '')
  const [date, setDate] = useState(format(new Date(), 'yyyy-MM-dd'))
  const [hours, setHours] = useState('8')
  const [kind, setKind] = useState<PtoKind>('vacation')
  const [paid, setPaid] = useState(true)
  const [notes, setNotes] = useState('')
  const [saving, setSaving] = useState(false)

  const tech = technicians.find(t => t.id === techId)
  const h = Number(hours) || 0
  const rate = tech?.hourly_wage == null ? null : Number(tech.hourly_wage)
  const cost = paid && rate != null ? Math.round(h * rate * 100) / 100 : 0
  const invalid = !techId || !date || h <= 0 || h > 24

  async function save() {
    if (invalid) return
    setSaving(true)
    const { error } = await supabase.from('pto_entries').insert({
      user_id: userId, technician_id: techId, date, hours: h, kind, is_paid: paid,
      // Snapshot the wage NOW — same rule as clock-in.
      hourly_rate: paid ? rate : null,
      notes: notes.trim() || null,
    })
    setSaving(false)
    if (error) {
      if (error.code === '23505') { notify.error(`${tech?.name} already has ${PTO_KIND_LABELS[kind].toLowerCase()} booked on that day.`); return }
      notify.error('Could not book: ' + error.message); return
    }
    notify.success(`${PTO_KIND_LABELS[kind]} booked for ${tech?.name}.`)
    onSaved(); onClose()
  }

  return (
    <Modal open onClose={onClose} title="Book time off" icon={Palmtree} size="md" onSubmit={save}
      footer={
        <div className="flex items-center justify-end gap-2">
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button onClick={save} loading={saving} disabled={invalid}>Book time off</Button>
        </div>
      }>
      <div className="space-y-3">
        <Select label="Who" value={techId} onChange={e => setTechId(e.target.value)}
          options={technicians.map(t => ({ value: t.id, label: t.name }))} />
        <div className="grid grid-cols-2 gap-3">
          <Input label="Date" type="date" value={date} onChange={e => setDate(e.target.value)} />
          <Input label="Hours" type="number" min="0.5" max="24" step="0.5" value={hours}
            onChange={e => setHours(e.target.value)}
            error={h > 24 ? 'A day is 24 hours at most' : undefined} />
        </div>
        <Select label="Kind" value={kind} onChange={e => setKind(e.target.value as PtoKind)}
          options={(Object.keys(PTO_KIND_LABELS) as PtoKind[]).map(k => ({ value: k, label: PTO_KIND_LABELS[k] }))} />
        <div>
          <Toggle checked={paid} onChange={setPaid} label="Paid" />
          <p className="text-[11px] text-ink-faint mt-1">
            {paid ? 'Counts toward pay at their rate.' : 'Tracked as absence, but not paid.'}
          </p>
        </div>
        <Input label="Notes" value={notes} onChange={e => setNotes(e.target.value)} placeholder="Optional" />

        <div className="rounded-xl border border-border bg-bg-tertiary px-3.5 py-2.5 flex items-center justify-between">
          <span className="text-xs text-ink-muted">This costs</span>
          <span className="text-sm font-bold text-ink tabular-nums">
            {!paid ? 'Unpaid' : rate == null ? 'No wage set — hours only' : formatCurrency(cost)}
          </span>
        </div>
        <p className="text-[11px] text-ink-faint">
          Doesn’t count as hours worked, so it never triggers overtime.
        </p>
      </div>
    </Modal>
  )
}

// ── Add holiday ──────────────────────────────────────────────────────────────
function AddHolidayDialog({ supabase, userId, onClose, onSaved }: {
  supabase: ReturnType<typeof createClient>; userId: string; onClose: () => void; onSaved: () => void
}) {
  const [date, setDate] = useState(format(new Date(), 'yyyy-MM-dd'))
  const [name, setName] = useState('')
  const [hours, setHours] = useState('8')
  const [paid, setPaid] = useState(true)
  const [saving, setSaving] = useState(false)
  const invalid = !date || !name.trim()

  async function save() {
    if (invalid) return
    setSaving(true)
    const { error } = await supabase.from('holidays').insert({
      user_id: userId, date, name: name.trim(), is_paid: paid, default_hours: Number(hours) || 8,
    })
    setSaving(false)
    if (error) {
      if (error.code === '23505') { notify.error('There is already a holiday on that date.'); return }
      notify.error('Could not add: ' + error.message); return
    }
    notify.success(`${name.trim()} added to the holiday calendar.`)
    onSaved(); onClose()
  }

  return (
    <Modal open onClose={onClose} title="Add a holiday" icon={CalendarDays} size="md" onSubmit={save}
      footer={
        <div className="flex items-center justify-end gap-2">
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button onClick={save} loading={saving} disabled={invalid}>Add holiday</Button>
        </div>
      }>
      <div className="space-y-3">
        <Input label="Name" value={name} onChange={e => setName(e.target.value)} placeholder="e.g. Canada Day" />
        <div className="grid grid-cols-2 gap-3">
          <Input label="Date" type="date" value={date} onChange={e => setDate(e.target.value)} />
          <Input label="Hours to pay" type="number" min="0" max="24" step="0.5" value={hours}
            onChange={e => setHours(e.target.value)} hint="Per person" />
        </div>
        <div>
          <Toggle checked={paid} onChange={setPaid} label="Paid holiday" />
          <p className="text-[11px] text-ink-faint mt-1">
            {paid ? 'Everyone eligible gets these hours at their rate.' : 'Marked on the calendar, but not paid.'}
          </p>
        </div>

        <Banner tone="info" icon={Info}>
          EdgeQuote doesn’t decide who qualifies for statutory holiday pay or how it’s calculated —
          the rules and the formula differ by province. You set the hours; adding a holiday here
          never pays anyone until you give it to them.
        </Banner>
      </div>
    </Modal>
  )
}
