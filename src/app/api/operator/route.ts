import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { answerOperatorQuestion } from '@/lib/operator/engine'
import { validateContextRefs } from '@/lib/operator/types'

export const dynamic = 'force-dynamic'

function readBody(raw: unknown): { question: string; context: ReturnType<typeof validateContextRefs>; requestId?: string } | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  const o = raw as Record<string, unknown>
  const question = typeof o.question === 'string' ? o.question.trim() : ''
  if (!question || question.length > 1000) return null
  const requestId = typeof o.request_id === 'string' && /^[a-zA-Z0-9:_-]{8,120}$/.test(o.request_id) ? o.request_id : undefined
  return { question, context: validateContextRefs(o.context), requestId }
}

export async function POST(req: NextRequest) {
  const supabase = await createClient()
  const { data: { user }, error: authError } = await supabase.auth.getUser()
  if (authError || !user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  let parsed: unknown
  try { parsed = await req.json() } catch { return NextResponse.json({ error: 'Invalid JSON body.' }, { status: 400 }) }
  const body = readBody(parsed)
  if (!body) return NextResponse.json({ error: 'Question is required and must be 1–1000 characters.' }, { status: 400 })

  // Tenant identity is NEVER accepted from the body/model. In EdgeQuote's current
  // owner-tenant architecture user.id is the tenant key and RLS independently
  // enforces that same boundary on every application-table read.
  try {
    const answer = await answerOperatorQuestion(supabase, user.id, body.question, body.context)

    // Operator telemetry is business metadata, not a business-record mutation.
    // It is best-effort because the Phase-1 migration may not have landed in the
    // environment serving a preview. Missing-table errors must never make the
    // read-only answer unavailable.
    if (body.requestId) {
      await supabase.from('operator_runs').upsert({
        user_id: user.id,
        initiated_by: user.id,
        idempotency_key: body.requestId,
        question: body.question,
        answer: answer.answer,
        status: 'completed',
        completed_at: new Date().toISOString(),
        tools_used: answer.tools_used,
      }, { onConflict: 'user_id,idempotency_key', ignoreDuplicates: true }).then(() => undefined, () => undefined)
    }
    return NextResponse.json(answer)
  } catch (error) {
    return NextResponse.json({ error: 'Operator could not verify the requested data. No action was taken.', detail: error instanceof Error ? error.message : 'unknown error' }, { status: 500 })
  }
}
