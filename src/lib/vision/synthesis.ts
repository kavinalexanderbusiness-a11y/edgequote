import 'server-only'
import { generateStructured, type JsonSchema } from '@/lib/ai/anthropic'
import type { ChangeSummary, ForecastBlock, OpportunityBlock, SeasonalBlock, VisionAnalysis } from './types'
import { SEASON_LABELS } from './season'

// ── AI Vision — narrative synthesis (text gateway) ────────────────────────────
// The deterministic engines decide WHAT is true (change signals, forecasts,
// opportunities); this optional pass just writes the human PROSE. It reuses the
// existing TEXT gateway (lib/ai/anthropic) with the structured findings — no
// images, no re-analysis. Graceful: returns null when AI is off or errors, and
// the caller falls back to the deterministic narrative/digest.

export interface SynthOut { change_narrative: string; digest: string }

const SCHEMA: JsonSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['change_narrative', 'digest'],
  properties: {
    change_narrative: { type: 'string', description: '1-2 sentences: what changed since last time, owner-facing. If first analysis, say it sets the baseline.' },
    digest: { type: 'string', description: '2-3 sentences: the living "state of this property" — condition, trajectory, and the single most valuable next move.' },
  },
}

const SYSTEM = `You are a property-care intelligence analyst writing for the business owner. You are handed DETERMINISTIC findings about one property over time. Write concise, concrete, plain prose. Use ONLY the findings — never invent conditions, dates, prices, or services. No fluff, no buzzwords. Return only through the tool.`

export async function synthesizeNarrative(opts: {
  analysis: VisionAnalysis
  change: ChangeSummary
  seasonal: SeasonalBlock
  forecast: ForecastBlock
  opportunities: OpportunityBlock
  analysisCount: number
  priorDigest: string | null
}): Promise<SynthOut | null> {
  const { analysis, change, seasonal, forecast, opportunities, analysisCount, priorDigest } = opts
  const c = analysis.condition
  const lines: string[] = []
  lines.push(`Analyses on file: ${analysisCount}.`)
  if (priorDigest) lines.push(`Previous digest: ${priorDigest}`)
  if (c) lines.push(`Condition now: lawn ${c.lawn_health}, mulch ${c.mulch_condition}, hedges ${c.hedge_condition}, ${c.bare_patches ? 'bare patches present, ' : ''}${c.dead_grass ? 'dead grass present, ' : ''}drainage ${c.drainage}.`)
  lines.push(change.is_first
    ? 'This is the first analysis (baseline).'
    : `Change signals since last time: ${change.signals.length ? change.signals.map(s => `${s.label} (${s.detail})`).join('; ') : 'none — holding steady'}.`)
  lines.push(`Season: ${SEASON_LABELS[seasonal.season]}. Seasonal recs: ${seasonal.recommendations.map(r => r.label).join(', ') || 'none'}.`)
  if (forecast.items.length) lines.push(`Forecast: ${forecast.items.map(f => `${f.label} ~${f.predicted_for}`).join('; ')}.`)
  if (opportunities.items.length) lines.push(`Opportunities (ranked): ${opportunities.items.map(o => `${o.label} [${o.tier}${o.never_purchased ? ', never bought' : ''}]`).join('; ')}.`)

  const result = await generateStructured<SynthOut>({
    system: SYSTEM,
    prompt: ['Write the change summary and digest for this property from these findings:', '', ...lines].join('\n'),
    toolName: 'write_summary',
    toolDescription: 'Provide the owner-facing change narrative and property digest.',
    schema: SCHEMA,
    maxTokens: 600,
  })
  if (!result.ok) return null
  const out = result.data
  if (!out || typeof out.change_narrative !== 'string' || typeof out.digest !== 'string') return null
  return out
}
