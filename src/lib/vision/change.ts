import type { ChangeSignal, ChangeSummary, VisionAnalysis } from './types'
import { COVERAGE_RANK, ordinalRank } from './scales'

// ── AI Vision — change detection ──────────────────────────────────────────────
// Compares TODAY's analysis to the PREVIOUS one (structured data, not images) and
// emits the change signals the brief asks for. Pure + deterministic so it's
// reliable; the human narrative is either this module's fallback or the AI
// synthesis polish (lib/vision/synthesis). Comparing stored analyses — never
// re-analysing imagery — is the whole point of accumulating knowledge.

function coverageOf(a: VisionAnalysis | null, key: string): number {
  const d = a?.detections?.find(x => x.key === key)
  if (!d || !d.present) return 0
  return COVERAGE_RANK[d.coverage] ?? 0
}

const HEALTH_DELTA = 8 // lawn-health score points before we call it a change

export function detectChanges(current: VisionAnalysis, previous: VisionAnalysis | null, since: string | null): ChangeSummary {
  const signals: ChangeSignal[] = []
  const cc = current.condition
  const pc = previous?.condition

  // First-ever read: no comparison, just flag standout starting conditions.
  if (!previous) {
    if (cc?.dead_grass) signals.push({ key: 'dead_grass', label: 'Dead grass present', attribute: 'dead_grass', direction: 'new', detail: 'Dead/brown-out areas visible on the first read.' })
    if (cc?.bare_patches) signals.push({ key: 'bare_patches', label: 'Bare patches present', attribute: 'bare_patches', direction: 'new', detail: 'Bare/thin areas visible on the first read.' })
    return { narrative: 'First analysis on file — this becomes the baseline every future visit is compared against.', signals, since: null, is_first: true }
  }

  // Lawn health.
  if (cc && pc && cc.lawn_health_score != null && pc.lawn_health_score != null) {
    const delta = cc.lawn_health_score - pc.lawn_health_score
    if (delta >= HEALTH_DELTA) signals.push({ key: 'lawn_healthier', label: 'Lawn looks healthier', attribute: 'lawn_health', direction: 'better', detail: `Turf health up ~${Math.round(delta)} pts (${pc.lawn_health} → ${cc.lawn_health}).` })
    else if (delta <= -HEALTH_DELTA) signals.push({ key: 'lawn_worse', label: 'Lawn looks worse', attribute: 'lawn_health', direction: 'worse', detail: `Turf health down ~${Math.round(-delta)} pts (${pc.lawn_health} → ${cc.lawn_health}).` })
  }

  // Weeds.
  const wNow = coverageOf(current, 'weeds'), wPrev = coverageOf(previous, 'weeds')
  if (wNow > wPrev) signals.push({ key: 'weeds_increasing', label: 'Weeds increasing', attribute: 'weeds', direction: 'up', detail: 'More weed coverage than last time — worth treating before they seed.' })
  else if (wNow < wPrev) signals.push({ key: 'weeds_reduced', label: 'Weeds reduced', attribute: 'weeds', direction: 'down', detail: 'Less weed coverage than last time — treatment is holding.' })

  // Mulch fading (condition got worse on the mulch scale).
  if (cc && pc) {
    const mNow = ordinalRank('mulch_condition', cc.mulch_condition)
    const mPrev = ordinalRank('mulch_condition', pc.mulch_condition)
    if (mNow != null && mPrev != null && mNow < mPrev) {
      signals.push({ key: 'mulch_fading', label: 'Mulch fading', attribute: 'mulch_condition', direction: 'worse', detail: `Mulch has gone ${pc.mulch_condition} → ${cc.mulch_condition} — a refresh is due.` })
    }
    // Hedge growth (tidiness got worse).
    const hNow = ordinalRank('hedge_condition', cc.hedge_condition)
    const hPrev = ordinalRank('hedge_condition', pc.hedge_condition)
    if (hNow != null && hPrev != null && hNow < hPrev) {
      signals.push({ key: 'hedge_growth', label: 'Hedge growth', attribute: 'hedge_condition', direction: 'worse', detail: `Hedges have grown out (${pc.hedge_condition.replace('_', ' ')} → ${cc.hedge_condition.replace('_', ' ')}).` })
    }
  }

  // Tree growth (more canopy coverage detected).
  const tNow = coverageOf(current, 'trees'), tPrev = coverageOf(previous, 'trees')
  if (tNow > tPrev) signals.push({ key: 'tree_growth', label: 'Tree growth', attribute: 'trees', direction: 'up', detail: 'More tree canopy than last time — watch for shade/overhang.' })

  // New landscaping.
  if (cc?.new_landscaping && !pc?.new_landscaping) signals.push({ key: 'new_landscaping', label: 'New landscaping', attribute: 'new_landscaping', direction: 'new', detail: 'Newly added or changed landscaping is visible.' })

  // Dead grass / bare patches appearing.
  if (cc?.dead_grass && !pc?.dead_grass) signals.push({ key: 'dead_grass', label: 'Dead grass appeared', attribute: 'dead_grass', direction: 'new', detail: 'Dead/brown-out areas not seen before.' })
  if (cc?.bare_patches && !pc?.bare_patches) signals.push({ key: 'bare_patches', label: 'Bare patches appeared', attribute: 'bare_patches', direction: 'new', detail: 'Bare/thin areas not seen before.' })

  return { narrative: fallbackNarrative(signals), signals, since, is_first: false }
}

// Deterministic narrative, used as-is when AI is off (synthesis may replace it).
export function fallbackNarrative(signals: ChangeSignal[]): string {
  if (!signals.length) return 'No notable change since the last analysis — the property is holding steady.'
  const good = signals.filter(s => s.direction === 'better' || s.direction === 'down').map(s => s.label.toLowerCase())
  const bad = signals.filter(s => s.direction !== 'better' && s.direction !== 'down').map(s => s.label.toLowerCase())
  const parts: string[] = []
  if (good.length) parts.push(`Improvements: ${good.join(', ')}.`)
  if (bad.length) parts.push(`Watch: ${bad.join(', ')}.`)
  return parts.join(' ')
}
