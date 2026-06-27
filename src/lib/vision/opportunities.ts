import type { AttributeRollup, Opportunity, OppTier, OpportunityBlock, Season, VisionAnalysis } from './types'
import { coverageRank } from './scales'
import { serviceLabel } from './services'

// ── AI Vision — opportunity detection ─────────────────────────────────────────
// Scores upsell opportunities from the current read + the customer's purchase
// history + season + the twin's TREND (a deteriorating condition is a more urgent
// opportunity than a steady one), ranked by expected value. Pure + deterministic.
// Opportunity keys are the canonical service keys (lib/vision/services) so
// never-purchased + $ hints line up. RECOMMENDATIONS ONLY — no prices written.

// `attr` = the tracked attribute whose trend makes this opportunity more/less
// urgent (used to read attributes[attr].trend).
interface Cand { key: string; attr: string; severity: number; reason: string; seasonalFit?: boolean }

function tierFor(score: number): OppTier {
  return score >= 70 ? 'high' : score >= 45 ? 'medium' : 'low'
}

export function scoreOpportunities(opts: {
  analysis: VisionAnalysis
  season: Season
  purchased: Set<string>
  values: Map<string, number>
  attributes?: Record<string, AttributeRollup> // the twin's per-attribute trend, when available
}): OpportunityBlock {
  const { analysis, season, purchased, values, attributes } = opts
  const c = analysis.condition
  const w = coverageRank(analysis, 'weeds')
  const springOrFall = season === 'spring' || season === 'fall'

  const cands: Cand[] = []

  // Mulch refresh — from mulch freshness.
  if (c) {
    const sev = c.mulch_condition === 'bare' ? 90 : c.mulch_condition === 'faded' ? 72 : c.mulch_condition === 'aging' ? 45 : 0
    if (sev) cands.push({ key: 'mulch', attr: 'mulch_condition', severity: sev, reason: `Mulch is ${c.mulch_condition} — a refresh restores colour and suppresses weeds.` })
  }
  // Weed control — from weed coverage.
  if (w) cands.push({ key: 'weed_control', attr: 'weeds', severity: w === 3 ? 90 : w === 2 ? 65 : 40, reason: `${w === 3 ? 'Heavy' : w === 2 ? 'Moderate' : 'Some'} weed coverage visible — treat before it seeds.`, seasonalFit: season === 'summer' || season === 'spring' })
  // Hedge / shrub trimming — from tidiness.
  if (c) {
    const sev = c.hedge_condition === 'overgrown' ? 82 : c.hedge_condition === 'slightly_overgrown' ? 52 : 0
    if (sev) cands.push({ key: 'hedge_trim', attr: 'hedge_condition', severity: sev, reason: `Hedges look ${c.hedge_condition.replace('_', ' ')} — a trim sharpens the whole property.` })
  }
  // Aeration — compaction / fair-poor turf, strongest in spring/fall.
  if (c) {
    let sev = c.lawn_health === 'poor' ? 65 : c.lawn_health === 'fair' ? 45 : 0
    if (c.bare_patches) sev += 12
    if (sev) cands.push({ key: 'aeration', attr: 'lawn_health', severity: Math.min(95, sev), reason: 'Turf is stressed/compacted — aeration improves root depth and recovery.', seasonalFit: springOrFall })
  }
  // Overseeding — bare/dead/poor turf.
  if (c && (c.bare_patches || c.dead_grass || c.lawn_health === 'poor')) {
    const sev = c.dead_grass ? 70 : c.bare_patches ? 60 : 48
    cands.push({ key: 'overseeding', attr: 'lawn_health', severity: sev, reason: `${c.dead_grass ? 'Dead' : c.bare_patches ? 'Bare' : 'Thin'} areas visible — overseeding thickens the lawn.`, seasonalFit: springOrFall })
  }
  // Fertilizer — feed when turf is fair/poor or weeds are present.
  if (c) {
    let sev = c.lawn_health === 'poor' ? 58 : c.lawn_health === 'fair' ? 40 : 0
    if (w >= 2) sev = Math.max(sev, 42)
    if (sev) cands.push({ key: 'fertilizer', attr: 'lawn_health', severity: sev, reason: 'A feeding program greens up the turf and helps it crowd out weeds.', seasonalFit: springOrFall })
  }
  // Edging — when edges aren't crisp.
  if (coverageRank(analysis, 'edging') <= 1) {
    cands.push({ key: 'edging', attr: 'edging', severity: 42, reason: 'Edges aren’t crisp — adding edging makes every visit look finished.' })
  }

  const items: Opportunity[] = cands.map(cand => {
    let score = cand.severity
    if (cand.seasonalFit) score += 12
    const worsening = attributes?.[cand.attr]?.trend === 'worsening'
    if (worsening) score += 10 // a deteriorating condition is more urgent than a steady one
    const neverPurchased = !purchased.has(cand.key)
    if (neverPurchased) score = score * 1.12 + 8 // a brand-new service is a bigger opening
    // Temper by overall confidence so a shaky read doesn't oversell.
    const confFactor = 0.6 + 0.4 * Math.min(1, Math.max(0, (analysis.confidence ?? 60) / 100))
    score = Math.round(Math.min(100, score * confFactor))
    const reason = [
      cand.reason,
      worsening ? 'It’s trending worse since the last visit.' : '',
      neverPurchased ? 'Customer hasn’t bought this before.' : '',
    ].filter(Boolean).join(' ')
    return {
      key: cand.key,
      label: serviceLabel(cand.key),
      tier: tierFor(score),
      score,
      expected_value: values.get(cand.key) ?? null,
      reason,
      never_purchased: neverPurchased,
    }
  }).filter(o => o.score >= 25)

  // Rank by expected customer value: tier/score first, then $ hint.
  items.sort((a, b) => (b.score - a.score) || ((b.expected_value ?? 0) - (a.expected_value ?? 0)))
  return { items }
}
