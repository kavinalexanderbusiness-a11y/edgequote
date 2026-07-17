import type { SupabaseClient } from '@supabase/supabase-js'
import { DEFAULT_PRICING, type PricingConfig } from '@/lib/pricing'

// ── ADR-002 · Pricing configuration provenance ───────────────────────────────
// THE one place that answers "which configuration priced this quote?".
//
// WHY THIS EXISTS. A quote's price derived from state that no longer existed.
// `business_settings` is ONE mutable row with ONE `updated_at`, and the base charge
// moved at least three times (~$20-22 in June → $50 from Jul 5-16 → $45 on Jul 17).
// Supply the config that was live at write time and the engine reproduces 95% of
// quotes; supply today's and it reproduces 1 of 46. The engine is deterministic and
// correct — the INPUTS were gone. Every historical quote became unreproducible the
// instant the owner edited a rate, silently.
//
// THE SPLIT (ADR-002). One test decides where a pricing input belongs:
//
//     "Could two quotes written in the SAME SECOND legitimately differ on this?"
//        NO  → configuration  → VERSION it (this file)
//        YES → derived state  → SNAPSHOT it on the quote (value_grade, nearby_count)
//
// Versioning alone cannot work: `valueGrade` is computed from live route context —
// where the jobs happened to be that day — and is unreconstructable later. Snapshotting
// alone cannot work either: a snapshot never records that a change HAPPENED, when, or
// to what, so a rate change on a quiet day leaves no trace at all.
//
// Precedent: `wage_history` already exists. Wages were versioned; prices were not.
//
// ⛔ FORWARD-ONLY. Nothing here backfills. The 55 pre-ADR quotes carry no version and
// read *unknown* forever — `resolveQuoteProvenance` says so out loud rather than
// substituting today's config, which is the false precision this whole exercise
// exists to prevent. July IS ~95% recoverable and June is not; recovering July would
// still be inference, and `source: 'reconstructed'` is the column that would have to
// label it as such.

/** Bumped only when the MEANING of a versioned field changes — never for a value change. */
export const PRICING_ENGINE_VERSION = 'v1'

/** A row of `pricing_config_versions`. Immutable in the database, by trigger. */
export interface PricingConfigVersionRow {
  id: string
  engine_version: string
  source: 'recorded' | 'reconstructed'
  base_charge: number
  mow_rate_per_1000: number
  budget_mult: number
  market_mult: number
  recommended_mult: number
  premium_mult: number
  travel_rate_per_km: number
  crew_cost_per_hour: number
  fee_recovery_percent: number
  payment_fee_strategy: string
}

/** The settings columns that move a stored price. Wider than `PricingSettingsInput`:
 *  fee recovery is baked into `initial_price` at insert, and crew cost drives the
 *  margin the owner is shown while choosing the number. */
export interface VersionableSettings {
  pricing_base_charge?: number | null
  pricing_mow_rate?: number | null
  pricing_recommended_mult?: number | null
  pricing_premium_mult?: number | null
  pricing_travel_rate?: number | null
  crew_cost_per_hour?: number | null
  fee_recovery_percent?: number | null
  payment_fee_strategy?: string | null
}

/** The versioned columns, minus identity. What we compare and what we insert. */
export type VersionedInputs = Omit<PricingConfigVersionRow, 'id' | 'source'>

// `numeric` can arrive as a string over the wire; every read goes through this.
function num(v: unknown, fallback: number): number {
  const n = Number(v)
  return Number.isFinite(n) ? n : fallback
}

// Mirrors lib/pricing's `pos()`: a null or non-positive setting falls back to the code
// default, so a version records what the engine WOULD ACTUALLY HAVE USED rather than
// what the column literally held. Recording the raw column here would make the version
// disagree with the price it is supposed to explain.
function pos(v: unknown, fallback: number): number {
  const n = Number(v)
  return Number.isFinite(n) && n > 0 ? n : fallback
}

