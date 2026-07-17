'use client'

import { useMemo } from 'react'
import { ReportShell } from '@/components/accounting/ReportShell'
import type { AccountingData } from '@/lib/accounting/data'
import type { Period } from '@/lib/accounting/period'
import type { CategorySlice } from '@/lib/accounting/report'
import { profitAndLoss } from '@/lib/accounting/report'
import { profitAndLossLines, STATEMENT_COLUMNS } from '@/lib/accounting/exports'
import { formatPct } from '@/lib/margin'
import { exportRowsToCsv } from '@/lib/csv'
import { Card, CardBody } from '@/components/ui/Card'
import { Button } from '@/components/ui/Button'
import { Banner } from '@/components/ui/Banner'
import { Badge } from '@/components/ui/Badge'
import { formatCurrency } from '@/lib/utils'
import { Download, Info } from 'lucide-react'

// ── Profit & Loss ────────────────────────────────────────────────────────────
// Pure presentation over profitAndLoss(). Not one arithmetic operation in this
// file: every figure is read off the engine result, so this page and the dashboard
// and the CSV cannot disagree.

export default function PnlPage() {
  return (
    <ReportShell
      title="Profit & Loss"
      description="What the business earned, what it cost, and what's left."
      action={({ data, period }) => (
        <Button
          variant="secondary"
          onClick={() =>
            exportRowsToCsv(
              `profit-and-loss-${period.from}-to-${period.to}`,
              profitAndLossLines(profitAndLoss({ ...data, period })),
              STATEMENT_COLUMNS,
            )
          }
        >
          <Download className="w-4 h-4" /> Export
        </Button>
      )}
    >
      {({ data, period }) => <Pnl data={data} period={period} />}
    </ReportShell>
  )
}

function Pnl({ data, period }: { data: AccountingData; period: Period }) {
  const pl = useMemo(() => profitAndLoss({ ...data, period }), [data, period])
  const booksEmpty = pl.expenseCount === 0

  return (
    <div className="flex flex-col gap-5">
      {booksEmpty && (
        <Banner tone="info" icon={Info}>
          <strong>These books are empty.</strong> With no expenses recorded, profit is just
          revenue and the margin reads 100% — arithmetically right, and not true of any real
          business.
        </Banner>
      )}
      {pl.undatedCashCount > 0 && (
        <Banner tone="warn">
          {formatCurrency(pl.undatedCash)} of collected payments have no payment date, so they
          belong to no period at all. Revenue below is short by that much.
        </Banner>
      )}

      <Card>
        <CardBody>
          <div className="flex items-center justify-between mb-1">
            <h2 className="text-sm font-semibold text-ink">{period.label}</h2>
            <Badge tone="neutral">Cash basis</Badge>
          </div>
          <p className="text-xs text-ink-faint mb-5">
            Money that actually moved — revenue when collected, cost when paid. Your GST return
            is worked out differently (see the GST page) and that&apos;s meant to differ.
          </p>

          <dl className="flex flex-col">
            <Line label="Cash collected" value={pl.cashCollected} note={`${pl.paymentCount} payment${pl.paymentCount === 1 ? '' : 's'}`} />
            {pl.refunded > 0 && <Line label="Refunded" value={-pl.refunded} note="paid back to customers" indent />}
            {pl.registrant && (
              <Line label="Less GST collected" value={-pl.salesTaxCollected} note="held for the CRA — never revenue" indent />
            )}
            <Line label="Revenue" value={pl.revenue} strong />

            <Divider />

            {pl.byCategory.length === 0 ? (
              <p className="text-sm text-ink-faint py-2">No costs recorded in this period.</p>
            ) : (
              pl.byCategory.map((c: CategorySlice) => (
                <Line
                  key={c.categoryId ?? 'none'}
                  label={c.name}
                  value={c.cost}
                  note={`${c.count} item${c.count === 1 ? '' : 's'}${c.tax_deductible ? '' : ' · not deductible'}`}
                  indent
                />
              ))
            )}
            <Line
              label="Operating cost"
              value={pl.cost}
              strong
              note={pl.registrant ? `net of ${formatCurrency(pl.taxPaid)} reclaimable tax` : 'gross — tax is not reclaimable for you'}
            />

            <Divider />

            <Line label="Profit" value={pl.profit} strong accent />
            <div className="flex items-baseline justify-between py-2">
              <dt className="text-sm text-ink-muted">Margin</dt>
              <dd className="text-sm tabular-nums text-ink">
                {booksEmpty ? <span className="text-ink-faint">—</span> : formatPct(pl.margin)}
              </dd>
            </div>
          </dl>
        </CardBody>
      </Card>

      {/* The money that left but isn't a cost. Shown, because it's real cash and its
          absence from the figures above is exactly what an owner would query. */}
      {(pl.capitalSpend > 0 || pl.ownerDraws > 0) && (
        <Card>
          <CardBody>
            <h2 className="text-sm font-semibold text-ink">Money out that isn&apos;t a cost</h2>
            <p className="text-xs text-ink-faint mb-3">
              Real cash left the bank, so it&apos;s in Cash Flow — but neither of these is a cost
              of earning the revenue above, so neither is in the profit figure.
            </p>
            <dl className="flex flex-col">
              {pl.capitalSpend > 0 && (
                <Line label="Capital purchases" value={pl.capitalSpend} note="cash became an asset — it wears out over years, not at once" indent />
              )}
              {pl.ownerDraws > 0 && (
                <Line label="Owner draws" value={pl.ownerDraws} note="profit taken out, not a cost of earning it" indent />
              )}
              <Line label="Total cash out" value={pl.spendGross} strong note="what the bank saw" />
            </dl>
          </CardBody>
        </Card>
      )}

      {pl.uncategorisedCount > 0 && (
        <Banner tone="warn">
          {pl.uncategorisedCount} expense{pl.uncategorisedCount === 1 ? '' : 's'} with no category —
          they&apos;re in the total but grouped under &ldquo;Uncategorised&rdquo;.
        </Banner>
      )}
    </div>
  )
}

function Line({ label, value, note, strong, indent, accent }: {
  label: string; value: number; note?: string; strong?: boolean; indent?: boolean; accent?: boolean
}) {
  return (
    <div className={`flex items-baseline justify-between gap-4 py-1.5 ${strong ? 'border-t border-line mt-1 pt-2' : ''}`}>
      <dt className={`text-sm ${indent ? 'pl-4 text-ink-muted' : strong ? 'font-semibold text-ink' : 'text-ink'}`}>
        {label}
        {note && <span className="block text-xs text-ink-faint pl-0">{note}</span>}
      </dt>
      <dd className={`text-sm tabular-nums shrink-0 ${strong ? 'font-semibold' : ''} ${accent ? (value >= 0 ? 'text-success' : 'text-danger') : 'text-ink'}`}>
        {formatCurrency(value)}
      </dd>
    </div>
  )
}

const Divider = () => <div className="h-3" />
