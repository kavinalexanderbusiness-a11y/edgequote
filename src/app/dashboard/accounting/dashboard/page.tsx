'use client'

import { useMemo } from 'react'
import Link from 'next/link'
import { ReportShell } from '@/components/accounting/ReportShell'
import type { AccountingData } from '@/lib/accounting/data'
import type { Period } from '@/lib/accounting/period'
import { profitAndLoss, cashFlow } from '@/lib/accounting/report'
import { balanceSheet, accountsPayable } from '@/lib/accounting/balanceSheet'
import { gstReturn } from '@/lib/accounting/gst'
import { trend } from '@/lib/accounting/trends'
import { formatPct } from '@/lib/margin'
import { Card, CardBody } from '@/components/ui/Card'
import { StatTile } from '@/components/ui/StatTile'
import { Banner } from '@/components/ui/Banner'
import { Badge } from '@/components/ui/Badge'
import { Button } from '@/components/ui/Button'
import { formatCurrency } from '@/lib/utils'
import {
  TrendingUp, Wallet, Waves, Receipt, ArrowRight, AlertTriangle, Info, Scale,
} from 'lucide-react'

// ── Financial dashboard ──────────────────────────────────────────────────────
// One screen that answers "how is the business doing", and routes to the statement
// behind each number.
//
// Every figure is read off an engine — the same engines the individual pages use, so
// this can't drift from them. What it adds is JUDGEMENT: which of these numbers
// deserves attention right now, and why. That's the only thing a dashboard should
// add, and it must never be a wall of vanity stats.

export default function FinancialDashboardPage() {
  return (
    <ReportShell title="Financial dashboard" description="How the business is actually doing.">
      {({ data, period, todayISO }) => <Dash data={data} period={period} todayISO={todayISO} />}
    </ReportShell>
  )
}

function Dash({ data, period, todayISO }: { data: AccountingData; period: Period; todayISO: string }) {
  const pl = useMemo(() => profitAndLoss({ ...data, period }), [data, period])
  const cf = useMemo(() => cashFlow({ ...data, period }), [data, period])
  const bs = useMemo(() => balanceSheet({ ...data, asOf: todayISO, todayISO }), [data, todayISO])
  const gst = useMemo(() => gstReturn({ ...data, period }), [data, period])
  const t = useMemo(() => trend({ ...data, period }), [data, period])
  const owed = useMemo(() => accountsPayable(data.expenses, todayISO), [data.expenses, todayISO])

  const booksEmpty = pl.expenseCount === 0

  return (
    <div className="flex flex-col gap-5">
      {booksEmpty && (
        <Banner tone="info" icon={Info}>
          <strong>The books are empty.</strong> With no expenses recorded, everything below is just
          revenue wearing a P&amp;L label — the margin reads 100% because nothing has been spent as
          far as the books know.{' '}
          <Link href="/dashboard/accounting" className="underline">Log what you spend</Link> and
          these start meaning something.
        </Banner>
      )}

      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        <StatTile
          label="Revenue"
          value={<span className="tabular-nums">{formatCurrency(pl.revenue)}</span>}
          sub={period.label}
          icon={TrendingUp}
        />
        <StatTile
          label="Profit"
          value={<span className="tabular-nums">{formatCurrency(pl.profit)}</span>}
          sub={booksEmpty ? 'no costs recorded' : `${formatPct(pl.margin)} margin`}
          icon={Wallet}
          tone={booksEmpty ? undefined : pl.profit >= 0 ? 'success' : 'danger'}
          accent={!booksEmpty}
        />
        <StatTile
          label="Cash movement"
          value={<span className="tabular-nums">{formatCurrency(cf.net)}</span>}
          sub={`${formatCurrency(cf.inflow)} in · ${formatCurrency(cf.outflow)} out`}
          icon={Waves}
        />
        <StatTile
          label="Cash on hand"
          value={<span className="tabular-nums">{bs.cash == null ? '—' : formatCurrency(bs.cash)}</span>}
          sub={bs.cash == null ? 'needs an opening balance' : 'as at today'}
          icon={Scale}
        />
      </div>

      {/* ── What needs attention. Only real things, never filler. ────────── */}
      <Attention pl={pl} owed={owed} gst={gst} bs={bs} />

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-5">
        <Card>
          <CardBody>
            <div className="flex items-center justify-between mb-3">
              <h2 className="text-sm font-semibold text-ink">Where the money goes</h2>
              <Link href="/dashboard/accounting/expenses-report">
                <Button variant="ghost" size="sm">Details <ArrowRight className="w-3.5 h-3.5" /></Button>
              </Link>
            </div>
            {pl.byCategory.length === 0 ? (
              <p className="text-sm text-ink-faint">No costs recorded in {period.label}.</p>
            ) : (
              <div className="flex flex-col gap-2">
                {pl.byCategory.slice(0, 6).map(c => (
                  <div key={c.categoryId ?? 'none'} className="flex items-center gap-3">
                    <span className="w-28 shrink-0 text-sm text-ink-muted truncate">{c.name}</span>
                    <span className="flex-1 h-2 rounded-full bg-surface-sunken overflow-hidden">
                      <span className="block h-full rounded-full bg-accent/70" style={{ width: `${Math.max(2, c.share * 100)}%` }} />
                    </span>
                    <span className="w-20 shrink-0 text-right text-sm tabular-nums text-ink">{formatCurrency(c.cost)}</span>
                  </div>
                ))}
              </div>
            )}
          </CardBody>
        </Card>

        <Card>
          <CardBody>
            <div className="flex items-center justify-between mb-3">
              <h2 className="text-sm font-semibold text-ink">Month by month</h2>
              <Link href="/dashboard/accounting/trends">
                <Button variant="ghost" size="sm">Trends <ArrowRight className="w-3.5 h-3.5" /></Button>
              </Link>
            </div>
            {t.points.length === 0 ? (
              <p className="text-sm text-ink-faint">Nothing to chart yet.</p>
            ) : (
              <div className="flex flex-col gap-2">
                {t.points.slice(-6).map(p => (
                  <div key={p.key} className="flex items-baseline justify-between gap-3 text-sm">
                    <span className="text-ink-muted w-20 shrink-0">{p.label}</span>
                    <span className="flex-1 h-2 rounded-full bg-surface-sunken overflow-hidden">
                      <span
                        className={`block h-full rounded-full ${p.profit >= 0 ? 'bg-success/70' : 'bg-danger/60'}`}
                        style={{ width: `${Math.min(100, Math.abs(p.profit) / Math.max(1, ...t.points.map(x => Math.abs(x.profit))) * 100)}%` }}
                      />
                    </span>
                    <span className={`w-20 shrink-0 text-right tabular-nums ${p.profit >= 0 ? 'text-ink' : 'text-danger'}`}>
                      {formatCurrency(p.profit)}
                    </span>
                  </div>
                ))}
              </div>
            )}
          </CardBody>
        </Card>
      </div>

      <Card>
        <CardBody>
          <h2 className="text-sm font-semibold text-ink mb-3">The statements</h2>
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-2">
            <Tile href="/dashboard/accounting/pnl" title="Profit & Loss" detail="What you earned and what it cost" />
            <Tile href="/dashboard/accounting/cash-flow" title="Cash Flow" detail="What moved through the bank" />
            <Tile
              href="/dashboard/accounting/balance-sheet"
              title="Balance Sheet"
              detail={bs.balances ? 'Balances ✓' : bs.difference == null ? 'Needs setup' : `Out by ${formatCurrency(Math.abs(bs.difference))}`}
              tone={bs.balances ? 'success' : bs.difference == null ? undefined : 'danger'}
            />
            <Tile href="/dashboard/accounting/job-costing" title="Job Costing" detail="What each job really cost" />
            <Tile href="/dashboard/accounting/gst" title="GST/HST" detail={gst.registrant ? `Net ${formatCurrency(gst.netTax)}` : 'Not registered'} />
            <Tile href="/dashboard/accounting/export" title="Export" detail="Files for your accountant" />
          </div>
        </CardBody>
      </Card>
    </div>
  )
}

