import 'server-only'
import type { SupabaseClient } from '@supabase/supabase-js'
import type { PropertyIntelligence, PropertyTwin, VisionAnalysis } from './types'
import { emitObservations, observationsFromAnalysis, recentObservations, rollupAttributes } from './observations'
import { detectChanges } from './change'
import { seasonalRecommendations } from './season'
import { buildForecast } from './forecast'
import { loadPurchaseHistory, loadServiceValues } from './purchases'
import { scoreOpportunities } from './opportunities'
import { buildCrm } from './crm'
import { buildMarketing } from './marketing'
import { synthesizeNarrative } from './synthesis'
import { deterministicDigest, getTwin, upsertTwin } from './twin'
import { VISION_PROMPT_VERSION } from './prompt'

// ── AI Vision — the twin orchestrator ─────────────────────────────────────────
// Runs AFTER an analysis is persisted: emits observations, rolls up the history,
// detects change vs the previous analysis, and computes seasonal recs, forecast,
// opportunities, CRM gaps and marketing signals — then materializes the twin. One
// place; the route just calls this. Best-effort: any failure returns the prior
// twin (or null) rather than failing the analysis.

interface OrchestratorProperty {
  id: string
  customer_id: string | null
  lat: number | null
  lng: number | null
  lawn_sqft: number | null
}

async function previousAnalysis(
  supabase: SupabaseClient,
  userId: string,
  propertyId: string,
  excludeId: string,
): Promise<{ analysis: VisionAnalysis | null; createdAt: string | null }> {
  const { data } = await supabase
    .from('property_intelligence')
    .select('id, created_at, analysis')
    .eq('user_id', userId)
    .eq('property_id', propertyId)
    .neq('id', excludeId)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle()
  if (!data) return { analysis: null, createdAt: null }
  const row = data as { created_at: string; analysis: VisionAnalysis }
  return { analysis: row.analysis ?? null, createdAt: row.created_at ?? null }
}

export async function updateTwinAfterAnalysis(
  supabase: SupabaseClient,
  params: {
    userId: string
    property: OrchestratorProperty
    intelligence: PropertyIntelligence
    observedAt: string
    hasBeforeAfter: boolean
    nowIso: string
  },
): Promise<PropertyTwin | null> {
  const { userId, property, intelligence, observedAt, hasBeforeAfter, nowIso } = params
  const analysis = intelligence.analysis
  const customerId = property.customer_id

  try {
    // 1) Emit this run's observations (+ a lawn_size fact from the measurement).
    const obsRows = observationsFromAnalysis(analysis)
    if (property.lawn_sqft != null) obsRows.push({ attribute_key: 'lawn_size', value_num: property.lawn_sqft, unit: 'sqft', source_kind: 'measurement' })
    await emitObservations(supabase, {
      userId, propertyId: property.id, analysisId: intelligence.id,
      observedAt, source: 'vision', model: intelligence.model || VISION_PROMPT_VERSION, rows: obsRows,
    })

    // 2) Roll up the accumulated history.
    const recent = await recentObservations(supabase, userId, property.id)
    const attributes = rollupAttributes(recent)

    // 3) Change vs the previous analysis.
    const prev = await previousAnalysis(supabase, userId, property.id, intelligence.id)
    const change = detectChanges(analysis, prev.analysis, prev.createdAt)

    // 4) Seasonal + forecast (deterministic).
    const seasonal = seasonalRecommendations(nowIso, analysis)
    const forecast = buildForecast({ nowIso, analysis, attributes })

    // 5) Opportunities + CRM (reads purchase history, never edits CRM/pricing).
    const [purchase, values] = await Promise.all([
      loadPurchaseHistory(supabase, userId, customerId),
      loadServiceValues(supabase, userId),
    ])
    const opportunities = scoreOpportunities({ analysis, season: seasonal.season, purchased: purchase.purchased, values, attributes })
    const crm = buildCrm({ purchased: purchase.purchased, hasCustomer: purchase.hasCustomer, opportunities })

    // 6) Marketing signals (reusable, no re-analysis).
    const marketing = buildMarketing({ analysis, change, hasBeforeAfter })

    // 7) Counts + narrative (AI polish, graceful fallback to deterministic).
    const existing = await getTwin(supabase, userId, property.id)
    const analysisCount = (existing?.analysis_count || 0) + 1
    const firstAnalyzedAt = existing?.first_analyzed_at || intelligence.created_at

    const synth = await synthesizeNarrative({
      analysis, change, seasonal, forecast, opportunities, analysisCount, priorDigest: existing?.digest ?? null,
    })
    if (synth) change.narrative = synth.change_narrative
    const digest = synth?.digest || deterministicDigest({ analysisCount, firstAnalyzedAt, analysis, change, forecast, opportunities, seasonal })

    // 8) Materialize the twin.
    return await upsertTwin(supabase, {
      userId, propertyId: property.id, customerId,
      firstAnalyzedAt, lastAnalyzedAt: intelligence.created_at, analysisCount, latestAnalysisId: intelligence.id,
      attributes, change_summary: change, seasonal, forecast, opportunities, marketing, crm,
      digest, model: intelligence.model, promptVersion: VISION_PROMPT_VERSION,
    })
  } catch {
    return getTwin(supabase, userId, property.id).catch(() => null)
  }
}
