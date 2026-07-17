'use client'

import { useMemo, useState } from 'react'
import Link from 'next/link'
import { ReportShell } from '@/components/accounting/ReportShell'
import type { AccountingData } from '@/lib/accounting/data'
import type { Period } from '@/lib/accounting/period'
import { profitAndLoss, cashFlow, expensesInPeriod, expensesBilledInPeriod } from '@/lib/accounting/report'
import { balanceSheet } from '@/lib/accounting/balanceSheet'
import { gstReturn } from '@/lib/accounting/gst'
import {
  EXPENSE_COLUMNS, JOURNAL_COLUMNS, ASSET_COLUMNS, LIABILITY_COLUMNS, STATEMENT_COLUMNS,
  journalRows, assetScheduleRows, profitAndLossLines, cashFlowLines, balanceSheetLines, gstReturnLines,
} from '@/lib/accounting/exports'
import { exportRowsToCsv } from '@/lib/csv'
import { Card, CardBody } from '@/components/ui/Card'
import { Button } from '@/components/ui/Button'
import { Banner } from '@/components/ui/Banner'
import { Badge } from '@/components/ui/Badge'
import { toast } from '@/lib/toast'
import { formatCurrency } from '@/lib/utils'
import { Download, FileSpreadsheet, Info, BookOpen, AlertTriangle } from 'lucide-react'

// ── Export centre + accountant tools ─────────────────────────────────────────
// Every file here is built from an engine result and written by lib/csv.ts. The
// export layer adds no arithmetic — the CSV is the artifact that reaches the
// accountant, and it must say exactly what the screen says.

export default function ExportCentrePage() {
  return (
    <ReportShell
      title="Export"
      description="Files for your spreadsheet, your accountant, or your records."
    >
      {({ data, period, todayISO }) => <Centre data={data} period={period} todayISO={todayISO} />}
    </ReportShell>
  )
}

