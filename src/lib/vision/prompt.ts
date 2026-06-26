import type { JsonSchema } from '@/lib/ai/anthropic'
import { DIFFICULTY_LEVELS, FEATURE_KEYS } from './types'

// ── AI Vision — analysis prompt builder ───────────────────────────────────────
// Assembles the system prompt (stable estimator persona + hard rules) and the
// per-property user prompt, plus the strict tool schema the model must fill. The
// model only ever sees the images + facts the app already holds, and is told NOT
// to invent measurements or set prices — its job is a grounded read + rough field
// estimates + upsell ideas, RECOMMENDATIONS ONLY.

export const VISION_PROMPT_VERSION = 'vision-property-v2'

// Facts the model may lean on (alongside the images). Kept tiny + truthful.
export interface PropertyFacts {
  address?: string | null
  neighborhood?: string | null
  city?: string | null
  lawnSqft?: number | null       // measured lawn area, if EdgeQuote already has it
  serviceType?: string | null    // the kind of work usually done here, if known
  imageLabels: string[]          // what each attached image is (same order as sent)
}

const SYSTEM = `You are an expert grounds-care estimator for a local property-maintenance business (lawn care, landscaping). You look at aerial/satellite imagery and ground-level before/after photos of ONE property and produce a precise, honest read the owner can act on.

Hard rules:
- Report ONLY what is actually visible in the supplied images. Never invent features, conditions, measurements, or anything off-frame. If something can't be seen, say so in "limitations" and lower your confidence.
- You are NOT pricing anything. Never output a dollar amount, rate, or quote. Your estimates are rough FIELD estimates (minutes, feet, a difficulty band) to help the owner plan — not prices.
- Estimates are approximate. Anchor mowing/labour to the visible lawn footprint and the measured lawn size when given; keep numbers realistic for a 1–3 person crew. Edging length is the linear feet of hard edges (driveway/walkway/bed borders) you can actually see.
- Detect every one of the requested features. For each, say whether it is present, how confident you are, how much of the visible area it covers, and a short grounded note. Set present=false (coverage "none") for anything you don't see.
- Suggest upsells ONLY when a detection supports them (e.g. visible weeds → weed control; thin/faded mulch → mulch refresh; missing crisp edges → edging; heavy overgrowth → an overgrowth cut; overhanging trees → tree/shrub trimming). Tie every suggestion to what you saw. No suggestion is a commitment or a price.
- A satellite view is top-down and can be months old; ground photos are current but partial. Weigh them accordingly and reflect any conflict honestly in your confidence and limitations.
- Return your answer ONLY through the provided tool.`

