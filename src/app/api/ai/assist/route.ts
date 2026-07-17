import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { aiEnabled, streamText } from '@/lib/ai/studioGateway'
import { ndjsonResponse } from '@/lib/ai/stream'
import { buildAssistInput, type AssistPayload, type AssistTask } from '@/lib/ai/assist'

export const maxDuration = 60

// ── /api/ai/assist — THE in-app writing-assist endpoint ──────────────────────
// One route for every assist task (see lib/ai/assist.ts). Auth-scoped; all
// context is re-derived server-side from ids — client-sent text is treated as
// a draft to improve, never as fact. Streams NDJSON like the marketing
// generator, so composers get the same "watch it write" feel:
//   {"t":"delta","text":"…"}   live text
//   {"t":"done","text":"…"}    full accumulated text
//   {"t":"error","error":"…"}
// GET reports capability so client surfaces can hide themselves entirely when
// no ANTHROPIC_API_KEY is configured (the app's disabled-by-default contract).

const TASKS: AssistTask[] = ['draft_message', 'customer_summary', 'review_response', 'quote_scope', 'job_notes', 'quote_intelligence']

export async function GET(): Promise<Response> {
  return NextResponse.json({ aiEnabled: aiEnabled() })
}

export async function POST(req: NextRequest): Promise<Response> {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ ok: false, aiEnabled: aiEnabled(), error: 'unauthorized' }, { status: 401 })

  const body = (await req.json().catch(() => ({}))) as Partial<AssistPayload>
  if (!body.task || !TASKS.includes(body.task)) {
    return NextResponse.json({ ok: false, aiEnabled: aiEnabled(), error: 'bad request' }, { status: 400 })
  }
  if (!aiEnabled()) return NextResponse.json({ ok: false, aiEnabled: false, error: 'AI is not configured yet.' })

  let input
  try {
    input = await buildAssistInput(supabase, user.id, body as AssistPayload)
  } catch (e) {
    return NextResponse.json({ ok: false, aiEnabled: true, error: e instanceof Error ? e.message : 'bad request' }, { status: 400 })
  }

  return ndjsonResponse(async emit => {
    const result = await streamText(
      { system: input.system, prompt: input.prompt, maxTokens: input.maxTokens, model: input.model },
      delta => emit({ t: 'delta', text: delta }),
    )
    if (!result.ok) emit({ t: 'error', error: result.error || 'generation failed' })
    else emit({ t: 'done', text: result.data.trim() })
  })
}
