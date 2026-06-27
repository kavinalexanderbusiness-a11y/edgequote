import type { JsonSchema } from '@/lib/ai/studioGateway'
import { channel as channelDef, type ChannelDef } from './channels'
import { brandVoicePromptBlock, MARKETING_SYSTEM, type BrandVoice } from './brandVoice'
import { styleDirective } from './styles'
import { ctaDirective } from './memory'
import {
  DEFAULT_POST_OPTIONS,
  type CtaIntent, type GenSubject, type MarketingCandidate, type MarketingChannel,
  type PostLength, type PostOptions, type PostText, type RewriteAction, type Season, type WritingStyle,
} from './types'

// ── Prompt builder — ONE framework, everything is a modifier ──────────────────────
// A single prompt body (`promptCore`) is shared by EVERY generation path. What varies:
//   • SUBJECT   — the facts to write about (a job's intelligence read, or a campaign theme)
//   • OPTIONS   — length / style / emoji / hashtags
//   • DIRECTIVE — a campaign angle (optional)
//   • EXTRAS    — the picked CTA intent + the anti-repetition AVOID block
// The brand persona, banned phrases, hook rules, platform playbooks, style directives,
// CTA rotation and hashtag mixing all live here once. A new platform is one ChannelDef;
// a new style is one row in styles.ts; a new rewrite is one row in REWRITE_ACTIONS.
// Nothing here is forked per-platform or per-feature.

export const PROMPT_VERSION = 'studio-agency-v3'
export const STREAM_PROMPT_VERSION = 'studio-agency-stream-v3'
export const REWRITE_PROMPT_VERSION = 'studio-rewrite-v1'

export type { GenSubject } from './types'

// Per-generation extras the routes assemble (CTA rotation + memory). Kept optional so
// every existing caller and back-compat path keeps working.
export interface PromptExtras {
  style?: WritingStyle
  ctaIntent?: CtaIntent | null
  avoidance?: string | null
}

// Banded lawn size — never the raw square footage (rule: numbers stay human).
function lawnBand(sqft: number | null): string | null {
  if (!sqft) return null
  if (sqft < 2000) return 'a compact lawn'
  if (sqft > 6000) return 'a larger property'
  return null
}