/** The config as the engine would build it, from a settings row. */
export function versionedInputsFromSettings(s?: VersionableSettings | null): VersionedInputs {
  return {
    engine_version: PRICING_ENGINE_VERSION,
    base_charge: pos(s?.pricing_base_charge, DEFAULT_PRICING.baseCharge),
    mow_rate_per_1000: pos(s?.pricing_mow_rate, DEFAULT_PRICING.mowRatePer1000),
    // budgetMult/marketMult are NOT settings-backed — they are code constants. That is
    // exactly why they are versioned: a code change moves them silently, and the row
    // records what was in force when the price was struck.
    budget_mult: DEFAULT_PRICING.budgetMult,
    market_mult: DEFAULT_PRICING.marketMult,
    recommended_mult: pos(s?.pricing_recommended_mult, DEFAULT_PRICING.recommendedMult),
    premium_mult: pos(s?.pricing_premium_mult, DEFAULT_PRICING.premiumMult),
    travel_rate_per_km: pos(s?.pricing_travel_rate, DEFAULT_PRICING.travelRatePerKm),
    crew_cost_per_hour: num(s?.crew_cost_per_hour, 40),
    fee_recovery_percent: num(s?.fee_recovery_percent, 3),
    payment_fee_strategy: s?.payment_fee_strategy || 'global_price_increase',
  }
}

/** A version row, read back as the engine's own config object. */
export function pricingConfigFromVersion(v: PricingConfigVersionRow): PricingConfig {
  return {
    baseCharge: num(v.base_charge, DEFAULT_PRICING.baseCharge),
    mowRatePer1000: num(v.mow_rate_per_1000, DEFAULT_PRICING.mowRatePer1000),
    budgetMult: num(v.budget_mult, DEFAULT_PRICING.budgetMult),
    marketMult: num(v.market_mult, DEFAULT_PRICING.marketMult),
    recommendedMult: num(v.recommended_mult, DEFAULT_PRICING.recommendedMult),
    premiumMult: num(v.premium_mult, DEFAULT_PRICING.premiumMult),
    travelRatePerKm: num(v.travel_rate_per_km, DEFAULT_PRICING.travelRatePerKm),
  }
}

const NUMERIC_FIELDS = [
  'base_charge', 'mow_rate_per_1000', 'budget_mult', 'market_mult',
  'recommended_mult', 'premium_mult', 'travel_rate_per_km',
  'crew_cost_per_hour', 'fee_recovery_percent',
] as const

/** Do these describe the same rate card? Numeric-aware, so `45` and `"45.00"` — which
 *  is the same money arriving by two routes — never mint a spurious version. */
export function sameVersionedInputs(a: VersionedInputs, b: VersionedInputs): boolean {
  if (a.engine_version !== b.engine_version) return false
  if (a.payment_fee_strategy !== b.payment_fee_strategy) return false
  return NUMERIC_FIELDS.every(f => Number(a[f]) === Number(b[f]))
}

export type EnsureResult =
  | { ok: true; versionId: string; config: PricingConfig; created: boolean }
  | { ok: false; reason: string }

/**
 * THE seam every pricing writer calls before writing a quote.
 *
 * Returns the version that describes the CURRENT settings — recording a new one first
 * if the owner has changed a rate since the last version was written. Idempotent: no
 * change, no new row.
 *
 * This is deliberately self-healing rather than relying on one hook in the settings
 * form. If a rate is ever changed by a path nobody remembered (a script, a migration,
 * a future screen), the next quote still records a truthful version instead of
 * pointing at a stale one. `valid_from` is then the moment of RECORDING, which is the
 * honest claim — we know the config is in force now; we cannot claim when it started.
 *
 * ⛔ FAIL-CLOSED. On any error this returns `ok: false` and the caller must NOT write
 * an engine-priced quote. A quote whose configuration we cannot state is precisely the
 * row this ADR exists to stop creating — and `quotes_engine_price_needs_config` will
 * refuse it in the database anyway. Better a clear refusal than a silent unknown.
 */
