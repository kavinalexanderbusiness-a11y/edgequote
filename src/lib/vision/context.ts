import 'server-only'
import type { SupabaseClient } from '@supabase/supabase-js'
import { latestForProperty } from './data'
import { getTwin } from './twin'
import { confidenceBand, type CrmBlock, type MarketingSummary, type PropertyIntelligence, type PropertyTwin } from './types'
import { DIFFICULTY_LABELS, FEATURE_LABELS } from './labels'

// ── AI Vision — reusable context for OTHER AI tools & systems ─────────────────
// The payoff of the digital twin: any future AI feature (a quote assistant, the
// marketing writer, a coach) or system (Marketing Studio, CRM) reads from HERE
// and inherits the accumulated read INSTEAD OF re-analysing imagery. Everything
// is plain data / text, grounded, and contains no prices.
//
// Seams exposed:
//   getPropertyContext()            → prompt block for any AI tool (twin-aware)
//   getPropertyMarketingSummary()   → Marketing Studio: fresh mulch / great edging / before-after …
//   getPropertyCrmRecommendations() → CRM: never-purchased services + natural recs
//   getPropertyTwin()               → the whole digital twin

function fmtDate(iso: string): string { return (iso || '').slice(0, 10) }

// Compact prompt block from a SINGLE analysis (kept for callers without a twin).
export function propertyContextBlock(intel: PropertyIntelligence | null): string | null {
  if (!intel || !intel.analysis) return null
  const a = intel.analysis
  const band = intel.confidence_band || confidenceBand(intel.confidence)
  const present = (a.detections || []).filter(d => d.present)
  const conditions = present.filter(d => ['weeds', 'overgrowth', 'obstacles'].includes(d.key))
  const lines: string[] = []
  lines.push(`AI VISION READ of this property (source: ${intel.source}, ${intel.image_count} image(s), as of ${fmtDate(intel.created_at)}; confidence ${Math.round(intel.confidence ?? 0)}/100 — ${band}):`)
  if (a.summary) lines.push(a.summary)
  if (present.length) lines.push('On the ground: ' + present.map(d => `${FEATURE_LABELS[d.key]}${d.coverage && d.coverage !== 'none' ? ` (${d.coverage})` : ''}`).join(', ') + '.')
  if (conditions.length) lines.push('Conditions: ' + conditions.map(d => `${FEATURE_LABELS[d.key]}${d.notes ? ` — ${d.notes}` : ''}`).join('; ') + '.')
  if (a.estimates) {
    const e = a.estimates
    lines.push(`Field estimates (rough, NOT prices): mowing difficulty ${DIFFICULTY_LABELS[e.mowing_difficulty]} (${Math.round(e.difficulty_score)}/100); ~${Math.round(e.labour_minutes)} min on site; ~${Math.round(e.trimming_minutes)} min trimming; ~${Math.round(e.edging_feet)} ft edging.`)
  }
  if (a.upsells?.length) lines.push('Upsell ideas (recommendations only): ' + a.upsells.map(u => u.label).join(', ') + '.')
  if (a.limitations?.length) lines.push('Not assessed: ' + a.limitations.join('; ') + '.')
  return lines.join('\n')
}

// The RICH, history-aware block — built from the digital twin. This is what most
// downstream tools should use: it carries memory, trajectory and ranked moves.
export function twinContextBlock(twin: PropertyTwin | null): string | null {
  if (!twin) return null
  const lines: string[] = []
  lines.push(`PROPERTY INTELLIGENCE (digital twin · ${twin.analysis_count} analysis${twin.analysis_count === 1 ? '' : 'es'} · updated ${fmtDate(twin.last_analyzed_at || twin.updated_at)}):`)
  if (twin.digest) lines.push(twin.digest)

  // Memory snapshot (a few key tracked attributes + trend).
  const attr = twin.attributes || {}
  const mem: string[] = []
  const show = (key: string, label: string) => {
    const r = attr[key]; if (r && r.current != null) mem.push(`${label} ${r.current}${r.trend && r.trend !== 'stable' && r.trend !== 'new' ? ` (${r.trend})` : ''}`)
  }
  show('lawn_size', 'lawn'); show('lawn_health', 'turf'); show('mulch_condition', 'mulch'); show('hedge_condition', 'hedges'); show('weeds', 'weeds')
  if (mem.length) lines.push('Memory: ' + mem.join('; ') + '.')

  const change = 'narrative' in twin.change_summary ? twin.change_summary : null
  if (change?.narrative) lines.push('Latest change: ' + change.narrative)

  const forecast = 'items' in twin.forecast ? twin.forecast : null
  if (forecast?.items?.length) lines.push('Forecast: ' + forecast.items.slice(0, 4).map(f => `${f.label} ~${f.predicted_for}`).join('; ') + '.')

  const opps = 'items' in twin.opportunities ? twin.opportunities : null
  if (opps?.items?.length) lines.push('Opportunities (ranked): ' + opps.items.slice(0, 5).map(o => `${o.label} [${o.tier}${o.never_purchased ? ', never bought' : ''}]`).join('; ') + '.')

  const mkt = 'highlights' in twin.marketing ? twin.marketing : null
  if (mkt?.highlights?.length) lines.push('Marketing angles: ' + mkt.highlights.join('; ') + '.')

  return lines.join('\n')
}

// The function future AI tools should call: richest available context for a
// property (twin first, single-analysis fallback), or null if nothing yet.
export async function getPropertyContext(supabase: SupabaseClient, userId: string, propertyId: string): Promise<string | null> {
  const twin = await getTwin(supabase, userId, propertyId)
  const block = twinContextBlock(twin)
  if (block) return block
  const intel = await latestForProperty(supabase, userId, propertyId)
  return propertyContextBlock(intel)
}

// The whole twin (for callers that want structured data, not a prompt block).
export async function getPropertyTwin(supabase: SupabaseClient, userId: string, propertyId: string): Promise<PropertyTwin | null> {
  return getTwin(supabase, userId, propertyId)
}

// ── Marketing integration seam (priority 7) ───────────────────────────────────
// Marketing Studio reads THIS to know "fresh mulch / excellent edging / dramatic
// before-after" without analysing images again. null = nothing analysed yet.
export async function getPropertyMarketingSummary(supabase: SupabaseClient, userId: string, propertyId: string): Promise<MarketingSummary | null> {
  const twin = await getTwin(supabase, userId, propertyId)
  if (twin && 'highlights' in twin.marketing) return twin.marketing as MarketingSummary
  return null
}

// ── CRM integration seam (priority 8) ─────────────────────────────────────────
// CRM reads THIS for never-purchased services + property-grounded recommendations.
export async function getPropertyCrmRecommendations(supabase: SupabaseClient, userId: string, propertyId: string): Promise<CrmBlock | null> {
  const twin = await getTwin(supabase, userId, propertyId)
  if (twin && 'never_purchased' in twin.crm) return twin.crm as CrmBlock
  return null
}
