'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { addDays, format } from 'date-fns'
import { createClient } from '@/lib/supabase/client'
import { useRealtimeRefresh } from '@/hooks/useRealtime'
import type { BusinessSettings, PtoEntry, Technician, TimeEntry } from '@/types'
import { PAY_PERIOD_LABELS, PTO_KIND_LABELS } from '@/types'
import { loadTechnicians } from '@/lib/crews'
import { loadTimeEntries, formatDuration, decimalHours } from '@/lib/timeTracking'
import {
  payrollRules, payPeriodFor, shiftPayPeriod, overtimeOff, inPeriod, periodSplitsWeeks,
  type PayPeriod,
} from '@/lib/payroll'
import { entryMinutes } from '@/lib/timeTracking'
import { buildDraftPayRun } from '@/lib/payRun'
import { FinalizePayRunDialog } from '@/components/dispatch/FinalizePayRunDialog'
import { exportRowsToCsv } from '@/lib/csv'
import { PageHeader } from '@/components/layout/PageHeader'
import { Card, CardBody } from '@/components/ui/Card'
import { Button } from '@/components/ui/Button'
import { StatTile } from '@/components/ui/StatTile'
import { Banner } from '@/components/ui/Banner'
import { EmptyState, InlineEmpty } from '@/components/ui/EmptyState'
import { SkeletonTiles, SkeletonRows } from '@/components/ui/Skeleton'
import { toast as notify } from '@/lib/toast'
import { formatCurrency, cn } from '@/lib/utils'
import {
  Wallet, ChevronLeft, ChevronRight, Clock, AlertTriangle, HardHat, Settings, Timer,
  Download, Printer, BarChart3, Lock, History, Palmtree,
} from 'lucide-react'

