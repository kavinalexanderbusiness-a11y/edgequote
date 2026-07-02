import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { aiEnabled, generateStructured, streamText } from '@/lib/ai/studioGateway'
import { loadBrandVoice, persistDraft } from '@/lib/marketing/data'
import { assembleIntelligence, intelligenceSubject } from '@/lib/marketing/intelligence'
import { buildPostInput, buildPostStreamInput, PROMPT_VERSION, STREAM_PROMPT_VERSION } from '@/lib/marketing/prompt'
import { buildGenerationContext } from '@/lib/marketing/generation'
import { scorePost, improvementNote } from '@/lib/marketing/quality'
import { listRecentPieces } from '@/lib/marketing/library'
import { channel as channelDef, isChannel } from '@/lib/marketing/channels'
import { normalizePostOptions, type GeneratedDraft } from '@/lib/marketing/types'

export const maxDuration = 60

// Streaming generation — the "watch it write" path. Streams the first draft live, then
// scores it; if it's weak it silently regenerates ONCE (structured) and emits the
// stronger version as the final piece. So the owner sees it write, then it settles to a
// post that has passed the quality bar.
//   {"t":"delta","text":"…"}      live text
//   {"t":"polishing"}              scored low → improving before showing
//   {"t":"done","piece":{…}}       the saved content_pieces row
//   {"t":"error","error":"…"}      something went wrong

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
  if (!body && hashtags.length) return { body: trimmed.trim(), hashtags: [] }
  return { body, hashtags }
}

export async function POST(req: NextRequest): Promise<Response> {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ ok: false, aiEnabled: aiEnabled(), error: 'unauthorized' }, { status: 401 })

  const body = await req.json().catch(() => ({}))
  const jobId = String(body.jobId || '')
  const ch = body.channel
  const options = normalizePostOptions(body.options)
  if (!jobId || !isChannel(ch)) return NextResponse.json({ ok: false, aiEnabled: aiEnabled(), error: 'bad request' }, { status: 400 })
  if (!aiEnabled()) return NextResponse.json({ ok: false, aiEnabled: false, error: 'AI is not configured yet.' })

  const intel = await assembleIntelligence(supabase, user.id, jobId)
  if (!intel) return NextResponse.json({ ok: false, aiEnabled: true, error: 'job not found' }, { status: 404 })
  const candidate = intel.candidate

  const [voice, recent] = await Promise.all([
    loadBrandVoice(supabase, user.id),
    listRecentPieces(supabase, user.id, 8),
  ])
  const subject = intelligenceSubject(intel, voice)
  const { extras, ctaIntent, scoreCtx } = buildGenerationContext({
    channel: ch, options, recent,
    neighborhood: candidate.neighborhood, city: candidate.city,
    hasReview: candidate.hasReview, recurring: intel.recurring, seasonStart: intel.seasonStart,
  })
  const def = channelDef(ch)
  const useTags = def.usesHashtags && options.hashtags

  const encoder = new TextEncoder()
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const emit = (obj: unknown) => controller.enqueue(encoder.encode(JSON.stringify(obj) + '\n'))
      const streamInput = buildPostStreamInput(subject, ch, voice, options, null, extras)
      const result = await streamText(
        { system: streamInput.system, prompt: streamInput.prompt, maxTokens: streamInput.maxTokens },
        delta => emit({ t: 'delta', text: delta }),
      )
      if (!result.ok) { emit({ t: 'error', error: result.error || 'generation failed' }); controller.close(); return }

      let { body: postBody, hashtags } = splitStreamedPost(result.data, useTags)
      const firstScore = scorePost({ body: postBody, hashtags }, scoreCtx)
      let score = firstScore
      let promptVersion = STREAM_PROMPT_VERSION
      let regenerated = false
      let title: string | null = null
      let model = result.model
      let note = improvementNote(firstScore, firstScore, false)

      // Weak draft → one silent structured regeneration, keep the better.
      if (!score.pass) {
        emit({ t: 'polishing' })
        const fix = firstScore.flags.slice(0, 3).join('; ') || 'it read as generic'
        const retry = buildPostInput(subject, ch, voice, options,
          `Your previous attempt scored ${firstScore.total}/100 and was weak (${fix}). Write a clearly DIFFERENT, stronger version: a fresher hook, no banned phrases, more specific.`, extras)
        const r2 = await generateStructured<GeneratedDraft>(retry)
        if (r2.ok) {
          const s2 = scorePost(r2.data, scoreCtx)
          if (s2.total >= firstScore.total) {
            postBody = r2.data.body ?? postBody
            hashtags = Array.isArray(r2.data.hashtags) ? r2.data.hashtags : hashtags
            title = r2.data.title ?? null
            score = s2; regenerated = true; promptVersion = PROMPT_VERSION; model = r2.model
            note = improvementNote(firstScore, s2, true)
            emit({ t: 'note', note })
          }
        }
      }

      const piece = await persistDraft(supabase, user.id, candidate, ch, {
        title,
        body: postBody,
        hashtags,
        model,
        promptVersion,
        meta: { options, style: options.style, ctaIntent, quality: score, qualityNote: note, regenerated },
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