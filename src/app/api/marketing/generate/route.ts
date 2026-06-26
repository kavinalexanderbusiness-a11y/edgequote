import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { aiEnabled, generateStructured } from '@/lib/ai/anthropic'
import { assembleCandidate } from '@/lib/marketing/data'
import { buildGenerateInput, PROMPT_VERSION } from '@/lib/marketing/prompt'
import { deriveBrandVoice, type BrandSource } from '@/lib/marketing/brandVoice'
import { isChannel } from '@/lib/marketing/channels'
import { seasonOf } from '@/lib/marketing/score'
import type { GeneratedDraft, GenerateResponse, ContentPiece } from '@/lib/marketing/types'

// Generate one channel post from a completed job. The owner's session scopes every
// read (RLS); we assemble the candidate, draft in the owner's brand voice, then
// persist a marketing_assets anchor (upsert, one per job) + a content_pieces draft.
// Nothing is sent or published — the draft is the owner's to edit and post.
export async function POST(req: NextRequest): Promise<NextResponse> {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ ok: false, aiEnabled: aiEnabled(), error: 'unauthorized' } satisfies GenerateResponse, { status: 401 })

  const body = await req.json().catch(() => ({}))
  const jobId = String(body.jobId || '')
  const channel = body.channel
  if (!jobId || !isChannel(channel)) {
    return NextResponse.json({ ok: false, aiEnabled: aiEnabled(), error: 'bad request' } satisfies GenerateResponse, { status: 400 })
  }
  if (!aiEnabled()) {
    return NextResponse.json({ ok: false, aiEnabled: false, error: 'AI is not configured yet.' } satisfies GenerateResponse)
  }

  const candidate = await assembleCandidate(supabase, user.id, jobId)
  if (!candidate) {
    return NextResponse.json({ ok: false, aiEnabled: true, error: 'job not found' } satisfies GenerateResponse, { status: 404 })
  }

  const { data: bizRow } = await supabase.from('business_settings')
    .select('company_name, owner_name, phone, website, email_primary, base_address, review_url')
    .eq('user_id', user.id).maybeSingle()
  const voice = deriveBrandVoice(bizRow as BrandSource | null)

  const input = buildGenerateInput(candidate, channel, voice)
  const result = await generateStructured<GeneratedDraft>({
    system: input.system,
    prompt: input.prompt,
    toolName: input.toolName,
    toolDescription: input.toolDescription,
    schema: input.schema,
  })
  if (!result.ok) {
    return NextResponse.json({ ok: false, aiEnabled: true, error: result.error || 'generation failed' } satisfies GenerateResponse, { status: 502 })
  }

  const draft = result.data
  const hashtags = Array.isArray(draft.hashtags) ? draft.hashtags.map(h => String(h).replace(/^#/, '').trim()).filter(Boolean).slice(0, 8) : []

  // Anchor the asset (idempotent: one row per job). status stays 'candidate' until
  // the owner publishes — generating a draft isn't publishing.
  const { data: assetRow } = await supabase.from('marketing_assets')
    .upsert({
      user_id: user.id,
      job_id: candidate.jobId,
      customer_id: candidate.customerId,
      property_id: candidate.propertyId,
      service_type: candidate.serviceType,
      neighborhood: candidate.neighborhood,
      season: seasonOf(candidate.date),
      quality_score: candidate.score,
      has_before: candidate.hasBefore,
      has_after: candidate.hasAfter,
      best_before_photo_id: candidate.bestBeforePhotoId,
      best_after_photo_id: candidate.bestAfterPhotoId,
      ai_rationale: candidate.rationale,
    }, { onConflict: 'user_id,job_id' })
    .select('id').maybeSingle()
  const assetId = (assetRow as { id: string } | null)?.id ?? null

  const { data: pieceRow, error: pieceErr } = await supabase.from('content_pieces')
    .insert({
      user_id: user.id,
      asset_id: assetId,
      job_id: candidate.jobId,
      customer_id: candidate.customerId,
      channel,
      kind: 'organic',
      title: draft.title?.trim() || null,
      body: draft.body?.trim() || '',
      hashtags,
      status: 'draft',
      model: result.model,
      prompt_version: PROMPT_VERSION,
    })
    .select('*').single()
  if (pieceErr || !pieceRow) {
    return NextResponse.json({ ok: false, aiEnabled: true, error: 'could not save draft' } satisfies GenerateResponse, { status: 500 })
  }

  return NextResponse.json({ ok: true, aiEnabled: true, piece: pieceRow as ContentPiece } satisfies GenerateResponse)
}
