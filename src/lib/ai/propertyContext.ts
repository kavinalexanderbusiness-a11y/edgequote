import type { SupabaseClient } from '@supabase/supabase-js'

// ── Shared property-intelligence read seam ───────────────────────────────────
// THE single door every AI feature uses to reuse a property's existing analysis
// instead of re-billing the vision model. A property is analysed once per image
// set (AI Vision writes property_intelligence); Marketing Studio, Before/After,
// CRM, Analytics and any future AI tool READ it through here. This file never
// writes and never calls Claude — it only resolves the current cached brain and
// renders it for a prompt.
//
// FAULT-TOLERANT BY DESIGN: returns null/empty when there's no analysis yet OR
// when the property_intelligence table isn't present (migration not applied).
// Callers must degrade gracefully — exactly as they already do when
// ANTHROPIC_API_KEY is absent — so wiring this in changes no behaviour until the
// brain is actually populated.

export interface PropertyIntelligence {
  id: string
  property_id: string
  customer_id: string | null
  job_id: string | null
  source: string
  image_count: number
  image_signature: string | null
  analysis: Record<string, unknown>
  summary: string | null
  detections: string[]
  upsell_keys: string[]
  mowing_difficulty: string | null
  difficulty_score: number | null
  est_labour_min: number | null
  est_trimming_min: number | null
  est_edging_ft: number | null
  confidence: number | null
  confidence_band: string | null
  model: string | null
  prompt_version: string | null
  status: string
  created_at: string
}

const COLUMNS =
  'id,property_id,customer_id,job_id,source,image_count,image_signature,analysis,' +
  'summary,detections,upsell_keys,mowing_difficulty,difficulty_score,est_labour_min,' +
  'est_trimming_min,est_edging_ft,confidence,confidence_band,model,prompt_version,status,created_at'

// The property's CURRENT analysis (the active row, newest first). Call this
// BEFORE any vision/analysis call: if it returns non-null, reuse it.
export async function getPropertyContext(
  supabase: SupabaseClient,
  propertyId: string | null | undefined,
): Promise<PropertyIntelligence | null> {
  if (!propertyId) return null
  try {
    const { data, error } = await supabase
      .from('property_intelligence')
      .select(COLUMNS)
      .eq('property_id', propertyId)
      .eq('status', 'active')
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle()
    if (error || !data) return null
    return data as unknown as PropertyIntelligence
  } catch {
    return null
  }
}

// Batch variant for callers handling several properties at once (e.g. the
// before/after picker ranking up to six pairs). One query, newest-active per
// property. Missing/absent table → empty map.
export async function getPropertyContexts(
  supabase: SupabaseClient,
  propertyIds: Array<string | null | undefined>,
): Promise<Map<string, PropertyIntelligence>> {
  const out = new Map<string, PropertyIntelligence>()
  const ids = Array.from(new Set(propertyIds.filter((x): x is string => !!x)))
  if (!ids.length) return out
  try {
    const { data, error } = await supabase
      .from('property_intelligence')
      .select(COLUMNS)
      .in('property_id', ids)
      .eq('status', 'active')
      .order('created_at', { ascending: false })
    if (error || !data) return out
    for (const row of data as unknown as PropertyIntelligence[]) {
      // ordered newest-first → keep the first seen per property
      if (!out.has(row.property_id)) out.set(row.property_id, row)
    }
    return out
  } catch {
    return out
  }
}

// Render the stored intelligence as a compact, prompt-ready line. Returns '' when
// there's nothing useful, so any prompt that includes it is byte-identical to
// before when no analysis exists — zero behaviour change until Vision populates
// the brain. Keep this SHORT: it's prepended to other prompts.
export function propertyContextBlock(ctx: PropertyIntelligence | null | undefined): string {
  if (!ctx) return ''
  const bits: string[] = []
  if (ctx.summary) bits.push(ctx.summary.trim())
  if (ctx.detections?.length) bits.push(`Features present: ${ctx.detections.slice(0, 8).join(', ')}.`)
  // `mowing_difficulty` is the column Vision writes; the VALUE is a plain
  // easy/moderate/hard rating of working this site. Rendering the column's name into
  // a prompt told every reader the trade was lawn care — so a plumber's quote could
  // come back discussing mowing. The rating is still useful to any trade (it's about
  // access and obstacles), so it's kept and described for what it measures.
  if (ctx.mowing_difficulty) bits.push(`Site difficulty for working here: ${ctx.mowing_difficulty}.`)
  if (!bits.length) return ''
  return `Known property facts (from a prior AI analysis — reuse these, don't re-derive): ${bits.join(' ')}`
}

// Order-independent key for an image set, so a future writer can detect "this
// exact imagery was already analysed" and skip a re-bill. Mirrors the
// image_signature reuse key on property_intelligence.
export function imageSignature(ids: Array<string | null | undefined>): string {
  return ids.filter((x): x is string => !!x).map(String).sort().join('|')
}
