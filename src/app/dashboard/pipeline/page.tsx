import { createClient } from '@/lib/supabase/server'
import { loadPipeline } from '@/lib/pipelineData'
import { PipelineBoard } from '@/components/pipeline/PipelineBoard'
import { PageHeader } from '@/components/layout/PageHeader'
import { PageContainer } from '@/components/layout/PageContainer'
import { ButtonLink } from '@/components/ui/Button'
import { formatCurrency } from '@/lib/utils'
import { Plus } from 'lucide-react'

// ── Pipeline — every deal in flight, and the one thing to do about each ──────
// The CRM's answer to "what should I do next?", one deal at a time. The dashboard
// answers it for the BUSINESS ("Follow up on quotes · 4 · $1,246"); this answers
// "…so which one, and what do I do?" — and both read the same engines, so they
// can never disagree about what is stale, won, lost, owed or booked.
//
// SERVER-RENDERED, one query batch (lib/pipelineData), no spinner: the board is
// simply there on the first byte. A failed read THROWS rather than painting an
// empty pipeline — "nothing to do" is the most reassuring screen in the app and
// the most dangerous thing to say when it isn't true.
//
// Deliberately NOT here: a win-rate chart, loss-reason breakdowns, per-
// neighbourhood conversion. That is Grow's Win/Loss panel, reading the same
// quote_outcomes rows. This page is a working queue; putting the analysis on it
// would make a second, drifting copy of the report and bury the work.
export default async function PipelinePage() {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  const report = await loadPipeline(supabase, user!.id)

  // The header states the shape of the pipeline in facts, not a caption: how many
  // deals need something today, and the money attached to the open ones. Both come
  // from the engine — nothing is recomputed here.
  const parts = [
    `${report.actionable} need${report.actionable === 1 ? 's' : ''} you today`,
    report.openValue > 0 ? `${formatCurrency(report.openValue)} still open` : null,
  ].filter(Boolean)

  return (
    <PageContainer>
      <PageHeader
        title="Pipeline"
        description={report.items.length > 0
          ? parts.join(' · ')
          : 'Leads and quotes appear here from the moment they arrive.'}
        action={
          <ButtonLink href="/dashboard/quotes/new">
            <Plus className="w-4 h-4" /> New quote
          </ButtonLink>
        }
      />
      <PipelineBoard report={report} />

      {/* Say what the board is, so a short Won column is never misread as a bad
          month. A deal drops off when nothing is left to do about it — that is the
          rule that keeps this a queue instead of a graveyard, and the owner should
          not have to infer it. */}
      {report.items.length > 0 && (
        <p className="mt-4 text-[11px] text-ink-faint leading-relaxed">
          A deal leaves this list once there’s nothing left to do about it — booked, invoiced and
          paid, or lost with the reason recorded. Your full quote history lives in{' '}
          <a href="/dashboard/quotes" className="text-ink-muted hover:text-accent-text underline">Quotes</a>,
          and win rates in{' '}
          <a href="/dashboard/grow" className="text-ink-muted hover:text-accent-text underline">Grow</a>.
        </p>
      )}
    </PageContainer>
  )
}
