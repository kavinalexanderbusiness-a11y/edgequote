import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { aiEnabled, generateStructured } from '@/lib/ai/studioGateway'
import { loadBrandVoice, persistDraft } from '@/lib/marketing/data'
import { assembleIntelligence, intelligenceSubject } from '@/lib/marketing/intelligence'
import { buildPostInput, PROMPT_VERSION } from '@/lib/marketing/prompt'
import { buildGenerationContext, generateScoredDraft, joinDirectives } from '@/lib/marketing/generation'
import { listRecentPieces } from '@/lib/marketing/library'
import { isChannel } from '@/lib/marketing/channels'
import { normalizePostOptions, type GeneratedDraft, type GenerateResponse } from '@/lib/marketing/types'

export const maxDuration = 60

// Generate one channel post from a completed job. Assembles the job's intelligence,
// reads recent posts to steer away from them (anti-repetition + CTA rotation), drafts
// in the brand voice + chosen style, scores the result, and regenerates once if it's
// weak — so the owner only ever sees a strong post.
export async function POST(req: NextRequest): Promise<NextResponse> {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ ok: false, aiEnabled: aiEnabled(), error: 'unauthorized' } satisfies GenerateResponse, { status: 401 })

  const body = await req.json().catch(() => ({}))
  const jobId = String(body.jobId || '')
  const channel = body.channel
  const options = normalizePostOptions(body.options)
  if (!jobId || !isChannel(channel)) {
    return NextResponse.json({ ok: false, aiEnabled: aiEnabled(), error: 'bad request' } satisfies GenerateResponse, { status: 400 })
  }
  if (!aiEnabled()) {
    return NextResponse.json({ ok: false, aiEnabled: false, error: 'AI is not configured yet.' } satisfies GenerateResponse)
  }

  const intel = await assembleIntelligence(supabase, user.id, jobId)
  if (!intel) {
    return NextResponse.json({ ok: false, aiEnabled: true, error: 'job not found' } satisfies GenerateResponse, { status: 404 })
  }
  const candidate = intel.candidate

  const [voice, recent] = await Promise.all([
    loadBrandVoice(supabase, user.id),
    listRecentPieces(supabase, user.id, 8),
  ])
  const subject = intelligenceSubject(intel, voice)
  const { extras, ctaIntent, scoreCtx } = buildGenerationContext({
    channel, options, recent,
    neighborhood: candidate.neighborhood, city: candidate.city,
    hasReview: candidate.hasReview, recurring: intel.recurring, seasonStart: intel.seasonStart,
  })

  const run = (extra: string | null) => generateStructured<GeneratedDraft>(
    buildPostInput(subject, channel, voice, options, joinDirectives(null, extra), extras),
  )
  const out = await generateScoredDraft(run, scoreCtx)
  if (!out.ok) {
    return NextResponse.json({ ok: false, aiEnabled: true, error: out.error } satisfies GenerateResponse, { status: 502 })
  }
  const { draft, score, regenerated, note } = out.result

  const piece = await persistDraft(supabase, user.id, candidate, channel, {
    title: draft.title ?? null,
    body: draft.body ?? '',
    hashtags: Array.isArray(draft.hashtags) ? draft.hashtags : [],
    model: out.result.model,
    promptVersion: PROMPT_VERSION,
    meta: { options, style: options.style, ctaIntent, quality: score, qualityNote: note, regenerated },
  })
  if (!piece) {
    return NextResponse.json({ ok: false, aiEnabled: true, error: 'could not save draft' } satisfies GenerateResponse, { status: 500 })
  }
  return NextResponse.json({ ok: true, aiEnabled: true, piece } satisfies GenerateResponse)
}