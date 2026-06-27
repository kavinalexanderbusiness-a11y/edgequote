import type { ChangeSummary, MarketingSummary, VisionAnalysis } from './types'
import { coverageRank } from './scales'

// ── AI Vision — marketing summary (reusable, no re-analysis) ──────────────────
// Distils the current read + change into ready-to-use marketing signals so
// Marketing Studio (or any future tool) can know "this property has fresh mulch /
// excellent edging / a dramatic before-after" WITHOUT analysing images again.
// Pure. Exposed for Marketing to consume — it does not edit Marketing Studio.

export function buildMarketing(opts: {
  analysis: VisionAnalysis
  change: ChangeSummary
  hasBeforeAfter: boolean
}): MarketingSummary {
  const { analysis, change, hasBeforeAfter } = opts
  const c = analysis.condition

  const flags: string[] = []
  const highlights: string[] = []

  if (c && (c.mulch_condition === 'fresh' || c.mulch_condition === 'good')) {
    flags.push('fresh_mulch'); highlights.push('Fresh, sharp mulch beds')
  }
  if (coverageRank(analysis, 'edging') >= 3) { flags.push('edging_excellent'); highlights.push('Crisp, professional edging') }
  if (c && c.lawn_health === 'excellent' && coverageRank(analysis, 'mowing_completed') > 0) {
    flags.push('beautiful_stripes'); highlights.push('Healthy, freshly cut lawn')
  }

  const improvements = change.signals.filter(s => s.direction === 'better' || s.direction === 'down')
  if (hasBeforeAfter && improvements.length) { flags.push('dramatic_before_after'); highlights.push('Clear before-and-after improvement') }
  if (improvements.length >= 2 || c?.new_landscaping) { flags.push('large_transformation'); highlights.push('Big visible transformation') }

  const summary = highlights.length
    ? `This property shows: ${highlights.join('; ')}.`
    : 'No standout marketing angle on this read yet.'

  return { flags, highlights, summary }
}
