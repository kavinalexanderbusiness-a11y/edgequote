import type { ReactNode } from 'react'
import { cn } from '@/lib/utils'
import {
  serviceHistory, describeTypicalVariance, describeVariance, formatMinutes,
  MIN_SERVICE_SAMPLE,
} from '@/lib/estimateVsActual'
import type { LearningLoad } from '@/lib/estimateVsActualData'

// ── What past visits of THIS service taught, on the visit being edited ───────
// The one surface built on the estimate-vs-actual history in this pass. It sits
// under the single-visit comparison, so the owner reads "here is this visit"
// then "here is what this service usually does" without going to a report.
//
// It renders in EVERY state including the three that show no figures, because
// the states are the point:
//   * the read failed          → say that. NOT "no similar jobs", which is a
//                                claim about the business rather than the request.
//   * no comparable history    → say that, and say what would create some.
//   * fewer than MIN_SERVICE_SAMPLE → show it, labelled as too thin to lean on.
//
// ⚠️ EVIDENCE, NEVER AN ACTION. Nothing here writes back to the estimate, and
// there is deliberately no "apply this" button: the owner reads the history and
// decides. A system that quietly moved the number would be pricing from its own
// averages, which is the one thing the product does not do.

/**
 * @param load        the 3-outcome read — failure is a branch, not an empty list
 * @param serviceType this visit's service, normalized by the canonical key
 * @param excludeJobId keeps this visit out of its own history
 */
export function ServiceEstimateLearning({
  load, serviceType, excludeJobId, className,
}: {
  load: LearningLoad
  serviceType: string | null | undefined
  excludeJobId?: string
  className?: string
}) {
  const shell = (children: React.ReactNode) => (
    <div className={cn('rounded-xl border border-border bg-surface p-3.5', className)}>
      <div className="text-xs font-semibold uppercase tracking-wide text-ink-muted">
        Estimate learning
      </div>
      {children}
    </div>
  )
  const note = (text: string) => (
    <p className="mt-2 text-xs leading-relaxed text-ink-muted">{text}</p>
  )

  // A read that did not happen. No sample size, no figures, no reassurance —
  // an owner must not read a network failure as "my estimates are fine".
  if (load.outcome === 'unavailable') {
    return shell(note('Past visits could not be loaded, so there is nothing to compare against yet. This is a loading problem, not a finding about your estimates.'))
  }

  const h = serviceHistory(serviceType, load.learning.comparisons, { excludeJobId })

  // ⚠️ A SINGLE VISIT IS NEVER DESCRIBED AS TYPICAL. With n=1 the median IS that
  // one visit, so the tendency wording would dress one job up as a pattern —
  // the exact overclaim the sample rules exist to prevent, and a disclaimer
  // underneath does not undo a headline. Below the threshold but above one, the
  // tendency wording is fair as long as the sample size is stated, which it is.
  const typical = h.sampleSize === 1
    ? describeVariance({ varianceMinutes: h.medianVarianceMinutes!, variancePct: h.medianVariancePct })
    : describeTypicalVariance(h.medianVarianceMinutes)

  if (h.sampleSize === 0) {
    return shell(
      <>
        <p className="mt-2 text-xs leading-relaxed text-ink-muted">
          No other completed <span className="font-medium text-ink">{h.serviceLabel.toLowerCase()}</span> visit
          has both a planned time and a recorded time yet, so there is no history to compare against.
        </p>
        {note('Recording the actual time on visits builds this up.')}
      </>,
    )
  }

  return shell(
    <>
      {/* Sample size leads, always. Every claim below is only worth what this
          number says it is, so it is never tucked underneath the finding. */}
      <p className="mt-1.5 text-sm text-ink">
        <span className="font-semibold">{h.serviceLabel}</span>
        <span className="text-ink-muted"> · {h.sampleSize} similar {h.sampleSize === 1 ? 'visit' : 'visits'}</span>
      </p>

      {typical && (
        <p className={cn('mt-1.5 text-sm', h.established ? 'font-medium text-ink' : 'text-ink-muted')}>
          {typical}
        </p>
      )}

      {/* Context, worded as two separate facts. These are independent medians
          and do NOT subtract to the line above — see VarianceRollup — so they
          are never stacked in a column that invites the arithmetic. */}
      <p className="mt-1.5 text-xs text-ink-muted tabular-nums">
        Typical plan {formatMinutes(h.medianEstimatedMinutes)} · typical result {formatMinutes(h.medianActualMinutes)}
      </p>

      {!h.established && note(
        h.sampleSize === 1
          ? 'One visit is an observation, not a pattern — treat it as a single data point.'
          : `Only ${h.sampleSize} visits, so this is too thin to rely on. It firms up at ${MIN_SERVICE_SAMPLE}.`,
      )}

      {load.truncated && note(`Based on the most recent ${load.learning.coverage.visits} completed visits.`)}
    </>,
  )
}
