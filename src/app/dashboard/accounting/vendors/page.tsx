'use client'

import { useMemo } from 'react'
import { ReportShell } from '@/components/accounting/ReportShell'
import type { AccountingData } from '@/lib/accounting/data'
import type { Period } from '@/lib/accounting/period'
import { profitAndLoss, expensesInPeriod } from '@/lib/accounting/report'
import { accountsPayable } from '@/lib/accounting/balanceSheet'
import { isUnpaid } from '@/lib/accounting/expenses'
import { exportRowsToCsv } from '@/lib/csv'
import { Card, CardBody } from '@/components/ui/Card'
import { Button } from '@/components/ui/Button'
import { Banner } from '@/components/ui/Banner'
import { StatTile } from '@/components/ui/StatTile'
import { InlineEmpty } from '@/components/ui/EmptyState'
import { Th, Td, tableRowHover } from '@/components/ui/Table'
import { formatCurrency, formatDate } from '@/lib/utils'
import { Download, Store, TrendingDown, AlertTriangle } from 'lucide-react'

// ── Vendor analytics ─────────────────────────────────────────────────────────
// Reads profitAndLoss().byVendor — the slice was computed in Phase 1 and never
// rendered. Nothing is re-summed here.

export default function VendorAnalyticsPage() {
  return (
    <ReportShell
      title="Vendors"
      description="Who the money goes to, and what you still owe them."
      action={({ data, period }) => (
        <Button
          variant="secondary"
          onClick={() =>
            exportRowsToCsv(
              `vendor-spend-${period.from}-to-${period.to}`,
              profitAndLoss({ ...data, period }).byVendor,
              [
                { label: 'Vendor', value: v => v.name },
                { label: 'Cost', value: v => v.cost },
                { label: 'Gross spend', value: v => v.gross },
                { label: 'Expenses', value: v => v.count },
              ],
            )
          }
        >
          <Download className="w-4 h-4" /> Export
        </Button>
      )}
    >
      {({ data, period, todayISO }) => <Vendors data={data} period={period} todayISO={todayISO} />}
    </ReportShell>
  )
}

function Vendors({ data, period, todayISO }: { data: AccountingData; period: Period; todayISO: string }) {
  const pl = useMemo(() => profitAndLoss({ ...data, period }), [data, period])

  // Money owed, by vendor. A/P is a position, not a flow, so it's measured as at
  // today across ALL bills — not filtered to the period, which would hide an old
  // unpaid bill exactly when it matters most.
  const owed = useMemo(() => {
    const m = new Map<string, { name: string; total: number; count: number; oldest: string }>()
    for (const e of data.expenses) {
      if (!isUnpaid(e) || e.bill_date > todayISO) continue
      const key = e.vendor_id ?? '__none__'
      const cur = m.get(key) || { name: e.vendors?.name ?? 'No vendor', total: 0, count: 0, oldest: e.bill_date }
      cur.total += Number(e.amount) || 0
      cur.count++
      if (e.bill_date < cur.oldest) cur.oldest = e.bill_date
      m.set(key, cur)
    }
    return [...m.values()].sort((a, b) => b.total - a.total)
  }, [data.expenses, todayISO])

  const totalOwed = useMemo(() => accountsPayable(data.expenses, todayISO), [data.expenses, todayISO])
  const inPeriodCount = useMemo(() => expensesInPeriod(data.expenses, period).length, [data.expenses, period])
  const top = pl.byVendor[0]

  return (
    <div className="flex flex-col gap-5">
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        <StatTile label="Vendors used" value={<span className="tabular-nums">{pl.byVendor.length}</span>} sub={`${inPeriodCount} expenses`} icon={Store} />
        <StatTile label="Total spend" value={<span className="tabular-nums">{formatCurrency(pl.cost)}</span>} icon={TrendingDown} />
        <StatTile
          label="Biggest"
          value={top ? <span className="text-base">{top.name}</span> : '—'}
          sub={top ? `${formatCurrency(top.cost)} · ${Math.round(top.share * 100)}% of spend` : 'nothing recorded'}
        />
        <StatTile
          label="You owe"
          value={<span className="tabular-nums">{formatCurrency(totalOwed)}</span>}
          sub={totalOwed > 0 ? 'unpaid bills, as at today' : 'nothing outstanding'}
          icon={AlertTriangle}
          tone={totalOwed > 0 ? 'warn' : undefined}
        />
      </div>

      {owed.length > 0 && (
        <Card>
          <CardBody>
            <h2 className="text-sm font-semibold text-ink mb-1">Bills you haven&apos;t paid</h2>
            <p className="text-xs text-ink-faint mb-3">
              As at today, across every period — an old unpaid bill shouldn&apos;t disappear just
              because you&apos;re looking at this month.
            </p>
            <div className="flex flex-col gap-2">
              {owed.map(o => (
                <div key={o.name} className="flex items-baseline justify-between gap-4 text-sm">
                  <span className="text-ink">
                    {o.name}
                    <span className="block text-xs text-ink-faint">
                      {o.count} bill{o.count === 1 ? '' : 's'} · oldest {formatDate(o.oldest)}
                    </span>
                  </span>
                  <span className="tabular-nums text-warn font-medium shrink-0">{formatCurrency(o.total)}</span>
                </div>
              ))}
            </div>
          </CardBody>
        </Card>
      )}

      {pl.byVendor.length > 0 && top && top.share > 0.5 && (
        <Banner tone="info">
          {Math.round(top.share * 100)}% of your spend goes to {top.name}. That&apos;s not
          automatically bad — one good supplier often is — but it&apos;s worth knowing what a price
          rise there would cost you.
        </Banner>
      )}

      <Card>
        {pl.byVendor.length === 0 ? (
          <CardBody><InlineEmpty icon={Store}>No vendor spend in {period.label}.</InlineEmpty></CardBody>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr>
                  <Th>Vendor</Th>
                  <Th>Share of spend</Th>
                  <Th className="text-right">Expenses</Th>
                  <Th className="text-right">Cost</Th>
                </tr>
              </thead>
              <tbody>
                {pl.byVendor.map(v => (
                  <tr key={v.vendorId ?? 'none'} className={tableRowHover}>
                    <Td className="text-ink">{v.name}</Td>
                    <Td>
                      <span className="flex items-center gap-2">
                        <span className="w-32 h-2 rounded-full bg-surface-sunken overflow-hidden">
                          <span className="block h-full rounded-full bg-accent/70" style={{ width: `${Math.max(2, v.share * 100)}%` }} />
                        </span>
                        <span className="text-xs text-ink-faint tabular-nums">{Math.round(v.share * 100)}%</span>
                      </span>
                    </Td>
                    <Td className="text-right tabular-nums text-ink-muted">{v.count}</Td>
                    <Td className="text-right tabular-nums text-ink font-medium">{formatCurrency(v.cost)}</Td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </div>
  )
}
