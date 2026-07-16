// ── Trade packs — the vertical foundation's data layer ───────────────────────
// A TradePack is what `business_settings.business_type` selects: the seed data
// and default copy that make a NEW business useful on day one. It is DATA and
// nothing else.
//
// THE RULE (enforced by scripts/verify-trades.ts, run in CI): no engine —
// pricing, scheduling, dispatch, automation, routing, invoicing, reporting,
// AI — may import lib/trades, and lib/trades may import NOTHING outside itself.
// A pack can only reach the product through what it SEEDS (service_templates
// rows, service_seasons jsonb, enabled_modules), which the owner then owns
// outright. Engines read owner config; they never know the trade exists.
//
// The shapes below deliberately MIRROR their destinations rather than importing
// them, so this module stays import-free:
//   TradeService          → public.service_templates columns
//   TradeSeason           → the ServiceSeason shape lib/seasons.ts accepts
//                           (+ label/match, which Phase 3 makes it accept)
//   TradeSeasonalCampaign → SeasonalTemplate in lib/crm/campaigns.ts
// CI deep-equals the lawn pack's copies against the live engine constants, so
// mirror-drift fails the build instead of shipping.

/** Mirrors the service_templates.pricing_display_type CHECK constraint. */
export type TradePricingDisplay =
  | 'starting_from'
  | 'hourly'
  | 'per_sqft'
  | 'per_linear_ft'
  | 'starting_from_materials'
  | 'hourly_materials'

/** One row of a starter catalogue → seeds public.service_templates. */
export interface TradeService {
  name: string
  category: string
  /** CAD. Interpreted by pricing_display_type (an hourly rate vs a job floor). */
  default_rate: number
  pricing_display_type: TradePricingDisplay
  default_description?: string
}

/** A recurring season window → seeds business_settings.service_seasons.
 *  `match` is the service-name keywords that map a service into this season —
 *  the same idea as lib/seasons.ts' hardcoded hints, expressed as data. */
export interface TradeSeason {
  label: string
  match: string[]
  startMonth: number // 1-12
  startDay: number   // 1-31
  endMonth: number
  endDay: number
}

/** A ready-made yearly campaign → offered as a preset in the campaign studio.
 *  Structurally identical to lib/crm/campaigns.ts' SeasonalTemplate. */
export interface TradeSeasonalCampaign {
  key: string
  label: string
  blurb: string
  month: number
  day: number
  subject: string
  body: string
  channels: string[]
}

export interface TradePack {
  /** Stable id stored in business_settings.business_type. Never rename. */
  key: string
  /** Picker label — what the owner chooses at setup. */
  label: string
  /** One-liner under the label in the picker. */
  blurb: string
  /** Starter catalogue. Seeded ONCE, only into an empty catalogue. */
  services: TradeService[]
  /** Season windows, keyed like service_seasons jsonb. Insertion order is match
   *  precedence (see lawn.ts: snow before lawn, mirroring the engine). Empty =
   *  year-round trade until the owner says otherwise. */
  seasons: Record<string, TradeSeason>
  /** Campaign-studio presets. Empty = fall back to the neutral pack's. */
  seasonalCampaigns: TradeSeasonalCampaign[]
  /** Suggested business_settings.enabled_modules (registry: lib/modules.ts).
   *  Undefined = suggest nothing → the business sees every module, today's
   *  behaviour. Deliberately unpopulated in Phase 2 — the seam exists, the
   *  opinions come later. */
  modules?: string[]
}