// Facts for a finished job when no richer intelligence read is supplied (back-compat).
function candidateFacts(candidate: MarketingCandidate): string[] {
  const facts: string[] = []
  facts.push(`Work done: ${candidate.serviceType || 'property maintenance'}.`)
  if (candidate.neighborhood) facts.push(`Neighbourhood: ${candidate.neighborhood}.`)
  else if (candidate.city) facts.push(`Area: ${candidate.city}.`)
  if (candidate.season) facts.push(`Season: ${candidate.season}.`)
  const band = lawnBand(candidate.lawnSqft)
  if (band) facts.push(`It is ${band}.`)
  if (candidate.hasBefore && candidate.hasAfter) facts.push('There is a before-and-after photo pair to attach.')
  else if (candidate.hasAfter) facts.push('There is a finished "after" photo to attach.')
  if (candidate.hasReview) facts.push('This customer was happy and left a review.')
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

function hashtagsActive(def: ChannelDef, options: PostOptions): boolean {
  return def.usesHashtags && options.hashtags
}
function hashtagCount(def: ChannelDef): number {
  return def.key === 'threads' ? 2 : def.key === 'instagram' ? 8 : 5
}

function lengthTarget(def: ChannelDef, length: PostLength): { chars: number; hint: string } {
  const base = def.maxChars
  switch (length) {
    case 'short':
      return { chars: Math.max(120, Math.round(base * 0.4)), hint: 'Length: short and scroll-stopping — 1 to 2 tight sentences.' }
    case 'long':
      return { chars: Math.min(base + 350, Math.round(base * 1.5)), hint: 'Length: longer — a short story or two small paragraphs, still skimmable.' }
    default:
      return { chars: base, hint: 'Length: medium — a few natural sentences.' }
  }
}

export function lengthChars(ch: MarketingChannel, length: PostLength): number {
  return lengthTarget(channelDef(ch), length).chars
}

// Emoji instruction = the channel's policy capped by the owner's toggle.
function emojiInstruction(def: ChannelDef, options: PostOptions): string {
  if (def.emoji === 'none' || !options.emojis) return 'Emojis: none — they read as spam here.'
  if (def.emoji === 'sparing') return 'Emojis: at most one or two, and only if they genuinely add warmth.'
  return 'Emojis: a few are fine where they fit — never more than one per line, never two in a row.'
}

const HOOK_RULE =
  'HOOK: open with ONE scroll-stopping line — a sharp observation, a small truth, a vivid detail, or a question — specific to THIS job, place, or season. ' +
  'Never open with the business name, "Another", "Check out", "We just", "Here\'s", or "Looking for". ' +
  'For calibre only (do NOT reuse these): "Great lawns don\'t happen by accident." / "One clean edge changes the whole property." / "This yard looked completely different an hour ago."'

// The shared prompt body every channel + option set flows through.
function promptCore(
  subject: GenSubject,
  ch: MarketingChannel,
  voice: BrandVoice,
  options: PostOptions,
  directive?: string | null,
  extras?: PromptExtras,
): string[] {
  const def = channelDef(ch)
  const len = lengthTarget(def, options.length)
  const useTags = hashtagsActive(def, options)
  const place = subject.neighborhood || subject.city || voice.city

  const lines: string[] = [
    `Write one ${def.label} post for ${voice.businessName}.`,
    '',
    'BUSINESS:',
    brandVoicePromptBlock(voice),
    '',
    'WHAT THIS POST IS ABOUT (use naturally — never list these as stats):',
    ...(subject.facts.length ? subject.facts : ['A general post about the business.']),
  ]

  if (directive && directive.trim()) lines.push('', 'CAMPAIGN:', directive.trim())

  lines.push(
    '',
    `PLATFORM — ${def.label}: ${def.playbook}`,
    '',
    styleDirective(extras?.style ?? options.style),
    HOOK_RULE,
    place ? `LOCAL: ground it in ${place} naturally — you live and work here. Never invent specific landmarks, businesses, streets, or events.` : '',
    len.hint,
    `Aim for roughly ${len.chars} characters or fewer.`,
    emojiInstruction(def, options),
  )

  if (options.cta) {
    lines.push(extras?.ctaIntent ? ctaDirective(extras.ctaIntent, voice)
      : 'Close with one clear, friendly call to action, worded naturally and not pushy.')
  }

  if (useTags) {
    const city = subject.city || voice.city
    lines.push(`HASHTAGS: a MIX of up to ${hashtagCount(def)} — 1-2 local (${[subject.neighborhood, city].filter(Boolean).join('/') || 'the area'}), 1-2 service, 1 seasonal, 1 brand-flavoured. Lowercase, no spaces, genuinely searchable. Never reuse the same set.`)
  }

  if (extras?.avoidance && extras.avoidance.trim()) lines.push('', extras.avoidance.trim())

  return lines
}

// ── Structured generation (used by all generate paths) ──
export function buildPostInput(
  subject: GenSubject,
  ch: MarketingChannel,
  voice: BrandVoice,
  options: PostOptions = DEFAULT_POST_OPTIONS,
  directive?: string | null,
  extras?: PromptExtras,
): { system: string; prompt: string; schema: JsonSchema; toolName: string; toolDescription: string } {
  const def = channelDef(ch)
  const useTags = hashtagsActive(def, options)

  const properties: Record<string, unknown> = {
    body: { type: 'string', description: `The finished ${def.label} post text.` },
    hashtags: {
      type: 'array',
      items: { type: 'string' },
      description: useTags
        ? `Up to ${hashtagCount(def)} hashtags WITHOUT the # symbol — a mix of local, service, seasonal and brand. Fresh each time.`
        : 'Leave this empty — no hashtags for this post.',
    },
  }
  const required = ['body', 'hashtags']
  if (def.usesTitle) {
    properties.title = { type: 'string', description: 'A short, specific headline (under 60 characters) — not a label.' }
    required.push('title')
  }

  const schema: JsonSchema = { type: 'object', additionalProperties: false, properties, required }
  const lines = promptCore(subject, ch, voice, options, directive, extras)
  lines.push(useTags
    ? `Put the hashtags (no # symbol) in the hashtags field.`
    : 'No hashtags — leave the hashtags field empty.')

  return {
    system: MARKETING_SYSTEM,
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
  extras?: PromptExtras,
) {
  return buildPostInput(subjectFromCandidate(candidate), ch, voice, options, directive, extras)
}

// ── Streaming generation (the "watch it write" path) ──
const STREAM_SYSTEM = `${MARKETING_SYSTEM}

Output format: write ONLY the post text, exactly as the owner would paste it. No preamble, no quotes, no "Here's your post", no labels or section headers.`

export function buildPostStreamInput(
  subject: GenSubject,
  ch: MarketingChannel,
  voice: BrandVoice,
  options: PostOptions = DEFAULT_POST_OPTIONS,
  directive?: string | null,
  extras?: PromptExtras,
): { system: string; prompt: string; maxTokens: number } {
  const def = channelDef(ch)
  const useTags = hashtagsActive(def, options)
  const lines = promptCore(subject, ch, voice, options, directive, extras)
  lines.push(useTags
    ? `End with ${def.key === 'threads' ? '1-2' : '3-6'} hashtags on the final line (with the # symbol).`
    : 'Do NOT use any hashtags.')
  const maxTokens = options.length === 'long' ? 1000 : options.length === 'short' ? 450 : 700
  return { system: STREAM_SYSTEM, prompt: lines.join('\n'), maxTokens }
}

export function buildStreamInput(
  candidate: MarketingCandidate,
  ch: MarketingChannel,
  voice: BrandVoice,
  options: PostOptions = DEFAULT_POST_OPTIONS,
  directive?: string | null,
  extras?: PromptExtras,
) {
  return buildPostStreamInput(subjectFromCandidate(candidate), ch, voice, options, directive, extras)
}

// ── AI rewrite tools — one gateway, a table of one-line transforms ──────────────────
export const REWRITE_ACTIONS: Record<RewriteAction, { label: string; instruction: string }> = {
  rewrite:       { label: 'Rewrite',          instruction: 'Rewrite this post from scratch in a fresh, clearly different way — same facts and platform, but a new hook, new angle and new wording. Do not reuse the opening line.' },
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

const REWRITE_SYSTEM = `${MARKETING_SYSTEM}

You are EDITING an existing post. Apply ONLY the requested change; keep every concrete fact (services, places, the kind of work). Preserve the platform's style and roughly its length unless the change is about length.`

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
    `Keep it suited to ${def.label}: ${def.playbook}`,
  ].join('\n')

  return {
    system: REWRITE_SYSTEM,
    prompt,
    schema,
    toolName: 'rewrite_post',
    toolDescription: `Return the rewritten ${def.label} post.`,
  }
}
