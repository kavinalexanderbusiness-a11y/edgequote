import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { aiEnabled, generateStructured } from '@/lib/ai/studioGateway'
import { assembleCandidate, loadBrandVoice, upsertAsset, insertPiece } from '@/lib/marketing/data'
import { buildGenerateInput, PROMPT_VERSION } from '@/lib/marketing/prompt'
import { CHANNELS } from '@/lib/marketing/channels'
import { normalizePostOptions, type ContentPiece, type GeneratedDraft, type GenerateAllResponse } from '@/lib/marketing/types'

// Generate all platforms in one click. Assembles the candidate + brand voice once,
// upserts the asset anchor once, then drafts EVERY channel in parallel through the
// same structured-generation path the single route uses (no new prompt, no new model
// plumbing — just a fan-out). Each channel's failure is isolated: one platform can
// fail and the rest still come back. Nothing is sent or published.
export const maxDuration = 60

export async function POST(req: NextRequest): Promise<NextResponse> {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) {
    return NextResponse.json({ ok: false, aiEnabled: aiEnabled(), pieces: [], errors: [] } satisfies GenerateAllResponse, { status: 401 })
  }

  const body = await req.json().catch(() => ({}))
  const jobId = String(body.jobId || '')
  const options = normalizePostOptions(body.options)
  if (!jobId) {
    return NextResponse.json({ ok: false, aiEnabled: aiEnabled(), pieces: [], errors: [] } satisfies GenerateAllResponse, { status: 400 })
  }
  if (!aiEnabled()) {
    return NextResponse.json({ ok: false, aiEnabled: false, pieces: [], errors: [] } satisfies GenerateAllResponse)
  }

  const candidate = await assembleCandidate(supabase, user.id, jobId)
  if (!candidate) {
    return NextResponse.json({ ok: false, aiEnabled: true, pieces: [], errors: [] } satisfies GenerateAllResponse, { status: 404 })
  }

  const voice = await loadBrandVoice(supabase, user.id)

  // One anchor for all channels, so six parallel writes don't race the same upsert.
  const assetId = await upsertAsset(supabase, user.id, candidate)

  type Outcome = { piece: ContentPiece } | { channel: typeof CHANNELS[number]['key']; error: string }
  const results = await Promise.all(CHANNELS.map(async (def): Promise<Outcome> => {
    const input = buildGenerateInput(candidate, def.key, voice, options)
    const result = await generateStructured<GeneratedDraft>({
      system: input.system,
      prompt: input.prompt,
      toolName: input.toolName,
      toolDescription: input.toolDescription,
      schema: input.schema,
    })
    if (!result.ok) return { channel: def.key, error: result.error || 'generation failed' }
    const piece = await insertPiece(supabase, user.id, candidate, def.key, assetId, {
      title: result.data.title ?? null,
      body: result.data.body ?? '',
      hashtags: Array.isArray(result.data.hashtags) ? result.data.hashtags : [],
      model: result.model,
      promptVersion: PROMPT_VERSION,
      meta: { options, batch: true },
    })
    if (!piece) return { channel: def.key, error: 'could not save draft' }
    return { piece }
  }))

  const pieces = results.flatMap(r => ('piece' in r ? [r.piece] : []))
  const errors = results.flatMap(r => ('error' in r ? [{ channel: r.channel, error: r.error }] : []))
  return NextResponse.json({ ok: pieces.length > 0, aiEnabled: true, pieces, errors } satisfies GenerateAllResponse)
}
