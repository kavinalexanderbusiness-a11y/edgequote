'use client'

import { useEffect, useMemo, useState } from 'react'
import { Sparkles, Check } from 'lucide-react'
import { createClient } from '@/lib/supabase/client'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/Button'
import { serviceHistory, MIN_SERVICE_SAMPLE } from '@/lib/estimateVsActual'
import type { LearningLoad } from '@/lib/estimateVsActualData'
import {
  buildWorkEstimate, describeConfidence, describeLaborBasis, formatLaborHours,
  formatEstimatedDuration,
} from '@/lib/workEstimate'
import { loadWorkdayMinutes } from '@/lib/workEstimateData'

// ── The smart estimate, on the field it is an estimate for ───────────────────
// Compact by design. This is a suggestion beside an input, not a report: one
// duration, the crew and labour-hours when the work needs a crew, the number of
// jobs behind it, and a button. No charts, no accuracy percentages, no history
// table — the estimate-learning detail already has its own surface further up
// the form, and duplicating it here would turn a 4-line card into a dashboard on
// a 375px screen.
//
// ⭐ IT NEVER WRITES BY ITSELF. There is no auto-fill effect and no
// setValue outside the button's own onClick, so a learned number cannot land in
// a scheduled visit's duration behind the owner's back, and re-opening a saved
// job can never silently re-estimate it. The owner's typed duration is the
// owner's, always; applying is a deliberate act with a visible control. (The
// widget this replaces auto-applied from an effect whenever its inputs changed.)
//
// ⭐ FOUR STATES, ALL RENDERED. A read that failed, a service with no history, a
// history too thin to lean on, and an established one. The thin state shows its
// figure as CONTEXT with no apply button: below the canonical sample threshold
// the product does not offer a number to fill a field with.

