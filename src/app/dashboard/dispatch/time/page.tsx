'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import Link from 'next/link'
import { format, startOfWeek, endOfWeek, startOfDay, endOfDay } from 'date-fns'
import { createClient } from '@/lib/supabase/client'
import { useRealtimeRefresh } from '@/hooks/useRealtime'
import { Technician, TimeEntry } from '@/types'
import { loadTechnicians } from '@/lib/crews'
import {
  loadTimeEntries, clockIn, clockOut, openEntryFor, entryMinutes, entryCost,
  formatDuration, decimalHours, totals, isOpen,
} from '@/lib/timeTracking'
import { TimeEntryEditor } from '@/components/dispatch/TimeEntryEditor'
import { PageHeader } from '@/components/layout/PageHeader'
import { Card, CardBody } from '@/components/ui/Card'
import { Button } from '@/components/ui/Button'
import { StatTile } from '@/components/ui/StatTile'
import { FilterPill } from '@/components/ui/FilterPill'
import { Banner } from '@/components/ui/Banner'
import { EmptyState, InlineEmpty } from '@/components/ui/EmptyState'
import { SkeletonTiles, SkeletonRows } from '@/components/ui/Skeleton'
import { toast as notify } from '@/lib/toast'
import { formatCurrency, cn } from '@/lib/utils'
import { HardHat, Play, Square, Clock, DollarSign, Trash2, AlertTriangle, Pencil, Wallet, BarChart3 } from 'lucide-react'

type Period = 'today' | 'week'

