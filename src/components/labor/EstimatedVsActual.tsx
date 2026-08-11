import { cn } from '@/lib/utils'
import { toneText } from '@/lib/tone'
import {
  readVisitLabor, formatMinutes, formatVarianceMinutes, formatVariancePct, describeVariance,
  type VisitLike,
} from '@/lib/estimateVsActual'

// ── Estimated vs Actual, on one finished visit ───────────────────────────────
// Three figures in the order an owner asks for them: what I planned, what it
// took, and the difference. Every number comes from lib/estimateVsActual — this
// component does no arithmetic of its own, so the job screen and any later
// report can never disagree about what a variance is.
//
// It renders in every state, including the ones with nothing to show. A visit
// with no recorded time says so; it does NOT quietly display a 0-minute
// difference, which would read as a perfect estimate on the majority of visits
// (in production, 54% of completed visits have no recorded time at all).

/** Big enough that the estimate itself is worth revisiting, in either direction. */
const NOTABLE_PCT = 25

const WHY: Record<string, string> = {
  // Wording stays factual about what is missing and who can fill it.
  not_completed: 'Available once this visit is marked done.',
  no_estimate: 'No planned time was set for this visit, so there is nothing to compare against.',
  no_actual: 'Enter the actual time on site to see how the estimate held up.',
  implausible_actual: 'The recorded time looks like a mis-tap, so it is left out of the comparison.',
}

export function EstimatedVsActual({ visit, className }: { visit: VisitLike; className?: string }) {
  const read = readVisitLabor(visit)
  const c = read.comparison

  // Attention follows MAGNITUDE, never direction. Running long is not a failure
  // and finishing early is not a win — both mean the plan was wrong, and an
  // owner who always overestimates is turning away work they had time for.
  const tone = c && Math.abs(c.variancePct) >= NOTABLE_PCT ? 'warn' : 'neutral'

  return (
    <div className={cn('rounded-xl border border-border bg-surface p-3.5', className)}>
      <div className="text-xs font-semibold uppercase tracking-wide text-ink-muted">
        Estimated vs actual
      </div>

      {/* Three columns hold at 375px because each value is short (“1h 45m” at
          worst). The labels stay above the numbers so nothing has to truncate. */}
      <dl className="mt-2.5 grid grid-cols-3 gap-2">
        <div className="min-w-0">
          <dt className="text-[11px] uppercase tracking-wide text-ink-faint">Estimated</dt>
          <dd className="mt-0.5 text-base font-semibold tabular-nums text-ink">
            {formatMinutes(read.estimatedMinutes)}
          </dd>
        </div>
        <div className="min-w-0">
          <dt className="text-[11px] uppercase tracking-wide text-ink-faint">Actual</dt>
          <dd className="mt-0.5 text-base font-semibold tabular-nums text-ink">
            {formatMinutes(read.actualMinutes)}
          </dd>
        </div>
        <div className="min-w-0">
          <dt className="text-[11px] uppercase tracking-wide text-ink-faint">Difference</dt>
          <dd className={cn('mt-0.5 text-base font-semibold tabular-nums', toneText[tone])}>
            {/* Null-safe by construction: with no comparison this is “—”, not 0. */}
            {formatVarianceMinutes(c ? c.varianceMinutes : null)}
          </dd>
        </div>
      </dl>

      {c ? (
        <p className="mt-2.5 text-xs leading-relaxed text-ink-muted">
          {describeVariance(c)}
        </p>
      ) : (
        <p className="mt-2.5 text-xs leading-relaxed text-ink-muted">
          {read.reason ? WHY[read.reason] : ''}
        </p>
      )}

      {c && (
        <p className="sr-only">
          Estimated {formatMinutes(c.estimatedMinutes)}, actual {formatMinutes(c.actualMinutes)},
          difference {formatVarianceMinutes(c.varianceMinutes)} ({formatVariancePct(c.variancePct)}).
        </p>
      )}
    </div>
  )
}
