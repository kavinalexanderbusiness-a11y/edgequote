'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import Link from 'next/link'
import { useParams, useRouter } from 'next/navigation'
import { addDays, format } from 'date-fns'
import { createClient } from '@/lib/supabase/client'
import type { BusinessSettings, PayRun, PayRunLine, PtoEntry, Technician, TimeEntry } from '@/types'
import { PAY_PERIOD_LABELS } from '@/types'
import { loadTechnicians } from '@/lib/crews'
import { loadTimeEntries, decimalHours, formatDuration } from '@/lib/timeTracking'
import { detectDrift, type PayRunDrift } from '@/lib/payRun'
import { exportRowsToCsv } from '@/lib/csv'
import { PageHeader } from '@/components/layout/PageHeader'
import { Card, CardBody } from '@/components/ui/Card'
import { Button } from '@/components/ui/Button'
import { StatTile } from '@/components/ui/StatTile'
import { Banner } from '@/components/ui/Banner'
import { SkeletonTiles, SkeletonRows } from '@/components/ui/Skeleton'
import { toast as notify } from '@/lib/toast'
import { confirm } from '@/lib/confirm'
import { formatCurrency, cn } from '@/lib/utils'
import {
  Wallet, AlertTriangle, Download, Printer, Clock, Timer, Trash2, Lock, Palmtree,
} from 'lucide-react'

