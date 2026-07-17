// THE webhook delivery worker. Both entry points run this same function:
// /api/integrations/deliver (nudged by the DB the moment deliveries are
// fanned out, or by a session user for test-sends/retry-now) and
// /api/cron/integrations (the retry sweep + backstop).
//
// Claiming goes through claim_webhook_deliveries (FOR UPDATE SKIP LOCKED), so
// concurrent workers never double-send. Server-only: needs the service-role
// client — never import from client code.

import type { SupabaseClient } from '@supabase/supabase-js'
import { deliveryBody } from './events'
import { signPayload, SIGNATURE_HEADER, EVENT_HEADER, DELIVERY_HEADER } from './signing'
import { backoffDelayMinutes, AUTO_DISABLE_AFTER } from './retry'

const TIMEOUT_MS = 8_000
const BATCH_SIZE = 20
const RESPONSE_BODY_LIMIT = 2_000

interface ClaimedDelivery {
  id: string
  user_id: string
  endpoint_id: string
  event_id: string | null
  event: string
  payload: Record<string, unknown>
  attempts: number
  created_at: string
}

interface EndpointRow {
  id: string
  url: string
  secret: string
  active: boolean
  consecutive_failures: number
}

export interface DeliverSummary {
  claimed: number
  delivered: number
  retried: number
  dead: number
  disabledEndpoints: number
}

interface AttemptOutcome {
  endpointId: string
  ok: boolean
}

async function attemptOne(sb: SupabaseClient, d: ClaimedDelivery, ep: EndpointRow | undefined): Promise<AttemptOutcome> {
  // Endpoint gone or paused between fan-out and delivery: park the row.
  if (!ep || !ep.active) {
    await sb.from('webhook_deliveries').update({
      status: 'dead', last_error: 'endpoint_inactive',
    }).eq('id', d.id)
    return { endpointId: d.endpoint_id, ok: true } // don't count against the endpoint
  }

  const body = JSON.stringify(deliveryBody({
    id: d.event_id ?? d.id, event: d.event, createdAt: d.created_at, data: d.payload ?? {},
  }))
  const started = Date.now()
  let status = 0
  let responseBody = ''
  let error: string | null = null

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS)
  try {
    const res = await fetch(ep.url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'User-Agent': 'EdgeQuote-Webhooks/1.0',
        [EVENT_HEADER]: d.event,
        [DELIVERY_HEADER]: d.id,
        [SIGNATURE_HEADER]: signPayload(ep.secret, body),
      },
      body,
      signal: controller.signal,
      redirect: 'error', // a webhook consumer answering with a redirect is a misconfig
    })
    status = res.status
    responseBody = (await res.text().catch(() => '')).slice(0, RESPONSE_BODY_LIMIT)
    if (!res.ok) error = `HTTP ${res.status}`
  } catch (e) {
    error = e instanceof Error ? (e.name === 'AbortError' ? `timeout after ${TIMEOUT_MS}ms` : e.message) : String(e)
  } finally {
    clearTimeout(timer)
  }
  const duration = Date.now() - started

  if (!error) {
    await sb.from('webhook_deliveries').update({
      status: 'success', delivered_at: new Date().toISOString(),
      response_status: status, response_body: responseBody, duration_ms: duration, last_error: null,
    }).eq('id', d.id)
    return { endpointId: ep.id, ok: true }
  }

  const delay = backoffDelayMinutes(d.attempts)
  await sb.from('webhook_deliveries').update({
    status: delay === null ? 'dead' : 'pending',
    next_attempt_at: delay === null ? undefined : new Date(Date.now() + delay * 60_000).toISOString(),
    response_status: status || null, response_body: responseBody || null,
    duration_ms: duration, last_error: error,
  }).eq('id', d.id)
  return { endpointId: ep.id, ok: false }
}

/**
 * Deliver everything that is due. `userId` scopes the run (session-triggered
 * test sends / retry-now); null processes all owners. Loops in batches until
 * the queue is dry or the time budget is spent.
 */
