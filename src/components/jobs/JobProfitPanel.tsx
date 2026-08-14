'use client'

import { useEffect, useState } from 'react'
import { TrendingUp } from 'lucide-react'
import { createClient } from '@/lib/supabase/client'
import { cn, formatCurrency } from '@/lib/utils'
import { Badge } from '@/components/ui/Badge'
import { formatWorked } from '@/lib/workDuration'
import {
  describeInvoiced, describeProfit, describeSettlement, type JobProfitReview,
} from '@/lib/jobProfit'
import { loadJobProfit, type JobProfitLoad } from '@/lib/jobProfitData'

// ── Did this visit make money? ───────────────────────────────────────────────
// The last panel in the stack, and deliberately the one that most often shows a
// SENTENCE instead of a number.
//
// Above it, three panels answer questions the visit already knows: how long it
// was planned to take, how long it took, and what somebody recorded spending. This
// one performs the only subtraction that crosses from revenue to cost — and
// lib/jobProfit refuses to perform it unless the cost is complete. On the day this
// shipped, both technicians in production had no wage recorded and the book held
// zero receipts, so the honest answer for every visit was:
//
//     "Margin incomplete — labour cost not recorded."
//
// That is the feature working. A panel that answered "100% margin" to the same
// data would be worse than no panel, because it would be believed.
//
// ⚠️ FOUR FIGURES, FOUR DIFFERENT FACTS, AND THEY ARE NEVER MERGED HERE. What was
// authorized, what was invoiced, what was collected and what was spent each get
// their own row and their own words. The one screen an owner glances at is exactly
// where "collected" would otherwise be read as "earned".
//
// ⚠️ EVERY BUTTON MUST BE type="button" — this renders inside JobForm's <form>,
// where a bare <button> submits the visit. There are none today; if one is added,
// use `Button` (which already defaults to type="button").

