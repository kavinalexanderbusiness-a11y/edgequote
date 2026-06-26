import type { JsonSchema } from '@/lib/ai/studioGateway'
import { channel as channelDef, type ChannelDef } from './channels'
import { brandVoicePromptBlock, type BrandVoice } from './brandVoice'
import {
  DEFAULT_POST_OPTIONS,
  type MarketingCandidate, type MarketingChannel, type PostLength, type PostOptions,
  type PostText, type RewriteAction, type Season,
} from './types'

// ── Prompt builder — ONE framework, everything is a modifier ──────────────────────
// A single prompt body (`promptCore`) is shared by EVERY generation path: one-off
// posts, "all platforms", campaigns, and the month-queue. The only inputs that vary
// are (a) the SUBJECT — the facts to write about, from a job candidate OR a themed
// campaign — and (b) an optional DIRECTIVE — a campaign angle / anti-repetition note.
// Rewrites reuse the same gateway + a table of one-line actions. A new platform is one
// ChannelDef; a new control is one line in modifierLines; a new rewrite is one row in
// REWRITE_ACTIONS. Never fork a per-channel or per-feature prompt.
//
// The AI only ever sees facts the app already holds — it is told NOT to invent
// details, so a generated post can't promise a service or price that wasn't performed.

export const PROMPT_VERSION = 'studio-organic-v2'
export const STREAM_PROMPT_VERSION = 'studio-organic-stream-v2'
export const REWRITE_PROMPT_VERSION = 'studio-rewrite-v1'

// ── Subject: the "what to write about", decoupled from where it came from ──────────
export interface GenSubject {
  facts: string[]
  season: Season | null
  neighborhood: string | null
  city: string | null
}

// The facts the model may use for a finished job — and nothing else.
function candidateFacts(candidate: MarketingCandidate): string[] {
  const facts: string[] = []
  facts.push(`Service performed: ${candidate.serviceType || 'property maintenance'}`)
  if (candidate.neighborhood) facts.push(`Neighbourhood: ${candidate.neighborhood}`)
  else if (candidate.city) facts.push(`Area: ${candidate.city}`)
  if (candidate.season) facts.push(`Season: ${candidate.season}`)
  if (candidate.lawnSqft) facts.push(`Lawn size: about ${Math.round(candidate.lawnSqft).toLocaleString()} sq ft`)
  if (candidate.hasBefore && candidate.hasAfter) facts.push('We have a before-and-after photo pair to attach.')
  else if (candidate.hasAfter) facts.push('We have a finished "after" photo to attach.')
  if (candidate.hasReview) facts.push('This customer was happy and left us a review.')
  return facts
}

export function subjectFromCandidate(candidate: MarketingCandidate): GenSubject {
  return {
    facts: candidateFacts(candidate),
    season: candidate.season,
    neighborhood: candidate.neighborhood,
    city: candidate.city,
  }
}

const SYSTEM = `You are an expert social media copywriter for a local property-care business (lawn care, landscaping, snow removal). You write posts the business owner can publish as-is.

Rules:
- Write ONLY from the facts provided. Never invent prices, guarantees, services, dates, customer names, landmarks, or businesses that weren't given. If a detail isn't provided, leave it out.
- Sound like a real local owner-operator, not a marketing agency. Warm, confident, specific. No corporate buzzwords ("synergy", "elevate", "unlock"), no clickbait.
- Make the neighbourhood and the actual work concrete when given — that's what makes a local post land.
- Match the requested platform's style and length, and follow every STYLE and CAMPAIGN instruction exactly as stated.
- Return your answer ONLY through the provided tool.`

function hashtagsActive(def: ChannelDef, options: PostOptions): boolean {
  return def.usesHashtags && options.hashtags
}

function hashtagCount(def: ChannelDef): number {
  return def.key === 'threads' ? 2 : 6
}

function lengthTarget(def: ChannelDef, length: PostLength): { chars: number; hint: string } {
  const base = def.maxChars
  switch (length) {
    case 'short':
      return { chars: Math.max(120, Math.round(base * 0.4)), hint: 'Length: keep it short and scroll-stopping — 1 to 2 tight sentences.' }
    case 'long':
      return { chars: Math.min(base + 350, Math.round(base * 1.5)), hint: 'Length: go longer — a short story or two small paragraphs, still skimmable.' }
    default:
      return { chars: base, hint: 'Length: medium — a few natural sentences.' }
  }
}

export function lengthChars(ch: MarketingChannel, length: PostLength): number {
  return lengthTarget(channelDef(ch), length).chars
}

const SEASON_CUE: Record<Season, string> = {
  spring: 'spring green-up, first cuts of the year, cleaning up after winter',
  summer: 'peak growing season, keeping it crisp through the summer heat',
  fall:   'leaf cleanup, fall aeration, the last tidy before the snow',
  winter: 'snow and ice, keeping driveways and walks clear and safe',
}

