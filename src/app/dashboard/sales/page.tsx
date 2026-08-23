import { createClient } from '@/lib/supabase/server'
import { loadSalesAnalytics } from '@/lib/sales/data'
import { presetPeriod, customPeriod, type Period, type PeriodKey } from '@/lib/sales/analytics'
import { localTodayISO } from '@/lib/utils'
import { PageContainer } from '@/components/layout/PageContainer'
import { PageHeader } from '@/components/layout/PageHeader'
import { Banner } from '@/components/ui/Banner'
import { EmptyState } from '@/components/ui/EmptyState'
import { PeriodFilter } from '@/components/sales/PeriodFilter'
import { SalesSnapshot } from '@/components/sales/SalesSnapshot'
import { PipelineBuckets } from '@/components/sales/PipelineBuckets'
import { SalesFunnel } from '@/components/sales/SalesFunnel'
import { SourceTable } from '@/components/sales/SourceTable'
import { RecentMovement } from '@/components/sales/RecentMovement'
import { ButtonLink } from '@/components/ui/Button'
import { TrendingUp, Plus } from 'lucide-react'

// ── Sales analytics ──────────────────────────────────────────────────────────
// The owner's selling questions, answered from canonical records: how much did I
// quote, what is still open, what was won and lost, what is authorized now, what
// did I invoice, and what actually arrived — plus which lead sources produced
// each of those.
//
// SERVER-RENDERED, one query batch, no spinner. The period lives in the URL, so
// changing it is a navigation rather than a client refetch, and the result is
// shareable.
//
// ⚠️ A failed read renders a NAMED FAILURE, never an empty report. "You quoted $0
// and won nothing this quarter" produced by a dead connection is a confident,
// specific, false verdict about someone's business — and unlike a blank screen,
// it gets believed.
//
// Deliberately NOT here: a per-deal next action (that is /dashboard/pipeline, a
// working queue), loss-reason analysis (Grow's Win/Loss, over the same
// quote_outcomes rows), and the accountant's period reports (/dashboard/reports,
// which is cash-basis by paid_at and answers a different question entirely).

const VALID: PeriodKey[] = ['30d', '90d', 'year', 'custom']
const ISO = /^\d{4}-\d{2}-\d{2}$/

/** The period from the URL, defaulting to 30 days. A malformed custom range
 *  falls back rather than 500ing — a hand-edited URL is not an error screen. */
function periodFromParams(params: Record<string, string | string[] | undefined>, todayISO: string): Period {
  const raw = typeof params.period === 'string' ? params.period : '30d'
  const key = (VALID.includes(raw as PeriodKey) ? raw : '30d') as PeriodKey
  if (key === 'custom') {
    const from = typeof params.from === 'string' ? params.from : ''
    const to = typeof params.to === 'string' ? params.to : ''
    if (ISO.test(from) && ISO.test(to)) return customPeriod(from, to)
    return presetPeriod('30d', todayISO)
  }
  return presetPeriod(key, todayISO)
}

export default async function SalesPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  const params = await searchParams
  const today = localTodayISO()
  const period = periodFromParams(params, today)

  const supabase = await createClient()
  const report = await loadSalesAnalytics(supabase, period)

  return (
    <PageContainer>
      <PageHeader
        title="Sales"
        description="What you quoted, won, invoiced and actually collected."
        action={
          <ButtonLink href="/dashboard/quotes/new">
            <Plus className="w-4 h-4" /> New quote
          </ButtonLink>
        }
      />

      <div className="space-y-5">
        <PeriodFilter period={period} />

        {report === null ? (
          // NAMED failure. Never a zeroed board.
          <Banner tone="danger">
            <span className="font-semibold">Couldn’t load your sales figures.</span> One of the
            reads failed, so this page is not showing you a number it cannot stand behind. Reload
            in a moment — nothing is wrong with your data.
          </Banner>
        ) : report.snapshot.quotedCount === 0 && report.snapshot.draftCount === 0 ? (
          <EmptyState
            icon={TrendingUp}
            title="No quotes in this period"
            description="Pick a longer range, or raise a quote and this fills in on its own."
          />
        ) : (
          <>
            {/* The anchor, stated up front. A date filter here does NOT mean
                "money received in these dates", and the owner must not have to
                infer that. */}
            <p className="text-[11px] text-ink-faint leading-relaxed">{report.cohortNote}</p>

            <SalesSnapshot s={report.snapshot} />

            <div className="grid lg:grid-cols-2 gap-4">
              <PipelineBuckets s={report.snapshot} />
              <SalesFunnel funnel={report.funnel} />
            </div>

            <SourceTable sources={report.sources} />
            <RecentMovement rows={report.movement} />
          </>
        )}
      </div>
    </PageContainer>
  )
}
