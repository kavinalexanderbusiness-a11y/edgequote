import { BANNED_PHRASES, BANNED_OPENERS, BANNED_BUZZWORDS } from './brandVoice'
import { channel as channelDef } from './channels'
import type { MarketingChannel, QualityScore } from './types'

// ── Marketing quality score ─────────────────────────────────────────────────────────
// Scores a generated post on six dimensions WITHOUT another AI call (instant + free):
// Hook, Readability, Local relevance, CTA strength, Originality, Brand consistency.
// If `total` is below THRESHOLD (or a hard rule trips), the route regenerates once and
// keeps the better attempt. This is the safety net that stops weak posts reaching the
// owner. Heuristic by design — it measures the things that make copy read as generic AI.

export const QUALITY_THRESHOLD = 72

export interface ScoreContext {
  channel: MarketingChannel
  neighborhood: string | null
  city: string | null
  recentBodies: string[]   // for originality vs the existing feed
  emojisRequested: boolean
}

const EMOJI_RE = /\p{Extended_Pictographic}/gu
const clamp = (n: number) => Math.max(0, Math.min(100, Math.round(n)))

function sentences(body: string): string[] {
  return body.replace(/\s+/g, ' ').trim().split(/(?<=[.!?])\s+/).filter(Boolean)
}
function wordCount(s: string): number {
  return s.split(/\s+/).filter(Boolean).length
}
function containsAny(haystack: string, needles: string[]): string | null {
  const h = haystack.toLowerCase()
  for (const n of needles) if (h.includes(n)) return n
  return null
}
function jaccard(a: string, b: string): number {
  const sa = new Set(a.toLowerCase().replace(/[^\p{L}\s]/gu, ' ').split(/\s+/).filter(w => w.length > 3))
  const sb = new Set(b.toLowerCase().replace(/[^\p{L}\s]/gu, ' ').split(/\s+/).filter(w => w.length > 3))
  if (!sa.size || !sb.size) return 0
  let inter = 0
  for (const w of sa) if (sb.has(w)) inter++
  return inter / (sa.size + sb.size - inter)
}

