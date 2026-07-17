'use client'

import { useMemo } from 'react'
import Link from 'next/link'
import { ReportShell } from '@/components/accounting/ReportShell'
import type { AccountingData } from '@/lib/accounting/data'
import { balanceSheet, type BalanceLine } from '@/lib/accounting/balanceSheet'
import { balanceSheetLines, STATEMENT_COLUMNS } from '@/lib/accounting/exports'
import { exportRowsToCsv } from '@/lib/csv'
import { Card, CardBody } from '@/components/ui/Card'
import { Button } from '@/components/ui/Button'
import { Banner } from '@/components/ui/Banner'
import { Badge } from '@/components/ui/Badge'
import { formatCurrency, formatDate } from '@/lib/utils'
import { Download, AlertTriangle, CheckCircle2, Settings } from 'lucide-react'

// ── Balance Sheet ────────────────────────────────────────────────────────────
// The one statement where the arithmetic checks itself, so the UI's whole job is to
// SHOW the check — pass or fail — rather than present a total and hope.
//
// A balance sheet that always balances is a balance sheet that isn't checking
// anything. When `difference` is non-zero this page says so loudly, because that
// gap is the single most useful thing on the page: it means something real is
// unrecorded, and it's pointing at it.

export default function BalanceSheetPage() {
  return (
    <ReportShell
      title="Balance Sheet"
      description="What the business owns, what it owes, and what's left over."
      mode="asOf"
      action={({ data, todayISO }) => (
        <Button
          variant="secondary"
          onClick={() =>
            exportRowsToCsv(
              `balance-sheet-${todayISO}`,
              balanceSheetLines(balanceSheet({ ...data, asOf: todayISO, todayISO })),
              STATEMENT_COLUMNS,
            )
          }
        >
          <Download className="w-4 h-4" /> Export
        </Button>
      )}
    >
      {({ data, asOf, todayISO }) => <Sheet data={data} asOf={asOf} todayISO={todayISO} />}
    </ReportShell>
  )
}