// The single place creative options become prompt instructions.
function modifierLines(options: PostOptions, voice: BrandVoice, subject: GenSubject): string[] {
  const lines: string[] = []

  lines.push(options.emojis
    ? 'Emojis: include a few tasteful, relevant emojis for warmth — at most one per line, never several in a row.'
    : 'Emojis: do not use any emojis.')

  if (options.cta) {
    const contact = voice.phone ? ` They can call or text ${voice.phone}.` : ''
    lines.push(`Call to action: finish with ONE clear, friendly call to action — invite them to message for a free quote or to book.${contact} Keep it natural, never pushy.`)
  }

  if (options.seasonal && subject.season) {
    lines.push(`Seasonal angle: work in a natural ${subject.season} note (${SEASON_CUE[subject.season]}) — only where it fits the post.`)
  }

  if (options.local) {
    const place = subject.neighborhood || subject.city || voice.city
    const climate = voice.city || subject.city
    if (place) {
      const area = subject.neighborhood ? 'neighbourhood' : 'area'
      lines.push(`Local flavour: write like a trusted ${place} neighbour — name the ${area}${climate ? ` and nod to ${climate}'s climate or season` : ''} naturally. Never invent specific landmarks, businesses, streets, or events.`)
    }
  }

  return lines
}

// The shared prompt body every channel + option set + directive flows through.
function promptCore(
  subject: GenSubject,
  ch: MarketingChannel,
  voice: BrandVoice,
  options: PostOptions,
  directive?: string | null,
): string[] {
  const def = channelDef(ch)
  const len = lengthTarget(def, options.length)
  const lines = [
    `Write one ${def.label} post for this business.`,
    '',
    'BUSINESS:',
    brandVoicePromptBlock(voice),
    '',
    'THIS POST IS ABOUT:',
    ...(subject.facts.length ? subject.facts : ['A general post about the business.']),
  ]
  if (directive && directive.trim()) {
    lines.push('', 'CAMPAIGN:', directive.trim())
  }
  lines.push(
    '',
    `PLATFORM STYLE (${def.label}): ${def.styleHint}`,
    '',
    'STYLE:',
    len.hint,
    `Aim for roughly ${len.chars} characters or fewer.`,
    ...modifierLines(options, voice, subject),
  )
  return lines
}

// ── Structured generation (used by all generate paths) ──
export function buildPostInput(
  subject: GenSubject,
  ch: MarketingChannel,
  voice: BrandVoice,
  options: PostOptions = DEFAULT_POST_OPTIONS,
  directive?: string | null,
): { system: string; prompt: string; schema: JsonSchema; toolName: string; toolDescription: string } {
  const def = channelDef(ch)
  const useTags = hashtagsActive(def, options)

  const properties: Record<string, unknown> = {
    body: { type: 'string', description: `The post text for ${def.label}.` },
    hashtags: {
      type: 'array',
      items: { type: 'string' },
      description: useTags
        ? `Up to ${hashtagCount(def)} relevant hashtags WITHOUT the # symbol (e.g. "lawncare"). Local + service oriented.`
        : 'Leave this empty — no hashtags for this post.',
    },
  }
  const required = ['body', 'hashtags']
  if (def.usesTitle) {
    properties.title = { type: 'string', description: 'A short headline (under 60 characters).' }
    required.push('title')
  }

  const schema: JsonSchema = { type: 'object', additionalProperties: false, properties, required }

  const lines = promptCore(subject, ch, voice, options, directive)
  lines.push(useTags
    ? `Hashtags: provide up to ${hashtagCount(def)} relevant hashtags in the hashtags field (no # symbol).`
    : 'Hashtags: none — leave the hashtags field empty.')

  return {
    system: SYSTEM,
    prompt: lines.join('\n'),
    schema,
    toolName: 'compose_post',
    toolDescription: `Provide the finished ${def.label} post for the owner to review and publish.`,
  }
}

// Back-compat adapter: a one-off post from a finished job.
export function buildGenerateInput(
  candidate: MarketingCandidate,
  ch: MarketingChannel,
  voice: BrandVoice,
  options: PostOptions = DEFAULT_POST_OPTIONS,
  directive?: string | null,
) {
  return buildPostInput(subjectFromCandidate(candidate), ch, voice, options, directive)
}

// ── Streaming generation (the "watch it write" path) ──
const STREAM_SYSTEM = `${SYSTEM}

Output format: write ONLY the post text, exactly as the owner would paste it. No preamble, no quotes, no "Here's your post", no labels or section headers.`

export function buildPostStreamInput(
  subject: GenSubject,
  ch: MarketingChannel,
  voice: BrandVoice,
  options: PostOptions = DEFAULT_POST_OPTIONS,
  directive?: string | null,
): { system: string; prompt: string; maxTokens: number } {
  const def = channelDef(ch)
  const useTags = hashtagsActive(def, options)
  const lines = promptCore(subject, ch, voice, options, directive)
  lines.push(useTags
    ? `Hashtags: end the post with ${def.key === 'threads' ? '1-2' : '3-6'} relevant hashtags on the final line (with the # symbol).`
    : 'Hashtags: do NOT use any hashtags.')
  const maxTokens = options.length === 'long' ? 1000 : options.length === 'short' ? 450 : 700
  return { system: STREAM_SYSTEM, prompt: lines.join('\n'), maxTokens }
}

export function buildStreamInput(
  candidate: MarketingCandidate,
  ch: MarketingChannel,
  voice: BrandVoice,
  options: PostOptions = DEFAULT_POST_OPTIONS,
  directive?: string | null,
) {
  return buildPostStreamInput(subjectFromCandidate(candidate), ch, voice, options, directive)
}

// ── AI rewrite tools — one gateway, a table of one-line transforms ──────────────────
export const REWRITE_ACTIONS: Record<RewriteAction, { label: string; instruction: string }> = {
  shorter:       { label: 'Shorter',          instruction: 'Make it noticeably shorter and tighter — cut filler, keep the core message and the call to action.' },
  longer:        { label: 'Longer',           instruction: 'Expand it a little — add a sentence of helpful detail or a short story, without padding or repetition.' },
  professional:  { label: 'More professional', instruction: 'Make the tone more professional and polished, while still sounding like a real owner — no corporate jargon.' },
  friendly:      { label: 'More friendly',    instruction: 'Make it warmer and friendlier — like talking to a neighbour.' },
  exciting:      { label: 'More exciting',    instruction: 'Make it more energetic and exciting — a stronger hook and more momentum, with no hype clichés or ALL CAPS.' },
  premium:       { label: 'More premium',     instruction: 'Give it a more premium, high-end feel — confident, quality-focused, understated. No discount language.' },
  local:         { label: 'More local',       instruction: 'Make it feel more local — lean into the neighbourhood and the local season/climate. Never invent specific landmarks or businesses.' },
  humorous:      { label: 'More humorous',    instruction: 'Add light, tasteful humour — one friendly, playful line. Keep it professional and on-brand.' },
  seo:           { label: 'SEO optimized',    instruction: 'Optimise for local SEO — naturally work in the service and the location/area keywords a neighbour would search, without keyword-stuffing.' },
  remove_emojis: { label: 'Remove emojis',    instruction: 'Remove all emojis. Keep the wording natural after removing them.' },
  add_emojis:    { label: 'Add emojis',       instruction: 'Add a few tasteful, relevant emojis for warmth — at most one per line, never several in a row.' },
  stronger_cta:  { label: 'Stronger CTA',     instruction: 'Make the call to action stronger and clearer — one specific next step (message us, book now, request a quote). Keep it natural, not pushy.' },
}

const REWRITE_SYSTEM = `You are editing an existing social media post for a local property-care business. Apply ONLY the requested change.

Rules:
- Keep every concrete fact (services, places, the kind of work) — do NOT invent new prices, guarantees, services, names, landmarks, or businesses.
- Keep it sounding like a real local owner-operator. No corporate buzzwords, no clickbait.
- Preserve the platform's style and roughly its length unless the change is about length.
- Return your answer ONLY through the provided tool.`

export function buildRewriteInput(
  text: PostText,
  ch: MarketingChannel,
  voice: BrandVoice,
  action: RewriteAction,
): { system: string; prompt: string; schema: JsonSchema; toolName: string; toolDescription: string } {
  const def = channelDef(ch)
  const act = REWRITE_ACTIONS[action]
  const useTags = def.usesHashtags

  const properties: Record<string, unknown> = {
    body: { type: 'string', description: 'The rewritten post text.' },
    hashtags: {
      type: 'array',
      items: { type: 'string' },
      description: useTags
        ? 'Hashtags WITHOUT the # symbol. Keep or refine the existing ones unless the change calls for different ones.'
        : 'Leave this empty — this platform does not use hashtags.',
    },
  }
  const required = ['body', 'hashtags']
  if (def.usesTitle) {
    properties.title = { type: 'string', description: 'The (possibly rewritten) short headline.' }
    required.push('title')
  }
  const schema: JsonSchema = { type: 'object', additionalProperties: false, properties, required }

  const current: string[] = []
  if (def.usesTitle && text.title) current.push(`HEADLINE: ${text.title}`)
  current.push('POST:', text.body || '(empty)')
  if (useTags && text.hashtags.length) current.push('HASHTAGS: ' + text.hashtags.map(h => `#${h.replace(/^#/, '')}`).join(' '))

  const prompt = [
    `Rewrite this ${def.label} post.`,
    '',
    'BUSINESS:',
    brandVoicePromptBlock(voice),
    '',
    'CURRENT POST:',
    ...current,
    '',
    `CHANGE TO APPLY: ${act.instruction}`,
    '',
    `Keep it suited to ${def.label}: ${def.styleHint}`,
  ].join('\n')

  return {
    system: REWRITE_SYSTEM,
    prompt,
    schema,
    toolName: 'rewrite_post',
    toolDescription: `Return the rewritten ${def.label} post.`,
  }
}
