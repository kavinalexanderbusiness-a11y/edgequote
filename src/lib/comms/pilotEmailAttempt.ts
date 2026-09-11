import { reachCheck } from './reach'
import { type PilotStore, type PilotConnection, uuid } from './pilotEmailStore'
import { sendClientEmail, type ClientEmailCredentials } from './pilotEmailTransport'

export type ResolveClientEmailCredentials = (connection: PilotConnection) => Promise<ClientEmailCredentials | null>
export type PilotSendResult = { code: 'finalized'; messageId: string; notificationLogId: string }
  | { code: 'blocked' | 'pending' | 'unavailable' }
export type PilotEmailRuntime = {
  store: PilotStore
  credentials: ResolveClientEmailCredentials
  http?: typeof fetch
  now?: () => number
}

export function credentialsMatch(c: PilotConnection, key: ClientEmailCredentials | null): key is ClientEmailCredentials {
  return !!key && key.connectionId === c.id && key.accountScope === c.account_scope
    && key.credentialVersion === c.credential_version && key.secretRef === c.secret_ref
    && typeof key.apiKey === 'string' && key.apiKey.length > 0
    && typeof key.webhookSecret === 'string' && key.webhookSecret.length > 0
}

// Deliberately receives only an approved workflow/step, never a caller's
// recipient, body, From address, owner ID or arbitrary idempotency key.
// A dedicated, separately approved scheduler must call this; none exists yet.
export async function dispatchApprovedPilotEmail(runtime: PilotEmailRuntime, workflowId: string, step: number): Promise<PilotSendResult> {
  if (!uuid(workflowId) || ![1, 2].includes(step)) return { code: 'blocked' }
  const { store } = runtime
  let attemptId: string | null = null, fence: number | null = null
  const fail = async (code: 'provider_unknown' | 'provider_refused' | 'store_failed') => {
    if (attemptId && fence !== null) {
      try { await store.rpc('pilot_email_fail', { p_attempt: attemptId, p_fence: fence, p_code: code }) } catch { /* Lease recovery remains durable. */ }
    }
  }
  const finalized = async (): Promise<PilotSendResult> => {
    const value = await store.rpc('pilot_email_finalize', { p_attempt: attemptId, p_fence: fence })
    return value.code === 'finalized' && uuid(value.message_id) && uuid(value.notification_log_id)
      ? { code: 'finalized', messageId: value.message_id, notificationLogId: value.notification_log_id }
      : { code: 'pending' }
  }
  try {
    const claim = await store.rpc('pilot_email_claim', { p_workflow: workflowId, p_step: step })
    if (claim.code === 'finalized' && uuid(claim.message_id) && uuid(claim.notification_log_id)) {
      return { code: 'finalized', messageId: claim.message_id, notificationLogId: claim.notification_log_id }
    }
    if (!['claimed', 'reconcile'].includes(String(claim.code))) return { code: 'blocked' }
    if (!uuid(claim.attempt_id) || !Number.isSafeInteger(claim.fence) || Number(claim.fence) < 1) return { code: 'unavailable' }
    attemptId = claim.attempt_id; fence = Number(claim.fence)
    // A known provider result is history to record, even after consent changes,
    // archive, disconnection or the provider retry window. This never calls transport.
    if (claim.code === 'reconcile') return await finalized()

    const workflow = await store.workflow(workflowId)
    const connection = workflow ? await store.connection(workflow.connection_id) : null
    if (!workflow || !connection || workflow.id !== workflowId || connection.id !== workflow.connection_id
      || connection.user_id !== workflow.user_id || connection.account_scope !== workflow.account_scope
      || connection.credential_version !== workflow.credential_version || connection.state !== 'active') {
      await fail('store_failed'); return { code: 'unavailable' }
    }
    const customer = await store.customer(workflow.user_id, workflow.customer_id)
    if (!customer || customer.archived_at === undefined
      || (customer.archived_at !== null && (typeof customer.archived_at !== 'string' || !Number.isFinite(Date.parse(customer.archived_at))))) {
      await fail('store_failed'); return { code: 'unavailable' }
    }
    if (customer.archived_at !== null) { await fail('store_failed'); return { code: 'blocked' } }
    const key = await runtime.credentials(connection)
    if (!credentialsMatch(connection, key)) { await fail('store_failed'); return { code: 'unavailable' } }
    // This capability represents this verified client-owned connection. It is
    // not a grant to the founder's shared email identity; no legacy fallback.
    const gate = reachCheck(customer, ['email'], 'estimate_followup', { caps: { outboundEmail: true, outboundSms: false } })
    if (gate.some(g => g.blocked) || !await store.govern(workflow.user_id, workflow.customer_id)) {
      await fail('store_failed'); return { code: 'blocked' }
    }
    const started = await store.rpc('pilot_email_start', { p_attempt: attemptId, p_fence: fence })
    if (started.code !== 'started') { await fail('store_failed'); return { code: 'blocked' } }
    if (started.attempt_id !== attemptId || started.fence !== fence || started.connection_id !== connection.id
      || started.account_scope !== connection.account_scope || started.credential_version !== connection.credential_version
      || started.secret_ref !== connection.secret_ref || typeof started.payload_json !== 'string'
      || typeof started.payload_hash !== 'string' || typeof started.idempotency_key !== 'string') {
      await fail('store_failed'); return { code: 'unavailable' }
    }
    const deadline = Math.min(Date.parse(String(started.lease_until)), Date.parse(String(started.retry_until))) - 1000
    const result = await sendClientEmail({
      connectionId: connection.id, accountScope: connection.account_scope,
      credentialVersion: connection.credential_version, secretRef: connection.secret_ref,
      payloadJson: started.payload_json, payloadHash: started.payload_hash,
      idempotencyKey: started.idempotency_key, deadline,
    }, key, { fetch: runtime.http, now: runtime.now })
    if (result.code !== 'accepted') {
      await fail(result.code === 'refused' ? 'provider_refused' : 'provider_unknown')
      return { code: result.code === 'refused' ? 'blocked' : 'pending' }
    }
    const confirmed = await store.rpc('pilot_email_confirm', { p_attempt: attemptId, p_fence: fence, p_provider_email_id: result.providerEmailId })
    if (confirmed.code !== 'confirmed') { await fail('store_failed'); return { code: 'pending' } }
    const resultFinal = await finalized()
    if (resultFinal.code !== 'finalized') await fail('store_failed')
    return resultFinal
  } catch {
    await fail('store_failed')
    return { code: 'pending' }
  }
}
