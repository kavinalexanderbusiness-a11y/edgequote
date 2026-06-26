import 'server-only'
import type { SupabaseClient } from '@supabase/supabase-js'
import type { AttributePoint, AttributeRollup, Detection, Observation, Trend, VisionAnalysis } from './types'
import { ordinalRank } from './scales'

// ── AI Vision — observations (the twin's fact log) ────────────────────────────
// Turns one analysis into normalized observation rows (append-only), reads recent
// history back, and rolls history up into per-attribute summaries. This is the
// substrate that makes the twin longitudinal — and the seam future modalities
// (drone, NDVI, inspection notes, weather) write into without any code here
// changing: they just insert rows with a different source_kind/attribute_key.

// A row to insert (analysis-derived). user/property/analysis ids + observed_at
// are stamped by emitObservations.
export interface ObservationInput {
  attribute_key: string
  value_text?: string | null
  value_num?: number | null
  unit?: string | null
  confidence?: number | null
  detail?: Record<string, unknown>
  source_kind?: string   // overrides the batch source (e.g. 'measurement' for lawn_size)
}

function bool(n: boolean): number { return n ? 1 : 0 }

// Map a v2 analysis → the attributes we track over time. Pure; the route adds a
// lawn_size observation (that figure comes from the property, not the model).
export function observationsFromAnalysis(analysis: VisionAnalysis): ObservationInput[] {
  const out: ObservationInput[] = []
  const det = new Map<string, Detection>((analysis.detections || []).map(d => [d.key, d]))

  const pushDet = (key: string) => {
    const d = det.get(key)
    if (!d) return
    out.push({ attribute_key: key, value_text: d.present ? d.coverage : 'none', confidence: d.confidence, detail: { present: d.present, notes: d.notes } })
  }
  // Detections that carry longitudinal meaning.
  ;['weeds', 'overgrowth', 'edging', 'mulch', 'rock', 'mowing_completed', 'trees'].forEach(pushDet)

  const c = analysis.condition
  if (c) {
    out.push({ attribute_key: 'lawn_health', value_text: c.lawn_health, value_num: c.lawn_health_score, unit: 'score' })
    out.push({ attribute_key: 'cut_height', value_text: c.cut_height })
    out.push({ attribute_key: 'mulch_condition', value_text: c.mulch_condition })
    out.push({ attribute_key: 'hedge_condition', value_text: c.hedge_condition })
    out.push({ attribute_key: 'drainage', value_text: c.drainage })
    out.push({ attribute_key: 'irrigation', value_text: c.irrigation })
    out.push({ attribute_key: 'bare_patches', value_num: bool(c.bare_patches) })
    out.push({ attribute_key: 'dead_grass', value_num: bool(c.dead_grass) })
    out.push({ attribute_key: 'new_landscaping', value_num: bool(c.new_landscaping) })
    out.push({ attribute_key: 'trouble_spots', value_num: c.trouble_spots?.length || 0, detail: { spots: c.trouble_spots || [] } })
  }

  const e = analysis.estimates
  if (e) {
    out.push({ attribute_key: 'difficulty', value_text: e.mowing_difficulty, value_num: e.difficulty_score })
    out.push({ attribute_key: 'labour_min', value_num: e.labour_minutes, unit: 'min' })
    out.push({ attribute_key: 'trimming_min', value_num: e.trimming_minutes, unit: 'min' })
    out.push({ attribute_key: 'edging_ft', value_num: e.edging_feet, unit: 'ft' })
  }
  return out
}

// Insert observation rows for one analysis. Best-effort: a failure here never
// fails the analysis (the twin update degrades gracefully).
export async function emitObservations(
  supabase: SupabaseClient,
  params: {
    userId: string
    propertyId: string
    analysisId: string
    observedAt: string
    source: string          // source_kind
    model: string
    rows: ObservationInput[]
  },
): Promise<number> {
  const payload = params.rows.map(r => ({
    user_id: params.userId,
    property_id: params.propertyId,
    analysis_id: params.analysisId,
    observed_at: params.observedAt,
    source_kind: r.source_kind ?? params.source,
    attribute_key: r.attribute_key,
    value_text: r.value_text ?? null,
    value_num: r.value_num ?? null,
    unit: r.unit ?? null,
    confidence: r.confidence ?? null,
    model: params.model,
    detail: r.detail ?? {},
  }))
  if (!payload.length) return 0
  const { error } = await supabase.from('property_observations').insert(payload)
  return error ? 0 : payload.length
}

// Recent observations for a property, newest first (bounded). Powers rollup +
// change + forecast without unbounded scans.
export async function recentObservations(
  supabase: SupabaseClient,
  userId: string,
  propertyId: string,
  limit = 400,
): Promise<Observation[]> {
  const { data } = await supabase
    .from('property_observations')
    .select('observed_at, source_kind, attribute_key, value_text, value_num, unit, confidence, model, detail')
    .eq('user_id', userId)
    .eq('property_id', propertyId)
    .eq('status', 'active')
    .order('observed_at', { ascending: false })
    .limit(limit)
  return (data as Observation[] | null) || []
}

function valueOf(o: Observation): string | number | null {
  return o.value_text != null ? o.value_text : (o.value_num != null ? o.value_num : null)
}

// Compare two readings of the same attribute → a trend direction. Uses the shared
// ordinal scale for categoricals, numeric compare for scores, else equality.
function trendBetween(attribute: string, current: string | number | null, prev: string | number | null): Trend {
  if (prev == null || current == null) return 'unknown'
  const cr = ordinalRank(attribute, current)
  const pr = ordinalRank(attribute, prev)
  if (cr != null && pr != null) {
    if (cr > pr) return 'improving'
    if (cr < pr) return 'worsening'
    return 'stable'
  }
  if (typeof current === 'number' && typeof prev === 'number') {
    // For score-like numerics higher = better; for "load" numerics (labour/edging)
    // we don't call it better/worse — treat any move as stable to avoid false reads.
    if (attribute === 'lawn_health') return current > prev ? 'improving' : current < prev ? 'worsening' : 'stable'
    return 'stable'
  }
  return current === prev ? 'stable' : 'unknown'
}

// Roll the flat log into per-attribute summaries (current + trend + history).
export function rollupAttributes(observations: Observation[]): Record<string, AttributeRollup> {
  const byAttr = new Map<string, Observation[]>()
  for (const o of observations) {
    const arr = byAttr.get(o.attribute_key) || []
    arr.push(o)
    byAttr.set(o.attribute_key, arr)
  }
  const out: Record<string, AttributeRollup> = {}
  for (const [attr, obsAll] of byAttr) {
    // observations come newest-first already; keep a bounded history per attribute.
    const obs = obsAll.slice(0, 24)
    const history: AttributePoint[] = obs.map(o => ({
      value: valueOf(o), observed_at: o.observed_at, source: o.source_kind, confidence: o.confidence ?? null,
    }))
    const current = history[0]?.value ?? null
    // first DIFFERENT prior value → trend (skip identical repeats).
    const priorDifferent = history.slice(1).find(p => p.value !== current)?.value ?? null
    const trend: Trend = history.length <= 1 ? 'new' : trendBetween(attr, current, priorDifferent)
    out[attr] = { current, trend, unit: obs[0]?.unit ?? null, history }
  }
  return out
}
