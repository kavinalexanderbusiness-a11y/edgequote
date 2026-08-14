'use client'

import { useEffect, useState } from 'react'
import Link from 'next/link'
import { BarChart3, Coins, Info, Receipt, ShieldQuestion } from 'lucide-react'
import { PageContainer } from '@/components/layout/PageContainer'
import { PageHeader } from '@/components/layout/PageHeader'
import { Card, CardBody } from '@/components/ui/Card'
import { Badge } from '@/components/ui/Badge'
import { Banner } from '@/components/ui/Banner'
import { StatTile } from '@/components/ui/StatTile'
import { SkeletonTiles } from '@/components/ui/Skeleton'
import { InlineEmpty } from '@/components/ui/EmptyState'
import { Th, Td, tableRowHover } from '@/components/ui/Table'
import { createClient } from '@/lib/supabase/client'
import { formatCurrency, formatDate } from '@/lib/utils'
import { marginTone } from '@/lib/margin'
import { describeBilling, type MarginBlock } from '@/lib/jobProfit'
import { loadProfitBook, PROFIT_BOOK_LIMIT, type ProfitBookLoad, type ProfitRow } from '@/lib/jobProfitData'

// ── Did finished jobs make money? ────────────────────────────────────────────
// The comparison next to the per-visit review, and it exists for ONE reason that
// a per-visit panel cannot serve: a margin on one job is not evidence. Two jobs
// out of seventy-nine carrying a 61% margin is arithmetically perfect and
// worthless, and the ONLY thing that says so is the denominator — so the
// denominator is the hero tile on this page, not the margin.
//
// ⭐ THE HEADLINE IS COVERAGE, DELIBERATELY. "2 of 79 finished visits can be
// judged" is the true summary of this business's costing today, and it is also
// the most useful sentence on the screen: it names the work that would make every
// other figure real. A page that led with "61% margin" would be read as the
// business's margin, which is not a claim this data can support.
//
// ⛔ NOT a P&L and not a second job-costing report. /dashboard/accounting/job-costing
// answers "what did receipts say each job cost" over an accounting PERIOD, on a
// cash basis, for the books. This answers "did the finished work pay", per visit,
// against the price the customer authorized, and it refuses to answer at all
// where the cost is incomplete. Both read the same expense rows; neither owns
// arithmetic (lib/jobProfit and lib/accounting do).
//
// ⛔ NOTHING HERE IS A COST ESTIMATE. No crew rate, no quote material line, no
// template. Every figure is a row somebody recorded, or a sentence saying nobody did.

const BLOCK_WORDS: Record<MarginBlock, string> = {
  cost_incomplete: 'missing a recorded cost',
  no_price: 'never priced',
  not_finished: 'not finished',
  clock_running: 'still on the clock',
  cancelled: 'cancelled',
  read_failed: 'could not be read',
}

/** The short form for a table cell — the panel on the visit itself carries the
 *  full sentence, and a column of full sentences is unreadable. */
const BLOCK_CELL: Record<MarginBlock, string> = {
  cost_incomplete: 'Cost incomplete',
  no_price: 'No price',
  not_finished: 'Unfinished',
  clock_running: 'Clock running',
  cancelled: 'Cancelled',
  read_failed: 'Unreadable',
}

