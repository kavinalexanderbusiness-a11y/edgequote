// ── Brand voice ─────────────────────────────────────────────────────────────────
// Turns the owner's existing business_settings (company name, owner, location,
// contact, review link) into a reusable voice profile + a prompt fragment, so the
// AI sounds like THIS business without the owner ever filling out a "brand voice"
// form. Pure + deterministic; consumed by the generate route and (via a hook) the UI.

// We only need a slice of business_settings — keep this decoupled from the full type.
export interface BrandSource {
  company_name?: string | null
  owner_name?: string | null
  phone?: string | null
  website?: string | null
  email_primary?: string | null
  base_address?: string | null
  review_url?: string | null
}

export interface BrandVoice {
  businessName: string
  ownerName: string | null
  phone: string | null
  website: string | null
  email: string | null
  city: string | null            // inferred from base_address for "local" framing
  reviewUrl: string | null
  // What this business actually SELLS, derived from their own service_templates and
  // recent jobs (lib/marketing/businessContext). Empty = we don't know, and the
  // prompt then says nothing rather than assuming a trade. This is the field that
  // stops the AI writing about lawns for a plumber: it rides on BrandVoice, which
  // every generator already threads into every prompt, so there is one place to
  // load it and one place to render it.
  services?: string[]
}

// Best-effort city from a free-text base address ("123 5 Ave SW, Calgary, AB").
function cityFromAddress(addr?: string | null): string | null {
  if (!addr) return null
  const parts = addr.split(',').map(p => p.trim()).filter(Boolean)
  // ".., City, Province PostalCode" → the city is usually the second-to-last part.
  if (parts.length >= 2) return parts[parts.length - 2] || null
  return null
}

export function deriveBrandVoice(src: BrandSource | null | undefined): BrandVoice {
  return {
    businessName: src?.company_name?.trim() || 'our company',
    ownerName: src?.owner_name?.trim() || null,
    phone: src?.phone?.trim() || null,
    website: src?.website?.trim() || null,
    email: src?.email_primary?.trim() || null,
    city: cityFromAddress(src?.base_address),
    reviewUrl: src?.review_url?.trim() || null,
  }
}

// A compact, stable system-prompt fragment describing the business. Kept terse so
// it caches well and doesn't drown the per-job context.
export function brandVoicePromptBlock(v: BrandVoice): string {
  const lines: string[] = [
    `Business name: ${v.businessName}`,
  ]
  if (v.ownerName) lines.push(`Owner: ${v.ownerName}`)
  if (v.city) lines.push(`Based in: ${v.city}`)
  // The trade, in the owner's own words. Only stated when we actually know it —
  // silence is correct when we don't, because the model inventing "lawn care" from
  // nothing is exactly the failure this replaces.
  if (v.services?.length) {
    lines.push(`Services they sell: ${v.services.slice(0, 8).join(', ')}`)
    lines.push('Write about THESE services only. Never mention a trade or service they do not sell.')
  }
  if (v.phone) lines.push(`Phone: ${v.phone}`)
  if (v.website) lines.push(`Website: ${v.website}`)
  return lines.join('\n')
}

// ── Brand personality ──────────────────────────────────────────────────────────
// The constant voice EVERY post must hit, and the phrases/openers that make content
// read as generic AI. Shared by the prompt (told never to use them) AND the quality
// scorer (penalises them). This is the single biggest lever against "AI-looking" copy.

export const BRAND_ATTRIBUTES = ['professional', 'friendly', 'genuinely local', 'quietly premium', 'honest', 'confident'] as const

// Phrases that show up in generic lawn-care AI captions. Banned outright.
export const BANNED_PHRASES: string[] = [
  'another happy customer', 'happy customer', 'one happy customer',
  'freshly mowed', 'freshly cut', 'freshly trimmed', 'crisp and tidy', 'crisp and clean',
  'if your lawn needs some love', 'give your lawn some love', 'show your lawn some love',
  'look no further', "we've got you covered", 'we have you covered', 'we got you covered',
  'transform your lawn', 'transform your space', 'transform your yard',
  'take your lawn to the next level', 'next level', 'lawn goals',
  'attention to detail', 'second to none', 'top-notch', 'top notch',
  'we take pride', 'pride ourselves', 'we pride ourselves',
  'give us a call today', 'call us today', 'contact us today', 'call today',
  'the difference is clear', 'see the difference', 'like new again', 'good as new',
  "there's nothing like", 'nothing beats', 'rain or shine', 'come rain or shine',
  'hard work pays off', 'satisfaction guaranteed', 'your trusted', 'one stop shop',
]

// First-word/opening patterns that signal a templated post. Hooks must avoid these.
export const BANNED_OPENERS: string[] = [
  'another', 'freshly', 'check out', 'take a look', 'we just', 'we recently',
  "here's", 'here is', 'looking for', 'need your', 'is your lawn', 'does your lawn',
  'introducing', 'meet ', 'say hello', 'nothing like', 'who else',
]

// Corporate buzzwords / hype that flatten the voice.
export const BANNED_BUZZWORDS: string[] = ['elevate', 'unlock', 'leverage', 'synergy', 'seamless', 'best-in-class', 'cutting-edge', 'game-changer', 'world-class']

// The marketing-manager persona. Stable (caches well); the business specifics ride in
// the prompt body via brandVoicePromptBlock.
// The persona names no trade: the BUSINESS block (brandVoicePromptBlock) states what
// this business sells, and stating a different trade here is how a plumber's feed
// ended up sounding like a lawn company. When the block is silent, the model is told
// to keep the trade unstated — inventing one is the failure mode, not the fallback.
export const MARKETING_SYSTEM = `You are the in-house marketing manager for ONE local property-services business in Canada. The BUSINESS block in each request states exactly what this business sells — write only within that trade, and if it doesn't say, keep the trade unstated rather than guessing. You have written local social content for years and you are genuinely good at it. You write the finished post; the owner publishes it exactly as written.

THE VOICE — every post sounds: ${BRAND_ATTRIBUTES.join(', ')}. You never sound cheesy, salesy, desperate, or like a template. You write like the best operator in town who also happens to be great with words.

NON-NEGOTIABLES
1. Truth only. Use ONLY the facts provided. Never invent prices, guarantees, services, dates, customer names, stats, landmarks, awards, or businesses. If a detail isn't given, leave it out.
2. Numbers stay human. Never drop raw figures or stats into the text (e.g. "a 4,200 sq ft property", "took 47 minutes"). Translate facts into language a real neighbour would say.
3. Originality is the whole job. This business's feed must never look AI-generated. Every post opens differently and varies its sentence shapes, rhythm, and adjectives. If a line could open any local service business's post, rewrite it.
4. Never use these phrases or close variants: ${BANNED_PHRASES.slice(0, 16).map(p => `"${p}"`).join(', ')}. No corporate buzzwords (${BANNED_BUZZWORDS.slice(0, 6).join(', ')}). No clickbait, no fake urgency, no ALL-CAPS, no exclamation pile-ups, no emoji walls, no hashtag spam.
5. One clear idea per post. Concrete and specific beats broad and generic, every time.

Return the finished post ONLY through the provided tool.`
