// Integrations platform regression suite — run with `npm run verify:integrations`.
//
// What tsc and build cannot catch here are wrong-VALUE bugs: a signature that
// verifies its own tampering, a backoff that never terminates, an event key
// the docs promise but the catalog dropped, a serializer whose field set
// drifts from the webhook payloads. Everything below runs the REAL production
// functions — no mocks, no network, deterministic.
//
// The DB side (capture triggers) can't run here; its payload field sets are
// pinned via events.ts payloadKeys, which the migration mirrors by contract.

import {
  INTEGRATION_EVENTS, EVENT_KEYS, eventByKey, validateEventSelection,
  deliveryBody, sampleDeliveryBody, SERIALIZED_FIELDS, serializeEntity,
  TEST_EVENT, type IntegrationEntity,
} from '../src/lib/integrations/events'
import { signPayload, verifySignature, SIGNATURE_HEADER, SIGNATURE_TOLERANCE_SECONDS, safeEqual } from '../src/lib/integrations/signing'
import {
  generateApiKey, hashApiKey, displayPrefix, isApiKeyShaped,
  generateWebhookSecret, generateInboundToken, normalizeScopes, API_RATE_LIMIT_PER_MINUTE,
} from '../src/lib/integrations/keys'
import { BACKOFF_MINUTES, MAX_ATTEMPTS, AUTO_DISABLE_AFTER, backoffDelayMinutes, RETENTION_DAYS, STUCK_PROCESSING_MINUTES } from '../src/lib/integrations/retry'
import { normalizeInboundPayload } from '../src/lib/integrations/inboundActions'
import { FEATURE_MODULES, moduleByKey } from '../src/lib/modules'

