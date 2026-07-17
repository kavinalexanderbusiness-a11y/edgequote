'use client'

import { useMemo } from 'react'
import Link from 'next/link'
import { ReportShell } from '@/components/accounting/ReportShell'
import type { AccountingData } from '@/lib/accounting/data'
import type { Period } from '@/lib/accounting/period'
import { gstReturn } from '@/lib/accounting/gst'
import { gstReturnLines, STATEMENT_COLUMNS } from '@/lib/accounting/exports'
import { exportRowsToCsv } from '@/lib/csv'
import { Card, CardBody } from '@/components/ui/Card'
import { Button } from '@/components/ui/Button'
import { Banner } from '@/components/ui/Banner'
import { Badge } from '@/components/ui/Badge'
import { EmptyState } from '@/components/ui/EmptyState'
import { formatCurrency } from '@/lib/utils'
import { Download, Info, Receipt, AlertTriangle } from 'lucide-react'

// ── GST/HST ──────────────────────────────────────────────────────────────────
// The only ACCRUAL statement in the module, and the page says so out loud — because
// every other number in Accounting is cash basis, and an owner who notices the
// difference deserves the reason rather than a support ticket.
//
// Under the Excise Tax Act GST is payable on the earlier of paid or DUE: you remit
// on an invoice you sent in March even if it's paid in June.

export default function GstPage() {
  return (
    <ReportShell
      title="GST/HST"
      description="What you owe the CRA, and what you can claim back."
      defaultPeriod="this_quarter"
      action={({ data, period }) => (
        <Button
          variant="secondary"
          onClick={() =>
            exportRowsToCsv(
              `gst-return-${period.from}-to-${period.to}`,
              gstReturnLines(gstReturn({ ...data, period })),
              STATEMENT_COLUMNS,
            )
          }
        >
          <Download className="w-4 h-4" /> Export
        </Button>
      )}
    >
      {({ data, period }) => <Gst data={data} period={period} />}
    </ReportShell>
  )
}

