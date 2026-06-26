import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { aiEnabled, generateStructured } from '@/lib/ai/studioGateway'
import { loadBrandVoice } from '@/lib/marketing/data'
import { buildRewriteInput, REWRITE_ACTIONS } from '@/lib/marketing/prompt'
import { isChannel } from '@/lib/marketing/channels'
import type { GeneratedDraft, PostText, RewriteAction, RewriteResponse } from '@/lib/marketing/types'

// One-click AI rewrite. STATELESS: takes the text currently in the editor + an action,
// returns the transformed text. Doesn't read or write the DB — the composer applies the
// result and the owner saves. Reuses the SAME gateway + brand voice as generation; the
// only thing that varies is one instruction line (REWRITE_ACTIONS).
export async function POST(req: NextRequest): Promise<NextResponse> {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ ok: false, aiEnabled: aiEnabled(), error: 'unauthorized' } satisfies RewriteResponse, { status: 401 })

  const body = await req.json().catch(() => ({}))
  const ch = body.channel
  const action = body.action as RewriteAction
  const raw = body.text as Partial<PostText> | undefined
  if (!isChannel(ch) || !action || !(action in REWRITE_ACTIONS) || !raw || typeof raw.body !== 'string' || !raw.body.trim()) {
    return NextResponse.json({ ok: false, aiEnabled: aiEnabled(), error: 'bad request' } satisfies RewriteResponse, { status: 400 })
  }
  if (!aiEnabled()) {
    return NextResponse.json({ ok: false, aiEnabled: false, error: 'AI is not configured yet.' } satisfies RewriteResponse)
  }

  const text: PostText = {
    title: typeof raw.title === 'string' ? raw.title : null,
    body: raw.body,
    hashtags: Array.isArray(raw.hashtags) ? raw.hashtags.map(String) : [],
  }

  const voice = await loadBrandVoice(supabase, user.id)
  const input = buildRewriteInput(text, ch, voice, action)
  const result = await generateStructured<GeneratedDraft>({
    system: input.system,
    prompt: input.prompt,
    toolName: input.toolName,
    toolDescription: input.toolDescription,
    schema: input.schema,
  })
  if (!result.ok) {
    return NextResponse.json({ ok: false, aiEnabled: true, error: result.error || 'rewrite failed' } satisfies RewriteResponse, { status: 502 })
  }

  const d = result.data
  return NextResponse.json({
    ok: true,
    aiEnabled: true,
    text: {
      title: d.title ?? null,
      body: d.body ?? text.body,
      hashtags: Array.isArray(d.hashtags) ? d.hashtags.map(h => String(h).replace(/^#/, '').trim()).filter(Boolean) : [],
    },
  } satisfies RewriteResponse)
}
