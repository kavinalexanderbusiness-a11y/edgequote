import type { AttributeRollup, ConfidenceBand, ForecastBlock, ForecastItem, VisionAnalysis } from './types'
import { coverageRank } from './scales'
import { seasonForDate } from './season'

// ── AI Vision — maintenance forecast ──────────────────────────────────────────
// Predicts WHEN each recurring need is likely due next, from the current read +
// the observation history's cadence + TREND (a condition that's deteriorating is
// pulled sooner than the textbook interval). Pure (date math only).
// Recommendations only — these are planning hints, never bookings.

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
  const worsening = (attr: string) => attributes[attr]?.trend === 'worsening'
  const season = seasonForDate(nowIso)
  const items: ForecastItem[] = []
  const add = (key: string, label: string, horizon: number, basis: string, confidence: ConfidenceBand) =>
    items.push({ key, label, predicted_for: addDays(nowIso, horizon), horizon_days: Math.round(horizon), basis, confidence })

  // Mulch refresh — annual cadence anchored on the last "fresh" observation if we
  // have one; pulled ~25% sooner when the twin sees mulch actively fading.
  if (c && c.mulch_condition !== 'none') {
    const hist = attributes['mulch_condition']?.history || []
    const lastFresh = hist.find(p => p.value === 'fresh')
    const fade = worsening('mulch_condition') ? 0.75 : 1
    if (c.mulch_condition === 'bare' || c.mulch_condition === 'faded') {
      add('mulch_refresh', 'Mulch refresh', 14, `Mulch is ${c.mulch_condition} now.`, 'high')
    } else if (lastFresh) {
      const elapsed = daysBetween(lastFresh.observed_at, nowIso)
      add('mulch_refresh', 'Mulch refresh', Math.max(20, (330 - elapsed) * fade), `Mulch was fresh ~${elapsed} days ago; mulch typically lasts ~11 months.`, 'medium')
    } else {
      add('mulch_refresh', 'Mulch refresh', (c.mulch_condition === 'aging' ? 60 : 300) * fade, `Current mulch is ${c.mulch_condition}.`, c.mulch_condition === 'aging' ? 'medium' : 'low')
    }
  }

  // Hedge / shrub trimming — from tidiness, pulled sooner when it's growing out
  // faster than this property's norm.
  if (c && c.hedge_condition !== 'none') {
    const fast = worsening('hedge_condition')
    const base = (c.hedge_condition === 'overgrown' ? 10 : c.hedge_condition === 'slightly_overgrown' ? 35 : 75) * (fast ? 0.7 : 1)
    const conf: ConfidenceBand = c.hedge_condition === 'overgrown' ? 'high' : c.hedge_condition === 'slightly_overgrown' ? 'medium' : 'low'
    add('hedge_trim', 'Hedge / shrub trimming', base, `Hedges are ${c.hedge_condition.replace('_', ' ')}${fast ? ' and growing out quickly' : ''}.`, conf)
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
  const w = coverageRank(analysis, 'weeds')
  if (w >= 2 || (w >= 1 && worsening('weeds'))) {
    add('weed_treatment', 'Weed treatment', worsening('weeds') ? 7 : 12, `Weeds are present${worsening('weeds') ? ' and spreading' : ''} — treat before they seed.`, w >= 3 || worsening('weeds') ? 'high' : 'medium')
  } else if (season === 'spring') {
    add('weed_treatment', 'Weed treatment (pre-emergent)', 21, 'Spring is the window for pre-emergent weed control.', 'low')
  }

  items.sort((a, b) => a.horizon_days - b.horizon_days)
  return { items }
}
