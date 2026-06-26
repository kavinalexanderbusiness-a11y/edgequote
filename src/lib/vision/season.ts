import type { Season, SeasonalBlock, SeasonalRecommendation, VisionAnalysis } from './types'

// ── AI Vision — seasonal intelligence ─────────────────────────────────────────
// Calendar season (northern hemisphere / Calgary) → season-appropriate service
// recommendations, sharpened by what the imagery actually shows. Pure + cheap so
// it runs every analysis with no model call. NOT the lawn/snow service-season
// engine (lib/seasons) — that drives recurrence math; this is the four-season
// framing the brief asks for.

export function seasonForDate(iso: string): Season {
  const m = Number((iso || '').slice(5, 7)) // 1-12
  if (m >= 3 && m <= 5) return 'spring'
  if (m >= 6 && m <= 8) return 'summer'
  if (m >= 9 && m <= 11) return 'fall'
  return 'winter'
}

export const SEASON_LABELS: Record<Season, string> = {
  spring: 'Spring', summer: 'Summer', fall: 'Fall', winter: 'Winter',
}

// Base season menu (the brief's examples), then we keep only what the property
// supports and add condition-driven extras.
const BASE: Record<Season, SeasonalRecommendation[]> = {
  spring: [
    { key: 'spring_cleanup', label: 'Spring cleanup', why: 'Clear winter debris and matting to wake the lawn up.' },
    { key: 'fertilizer', label: 'Fertilizer (spring feed)', why: 'Early feed drives green-up and crowds out weeds.' },
    { key: 'aeration', label: 'Aeration', why: 'Relieve compaction from winter for stronger spring roots.' },
    { key: 'overseeding', label: 'Overseeding', why: 'Thicken thin/winter-damaged turf while soil is cool and moist.' },
  ],
  summer: [
    { key: 'mowing', label: 'Regular mowing', why: 'Peak growth — keep a steady cut to stay ahead.' },
    { key: 'watering', label: 'Watering / irrigation check', why: 'Heat stress shows up fast; confirm coverage.' },
    { key: 'weed_control', label: 'Weed control', why: 'Summer is when weeds run; treat before they seed.' },
  ],
  fall: [
    { key: 'fall_cleanup', label: 'Leaf / fall cleanup', why: 'Leaves left on turf smother and invite disease.' },
    { key: 'fertilizer', label: 'Fall fertilizer', why: 'Fall feed builds roots for a stronger spring.' },
    { key: 'aeration', label: 'Aeration', why: 'Fall aeration sets up winter recovery and spring vigour.' },
  ],
  winter: [
    { key: 'snow_readiness', label: 'Snow readiness', why: 'Confirm access, markers and a removal plan before snowfall.' },
    { key: 'dormant_pruning', label: 'Dormant pruning', why: 'Trees/shrubs prune cleanest while dormant.' },
  ],
}

// Build the season block, filtered + augmented by the current read. We add an
// item only when the property actually has the asset (e.g. don't suggest mulch
// where there are no beds).
export function seasonalRecommendations(iso: string, analysis: VisionAnalysis | null): SeasonalBlock {
  const season = seasonForDate(iso)
  const has = (key: string) => !!analysis?.detections?.find(d => d.key === key && d.present)
  const c = analysis?.condition

  const recs: SeasonalRecommendation[] = []
  for (const r of BASE[season]) {
    // Drop watering when there's no lawn; drop aeration/overseeding when no lawn either.
    if (['watering', 'overseeding', 'aeration', 'mowing'].includes(r.key) && analysis && !has('mowing_completed') && !has('overgrowth')) continue
    recs.push(r)
  }

  // Condition-driven seasonal extras (still season-appropriate).
  if (c) {
    if ((season === 'spring' || season === 'summer') && (c.mulch_condition === 'faded' || c.mulch_condition === 'aging' || c.mulch_condition === 'bare')) {
      recs.unshift({ key: 'mulch_refresh', label: 'Mulch refresh', why: `Mulch is ${c.mulch_condition} — a refresh restores colour and weed suppression.` })
    }
    if (c.hedge_condition === 'overgrown' || c.hedge_condition === 'slightly_overgrown') {
      recs.push({ key: 'hedge_trim', label: 'Hedge / shrub trimming', why: `Hedges look ${c.hedge_condition.replace('_', ' ')}.` })
    }
    if (c.bare_patches || c.dead_grass) {
      recs.push({ key: 'overseeding', label: 'Overseeding / patch repair', why: 'Bare or dead patches are visible — repair before they spread.' })
    }
  }

  // De-dupe by key, keep first occurrence (condition extras win position).
  const seen = new Set<string>()
  const deduped = recs.filter(r => (seen.has(r.key) ? false : (seen.add(r.key), true)))
  return { season, recommendations: deduped }
}