export function SmartEstimateCard({
  load, serviceType, excludeJobId, value, onApply, className,
}: {
  /** The 3-outcome completed-visit read. Failure is a branch, not an empty list. */
  load: LearningLoad | null
  serviceType: string | null | undefined
  /** Keeps the visit being edited out of its own history. */
  excludeJobId?: string
  /** The form's current duration (minutes), so the card can say "Applied". */
  value: number | null
  onApply: (minutes: number) => void
  className?: string
}) {
  const supabase = useMemo(() => createClient(), [])
  const [dayMin, setDayMin] = useState<number | null>(null)

  useEffect(() => {
    let active = true
    supabase.auth.getSession().then(({ data: { session } }) =>
      loadWorkdayMinutes(supabase, session?.user?.id ?? ''))
      .then(m => { if (active) setDayMin(m) })
    return () => { active = false }
  }, [supabase])

  const shell = (badgeEl: React.ReactNode, body: React.ReactNode, tone?: 'accent') => (
    <div className={cn(
      'rounded-xl border p-3 space-y-1.5',
      tone === 'accent' ? 'border-accent/20 bg-accent/[0.04]' : 'border-border bg-bg-tertiary',
      className,
    )}>
      <div className="flex items-center justify-between gap-2">
        <span className="text-xs font-bold text-ink flex items-center gap-1.5">
          <Sparkles className={cn('w-3.5 h-3.5', tone === 'accent' ? 'text-accent-text' : 'text-ink-faint')} />
          Smart estimate
        </span>
        {badgeEl}
      </div>
      {body}
    </div>
  )

  const badge = (text: string, strong?: boolean) => (
    <span className={cn(
      'text-[10px] font-semibold rounded-full px-2 py-0.5 border whitespace-nowrap',
      strong ? 'text-accent-text border-accent/40 bg-accent/10' : 'text-ink-muted border-border',
    )}>{text}</span>
  )
  const note = (text: string) => <p className="text-[11px] leading-relaxed text-ink-muted">{text}</p>

  // Nothing is loaded yet, or the read did not happen. A network failure must
  // never read as "this service has no history" — that is a claim about the
  // business made out of a claim about the connection.
  if (!load) return null
  if (load.outcome === 'unavailable') {
    return shell(
      badge('—'),
      note('Past visits could not be loaded, so there is no estimate to offer. This is a loading problem, not a finding about your work.'),
    )
  }

  const est = buildWorkEstimate(
    serviceHistory(serviceType, load.learning.comparisons, { excludeJobId }),
    // Until the setting has loaded, the product default stands in — it changes
    // only the unit a duration is spoken in, never the duration.
    { capacityHours: dayMin == null ? null : dayMin / 60 },
  )
  const svc = est.serviceLabel.toLowerCase()
  const basis = (n: number) => `Based on ${n} comparable completed job${n === 1 ? '' : 's'}`

  // No comparable work. Say so, say what builds it, and offer nothing.
  if (est.confidence === 'none') {
    return shell(
      badge(describeConfidence(est)),
      note(`No completed ${svc} job has both a planned and a recorded time yet — so there is nothing to estimate from. Enter an estimate manually; recording the actual time as you finish jobs builds this up.`),
    )
  }

  // Real visits, below the canonical threshold. The figure is shown because
  // hiding it would be its own dishonesty, but it is CONTEXT: no button, no
  // "typical", and the count leads.
  if (est.confidence === 'limited') {
    return shell(
      badge(describeConfidence(est)),
      <>
        <p className="text-sm font-semibold text-ink tabular-nums">
          {est.sampleSize === 1 ? 'One ' : `${est.sampleSize} `}{svc} job{est.sampleSize === 1 ? '' : 's'} recorded
          <span className="font-normal text-ink-muted"> · {formatEstimatedDuration(est.observedElapsedMinutes, est.workdayMinutes)} on site</span>
        </p>
        {note(est.sampleSize === 1
          ? `One job is an observation, not a pattern, so EdgeQuote will not suggest a duration from it. It starts suggesting at ${MIN_SERVICE_SAMPLE}.`
          : `Too thin to suggest a duration from — enter an estimate manually. It firms up at ${MIN_SERVICE_SAMPLE} comparable jobs.`)}
      </>,
    )
  }

  // Established. `suggestedElapsedMinutes` is non-null exactly here.
  const minutes = est.suggestedElapsedMinutes as number
  const applied = value != null && Math.round(value) === minutes

  return shell(
    badge(describeConfidence(est), true),
    <>
      {/* ELAPSED leads — it is what a calendar, a customer and a crew's day are
          measured in. Past a working day it is spoken in workdays with the
          hours kept alongside, because "960 minutes" is a number the reader has
          to convert before it means anything. */}
      <p className="text-xl font-black text-ink leading-none tabular-nums">
        ~{formatEstimatedDuration(minutes, est.workdayMinutes)}
        <span className="text-xs font-semibold text-ink-muted"> on site</span>
      </p>

      {/* LABOUR — a different question, not a bigger version of the same one.
          Shown whenever it says something the elapsed line does not; on solo
          work the two figures are the same number and the line is noise.
          ⭐ That condition is "labour ≠ elapsed", NOT "crew > 1", because a
          multi-day job worked by one person on Monday and two on Tuesday has
          real labour and NO single crew size — gating on the crew would hide
          the one figure only work sessions can produce.

          ⭐ THE BASIS IS SAID OUT LOUD. "actually worked" is reserved for
          labour summed from work sessions whose worker counts a person stated.
          A figure derived from the PLANNED crew — including a clock session's
          copy of it — is worded as such and never as what happened.

          ⚠️ THREE FACTS, NOT A SUM. Hours, crew and labour-hours are three
          independent medians and will not multiply out to each other — every
          visit contributes its own hours AND its own headcount, so the typical
          of each is measured separately. The wording keeps them as separate
          observations ("and", not "×") rather than inviting arithmetic that is
          supposed to disagree. */}
      {est.suggestedLaborMinutes != null && est.suggestedLaborMinutes !== minutes && (
        <p className="text-[11px] text-ink-muted tabular-nums">
          {est.typicalCrewSize != null
            ? `Usually a crew of ${est.typicalCrewSize}, and a`
            : 'The crew varied from day to day; a'}
          {' '}typical job carries about {formatLaborHours(est.suggestedLaborMinutes)} {describeLaborBasis(est)}
          {est.laborSampleSize !== est.sampleSize && ` (${est.laborSampleSize} of them recorded it)`}
        </p>
      )}

      <div className="flex items-center justify-between gap-2 pt-0.5">
        <span className="text-[11px] text-ink-faint">{basis(est.sampleSize)}</span>
        {applied
          ? <span className="inline-flex items-center gap-1 text-[11px] font-semibold text-emerald-400 shrink-0">
              <Check className="w-3.5 h-3.5" /> Applied
            </span>
          : <Button type="button" variant="ghost" size="sm" className="shrink-0"
              onClick={() => onApply(minutes)}>Use estimate</Button>}
      </div>
    </>,
    'accent',
  )
}