export async function processDueDeliveries(
  sb: SupabaseClient,
  userId: string | null = null,
  timeBudgetMs = 40_000,
): Promise<DeliverSummary> {
  const summary: DeliverSummary = { claimed: 0, delivered: 0, retried: 0, dead: 0, disabledEndpoints: 0 }
  const deadline = Date.now() + timeBudgetMs

  while (Date.now() < deadline) {
    const { data: claimed, error: claimErr } = await sb.rpc('claim_webhook_deliveries', {
      p_limit: BATCH_SIZE, p_user: userId,
    })
    if (claimErr) throw new Error(`claim failed: ${claimErr.message}`)
    const batch = (claimed ?? []) as ClaimedDelivery[]
    if (batch.length === 0) break
    summary.claimed += batch.length

    const endpointIds = Array.from(new Set(batch.map((d) => d.endpoint_id)))
    const { data: eps } = await sb.from('webhook_endpoints')
      .select('id, url, secret, active, consecutive_failures')
      .in('id', endpointIds)
    const epById = new Map<string, EndpointRow>(((eps ?? []) as EndpointRow[]).map((e) => [e.id, e]))

    const outcomes = await Promise.all(batch.map((d) => attemptOne(sb, d, epById.get(d.endpoint_id))))

    // Per-endpoint health bookkeeping (aggregated per batch; a success resets).
    const byEndpoint = new Map<string, { ok: number; fail: number }>()
    for (const o of outcomes) {
      const agg = byEndpoint.get(o.endpointId) ?? { ok: 0, fail: 0 }
      if (o.ok) agg.ok += 1
      else agg.fail += 1
      byEndpoint.set(o.endpointId, agg)
    }
    for (const [endpointId, agg] of byEndpoint) {
      const ep = epById.get(endpointId)
      if (!ep) continue
      summary.delivered += agg.ok
      if (agg.ok > 0 && agg.fail === 0) {
        await sb.from('webhook_endpoints').update({
          consecutive_failures: 0, last_success_at: new Date().toISOString(),
        }).eq('id', endpointId)
        continue
      }
      if (agg.fail === 0) continue
      const failures = ep.consecutive_failures + agg.fail
      const disable = failures >= AUTO_DISABLE_AFTER
      await sb.from('webhook_endpoints').update({
        consecutive_failures: failures,
        last_failure_at: new Date().toISOString(),
        ...(agg.ok > 0 ? { last_success_at: new Date().toISOString() } : {}),
        ...(disable ? {
          active: false,
          disabled_reason: `Paused automatically after ${failures} consecutive failed deliveries. Fix the endpoint, then resume it.`,
        } : {}),
      }).eq('id', endpointId)
      if (disable) {
        summary.disabledEndpoints += 1
        await sb.from('webhook_deliveries').update({ status: 'dead', last_error: 'endpoint_disabled' })
          .eq('endpoint_id', endpointId).eq('status', 'pending')
      }
    }

    // Count retried/dead from this batch for the run log.
    const failedIds = outcomes.filter((o) => !o.ok).length
    if (failedIds > 0) {
      const stillDead = batch.filter((d) => backoffDelayMinutes(d.attempts) === null).length
      summary.dead += Math.min(stillDead, failedIds)
      summary.retried += failedIds - Math.min(stillDead, failedIds)
    }

    if (batch.length < BATCH_SIZE) break // queue is dry
  }
  return summary
}

/** Re-queue deliveries a crashed worker left claimed. */
export async function requeueStuckDeliveries(sb: SupabaseClient, olderThanMinutes: number): Promise<number> {
  const cutoff = new Date(Date.now() - olderThanMinutes * 60_000).toISOString()
  const { data } = await sb.from('webhook_deliveries')
    .update({ status: 'pending' })
    .eq('status', 'processing').lt('last_attempt_at', cutoff)
    .select('id')
  return data?.length ?? 0
}

/** Retention: prune settled logs, old outbox rows and old inbound receipts. */
export async function pruneIntegrationLogs(sb: SupabaseClient, retentionDays: number): Promise<void> {
  const cutoff = new Date(Date.now() - retentionDays * 86_400_000).toISOString()
  await sb.from('webhook_deliveries').delete().in('status', ['success', 'dead']).lt('created_at', cutoff)
  await sb.from('integration_events').delete().lt('created_at', cutoff)
  await sb.from('inbound_events').delete().lt('created_at', cutoff)
}
