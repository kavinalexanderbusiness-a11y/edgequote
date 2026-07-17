'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import Link from 'next/link'
import { format } from 'date-fns'
import { createClient } from '@/lib/supabase/client'
import type { PayRun } from '@/types'
import { PAY_PERIOD_LABELS } from '@/types'
import { decimalHours, formatDuration } from '@/lib/timeTracking'
import { exportRowsToCsv } from '@/lib/csv'
import { PageHeader } from '@/components/layout/PageHeader'
import { Card, CardBody } from '@/components/ui/Card'
import { Button } from '@/components/ui/Button'
import { StatTile } from '@/components/ui/StatTile'
import { Banner } from '@/components/ui/Banner'
import { EmptyState } from '@/components/ui/EmptyState'
import { SkeletonTiles, SkeletonRows } from '@/components/ui/Skeleton'
import { toast as notify } from '@/lib/toast'
import { formatCurrency } from '@/lib/utils'
import { Wallet, AlertTriangle, Download, History, ChevronRight, Timer } from 'lucide-react'

// ── Payroll history ──────────────────────────────────────────────────────────
// Every finalized pay run. These rows are READ, never recomputed: a pay run is
// what you actually paid, and lib/payRun snapshotted it for exactly that reason.
// The live, always-current view is the Payroll page.
export default function PayrollHistoryPage() {
  const supabase = useMemo(() => createClient(), [])
  const [runs, setRuns] = useState<PayRun[]>([])
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState<string | null>(null)

  const fetchAll = useCallback(async () => {
    try {
      const { data: { session } } = await supabase.auth.getSession()
      const user = session?.user
      if (!user) { setLoadError('Session expired — sign in again.'); return }
      const { data, error } = await supabase.from('pay_runs').select('*')
        .eq('user_id', user.id).order('period_start', { ascending: false })
      if (error) throw error
      setRuns((data as PayRun[]) ?? [])
      setLoadError(null)
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : 'Could not load payroll history.')
    } finally {
      setLoading(false)
    }
  }, [supabase])

  useEffect(() => { fetchAll() }, [fetchAll])

  const ytd = useMemo(() => {
    const year = new Date().getFullYear()
    const mine = runs.filter(r => new Date(`${r.period_start.slice(0, 10)}T00:00:00`).getFullYear() === year)
    return {
      gross: Math.round(mine.reduce((s, r) => s + Number(r.gross_pay), 0) * 100) / 100,
      runs: mine.length,
      otMinutes: mine.reduce((s, r) => s + r.ot_minutes, 0),
    }
  }, [runs])

  function exportAll() {
    if (!runs.length) { notify.error('No pay runs to export.'); return }
    exportRowsToCsv(`payroll-history-${format(new Date(), 'yyyy-MM-dd')}`, runs, [
      { label: 'Period start', value: r => r.period_start.slice(0, 10) },
      { label: 'Period end', value: r => r.period_end.slice(0, 10) },
      { label: 'Pay period', value: r => PAY_PERIOD_LABELS[r.period_kind] },
      { label: 'Finalized', value: r => format(new Date(r.finalized_at), 'yyyy-MM-dd HH:mm') },
      { label: 'Employees', value: r => r.employee_count },
      { label: 'Regular hours', value: r => decimalHours(r.regular_minutes) },
      { label: 'Overtime hours', value: r => decimalHours(r.ot_minutes) },
      { label: 'Worked pay', value: r => r.worked_pay },
      { label: 'Paid time off hours', value: r => r.pto_hours },
      { label: 'Paid time off pay', value: r => r.pto_pay },
      { label: 'Gross pay', value: r => r.gross_pay },
      // The rules that produced these numbers travel WITH them — a row that says
      // "44h weekly at 1.5x" is auditable years later; one that doesn't isn't.
      { label: 'OT rule: daily hours', value: r => r.ot_daily_hours ?? '' },
      { label: 'OT rule: weekly hours', value: r => r.ot_weekly_hours ?? '' },
      { label: 'OT rule: multiplier', value: r => r.ot_multiplier },
      { label: 'Note', value: r => r.note ?? '' },
    ])
    notify.success(`Exported ${runs.length} pay run${runs.length !== 1 ? 's' : ''} to CSV.`)
  }

  if (loading) {
    return (
      <div className="max-w-5xl space-y-5">
        <PageHeader crumb={{ label: 'Payroll', href: '/dashboard/dispatch/payroll' }} title="Payroll history"
          description="Every pay run you've finalized." />
        <SkeletonTiles count={3} />
        <SkeletonRows count={4} />
      </div>
    )
  }

  return (
    <div className="max-w-5xl space-y-5">
      <PageHeader
        crumb={{ label: 'Payroll', href: '/dashboard/dispatch/payroll' }}
        title="Payroll history"
        description="Every pay run you’ve finalized — what you actually paid, frozen."
        action={
          <Button variant="secondary" size="sm" onClick={exportAll} disabled={!runs.length}>
            <Download className="w-3.5 h-3.5" /> Export CSV
          </Button>
        }
      />

      {loadError && (
        <Banner tone="danger" icon={AlertTriangle}
          action={<Button size="sm" variant="secondary" onClick={() => { setLoading(true); fetchAll() }}>Retry</Button>}>
          {loadError}
        </Banner>
      )}

      {runs.length === 0 ? (
        <Card>
          <EmptyState icon={History} className="py-12" title="No pay runs yet"
            description="When a pay period is done, finalize it on the Payroll page. It gets frozen here with a pay stub for each person."
            action={{ label: 'Go to Payroll', href: '/dashboard/dispatch/payroll' }} />
        </Card>
      ) : (
        <>
          <div className="grid grid-cols-3 gap-3">
            <StatTile label={`Gross paid ${new Date().getFullYear()}`} icon={Wallet} value={formatCurrency(ytd.gross)}
              sub={`${ytd.runs} pay run${ytd.runs !== 1 ? 's' : ''}`} accent />
            <StatTile label="Overtime this year" icon={Timer} value={formatDuration(ytd.otMinutes)}
              sub={`${decimalHours(ytd.otMinutes)} h`} tone={ytd.otMinutes > 0 ? 'warn' : undefined} />
            <StatTile label="Pay runs" icon={History} value={String(runs.length)} sub="All time" />
          </div>

          <Card>
            <CardBody className="p-0">
              <div className="divide-y divide-border">
                {runs.map(r => (
                  <Link key={r.id} href={`/dashboard/dispatch/payroll/history/${r.id}`}
                    className="px-5 py-3.5 flex items-center gap-3 hover:bg-surface-raised transition-colors">
                    <div className="min-w-0 flex-1">
                      <p className="text-sm font-semibold text-ink tabular-nums truncate">
                        {format(new Date(`${r.period_start.slice(0, 10)}T00:00:00`), 'MMM d')} –{' '}
                        {format(new Date(`${r.period_end.slice(0, 10)}T00:00:00`), 'MMM d, yyyy')}
                      </p>
                      <p className="text-[11px] text-ink-faint tabular-nums">
                        {r.employee_count} employee{r.employee_count !== 1 ? 's' : ''} ·{' '}
                        {decimalHours(r.regular_minutes + r.ot_minutes)} h
                        {r.ot_minutes > 0 && <span className="text-amber-400"> · {decimalHours(r.ot_minutes)} h OT</span>}
                        {Number(r.pto_hours) > 0 && ` · ${Number(r.pto_hours)} h off`}
                        {' · finalized '}{format(new Date(r.finalized_at), 'MMM d')}
                      </p>
                      {r.note && <p className="text-[11px] text-ink-faint truncate mt-0.5">{r.note}</p>}
                    </div>
                    <span className="text-sm font-bold text-ink tabular-nums shrink-0">{formatCurrency(Number(r.gross_pay))}</span>
                    <ChevronRight className="w-4 h-4 text-ink-faint shrink-0" />
                  </Link>
                ))}
              </div>
            </CardBody>
          </Card>
        </>
      )}

      <p className="text-[11px] text-ink-faint text-center">
        A finalized pay run is frozen — it keeps showing what you paid even if a shift is edited later.
        Gross, before tax and deductions.
      </p>
    </div>
  )
}