export async function ensureCurrentPricingConfigVersion(
  supabase: SupabaseClient,
  userId: string,
): Promise<EnsureResult> {
  const { data: settings, error: sErr } = await supabase
    .from('business_settings')
    .select('pricing_base_charge, pricing_mow_rate, pricing_recommended_mult, pricing_premium_mult, pricing_travel_rate, crew_cost_per_hour, fee_recovery_percent, payment_fee_strategy')
    .eq('user_id', userId)
    .maybeSingle()
  if (sErr) return { ok: false, reason: sErr.message }

  const want = versionedInputsFromSettings(settings as VersionableSettings | null)

  const { data: latest, error: vErr } = await supabase
    .from('pricing_config_versions')
    .select('*')
    .eq('user_id', userId)
    .order('valid_from', { ascending: false })
    .limit(1)
    .maybeSingle()
  if (vErr) return { ok: false, reason: vErr.message }

  if (latest) {
    const row = latest as PricingConfigVersionRow
    const have = versionedInputsFromRow(row)
    if (sameVersionedInputs(have, want)) {
      return { ok: true, versionId: row.id, config: pricingConfigFromVersion(row), created: false }
    }
  }

  const { data: created, error: cErr } = await supabase
    .from('pricing_config_versions')
    .insert({
      user_id: userId,
      valid_from: new Date().toISOString(),
      source: 'recorded',
      note: latest ? 'Recorded on a settings change detected at write time.' : 'First version recorded for this account.',
      ...want,
    })
    .select('*')
    .single()
  if (cErr || !created) return { ok: false, reason: cErr?.message ?? 'could not record a pricing config version' }

  const row = created as PricingConfigVersionRow
  return { ok: true, versionId: row.id, config: pricingConfigFromVersion(row), created: true }
}

function versionedInputsFromRow(v: PricingConfigVersionRow): VersionedInputs {
  return {
    engine_version: v.engine_version,
    base_charge: Number(v.base_charge),
    mow_rate_per_1000: Number(v.mow_rate_per_1000),
    budget_mult: Number(v.budget_mult),
    market_mult: Number(v.market_mult),
    recommended_mult: Number(v.recommended_mult),
    premium_mult: Number(v.premium_mult),
    travel_rate_per_km: Number(v.travel_rate_per_km),
    crew_cost_per_hour: Number(v.crew_cost_per_hour),
    fee_recovery_percent: Number(v.fee_recovery_percent),
    payment_fee_strategy: v.payment_fee_strategy,
  }
}

// ── Reading provenance back ──────────────────────────────────────────────────
// How a price was derived at all. Not every writer uses the engine: `book_service`
// prices flat from `service_templates.default_rate` and never reads pricing config, so
// recording a config version against it would be a lie. Reuses the vocabulary
// QuoteBuilder already speaks (`type PriceOrigin`).
export type PriceSource = 'engine' | 'template_rate'

export interface QuoteProvenanceInput {
  price_source?: string | null
  pricing_config_version_id?: string | null
  value_grade?: string | null
  nearby_count?: number | null
}

export type QuoteProvenance =
  | {
      known: true
      config: PricingConfig
      versionId: string
      engineVersion: string
      valueGrade: string | null
      nearbyCount: number | null
    }
  | { known: false; reason: 'pre_adr_002' | 'not_engine_priced' | 'version_missing' }

/**
 * THE canonical answer to "what priced this quote?" — or an honest *unknown*.
 *
 * Every consumer (learning, reporting, the quote page's explanation, the PDF) reads
 * this rather than re-deriving. ⛔ It NEVER falls back to the live config: doing that
 * is the exact bug ADR-002 removes, and it would be undetectable from the outside.
 */
export function resolveQuoteProvenance(
  q: QuoteProvenanceInput,
  version: PricingConfigVersionRow | null | undefined,
): QuoteProvenance {
  // Written before ADR-002 landed: the config it used is gone and cannot be recovered.
  if (!q.price_source) return { known: false, reason: 'pre_adr_002' }
  // Priced by something other than the engine — there is no engine config to state.
  if (q.price_source !== 'engine') return { known: false, reason: 'not_engine_priced' }
  if (!q.pricing_config_version_id || !version) return { known: false, reason: 'version_missing' }
  return {
    known: true,
    config: pricingConfigFromVersion(version),
    versionId: version.id,
    engineVersion: version.engine_version,
    valueGrade: q.value_grade ?? null,
    nearbyCount: q.nearby_count ?? null,
  }
}

/** Plain words for why a quote can't be reproduced — so surfaces explain it identically. */
export function provenanceUnknownLabel(reason: 'pre_adr_002' | 'not_engine_priced' | 'version_missing'): string {
  return reason === 'pre_adr_002'
    ? 'This quote was written before pricing settings were versioned, so the rates it used are not recorded.'
    : reason === 'not_engine_priced'
      ? 'This price came from a service template rate, not the pricing engine.'
      : 'The pricing settings for this quote are missing.'
}
