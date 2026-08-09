'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import Link from 'next/link'
import { format, startOfWeek, endOfWeek, startOfDay, endOfDay } from 'date-fns'
import { createClient } from '@/lib/supabase/client'
import { useRealtimeRefresh } from '@/hooks/useRealtime'
import { BusinessSettings, Technician, TimeEntry } from '@/types'
import { loadTechnicians } from '@/lib/crews'
import { payrollRules, type WeekDay } from '@/lib/payroll'
import {
  loadTimeEntries, clockIn, clockOut, openEntryFor, entryMinutes, entryCost,
  formatDuration, decimalHours, totals, isOpen, openSinceLabel, isStaleOpen,
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
  // Set when the sweep for open shifts started BEFORE the window failed. Kept
  // apart from loadError because the rest of the page still loaded — but "nobody
  // is on the clock" must never be inferred from a query that never answered.
  const [openSweepError, setOpenSweepError] = useState<string | null>(null)
  const [period, setPeriod] = useState<Period>('today')
  // The OT work week the owner set in Settings → Payroll. Until settings land we
  // assume nothing and simply don't offer the week view — see `range`.
  const [weekStartsOn, setWeekStartsOn] = useState<WeekDay | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [editing, setEditing] = useState<TimeEntry | null>(null)
  // Open shifts have no DB duration yet, so their elapsed time is computed live.
  // One shared clock ticking each 30s — not a timer per row.
  const [now, setNow] = useState(() => new Date())
  useEffect(() => {
    const h = window.setInterval(() => setNow(new Date()), 30_000)
    return () => window.clearInterval(h)
  }, [])

  // "This week" is the WORK WEEK — the boundary lib/payroll judges overtime
  // against (business_settings.pay_week_starts_on), not a hardcoded Monday.
  //
  // It was hardcoded to Monday. An owner who set the work week to Sunday in
  // Settings → Payroll got a timesheet totalling Mon–Sun while payroll charged
  // overtime on Sun–Sat: the one screen you check to answer "has Dave hit 44 yet"
  // was counting a different seven days from the screen that decides what he's
  // paid, and the two disagreed by a whole shift at each end.
  //
  // Exposed as ISO strings because the fetch keys on them — a fresh Date object
  // every render would refetch the timesheet on every unrelated state change.
  const range = useMemo(() => {
    const base = new Date()
    const wk = weekStartsOn ?? 1
    const from = period === 'today' ? startOfDay(base) : startOfWeek(base, { weekStartsOn: wk })
    const to = period === 'today' ? endOfDay(base) : endOfWeek(base, { weekStartsOn: wk })
    return { from, to, fromISO: from.toISOString(), toISO: to.toISOString() }
  }, [period, weekStartsOn])
  const { fromISO, toISO } = range

  const fetchAll = useCallback(async () => {
    try {
      const { data: { session } } = await supabase.auth.getSession()
      const user = session?.user
      if (!user) { setLoadError('Session expired — sign in again.'); return }
      setUid(user.id)
      const [sRes, t, e] = await Promise.all([
        supabase.from('business_settings').select('*').eq('user_id', user.id).maybeSingle(),
        // includeArchived: this is the paid-time LEDGER. Shifts worked by someone
        // who has since left still have to render with their name and wage —
        // that is the payroll record PAY-1 exists to preserve.
        loadTechnicians(supabase, user.id, { includeArchived: true }),
        loadTimeEntries(supabase, user.id, { fromISO, toISO }),
      ])
      // THE payroll engine decides what a work week is. Reading the column
      // directly here would be a second interpretation of the same setting.
      setWeekStartsOn(payrollRules(sRes.data as BusinessSettings | null).weekStartsOn)
      // An open shift started before this window still needs its Clock out
      // button, or it becomes unstoppable from the screen that owns it.
      //
      // A FAILURE HERE IS NOT AN ANSWER. Swallowing it into an empty list — as
      // this used to — made a network blip render as "On the clock: 0 · Nobody
      // clocked in", with a Clock in button beside a person who was already on
      // the clock. The page now says it couldn't check instead of saying no.
      let open: TimeEntry[] = []
      try {
        open = (await loadTimeEntries(supabase, user.id, {})).filter(isOpen)
        setOpenSweepError(null)
      } catch (err) {
        setOpenSweepError(err instanceof Error ? err.message : 'the request failed')
      }
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
  }, [supabase, fromISO, toISO])

  useEffect(() => { fetchAll() }, [fetchAll])
  useRealtimeRefresh('time_entries', uid ? `user_id=eq.${uid}` : null, fetchAll)

  // Both handlers ADOPT the row the write returns instead of throwing it away
  // and waiting on a refetch. The button's label comes from `entries`, not from
  // `busy`, so clearing busy first re-enabled a button that still said "Clock
  // in" — a second tap in that window hit the one-open-shift unique index and
  // told the owner "already clocked in" for a tap that had just worked. Now the
  // row lands and the button flips in the same commit. fetchAll still runs (it
  // recomputes the day's totals), but nothing user-visible waits on it.
  async function doClockIn(t: Technician) {
    setBusy(t.id)
    const res = await clockIn(supabase, { userId: uid!, technician: t })
    if (!res.ok) { setBusy(null); notify.error(res.error); return }
    setEntries(prev => [res.entry, ...prev.filter(x => x.id !== res.entry.id)])
    setBusy(null)
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
    if (!res.ok) { setBusy(null); notify.error(res.error); fetchAll(); return }
    setEntries(prev => prev.map(x => x.id === res.entry.id ? res.entry : x))
    setBusy(null)
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
      // Worked hours feed payroll: a restore that fails without saying so loses a
      // crew member's shift for good, and the owner has no way to know it happened.
      const { error: rErr } = await supabase.from('time_entries').insert(row)
      if (rErr) { notify.error('Could not restore the shift: ' + rErr.message + ' — re-enter it by hand so payroll stays right.'); return }
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
  // Open shifts that didn't start today — almost always a forgotten clock-out,
  // and the reason someone's "hours" can read as three days.
  const staleOpen = useMemo(() => entries.filter(e => isStaleOpen(e, now)), [entries, now])
  const unpaidRated = useMemo(() => inRange.some(e => e.hourly_rate == null), [inRange])
  const techById = useMemo(() => Object.fromEntries(techs.map(t => [t.id, t])), [techs])
  const active = useMemo(() => techs.filter(t => t.is_active), [techs])

  if (loading) {
    return (
      <div className="max-w-5xl space-y-5">
        <PageHeader crumb={{ label: 'Workforce', href: '/dashboard/workforce' }} title="Timesheet"
          description="Clock your people in and out, and see what the hours cost." />
        {/* Same breakpoints as the loaded row, so the tiles land where their
            placeholder was instead of jumping a column on a phone. */}
        <SkeletonTiles count={3} className="grid-cols-2 sm:grid-cols-3 lg:grid-cols-3" />
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

      {!loadError && openSweepError && (
        <Banner tone="warn" icon={AlertTriangle}
          action={<Button size="sm" variant="secondary" onClick={() => fetchAll()}>Retry</Button>}>
          Couldn’t check for shifts left open from earlier days ({openSweepError}). Anyone still on
          the clock from before today may show here as clocked out — retry before trusting this screen.
        </Banner>
      )}

      {!openSweepError && staleOpen.length > 0 && (
        <Banner tone="warn" icon={AlertTriangle}>
          {staleOpen.length === 1
            ? `${techById[staleOpen[0].technician_id]?.name ?? 'Someone'} has been on the clock since ${openSinceLabel(staleOpen[0].clock_in, now)}`
            : `${staleOpen.length} shifts have been open since before today`}
          {' '}— almost certainly a missed clock-out. An open shift is never paid, so fix the end
          time with Edit and those hours reach payroll.
        </Banner>
      )}

      {/* Two across on a phone, three from sm. At 375px the dashboard's p-4 leaves
          343px, so three tiles get 78px of content each — narrower than
          "$2,000.00" or "80h 30m" at text-xl. Grid items don't shrink below their
          content, so the row pushed the whole page into a sideways scroll on the
          screen most likely to be read one-handed in a truck. */}
      <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
        <StatTile label={period === 'today' ? 'Hours today' : 'Hours this week'} icon={Clock}
          value={formatDuration(sum.minutes)} sub={`${decimalHours(sum.minutes)} h · ${sum.entries} shift${sum.entries !== 1 ? 's' : ''}`} />
        <StatTile label="Labour cost" icon={DollarSign} value={formatCurrency(sum.cost)}
          sub={unpaidRated ? 'Some shifts have no wage' : 'From each shift’s own rate'} accent />
        {/* When the open-shift sweep failed we know about today's shifts and
            nothing older, so this refuses to state a count rather than claim a
            zero it cannot support. */}
        <StatTile label="On the clock" icon={HardHat}
          value={openSweepError ? '—' : String(openCount)}
          sub={openSweepError ? 'Couldn’t check' : openCount ? 'Counting up now' : 'Nobody clocked in'}
          tone={openSweepError ? undefined : openCount ? 'success' : undefined}
          tonedSurface={!openSweepError && openCount > 0} />
      </div>

      <div className="flex items-center gap-1.5">
        <FilterPill active={period === 'today'} onClick={() => setPeriod('today')}>Today</FilterPill>
        <FilterPill active={period === 'week'} onClick={() => setPeriod('week')}>This week</FilterPill>
        {/* Weekdays are spelled out in the week view so the work-week boundary is
            visible: this has to be the same seven days payroll charges overtime
            against, and an owner can only check that if they can see it. */}
        <span className="ml-auto text-[11px] text-ink-faint tabular-nums"
          title={period === 'week' ? 'Your work week, set in Settings → Payroll' : undefined}>
          {period === 'week'
            ? `${format(range.from, 'EEE MMM d')} – ${format(range.to, 'EEE MMM d')}`
            : format(range.from, 'MMM d')}
        </span>
      </div>

      {/* ── Roster: the clock ── */}
      {active.length === 0 ? (
        <Card>
          <EmptyState icon={HardHat} title="No one on the roster yet"
            description="Add the people who work for you, then you can clock them in here."
            action={{ label: 'Add your people', href: '/dashboard/workforce' }} />
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
                      {open && ` · on the clock since ${openSinceLabel(open.clock_in, now)}`}
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
                      <p className="text-sm font-medium text-ink truncate">{t?.name ?? 'Former employee'}</p>
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
          technicianName={techById[editing.technician_id]?.name ?? 'this employee'}
          supabase={supabase}
          onClose={() => setEditing(null)}
          onSaved={fetchAll}
        />
      )}
    </div>
  )
}
