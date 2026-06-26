// ── AI Vision — domain types ──────────────────────────────────────────────────
// The shape of a property's AI read. `VisionAnalysis` is what the model returns
// (and what we persist in property_intelligence.analysis); `PropertyIntelligence`
// is the stored row. Everything here is RECOMMENDATIONS ONLY — no field is a price
// and nothing downstream writes a quote/job/invoice from it.

// The 12 ground features the brief asks AI Vision to detect. Stable keys: they are
// the contract every downstream tool (and the denormalised detections[] column)
// reads, so renaming one is a migration, not a rename.
export const FEATURE_KEYS = [
  'mowing_completed',
  'edging',
  'trimming',
  'mulch',
  'rock',
  'weeds',
  'overgrowth',
  'trees',
  'fences',
  'gardens',
  'driveways',
  'obstacles',
] as const
export type FeatureKey = typeof FEATURE_KEYS[number]

// How much of the visible property a feature covers (qualitative — the model
// can't measure area reliably from a photo, so we never ask it to).
export type Coverage = 'none' | 'low' | 'medium' | 'high'

export interface Detection {
  key: FeatureKey
  present: boolean
  confidence: number          // 0-100, this single detection
  coverage: Coverage          // 'none' when present=false
  notes: string               // short, grounded ("thinning mulch along the north bed")
}

// Mowing difficulty band — how hard the lawn is to service (slope, obstacles,
// tight edges, overgrowth), NOT a price tier.
export const DIFFICULTY_LEVELS = ['easy', 'moderate', 'hard', 'severe'] as const
export type Difficulty = typeof DIFFICULTY_LEVELS[number]

export interface Estimates {
  mowing_difficulty: Difficulty
  difficulty_score: number     // 0-100 (easy ≈ 0-25 … severe ≈ 76-100)
  labour_minutes: number       // whole-visit labour, minutes
  trimming_minutes: number     // string-trimming portion, minutes
  edging_feet: number          // linear edging length, feet
  rationale: string            // one sentence on what drove the estimate
}

// An automatically suggested upsell — grounded in a detection, never invented.
export interface Upsell {
  key: string                  // 'mulch_refresh' | 'weed_control' | 'edging' | 'overgrowth_cut' | 'tree_shrub_trim' | 'garden_bed_care' | 'rock_topup' | 'aeration' | 'overseeding' | 'cleanup'
  label: string                // human label ("Mulch refresh")
  reason: string               // why, tied to what was seen
  confidence: number           // 0-100
}

export type ConfidenceBand = 'high' | 'medium' | 'low'

// ── Condition (v2) ────────────────────────────────────────────────────────────
// A richer, longitudinal read beyond mere presence — the raw material the digital
// twin tracks over time (mulch ages, hedges grow, lawns recover). Optional on the
// type so v1 rows (pre-condition) still satisfy it.
export type HealthLevel = 'excellent' | 'good' | 'fair' | 'poor' | 'unknown'
export type CutHeight = 'short' | 'medium' | 'long' | 'unknown'
export type MulchCondition = 'fresh' | 'good' | 'aging' | 'faded' | 'bare' | 'none'
export type HedgeCondition = 'tidy' | 'slightly_overgrown' | 'overgrown' | 'none'
export type DrainageSign = 'none' | 'pooling' | 'erosion' | 'soggy' | 'unknown'
export type IrrigationSign = 'none' | 'sprinklers_visible' | 'dry_stress' | 'over_watered' | 'unknown'

export interface TroubleSpot { location: string; issue: string }

export interface Condition {
  lawn_health: HealthLevel
  lawn_health_score: number          // 0-100
  cut_height: CutHeight
  bare_patches: boolean
  dead_grass: boolean
  new_landscaping: boolean           // visible change/addition since a typical state
  mulch_condition: MulchCondition
  hedge_condition: HedgeCondition
  drainage: DrainageSign
  irrigation: IrrigationSign
  trouble_spots: TroubleSpot[]       // recurring problem areas, located
}

// The full structured read the model returns (and we store verbatim in jsonb).
export interface VisionAnalysis {
  summary: string              // one-paragraph plain-English read of the property
  detections: Detection[]      // one per FEATURE_KEYS
  condition?: Condition        // v2 longitudinal read (optional for legacy v1 rows)
  estimates: Estimates
  upsells: Upsell[]
  confidence: number           // overall 0-100 (the model's own read of how sure it is)
  limitations: string[]        // truthful caveats ("back yard not visible from satellite")
}

// What kind of imagery fed the analysis.
export type IntelSource = 'satellite' | 'photos' | 'combined'

// A persisted property_intelligence row (denormalised headline fields + the full
// analysis blob). Mirrors the migration in supabase/RUN-2026-06-25h-*.sql.
export interface PropertyIntelligence {
  id: string
  created_at: string
  updated_at: string
  user_id: string
  property_id: string
  customer_id: string | null
  job_id: string | null
  source: IntelSource
  image_count: number
  image_signature: string | null
  analysis: VisionAnalysis
  summary: string | null
  detections: FeatureKey[]
  upsell_keys: string[]
  mowing_difficulty: Difficulty | null
  difficulty_score: number | null
  est_labour_min: number | null
  est_trimming_min: number | null
  est_edging_ft: number | null
  confidence: number | null
  confidence_band: ConfidenceBand | null
  model: string | null
  prompt_version: string | null
  status: 'active' | 'superseded' | 'archived'
  inputs?: { kind: string; ref: string | null; captured_at: string | null }[]
  observed_at?: string | null
}

