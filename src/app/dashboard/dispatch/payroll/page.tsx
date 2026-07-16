'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import Link from 'next/link'
import { addDays, format } from 'date-fns'
import { createClient } from '@/lib/supabase/client'
import { useRealtimeRefresh } from '@/hooks/useRealtime'
import type { BusinessSettings, Technician, TimeEntry } from '@/types'
import { PAY_PERIOD_LABELS } from '@/types'
import { loadTechnicians } from '@/lib/crews'
import { loadTimeEntries, formatDuration, decimalHours } from '@/lib/timeTracking'
import {
  payrollRules, payPeriodFor, shiftPayPeriod, payrollSummary, overtimeOff, inPeriod,
  type PayPeriod, type PayrollSummary,
} from '@/lib/payroll'
import { entryMinutes } from '@/lib/timeTracking'
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
  Download, Printer, BarChart3,
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
  const [uid, setUid] = useState<string | null>(null)
  const [settings, setSettings] = useState<BusinessSettings | null>(null)
  const [techs, setTechs] = useState<Technician[]>([])
  const [entries, setEntries] = useState<TimeEntry[]>([])
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
        loadTechnicians(supabase, user.id),
      ])
      const s = sRes.data as BusinessSettings | null
      setSettings(s)
      setTechs(t)
      // Resolve the period from the freshly-loaded rules, not stale state.
      const r = payrollRules(s)
      const p = period ?? payPeriodFor(new Date(), r)
      setPeriod(p)
      const e = await loadTimeEntries(supabase, user.id, {
        fromISO: p.start.toISOString(),
        toISO: addDays(p.end, 1).toISOString(),
      })
      setEntries(e)
      setLoadError(null)
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : 'Could not load payroll.')
    } finally {
      setLoading(false)
    }
  }, [supabase, period])

  useEffect(() => { fetchAll() }, [fetchAll])
  useRealtimeRefresh('time_entries', uid ? `user_id=eq.${uid}` : null, fetchAll)

  const sum: PayrollSummary | null = useMemo(
    () => (period ? payrollSummary(entries, techs, rules, period) : null),
    [entries, techs, rules, period],
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

  // Payroll export — the summary as it is on screen. Hours are emitted as decimal
  // numbers (not "7h 30m") because every payroll system and spreadsheet wants a
  // number it can sum; 7.5 sums, "7h 30m" does not.
  function exportCsv() {
    if (!sum || !sum.rows.length) { notify.error('Nothing to export for this pay period.'); return }
    exportRowsToCsv(`payroll-${format(sum.period.start, 'yyyy-MM-dd')}-to-${format(sum.period.end, 'yyyy-MM-dd')}`, sum.rows, [
      { label: 'Employee', value: r => r.name },
      { label: 'Period start', value: () => format(sum.period.start, 'yyyy-MM-dd') },
      { label: 'Period end', value: () => format(sum.period.end, 'yyyy-MM-dd') },
      { label: 'Regular hours', value: r => decimalHours(r.regularMinutes) },
      { label: 'Overtime hours', value: r => decimalHours(r.otMinutes) },
      { label: 'Total hours', value: r => decimalHours(r.totalMinutes) },
      { label: 'Rate (blended $/hr)', value: r => r.blendedRate },
      { label: 'OT multiplier', value: () => rules.multiplier },
      { label: 'Regular pay', value: r => r.regularPay },
      { label: 'Overtime pay', value: r => r.otPay },
      { label: 'Gross pay', value: r => r.totalPay },
      { label: 'Shifts', value: r => r.shifts },
      // Exported so a bookkeeper can see WHY a total looks light, instead of
      // finding out on payday.
      { label: 'Open shifts (unpaid)', value: r => r.openShifts },
      { label: 'Hours with no wage set', value: r => decimalHours(r.unratedMinutes) },
    ])
    notify.success(`Exported ${sum.rows.length} employee${sum.rows.length !== 1 ? 's' : ''} to CSV.`)
  }

  if (loading || !period || !sum) {
    return (
      <div className="max-w-5xl space-y-5">
        <PageHeader crumb={{ label: 'Timesheet', href: '/dashboard/dispatch/time' }} title="Payroll"
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
        crumb={{ label: 'Timesheet', href: '/dashboard/dispatch/time' }}
        title="Payroll"
        description={`${PAY_PERIOD_LABELS[rules.kind]} · what each person earned, regular and overtime.`}
        action={
          <div className="flex items-center gap-2">
            <Button variant="secondary" size="sm" onClick={exportCsv} disabled={!sum.rows.length}>
              <Download className="w-3.5 h-3.5" /> Export CSV
            </Button>
            <Button variant="secondary" size="sm" onClick={() => window.print()} disabled={!sum.rows.length}>
              <Printer className="w-3.5 h-3.5" /> Print timesheets
            </Button>
            <Link href="/dashboard/dispatch/labor">
              <Button variant="secondary" size="sm"><BarChart3 className="w-3.5 h-3.5" /> Labour</Button>
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
        <StatTile label="Regular hours" icon={Clock} value={formatDuration(sum.regularMinutes)}
          sub={`${decimalHours(sum.regularMinutes)} h`} />
        <StatTile label="Overtime hours" icon={Timer} value={formatDuration(sum.otMinutes)}
          sub={otOff ? 'No OT rule set' : `${decimalHours(sum.otMinutes)} h at ${rules.multiplier}x`}
          tone={sum.otMinutes > 0 ? 'warn' : undefined} tonedSurface={sum.otMinutes > 0} />
        <StatTile label="People paid" icon={HardHat} value={String(sum.rows.filter(r => r.totalPay > 0).length)}
          sub={`${sum.rows.length} on the sheet`} />
        <StatTile label="Total pay" icon={Wallet} value={formatCurrency(sum.totalPay)}
          sub="Gross, before deductions" accent />
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
      {sum.openShifts > 0 && (
        <Banner tone="warn" icon={AlertTriangle}
          action={<Link href="/dashboard/dispatch/time" className="shrink-0 text-xs font-semibold underline">Timesheet</Link>}>
          {sum.openShifts} shift{sum.openShifts !== 1 ? 's are' : ' is'} still open and {sum.openShifts !== 1 ? 'are' : 'is'} not
          included — an unfinished shift has no hours yet. Clock {sum.openShifts !== 1 ? 'them' : 'it'} out to pay {sum.openShifts !== 1 ? 'them' : 'it'}.
        </Banner>
      )}
      {sum.unratedMinutes > 0 && (
        <Banner tone="warn" icon={AlertTriangle}>
          {formatDuration(sum.unratedMinutes)} was worked with no wage set, so it counts as hours but
          pays $0. Set a wage on the roster, then edit those shifts.
        </Banner>
      )}
      {sum.approximate && (
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
              {formatDuration(sum.totalMinutes)} · {decimalHours(sum.totalMinutes)} h
            </span>
          </div>

          {sum.rows.length === 0 ? (
            techs.length === 0 ? (
              <EmptyState icon={HardHat} className="py-12" title="No one on the roster yet"
                description="Add your people under Crews & roster on the dispatch board, then clock them in." />
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
                    <th className="text-right px-3 py-2.5 text-[10px] font-semibold text-ink-faint uppercase tracking-wide hidden sm:table-cell">Rate</th>
                    <th className="text-right px-5 py-2.5 text-[10px] font-semibold text-ink-faint uppercase tracking-wide">Pay</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border">
                  {sum.rows.map(r => (
                    <tr key={r.technicianId} className="hover:bg-surface-raised transition-colors">
                      <td className="px-5 py-3">
                        <p className="font-medium text-ink truncate">{r.name}</p>
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
                      <td className="px-3 py-3 text-right tabular-nums text-ink-muted hidden sm:table-cell">
                        {r.blendedRate > 0 ? `${formatCurrency(r.blendedRate)}/hr` : '—'}
                      </td>
                      <td className="px-5 py-3 text-right font-bold text-ink tabular-nums">{formatCurrency(r.totalPay)}</td>
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

      {/* ── Printable timesheets ──────────────────────────────────────────────
          Off-screen; only paper sees it (globals.css @media print). One sheet per
          person: their shifts, their totals, and a signature line — the thing an
          owner hands over or files. Same numbers as above, from the same engine. */}
      <div className="print-sheet hidden print:block text-[11px]">
        {sum.rows.map((r, i) => {
          const shifts = shiftsByTech.get(r.technicianId) ?? []
          return (
            <section key={r.technicianId} className={cn('print-keep', i < sum.rows.length - 1 && 'print-break')}>
              <header className="mb-3">
                <h1 className="text-base font-bold">{r.name} — Timesheet</h1>
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

              <table className="w-full border-collapse mb-4">
                <tbody>
                  <tr><td className="py-0.5">Regular hours</td><td className="py-0.5 text-right">{decimalHours(r.regularMinutes)}</td></tr>
                  <tr><td className="py-0.5">Overtime hours{!otOff && ` (at ${rules.multiplier}×)`}</td><td className="py-0.5 text-right">{decimalHours(r.otMinutes)}</td></tr>
                  <tr data-print-rule className="border-t border-black"><td className="py-1 font-bold">Total hours</td><td className="py-1 text-right font-bold">{decimalHours(r.totalMinutes)}</td></tr>
                  <tr><td className="py-0.5">Regular pay</td><td className="py-0.5 text-right">{formatCurrency(r.regularPay)}</td></tr>
                  <tr><td className="py-0.5">Overtime pay</td><td className="py-0.5 text-right">{formatCurrency(r.otPay)}</td></tr>
                  <tr data-print-rule className="border-t border-black"><td className="py-1 font-bold">Gross pay</td><td className="py-1 text-right font-bold">{formatCurrency(r.totalPay)}</td></tr>
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
