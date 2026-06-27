import type { BrandVoice } from './brandVoice'
import type { ContentPiece, CtaIntent, MarketingChannel } from './types'

// ── Generation memory ─────────────────────────────────────────────────────────────
// Looks at recent posts and steers the next one AWAY from them, so the feed never
// reads as AI-generated. Two jobs: (1) build an AVOID block (openings, CTAs, hashtags,
// overused words the model must not reuse) and (2) rotate the CTA intent so every post
// closes with a different ask. Deterministic + free (no AI) — runs before generation.

type RecentPiece = Pick<ContentPiece, 'body' | 'hashtags' | 'channel' | 'meta'>

const STOPWORDS = new Set([
  'the', 'and', 'for', 'with', 'your', 'you', 'our', 'this', 'that', 'they', 'them', 'their',
  'are', 'was', 'were', 'have', 'has', 'had', 'from', 'just', 'into', 'over', 'after', 'before',
  'about', 'than', 'then', 'when', 'what', 'where', 'which', 'will', 'would', 'could', 'should',
  'here', 'there', 'every', 'some', 'more', 'most', 'very', 'really', 'lawn', 'yard', 'grass',
])

function words(text: string): string[] {
  return text.toLowerCase().replace(/[^\p{L}\s]/gu, ' ').split(/\s+/).filter(Boolean)
}

function opening(body: string): string {
  return words(body).slice(0, 9).join(' ')
}

function closing(body: string): string {
  const sentences = body.replace(/\s+/g, ' ').trim().split(/(?<=[.!?])\s+/).filter(Boolean)
  return (sentences[sentences.length - 1] || '').trim().slice(0, 80)
}

// Words used across MULTIPLE recent posts → the feed's tics. Surface the worst so the
// model stops leaning on them ("pristine", "beautiful", "transform", …).
function overusedWords(bodies: string[]): string[] {
  const docFreq = new Map<string, number>()
  for (const b of bodies) {
    const seen = new Set(words(b).filter(w => w.length > 4 && !STOPWORDS.has(w)))
    for (const w of seen) docFreq.set(w, (docFreq.get(w) || 0) + 1)
  }
  return [...docFreq.entries()].filter(([, n]) => n >= 2).sort((a, b) => b[1] - a[1]).map(([w]) => w).slice(0, 8)
}

// The AVOID block injected into the prompt. Null when there's no history yet.
export function buildAvoidance(recent: RecentPiece[], ch: MarketingChannel): string | null {
  if (!recent.length) return null
  // Opening lines are most repetitive within a channel; pull those channel-first.
  const sameCh = recent.filter(r => r.channel === ch)
  const openings = Array.from(new Set((sameCh.length ? sameCh : recent).map(r => opening(r.body)).filter(Boolean))).slice(0, 6)
  const closings = Array.from(new Set(recent.map(r => closing(r.body)).filter(Boolean))).slice(0, 5)
  const tags = Array.from(new Set(recent.flatMap(r => (r.hashtags || []).map(h => h.toLowerCase())))).slice(0, 12)
  const overused = overusedWords(recent.map(r => r.body))

  const lines: string[] = ['AVOID — recent posts already used these. Do something clearly different:']
  if (openings.length) lines.push(`• Openings already used (start somewhere new): ${openings.map(o => `"${o}…"`).join(' / ')}`)
  if (closings.length) lines.push(`• CTAs already used (phrase yours differently): ${closings.map(c => `"${c}"`).join(' / ')}`)
  if (tags.length) lines.push(`• Hashtags already used (pick fresh ones): ${tags.map(t => `#${t}`).join(' ')}`)
  if (overused.length) lines.push(`• Overused words to avoid here: ${overused.join(', ')}`)
  return lines.length > 1 ? lines.join('\n') : null
}

// ── CTA rotation ──
const CTA_LABEL: Record<CtaIntent, string> = {
  booking: 'an invitation to book their next visit',
  estimate: 'an offer of a free, no-pressure estimate',
  referral: 'a friendly nudge to refer a neighbour',
  review: 'a warm ask for a quick review',
  weekly: 'a mention of easy weekly or biweekly upkeep',
  seasonal: 'a gentle seasonal reminder to get on the schedule',
}

export function ctaDirective(intent: CtaIntent, voice: BrandVoice): string {
  const contact = voice.phone ? ` They can call or text ${voice.phone}.` : ''
  const review = intent === 'review' && voice.reviewUrl ? ` Point them to ${voice.reviewUrl}.` : ''
  return `Close with ${CTA_LABEL[intent]} — one natural line, never pushy, and worded differently from recent posts.${review || contact}`
}

// Choose a CTA intent that fits the context AND rotates away from the last few used.
// `offset` shifts the pick so a single batch (all-platforms / queue) varies its CTAs.
export function pickCtaIntent(args: {
  recent: RecentPiece[]
  hasReview: boolean
  recurring: boolean
  seasonStart: boolean
  offset?: number
}): CtaIntent {
  // Eligible pool — context-aware: only offer 'review'/'weekly'/'seasonal' when they fit.
  const pool: CtaIntent[] = ['booking', 'estimate', 'referral']
  if (args.hasReview) pool.push('review')
  if (args.recurring) pool.push('weekly')
  if (args.seasonStart) pool.push('seasonal')
  // Rotate the pool by offset so consecutive posts in a batch don't all match.
  const offset = ((args.offset ?? 0) % pool.length + pool.length) % pool.length
  const rotated = pool.map((_, i) => pool[(i + offset) % pool.length])

  // What did the last few posts already ask for? Rotate away from them.
  const usedRecently = args.recent
    .map(r => (r.meta && typeof r.meta === 'object' ? (r.meta as Record<string, unknown>).ctaIntent : null))
    .filter((v): v is CtaIntent => typeof v === 'string') as CtaIntent[]
  const lastTwo = new Set(usedRecently.slice(0, 2))

  const fresh = rotated.find(i => !lastTwo.has(i))
  if (fresh) return fresh
  // Everything in the pool was used recently → step deterministically through it.
  return rotated[(usedRecently.length + offset) % rotated.length]
}