export function scorePost(post: { title?: string | null; body: string; hashtags: string[] }, ctx: ScoreContext): QualityScore {
  const def = channelDef(ctx.channel)
  const body = (post.body || '').trim()
  const lower = body.toLowerCase()
  const flags: string[] = []
  const sents = sentences(body)
  const first = sents[0] || ''
  const firstLower = first.toLowerCase()

  // ── Hook ──
  let hook = 72
  const badOpener = BANNED_OPENERS.find(o => firstLower.startsWith(o))
  if (badOpener) { hook -= 38; flags.push(`weak opener "${badOpener}…"`) }
  const firstLen = first.length
  if (firstLen > 130) { hook -= 18; flags.push('hook too long') }
  else if (firstLen >= 18 && firstLen <= 95) hook += 12
  if (/[A-Z][a-z]+/.test(first) && /[.!?]$/.test(first)) hook += 4
  // a hook that just names the service is generic
  if (/^(lawn care|lawn mowing|grass cutting|landscaping)\b/i.test(first)) { hook -= 14; flags.push('generic hook') }

  // ── Readability ──
  let readability = 80
  const avgLen = sents.length ? sents.reduce((s, x) => s + wordCount(x), 0) / sents.length : wordCount(body)
  if (avgLen > 28) { readability -= 20; flags.push('sentences run long') }
  else if (avgLen >= 8 && avgLen <= 22) readability += 8
  if (sents.some(s => wordCount(s) > 45)) { readability -= 12; flags.push('a sentence is a wall') }
  if (body.length > def.maxChars * 1.6) { readability -= 12; flags.push('over platform length') }
  if (body.length > 280 && !body.includes('\n')) readability -= 6 // long + no breathing room

  // ── Local relevance ──
  let localRelevance = 45
  const place = [ctx.neighborhood, ctx.city].filter(Boolean).map(p => (p as string).toLowerCase())
  if (place.some(p => lower.includes(p))) localRelevance = 95
  else if (/\b(neighbour|neighbor|local|community|street|block|area)\b/.test(lower)) localRelevance = 70
  else flags.push('no local reference')

  // ── CTA strength ──
  let ctaStrength = 35
  if (/\b(book|booking|quote|estimate|message us|dm|call|text|schedule|reach out|get in touch|reserve|refer|review|leave us)\b/.test(lower) || /\?\s*$/.test(body)) {
    ctaStrength = 88
  } else flags.push('no clear CTA')

  // ── Originality ──
  let originality = 85
  const banned = containsAny(body, BANNED_PHRASES)
  if (banned) { originality -= 45; flags.push(`banned phrase "${banned}"`) }
  const maxSim = ctx.recentBodies.reduce((m, b) => Math.max(m, jaccard(body, b)), 0)
  if (maxSim > 0.5) { originality -= 30; flags.push('very similar to a recent post') }
  else if (maxSim > 0.35) { originality -= 14; flags.push('echoes a recent post') }

  // ── Brand consistency ──
  let brandConsistency = 88
  if (banned) brandConsistency -= 25
  const buzz = containsAny(body, BANNED_BUZZWORDS)
  if (buzz) { brandConsistency -= 18; flags.push(`buzzword "${buzz}"`) }
  const emojis = (body.match(EMOJI_RE) || []).length
  if (def.emoji === 'none' && emojis > 0) { brandConsistency -= 16; flags.push('emoji on a no-emoji platform') }
  else if (def.emoji === 'sparing' && emojis > 2) { brandConsistency -= 10; flags.push('too many emoji') }
  else if (emojis > 6) { brandConsistency -= 12; flags.push('emoji overload') }
  const bangs = (body.match(/!/g) || []).length
  if (bangs > 2) { brandConsistency -= 10; flags.push('exclamation pile-up') }
  if (/\b[A-Z]{4,}\b/.test(body)) { brandConsistency -= 8; flags.push('ALL-CAPS hype') }
  if (!def.usesHashtags && post.hashtags.length) { brandConsistency -= 6; flags.push('hashtags where the platform takes none') }
  if (def.usesHashtags && post.hashtags.length > 8) { brandConsistency -= 8; flags.push('hashtag wall') }

  const dims = {
    hook: clamp(hook),
    readability: clamp(readability),
    localRelevance: clamp(localRelevance),
    ctaStrength: clamp(ctaStrength),
    originality: clamp(originality),
    brandConsistency: clamp(brandConsistency),
  }
  // Weighted: originality + hook matter most for "doesn't look AI-generated".
  const total = clamp(
    dims.hook * 0.22 + dims.originality * 0.24 + dims.brandConsistency * 0.18 +
    dims.localRelevance * 0.14 + dims.ctaStrength * 0.12 + dims.readability * 0.10,
  )
  // Hard fails force a regenerate regardless of the weighted total.
  const hardFail = !!banned || !!badOpener || !body
  const pass = total >= QUALITY_THRESHOLD && !hardFail

  return { ...dims, total, pass, flags }
}

// Developer/debug note (#10): why the shown post is stronger than the first attempt.
export function improvementNote(first: QualityScore, final: QualityScore, regenerated: boolean): string {
  if (!regenerated) {
    return `Passed on first try (${final.total}/100). Strengths: ${topDims(final)}.`
  }
  const gained: string[] = []
  for (const k of ['hook', 'originality', 'localRelevance', 'ctaStrength', 'brandConsistency', 'readability'] as const) {
    const d = final[k] - first[k]
    if (d >= 8) gained.push(`${LABEL[k]} +${d}`)
  }
  const fixed = first.flags.filter(f => !final.flags.includes(f))
  return `Regenerated once: ${first.total} → ${final.total}/100. ${gained.length ? 'Improved ' + gained.join(', ') + '. ' : ''}${fixed.length ? 'Fixed: ' + fixed.slice(0, 3).join('; ') + '.' : ''}`.trim()
}

const LABEL: Record<keyof Omit<QualityScore, 'total' | 'pass' | 'flags'>, string> = {
  hook: 'hook', readability: 'readability', localRelevance: 'local', ctaStrength: 'CTA', originality: 'originality', brandConsistency: 'brand',
}
function topDims(s: QualityScore): string {
  return (Object.keys(LABEL) as (keyof typeof LABEL)[])
    .map(k => ({ k, v: s[k] }))
    .sort((a, b) => b.v - a.v)
    .slice(0, 2)
    .map(d => `${LABEL[d.k]} ${d.v}`)
    .join(', ')
}
