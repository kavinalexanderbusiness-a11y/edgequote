'use client'

import { useMemo } from 'react'
import { ReportShell } from '@/components/accounting/ReportShell'
import type { AccountingData } from '@/lib/accounting/data'
import type { Period } from '@/lib/accounting/period'
import { costJobs, rollupJobCosting } from '@/lib/accounting/jobCosting'
import { isGstRegistrant, expensesInPeriod } from '@/lib/accounting/report'
import { inPeriod } from '@/lib/accounting/period'
import { formatPct } from '@/lib/margin'
import { JOB_COSTING_COLUMNS } from '@/lib/accounting/exports'
import { exportRowsToCsv } from '@/lib/csv'
import { Card, CardBody } from '@/components/ui/Card'
import { Button } from '@/components/ui/Button'
import { Banner } from '@/components/ui/Banner'
import { Badge } from '@/components/ui/Badge'
import { StatTile } from '@/components/ui/StatTile'
import { EmptyState } from '@/components/ui/EmptyState'
import { Th, Td, tableRowHover } from '@/components/ui/Table'
import { formatCurrency, formatDate } from '@/lib/utils'
import { Download, Info, Briefcase, Receipt } from 'lucide-react'

// ── Job Costing ──────────────────────────────────────────────────────────────
// What jobs REALLY cost, from receipts tagged to them.
//
// The honesty rule from lib/margin.ts is the whole design: a job with no receipts
// has an UNKNOWN cost, not a zero cost. Show 0 and every job in the business reads
// 100% margin — a page full of confident, flattering, false numbers. Those jobs are
// still listed (hiding them would make this read as "the jobs", not "the jobs we
// can cost"), but their cost is "—" and they contribute nothing to the rollup.
//
// It also does NOT add labour: economics.ts charges a LOADED crew rate that already
// has fuel and overhead in it, so adding receipted fuel would double-count and
// report a loss that never happened.

export default function JobCostingPage() {
  return (
    <ReportShell
      title="Job Costing"
      description="What each job actually cost, from the receipts tagged to it."
      action={({ data, period }) => (
        <Button
          variant="secondary"
          onClick={() => {
            const { rows } = build(data, period)
            exportRowsToCsv(`job-costing-${period.from}-to-${period.to}`, rows, JOB_COSTING_COLUMNS)
          }}
        >
          <Download className="w-4 h-4" /> Export
        </Button>
      )}
    >
      {({ data, period }) => <Costing data={data} period={period} />}
    </ReportShell>
  )
}

function build(data: AccountingData, period: Period) {
  const registrant = isGstRegistrant(data.settings)
  // Jobs scheduled in the period; costs are the expenses whose CASH moved in it.
  const jobs = data.jobs.filter(j => inPeriod(j.scheduled_date, period))
  const expenses = expensesInPeriod(data.expenses, period)

  const costings = costJobs({
    jobs: jobs.map(j => ({ id: j.id, price: j.price })),
    expenses,
    registrant,
  })
  const nameOf = new Map(jobs.map(j => [j.id, j.title || j.service_type || 'Job']))
  const rows = costings.map(c => ({ ...c, jobName: nameOf.get(c.jobId) ?? 'Job' }))
  const rollup = rollupJobCosting(costings, expenses, registrant)
  return { rows, rollup, jobs }
}

function Costing({ data, period }: { data: AccountingData; period: Period }) {
  const { rows, rollup, jobs } = useMemo(() => build(data, period), [data, period])
  const dated = useMemo(() => new Map(data.jobs.map(j => [j.id, j.scheduled_date])), [data.jobs])

  if (jobs.length === 0) {
    return <EmptyState icon={Briefcase} title="No jobs in this period" description="Pick a wider period, or schedule some work." />
  }

  const costedShare = rollup.totalJobs > 0 ? rollup.costedJobs / rollup.totalJobs : 0

  return (
    <div className="flex flex-col gap-5">
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        <StatTile
          label="Jobs with receipts"
          value={<span className="tabular-nums">{rollup.costedJobs} of {rollup.totalJobs}</span>}
          sub={`${Math.round(costedShare * 100)}% can be costed`}
          icon={Receipt}
        />
        <StatTile label="Revenue (costed jobs)" value={<span className="tabular-nums">{formatCurrency(rollup.revenue)}</span>} sub="only jobs with receipts" />
        <StatTile label="Receipted cost" value={<span className="tabular-nums">{formatCurrency(rollup.cost)}</span>} />
        <StatTile
          label="Margin (costed jobs)"
          value={<span className="tabular-nums">{formatPct(rollup.marginPercent)}</span>}
          icon={Briefcase}
          accent
        />
      </div>

      {rollup.costedJobs === 0 ? (
        <Banner tone="info" icon={Info}>
          <strong>No job has a receipt tagged to it yet.</strong> Costs here come from expenses
          linked to a job, so every job below shows &ldquo;—&rdquo; rather than $0. That&apos;s
          deliberate: a job with no receipts has an <em>unknown</em> cost, and calling it zero
          would report 100% margin on all of them.
        </Banner>
      ) : (
        <Banner tone="info" icon={Info}>
          <strong>These are receipts only, not labour.</strong> Your crew rate already includes
          fuel and overhead, so adding it to these receipts would count the same fuel twice and
          invent a loss. Use the Profitability page for the labour view of a job.
        </Banner>
      )}

      {rollup.untaggedCost > 0 && (
        <Banner tone="warn">
          {formatCurrency(rollup.untaggedCost)} of spend isn&apos;t linked to any job. Some of that
          is genuine overhead — insurance, software — but anything that was for a specific job is
          missing from that job&apos;s cost below.
        </Banner>
      )}

      <Card>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr>
                <Th>Job</Th>
                <Th className="text-right">Revenue</Th>
                <Th className="text-right">Receipted cost</Th>
                <Th className="text-right">Profit</Th>
                <Th className="text-right">Margin</Th>
              </tr>
            </thead>
            <tbody>
              {rows.map(r => (
                <tr key={r.jobId} className={tableRowHover}>
                  <Td>
                    <span className="text-ink">{r.jobName}</span>
                    <span className="block text-xs text-ink-faint">
                      {dated.get(r.jobId) ? formatDate(dated.get(r.jobId)!) : '—'}
                      {r.expenseCount > 0 && ` · ${r.expenseCount} receipt${r.expenseCount === 1 ? '' : 's'}`}
                    </span>
                  </Td>
                  <Td className="text-right tabular-nums text-ink">{r.revenue == null ? '—' : formatCurrency(r.revenue)}</Td>
                  <Td className="text-right tabular-nums">
                    {/* '—', never $0. An untagged job's cost is unknown, and a zero here
                        would read as "this job cost nothing" — a lie that flatters. */}
                    {r.directCost == null
                      ? <span className="text-ink-faint" title="No receipts tagged — cost unknown, not zero">—</span>
                      : <span className="text-ink">{formatCurrency(r.directCost)}</span>}
                  </Td>
                  <Td className="text-right tabular-nums">
                    {r.profit == null ? <span className="text-ink-faint">—</span> : <span className="text-ink">{formatCurrency(r.profit)}</span>}
                  </Td>
                  <Td className="text-right">
                    {r.marginPercent == null
                      ? <span className="text-ink-faint text-sm">—</span>
                      : <Badge tone={r.tone}>{formatPct(r.marginPercent)}</Badge>}
                  </Td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>
    </div>
  )
}