// The strict tool schema = our VisionAnalysis shape. additionalProperties:false +
// required on every object so `strict` validates and the model can't drift.
export function buildVisionSchema(): JsonSchema {
  return {
    type: 'object',
    additionalProperties: false,
    required: ['summary', 'detections', 'condition', 'estimates', 'upsells', 'confidence', 'limitations'],
    properties: {
      summary: { type: 'string', description: 'One short paragraph: a plain-English read of this property and its condition, as an owner would describe it.' },
      condition: {
        type: 'object',
        additionalProperties: false,
        description: 'A deeper read of CONDITION (tracked over time). Use "unknown"/false when it cannot be judged from the imagery.',
        required: ['lawn_health', 'lawn_health_score', 'cut_height', 'bare_patches', 'dead_grass', 'new_landscaping', 'mulch_condition', 'hedge_condition', 'drainage', 'irrigation', 'trouble_spots'],
        properties: {
          lawn_health: { type: 'string', enum: ['excellent', 'good', 'fair', 'poor', 'unknown'], description: 'Overall turf health (colour, density, uniformity).' },
          lawn_health_score: { type: 'number', description: '0-100 turf health (poor ~0-40, fair ~41-60, good ~61-85, excellent ~86-100).' },
          cut_height: { type: 'string', enum: ['short', 'medium', 'long', 'unknown'], description: 'Apparent mowing height.' },
          bare_patches: { type: 'boolean', description: 'Visible bare/thin soil patches.' },
          dead_grass: { type: 'boolean', description: 'Visible dead/brown-out areas.' },
          new_landscaping: { type: 'boolean', description: 'Visible newly added or changed landscaping (new beds, sod, hardscape, plantings).' },
          mulch_condition: { type: 'string', enum: ['fresh', 'good', 'aging', 'faded', 'bare', 'none'], description: 'Freshness of mulch (drives mulch-age tracking). "none" if no mulch beds.' },
          hedge_condition: { type: 'string', enum: ['tidy', 'slightly_overgrown', 'overgrown', 'none'], description: 'Hedge/shrub tidiness (drives pruning forecast). "none" if no hedges.' },
          drainage: { type: 'string', enum: ['none', 'pooling', 'erosion', 'soggy', 'unknown'], description: 'Any visible drainage problem.' },
          irrigation: { type: 'string', enum: ['none', 'sprinklers_visible', 'dry_stress', 'over_watered', 'unknown'], description: 'Any irrigation/watering signal.' },
          trouble_spots: {
            type: 'array',
            description: 'Specific recurring problem areas, each located. Empty array if none.',
            items: {
              type: 'object',
              additionalProperties: false,
              required: ['location', 'issue'],
              properties: {
                location: { type: 'string', description: 'Where ("north bed", "front-right corner").' },
                issue: { type: 'string', description: 'What ("standing water", "thinning turf").' },
              },
            },
          },
        },
      },
      detections: {
        type: 'array',
        description: `Return exactly one entry for EACH of these ${FEATURE_KEYS.length} features, in this order: ${FEATURE_KEYS.join(', ')}.`,
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['key', 'present', 'confidence', 'coverage', 'notes'],
          properties: {
            key: { type: 'string', enum: [...FEATURE_KEYS] },
            present: { type: 'boolean', description: 'Is this feature visible in the imagery?' },
            confidence: { type: 'number', description: '0-100, how sure you are about THIS feature.' },
            coverage: { type: 'string', enum: ['none', 'low', 'medium', 'high'], description: 'How much of the visible property it covers ("none" when present is false).' },
            notes: { type: 'string', description: 'Short, grounded note. Empty string if nothing to add.' },
          },
        },
      },
      estimates: {
        type: 'object',
        additionalProperties: false,
        required: ['mowing_difficulty', 'difficulty_score', 'labour_minutes', 'trimming_minutes', 'edging_feet', 'rationale'],
        properties: {
          mowing_difficulty: { type: 'string', enum: [...DIFFICULTY_LEVELS], description: 'How hard the lawn is to mow/service (slope, obstacles, tight edges, overgrowth) — NOT a price tier.' },
          difficulty_score: { type: 'number', description: '0-100 difficulty (easy ~0-25, moderate ~26-50, hard ~51-75, severe ~76-100).' },
          labour_minutes: { type: 'number', description: 'Rough whole-visit labour estimate in minutes for a typical crew.' },
          trimming_minutes: { type: 'number', description: 'Rough string-trimming portion in minutes.' },
          edging_feet: { type: 'number', description: 'Approximate linear feet of hard edges to edge.' },
          rationale: { type: 'string', description: 'One sentence on what drove these numbers.' },
        },
      },
      upsells: {
        type: 'array',
        description: 'Upsell ideas grounded in the detections above (0-6). Empty array if nothing is warranted.',
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['key', 'label', 'reason', 'confidence'],
          properties: {
            key: { type: 'string', description: 'Stable snake_case key, e.g. mulch_refresh, weed_control, edging, overgrowth_cut, tree_shrub_trim, garden_bed_care, rock_topup, aeration, overseeding, cleanup.' },
            label: { type: 'string', description: 'Short human label, e.g. "Mulch refresh".' },
            reason: { type: 'string', description: 'Why — tied to what was seen.' },
            confidence: { type: 'number', description: '0-100.' },
          },
        },
      },
      confidence: { type: 'number', description: 'Overall 0-100: how much the owner should trust this whole analysis, given image quality, coverage and any conflicts.' },
      limitations: {
        type: 'array',
        description: 'Honest caveats — what you could NOT see or assess (e.g. "back yard not visible from satellite", "image too dark to judge weeds").',
        items: { type: 'string' },
      },
    },
  }
}

export function buildAnalysisPrompt(facts: PropertyFacts): {
  system: string; prompt: string; schema: JsonSchema; toolName: string; toolDescription: string
} {
  const lines: string[] = ['Analyze this single property from the attached imagery.', '']

  const ctx: string[] = []
  if (facts.address) ctx.push(`Address: ${facts.address}`)
  if (facts.neighborhood) ctx.push(`Neighbourhood: ${facts.neighborhood}`)
  else if (facts.city) ctx.push(`Area: ${facts.city}`)
  if (facts.lawnSqft) ctx.push(`Measured lawn size on file: about ${Math.round(facts.lawnSqft).toLocaleString()} sq ft (anchor your mowing/labour estimate to this).`)
  if (facts.serviceType) ctx.push(`Service usually done here: ${facts.serviceType}`)
  if (ctx.length) { lines.push('PROPERTY ON FILE:', ...ctx, '') }

  lines.push('ATTACHED IMAGES (in order):', ...facts.imageLabels.map((l, i) => `  ${i + 1}. ${l}`), '')
  lines.push(
    'Do all of this:',
    '1. Detect each requested feature (mowing completed, edging, trimming, mulch, rock, weeds, overgrowth, trees, fences, gardens, driveways, obstacles).',
    '2. Read CONDITION (lawn health, cut height, bare/dead patches, mulch freshness, hedge tidiness, drainage, irrigation, new landscaping, located trouble spots) — this is tracked over time, so be consistent and concrete.',
    '3. Estimate mowing difficulty, whole-visit labour minutes, trimming minutes, and edging feet.',
    '4. Suggest upsells that the detections support — recommendations only.',
    '5. Give an overall confidence score and list what you could not see.',
  )

  return {
    system: SYSTEM,
    prompt: lines.join('\n'),
    schema: buildVisionSchema(),
    toolName: 'report_property',
    toolDescription: 'Return the full structured property analysis for the owner to review (recommendations only — no prices).',
  }
}
