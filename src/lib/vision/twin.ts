import 'server-only'
import type { SupabaseClient } from '@supabase/supabase-js'
import type {
  AttributeRollup, ChangeSummary, CrmBlock, ForecastBlock, MarketingSummary,
  OpportunityBlock, PropertyTwin, SeasonalBlock, VisionAnalysis,
} from './types'
import { SEASON_LABELS } from './season'

// ── AI Vision — the digital twin (read / write) ───────────────────────────────
// One row per property: the materialized, accumulated state. This module just
// reads + upserts it; lib/vision/intelligence computes what goes in.

function rowToTwin(row: Record<string, unknown>): PropertyTwin {
  return {
    id: row.id as string,
    created_at: row.created_at as string,
    updated_at: row.updated_at as string,
    user_id: row.user_id as string,
    property_id: row.property_id as string,
    customer_id: (row.customer_id as string | null) ?? null,
    first_analyzed_at: (row.first_analyzed_at as string | null) ?? null,
    last_analyzed_at: (row.last_analyzed_at as string | null) ?? null,
    analysis_count: (row.analysis_count as number) ?? 0,
    latest_analysis_id: (row.latest_analysis_id as string | null) ?? null,
    attributes: (row.attributes as Record<string, AttributeRollup>) ?? {},
    change_summary: (row.change_summary as ChangeSummary) ?? {},
    seasonal: (row.seasonal as SeasonalBlock) ?? {},
    forecast: (row.forecast as ForecastBlock) ?? {},
    opportunities: (row.opportunities as OpportunityBlock) ?? {},
    marketing: (row.marketing as MarketingSummary) ?? {},
    crm: (row.crm as CrmBlock) ?? {},
    digest: (row.digest as string | null) ?? null,
    model: (row.model as string | null) ?? null,
    prompt_version: (row.prompt_version as string | null) ?? null,
  }
}

export async function getTwin(supabase: SupabaseClient, userId: string, propertyId: string): Promise<PropertyTwin | null> {
  const { data } = await supabase
    .from('property_twin')
    .select('*')
    .eq('user_id', userId)
    .eq('property_id', propertyId)
    .maybeSingle()
  return data ? rowToTwin(data as Record<string, unknown>) : null
}

export interface UpsertTwinParams {
  userId: string
  propertyId: string
  customerId: string | null
  firstAnalyzedAt: string
  lastAnalyzedAt: string
  analysisCount: number
  latestAnalysisId: string
  attributes: Record<string, AttributeRollup>
  change_summary: ChangeSummary
  seasonal: SeasonalBlock
  forecast: ForecastBlock
  opportunities: OpportunityBlock
  marketing: MarketingSummary
  crm: CrmBlock
  digest: string
  model: string | null
  promptVersion: string
}

export async function upsertTwin(supabase: SupabaseClient, p: UpsertTwinParams): Promise<PropertyTwin | null> {
  const row = {
    user_id: p.userId,
    property_id: p.propertyId,
    customer_id: p.customerId,
    first_analyzed_at: p.firstAnalyzedAt,
    last_analyzed_at: p.lastAnalyzedAt,
    analysis_count: p.analysisCount,
    latest_analysis_id: p.latestAnalysisId,
    attributes: p.attributes,
    change_summary: p.change_summary,
    seasonal: p.seasonal,
    forecast: p.forecast,
    opportunities: p.opportunities,
    marketing: p.marketing,
    crm: p.crm,
    digest: p.digest,
    model: p.model,
    prompt_version: p.promptVersion,
  }
  const { data, error } = await supabase
    .from('property_twin')
    .upsert(row, { onConflict: 'user_id,property_id' })
    .select('*')
    .single()
  if (error || !data) return null
  return rowToTwin(data as Record<string, unknown>)
}

// A deterministic one-paragraph "state of this property" — the fallback when AI
// synthesis is off, and the seed the AI polishes when it's on.
export function deterministicDigest(opts: {
  analysisCount: number
  firstAnalyzedAt: string
  analysis: VisionAnalysis
  change: ChangeSummary
  forecast: ForecastBlock
  opportunities: OpportunityBlock
  seasonal: SeasonalBlock
}): string {
  const { analysisCount, firstAnalyzedAt, analysis, change, forecast, opportunities, seasonal } = opts
  const parts: string[] = []
  parts.push(analysisCount <= 1
    ? 'First analysis on file — the baseline for this property.'
    : `Analyzed ${analysisCount} times since ${firstAnalyzedAt.slice(0, 10)}.`)
  const c = analysis.condition
  if (c) parts.push(`Currently: ${c.lawn_health} turf${c.mulch_condition !== 'none' ? `, ${c.mulch_condition} mulch` : ''}${c.hedge_condition !== 'none' ? `, ${c.hedge_condition.replace('_', ' ')} hedges` : ''}.`)
  if (!change.is_first && change.signals.length) parts.push(`Since last time: ${change.signals.map(s => s.label.toLowerCase()).join(', ')}.`)
  const nextF = forecast.items[0]
  if (nextF) parts.push(`Next likely need: ${nextF.label} (~${nextF.predicted_for}).`)
  const topO = opportunities.items[0]
  if (topO) parts.push(`Top opportunity: ${topO.label} (${topO.tier}).`)
  parts.push(`${SEASON_LABELS[seasonal.season]} focus: ${(seasonal.recommendations[0]?.label) || 'steady maintenance'}.`)
  return parts.join(' ')
}