export default function JobProfitPage() {
  const supabase = createClient()
  const [load, setLoad] = useState<ProfitBookLoad | null>(null)

  useEffect(() => {
    let alive = true
    ;(async () => {
      const { data: { user } } = await supabase.auth.getUser()
      if (!alive) return
      const next = await loadProfitBook(supabase, user?.id ?? '')
      if (alive) setLoad(next)
    })()
    return () => { alive = false }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  return (
    <PageContainer>
      <PageHeader
        title="Did finished jobs make money"
        description="Every finished visit against the price it was authorized to bill — and named plainly where it can’t say."
        crumb={{ label: 'Grow', href: '/dashboard/grow' }} />

      {/* Loading shows NO figures. A tile that reads $0.00 for half a second is
          the same lie as a failed read that reads $0.00. */}
      {!load && <SkeletonTiles count={4} />}

      {load?.outcome === 'unavailable' && (
        <Banner tone="danger" icon={Info}>
          Your finished work could not be loaded, so nothing is shown. This is a loading problem —
          not a finding that nothing made money.
        </Banner>
      )}

      {load?.outcome === 'ok' && <Book load={load} />}
    </PageContainer>
  )
}

function Book({ load }: { load: Extract<ProfitBookLoad, { outcome: 'ok' }> }) {
  const { rollup, rows } = load
  const judged = rollup.judgeable

  if (rollup.visits === 0) {
    return (
      <Card>
        <CardBody>
          <InlineEmpty icon={BarChart3}>
            No visit has been finished yet. Once work is completed, its price, its recorded costs and
            what it collected turn up here.
          </InlineEmpty>
        </CardBody>
      </Card>
    )
  }

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        {/* THE hero: the denominator. Every other tile is a slice of it. */}
        <StatTile
          accent icon={ShieldQuestion}
          label="Can be judged"
          value={`${judged} of ${rollup.visits}`}
          sub={
            load.completedTotal != null && load.completedTotal > rollup.visits
              ? `finished visits read · ${load.completedTotal} in the book`
              : 'finished visits read'
          } />
        <StatTile
          icon={Coins}
          label="Authorized (judged)"
          value={judged ? formatCurrency(rollup.authorized) : '—'}
          sub={judged ? 'the price those visits agreed' : 'nothing judgeable yet'} />
        <StatTile
          icon={Receipt}
          label="Recorded cost (judged)"
          value={judged ? formatCurrency(rollup.cost) : '—'}
          sub={judged ? 'labour, materials and other' : 'nothing judgeable yet'} />
        <StatTile
          icon={BarChart3}
          tone={judged ? marginTone(rollup.percent) : undefined}
          label="Known margin"
          value={judged && rollup.percent != null ? `${rollup.percent}%` : '—'}
          sub={judged ? `${formatCurrency(rollup.profit)} kept` : 'no margin can be shown'} />
      </div>

      {/* Why the rest cannot be judged. Not an apology — the list of things that
          would make this page real, in the order they would pay off. */}
      {rollup.blockedBy.length > 0 && (
        <Banner tone={judged === 0 ? 'warn' : 'neutral'} icon={Info}>
          {judged === 0
            ? 'No finished visit can be judged yet. '
            : `${rollup.visits - judged} of the ${rollup.visits} finished visits read cannot be judged: `}
          {rollup.blockedBy.map(b => `${b.count} ${BLOCK_WORDS[b.block]}`).join(' · ')}.
          {rollup.blockedBy.some(b => b.block === 'cost_incomplete') && (
            <> A category with nothing recorded in it does not mean nothing was spent, so no margin is
              shown — record the cost on the visit and it fills in.</>
          )}
        </Banner>
      )}

      {/* Cash, kept firmly apart from the margin above. */}
      <Card>
        <CardBody className="flex flex-wrap items-baseline justify-between gap-2">
          <p className="text-xs leading-relaxed text-ink-muted">
            <span className="font-semibold text-ink">{formatCurrency(rollup.collected)} collected</span>
            {' '}across these {rollup.visits} visits{rollup.collectedPartial ? ' (at least — some could not be read)' : ''}.
            {' '}Cash is not revenue and never enters a margin: an unpaid invoice has still earned its
            price, and a settled one may have been paid from credit taken months earlier.
          </p>
        </CardBody>
      </Card>

      <Card>
        <div className="overflow-x-auto">
          <table className="w-full min-w-[720px]">
            <thead>
              <tr className="border-b border-border">
                <Th>Visit</Th>
                <Th className="text-right">Authorized</Th>
                <Th className="text-right">Recorded cost</Th>
                <Th className="text-right">Margin</Th>
                <Th>Billing</Th>
              </tr>
            </thead>
            <tbody>
              {rows.map(r => <ProfitTableRow key={r.jobId} row={r} />)}
            </tbody>
          </table>
        </div>
      </Card>

      {/* A cap that bit must SAY it bit — a page that silently showed the newest
          sixty while implying it read everything is the quiet version of the lie
          this whole lane exists to prevent. */}
      {load.truncated && (
        <p className="text-xs text-ink-faint">
          The most recent {PROFIT_BOOK_LIMIT} finished visits are shown
          {load.completedTotal != null && ` of ${load.completedTotal} in the book`}. Older work is not
          in the figures above.
        </p>
      )}

      <p className="text-xs leading-relaxed text-ink-faint">
        Margin here is GROSS, on recorded direct cost only: no overhead, drive time, equipment or
        owner’s wage is taken off. It is not a profit-and-loss statement — your books live in{' '}
        <Link href="/dashboard/accounting" className="text-accent-text hover:underline">Accounting</Link>.
      </p>
    </div>
  )
}

function ProfitTableRow({ row }: { row: ProfitRow }) {
  const r = row.review
  const known = r.margin.state === 'known'
  return (
    <tr className={`border-b border-border last:border-0 ${tableRowHover}`}>
      <Td>
        {/* Back to the visit this row is about, landing ON its review panel —
            the same door vocabulary the + sheet uses (lib/quickAdd). */}
        <Link
          href={`/dashboard/schedule?job=${row.jobId}&panel=profit`}
          className="font-medium text-ink hover:text-accent-text">
          {row.label}
        </Link>
        <p className="text-xs text-ink-faint">
          {row.date ? formatDate(row.date) : 'no date'}
          {row.invoiceNumber ? ` · ${row.invoiceNumber}` : ''}
        </p>
      </Td>
      <Td className="text-right tabular-nums">
        {r.authorized.amount != null
          ? formatCurrency(r.authorized.amount)
          : <span className="text-ink-faint">No price</span>}
      </Td>
      <Td className="text-right tabular-nums">
        {r.cost.total.state === 'known'
          ? formatCurrency(r.cost.total.amount ?? 0)
          : r.margin.costFloor > 0
            ? <span className="text-ink-faint">At least {formatCurrency(r.margin.costFloor)}</span>
            : <span className="text-ink-faint">—</span>}
      </Td>
      <Td className="text-right">
        {known
          ? (
            <span className="inline-flex items-center gap-2">
              <span className="tabular-nums font-medium text-ink">{formatCurrency(r.margin.profit ?? 0)}</span>
              <Badge tone={r.margin.tone}>{r.margin.percent}%</Badge>
            </span>
          )
          : <span className="text-xs text-ink-faint">{BLOCK_CELL[r.margin.block as MarginBlock]}</span>}
      </Td>
      {/* The engine's own words, not a second spelling of them: a table that
          disagreed with the panel about whether an invoice was paid would be
          worse than a table with no billing column. */}
      <Td>
        <span className="text-xs text-ink-muted">{describeBilling(r)}</span>
      </Td>
    </tr>
  )
}
