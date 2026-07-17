import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { aiEnabled, generateStructured, downscaleImageUrl } from '@/lib/ai/anthropic'
import { getPropertyContexts, propertyContextBlock } from '@/lib/ai/propertyContext'

export const dynamic = 'force-dynamic'
export const maxDuration = 60

// ── AI "strongest before/after" picker ──────────────────────────────────────
// Given the owner's candidate pairs, Claude vision looks at each before+after
// and ranks them by transformation impact, lighting, framing and how cleanly the
// result reads as a post. Returns a ranking + a short rationale per pair and one
// suggested headline. DISABLED-SAFE: with no ANTHROPIC_API_KEY this returns
// { disabled:true } and the client keeps its deterministic ordering. The owner
// triggers this explicitly — we never auto-send customer photos off-platform.
//
// The AI result is no longer thrown away: each ranked pair is captured as a
// marketing_assets row (reusable by Marketing Studio / Content Library / future
// AI) and the ranking is enriched with any property intelligence already on file
// (shared brain — analyse once, reuse everywhere). Both are best-effort and
// fault-tolerant: if those tables aren't present yet, the response is unchanged.

// Bound cost/latency: at most this many pairs (×2 images) per request.
const MAX_CANDIDATES = 6

interface Candidate {
  jobId: string
  label: string
  beforeUrl: string
  afterUrl: string
  // Optional — the client sends these so the AI pick can be persisted as a
  // reusable asset. Older clients that omit them still work (asset just lacks
  // the photo FKs / neighborhood).
  beforePhotoId?: string
  afterPhotoId?: string
  neighborhood?: string
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

interface JobRow {
  id: string
  customer_id: string | null
  property_id: string | null
  service_type: string | null
  completed_at: string | null
  scheduled_date: string | null
}

function clampScore(n: number): number {
  return Math.max(0, Math.min(100, Math.round(n)))
}

function seasonOf(iso: string | null): string {
  const d = iso ? new Date(iso) : new Date()
  const m = d.getMonth() // 0-11
  if (m >= 2 && m <= 4) return 'spring'
  if (m >= 5 && m <= 7) return 'summer'
  if (m >= 8 && m <= 10) return 'fall'
  return 'winter'
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

  // Resolve each candidate job's customer/property/service from the source of
  // truth (not the client) — used both to enrich the prompt with cached property
  // intelligence and to capture the asset afterwards. Best-effort.
  const jobMap = new Map<string, JobRow>()
  try {
    const { data: jobRows } = await supabase
      .from('jobs')
      .select('id,customer_id,property_id,service_type,completed_at,scheduled_date')
      .eq('user_id', user.id)
      .in('id', candidates.map(c => c.jobId))
    for (const j of (jobRows as JobRow[]) || []) jobMap.set(j.id, j)
  } catch { /* table/columns unavailable — proceed without context */ }

  // Pull any analysis already on file for these properties — reuse, never
  // re-analyse. Empty when Vision hasn't run / table absent → prompt unchanged.
  const contexts = await getPropertyContexts(
    supabase,
    candidates.map(c => jobMap.get(c.jobId)?.property_id),
  )

  // Optionally shrink images before the model fetches them (images are >90% of
  // the bill). Opt-in: set AI_IMAGE_MAX_EDGE only with Supabase image transforms
  // enabled. Unset → original URLs → identical to before.
  const maxEdge = Number(process.env.AI_IMAGE_MAX_EDGE)
  const img = (url: string) => (maxEdge > 0 ? downscaleImageUrl(url, maxEdge) : url)

  // Build one user turn: a STABLE instruction prefix (cache breakpoint) then,
  // per pair, a label + any known property facts + the before/after images.
  const blocks: Parameters<typeof generateStructured>[0]['blocks'] = [
    {
      type: 'text',
      cache: true,
      text:
        `You are picking the single strongest BEFORE/AFTER pair for a local property-services business to post on social media. ` +
        `There are ${candidates.length} candidate pairs, indexed from 0. For each, the BEFORE photo comes first, then the AFTER. ` +
        `Judge by: how dramatic and obvious the transformation is, clean framing that roughly matches between the two shots, good lighting, ` +
        `and whether it would make a scroller stop. Penalize pairs where before and after look unrelated, are blurry, or show little change. ` +
        `Return a score 0-100 and a one-sentence rationale for each index, the best index overall, and one punchy headline (max 8 words) for the winner.`,
    },
  ]
  candidates.forEach((c, i) => {
    const ctxLine = propertyContextBlock(contexts.get(jobMap.get(c.jobId)?.property_id || ''))
    blocks.push({ type: 'text', text: `--- Pair ${i} — ${c.label} ---${ctxLine ? `\n${ctxLine}` : ''}\nBEFORE:` })
    blocks.push({ type: 'image', url: img(c.beforeUrl) })
    blocks.push({ type: 'text', text: 'AFTER:' })
    blocks.push({ type: 'image', url: img(c.afterUrl) })
  })

  const result = await generateStructured<AiResult>({
    blocks,
    tier: 'vision',
    cacheTools: true,
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
      score: r ? clampScore(r.score) : 0,
      rationale: r?.rationale || '',
    }
  })
  const best = candidates[result.bestIndex]
  const headline = result.headline || ''

  // ── Capture the AI result as reusable marketing assets (don't discard it) ───
  // One row per ranked pair, upserted on (user_id, job_id). The winner keeps the
  // headline. Best-effort: a missing table / FK never affects the response, and
  // we deliberately don't send `status` so a row the owner already acted on
  // (used/dismissed) keeps its state.
  try {
    const assetRows = candidates.map((c, i) => {
      const j = jobMap.get(c.jobId)
      const r = byIndex.get(i)
      const isWinner = i === result.bestIndex
      const rationale = r?.rationale || ''
      return {
        user_id: user.id,
        job_id: c.jobId,
        customer_id: j?.customer_id ?? null,
        property_id: j?.property_id ?? null,
        service_type: j?.service_type ?? null,
        neighborhood: c.neighborhood ?? null,
        season: seasonOf(j?.completed_at ?? j?.scheduled_date ?? null),
        quality_score: r ? clampScore(r.score) : null,
        has_before: true,
        has_after: true,
        best_before_photo_id: c.beforePhotoId ?? null,
        best_after_photo_id: c.afterPhotoId ?? null,
        ai_rationale: isWinner && headline ? `${headline} — ${rationale}`.trim() : rationale,
      }
    })
    await supabase.from('marketing_assets').upsert(assetRows, { onConflict: 'user_id,job_id' })
  } catch { /* persistence is best-effort — never block the AI result */ }

  return NextResponse.json({
    ok: true,
    bestJobId: best ? best.jobId : ranking.slice().sort((a, b) => b.score - a.score)[0]?.jobId,
    headline,
    ranking,
  })
}
