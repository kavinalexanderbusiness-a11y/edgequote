import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { aiEnabled, generateStructured } from '@/lib/ai/anthropic'

export const dynamic = 'force-dynamic'
export const maxDuration = 60

// ── AI "strongest before/after" picker ──────────────────────────────────────
// Given the owner's candidate pairs, Claude vision looks at each before+after
// and ranks them by transformation impact, lighting, framing and how cleanly the
// result reads as a post. Returns a ranking + a short rationale per pair and one
// suggested headline. DISABLED-SAFE: with no ANTHROPIC_API_KEY this returns
// { disabled:true } and the client keeps its deterministic ordering. The owner
// triggers this explicitly — we never auto-send customer photos off-platform.

// Bound cost/latency: at most this many pairs (×2 images) per request.
const MAX_CANDIDATES = 6

interface Candidate {
  jobId: string
  label: string
  beforeUrl: string
  afterUrl: string
}

interface RankItem {
  index: number
  score: number
  rationale: string
}
interface AiResult {
  ranking: RankItem[]
  bestIndex: number
  headline: string
}

export async function POST(req: NextRequest) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'unauthorized' }, { status: 401 })

  if (!aiEnabled()) return NextResponse.json({ disabled: true })

  const body = await req.json().catch(() => ({}))
  const raw: Candidate[] = Array.isArray(body.candidates) ? body.candidates : []
  const candidates = raw
    .filter(c => c && c.jobId && c.beforeUrl && c.afterUrl)
    .slice(0, MAX_CANDIDATES)
  if (!candidates.length) return NextResponse.json({ error: 'no candidates' }, { status: 400 })

  // Build one user turn: a framing line + (label, before img, after img) per pair.
  const blocks: Parameters<typeof generateStructured>[0]['blocks'] = [
    {
      type: 'text',
      text:
        `You are picking the single strongest BEFORE/AFTER pair for a lawn & property care business to post on social media. ` +
        `There are ${candidates.length} candidate pairs, indexed from 0. For each, the BEFORE photo comes first, then the AFTER. ` +
        `Judge by: how dramatic and obvious the transformation is, clean framing that roughly matches between the two shots, good lighting, ` +
        `and whether it would make a scroller stop. Penalize pairs where before and after look unrelated, are blurry, or show little change. ` +
        `Return a score 0-100 and a one-sentence rationale for each index, the best index overall, and one punchy headline (max 8 words) for the winner.`,
    },
  ]
  candidates.forEach((c, i) => {
    blocks.push({ type: 'text', text: `--- Pair ${i} — ${c.label} ---\nBEFORE:` })
    blocks.push({ type: 'image', url: c.beforeUrl })
    blocks.push({ type: 'text', text: 'AFTER:' })
    blocks.push({ type: 'image', url: c.afterUrl })
  })

  const result = await generateStructured<AiResult>({
    blocks,
    maxTokens: 1200,
    tool: {
      name: 'rank_pairs',
      description: 'Rank the candidate before/after pairs and pick the strongest.',
      schema: {
        type: 'object',
        properties: {
          ranking: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                index: { type: 'integer', description: 'Pair index (0-based).' },
                score: { type: 'number', description: '0-100 strength score.' },
                rationale: { type: 'string', description: 'One short sentence.' },
              },
              required: ['index', 'score', 'rationale'],
            },
          },
          bestIndex: { type: 'integer', description: 'Index of the strongest pair.' },
          headline: { type: 'string', description: 'Punchy headline for the winner (<=8 words).' },
        },
        required: ['ranking', 'bestIndex', 'headline'],
      },
    },
  })

  if (!result) {
    // Key present but the call failed/timed out — let the client fall back quietly.
    return NextResponse.json({ ok: false, failed: true })
  }

  // Map indices back to jobIds; ignore anything out of range.
  const byIndex = new Map<number, RankItem>()
  for (const r of result.ranking || []) byIndex.set(r.index, r)
  const ranking = candidates.map((c, i) => {
    const r = byIndex.get(i)
    return {
      jobId: c.jobId,
      score: r ? Math.max(0, Math.min(100, Math.round(r.score))) : 0,
      rationale: r?.rationale || '',
    }
  })
  const best = candidates[result.bestIndex]
  return NextResponse.json({
    ok: true,
    bestJobId: best ? best.jobId : ranking.slice().sort((a, b) => b.score - a.score)[0]?.jobId,
    headline: result.headline || '',
    ranking,
  })
}