function Gst({ data, period }: { data: AccountingData; period: Period }) {
  const r = useMemo(() => gstReturn({ ...data, period }), [data, period])

  if (!r.registrant) {
    return (
      <div className="flex flex-col gap-5">
        <EmptyState
          icon={Receipt}
          title="You're not registered for GST"
          description="So there's nothing to file: you don't charge it, and you don't claim it back. If you register, set your GST rate and number in settings and this becomes a real return."
          action={{ label: 'Open settings', href: '/dashboard/settings' }}
        />
        <Card>
          <CardBody>
            <div className="flex items-baseline justify-between">
              <span className="text-sm text-ink-muted">
                Sales invoiced in {period.label}
                <span className="block text-xs text-ink-faint">what would be taxable if you registered</span>
              </span>
              <span className="text-sm tabular-nums text-ink">{formatCurrency(r.sales)}</span>
            </div>
          </CardBody>
        </Card>
      </div>
    )
  }

  return (
    <div className="flex flex-col gap-5">
      <Banner tone="info" icon={Info}>
        <strong>This one is accrual, not cash.</strong> GST is owed the moment you invoice, not
        when the customer pays — so an unpaid invoice still owes tax here, and this won&apos;t
        match the P&amp;L. That difference is correct, not a bug.
      </Banner>

      {!r.gstNumber && (
        <Banner tone="warn" icon={AlertTriangle}>
          <strong>No GST number set.</strong> The CRA requires it on any invoice of $30+ for your
          customer to claim their credit — without it, theirs can be denied on audit.{' '}
          <Link href="/dashboard/settings" className="underline">Add it in settings</Link>.
        </Banner>
      )}

      <Card>
        <CardBody>
          <div className="flex items-center justify-between mb-4">
            <div>
              <h2 className="text-sm font-semibold text-ink">Return for {period.label}</h2>
              <p className="text-xs text-ink-faint">GST {r.gstPercent}% · {r.gstNumber ?? 'no number set'}</p>
            </div>
            <Badge tone="neutral">Accrual</Badge>
          </div>

          <dl className="flex flex-col">
            <Line code="101" label="Sales and other revenue" value={r.sales} note={`${r.invoiceCount} invoice${r.invoiceCount === 1 ? '' : 's'} issued`} />
            <Line code="105" label="GST/HST collected" value={r.taxCollected} />
            <Line
              code="108"
              label="Input tax credits"
              value={r.inputTaxCredits}
              note={r.capitalItcs > 0 ? `includes ${formatCurrency(r.capitalItcs)} on equipment` : `from ${r.expenseCount} bill${r.expenseCount === 1 ? '' : 's'}`}
            />
            <div className="flex items-baseline justify-between gap-4 border-t border-line mt-2 pt-3">
              <dt className="text-sm font-semibold text-ink">
                <span className="text-xs text-ink-faint mr-2">109</span>
                Net tax
                <span className="block text-xs font-normal text-ink-faint">
                  {r.netTax >= 0 ? 'You remit this to the CRA' : 'The CRA owes you this back'}
                </span>
              </dt>
              <dd className={`text-base font-semibold tabular-nums shrink-0 ${r.netTax >= 0 ? 'text-ink' : 'text-success'}`}>
                {formatCurrency(Math.abs(r.netTax))}
              </dd>
            </div>
          </dl>
        </CardBody>
      </Card>

      {r.excludedDrafts.count > 0 && (
        <Banner tone="warn">
          {r.excludedDrafts.count} draft invoice{r.excludedDrafts.count === 1 ? '' : 's'} worth{' '}
          {formatCurrency(r.excludedDrafts.total)} {r.excludedDrafts.count === 1 ? 'is' : 'are'} excluded
          — nobody was charged, so no GST is owed on {r.excludedDrafts.count === 1 ? 'it' : 'them'}. Send{' '}
          {r.excludedDrafts.count === 1 ? 'it' : 'them'} and this return changes.
        </Banner>
      )}

      {r.inputTaxCredits === 0 && r.taxCollected > 0 && (
        <Banner tone="warn">
          <strong>No input tax credits claimed.</strong> You&apos;re remitting{' '}
          {formatCurrency(r.taxCollected)} and claiming nothing back. If the business bought
          anything with GST on it this period, logging those receipts reduces this bill directly.
        </Banner>
      )}

      <Card>
        <CardBody>
          <h2 className="text-sm font-semibold text-ink mb-3">The invoices behind line 105</h2>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-xs text-ink-faint">
                  <th className="pb-2 font-medium">Invoice</th>
                  <th className="pb-2 font-medium">Customer</th>
                  <th className="pb-2 font-medium text-right">Net</th>
                  <th className="pb-2 font-medium text-right">GST</th>
                </tr>
              </thead>
              <tbody>
                {r.rows.map(row => (
                  <tr key={row.invoiceNumber ?? Math.random()} className="border-t border-line">
                    <td className="py-2 text-ink-muted">{row.invoiceNumber ?? '—'}</td>
                    <td className="py-2 text-ink-muted">{row.customerName}</td>
                    <td className="py-2 text-right tabular-nums text-ink">{formatCurrency(row.net)}</td>
                    <td className="py-2 text-right tabular-nums text-ink">{formatCurrency(row.gst)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </CardBody>
      </Card>
    </div>
  )
}

function Line({ code, label, value, note }: { code: string; label: string; value: number; note?: string }) {
  return (
    <div className="flex items-baseline justify-between gap-4 py-1.5">
      <dt className="text-sm text-ink">
        <span className="text-xs text-ink-faint mr-2">{code}</span>
        {label}
        {note && <span className="block text-xs text-ink-faint">{note}</span>}
      </dt>
      <dd className="text-sm tabular-nums text-ink shrink-0">{formatCurrency(value)}</dd>
    </div>
  )
}