// ── Pay run detail — the pay stubs ───────────────────────────────────────────
// Reads the FROZEN lines. Nothing here is recomputed except the drift check,
// which deliberately recomputes to compare (see lib/payRun.detectDrift).
export default function PayRunDetailPage() {
  const supabase = useMemo(() => createClient(), [])
  const params = useParams()
  const router = useRouter()
  const id = String(params?.id ?? '')

  const [run, setRun] = useState<PayRun | null>(null)
  const [lines, setLines] = useState<PayRunLine[]>([])
  const [settings, setSettings] = useState<BusinessSettings | null>(null)
  const [drift, setDrift] = useState<PayRunDrift | null>(null)
  const [entriesByTech, setEntriesByTech] = useState<Map<string, TimeEntry[]>>(new Map())
  const [ptoByTech, setPtoByTech] = useState<Map<string, PtoEntry[]>>(new Map())
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState<string | null>(null)

  const fetchAll = useCallback(async () => {
    try {
      const { data: { session } } = await supabase.auth.getSession()
      const user = session?.user
      if (!user) { setLoadError('Session expired — sign in again.'); return }

      const [runRes, lineRes, sRes] = await Promise.all([
        supabase.from('pay_runs').select('*').eq('id', id).maybeSingle(),
        supabase.from('pay_run_lines').select('*').eq('pay_run_id', id).order('gross_pay', { ascending: false }),
        supabase.from('business_settings').select('*').eq('user_id', user.id).maybeSingle(),
      ])
      const r = runRes.data as PayRun | null
      if (!r) { setLoadError('That pay run no longer exists.'); setLoading(false); return }
      setRun(r)
      setLines((lineRes.data as PayRunLine[]) ?? [])
      setSettings(sRes.data as BusinessSettings | null)

      // The shifts as they stand NOW — for the stub detail and the drift check.
      const from = new Date(`${r.period_start.slice(0, 10)}T00:00:00`)
      const to = addDays(new Date(`${r.period_end.slice(0, 10)}T00:00:00`), 1)
      const [techs, entries, ptoRes] = await Promise.all([
        // includeArchived: detectDrift() REBUILDS this settled run from the roster
        // and compares gross. Omit someone who has since left and the rebuild comes
        // up short — the page reports "drift" on a pay run that never changed.
        loadTechnicians(supabase, user.id, { includeArchived: true }),
        loadTimeEntries(supabase, user.id, { fromISO: from.toISOString(), toISO: to.toISOString() }),
        supabase.from('pto_entries').select('*').eq('user_id', user.id)
          .gte('date', r.period_start.slice(0, 10)).lte('date', r.period_end.slice(0, 10)),
      ])
      const ptos = (ptoRes.data as PtoEntry[]) ?? []

      const em = new Map<string, TimeEntry[]>()
      for (const e of entries) {
        const l = em.get(e.technician_id); if (l) l.push(e); else em.set(e.technician_id, [e])
      }
      for (const l of em.values()) l.sort((a, b) => a.clock_in.localeCompare(b.clock_in))
      setEntriesByTech(em)

      const pm = new Map<string, PtoEntry[]>()
      for (const p of ptos) {
        const l = pm.get(p.technician_id); if (l) l.push(p); else pm.set(p.technician_id, [p])
      }
      for (const l of pm.values()) l.sort((a, b) => a.date.localeCompare(b.date))
      setPtoByTech(pm)

      setDrift(detectDrift({ run: r, entries, ptoEntries: ptos, technicians: techs }))
      setLoadError(null)
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : 'Could not load this pay run.')
    } finally {
      setLoading(false)
    }
  }, [supabase, id])

  useEffect(() => { fetchAll() }, [fetchAll])

  async function deleteRun() {
    if (!run) return
    const ok = await confirm({
      title: 'Delete this pay run?',
      message: 'This removes the frozen record of what you paid for this period, including every pay stub in it. The shifts and time off themselves are not touched — you can finalize the period again.',
      confirmLabel: 'Delete pay run',
      destructive: true,
    })
    if (!ok) return
    const { error } = await supabase.from('pay_runs').delete().eq('id', run.id)
    if (error) { notify.error('Could not delete: ' + error.message); return }
    notify.success('Pay run deleted.')
    router.push('/dashboard/dispatch/payroll/history')
  }

  function exportStubs() {
    if (!run || !lines.length) return
    exportRowsToCsv(`pay-stubs-${run.period_start.slice(0, 10)}-to-${run.period_end.slice(0, 10)}`, lines, [
      { label: 'Employee', value: l => l.technician_name },
      { label: 'Role', value: l => l.technician_role ?? '' },
      { label: 'Period start', value: () => run.period_start.slice(0, 10) },
      { label: 'Period end', value: () => run.period_end.slice(0, 10) },
      { label: 'Regular hours', value: l => decimalHours(l.regular_minutes) },
      { label: 'Overtime hours', value: l => decimalHours(l.ot_minutes) },
      { label: 'Paid time off hours', value: l => Number(l.pto_hours) },
      { label: 'Rate (blended $/hr)', value: l => Number(l.blended_rate) },
      { label: 'Regular pay', value: l => Number(l.regular_pay) },
      { label: 'Overtime pay', value: l => Number(l.ot_pay) },
      { label: 'Paid time off pay', value: l => Number(l.pto_pay) },
      { label: 'Gross pay', value: l => Number(l.gross_pay) },
      { label: 'Shifts', value: l => l.shifts },
    ])
    notify.success(`Exported ${lines.length} pay stub${lines.length !== 1 ? 's' : ''} to CSV.`)
  }

  if (loading) {
    return (
      <div className="max-w-5xl space-y-5">
        <PageHeader crumb={{ label: 'Payroll history', href: '/dashboard/dispatch/payroll/history' }} title="Pay run" />
        <SkeletonTiles count={4} />
        <SkeletonRows count={4} />
      </div>
    )
  }

  if (loadError || !run) {
    return (
      <div className="max-w-5xl space-y-5">
        <PageHeader crumb={{ label: 'Payroll history', href: '/dashboard/dispatch/payroll/history' }} title="Pay run" />
        <Banner tone="danger" icon={AlertTriangle}
          action={<Link href="/dashboard/dispatch/payroll/history"><Button size="sm" variant="secondary">Back to history</Button></Link>}>
          {loadError ?? 'Not found.'}
        </Banner>
      </div>
    )
  }

  const start = new Date(`${run.period_start.slice(0, 10)}T00:00:00`)
  const end = new Date(`${run.period_end.slice(0, 10)}T00:00:00`)
  const otOff = run.ot_daily_hours == null && run.ot_weekly_hours == null

  return (
    <div className="max-w-5xl space-y-5">
      <PageHeader
        crumb={{ label: 'Payroll history', href: '/dashboard/dispatch/payroll/history' }}
        title={`${format(start, 'MMM d')} – ${format(end, 'MMM d, yyyy')}`}
        description={`${PAY_PERIOD_LABELS[run.period_kind]} · finalized ${format(new Date(run.finalized_at), 'MMM d, yyyy')}`}
        action={
          <div className="flex items-center gap-2">
            <Button variant="secondary" size="sm" onClick={exportStubs}><Download className="w-3.5 h-3.5" /> CSV</Button>
            <Button variant="secondary" size="sm" onClick={() => window.print()}><Printer className="w-3.5 h-3.5" /> Print stubs</Button>
            <Button variant="ghost" size="sm" onClick={deleteRun} className="hover:text-red-400" title="Delete pay run">
              <Trash2 className="w-3.5 h-3.5" />
            </Button>
          </div>
        }
      />

      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        <StatTile label="Regular hours" icon={Clock} value={formatDuration(run.regular_minutes)} sub={`${decimalHours(run.regular_minutes)} h`} />
        <StatTile label="Overtime hours" icon={Timer} value={formatDuration(run.ot_minutes)}
          sub={otOff ? 'No OT rule was set' : `at ${Number(run.ot_multiplier)}×`}
          tone={run.ot_minutes > 0 ? 'warn' : undefined} tonedSurface={run.ot_minutes > 0} />
        <StatTile label="Paid time off" icon={Palmtree} value={`${Number(run.pto_hours)} h`} sub={formatCurrency(Number(run.pto_pay))} />
        <StatTile label="Gross paid" icon={Wallet} value={formatCurrency(Number(run.gross_pay))} sub={`${run.employee_count} employee${run.employee_count !== 1 ? 's' : ''}`} accent />
      </div>

      {/* The record is frozen — and honest about having been overtaken. */}
      {drift?.drifted && (
        <Banner tone="warn" icon={AlertTriangle}>
          Shifts in this period have changed since it was finalized. This run still shows what you
          actually paid ({formatCurrency(drift.paidGross)}); the same period now works out to{' '}
          {formatCurrency(drift.liveGross)} — a difference of {formatCurrency(Math.abs(drift.difference))}.
          Nothing is wrong with this record; it just isn’t the newest maths any more.
        </Banner>
      )}

      <Banner tone="info" icon={Lock}>
        Frozen with the rules used at the time:{' '}
        {otOff ? 'no overtime rule' : `overtime after ${[
          run.ot_daily_hours != null ? `${Number(run.ot_daily_hours)} h/day` : null,
          run.ot_weekly_hours != null ? `${Number(run.ot_weekly_hours)} h/week` : null,
        ].filter(Boolean).join(' or ')} at ${Number(run.ot_multiplier)}×`}
        {run.note && <> · {run.note}</>}
      </Banner>

      <Card>
        <CardBody className="p-0">
          <div className="px-5 py-3 border-b border-border">
            <h2 className="text-sm font-semibold text-ink">Pay stubs</h2>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border">
                  <th className="text-left px-5 py-2.5 text-[10px] font-semibold text-ink-faint uppercase tracking-wide">Employee</th>
                  <th className="text-right px-3 py-2.5 text-[10px] font-semibold text-ink-faint uppercase tracking-wide">Regular</th>
                  <th className="text-right px-3 py-2.5 text-[10px] font-semibold text-ink-faint uppercase tracking-wide">Overtime</th>
                  <th className="text-right px-3 py-2.5 text-[10px] font-semibold text-ink-faint uppercase tracking-wide hidden sm:table-cell">Time off</th>
                  <th className="text-right px-5 py-2.5 text-[10px] font-semibold text-ink-faint uppercase tracking-wide">Gross</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {lines.map(l => (
                  <tr key={l.id} className="hover:bg-surface-raised transition-colors">
                    <td className="px-5 py-3">
                      <p className="font-medium text-ink truncate">{l.technician_name}</p>
                      <p className="text-[11px] text-ink-faint tabular-nums">
                        {l.technician_role ? `${l.technician_role} · ` : ''}
                        {l.shifts} shift{l.shifts !== 1 ? 's' : ''}
                        {Number(l.blended_rate) > 0 && ` · ${formatCurrency(Number(l.blended_rate))}/hr`}
                        {/* The employee row is gone but the stub remains — say so. */}
                        {l.technician_id == null && <span className="text-amber-400"> · no longer on the roster</span>}
                      </p>
                    </td>
                    <td className="px-3 py-3 text-right tabular-nums text-ink">
                      {formatDuration(l.regular_minutes)}
                      <span className="block text-[11px] text-ink-faint">{formatCurrency(Number(l.regular_pay))}</span>
                    </td>
                    <td className="px-3 py-3 text-right tabular-nums">
                      <span className={cn(l.ot_minutes > 0 ? 'text-amber-400 font-semibold' : 'text-ink-faint')}>
                        {l.ot_minutes > 0 ? formatDuration(l.ot_minutes) : '—'}
                      </span>
                      {l.ot_minutes > 0 && <span className="block text-[11px] text-ink-faint">{formatCurrency(Number(l.ot_pay))}</span>}
                    </td>
                    <td className="px-3 py-3 text-right tabular-nums hidden sm:table-cell">
                      <span className={Number(l.pto_hours) > 0 ? 'text-ink' : 'text-ink-faint'}>
                        {Number(l.pto_hours) > 0 ? `${Number(l.pto_hours)} h` : '—'}
                      </span>
                      {Number(l.pto_pay) > 0 && <span className="block text-[11px] text-ink-faint">{formatCurrency(Number(l.pto_pay))}</span>}
                    </td>
                    <td className="px-5 py-3 text-right font-bold text-ink tabular-nums">{formatCurrency(Number(l.gross_pay))}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </CardBody>
      </Card>

      {/* ── Printable pay stubs (globals.css @media print) ── */}
      <div className="print-sheet hidden print:block text-[11px]">
        {lines.map((l, i) => {
          const shifts = l.technician_id ? entriesByTech.get(l.technician_id) ?? [] : []
          const ptos = l.technician_id ? ptoByTech.get(l.technician_id) ?? [] : []
          return (
            <section key={l.id} className={cn('print-keep', i < lines.length - 1 && 'print-break')}>
              <header className="mb-3">
                <h1 className="text-base font-bold">{l.technician_name} — Pay stub</h1>
                <p>
                  {settings?.company_name ? `${settings.company_name} · ` : ''}
                  {format(start, 'MMM d, yyyy')} – {format(end, 'MMM d, yyyy')} · {PAY_PERIOD_LABELS[run.period_kind]}
                </p>
                <p>Finalized {format(new Date(run.finalized_at), 'MMM d, yyyy')}</p>
              </header>

              <table className="w-full border-collapse mb-4">
                <thead>
                  <tr data-print-rule className="border-b border-black">
                    <th className="text-left py-1">Earnings</th>
                    <th className="text-right py-1">Hours</th>
                    <th className="text-right py-1">Rate</th>
                    <th className="text-right py-1">Amount</th>
                  </tr>
                </thead>
                <tbody>
                  <tr data-print-rule className="border-b border-black/20">
                    <td className="py-1">Regular</td>
                    <td className="py-1 text-right">{decimalHours(l.regular_minutes)}</td>
                    <td className="py-1 text-right">{Number(l.blended_rate) > 0 ? formatCurrency(Number(l.blended_rate)) : '—'}</td>
                    <td className="py-1 text-right">{formatCurrency(Number(l.regular_pay))}</td>
                  </tr>
                  {l.ot_minutes > 0 && (
                    <tr data-print-rule className="border-b border-black/20">
                      <td className="py-1">Overtime (at {Number(run.ot_multiplier)}×)</td>
                      <td className="py-1 text-right">{decimalHours(l.ot_minutes)}</td>
                      <td className="py-1 text-right">{formatCurrency(Number(l.blended_rate) * Number(run.ot_multiplier))}</td>
                      <td className="py-1 text-right">{formatCurrency(Number(l.ot_pay))}</td>
                    </tr>
                  )}
                  {Number(l.pto_hours) > 0 && (
                    <tr data-print-rule className="border-b border-black/20">
                      <td className="py-1">Paid time off</td>
                      <td className="py-1 text-right">{Number(l.pto_hours)}</td>
                      <td className="py-1 text-right">{Number(l.blended_rate) > 0 ? formatCurrency(Number(l.blended_rate)) : '—'}</td>
                      <td className="py-1 text-right">{formatCurrency(Number(l.pto_pay))}</td>
                    </tr>
                  )}
                  <tr data-print-rule className="border-t border-black">
                    <td className="py-1 font-bold" colSpan={3}>Gross pay</td>
                    <td className="py-1 text-right font-bold">{formatCurrency(Number(l.gross_pay))}</td>
                  </tr>
                </tbody>
              </table>

              {shifts.length > 0 && (
                <>
                  <p className="font-bold mb-1">Shifts</p>
                  <table className="w-full border-collapse mb-3">
                    <tbody>
                      {shifts.map(e => (
                        <tr key={e.id} data-print-rule className="border-b border-black/20">
                          <td className="py-0.5">{format(new Date(e.clock_in), 'EEE MMM d')}</td>
                          <td className="py-0.5">{format(new Date(e.clock_in), 'h:mm a')} – {e.clock_out ? format(new Date(e.clock_out), 'h:mm a') : '—'}</td>
                          <td className="py-0.5 text-right">{e.clock_out ? `${decimalHours(Math.max(0, e.minutes_worked ?? 0))} h` : 'open'}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </>
              )}

              {ptos.length > 0 && (
                <>
                  <p className="font-bold mb-1">Time off</p>
                  <table className="w-full border-collapse mb-3">
                    <tbody>
                      {ptos.map(p => (
                        <tr key={p.id} data-print-rule className="border-b border-black/20">
                          <td className="py-0.5">{format(new Date(`${p.date.slice(0, 10)}T00:00:00`), 'EEE MMM d')}</td>
                          <td className="py-0.5 capitalize">{p.kind}{!p.is_paid && ' (unpaid)'}</td>
                          <td className="py-0.5 text-right">{Number(p.hours)} h</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </>
              )}

              <p className="mt-4 text-[9px]">
                Gross pay before tax, deductions and remittances. This is a record of hours and
                earnings, not a statutory payroll document.
              </p>
            </section>
          )
        })}
      </div>
    </div>
  )
}
