import type { AiResult } from '@/lib/ai/studioGateway'
import { scorePost, improvementNote, type ScoreContext } from './quality'
import { buildAvoidance, pickCtaIntent } from './memory'
import type { PromptExtras } from './prompt'
import type { ContentPiece, CtaIntent, GeneratedDraft, MarketingChannel, PostOptions, QualityScore } from './types'

// ── Generation orchestration ────────────────────────────────────────────────────────
// Two reusable pieces the routes share so they stay thin and identical in shape:
//  1) buildGenerationContext — turns recent posts into the CTA pick + AVOID block + the
//     scoring context (all the "memory" the next post needs).
//  2) generateScoredDraft — generate → score → (if weak) regenerate ONCE → keep the
//     better attempt. Gateway-agnostic: the route passes a `run` thunk that calls its
//     own gateway, so this works for both the studio gateway and any other.

type RecentPiece = Pick<ContentPiece, 'body' | 'hashtags' | 'channel' | 'meta'>

export function buildGenerationContext(args: {
  channel: MarketingChannel
  options: PostOptions
  recent: RecentPiece[]
  neighborhood: string | null
  city: string | null
  hasReview: boolean
  recurring: boolean
  seasonStart: boolean
  ctaOffset?: number   // vary the CTA across a batch (all-platforms / queue)
}): { extras: PromptExtras; ctaIntent: CtaIntent; scoreCtx: ScoreContext } {
  const avoidance = buildAvoidance(args.recent, args.channel)
  const ctaIntent = pickCtaIntent({
    recent: args.recent,
    hasReview: args.hasReview,
    recurring: args.recurring,
    seasonStart: args.seasonStart,
    offset: args.ctaOffset ?? 0,
  })
  const extras: PromptExtras = { style: args.options.style, ctaIntent, avoidance }
  const scoreCtx: ScoreContext = {
    channel: args.channel,
    neighborhood: args.neighborhood,
    city: args.city,
    recentBodies: args.recent.map(r => r.body),
    emojisRequested: args.options.emojis,
  }
  return { extras, ctaIntent, scoreCtx }
}

export interface ScoredDraft {
  draft: GeneratedDraft
  score: QualityScore
  regenerated: boolean
  note: string
  model: string
}

// Generate, score, and regenerate once if the post is weak. `run(extraDirective)` builds
// the prompt (the route appends extraDirective on the retry) and calls the gateway.
export async function generateScoredDraft(
  run: (extraDirective: string | null) => Promise<AiResult<GeneratedDraft>>,
  scoreCtx: ScoreContext,
  opts?: { regenerate?: boolean },
): Promise<{ ok: true; result: ScoredDraft } | { ok: false; error: string }> {
  const a1 = await run(null)
  if (!a1.ok) return { ok: false, error: a1.error || 'generation failed' }
  const s1 = scorePost(a1.data, scoreCtx)
  if (s1.pass || opts?.regenerate === false) {
    return { ok: true, result: { draft: a1.data, score: s1, regenerated: false, note: improvementNote(s1, s1, false), model: a1.model } }
  }

  const fix = s1.flags.slice(0, 3).join('; ') || 'it read as generic'
  const a2 = await run(
    `Your previous attempt scored ${s1.total}/100 and was weak (${fix}). Write a clearly DIFFERENT, stronger version: a fresher hook, no banned phrases, more specific and human. Do not reuse the previous opening.`,
  )
  if (!a2.ok) {
    return { ok: true, result: { draft: a1.data, score: s1, regenerated: false, note: improvementNote(s1, s1, false), model: a1.model } }
  }
  const s2 = scorePost(a2.data, scoreCtx)
  const better = s2.total >= s1.total ? { d: a2.data, s: s2, m: a2.model } : { d: a1.data, s: s1, m: a1.model }
  return { ok: true, result: { draft: better.d, score: better.s, regenerated: true, note: improvementNote(s1, better.s, true), model: better.m } }
}

// Join a campaign directive with the quality-retry directive (either may be null).
export function joinDirectives(a?: string | null, b?: string | null): string | null {
  return [a, b].filter(d => d && d.trim()).join('\n\n') || null
}
