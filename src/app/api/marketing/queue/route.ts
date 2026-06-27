import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { aiEnabled, generateStructured } from '@/lib/ai/studioGateway'
import { listCandidates, loadBrandVoice, upsertAsset, insertPiece, type PieceAnchor } from '@/lib/marketing/data'
import { buildPostInput, subjectFromCandidate, type GenSubject, PROMPT_VERSION } from '@/lib/marketing/prompt'
import { buildGenerationContext, generateScoredDraft, joinDirectives } from '@/lib/marketing/generation'
import { campaignSubject } from '@/lib/marketing/campaigns'
import { isChannel } from '@/lib/marketing/channels'
import { listRecentPieces, setSchedule } from '@/lib/marketing/library'
import { normalizePostOptions, type ContentPiece, type GeneratedDraft, type MarketingCandidate, type MarketingChannel, type PostLength, type QueueResponse } from '@/lib/marketing/types'

export const maxDuration = 120

// Smart Publishing Queue — generate (and schedule) a batch of VARIED posts in one go,
// e.g. a month of content. Variety is engineered: each post rotates the anchor job, the
// channel, the length, a distinct angle, and the CTA, and carries the anti-repetition
// memory so the feed never reads the same. Each post is scored (stored on the piece);
// to keep a 16-post batch affordable, the queue does NOT auto-regenerate — the owner can
// regenerate any single post from the composer.

const MAX_COUNT = 16
const ROTATION: MarketingChannel[] = ['facebook', 'instagram', 'gbp', 'nextdoor', 'threads', 'linkedin']
const LENGTHS: PostLength[] = ['medium', 'short', 'long']
const ANGLES = [
  'Lead with the visible result / before-and-after.',
  'Focus on reliability and showing up on schedule.',
  'Make it about the neighbourhood and being local.',
  'Share one quick, genuinely useful lawn/yard tip.',
  'A warm, friendly check-in with the community.',
  'Lean on social proof — happy customers and reviews.',
]

function addDays(dateStr: string, n: number): string {
  const d = new Date(dateStr + 'T00:00:00')
  d.setDate(d.getDate() + n)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

async function inChunks<T, R>(items: T[], size: number, fn: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const out: R[] = []
  for (let i = 0; i < items.length; i += size) {
    const batch = items.slice(i, i + size)
    out.push(...await Promise.all(batch.map((it, j) => fn(it, i + j))))
  }
  return out
}

export async function POST(req: NextRequest): Promise<NextResponse> {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ ok: false, aiEnabled: aiEnabled(), pieces: [], errors: [] } satisfies QueueResponse, { status: 401 })

  const body = await req.json().catch(() => ({}))
  const count = Math.max(1, Math.min(MAX_COUNT, Number(body.count) || 8))
  const options = normalizePostOptions(body.options)
  const reqChannels = Array.isArray(body.channels) ? (body.channels as unknown[]).filter(isChannel) as MarketingChannel[] : []
  const channels = reqChannels.length ? reqChannels : ROTATION
  const everyDays = Math.max(1, Math.min(14, Number(body.everyDays) || 2))
  const startDate: string | null = typeof body.startDate === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(body.startDate) ? body.startDate : null

  if (!aiEnabled()) return NextResponse.json({ ok: false, aiEnabled: false, pieces: [], errors: [] } satisfies QueueResponse)

  const userId = user.id
  const voice = await loadBrandVoice(supabase, userId)
  const [candidates, recent] = await Promise.all([
    listCandidates(supabase, userId),
    listRecentPieces(supabase, userId, 12),
  ])

  const assetCache = new Map<string, string | null>()
  async function assetFor(c: MarketingCandidate): Promise<string | null> {
    if (assetCache.has(c.jobId)) return assetCache.get(c.jobId)!
    const id = await upsertAsset(supabase, userId, c)
    assetCache.set(c.jobId, id)
    return id
  }

  const plan = Array.from({ length: count }, (_, i) => ({
    index: i,
    channel: channels[i % channels.length],
    length: LENGTHS[i % LENGTHS.length],
    angle: ANGLES[i % ANGLES.length],
    candidate: candidates.length ? candidates[i % candidates.length] : null,
  }))

  type Outcome = { piece: ContentPiece } | { error: string }
  const results = await inChunks(plan, 4, async (p): Promise<Outcome> => {
    const subject: GenSubject = p.candidate ? subjectFromCandidate(p.candidate) : campaignSubject('custom', voice, {})
    const postOptions = { ...options, length: p.length }
    const { extras, ctaIntent, scoreCtx } = buildGenerationContext({
      channel: p.channel, options: postOptions, recent,
      neighborhood: p.candidate?.neighborhood ?? null, city: p.candidate?.city ?? voice.city,
      hasReview: p.candidate?.hasReview ?? false, recurring: false, seasonStart: false,
      ctaOffset: p.index,
    })
    const directive = `Content-plan post. Angle: ${p.angle}`
    const run = (extra: string | null) => generateStructured<GeneratedDraft>(
      buildPostInput(subject, p.channel, voice, postOptions, joinDirectives(directive, extra), extras),
    )
    const out = await generateScoredDraft(run, scoreCtx, { regenerate: false })
    if (!out.ok) return { error: `${p.channel}: ${out.error}` }
    const { draft, score, regenerated, note } = out.result

    const assetId = p.candidate ? await assetFor(p.candidate) : null
    const anchor: PieceAnchor = p.candidate ?? { jobId: null, customerId: null, date: null }
    let piece = await insertPiece(supabase, userId, anchor, p.channel, assetId, {
      title: draft.title ?? null,
      body: draft.body ?? '',
      hashtags: Array.isArray(draft.hashtags) ? draft.hashtags : [],
      model: out.result.model,
      promptVersion: PROMPT_VERSION,
      season: p.candidate?.season ?? null,
      meta: { options: postOptions, style: postOptions.style, ctaIntent, queue: true, angle: p.angle, quality: score, qualityNote: note, regenerated },
    })
    if (!piece) return { error: `${p.channel}: could not save draft` }
    if (startDate) {
      const scheduled = await setSchedule(supabase, piece.id, `${addDays(startDate, p.index * everyDays)}T09:00:00.000Z`)
      if (scheduled) piece = scheduled
    }
    return { piece }
  })

  const pieces = results.flatMap(r => ('piece' in r ? [r.piece] : []))
  const errors = results.flatMap(r => ('error' in r ? [r.error] : []))
  const skipped = !candidates.length ? 'No finished jobs yet — generated general posts instead. Add job photos for richer, proof-of-work content.' : null
  return NextResponse.json({ ok: pieces.length > 0, aiEnabled: true, pieces, errors, skipped } satisfies QueueResponse)
}