function Centre({ data, period, todayISO }: { data: AccountingData; period: Period; todayISO: string }) {
  const [busy, setBusy] = useState<string | null>(null)

  const pl = useMemo(() => profitAndLoss({ ...data, period }), [data, period])
  const bs = useMemo(() => balanceSheet({ ...data, asOf: todayISO, todayISO }), [data, todayISO])
  const gst = useMemo(() => gstReturn({ ...data, period }), [data, period])

  // The accountant export is only worth having if the category→account mapping is
  // done. Unmapped categories don't break the file — they arrive with a blank code
  // and the accountant has to guess — so the number is surfaced before download,
  // not discovered by them afterwards.
  const mapping = useMemo(() => {
    const used = new Map<string, { name: string; code: string | null }>()
    for (const e of expensesBilledInPeriod(data.expenses, period)) {
      const c = e.expense_categories
      if (!c) continue
      used.set(c.id, { name: c.name, code: c.external_account })
    }
    const all = [...used.values()]
    return { total: all.length, mapped: all.filter(c => c.code).length, unmapped: all.filter(c => !c.code) }
  }, [data.expenses, period])

  function run(name: string, fn: () => void) {
    setBusy(name)
    try {
      fn()
      toast.success(`${name} downloaded`)
    } catch {
      toast.error(`Could not build ${name}.`)
    } finally {
      setBusy(null)
    }
  }

  const suffix = `${period.from}-to-${period.to}`

  return (
    <div className="flex flex-col gap-5">
      {data.expenses.length === 0 && (
        <Banner tone="info" icon={Info}>
          There&apos;s nothing to export yet — log some expenses and these files start containing
          your business rather than headings.
        </Banner>
      )}

      {/* ── Accountant tools ───────────────────────────────────────────── */}
      <Card>
        <CardBody>
          <div className="flex items-start justify-between gap-4 mb-1">
            <h2 className="text-sm font-semibold text-ink">For your accountant</h2>
            <Badge tone="neutral">accrual</Badge>
          </div>
          <p className="text-xs text-ink-faint mb-4">
            A general-journal file keyed on your own account codes. Deliberately a plain CSV rather
            than a QuickBooks or Xero file: those formats are version-specific and reject a file
            silently. Any accountant can import or read this one — and if something&apos;s wrong,
            you&apos;ll see it.
          </p>

          {mapping.total > 0 && mapping.mapped < mapping.total && (
            <Banner tone="warn" icon={AlertTriangle} className="mb-4">
              <strong>{mapping.total - mapping.mapped} of {mapping.total} categories have no
              account code.</strong>{' '}
              They&apos;ll export with a blank code and your accountant will have to guess where
              they go: {mapping.unmapped.slice(0, 4).map(c => c.name).join(', ')}
              {mapping.unmapped.length > 4 && `, +${mapping.unmapped.length - 4} more`}.{' '}
              <Link href="/dashboard/accounting?tab=categories" className="underline">Set the codes</Link>{' '}
              once and every export after this speaks their chart of accounts.
            </Banner>
          )}

          <div className="flex flex-col gap-2">
            <Row
              icon={BookOpen}
              title="General journal"
              detail={`Every bill dated by when it was incurred, with account codes. ${expensesBilledInPeriod(data.expenses, period).length} rows.`}
              busy={busy}
              onClick={() => run('General journal', () =>
                exportRowsToCsv(`journal-${suffix}`, journalRows(expensesBilledInPeriod(data.expenses, period)), JOURNAL_COLUMNS))}
            />
            <Row
              icon={FileSpreadsheet}
              title="Depreciation schedule"
              detail={`Cost basis and book value for ${data.fixedAssets.length} asset${data.fixedAssets.length === 1 ? '' : 's'} — what they need to work out your capital cost allowance.`}
              busy={busy}
              disabled={data.fixedAssets.length === 0}
              onClick={() => run('Depreciation schedule', () =>
                exportRowsToCsv(`depreciation-${todayISO}`, assetScheduleRows(data.fixedAssets, todayISO), ASSET_COLUMNS))}
            />
            <Row
              icon={FileSpreadsheet}
              title="Balance sheet"
              detail={bs.balances ? 'Balances — assets = liabilities + equity.' : bs.difference == null ? 'Incomplete — some inputs are missing.' : `Out by ${formatCurrency(Math.abs(bs.difference))}, and the file says so.`}
              busy={busy}
              onClick={() => run('Balance sheet', () =>
                exportRowsToCsv(`balance-sheet-${todayISO}`, balanceSheetLines(bs), STATEMENT_COLUMNS))}
            />
          </div>
        </CardBody>
      </Card>

      {/* ── Statements ─────────────────────────────────────────────────── */}
      <Card>
        <CardBody>
          <h2 className="text-sm font-semibold text-ink mb-1">Statements</h2>
          <p className="text-xs text-ink-faint mb-4">{period.label}. Exactly what&apos;s on the screen, in a file.</p>
          <div className="flex flex-col gap-2">
            <Row
              icon={FileSpreadsheet}
              title="Profit & Loss"
              detail={`Revenue ${formatCurrency(pl.revenue)} · cost ${formatCurrency(pl.cost)} · profit ${formatCurrency(pl.profit)}`}
              busy={busy}
              onClick={() => run('Profit & Loss', () =>
                exportRowsToCsv(`profit-and-loss-${suffix}`, profitAndLossLines(pl), STATEMENT_COLUMNS))}
            />
            <Row
              icon={FileSpreadsheet}
              title="Cash Flow"
              detail="Gross both sides — this is the one that reconciles to your bank."
              busy={busy}
              onClick={() => run('Cash Flow', () =>
                exportRowsToCsv(`cash-flow-${suffix}`, cashFlowLines(cashFlow({ ...data, period })), STATEMENT_COLUMNS))}
            />
            <Row
              icon={FileSpreadsheet}
              title="GST/HST return"
              detail={gst.registrant
                ? `Net tax ${formatCurrency(gst.netTax)} — ${gst.netTax >= 0 ? 'you remit' : 'refund due'}`
                : "You're not registered, so there's nothing to file."}
              busy={busy}
              disabled={!gst.registrant}
              onClick={() => run('GST return', () =>
                exportRowsToCsv(`gst-return-${suffix}`, gstReturnLines(gst), STATEMENT_COLUMNS))}
            />
          </div>
        </CardBody>
      </Card>

      {/* ── Raw data ───────────────────────────────────────────────────── */}
      <Card>
        <CardBody>
          <h2 className="text-sm font-semibold text-ink mb-1">Raw data</h2>
          <p className="text-xs text-ink-faint mb-4">Every row, for your own spreadsheet.</p>
          <div className="flex flex-col gap-2">
            <Row
              icon={Download}
              title="Expenses"
              detail={`${expensesInPeriod(data.expenses, period).length} in this period, with gross, tax and net as separate columns.`}
              busy={busy}
              onClick={() => run('Expenses', () =>
                exportRowsToCsv(`expenses-${suffix}`, expensesInPeriod(data.expenses, period), EXPENSE_COLUMNS))}
            />
            <Row
              icon={Download}
              title="What you owe"
              detail={`${data.liabilities.length} loan${data.liabilities.length === 1 ? '' : 's'} and card${data.liabilities.length === 1 ? '' : 's'}.`}
              busy={busy}
              disabled={data.liabilities.length === 0}
              onClick={() => run('Liabilities', () =>
                exportRowsToCsv(`liabilities-${todayISO}`, data.liabilities, LIABILITY_COLUMNS))}
            />
          </div>
        </CardBody>
      </Card>
    </div>
  )
}

function Row({ icon: Icon, title, detail, onClick, busy, disabled }: {
  icon: typeof Download; title: string; detail: string
  onClick: () => void; busy: string | null; disabled?: boolean
}) {
  return (
    <div className={`flex items-center gap-3 p-3 rounded-xl border border-line ${disabled ? 'opacity-50' : ''}`}>
      <span className="w-9 h-9 rounded-lg bg-surface-sunken grid place-items-center shrink-0">
        <Icon className="w-4 h-4 text-ink-muted" />
      </span>
      <div className="flex-1 min-w-0">
        <p className="text-sm font-medium text-ink">{title}</p>
        <p className="text-xs text-ink-faint">{detail}</p>
      </div>
      <Button variant="secondary" size="sm" onClick={onClick} loading={busy === title} disabled={disabled}>
        <Download className="w-4 h-4" /> CSV
      </Button>
    </div>
  )
}
