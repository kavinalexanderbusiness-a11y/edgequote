'use client'

import { useMemo } from 'react'
import { ReportShell } from '@/components/accounting/ReportShell'
import type { AccountingData } from '@/lib/accounting/data'
import type { Period } from '@/lib/accounting/period'
import { cashFlow, profitAndLoss } from '@/lib/accounting/report'
import { monthKeyLabel } from '@/lib/accounting/period'
import { cashFlowLines, STATEMENT_COLUMNS } from '@/lib/accounting/exports'
import { exportRowsToCsv } from '@/lib/csv'
import { Card, CardBody } from '@/components/ui/Card'
import { Button } from '@/components/ui/Button'
import { StatTile } from '@/components/ui/StatTile'
import { Badge } from '@/components/ui/Badge'
import { InlineEmpty } from '@/components/ui/EmptyState'
import { formatCurrency } from '@/lib/utils'
import { Download, TrendingUp, TrendingDown, Wallet, Waves } from 'lucide-react'

// ── Cash Flow ────────────────────────────────────────────────────────────────
// GROSS on both sides, because this is the statement that has to reconcile against
// a bank statement — and the bank moved the gross. It counts money the P&L rightly
// refuses to call a cost (capital purchases, owner draws, the tax inside a receipt),
// which is exactly why the two figures differ and why both are correct.

export default function CashFlowPage() {
  return (
    <ReportShell
      title="Cash Flow"
      description="What actually moved through the bank."
      action={({ data, period }) => (
        <Button
          variant="secondary"
          onClick={() =>
            exportRowsToCsv(
              `cash-flow-${period.from}-to-${period.to}`,
              cashFlowLines(cashFlow({ ...data, period })),
              STATEMENT_COLUMNS,
            )
          }
        >
          <Download className="w-4 h-4" /> Export
        </Button>
      )}
    >
      {({ data, period }) => <Flow data={data} period={period} />}
    </ReportShell>
  )
}

function Flow({ data, period }: { data: AccountingData; period: Period }) {
  const cf = useMemo(() => cashFlow({ ...data, period }), [data, period])
  const pl = useMemo(() => profitAndLoss({ ...data, period }), [data, period])

  // The gap between cash and profit, itemised. "I made $3k profit but my bank went
  // down" is the single most common confusion in small-business accounting, and it
  // deserves an answer on the page rather than a support conversation.
  const gap = useMemo(() => {
    const items: { label: string; value: number; why: string }[] = []
    if (pl.capitalSpend > 0) items.push({ label: 'Capital purchases', value: -pl.capitalSpend, why: 'bought assets — cash out, but not a cost' })
    if (pl.ownerDraws > 0) items.push({ label: 'Owner draws', value: -pl.ownerDraws, why: 'profit taken out, not a cost of earning it' })
    if (pl.registrant && pl.salesTaxCollected > 0) items.push({ label: 'GST collected', value: pl.salesTaxCollected, why: "cash you're holding for the CRA — never revenue" })
    if (pl.registrant && pl.taxPaid > 0) items.push({ label: 'GST paid on costs', value: -pl.taxPaid, why: 'cash out now, reclaimed later as a credit' })
    return items
  }, [pl])

  const max = Math.max(1, ...cf.byMonth.map(m => Math.max(m.inflow, m.outflow)))

  return (
    <div className="flex flex-col gap-5">
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        <StatTile label="Cash in" value={<span className="tabular-nums">{formatCurrency(cf.inflow)}</span>} icon={TrendingUp} />
        <StatTile label="Cash out" value={<span className="tabular-nums">{formatCurrency(cf.outflow)}</span>} icon={TrendingDown} />
        <StatTile
          label="Net movement"
          value={<span className="tabular-nums">{formatCurrency(cf.net)}</span>}
          sub={cf.net >= 0 ? 'the bank grew' : 'the bank shrank'}
          icon={Waves}
          tone={cf.net >= 0 ? 'success' : 'danger'}
          accent
        />
        <StatTile
          label="Profit (for contrast)"
          value={<span className="tabular-nums">{formatCurrency(pl.profit)}</span>}
          sub="different on purpose — see below"
          icon={Wallet}
        />
      </div>

      {/* Why cash ≠ profit, in dollars. */}
      {gap.length > 0 && (
        <Card>
          <CardBody>
            <div className="flex items-center justify-between mb-1">
              <h2 className="text-sm font-semibold text-ink">Why the bank and the profit disagree</h2>
              <Badge tone="neutral">both correct</Badge>
            </div>
            <p className="text-xs text-ink-faint mb-3">
              Profit is what you earned. Cash is what moved. These are the things that are one but
              not the other — none of them is an error.
            </p>
            <dl className="flex flex-col">
              <div className="flex items-baseline justify-between py-1.5">
                <dt className="text-sm text-ink">Profit</dt>
                <dd className="text-sm tabular-nums text-ink">{formatCurrency(pl.profit)}</dd>
              </div>
              {gap.map(g => (
                <div key={g.label} className="flex items-baseline justify-between gap-4 py-1.5">
                  <dt className="text-sm text-ink-muted pl-4">
                    {g.label}
                    <span className="block text-xs text-ink-faint">{g.why}</span>
                  </dt>
                  <dd className="text-sm tabular-nums text-ink-muted shrink-0">{formatCurrency(g.value)}</dd>
                </div>
              ))}
              <div className="flex items-baseline justify-between border-t border-line mt-1 pt-2">
                <dt className="text-sm font-semibold text-ink">Net cash movement</dt>
                <dd className="text-sm font-semibold tabular-nums text-ink">{formatCurrency(cf.net)}</dd>
              </div>
            </dl>
          </CardBody>
        </Card>
      )}

      <Card>
        <CardBody>
          <h2 className="text-sm font-semibold text-ink mb-3">Month by month</h2>
          {cf.byMonth.length === 0 ? (
            <InlineEmpty icon={Waves}>Nothing moved in {period.label}.</InlineEmpty>
          ) : (
            <div className="flex flex-col gap-3">
              {cf.byMonth.map(m => (
                <div key={m.key} className="flex items-center gap-3">
                  <span className="w-20 shrink-0 text-xs text-ink-muted">{monthKeyLabel(m.key)}</span>
                  <div className="flex-1 flex flex-col gap-1">
                    <span className="h-2 rounded-full bg-surface-sunken overflow-hidden">
                      <span className="block h-full rounded-full bg-success/70" style={{ width: `${(m.inflow / max) * 100}%` }} />
                    </span>
                    <span className="h-2 rounded-full bg-surface-sunken overflow-hidden">
                      <span className="block h-full rounded-full bg-danger/60" style={{ width: `${(m.outflow / max) * 100}%` }} />
                    </span>
                  </div>
                  <span className={`w-24 shrink-0 text-right text-sm tabular-nums ${m.net >= 0 ? 'text-ink' : 'text-danger'}`}>
                    {formatCurrency(m.net)}
                  </span>
                </div>
              ))}
            </div>
          )}
        </CardBody>
      </Card>
    </div>
  )
}
