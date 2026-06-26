import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { aiEnabled, streamText } from '@/lib/ai/anthropic'
import { assembleCandidate, persistDraft } from '@/lib/marketing/data'
import { buildStreamInput, STREAM_PROMPT_VERSION } from '@/lib/marketing/prompt'
import { deriveBrandVoice, type BrandSource } from '@/lib/marketing/brandVoice'
import { channel as channelDef, isChannel } from '@/lib/marketing/channels'

// Streaming generation — the "watch it write" path. Streams the post text to the
// browser token-by-token as newline-delimited JSON events, then persists the draft
// and emits the saved piece as the final event. Error/disabled cases return plain
// JSON (no stream) so the client can fall back to the non-streaming route.
//
//   {"t":"delta","text":"…"}   repeated, the live post text
//   {"t":"done","piece":{…}}    the saved content_pieces row
//   {"t":"error","error":"…"}   something went wrong mid-stream

// Split a streamed plain-text post into body + trailing hashtags (hashtag channels).
function splitStreamedPost(text: string, usesHashtags: boolean): { body: string; hashtags: string[] } {
  const trimmed = text.replace(/\s+$/, '')
  if (!usesHashtags) return { body: trimmed.trim(), hashtags: [] }
  const lines = trimmed.split('\n')
  const tagLines: string[] = []
  while (lines.length) {
    const last = (lines[lines.length - 1] || '').trim()
    if (last === '') { lines.pop(); continue }
    if (/^#[^\s#]+(\s+#[^\s#]+)*$/.test(last)) { tagLines.unshift(last); lines.pop(); continue }
    break
  }
  const hashtags = tagLines.join(' ').split(/\s+/).map(t => t.replace(/^#/, '').trim()).filter(Boolean).slice(0, 8)
  const body = lines.join('\n').trim()
  if (!body && hashtags.length) return { body: trimmed.trim(), hashtags: [] } // model put it all on one line
  return { body, hashtags }
}

export async function POST(req: NextRequest): Promise<Response> {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ ok: false, aiEnabled: aiEnabled(), error: 'unauthorized' }, { status: 401 })

  const body = await req.json().catch(() => ({}))
  const jobId = String(body.jobId || '')
  const ch = body.channel
  if (!jobId || !isChannel(ch)) {
    return NextResponse.json({ ok: false, aiEnabled: aiEnabled(), error: 'bad request' }, { status: 400 })
  }
  if (!aiEnabled()) {
    return NextResponse.json({ ok: false, aiEnabled: false, error: 'AI is not configured yet.' })
  }

  const candidate = await assembleCandidate(supabase, user.id, jobId)
  if (!candidate) return NextResponse.json({ ok: false, aiEnabled: true, error: 'job not found' }, { status: 404 })

  const { data: bizRow } = await supabase.from('business_settings')
    .select('company_name, owner_name, phone, website, email_primary, base_address, review_url')
    .eq('user_id', user.id).maybeSingle()
  const voice = deriveBrandVoice(bizRow as BrandSource | null)
  const input = buildStreamInput(candidate, ch, voice)
  const def = channelDef(ch)

  const encoder = new TextEncoder()
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const emit = (obj: unknown) => controller.enqueue(encoder.encode(JSON.stringify(obj) + '\n'))
      const result = await streamText(
        { system: input.system, prompt: input.prompt, maxTokens: input.maxTokens },
        delta => emit({ t: 'delta', text: delta }),
      )
      if (!result.ok) {
        emit({ t: 'error', error: result.error || 'generation failed' })
        controller.close()
        return
      }
      const { body: postBody, hashtags } = splitStreamedPost(result.data, def.usesHashtags)
      const piece = await persistDraft(supabase, user.id, candidate, ch, {
        body: postBody,
        hashtags,
        model: result.model,
        promptVersion: STREAM_PROMPT_VERSION,
      })
      if (!piece) emit({ t: 'error', error: 'could not save draft' })
      else emit({ t: 'done', piece })
      controller.close()
    },
  })

  return new Response(stream, {
    headers: {
      'Content-Type': 'application/x-ndjson; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      'X-Accel-Buffering': 'no',
    },
  })
}