export function JobProfitPanel({
  jobId, reloadKey, className,
}: {
  jobId: string
  /** Bumped by the cost panel above, so recording a receipt updates this at once
   *  instead of leaving two panels on screen disagreeing about the same visit. */
  reloadKey?: number
  className?: string
}) {
  const supabase = createClient()
  const [load, setLoad] = useState<JobProfitLoad | null>(null)

  useEffect(() => {
    let alive = true
    ;(async () => {
      const { data: { user } } = await supabase.auth.getUser()
      if (!alive) return
      const next = await loadJobProfit(supabase, user?.id ?? '', jobId)
      if (alive) setLoad(next)
    })()
    return () => { alive = false }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [jobId, reloadKey])

  // Loading is its own state and shows NO figures. A skeleton with zeros in it is
  // the same lie as a failed read with zeros in it, half a second earlier.
  if (!load) return <Shell className={className}><Muted>Working it out…</Muted></Shell>

  if (load.outcome === 'unavailable') {
    return (
      <Shell className={className}>
        <Muted>
          This visit’s money could not be loaded, so nothing is shown. That is a loading problem —
          not a finding that the visit made nothing.
        </Muted>
      </Shell>
    )
  }

  const r = load.review
  const known = r.margin.state === 'known'

  return (
    <Shell className={className} badge={known ? <Badge tone={r.margin.tone}>{r.margin.percent}% margin</Badge> : null}>
      {/* The headline is the sentence when there is no margin, and the whole
          subtraction when there is — "52%" alone hides whether that is 52% of
          $200 or of $20,000. */}
      <p className={cn('mt-1.5 text-sm leading-relaxed', known ? 'font-semibold text-ink' : 'text-ink')}>
        {describeProfit(r)}
      </p>

      <dl className="mt-2.5 space-y-1">
        {/* The original agreement first, so the reader sees what changed rather
            than only where things landed. Absent for a directly-booked job, which
            is a fact about the job and not a $0 agreement. */}
        <Row
          label="Accepted quote"
          value={r.accepted.amount != null ? formatCurrency(r.accepted.amount) : 'Booked without a quote'}
          known={r.accepted.state === 'known'} />
        <Row
          label="Authorized now"
          value={r.authorized.amount != null ? formatCurrency(r.authorized.amount) : 'No price recorded'}
          known={r.authorized.state === 'known'} />
        {/* Where that price came from, when it is not simply the base service.
            An APPROVED change order minted its line item, so it is authorized
            value; a pending or declined one has no row and cannot appear here. */}
        {r.authorized.state === 'known' && (r.authorized.extras !== 0 || r.authorized.travel !== 0) && (
          <p className="pl-0.5 text-[11px] leading-relaxed text-ink-faint">
            {formatCurrency(r.authorized.base)} base
            {r.authorized.approvedChanges !== 0 && ` + ${formatCurrency(r.authorized.approvedChanges)} in ${r.authorized.approvedChangeCount === 1 ? 'an approved change' : `${r.authorized.approvedChangeCount} approved changes`}`}
            {r.authorized.ownerExtras !== 0 && ` + ${formatCurrency(r.authorized.ownerExtras)} in added extras`}
            {r.authorized.travel !== 0 && ` + ${formatCurrency(r.authorized.travel)} travel`}
          </p>
        )}
        {r.scopeVariance != null && Math.abs(r.scopeVariance) > 0.005 && (
          <p className="pl-0.5 text-[11px] leading-relaxed text-ink-faint">
            {r.scopeVariance > 0
              ? `${formatCurrency(r.scopeVariance)} more than the accepted quote.`
              : `${formatCurrency(Math.abs(r.scopeVariance))} less than the accepted quote.`}
          </p>
        )}
        {/* Asked for, not answered. Reported so it is visible, and never added to
            anything above — nobody has agreed to pay it. */}
        {r.changes.pending > 0.005 && (
          <p className="pl-0.5 text-[11px] leading-relaxed text-amber-600 dark:text-amber-400">
            {formatCurrency(r.changes.pending)} in {r.changes.pendingCount === 1 ? 'a change' : 'changes'} is
            still unanswered — not counted above, because nobody has agreed to it.
          </p>
        )}

        {/* What was actually billed — its own line, because "not invoiced yet"
            and "$0.00" are different facts and a sentence buried below the
            figures is where that distinction goes to die. */}
        <Row
          label="Invoiced"
          value={r.invoiced.amount != null ? formatCurrency(r.invoiced.amount) : describeInvoiced(r)}
          known={r.invoiced.state === 'issued' || r.invoiced.state === 'draft'} />

        <Row label="Recorded costs" value={costWords(r)} known={r.cost.total.state === 'known'} />

        {known && (
          <Row label="Known margin" value={formatCurrency(r.margin.profit ?? 0)} known strong />
        )}
      </dl>

      {/* ── Cash, which is a different question from all of the above ── */}
      <div className="mt-2.5 space-y-1 border-t border-border pt-2">
        <Row
          label="Collected"
          value={r.collected.amount != null ? formatCurrency(r.collected.amount) : 'Unknown'}
          known={r.collected.state === 'known'} />
        {describeSettlement(r) && (
          <p className="text-xs leading-relaxed text-ink-muted">{describeSettlement(r)}</p>
        )}
        {r.collected.fromCredit > 0.005 && (
          <p className="text-[11px] leading-relaxed text-ink-faint">
            {formatCurrency(r.collected.fromCredit)} of that invoice was settled from credit this
            customer had already paid — real settlement, but not cash arriving now.
          </p>
        )}
        {r.collected.refunded > 0.005 && (
          <p className="text-[11px] leading-relaxed text-ink-faint">
            {formatCurrency(r.collected.refunded)} was refunded, and is already netted off above.
          </p>
        )}
        {r.collected.includesTax && (r.collected.amount ?? 0) > 0 && (
          <p className="text-[11px] leading-relaxed text-ink-faint">
            Cash collected includes sales tax you hold for the CRA, so it is more than the revenue
            above. Margin is measured on the price, never on the cash.
          </p>
        )}
        {r.invoicedVariance != null && Math.abs(r.invoicedVariance) > 0.005 && (
          <p className="text-[11px] leading-relaxed text-amber-600 dark:text-amber-400">
            {r.invoicedVariance < 0
              ? `Invoiced ${formatCurrency(Math.abs(r.invoicedVariance))} less than authorized — a discount, or the invoice was edited.`
              : `Invoiced ${formatCurrency(r.invoicedVariance)} more than authorized — the invoice was edited by hand.`}
            {' '}Margin above uses the authorized price.
          </p>
        )}
      </div>

      {/* ── The days behind it: what makes a multi-day project reviewable ── */}
      {(r.work.sessions > 0 || r.work.failed || r.work.disagrees) && (
        <div className="mt-2 border-t border-border pt-2">
          {r.work.sessions > 0 && (
            <p className="text-xs tabular-nums text-ink-muted">
              {r.work.sessions} {r.work.sessions === 1 ? 'session' : 'sessions'}
              {r.work.days > 1 && ` over ${r.work.days} days`}
              {r.work.elapsedMinutes != null && ` · ${formatWorked(r.work.elapsedMinutes)} on site`}
              {r.work.labourMinutes != null && r.work.labourMinutes !== r.work.elapsedMinutes
                && ` · ${formatWorked(r.work.labourMinutes)} of labour`}
            </p>
          )}
          {r.work.disagrees && (
            <p className="mt-1 text-[11px] leading-relaxed text-amber-600 dark:text-amber-400">
              The day-by-day record does not add up to this visit’s recorded time, so these are not
              all the days. Hours here are incomplete.
            </p>
          )}
          {r.work.failed && (
            <p className="mt-1 text-[11px] leading-relaxed text-ink-faint">
              The day-by-day record could not be loaded — not a finding that no days were worked.
            </p>
          )}
        </div>
      )}

      {/* What this margin does NOT include. Said on the panel rather than in a
          help page, because a gross margin read as a net one is how an owner
          concludes a job paid for itself when it did not. */}
      {known && (
        <p className="mt-2 text-[11px] leading-relaxed text-ink-faint">
          Gross margin on recorded direct cost: no overhead, drive time, equipment or owner’s wage is
          taken off here.
        </p>
      )}
      {!known && r.margin.block === 'cost_incomplete' && (
        <p className="mt-2 text-[11px] leading-relaxed text-ink-faint">
          Nothing recorded in a category does not mean nothing was spent in it, so no margin is shown.
          Record it above and this fills in.
        </p>
      )}
    </Shell>
  )
}

/**
 * The cost figure, worded so a floor can never be read as a total. "At least
 * $185" is the honest form of an incomplete cost — the wording itself says more
 * is missing, which "$185" with a footnote elsewhere does not.
 */
function costWords(r: JobProfitReview): string {
  if (r.cost.total.state === 'known') return formatCurrency(r.cost.total.amount ?? 0)
  if (r.margin.costFloor > 0) return `At least ${formatCurrency(r.margin.costFloor)}`
  return 'Nothing recorded'
}

function Row({ label, value, known, strong }: {
  label: string; value: string; known: boolean; strong?: boolean
}) {
  return (
    <div className="flex items-baseline justify-between gap-3">
      <dt className="text-xs text-ink-muted">{label}</dt>
      <dd className={cn(
        'shrink-0 text-xs tabular-nums',
        known ? (strong ? 'font-semibold text-ink' : 'font-medium text-ink') : 'text-ink-faint',
      )}>
        {value}
      </dd>
    </div>
  )
}

function Muted({ children }: { children: React.ReactNode }) {
  return <p className="mt-2 text-xs leading-relaxed text-ink-muted">{children}</p>
}

function Shell({ className, badge, children }: {
  className?: string; badge?: React.ReactNode; children: React.ReactNode
}) {
  return (
    <div className={cn('rounded-xl border border-border bg-surface p-3.5', className)}>
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-ink-muted">
          <TrendingUp className="h-3.5 w-3.5" /> Did this make money
        </div>
        {badge}
      </div>
      {children}
    </div>
  )
}
