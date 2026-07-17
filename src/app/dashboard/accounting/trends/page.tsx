'use client'

import { useMemo } from 'react'
import { ReportShell } from '@/components/accounting/ReportShell'
import type { AccountingData } from '@/lib/accounting/data'
import type { Period } from '@/lib/accounting/period'
import { trend, type Change } from '@/lib/accounting/trends'
import { formatPct } from '@/lib/margin'
import { exportRowsToCsv } from '@/lib/csv'
import { Card, CardBody } from '@/components/ui/Card'
import { Button } from '@/components/ui/Button'
import { StatTile } from '@/components/ui/StatTile'
import { InlineEmpty } from '@/components/ui/EmptyState'
import { formatCurrency } from '@/lib/utils'
import { Download, TrendingUp, TrendingDown, Minus, Calendar } from 'lucide-react'

// ── Financial trends ─────────────────────────────────────────────────────────
// Shape, not totals. Everything is read off trend(), which is itself read off
// profitAndLoss() — so a trend can never disagree with the P&L it sits beside.

export default function TrendsPage() {
  return (
    <ReportShell
      title="Trends"
      description="The shape of the year, not just the total."
      action={({ data, period }) => (
        <Button
          variant="secondary"
          onClick={() =>
            exportRowsToCsv(
              `trends-${period.from}-to-${period.to}`,
              trend({ ...data, period }).points,
              [
                { label: 'Month', value: p => p.label },
                { label: 'Revenue', value: p => p.revenue },
                { label: 'Cost', value: p => p.cost },
                { label: 'Profit', value: p => p.profit },
                { label: 'Margin %', value: p => (p.margin == null ? '—' : p.margin) },
                { label: 'Profit to date', value: p => p.runningProfit },
              ],
            )
          }
        >
          <Download className="w-4 h-4" /> Export
        </Button>
      )}
    >
      {({ data, period }) => <Trends data={data} period={period} />}
    </ReportShell>
  )
}

function Trends({ data, period }: { data: AccountingData; period: Period }) {
  const t = useMemo(() => trend({ ...data, period }), [data, period])

  if (t.points.length === 0) {
    return <InlineEmpty icon={Calendar}>Nothing in {period.label} to chart.</InlineEmpty>
  }

  const scale = Math.max(1, ...t.points.map(p => Math.max(p.revenue, p.cost)))

  return (
    <div className="flex flex-col gap-5">
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        <StatTile
          label="Revenue"
          value={<span className="tabular-nums">{formatCurrency(t.totalRevenue)}</span>}
          sub={<ChangeNote c={t.revenueChange} />}
          icon={TrendingUp}
        />
        <StatTile
          label="Profit"
          value={<span className="tabular-nums">{formatCurrency(t.totalProfit)}</span>}
          sub={<ChangeNote c={t.profitChange} />}
          accent
        />
        <StatTile
          label="Best month"
          value={t.bestMonth ? <span className="text-base">{t.bestMonth.label}</span> : '—'}
          // By PROFIT, not revenue: ranking by revenue is how a business celebrates
          // the month it billed a lot and spent more.
          sub={t.bestMonth ? `${formatCurrency(t.bestMonth.profit)} profit` : ''}
        />
        <StatTile
          label="Months in the black"
          value={<span className="tabular-nums">{t.profitableMonths} of {t.points.length}</span>}
          sub={`${formatCurrency(t.averageProfit)} average`}
        />
      </div>

      <Card>
        <CardBody>
          <h2 className="text-sm font-semibold text-ink mb-1">Revenue against cost</h2>
          <p className="text-xs text-ink-faint mb-4">Green is what came in, red is what it cost. The gap is the profit.</p>
          <div className="flex flex-col gap-3">
            {t.points.map(p => (
              <div key={p.key} className="flex items-center gap-3">
                <span className="w-20 shrink-0 text-xs text-ink-muted">{p.label}</span>
                <div className="flex-1 flex flex-col gap-1">
                  <span className="h-2.5 rounded-full bg-surface-sunken overflow-hidden">
                    <span className="block h-full rounded-full bg-success/70" style={{ width: `${(p.revenue / scale) * 100}%` }} />
                  </span>
                  <span className="h-2.5 rounded-full bg-surface-sunken overflow-hidden">
                    <span className="block h-full rounded-full bg-danger/60" style={{ width: `${(p.cost / scale) * 100}%` }} />
                  </span>
                </div>
                <span className={`w-24 shrink-0 text-right text-sm tabular-nums ${p.profit >= 0 ? 'text-ink' : 'text-danger'}`}>
                  {formatCurrency(p.profit)}
                </span>
                <span className="w-14 shrink-0 text-right text-xs text-ink-faint tabular-nums">
                  {formatPct(p.margin)}
                </span>
              </div>
            ))}
          </div>
        </CardBody>
      </Card>

      <Card>
        <CardBody>
          <h2 className="text-sm font-semibold text-ink mb-3">Profit, adding up</h2>
          <div className="flex flex-col gap-1.5">
            {t.points.map(p => (
              <div key={p.key} className="flex items-baseline justify-between gap-4 text-sm">
                <span className="text-ink-muted">{p.label}</span>
                <span className={`tabular-nums ${p.runningProfit >= 0 ? 'text-ink' : 'text-danger'}`}>
                  {formatCurrency(p.runningProfit)}
                </span>
              </div>
            ))}
          </div>
        </CardBody>
      </Card>
    </div>
  )
}

function ChangeNote({ c }: { c: Change | null }) {
  if (!c) return <>no earlier period to compare</>
  const Icon = c.direction === 'up' ? TrendingUp : c.direction === 'down' ? TrendingDown : Minus
  return (
    <span className="inline-flex items-center gap-1">
      <Icon className="w-3 h-3" />
      {/* A percent needs a base. 0 → 500 isn't "infinite growth", it's a first
          month — so the engine returns null and we say the dollars instead. */}
      {c.percent == null
        ? `${formatCurrency(c.delta)} vs nothing before`
        : `${c.percent > 0 ? '+' : ''}${c.percent}% vs last period`}
    </span>
  )
}