/**
 * The only opinionated part of the page.
 *
 * Each item is a real, actionable fact with a number attached — never a vanity stat
 * and never filler. If nothing is wrong, this renders nothing at all: an empty
 * attention list is the correct output for a healthy business, and inventing
 * something to fill the space would train the owner to ignore it.
 */
function Attention({ pl, owed, gst, bs }: {
  pl: ReturnType<typeof profitAndLoss>; owed: number
  gst: ReturnType<typeof gstReturn>; bs: ReturnType<typeof balanceSheet>
}) {
  const items: { tone: 'warn' | 'danger'; text: React.ReactNode }[] = []

  if (pl.undatedCashCount > 0) {
    items.push({
      tone: 'warn',
      text: <>{formatCurrency(pl.undatedCash)} of payments have no date, so they&apos;re in no period at all — revenue above is short by that much.</>,
    })
  }
  if (owed > 0) {
    items.push({
      tone: 'warn',
      text: <>You owe {formatCurrency(owed)} in unpaid bills. It isn&apos;t a cost until you pay it, but it is money going out.</>,
    })
  }
  if (gst.registrant && gst.netTax > 0) {
    items.push({
      tone: 'warn',
      text: <>{formatCurrency(gst.netTax)} of GST to remit for this period. That cash is the CRA&apos;s, not yours.</>,
    })
  }
  if (bs.difference != null && !bs.balances) {
    items.push({
      tone: 'danger',
      text: <>The balance sheet is out by {formatCurrency(Math.abs(bs.difference))} — something real isn&apos;t recorded.</>,
    })
  }
  if (pl.uncategorisedCount > 0) {
    items.push({
      tone: 'warn',
      text: <>{pl.uncategorisedCount} expense{pl.uncategorisedCount === 1 ? '' : 's'} with no category — counted, but not claimable properly.</>,
    })
  }

  if (items.length === 0) return null

  return (
    <Card>
      <CardBody>
        <h2 className="text-sm font-semibold text-ink mb-3">Worth a look</h2>
        <ul className="flex flex-col gap-2">
          {items.map((it, i) => (
            <li key={i} className="flex gap-2 text-sm text-ink-muted">
              <AlertTriangle className={`w-4 h-4 shrink-0 mt-0.5 ${it.tone === 'danger' ? 'text-danger' : 'text-warn'}`} />
              {it.text}
            </li>
          ))}
        </ul>
      </CardBody>
    </Card>
  )
}

function Tile({ href, title, detail, tone }: { href: string; title: string; detail: string; tone?: 'success' | 'danger' }) {
  return (
    <Link href={href} className="flex items-center gap-3 p-3 rounded-xl border border-line hover:border-accent transition-colors group">
      <span className="w-8 h-8 rounded-lg bg-surface-sunken grid place-items-center shrink-0">
        <Receipt className="w-4 h-4 text-ink-muted" />
      </span>
      <span className="flex-1 min-w-0">
        <span className="block text-sm font-medium text-ink">{title}</span>
        <span className={`block text-xs ${tone === 'success' ? 'text-success' : tone === 'danger' ? 'text-danger' : 'text-ink-faint'}`}>
          {detail}
        </span>
      </span>
      <ArrowRight className="w-4 h-4 text-ink-faint group-hover:text-accent shrink-0" />
    </Link>
  )
}