// ── Payroll summary ──────────────────────────────────────────────────────────
// What each person earned this pay period, regular vs overtime. Every number
// comes from lib/payroll (the ONE payroll engine) over lib/timeTracking — this
// file renders and navigates periods, and computes nothing itself.
//
// Lives under /dashboard/dispatch because `technicians` is the roster dispatch
// owns. There is no separate "employees" area, and no second people system.
export default function PayrollPage() {
  const supabase = useMemo(() => createClient(), [])
  const router = useRouter()
  const [uid, setUid] = useState<string | null>(null)
  const [settings, setSettings] = useState<BusinessSettings | null>(null)
  const [techs, setTechs] = useState<Technician[]>([])
  const [entries, setEntries] = useState<TimeEntry[]>([])
  const [ptoEntries, setPtoEntries] = useState<PtoEntry[]>([])
  const [finalizeOpen, setFinalizeOpen] = useState(false)
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState<string | null>(null)
  // Which period we're looking at. Null until settings load (the rules decide
  // what a period even is), then anchored on today.
  const [period, setPeriod] = useState<PayPeriod | null>(null)

  const rules = useMemo(() => payrollRules(settings), [settings])

  const fetchAll = useCallback(async () => {
    try {
      const { data: { session } } = await supabase.auth.getSession()
      const user = session?.user
      if (!user) { setLoadError('Session expired — sign in again.'); return }
      setUid(user.id)
      const [sRes, t] = await Promise.all([
        supabase.from('business_settings').select('*').eq('user_id', user.id).maybeSingle(),
        // includeArchived: someone archived MID-PERIOD still worked hours in that
        // period and is still owed them. buildDraftPayRun computes the draft FROM
        // this list, so filtering them out silently underpays a real person.
        loadTechnicians(supabase, user.id, { includeArchived: true }),
      ])
      const s = sRes.data as BusinessSettings | null
      setSettings(s)
      setTechs(t)
      // Resolve the period from the freshly-loaded rules, not stale state.
      const r = payrollRules(s)
      const p = period ?? payPeriodFor(new Date(), r)
      setPeriod(p)
      const [e, ptoRes] = await Promise.all([
        loadTimeEntries(supabase, user.id, {
          fromISO: p.start.toISOString(),
          toISO: addDays(p.end, 1).toISOString(),
        }),
        // PTO is a SEPARATE ledger — loaded alongside, never merged into
        // `entries`. Merging would feed vacation hours to lib/payroll as worked
        // time and invent overtime (see lib/pto).
        supabase.from('pto_entries').select('*').eq('user_id', user.id)
          .gte('date', format(p.start, 'yyyy-MM-dd')).lte('date', format(p.end, 'yyyy-MM-dd')),
      ])
      setEntries(e)
      setPtoEntries((ptoRes.data as PtoEntry[]) ?? [])
      setLoadError(null)
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : 'Could not load payroll.')
    } finally {
      setLoading(false)
    }
  }, [supabase, period])

  useEffect(() => { fetchAll() }, [fetchAll])
  useRealtimeRefresh('time_entries', uid ? `user_id=eq.${uid}` : null, fetchAll)

  // ONE source of truth for this whole page. The tile, the table, the CSV, the
  // printed timesheet and Finalize all read THIS object.
  //
  // They used to not. `payrollSummary` (worked time only) fed the table/CSV/print
  // while the draft (worked + PTO) fed the tile and Finalize — so a period with
  // one vacation day printed a timesheet, exported a CSV, and froze a pay run
  // with three different totals. Two engines on one screen is how that happens;
  // the fix is to have one.
  const draft = useMemo(
    () => (period ? buildDraftPayRun({ entries, ptoEntries, technicians: techs, rules, period }) : null),
    [entries, ptoEntries, techs, rules, period],
  )

  const step = (delta: number) => setPeriod(p => (p ? shiftPayPeriod(p, delta, rules) : p))
  const otOff = overtimeOff(rules)

  // Shifts per technician, for the printed timesheets. Oldest first — a timesheet
  // reads forward through the period, unlike the newest-first screen list.
  const shiftsByTech = useMemo(() => {
    const m = new Map<string, TimeEntry[]>()
    for (const e of entries) {
      if (period && !inPeriod(e, period)) continue
      const list = m.get(e.technician_id)
      if (list) list.push(e); else m.set(e.technician_id, [e])
    }
    for (const list of m.values()) list.sort((a, b) => a.clock_in.localeCompare(b.clock_in))
    return m
  }, [entries, period])

  // Time off per person, for the printed timesheet's own time-off table.
  const ptoByTech = useMemo(() => {
    const m = new Map<string, PtoEntry[]>()
    for (const p of ptoEntries) {
      const list = m.get(p.technician_id)
      if (list) list.push(p); else m.set(p.technician_id, [p])
    }
    for (const list of m.values()) list.sort((a, b) => a.date.localeCompare(b.date))
    return m
  }, [ptoEntries])

  // Payroll export — the same draft the screen shows and Finalize freezes. Hours
  // are emitted as decimal numbers (not "7h 30m") because every payroll system and
  // spreadsheet wants a number it can sum; 7.5 sums, "7h 30m" does not.
  function exportCsv() {
    if (!draft || !draft.lines.length) { notify.error('Nothing to export for this pay period.'); return }
    exportRowsToCsv(`payroll-${format(draft.period.start, 'yyyy-MM-dd')}-to-${format(draft.period.end, 'yyyy-MM-dd')}`, draft.lines, [
      { label: 'Employee', value: l => l.technicianName },
      { label: 'Role', value: l => l.technicianRole ?? '' },
      { label: 'Period start', value: () => format(draft.period.start, 'yyyy-MM-dd') },
      { label: 'Period end', value: () => format(draft.period.end, 'yyyy-MM-dd') },
      { label: 'Regular hours', value: l => decimalHours(l.regularMinutes) },
      { label: 'Overtime hours', value: l => decimalHours(l.otMinutes) },
      { label: 'Hours worked', value: l => decimalHours(l.totalMinutes) },
      // Blended = weighted average of the rates actually worked. Named in full so
      // nobody reconciles it against an offer letter and finds it "wrong".
      { label: 'Rate (blended avg $/hr)', value: l => l.blendedRate },
      { label: 'OT multiplier', value: () => rules.multiplier },
      { label: 'Regular pay', value: l => l.regularPay },
      { label: 'Overtime pay', value: l => l.otPay },
      // PTO is its own earning line — it was missing here entirely, so exported
      // gross didn't match the finalized pay run.
      { label: 'Paid time off hours', value: l => l.ptoHours },
      { label: 'Paid time off pay', value: l => l.ptoPay },
      { label: 'Gross pay', value: l => l.grossPay },
      { label: 'Shifts', value: l => l.shifts },
      // Exported so a bookkeeper can see WHY a total looks light, instead of
      // finding out on payday.
      { label: 'Open shifts (unpaid)', value: l => l.openShifts },
      { label: 'Hours with no wage set', value: l => decimalHours(l.unratedMinutes) },
    ])
    notify.success(`Exported ${draft.lines.length} employee${draft.lines.length !== 1 ? 's' : ''} to CSV.`)
  }

  if (loading || !period || !draft) {
    return (
      <div className="max-w-5xl space-y-5">
        <PageHeader crumb={{ label: 'Workforce', href: '/dashboard/workforce' }} title="Payroll"
          description="What each person earned this pay period." />
        <SkeletonTiles count={4} />
        <SkeletonRows count={4} />
      </div>
    )
  }

  const isCurrent = period.start.getTime() === payPeriodFor(new Date(), rules).start.getTime()

  return (
    <div className="max-w-5xl space-y-5">
      <PageHeader
        crumb={{ label: 'Workforce', href: '/dashboard/workforce' }}
        title="Payroll"
        description={`${PAY_PERIOD_LABELS[rules.kind]} · what each person earned, regular and overtime.`}
        action={
          <div className="flex items-center gap-2">
            <Button size="sm" onClick={() => setFinalizeOpen(true)} disabled={!draft?.lines.length}>
              <Lock className="w-3.5 h-3.5" /> Finalize
            </Button>
            <Button variant="secondary" size="sm" onClick={exportCsv} disabled={!draft.lines.length}>
              <Download className="w-3.5 h-3.5" /> CSV
            </Button>
            <Button variant="secondary" size="sm" onClick={() => window.print()} disabled={!draft.lines.length}>
              <Printer className="w-3.5 h-3.5" /> Print
            </Button>
            <Link href="/dashboard/dispatch/payroll/history">
              <Button variant="secondary" size="sm"><History className="w-3.5 h-3.5" /> History</Button>
            </Link>
            <Link href="/dashboard/dispatch/labor">
              <Button variant="secondary" size="sm" aria-label="Labour analytics"><BarChart3 className="w-3.5 h-3.5" /></Button>
            </Link>
            <Link href="/dashboard/settings#payroll">
              <Button variant="secondary" size="sm" aria-label="Payroll settings"><Settings className="w-3.5 h-3.5" /></Button>
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

      {/* ── Period navigator ── */}
      <div className="flex items-center gap-2">
        <Button variant="secondary" size="sm" onClick={() => step(-1)} aria-label="Previous pay period">
          <ChevronLeft className="w-4 h-4" />
        </Button>
        <div className="flex-1 text-center">
          <p className="text-sm font-bold text-ink tabular-nums">{period.label}</p>
          <p className="text-[11px] text-ink-faint tabular-nums">
            {format(period.start, 'EEE MMM d')} – {format(period.end, 'EEE MMM d')}
            {isCurrent && ' · current period'}
          </p>
        </div>
        <Button variant="secondary" size="sm" onClick={() => step(1)} aria-label="Next pay period">
          <ChevronRight className="w-4 h-4" />
        </Button>
        {!isCurrent && (
          <Button variant="ghost" size="sm" onClick={() => setPeriod(payPeriodFor(new Date(), rules))}>Today</Button>
        )}
      </div>

      {/* ── Totals ── */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        <StatTile label="Regular hours" icon={Clock} value={formatDuration(draft.regularMinutes)}
          sub={`${decimalHours(draft.regularMinutes)} h`} />
        <StatTile label="Overtime hours" icon={Timer} value={formatDuration(draft.otMinutes)}
          sub={otOff ? 'No OT rule set' : `${decimalHours(draft.otMinutes)} h at ${rules.multiplier}x`}
          tone={draft.otMinutes > 0 ? 'warn' : undefined} tonedSurface={draft.otMinutes > 0} />
        <StatTile label="Paid time off" icon={Palmtree} value={`${draft.ptoHours} h`}
          sub={draft.ptoPay > 0 ? formatCurrency(draft.ptoPay) : 'Not hours worked'}
          onClick={() => router.push('/dashboard/dispatch/time-off')} />
        <StatTile label="Total pay" icon={Wallet} value={formatCurrency(draft.grossPay)}
          sub="Worked + time off, before deductions" accent />
      </div>

      {/* Honest caveats — each one is a reason a number might not be what the
          owner expects, said out loud instead of discovered on payday. */}
      {otOff && (
        <Banner tone="info" icon={Timer}
          action={<Link href="/dashboard/settings#payroll" className="shrink-0 text-xs font-semibold underline">Set rules</Link>}>
          No overtime rule is set, so every hour is paid as regular time. EdgeQuote won’t guess a
          threshold — overtime law differs by province (Alberta 8/day &amp; 44/week, Ontario 44/week).
        </Banner>
      )}
      {draft.openShifts > 0 && (
        <Banner tone="warn" icon={AlertTriangle}
          action={<Link href="/dashboard/dispatch/time" className="shrink-0 text-xs font-semibold underline">Timesheet</Link>}>
          {draft.openShifts} shift{draft.openShifts !== 1 ? 's are' : ' is'} still open and {draft.openShifts !== 1 ? 'are' : 'is'} not
          included — an unfinished shift has no hours yet. Clock {draft.openShifts !== 1 ? 'them' : 'it'} out to pay {draft.openShifts !== 1 ? 'them' : 'it'}.
        </Banner>
      )}
      {draft.unratedMinutes > 0 && (
        <Banner tone="warn" icon={AlertTriangle}
          action={<Link href="/dashboard/dispatch/time" className="shrink-0 text-xs font-semibold underline">Fix rates</Link>}>
          {formatDuration(draft.unratedMinutes)} was worked with no wage set, so it counts as hours but
          pays $0. Open the shift on the timesheet and set its rate — the wage on the roster only
          applies to future clock-ins.
        </Banner>
      )}
      {periodSplitsWeeks(rules) && (
        <Banner tone="info" icon={AlertTriangle}>
          {PAY_PERIOD_LABELS[rules.kind]} periods don’t line up with work weeks, so overtime is judged on
          the part of each week inside this period. Weekly or every-2-weeks periods are exact.
        </Banner>
      )}

      {/* ── Per-person ── */}
      <Card>
        <CardBody className="p-0">
          <div className="px-5 py-3 border-b border-border flex items-center justify-between">
            <h2 className="text-sm font-semibold text-ink">By person</h2>
            <span className="text-[11px] text-ink-faint tabular-nums">
              {formatDuration(draft.regularMinutes + draft.otMinutes)} worked
              {draft.ptoHours > 0 && ` · ${draft.ptoHours} h off`}
            </span>
          </div>

          {draft.lines.length === 0 ? (
            techs.length === 0 ? (
              <EmptyState icon={HardHat} className="py-12" title="No one on the roster yet"
                description="Add your people to the roster, then clock them in — their hours and pay show up here."
                action={{ label: 'Open the roster', href: '/dashboard/dispatch?roster=1' }} />
            ) : (
              <InlineEmpty icon={Clock}>No hours in this pay period.</InlineEmpty>
            )
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-border">
                    <th className="text-left px-5 py-2.5 text-[10px] font-semibold text-ink-faint uppercase tracking-wide">Person</th>
                    <th className="text-right px-3 py-2.5 text-[10px] font-semibold text-ink-faint uppercase tracking-wide">Regular</th>
                    <th className="text-right px-3 py-2.5 text-[10px] font-semibold text-ink-faint uppercase tracking-wide">Overtime</th>
                    {/* PTO was missing entirely — the Pay column silently excluded
                        it while the tile above included it. */}
                    <th className="text-right px-3 py-2.5 text-[10px] font-semibold text-ink-faint uppercase tracking-wide">Time off</th>
                    <th className="text-right px-3 py-2.5 text-[10px] font-semibold text-ink-faint uppercase tracking-wide hidden sm:table-cell">Avg rate</th>
                    <th className="text-right px-5 py-2.5 text-[10px] font-semibold text-ink-faint uppercase tracking-wide">Gross</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border">
                  {draft.lines.map(r => (
                    <tr key={r.technicianId} className="hover:bg-surface-raised transition-colors">
                      <td className="px-5 py-3">
                        <p className="font-medium text-ink truncate">{r.technicianName}</p>
                        <p className="text-[11px] text-ink-faint tabular-nums">
                          {r.shifts} shift{r.shifts !== 1 ? 's' : ''}
                          {r.openShifts > 0 && <span className="text-amber-400"> · {r.openShifts} open</span>}
                          {r.unratedMinutes > 0 && <span className="text-amber-400"> · no wage</span>}
                        </p>
                      </td>
                      <td className="px-3 py-3 text-right tabular-nums text-ink">
                        {formatDuration(r.regularMinutes)}
                        <span className="block text-[11px] text-ink-faint">{formatCurrency(r.regularPay)}</span>
                      </td>
                      <td className="px-3 py-3 text-right tabular-nums">
                        <span className={cn(r.otMinutes > 0 ? 'text-amber-400 font-semibold' : 'text-ink-faint')}>
                          {r.otMinutes > 0 ? formatDuration(r.otMinutes) : '—'}
                        </span>
                        {r.otMinutes > 0 && <span className="block text-[11px] text-ink-faint">{formatCurrency(r.otPay)}</span>}
                      </td>
                      <td className="px-3 py-3 text-right tabular-nums">
                        <span className={r.ptoHours > 0 ? 'text-ink' : 'text-ink-faint'}>
                          {r.ptoHours > 0 ? `${r.ptoHours} h` : '—'}
                        </span>
                        {r.ptoPay > 0 && <span className="block text-[11px] text-ink-faint">{formatCurrency(r.ptoPay)}</span>}
                      </td>
                      <td className="px-3 py-3 text-right tabular-nums text-ink-muted hidden sm:table-cell">
                        {r.blendedRate > 0 ? `${formatCurrency(r.blendedRate)}/hr` : '—'}
                      </td>
                      <td className="px-5 py-3 text-right font-bold text-ink tabular-nums">{formatCurrency(r.grossPay)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </CardBody>
      </Card>

      <p className="text-[11px] text-ink-faint text-center">
        Gross pay from each shift’s own stamped rate — before tax, deductions and remittances.
        {!otOff && ` Overtime is the greater of the daily or weekly rule, never both.`}
      </p>

      {finalizeOpen && draft && uid && (
        <FinalizePayRunDialog
          open
          draft={draft}
          supabase={supabase}
          userId={uid}
          onClose={() => setFinalizeOpen(false)}
          onFinalized={id => router.push(`/dashboard/dispatch/payroll/history/${id}`)}
        />
      )}

      {/* ── Printable timesheets ──────────────────────────────────────────────
          Off-screen; only paper sees it (globals.css @media print). One sheet per
          person: their shifts, their totals, and a signature line — the thing an
          owner hands over or files. Same numbers as above, from the same engine. */}
      <div className="print-sheet hidden print:block text-[11px]">
        {draft.lines.map((r, i) => {
          const shifts = shiftsByTech.get(r.technicianId) ?? []
          const pto = ptoByTech.get(r.technicianId) ?? []
          return (
            <section key={r.technicianId} className={cn('print-keep', i < draft.lines.length - 1 && 'print-break')}>
              <header className="mb-3">
                <h1 className="text-base font-bold">{r.technicianName} — Timesheet</h1>
                <p>
                  {settings?.company_name ? `${settings.company_name} · ` : ''}
                  {format(period.start, 'MMM d, yyyy')} – {format(period.end, 'MMM d, yyyy')}
                  {' · '}{PAY_PERIOD_LABELS[rules.kind]}
                </p>
              </header>

              <table className="w-full border-collapse mb-3">
                <thead>
                  <tr data-print-rule className="border-b border-black">
                    <th className="text-left py-1">Date</th>
                    <th className="text-left py-1">In</th>
                    <th className="text-left py-1">Out</th>
                    <th className="text-right py-1">Break</th>
                    <th className="text-right py-1">Hours</th>
                    <th className="text-left py-1">Notes</th>
                  </tr>
                </thead>
                <tbody>
                  {shifts.length === 0 ? (
                    <tr><td colSpan={6} className="py-2">No shifts in this period.</td></tr>
                  ) : shifts.map(e => (
                    <tr key={e.id} data-print-rule className="border-b border-black/20">
                      <td className="py-1">{format(new Date(e.clock_in), 'EEE MMM d')}</td>
                      <td className="py-1">{format(new Date(e.clock_in), 'h:mm a')}</td>
                      {/* An open shift prints as "—", never as a guessed end time. */}
                      <td className="py-1">{e.clock_out ? format(new Date(e.clock_out), 'h:mm a') : '—'}</td>
                      <td className="py-1 text-right">{e.break_minutes ? `${e.break_minutes}m` : '—'}</td>
                      <td className="py-1 text-right">
                        {e.clock_out ? decimalHours(entryMinutes(e)) : 'open'}
                      </td>
                      <td className="py-1">{e.notes ?? ''}</td>
                    </tr>
                  ))}
                </tbody>
              </table>

              {/* Time off is listed before the totals so the gross below is
                  self-evidently the sum of what's on the page. It used to be
                  omitted entirely, and the signed gross was short by its value. */}
              {pto.length > 0 && (
                <>
                  <p className="font-bold mb-1">Time off</p>
                  <table className="w-full border-collapse mb-3">
                    <tbody>
                      {pto.map(p => (
                        <tr key={p.id} data-print-rule className="border-b border-black/20">
                          <td className="py-0.5">{format(new Date(`${p.date.slice(0, 10)}T00:00:00`), 'EEE MMM d')}</td>
                          <td className="py-0.5">{PTO_KIND_LABELS[p.kind]}{!p.is_paid && ' (unpaid)'}</td>
                          <td className="py-0.5 text-right">{Number(p.hours)} h</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </>
              )}

              <table className="w-full border-collapse mb-4">
                <tbody>
                  <tr><td className="py-0.5">Regular hours</td><td className="py-0.5 text-right">{decimalHours(r.regularMinutes)}</td></tr>
                  <tr><td className="py-0.5">Overtime hours{!otOff && ` (at ${rules.multiplier}×)`}</td><td className="py-0.5 text-right">{decimalHours(r.otMinutes)}</td></tr>
                  <tr data-print-rule className="border-t border-black"><td className="py-1 font-bold">Hours worked</td><td className="py-1 text-right font-bold">{decimalHours(r.totalMinutes)}</td></tr>
                  <tr><td className="py-0.5">Regular pay</td><td className="py-0.5 text-right">{formatCurrency(r.regularPay)}</td></tr>
                  <tr><td className="py-0.5">Overtime pay</td><td className="py-0.5 text-right">{formatCurrency(r.otPay)}</td></tr>
                  {r.ptoHours > 0 && (
                    <tr><td className="py-0.5">Paid time off ({r.ptoHours} h)</td><td className="py-0.5 text-right">{formatCurrency(r.ptoPay)}</td></tr>
                  )}
                  <tr data-print-rule className="border-t border-black"><td className="py-1 font-bold">Gross pay</td><td className="py-1 text-right font-bold">{formatCurrency(r.grossPay)}</td></tr>
                </tbody>
              </table>

              {r.openShifts > 0 && (
                <p className="mb-2">Note: {r.openShifts} shift{r.openShifts !== 1 ? 's are' : ' is'} still open and not included in these totals.</p>
              )}

              <div className="flex gap-8 mt-6">
                <div data-print-rule className="flex-1 border-t border-black pt-1">Employee signature</div>
                <div data-print-rule className="flex-1 border-t border-black pt-1">Date</div>
              </div>
              <p className="mt-3 text-[9px]">Gross pay before tax, deductions and remittances.</p>
            </section>
          )
        })}
      </div>
    </div>
  )
}