let pass = 0
let fail = 0
const check = (name: string, ok: boolean, detail?: string) => {
  if (ok) {
    pass++
    console.log(`  ✓ ${name}`)
  } else {
    fail++
    console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`)
  }
}

// ── Event catalog ────────────────────────────────────────────────────────────
console.log('\nEvent catalog:')
const ENTITIES: IntegrationEntity[] = ['customer', 'quote', 'job', 'invoice', 'payment', 'request']
check('has the 10 launch events', INTEGRATION_EVENTS.length === 10, String(INTEGRATION_EVENTS.length))
check('keys are unique', new Set(EVENT_KEYS).size === EVENT_KEYS.length)
check('keys are entity.action shaped', EVENT_KEYS.every((k) => /^[a-z]+\.[a-z_]+$/.test(k)))
check('every event names a known entity', INTEGRATION_EVENTS.every((e) => ENTITIES.includes(e.entity)))
check('every event has label + description', INTEGRATION_EVENTS.every((e) => e.label.length > 0 && e.description.length > 10))
check("test.ping is NOT in the catalog (synthetic only)", !EVENT_KEYS.includes(TEST_EVENT))
check('the lifecycle spine is covered', ['customer.created', 'quote.accepted', 'job.completed', 'invoice.paid', 'payment.recorded', 'request.created'].every((k) => EVENT_KEYS.includes(k)))
check('eventByKey hits and misses cleanly', eventByKey('invoice.paid')?.entity === 'invoice' && eventByKey('nope.nope') === null)

// Samples ↔ payloadKeys: every sample carries exactly its declared keys.
for (const ev of INTEGRATION_EVENTS) {
  const sampleKeys = Object.keys(ev.sample).sort()
  const declared = [...ev.payloadKeys].sort()
  check(`sample matches payloadKeys: ${ev.key}`,
    sampleKeys.length === declared.length && sampleKeys.every((k, i) => k === declared[i]),
    `sample [${sampleKeys}] vs declared [${declared}]`)
  check(`payload id present: ${ev.key}`, ev.payloadKeys.includes('id') && ev.payloadKeys.includes('created_at'))
}

// Serializers ↔ payloads: each event's payload keys are a subset of its
// entity's API field list, and serializeEntity returns exactly that list.
console.log('\nSerializer agreement (API ⇄ webhook payloads):')
for (const ev of INTEGRATION_EVENTS) {
  check(`payload ⊆ API fields: ${ev.key}`, ev.payloadKeys.every((k) => SERIALIZED_FIELDS[ev.entity].includes(k)))
}
for (const entity of ENTITIES) {
  const out = serializeEntity(entity, { id: 'x', extra_column_never_leaks: 'y' })
  check(`serializeEntity(${entity}) returns exactly the field list`,
    Object.keys(out).length === SERIALIZED_FIELDS[entity].length && !('extra_column_never_leaks' in out))
}
check('unknown fields default to null, not undefined', serializeEntity('customer', {}).name === null)

// Envelope
const body = deliveryBody({ id: 'e1', event: 'x.y', createdAt: 't', data: { a: 1 } })
check('delivery envelope is {id, event, created_at, data}', JSON.stringify(Object.keys(body)) === JSON.stringify(['id', 'event', 'created_at', 'data']))
check('sampleDeliveryBody wraps the catalog sample', (sampleDeliveryBody('quote.accepted').data as Record<string, unknown>).status === 'accepted')

// ── Endpoint event selection ─────────────────────────────────────────────────
console.log('\nEvent selection validation:')
check("['*'] is valid", validateEventSelection(['*']) === null)
check('exact keys are valid', validateEventSelection(['invoice.paid', 'quote.accepted']) === null)
check('empty list rejected', validateEventSelection([]) !== null)
check('unknown key rejected by name', (validateEventSelection(['invoice.paid', 'bogus.event']) ?? '').includes('bogus.event'))
check("'*' mixed with keys rejected", validateEventSelection(['*', 'invoice.paid']) !== null)
check('non-array rejected', validateEventSelection('*' as unknown) !== null)

// ── Signing ──────────────────────────────────────────────────────────────────
console.log('\nSignature scheme:')
const secret = generateWebhookSecret()
const payload = JSON.stringify(sampleDeliveryBody('invoice.paid'))
const now = 1_800_000_000
const header = signPayload(secret, payload, now)
check('header shape t=…,v1=…', /^t=\d+,v1=[0-9a-f]{64}$/.test(header), header)
check('round-trip verifies', verifySignature(secret, header, payload, now))
check('tampered body fails', !verifySignature(secret, header, payload + ' ', now))
check('wrong secret fails', !verifySignature(generateWebhookSecret(), header, payload, now))
check('stale timestamp fails (replay guard)', !verifySignature(secret, header, payload, now + SIGNATURE_TOLERANCE_SECONDS + 1))
check('future timestamp fails too', !verifySignature(secret, signPayload(secret, payload, now + 9999), payload, now))
check('missing header fails', !verifySignature(secret, null, payload, now))
check('garbage header fails', !verifySignature(secret, 'v1=deadbeef', payload, now))
check('rotation: extra v1 entries still verify', verifySignature(secret, `${header},v1=${'0'.repeat(64)}`, payload, now))
check('header constant is stable', SIGNATURE_HEADER === 'x-edgequote-signature')
check('safeEqual: equal / unequal / length-mismatch', safeEqual('abc', 'abc') && !safeEqual('abc', 'abd') && !safeEqual('abc', 'abcd'))

// ── Credentials ──────────────────────────────────────────────────────────────
console.log('\nCredential minting:')
const k1 = generateApiKey()
const k2 = generateApiKey()
check('API key shape eq_live_ + 64 hex', isApiKeyShaped(k1))
check('two keys differ', k1 !== k2)
check('hash is 64-hex and deterministic', /^[0-9a-f]{64}$/.test(hashApiKey(k1)) && hashApiKey(k1) === hashApiKey(k1))
check('hash never contains the key body', !hashApiKey(k1).includes(k1.slice(8, 24)))
check('display prefix is eq_live_ + 4', displayPrefix(k1).length === 12 && k1.startsWith(displayPrefix(k1)))
check('webhook secret shape', /^whsec_[0-9a-f]{48}$/.test(generateWebhookSecret()))
check('inbound token shape', /^eqin_[0-9a-f]{32}$/.test(generateInboundToken()))
check('rate limit is a sane constant', API_RATE_LIMIT_PER_MINUTE >= 60 && API_RATE_LIMIT_PER_MINUTE <= 1000)
check("scopes: ['read'] ok", JSON.stringify(normalizeScopes(['read'])) === '["read"]')
check('scopes: dedup + both', JSON.stringify(normalizeScopes(['read', 'write', 'read'])) === '["read","write"]')
check('scopes: unknown rejected', normalizeScopes(['read', 'admin']) === null)
check('scopes: empty rejected', normalizeScopes([]) === null)

// ── Retry policy ─────────────────────────────────────────────────────────────
console.log('\nRetry policy:')
check('backoff strictly increases', BACKOFF_MINUTES.every((m, i) => i === 0 || m > BACKOFF_MINUTES[i - 1]))
check('MAX_ATTEMPTS = steps + 1', MAX_ATTEMPTS === BACKOFF_MINUTES.length + 1)
check('attempt 1 failure → first step', backoffDelayMinutes(1) === BACKOFF_MINUTES[0])
check('last retryable attempt → last step', backoffDelayMinutes(MAX_ATTEMPTS - 1) === BACKOFF_MINUTES[BACKOFF_MINUTES.length - 1])
check('final attempt → dead (null)', backoffDelayMinutes(MAX_ATTEMPTS) === null)
check('beyond final → still dead', backoffDelayMinutes(MAX_ATTEMPTS + 5) === null)
check('total retry window spans ≥ 24h', BACKOFF_MINUTES.reduce((a, b) => a + b, 0) >= 1440)
check('auto-disable threshold exceeds one full delivery cycle', AUTO_DISABLE_AFTER > MAX_ATTEMPTS)
check('stuck-claim requeue < first long backoff', STUCK_PROCESSING_MINUTES < 30)
check('retention is real but bounded', RETENTION_DAYS >= 7 && RETENTION_DAYS <= 90)

// ── Inbound normalization ────────────────────────────────────────────────────
console.log('\nInbound payload normalization:')
const n1 = normalizeInboundPayload({ full_name: 'A B', tel: '403-555-0000', comments: 'hi', utm_source: 'fb' })
check('aliases map (full_name/tel/comments/utm_source)', n1.name === 'A B' && n1.phone === '403-555-0000' && n1.message === 'hi' && n1.source === 'fb')
const n2 = normalizeInboundPayload({ Name: 'C', Email: 'c@d.e', Phone: '1', Address: 'x', City: 'y', Message: 'z' })
check('capitalized variants map', n2.name === 'C' && n2.email === 'c@d.e' && n2.address === 'x' && n2.city === 'y' && n2.message === 'z')
check('canonical keys win over nothing', normalizeInboundPayload({ name: 'N' }).name === 'N')
check('empty strings become null', normalizeInboundPayload({ name: '  ' }).name === null)
check('non-string values ignored safely', normalizeInboundPayload({ name: { evil: true } as unknown }).name === null)

// ── Module registration ──────────────────────────────────────────────────────
console.log('\nModule registration:')
const mod = moduleByKey('integrations')
check("module 'integrations' is registered", Boolean(mod))
if (mod) {
  check('href points at the page', mod.href === '/dashboard/integrations')
  check('category is valid', ['operations', 'customers', 'money', 'growth'].includes(mod.category))
  check('carries updatedAt (marketplace contract)', /^\d{4}-\d{2}-\d{2}$/.test(mod.updatedAt))
  check('permission manifest is honest (read + write + send)', mod.permissions.includes('customers:write') && mod.permissions.includes('webhooks:send'))
  check('no dependencies (platform module)', !mod.requires || mod.requires.length === 0)
  check('not core (removable)', !mod.core)
}
check('registry keys still unique', new Set(FEATURE_MODULES.map((m) => m.key)).size === FEATURE_MODULES.length)

// ── Verdict ──────────────────────────────────────────────────────────────────
console.log(`\n${fail === 0 ? '✓' : '✗'} integrations checks: ${pass} passed, ${fail} failed`)
process.exit(fail === 0 ? 0 : 1)
