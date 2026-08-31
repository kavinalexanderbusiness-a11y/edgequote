import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { answerOperatorQuestion } from '@/lib/operator/engine'
import { validateContextRefs } from '@/lib/operator/types'

export const dynamic = 'force-dynamic'

// Trailing-hour ceiling per business. Generous for a human owner (one question
// a minute, all hour), a hard floor under scripted or runaway spend.
const RUNS_PER_HOUR = 60

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
    // Cost floor: one question fans out up to ~10 tenant reads plus one paid
    // model call, so the trailing hour is counted from the run history itself
    // (the beta-signup / portal-access shape: count rows, 429 past the line).
    // Best-effort while the Phase-1 migration is unapplied — a missing table
    // must not take the read-only answer down, but once the table exists the
    // limit is real because EVERY run is recorded (see below).
    const hourAgo = new Date(Date.now() - 3_600_000).toISOString()
    const { count, error: countError } = await supabase.from('operator_runs')
      .select('id', { count: 'exact', head: true })
      .eq('user_id', user.id).gte('created_at', hourAgo)
    if (!countError && (count ?? 0) >= RUNS_PER_HOUR) {
      return NextResponse.json({ error: 'Operator is rate-limited for this hour. Please try again later.' }, { status: 429 })
    }

    const answer = await answerOperatorQuestion(supabase, user.id, body.question, body.context)

    // Operator telemetry is business metadata, not a business-record mutation.
    // The id is server-generated when the client omits one so that no caller can
    // opt out of the run history (and therefore out of the rate limit above);
    // a client-supplied id still deduplicates that client's double-submits.
    // Best-effort: missing-table errors must never make the answer unavailable.
    const idempotencyKey = body.requestId ?? `server:${crypto.randomUUID()}`
    await supabase.from('operator_runs').upsert({
      user_id: user.id,
      initiated_by: user.id,
      idempotency_key: idempotencyKey,
      question: body.question,
      answer: answer.answer,
      status: 'completed',
      completed_at: new Date().toISOString(),
      tools_used: answer.tools_used,
    }, { onConflict: 'user_id,idempotency_key', ignoreDuplicates: true }).then(() => undefined, () => undefined)
    return NextResponse.json(answer)
  } catch (error) {
    // The message goes to the server log only: provider failures name API keys,
    // model ids and timeouts, none of which belong in a browser response.
    console.error('[operator] run failed:', error instanceof Error ? error.message : error)
    return NextResponse.json({ error: 'Operator could not verify the requested data. No action was taken.' }, { status: 500 })
  }
}
