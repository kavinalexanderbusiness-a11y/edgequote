'use client'

import { useMemo } from 'react'
import { ReportShell } from '@/components/accounting/ReportShell'
import type { AccountingData } from '@/lib/accounting/data'
import type { Period } from '@/lib/accounting/period'
import { profitAndLoss, expensesInPeriod } from '@/lib/accounting/report'
import { monthKeyLabel } from '@/lib/accounting/period'
import { EXPENSE_COLUMNS } from '@/lib/accounting/exports'
import { exportRowsToCsv } from '@/lib/csv'
import { Card, CardBody } from '@/components/ui/Card'
import { Button } from '@/components/ui/Button'
import { Banner } from '@/components/ui/Banner'
import { Badge } from '@/components/ui/Badge'
import { StatTile } from '@/components/ui/StatTile'
import { InlineEmpty } from '@/components/ui/EmptyState'
import { formatCurrency } from '@/lib/utils'
import { Download, Receipt, Tags, Paperclip } from 'lucide-react'

// ── Expense analytics ────────────────────────────────────────────────────────
// Where the money goes, by category and over time. Reads profitAndLoss().byCategory
// and .byMonth — both computed by the engine, neither re-derived here.

export default function ExpenseReportPage() {
  return (
    <ReportShell
      title="Expenses"
      description="Where the money goes."
      action={({ data, period }) => (
        <Button
          variant="secondary"
          onClick={() =>
            exportRowsToCsv(
              `expenses-${period.from}-to-${period.to}`,
              expensesInPeriod(data.expenses, period),
              EXPENSE_COLUMNS,
            )
          }
        >
          <Download className="w-4 h-4" /> Export
        </Button>
      )}
    >
      {({ data, period }) => <Expenses data={data} period={period} />}
    </ReportShell>
  )
}

function Expenses({ data, period }: { data: AccountingData; period: Period }) {
  const pl = useMemo(() => profitAndLoss({ ...data, period }), [data, period])
  const rows = useMemo(() => expensesInPeriod(data.expenses, period), [data.expenses, period])

  const withReceipts = rows.filter(e => e.receipt_path).length
  const receiptShare = rows.length > 0 ? withReceipts / rows.length : 0
  const maxMonth = Math.max(1, ...pl.byMonth.map(m => m.cost))

  return (
    <div className="flex flex-col gap-5">
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        <StatTile label="Total cost" value={<span className="tabular-nums">{formatCurrency(pl.cost)}</span>} sub={`${pl.expenseCount} expense${pl.expenseCount === 1 ? '' : 's'}`} icon={Receipt} accent />
        <StatTile label="Categories used" value={<span className="tabular-nums">{pl.byCategory.length}</span>} icon={Tags} />
        <StatTile
          label="Deductible"
          value={<span className="tabular-nums">{formatCurrency(pl.deductibleCost)}</span>}
          sub={pl.cost > pl.deductibleCost ? `${formatCurrency(pl.cost - pl.deductibleCost)} you can't claim` : 'all of it'}
        />
        <StatTile
          label="With a receipt"
          value={<span className="tabular-nums">{Math.round(receiptShare * 100)}%</span>}
          sub={`${withReceipts} of ${rows.length} backed up`}
          icon={Paperclip}
          tone={receiptShare < 0.5 && rows.length > 0 ? 'warn' : undefined}
        />
      </div>

      {rows.length > 0 && receiptShare < 0.5 && (
        <Banner tone="warn">
          Fewer than half your expenses have a receipt attached. The CRA can disallow a claim it
          can&apos;t see evidence for — and receipts are much easier to attach now than to find
          later.
        </Banner>
      )}

      {pl.uncategorisedCount > 0 && (
        <Banner tone="warn">
          {pl.uncategorisedCount} expense{pl.uncategorisedCount === 1 ? '' : 's'} with no category.
          They&apos;re counted in the total, but they can&apos;t be grouped or claimed properly.
        </Banner>
      )}

      <Card>
        <CardBody>
          <h2 className="text-sm font-semibold text-ink mb-3">By category</h2>
          {pl.byCategory.length === 0 ? (
            <InlineEmpty icon={Tags}>No costs in {period.label}.</InlineEmpty>
          ) : (
            <div className="flex flex-col gap-2.5">
              {pl.byCategory.map(c => (
                <div key={c.categoryId ?? 'none'} className="flex items-center gap-3">
                  <span className="w-36 shrink-0 text-sm text-ink-muted truncate">{c.name}</span>
                  <span className="flex-1 h-2 rounded-full bg-surface-sunken overflow-hidden">
                    <span className="block h-full rounded-full bg-accent/70" style={{ width: `${Math.max(2, c.share * 100)}%` }} />
                  </span>
                  <span className="w-12 shrink-0 text-right text-xs text-ink-faint tabular-nums">{Math.round(c.share * 100)}%</span>
                  <span className="w-24 shrink-0 text-right text-sm tabular-nums text-ink">{formatCurrency(c.cost)}</span>
                  {!c.tax_deductible && <Badge tone="neutral">not deductible</Badge>}
                </div>
              ))}
            </div>
          )}
        </CardBody>
      </Card>

      <Card>
        <CardBody>
          <h2 className="text-sm font-semibold text-ink mb-3">Over time</h2>
          {pl.byMonth.length === 0 ? (
            <InlineEmpty icon={Receipt}>Nothing to chart yet.</InlineEmpty>
          ) : (
            <div className="flex flex-col gap-2">
              {pl.byMonth.map(m => (
                <div key={m.key} className="flex items-center gap-3">
                  <span className="w-20 shrink-0 text-xs text-ink-muted">{monthKeyLabel(m.key)}</span>
                  <span className="flex-1 h-2 rounded-full bg-surface-sunken overflow-hidden">
                    <span className="block h-full rounded-full bg-danger/60" style={{ width: `${(m.cost / maxMonth) * 100}%` }} />
                  </span>
                  <span className="w-24 shrink-0 text-right text-sm tabular-nums text-ink">{formatCurrency(m.cost)}</span>
                </div>
              ))}
            </div>
          )}
        </CardBody>
      </Card>
    </div>
  )
}
