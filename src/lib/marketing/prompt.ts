import type { JsonSchema } from '@/lib/ai/anthropic'
import { channel as channelDef } from './channels'
import { brandVoicePromptBlock, type BrandVoice } from './brandVoice'
import type { MarketingCandidate, MarketingChannel } from './types'

// ── Prompt builder ──────────────────────────────────────────────────────────────
// Assembles the system prompt (stable brand voice + rules) and the per-job user
// prompt for ONE channel, plus the strict tool schema the model must fill. The AI
// only ever sees facts the app already holds — it is told NOT to invent details,
// so a generated post can't promise a service or price that wasn't performed.

export const PROMPT_VERSION = 'studio-organic-v1'

const SYSTEM = `You are an expert social media copywriter for a local property-care business (lawn care, landscaping, snow removal). You write posts the business owner can publish as-is.

Rules:
- Write ONLY from the facts provided. Never invent prices, guarantees, services, dates, or customer names that weren't given. If a detail isn't provided, leave it out.
- Sound like a real local owner-operator, not a marketing agency. Warm, confident, specific. No corporate buzzwords ("synergy", "elevate", "unlock"), no clickbait.
- Make the neighbourhood and the actual work concrete when given — that's what makes a local post land.
- A light, natural call to action (message us / book a quote) is good; don't be pushy.
- Match the requested platform's style and length. Respect whether hashtags are wanted.
- Return your answer ONLY through the provided tool.`

export function buildGenerateInput(
  candidate: MarketingCandidate,
  ch: MarketingChannel,
  voice: BrandVoice,
): { system: string; prompt: string; schema: JsonSchema; toolName: string; toolDescription: string } {
  const def = channelDef(ch)

  // ── The facts the model may use (and nothing else). ──
  const facts: string[] = []
  facts.push(`Service performed: ${candidate.serviceType || 'property maintenance'}`)
  if (candidate.neighborhood) facts.push(`Neighbourhood: ${candidate.neighborhood}`)
  else if (candidate.city) facts.push(`Area: ${candidate.city}`)
  if (candidate.season) facts.push(`Season: ${candidate.season}`)
  if (candidate.lawnSqft) facts.push(`Lawn size: about ${Math.round(candidate.lawnSqft).toLocaleString()} sq ft`)
  if (candidate.hasBefore && candidate.hasAfter) facts.push('We have a before-and-after photo pair to attach.')
  else if (candidate.hasAfter) facts.push('We have a finished "after" photo to attach.')
  if (candidate.hasReview) facts.push('This customer was happy and left us a review.')

  const properties: Record<string, unknown> = {
    body: { type: 'string', description: `The post text for ${def.label}. Aim for roughly ${def.maxChars} characters or fewer.` },
    hashtags: {
      type: 'array',
      items: { type: 'string' },
      description: def.usesHashtags
        ? 'Up to 6 relevant hashtags WITHOUT the # symbol (e.g. "lawncare"). Local + service oriented.'
        : 'Leave this empty — this platform does not use hashtags.',
    },
  }
  const required = ['body', 'hashtags']
  if (def.usesTitle) {
    properties.title = { type: 'string', description: 'A short headline (under 60 characters).' }
    required.push('title')
  }

  const schema: JsonSchema = {
    type: 'object',
    additionalProperties: false,
    properties,
    required,
  }

  const prompt = [
    `Write one ${def.label} post for this business.`,
    '',
    'BUSINESS:',
    brandVoicePromptBlock(voice),
    '',
    'THIS JOB:',
    ...facts,
    '',
    `PLATFORM STYLE (${def.label}): ${def.styleHint}`,
    def.usesHashtags ? '' : 'Do NOT use hashtags.',
  ].filter(line => line !== '').join('\n')

  return {
    system: SYSTEM,
    prompt,
    schema,
    toolName: 'compose_post',
    toolDescription: `Provide the finished ${def.label} post for the owner to review and publish.`,
  }
}