// ── Timesheet ────────────────────────────────────────────────────────────────
// Clock in/out and the paid-time ledger for the roster. All duration and cost
// maths comes from lib/timeTracking (the ONE engine) — this file only renders.
//
// Lives under /dashboard/dispatch because `technicians` IS the roster the
// dispatch module owns; a separate "employees" area would imply a second people
// system, which is exactly what doesn't exist here.
export default function TimesheetPage() {
  const supabase = useMemo(() => createClient(), [])
  const [uid, setUid] = useState<string | null>(null)
  const [techs, setTechs] = useState<Technician[]>([])
  const [entries, setEntries] = useState<TimeEntry[]>([])
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [period, setPeriod] = useState<Period>('today')
  const [busy, setBusy] = useState<string | null>(null)
  const [editing, setEditing] = useState<TimeEntry | null>(null)
  // Open shifts have no DB duration yet, so their elapsed time is computed live.
  // One shared clock ticking each 30s — not a timer per row.
  const [now, setNow] = useState(() => new Date())
  useEffect(() => {
    const h = window.setInterval(() => setNow(new Date()), 30_000)
    return () => window.clearInterval(h)
  }, [])

  const range = useMemo(() => {
    const base = new Date()
    return period === 'today'
      ? { from: startOfDay(base), to: endOfDay(base) }
      : { from: startOfWeek(base, { weekStartsOn: 1 }), to: endOfWeek(base, { weekStartsOn: 1 }) }
  }, [period])

  const fetchAll = useCallback(async () => {
    try {
      const { data: { session } } = await supabase.auth.getSession()
      const user = session?.user
      if (!user) { setLoadError('Session expired — sign in again.'); return }
      setUid(user.id)
      const [t, e] = await Promise.all([
        loadTechnicians(supabase, user.id),
        loadTimeEntries(supabase, user.id, { fromISO: range.from.toISOString(), toISO: range.to.toISOString() }),
      ])
      // An open shift started before this window still needs its Clock out
      // button, or it becomes unstoppable from the screen that owns it.
      const open = await loadTimeEntries(supabase, user.id, {})
        .then(all => all.filter(isOpen))
        .catch(() => [] as TimeEntry[])
      const merged = [...e]
      for (const o of open) if (!merged.some(x => x.id === o.id)) merged.push(o)
      setTechs(t)
      setEntries(merged)
      setLoadError(null)
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : 'Could not load the timesheet.')
    } finally {
      setLoading(false)
    }
  }, [supabase, range.from, range.to])

  useEffect(() => { fetchAll() }, [fetchAll])
  useRealtimeRefresh('time_entries', uid ? `user_id=eq.${uid}` : null, fetchAll)

  async function doClockIn(t: Technician) {
    setBusy(t.id)
    const res = await clockIn(supabase, { userId: uid!, technician: t })
    setBusy(null)
    if (!res.ok) { notify.error(res.error); return }
    notify.success(
      t.hourly_wage == null
        ? `${t.name} clocked in — no wage set, so this shift records hours only.`
        : `${t.name} clocked in at ${formatCurrency(Number(t.hourly_wage))}/hr.`,
    )
    fetchAll()
  }

  async function doClockOut(t: Technician, entry: TimeEntry) {
    setBusy(t.id)
    const res = await clockOut(supabase, entry.id)
    setBusy(null)
    if (!res.ok) { notify.error(res.error); fetchAll(); return }
    notify.success(`${t.name} clocked out — ${formatDuration(res.entry.minutes_worked ?? 0)} recorded.`)
    fetchAll()
  }

  async function deleteEntry(e: TimeEntry) {
    const row = { ...e } as Record<string, unknown>
    delete row.minutes_worked   // generated — re-inserting it is rejected by Postgres
    const { error } = await supabase.from('time_entries').delete().eq('id', e.id)
    if (error) { notify.error('Could not delete: ' + error.message); return }
    setEntries(prev => prev.filter(x => x.id !== e.id))
    notify.undo('Shift deleted', async () => {
      await supabase.from('time_entries').insert(row)
      fetchAll()
    })
  }

  const inRange = useMemo(
    () => entries.filter(e => {
      const t = new Date(e.clock_in).getTime()
      return t >= range.from.getTime() && t <= range.to.getTime()
    }),
    [entries, range.from, range.to],
  )
  const sum = useMemo(() => totals(inRange, now), [inRange, now])
  const openCount = useMemo(() => entries.filter(isOpen).length, [entries])
  const unpaidRated = useMemo(() => inRange.some(e => e.hourly_rate == null), [inRange])
  const techById = useMemo(() => Object.fromEntries(techs.map(t => [t.id, t])), [techs])
  const active = useMemo(() => techs.filter(t => t.is_active), [techs])

  if (loading) {
    return (
      <div className="max-w-5xl space-y-5">
        <PageHeader crumb={{ label: 'Workforce', href: '/dashboard/workforce' }} title="Timesheet"
          description="Clock your people in and out, and see what the hours cost." />
        <SkeletonTiles count={3} className="grid-cols-3 lg:grid-cols-3" />
        <SkeletonRows count={4} />
      </div>
    )
  }

  return (
    <div className="max-w-5xl space-y-5">
      <PageHeader
        crumb={{ label: 'Workforce', href: '/dashboard/workforce' }}
        title="Timesheet"
        description="Clock your people in and out, and see what the hours cost."
        action={
          <div className="flex items-center gap-2">
            <Link href="/dashboard/dispatch/labor">
              <Button variant="secondary" size="sm"><BarChart3 className="w-3.5 h-3.5" /> Labour</Button>
            </Link>
            <Link href="/dashboard/dispatch/payroll">
              <Button variant="secondary" size="sm"><Wallet className="w-3.5 h-3.5" /> Payroll</Button>
            </Link>
          </div>
        }
      />

      {loadError && (
        <Banner tone="danger" icon={AlertTriangle}
          action={<Button size="sm" variant="secondary" onClick={() => { setLoading(true); fetchAll() }}>Retry</Button>}>
          {loadError}
        </Banner>
      )}

      <div className="grid grid-cols-3 gap-3">
        <StatTile label={period === 'today' ? 'Hours today' : 'Hours this week'} icon={Clock}
          value={formatDuration(sum.minutes)} sub={`${decimalHours(sum.minutes)} h · ${sum.entries} shift${sum.entries !== 1 ? 's' : ''}`} />
        <StatTile label="Labour cost" icon={DollarSign} value={formatCurrency(sum.cost)}
          sub={unpaidRated ? 'Some shifts have no wage' : 'From each shift’s own rate'} accent />
        <StatTile label="On the clock" icon={HardHat} value={String(openCount)}
          sub={openCount ? 'Counting up now' : 'Nobody clocked in'} tone={openCount ? 'success' : undefined} tonedSurface={openCount > 0} />
      </div>

      <div className="flex items-center gap-1.5">
        <FilterPill active={period === 'today'} onClick={() => setPeriod('today')}>Today</FilterPill>
        <FilterPill active={period === 'week'} onClick={() => setPeriod('week')}>This week</FilterPill>
        <span className="ml-auto text-[11px] text-ink-faint tabular-nums">
          {format(range.from, 'MMM d')}{period === 'week' ? ` – ${format(range.to, 'MMM d')}` : ''}
        </span>
      </div>

      {/* ── Roster: the clock ── */}
      {active.length === 0 ? (
        <Card>
          <EmptyState icon={HardHat} title="No one on the roster yet"
            description="Add the people who work for you, then you can clock them in here."
            action={{ label: 'Add your people', href: '/dashboard/dispatch?roster=1' }} />
        </Card>
      ) : (
        <div className="space-y-2">
          {active.map((t, i) => {
            const open = openEntryFor(entries, t.id)
            return (
              <Card key={t.id} className={cn('card-lift animate-rise', i < 6 && `stagger-${i + 1}`, open && 'border-emerald-500/30')}>
                <CardBody className="flex flex-wrap items-center gap-3 py-3.5">
                  <div className="min-w-0 flex-1">
                    <p className="text-sm font-semibold text-ink truncate flex items-center gap-2">
                      {open && <span aria-hidden className="w-1.5 h-1.5 rounded-full bg-emerald-400 shrink-0" />}
                      {t.name}
                      {t.role && <span className="text-[11px] font-normal text-ink-faint">· {t.role}</span>}
                    </p>
                    <p className="text-[11px] text-ink-faint tabular-nums mt-0.5">
                      {t.hourly_wage == null
                        ? 'No wage set — hours only'
                        : `${formatCurrency(Number(t.hourly_wage))}/hr`}
                      {open && ` · on the clock since ${format(new Date(open.clock_in), 'h:mm a')}`}
                    </p>
                  </div>
                  {open && (
                    <span className="text-sm font-bold text-emerald-400 tabular-nums shrink-0">
                      {formatDuration(entryMinutes(open, now))}
                    </span>
                  )}
                  {open ? (
                    <Button size="sm" variant="secondary" onClick={() => doClockOut(t, open)} loading={busy === t.id}>
                      <Square className="w-3.5 h-3.5" /> Clock out
                    </Button>
                  ) : (
                    <Button size="sm" onClick={() => doClockIn(t)} loading={busy === t.id}>
                      <Play className="w-3.5 h-3.5" /> Clock in
                    </Button>
                  )}
                </CardBody>
              </Card>
            )
          })}
        </div>
      )}

      {/* ── Entries ── */}
      <Card>
        <CardBody className="p-0">
          <div className="px-5 py-3 border-b border-border flex items-center justify-between">
            <h2 className="text-sm font-semibold text-ink">{period === 'today' ? 'Today’s shifts' : 'This week’s shifts'}</h2>
            <span className="text-[11px] text-ink-faint tabular-nums">{inRange.length} shift{inRange.length !== 1 ? 's' : ''}</span>
          </div>
          {inRange.length === 0 ? (
            <InlineEmpty icon={Clock}>
              No shifts {period === 'today' ? 'today' : 'this week'} yet — clock someone in above.
            </InlineEmpty>
          ) : (
            <div className="divide-y divide-border">
              {inRange.map(e => {
                const t = techById[e.technician_id]
                return (
                  <div key={e.id} className="px-5 py-3 flex flex-wrap items-center gap-3">
                    <div className="min-w-0 flex-1">
                      <p className="text-sm font-medium text-ink truncate">{t?.name ?? 'Removed technician'}</p>
                      <p className="text-[11px] text-ink-faint tabular-nums">
                        {format(new Date(e.clock_in), 'MMM d, h:mm a')} → {e.clock_out ? format(new Date(e.clock_out), 'h:mm a') : 'now'}
                        {e.break_minutes > 0 && ` · ${e.break_minutes}m break`}
                        {e.hourly_rate != null && ` · ${formatCurrency(Number(e.hourly_rate))}/hr`}
                      </p>
                    </div>
                    <div className="text-right shrink-0 w-20">
                      <p className={cn('text-sm font-bold tabular-nums', isOpen(e) ? 'text-emerald-400' : 'text-ink')}>
                        {formatDuration(entryMinutes(e, now))}
                      </p>
                      <p className="text-[11px] text-ink-faint tabular-nums">
                        {e.hourly_rate == null ? '—' : formatCurrency(entryCost(e, now))}
                      </p>
                    </div>
                    {/* ONE editing path — times, break and notes all live in the
                        editor, so there is no second way to change a shift. */}
                    <Button variant="secondary" size="sm" onClick={() => setEditing(e)} className="shrink-0" title="Edit this shift">
                      <Pencil className="w-3.5 h-3.5" /> Edit
                    </Button>
                    <Button variant="ghost" size="sm" onClick={() => deleteEntry(e)}
                      className="hover:text-red-400 shrink-0" title="Delete shift">
                      <Trash2 className="w-3.5 h-3.5" />
                    </Button>
                  </div>
                )
              })}
            </div>
          )}
        </CardBody>
      </Card>

      <p className="text-[11px] text-ink-faint text-center">
        Each shift keeps the wage it was clocked in at, so changing someone&rsquo;s rate never rewrites past hours.
      </p>

      {editing && techById[editing.technician_id] && (
        <TimeEntryEditor
          open
          entry={editing}
          technicianName={techById[editing.technician_id]?.name ?? 'this technician'}
          supabase={supabase}
          onClose={() => setEditing(null)}
          onSaved={fetchAll}
        />
      )}
    </div>
  )
}
