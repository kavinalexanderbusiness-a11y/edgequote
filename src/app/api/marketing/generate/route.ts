import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { aiEnabled, generateStructured } from '@/lib/ai/studioGateway'
import { assembleCandidate, loadBrandVoice, persistDraft } from '@/lib/marketing/data'
import { buildGenerateInput, PROMPT_VERSION } from '@/lib/marketing/prompt'
import { isChannel } from '@/lib/marketing/channels'
import { normalizePostOptions, type GeneratedDraft, type GenerateResponse } from '@/lib/marketing/types'

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
  const options = normalizePostOptions(body.options)
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

  const voice = await loadBrandVoice(supabase, user.id)

  const input = buildGenerateInput(candidate, channel, voice, options)
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
  const piece = await persistDraft(supabase, user.id, candidate, channel, {
    title: draft.title ?? null,
    body: draft.body ?? '',
    hashtags: Array.isArray(draft.hashtags) ? draft.hashtags : [],
    model: result.model,
    promptVersion: PROMPT_VERSION,
    meta: { options },
  })
  if (!piece) {
    return NextResponse.json({ ok: false, aiEnabled: true, error: 'could not save draft' } satisfies GenerateResponse, { status: 500 })
  }
  return NextResponse.json({ ok: true, aiEnabled: true, piece } satisfies GenerateResponse)
}
