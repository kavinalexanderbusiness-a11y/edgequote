import { type PilotStore, record, uuid } from './pilotEmailStore'

export interface PilotOwnerAuth {
  // Supplied by trusted server code using Supabase auth.getUser(), never from a
  // request's owner ID, cached session field or proposed approval boolean.
  getUser(): Promise<{ data: { user: { id: string } | null }; error: unknown }>
}

type OwnerResult = { status: number; body: Record<string, unknown> }
const unavailable = (): OwnerResult => ({ status: 503, body: { error: 'Could not update email follow-up. Try again.' } })

function validSteps(steps: unknown[]): boolean {
  return steps.every(value => {
    const step = record(value)
    return !!step && !Object.keys(step).some(key => !['subject', 'text', 'html', 'due_at'].includes(key))
      && typeof step.subject === 'string' && step.subject.trim().length > 0 && step.subject.length <= 500
      && !/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/.test(step.subject)
      && typeof step.text === 'string' && step.text.trim().length > 0 && step.text.length <= 30_000
      && (!('html' in step) || (typeof step.html === 'string' && step.html.length > 0 && step.html.length <= 100_000))
      && typeof step.due_at === 'string' && step.due_at.length <= 80 && Number.isFinite(Date.parse(step.due_at))
  })
}

async function requestBody(request: Request): Promise<Record<string, unknown> | null> {
  if (request.method !== 'POST' || !request.headers.get('content-type')?.startsWith('application/json')) return null
  const origin = request.headers.get('origin')
  if ((origin && origin !== new URL(request.url).origin) || request.headers.get('sec-fetch-site') === 'cross-site') return null
  if (!request.body) return null
  const reader = request.body.getReader(), chunks: Uint8Array[] = []
  let length = 0, timer: ReturnType<typeof setTimeout> | undefined
  const read = async () => {
    try {
      while (true) {
        const next = await reader.read()
        if (next.done) return record(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks, length))))
        length += next.value.length
        if (length > 300_000) { await reader.cancel(); return null }
        chunks.push(next.value)
      }
    } catch { return null }
  }
  const timeout = new Promise<null>(resolve => { timer = setTimeout(() => { void reader.cancel().catch(() => {}); resolve(null) }, 10_000) })
  try { return await Promise.race([read(), timeout]) } finally { clearTimeout(timer) }
}

// Dormant handler: no application route mounts it. This is approval only; it
// cannot activate a connection, choose credentials, run transport or send now.
export async function approvePilotEmailRequest(store: PilotStore, auth: PilotOwnerAuth, request: Request): Promise<OwnerResult> {
  try {
    const identity = await auth.getUser()
    if (identity.error || !identity.data.user || !uuid(identity.data.user.id)) return { status: 401, body: { error: 'Sign in to continue.' } }
    const body = await requestBody(request)
    if (!body || Object.keys(body).some(k => !['connectionId', 'customerId', 'quoteId', 'steps'].includes(k))
      || !uuid(body.connectionId) || !uuid(body.customerId) || !uuid(body.quoteId) || !Array.isArray(body.steps)
      || body.steps.length < 1 || body.steps.length > 2 || !validSteps(body.steps)) return { status: 400, body: { error: 'Check the follow-up details.' } }
    const connection = await store.connection(body.connectionId)
    if (!connection || connection.user_id !== identity.data.user.id) return { status: 404, body: { error: 'Email connection not found.' } }
    const result = await store.rpc('pilot_email_approve_workflow', {
      p_connection: connection.id, p_customer: body.customerId, p_quote: body.quoteId,
      p_steps: body.steps, p_approved_by: identity.data.user.id,
    })
    if (['approved', 'existing'].includes(String(result.code)) && uuid(result.workflow_id)) {
      const workflow = await store.workflow(result.workflow_id)
      if (workflow?.user_id === identity.data.user.id && workflow.state === 'approved') {
        return { status: 200, body: { workflowId: result.workflow_id, state: 'approved' } }
      }
    }
    return { status: 409, body: { error: 'The quote or email connection changed. Review it before approving follow-up.' } }
  } catch { return unavailable() }
}

export async function pausePilotEmailRequest(store: PilotStore, auth: PilotOwnerAuth, request: Request): Promise<OwnerResult> {
  try {
    const identity = await auth.getUser()
    if (identity.error || !identity.data.user || !uuid(identity.data.user.id)) return { status: 401, body: { error: 'Sign in to continue.' } }
    const body = await requestBody(request)
    if (!body || Object.keys(body).some(k => k !== 'workflowId') || !uuid(body.workflowId)) return { status: 400, body: { error: 'Choose a follow-up to pause.' } }
    const workflow = await store.workflow(body.workflowId)
    if (!workflow || workflow.user_id !== identity.data.user.id) return { status: 404, body: { error: 'Follow-up not found.' } }
    const result = await store.rpc('pilot_email_hold_workflow', { p_workflow: workflow.id, p_reason: 'owner_paused' })
    return result.code === 'held' ? { status: 200, body: { state: 'paused' } } : unavailable()
  } catch { return unavailable() }
}
