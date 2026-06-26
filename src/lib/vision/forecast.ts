import type { AttributeRollup, ConfidenceBand, Detection, ForecastBlock, ForecastItem, VisionAnalysis } from './types'
import { COVERAGE_RANK } from './scales'
import { seasonForDate } from './season'

// ── AI Vision — maintenance forecast ──────────────────────────────────────────
// Predicts WHEN each recurring need is likely due next, from the current read +
// the observation history's cadence. Pure (date math only). Recommendations only —
// these are planning hints, never bookings.

function addDays(iso: string, days: number): string {
  const d = new Date(iso)
  d.setDate(d.getDate() + Math.round(days))
  return d.toISOString().slice(0, 10)
}
function daysBetween(aIso: string, bIso: string): number {
  return Math.round((new Date(bIso).getTime() - new Date(aIso).getTime()) / 86_400_000)
}

export function buildForecast(opts: {
  nowIso: string
  analysis: VisionAnalysis
  attributes: Record<string, AttributeRollup>
}): ForecastBlock {
  const { nowIso, analysis, attributes } = opts
  const c = analysis.condition
  const det = new Map<string, Detection>((analysis.detections || []).map(d => [d.key, d]))
  const cov = (k: string) => { const d = det.get(k); return d?.present ? (COVERAGE_RANK[d.coverage] ?? 0) : 0 }
  const season = seasonForDate(nowIso)
  const items: ForecastItem[] = []
  const add = (key: string, label: string, horizon: number, basis: string, confidence: ConfidenceBand) =>
    items.push({ key, label, predicted_for: addDays(nowIso, horizon), horizon_days: Math.round(horizon), basis, confidence })

  // Mulch refresh — annual cadence anchored on the last "fresh" observation if we
  // have one; otherwise from current freshness.
  if (c && c.mulch_condition !== 'none') {
    const hist = attributes['mulch_condition']?.history || []
    const lastFresh = hist.find(p => p.value === 'fresh')
    if (c.mulch_condition === 'bare' || c.mulch_condition === 'faded') {
      add('mulch_refresh', 'Mulch refresh', 14, `Mulch is ${c.mulch_condition} now.`, 'high')
    } else if (lastFresh) {
      const horizon = Math.max(20, 330 - daysBetween(lastFresh.observed_at, nowIso))
      add('mulch_refresh', 'Mulch refresh', horizon, `Mulch was fresh ~${daysBetween(lastFresh.observed_at, nowIso)} days ago; mulch typically lasts ~11 months.`, 'medium')
    } else {
      add('mulch_refresh', 'Mulch refresh', c.mulch_condition === 'aging' ? 60 : 300, `Current mulch is ${c.mulch_condition}.`, c.mulch_condition === 'aging' ? 'medium' : 'low')
    }
  }

  // Hedge / shrub trimming — from tidiness, refined by how fast it grew out before.
  if (c && c.hedge_condition !== 'none') {
    const base = c.hedge_condition === 'overgrown' ? 10 : c.hedge_condition === 'slightly_overgrown' ? 35 : 75
    const conf: ConfidenceBand = c.hedge_condition === 'overgrown' ? 'high' : c.hedge_condition === 'slightly_overgrown' ? 'medium' : 'low'
    add('hedge_trim', 'Hedge / shrub trimming', base, `Hedges are ${c.hedge_condition.replace('_', ' ')}.`, conf)
  }

  // Mowing frequency increase — the spring growth ramp. Target ~June 1 (peak
  // growth); from late-year months that means next June.
  if (season === 'winter' || season === 'spring') {
    const m = Number(nowIso.slice(5, 7))
    const year = m >= 9 ? Number(nowIso.slice(0, 4)) + 1 : Number(nowIso.slice(0, 4))
    const h = daysBetween(nowIso, `${year}-06-01`)
    if (h > 0) add('mowing_frequency_up', 'Mowing frequency increases', h, 'Growth ramps up heading into summer — expect more frequent cuts.', 'medium')
  }

  // Weed treatment — present/rising weeds, or the summer flush.
  const w = cov('weeds')
  const weedTrend = attributes['weeds']?.trend
  if (w >= 2 || (w >= 1 && weedTrend === 'worsening')) {
    add('weed_treatment', 'Weed treatment', 12, 'Weeds are present and spreading — treat before they seed.', w >= 3 ? 'high' : 'medium')
  } else if (season === 'spring') {
    add('weed_treatment', 'Weed treatment (pre-emergent)', 21, 'Spring is the window for pre-emergent weed control.', 'low')
  }

  items.sort((a, b) => a.horizon_days - b.horizon_days)
  return { items }
}
