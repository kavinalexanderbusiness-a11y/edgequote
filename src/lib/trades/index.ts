import type { TradePack } from './types'
import { LAWN_PACK } from './lawn'
import { NEUTRAL_PACK } from './neutral'
import { CATALOG_PACKS } from './catalog'

// ── THE trade registry ────────────────────────────────────────────────────────
// Every trade EdgeQuote knows how to seed. Code-defined on purpose — the same
// call lib/automation/rules.ts made for automation rules: inventing a trade
// should be a reviewed change, not a row someone can type. Adding one is a pack
// file + a registry line + CI green; it must never need a migration, because
// business_type's DB constraint checks FORMAT only and unknown keys land on the
// neutral pack.
//
// Order here is picker order: the founding trade first, then the named trades
// alphabetically, "General field service" last as the catch-all.

export type { TradePack, TradeService, TradeSeason, TradeSeasonalCampaign, TradePricingDisplay } from './types'
export { LAWN_PACK } from './lawn'
export { NEUTRAL_PACK } from './neutral'

/** What business_settings.business_type defaults to — the founding trade. */
export const DEFAULT_BUSINESS_TYPE = 'lawn_landscaping'

export const TRADE_PACKS: TradePack[] = [
  LAWN_PACK,
  ...CATALOG_PACKS,
  NEUTRAL_PACK,
]

const BY_KEY: Record<string, TradePack> = Object.fromEntries(TRADE_PACKS.map(p => [p.key, p]))

/** The pack for a business_type. Unknown, empty or missing → the neutral pack —
 *  fails safe, never to lawn copy and never to a crash. */
export function tradePack(key: string | null | undefined): TradePack {
  return (key && BY_KEY[key]) || NEUTRAL_PACK
}
