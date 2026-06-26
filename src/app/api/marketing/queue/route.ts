import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { aiEnabled, generateStructured } from '@/lib/ai/studioGateway'
import { listCandidates, loadBrandVoice, upsertAsset, insertPiece, type PieceAnchor } from '@/lib/marketing/data'
import { buildPostInput, subjectFromCandidate, type GenSubject, PROMPT_VERSION } from '@/lib/marketing/prompt'
import { campaignSubject } from '@/lib/marketing/campaigns'
import { isChannel } from '@/lib/marketing/channels'
import { listRecentPieces, setSchedule } from '@/lib/marketing/library'
import { normalizePostOptions, type ContentPiece, type GeneratedDraft, type MarketingCandidate, type MarketingChannel, type PostLength, type QueueResponse } from '@/lib/marketing/types'

export const maxDuration = 120

// Smart Publishing Queue — generate (and schedule) a batch of VARIED posts in one go,
// e.g. a month of content. Variety is engineered, not hoped for: each post rotates the
// anchor job, the channel, the length, and a distinct angle, and is told to read unlike
// the recent posts. Reuses the same prompt framework + gateway as everything else.

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

  // Anti-repetition context: a few recent post openings the model should avoid echoing.
  const recentSnippets = recent.map(p => p.body.replace(/\s+/g, ' ').trim().slice(0, 90)).filter(Boolean).slice(0, 6)
  const avoidBlock = recentSnippets.length
    ? `Make this DISTINCT from the business's recent posts — do NOT reuse their opening lines or structure:\n${recentSnippets.map(s => `- "${s}…"`).join('\n')}`
    : ''

  // Build the plan. Cycle candidates so a small job pool still yields varied posts;
  // if there are no candidates at all, fall back to themed seasonal subjects.
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
    const directive = [`Content-plan post. Angle: ${p.angle}`, avoidBlock].filter(Boolean).join('\n\n')
    const postOptions = { ...options, length: p.length }
    const input = buildPostInput(subject, p.channel, voice, postOptions, directive)
    const result = await generateStructured<GeneratedDraft>({
      system: input.system, prompt: input.prompt,
      toolName: input.toolName, toolDescription: input.toolDescription, schema: input.schema,
    })
    if (!result.ok) return { error: `${p.channel}: ${result.error || 'generation failed'}` }
    const assetId = p.candidate ? await assetFor(p.candidate) : null
    const anchor: PieceAnchor = p.candidate ?? { jobId: null, customerId: null, date: null }
    let piece = await insertPiece(supabase, userId, anchor, p.channel, assetId, {
      title: result.data.title ?? null,
      body: result.data.body ?? '',
      hashtags: Array.isArray(result.data.hashtags) ? result.data.hashtags : [],
      model: result.model,
      promptVersion: PROMPT_VERSION,
      season: p.candidate?.season ?? null,
      meta: { options: postOptions, queue: true, angle: p.angle },
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
