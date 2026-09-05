// Prepared B2 transport, deliberately NOT mounted under app/api. No environment
// switch can expose billing while the SQL and activation plan remain unapplied.
import { createHmac, timingSafeEqual } from 'node:crypto'
import { reconcilePlatformSubscriptionEvent } from './reconcile'
import { billingId, billingObject, billingTime, platformProvider, platformProviderConfig } from './provider'
import type { BillingEnvironment } from './provider'
import type { PlatformBillingStore, VerifiedPlatformSubscriptionEvent } from './reconcileTypes'

const relevant = new Set(['customer.subscription.created', 'customer.subscription.updated', 'customer.subscription.deleted',
  'customer.subscription.paused', 'customer.subscription.resumed', 'customer.subscription.pending_update_applied',
  'customer.subscription.pending_update_expired', 'customer.subscription.trial_will_end'])
const MAX_BODY_BYTES = 1024 * 1024

export function validPlatformSignature(raw: string, signature: string | null, secret: string, now: number): boolean {
  if (!signature || signature.length > 4096 || !Number.isFinite(now)) return false
  const fields = signature.split(',').map(value => value.trim().split('='))
  const times = fields.filter(([name]) => name === 't')
  if (times.length !== 1 || times[0].length !== 2 || !/^\d+$/.test(times[0][1])) return false
  const timestamp = Number(times[0][1])
  if (!Number.isSafeInteger(timestamp) || Math.abs(now / 1000 - timestamp) > 300) return false
  const expected = createHmac('sha256', secret).update(`${times[0][1]}.${raw}`, 'utf8').digest()
  return fields.some(([name, value, extra]) => name === 'v1' && extra === undefined
    && /^[a-f0-9]{64}$/i.test(value ?? '') && timingSafeEqual(expected, Buffer.from(value, 'hex')))
}

function eventIdentity(value: unknown, accountId: string, livemode: boolean) {
  const event = billingObject(value)
  // This endpoint is for the SaaS account's own snapshot events. Connect and
  // organization event destinations require a different reviewed dispatcher.
  if (event.object !== 'event' || event.livemode !== livemode || event.account != null || event.context != null
    || typeof event.type !== 'string' || event.type.length > 255) throw new Error('event_scope_mismatch')
  const created = billingTime(event.created)
  if (!created) throw new Error('invalid_event_time')
  return { event, eventId: billingId(event.id, 'evt'), eventType: event.type, eventCreatedAt: created, stripeAccountId: accountId, livemode }
}
function relevantIdentity(value: unknown, accountId: string, livemode: boolean): VerifiedPlatformSubscriptionEvent {
  const identity = eventIdentity(value, accountId, livemode)
  const object = billingObject(billingObject(identity.event.data).object)
  if (object.object !== 'subscription' || object.livemode !== livemode) throw new Error('invalid_subscription_event')
  return { eventId: identity.eventId, eventType: identity.eventType, eventCreatedAt: identity.eventCreatedAt,
    stripeAccountId: accountId, livemode, stripeCustomerId: billingId(object.customer, 'cus'), stripeSubscriptionId: billingId(object.id, 'sub') }
}
async function rawBody(request: Request): Promise<string> {
  if (!request.body) throw new Error('invalid_body')
  const reader = request.body.getReader()
  const chunks: Uint8Array[] = []
  let size = 0
  try {
    while (true) {
      const next = await reader.read()
      if (next.done) break
      size += next.value.byteLength
      if (size > MAX_BODY_BYTES) { await reader.cancel(); throw new Error('body_too_large') }
      chunks.push(next.value)
    }
  } finally { reader.releaseLock() }
  // Preserve even a UTF-8 BOM: stripping bytes before HMAC would let an altered
  // body pass with the original signature. Invalid UTF-8 is rejected outright.
  return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(Buffer.concat(chunks))
}
const reply = (status: number) => Response.json(status === 200 ? { received: true } : { error: 'Billing event could not be processed.' },
  { status, headers: { 'Cache-Control': 'private, no-store', ...(status === 503 ? { 'Retry-After': '30' } : {}) } })

export async function handlePlatformBillingWebhook(request: Request, deps: {
  environment: BillingEnvironment
  createStore(): PlatformBillingStore | null
  fetcher?: typeof fetch
  now?: () => number
}): Promise<Response> {
  if (request.method !== 'POST') return reply(405)
  const config = platformProviderConfig(deps.environment)
  if (!config) return reply(503)
  let payload: unknown
  try {
    const raw = await rawBody(request)
    if (!validPlatformSignature(raw, request.headers.get('stripe-signature'), config.webhookSecret, (deps.now ?? Date.now)())) return reply(400)
    payload = JSON.parse(raw)
    eventIdentity(payload, config.platformAccountId, config.livemode)
  } catch { return reply(400) }
  try {
    const provider = platformProvider(config, deps.fetcher)
    const scope = await provider.verifyScope()
    const identity = eventIdentity(payload, scope.platformAccountId, scope.livemode)
    // Fetch the signed event with the verified SaaS account's API credential.
    // Distinct env var names/signing secrets alone do not prove account origin.
    const storedEvent = await provider.retrieveEvent(identity.eventId)
    const stored = eventIdentity(storedEvent, scope.platformAccountId, scope.livemode)
    if (stored.eventId !== identity.eventId || stored.eventType !== identity.eventType || stored.eventCreatedAt !== identity.eventCreatedAt) return reply(503)
    if (!relevant.has(identity.eventType)) return reply(identity.eventType.startsWith('customer.subscription.') ? 503 : 200)
    const verified = relevantIdentity(payload, scope.platformAccountId, scope.livemode)
    const canonicalEvent = relevantIdentity(storedEvent, scope.platformAccountId, scope.livemode)
    if (verified.stripeCustomerId !== canonicalEvent.stripeCustomerId || verified.stripeSubscriptionId !== canonicalEvent.stripeSubscriptionId) return reply(503)
    const store = deps.createStore()
    if (!store) return reply(503)
    const result = await reconcilePlatformSubscriptionEvent(verified, { scope, store, readCanonicalSubscriptions: provider.readCanonicalSubscriptions })
    return reply(result.kind === 'retry' ? 503 : 200)
  } catch { return reply(503) }
}