// ── API contract (POST /api/vision/analyze) ───────────────────────────────────
export interface AnalyzeRequest {
  propertyId: string
  photoIds?: string[]        // restrict to specific photos; omit = all property photos
  includeSatellite?: boolean // default true
  jobId?: string | null      // optional: tie the analysis to one visit
  force?: boolean            // re-run even if an identical image set was already analysed
}

export interface AnalyzeResponse {
  ok: boolean
  aiEnabled: boolean
  intelligence?: PropertyIntelligence
  twin?: PropertyTwin        // the updated digital twin (memory + computed intelligence)
  reused?: boolean           // true → served the cached analysis, no model call
  error?: string
}

// ── Digital twin (longitudinal intelligence) ──────────────────────────────────
// One observation in the append-only fact log (property_observations).
export interface Observation {
  id?: string
  observed_at: string
  source_kind: string        // OPEN: vision | drone | inspection_note | weather | ndvi | …
  attribute_key: string      // OPEN: lawn_health | weeds | mulch_condition | …
  value_text: string | null
  value_num: number | null
  unit: string | null
  confidence: number | null
  model: string | null
  detail?: Record<string, unknown>
}

// A point in an attribute's history (newest-first when rolled up on the twin).
export interface AttributePoint {
  value: string | number | null
  observed_at: string
  source: string
  confidence: number | null
}
export type Trend = 'improving' | 'worsening' | 'stable' | 'new' | 'unknown'
export interface AttributeRollup {
  current: string | number | null
  trend: Trend
  unit?: string | null
  history: AttributePoint[]
}

// Change detection (today vs the previous analysis).
export type ChangeDirection = 'up' | 'down' | 'better' | 'worse' | 'new' | 'gone'
export interface ChangeSignal {
  key: string                // 'lawn_healthier' | 'lawn_worse' | 'weeds_increasing' | 'weeds_reduced' | 'mulch_fading' | 'hedge_growth' | 'tree_growth' | 'new_landscaping' | 'dead_grass' | 'bare_patches'
  label: string
  attribute: string
  direction: ChangeDirection
  detail: string
}
export interface ChangeSummary {
  narrative: string          // human paragraph
  signals: ChangeSignal[]
  since: string | null       // ISO date of the analysis we compared against (null = first ever)
  is_first: boolean
}

// Seasonal intelligence.
export type Season = 'spring' | 'summer' | 'fall' | 'winter'
export interface SeasonalRecommendation { key: string; label: string; why: string }
export interface SeasonalBlock {
  season: Season
  recommendations: SeasonalRecommendation[]
}

// Maintenance forecast.
export interface ForecastItem {
  key: string                // 'hedge_trim' | 'mulch_refresh' | 'mowing_frequency_up' | 'weed_treatment' | …
  label: string
  predicted_for: string      // ISO date (best estimate) — when it's likely needed next
  horizon_days: number
  basis: string              // what the prediction is built on
  confidence: ConfidenceBand
}
export interface ForecastBlock { items: ForecastItem[] }

// Opportunity detection (ranked by expected customer value).
export type OppTier = 'high' | 'medium' | 'low'
export interface Opportunity {
  key: string                // service key (mulch_refresh, aeration, hedge_trim, weed_control, …)
  label: string
  tier: OppTier
  score: number              // 0-100 (drives ranking)
  expected_value: number | null  // rough $ if a matching service template exists, else null
  reason: string
  never_purchased: boolean   // customer has never bought this service
}
export interface OpportunityBlock { items: Opportunity[] }

// Marketing integration (reusable — Marketing Studio reads, never re-analyses).
export interface MarketingSummary {
  flags: string[]            // 'fresh_mulch' | 'edging_excellent' | 'dramatic_before_after' | 'beautiful_stripes' | 'large_transformation' | …
  highlights: string[]       // ready-to-use phrases
  summary: string
}

// CRM integration (reusable — never-purchased services + natural recommendations).
export interface CrmBlock {
  never_purchased: string[]  // service keys the customer has never bought
  recommendations: { key: string; label: string; why: string }[]
}

// The materialized digital twin (property_twin row).
export interface PropertyTwin {
  id: string
  created_at: string
  updated_at: string
  user_id: string
  property_id: string
  customer_id: string | null
  first_analyzed_at: string | null
  last_analyzed_at: string | null
  analysis_count: number
  latest_analysis_id: string | null
  attributes: Record<string, AttributeRollup>
  change_summary: ChangeSummary | Record<string, never>
  seasonal: SeasonalBlock | Record<string, never>
  forecast: ForecastBlock | Record<string, never>
  opportunities: OpportunityBlock | Record<string, never>
  marketing: MarketingSummary | Record<string, never>
  crm: CrmBlock | Record<string, never>
  digest: string | null
  model: string | null
  prompt_version: string | null
}

// Overall confidence number → band. Derived in ONE place so the chip, the column
// and any downstream gate agree (we never trust a free-text band from the model).
export function confidenceBand(score: number | null | undefined): ConfidenceBand {
  if (score == null) return 'low'
  if (score >= 75) return 'high'
  if (score >= 50) return 'medium'
  return 'low'
}