function Sheet({ data, asOf, todayISO }: { data: AccountingData; asOf: string; todayISO: string }) {
  const bs = useMemo(() => balanceSheet({ ...data, asOf, todayISO }), [data, asOf, todayISO])

  return (
    <div className="flex flex-col gap-5">
      {/* ── The check, first. It decides whether anything below is trustworthy. ── */}
      {bs.difference == null ? (
        <Banner tone="warn" icon={AlertTriangle}>
          <strong>This can&apos;t be checked yet.</strong> A balance sheet is only worth reading
          when assets, liabilities and equity are worked out separately and then compared. Until
          the missing pieces below are filled in, this is a partial picture — so it isn&apos;t
          totalled, and nothing has been guessed to make it look finished.
        </Banner>
      ) : bs.balances ? (
        <Banner tone="success" icon={CheckCircle2}>
          <strong>It balances.</strong> What the business owns, less what it owes, comes to exactly
          what the books say it earned and you put in. That agreement is the point — the two sides
          were worked out from different data and they met.
        </Banner>
      ) : (
        <Banner tone="danger" icon={AlertTriangle}>
          <strong>It doesn&apos;t balance — out by {formatCurrency(Math.abs(bs.difference))}.</strong>{' '}
          That isn&apos;t a rounding wobble, it means something real isn&apos;t recorded. Usually:
          money you put in that was never logged, gear bought before you started tracking, or an
          opening balance that&apos;s slightly off. The gap is shown rather than quietly absorbed,
          because absorbing it would make every figure here unprovable.
        </Banner>
      )}

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-5">
        <Card>
          <CardBody>
            <div className="flex items-center justify-between mb-3">
              <h2 className="text-sm font-semibold text-ink">Assets</h2>
              <Badge tone="neutral">owns</Badge>
            </div>
            <dl className="flex flex-col">
              {bs.assets.map(l => <Row key={l.label} line={l} />)}
              <Total label="Total assets" value={bs.totalAssets} />
            </dl>
          </CardBody>
        </Card>

        <Card>
          <CardBody>
            <div className="flex items-center justify-between mb-3">
              <h2 className="text-sm font-semibold text-ink">Liabilities</h2>
              <Badge tone="neutral">owes</Badge>
            </div>
            <dl className="flex flex-col">
              {bs.liabilities.map(l => <Row key={l.label} line={l} />)}
              <Total label="Total liabilities" value={bs.totalLiabilities} />
            </dl>
          </CardBody>
        </Card>
      </div>

      <Card>
        <CardBody>
          <h2 className="text-sm font-semibold text-ink mb-1">Equity</h2>
          <p className="text-xs text-ink-faint mb-3">
            Worked out from what you put in and what the business has earned — deliberately not
            from the two cards above. That&apos;s what makes the check below mean something.
          </p>
          <dl className="flex flex-col">
            {bs.equity.map(l => <Row key={l.label} line={l} />)}
            <Total label="Total equity" value={bs.totalEquity} />
          </dl>

          <div className="mt-5 pt-4 border-t border-line flex flex-col gap-2">
            <div className="flex items-baseline justify-between">
              <span className="text-sm text-ink-muted">Net worth (assets − liabilities)</span>
              <span className="text-sm tabular-nums text-ink">{money(bs.netWorth)}</span>
            </div>
            <div className="flex items-baseline justify-between">
              <span className="text-sm text-ink-muted">Explained by equity</span>
              <span className="text-sm tabular-nums text-ink">{money(bs.totalEquity)}</span>
            </div>
            <div className="flex items-baseline justify-between">
              <span className={`text-sm font-semibold ${bs.balances ? 'text-success' : bs.difference == null ? 'text-ink-faint' : 'text-danger'}`}>
                Unexplained difference
              </span>
              <span className={`text-sm font-semibold tabular-nums ${bs.balances ? 'text-success' : bs.difference == null ? 'text-ink-faint' : 'text-danger'}`}>
                {money(bs.difference)}
              </span>
            </div>
          </div>
        </CardBody>
      </Card>

      {bs.gaps.length > 0 && (
        <Card>
          <CardBody>
            <h2 className="text-sm font-semibold text-ink mb-2">What&apos;s missing</h2>
            <ul className="flex flex-col gap-2">
              {bs.gaps.map((g, i) => (
                <li key={i} className="text-sm text-ink-muted flex gap-2">
                  <span className="text-warn shrink-0">•</span>{g}
                </li>
              ))}
            </ul>
            <div className="flex gap-2 mt-4">
              <Link href="/dashboard/accounting/setup">
                <Button variant="secondary" size="sm"><Settings className="w-4 h-4" /> Fill these in</Button>
              </Link>
            </div>
          </CardBody>
        </Card>
      )}

      {bs.register.rows.length > 0 && (
        <Card>
          <CardBody>
            <h2 className="text-sm font-semibold text-ink mb-3">What the gear is worth</h2>
            <div className="flex flex-col gap-2">
              {bs.register.rows.map(({ asset, depreciation }) => (
                <div key={asset.id} className="flex items-baseline justify-between gap-4 text-sm">
                  <span className="text-ink">
                    {asset.name}
                    <span className="block text-xs text-ink-faint">
                      bought {formatDate(asset.in_service_date)} for {formatCurrency(depreciation.cost)}
                      {depreciation.fullyDepreciated && ' · fully written off'}
                    </span>
                  </span>
                  <span className="tabular-nums text-ink shrink-0">{formatCurrency(depreciation.bookValue)}</span>
                </div>
              ))}
            </div>
          </CardBody>
        </Card>
      )}
    </div>
  )
}

/** '—' for a genuine unknown. Never 0: a total containing an unknown is not a total. */
const money = (v: number | null) => (v == null ? '—' : formatCurrency(v))

function Row({ line }: { line: BalanceLine }) {
  return (
    <div className="flex items-baseline justify-between gap-4 py-1.5">
      <dt className="text-sm text-ink-muted">
        {line.label}
        <span className="block text-xs text-ink-faint">{line.missing ?? line.source}</span>
      </dt>
      <dd className={`text-sm tabular-nums shrink-0 ${line.value == null ? 'text-ink-faint' : 'text-ink'}`}>
        {money(line.value)}
      </dd>
    </div>
  )
}

function Total({ label, value }: { label: string; value: number | null }) {
  return (
    <div className="flex items-baseline justify-between gap-4 border-t border-line mt-1 pt-2">
      <dt className="text-sm font-semibold text-ink">{label}</dt>
      <dd className={`text-sm font-semibold tabular-nums ${value == null ? 'text-ink-faint' : 'text-ink'}`}>
        {money(value)}
      </dd>
    </div>
  )
}
