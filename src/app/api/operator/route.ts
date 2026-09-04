import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { answerOperatorQuestion } from '@/lib/operator/engine'
import { validateContextRefs } from '@/lib/operator/types'
import { recordRun } from '@/lib/operator/runLog'

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
    // must not take the read-only answer down. Once the table exists the limit
    // is real for every run the write actually lands; a write that fails after
    // the fact is logged rather than counted (see recordRun).
    const hourAgo = new Date(Date.now() - 3_600_000).toISOString()
    const { count, error: countError } = await supabase.from('operator_runs')
      .select('id', { count: 'exact', head: true })
      .eq('user_id', user.id).gte('created_at', hourAgo)
    if (!countError && (count ?? 0) >= RUNS_PER_HOUR) {
      return NextResponse.json({ error: 'Operator is rate-limited for this hour. Please try again later.' }, { status: 429 })
    }

    // The module is `core: true`, so this route is live for every tenant the
    // moment the code deploys — which can precede the Phase-1 table by a whole
    // landing cycle. In that window the count above cannot run and the upsert
    // below cannot record, so a paid model call would be both uncounted and
    // unattributable. Deny the SPEND, not the answer: the deterministic
    // evidence path needs no model and stays fully available.
    const auditable = !countError
    const { response, audit } = await answerOperatorQuestion(
      supabase, user.id, body.question, body.context, { allowModel: auditable })

    // Operator telemetry is business metadata, not a business-record mutation.
    // The id is server-generated when the client omits one so that no caller can
    // opt out of the run history (and therefore out of the rate limit above);
    // a client-supplied id still deduplicates that client's double-submits.
    // The audit half (provider/model/token spend) is recorded here and NEVER
    // included in the browser response.
    //
    // ⭐⭐ BEST-EFFORT PERSISTENCE, AND SAY SO. The control that bounds spend is
    // the PRE-CHECK above: if the run history cannot be read, no model is
    // called. This write is the separate, after-the-fact half — the answer has
    // already been produced (and, when allowed, already paid for), so a failure
    // here must never take the answer away from the owner.
    //
    // ⛔ It therefore does NOT establish "no audit row ⇒ no spend". The true
    // invariant is "pre-check failed ⇒ no spend". A run CAN succeed, spend, and
    // then fail to record — which is exactly why that outcome is now logged
    // instead of discarded.
    //
    // ⛔⛔ supabase-js RESOLVES on failure ({ data: null, error }); it does not
    // reject. The previous `.then(() => undefined, () => undefined)` put the
    // handler on the REJECTION branch, so the common failures — table absent,
    // RLS refusal, constraint violation — landed on the FULFILLED branch and
    // were dropped without a trace. Both branches are handled below.
    const idempotencyKey = body.requestId ?? `server:${crypto.randomUUID()}`
    await recordRun(supabase, {
      user_id: user.id,
      initiated_by: user.id,
      idempotency_key: idempotencyKey,
      question: body.question,
      answer: response.answer,
      status: 'completed',
      completed_at: new Date().toISOString(),
      tools_used: response.tools_used,
      provider: audit.provider,
      model: audit.model,
      tokens_in: audit.tokens_in,
      tokens_out: audit.tokens_out,
    }, audit)
    return NextResponse.json(response)
  } catch (error) {
    // The message goes to the server log only: provider failures name API keys,
    // model ids and timeouts, none of which belong in a browser response.
    console.error('[operator] run failed:', error instanceof Error ? error.message : error)
    return NextResponse.json({ error: 'Operator could not verify the requested data. No action was taken.' }, { status: 500 })
  }
}
