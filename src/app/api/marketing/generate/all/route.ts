import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { aiEnabled, generateStructured } from '@/lib/ai/studioGateway'
import { loadBrandVoice, upsertAsset, insertPiece } from '@/lib/marketing/data'
import { assembleIntelligence, intelligenceSubject } from '@/lib/marketing/intelligence'
import { buildPostInput, PROMPT_VERSION } from '@/lib/marketing/prompt'
import { buildGenerationContext, generateScoredDraft, joinDirectives } from '@/lib/marketing/generation'
import { listRecentPieces } from '@/lib/marketing/library'
import { CHANNELS } from '@/lib/marketing/channels'
import { normalizePostOptions, type ContentPiece, type GeneratedDraft, type GenerateAllResponse } from '@/lib/marketing/types'

// Generate all platforms in one click. Assembles the job's intelligence + brand voice
// ONCE, then drafts every channel in parallel through the same quality-scored path the
// single route uses — each with platform-specific writing, a rotated CTA (offset per
// channel so they differ), and the same anti-repetition memory. Each channel fails
// independently. Nothing is sent or published.
export const maxDuration = 90

export async function POST(req: NextRequest): Promise<NextResponse> {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ ok: false, aiEnabled: aiEnabled(), pieces: [], errors: [] } satisfies GenerateAllResponse, { status: 401 })

  const body = await req.json().catch(() => ({}))
  const jobId = String(body.jobId || '')
  const options = normalizePostOptions(body.options)
  if (!jobId) return NextResponse.json({ ok: false, aiEnabled: aiEnabled(), pieces: [], errors: [] } satisfies GenerateAllResponse, { status: 400 })
  if (!aiEnabled()) return NextResponse.json({ ok: false, aiEnabled: false, pieces: [], errors: [] } satisfies GenerateAllResponse)

  const intel = await assembleIntelligence(supabase, user.id, jobId)
  if (!intel) return NextResponse.json({ ok: false, aiEnabled: true, pieces: [], errors: [] } satisfies GenerateAllResponse, { status: 404 })
  const candidate = intel.candidate

  const [voice, recent] = await Promise.all([
    loadBrandVoice(supabase, user.id),
    listRecentPieces(supabase, user.id, 8),
  ])
  const subject = intelligenceSubject(intel, voice)
  const assetId = await upsertAsset(supabase, user.id, candidate)

  type Outcome = { piece: ContentPiece } | { channel: typeof CHANNELS[number]['key']; error: string }
  const results = await Promise.all(CHANNELS.map(async (def, i): Promise<Outcome> => {
    const { extras, ctaIntent, scoreCtx } = buildGenerationContext({
      channel: def.key, options, recent,
      neighborhood: candidate.neighborhood, city: candidate.city,
      hasReview: candidate.hasReview, recurring: intel.recurring, seasonStart: intel.seasonStart,
      ctaOffset: i, // each platform gets a different CTA
    })
    const run = (extra: string | null) => generateStructured<GeneratedDraft>(
      buildPostInput(subject, def.key, voice, options, joinDirectives(null, extra), extras),
    )
    const out = await generateScoredDraft(run, scoreCtx)
    if (!out.ok) return { channel: def.key, error: out.error }
    const { draft, score, regenerated, note } = out.result
    const piece = await insertPiece(supabase, user.id, candidate, def.key, assetId, {
      title: draft.title ?? null,
      body: draft.body ?? '',
      hashtags: Array.isArray(draft.hashtags) ? draft.hashtags : [],
      model: out.result.model,
      promptVersion: PROMPT_VERSION,
      meta: { options, style: options.style, ctaIntent, quality: score, qualityNote: note, regenerated, batch: true },
    })
    if (!piece) return { channel: def.key, error: 'could not save draft' }
    return { piece }
  }))

  const pieces = results.flatMap(r => ('piece' in r ? [r.piece] : []))
  const errors = results.flatMap(r => ('error' in r ? [{ channel: r.channel, error: r.error }] : []))
  return NextResponse.json({ ok: pieces.length > 0, aiEnabled: true, pieces, errors } satisfies GenerateAllResponse)
}
