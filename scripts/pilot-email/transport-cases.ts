import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { sendClientEmail, retrieveClientEmail, type ClientEmailCredentials, type FrozenEmailRequest } from '../../src/lib/comms/pilotEmailTransport'

const ID = '00000000-0000-4000-8000-000000000001'
const credentials: ClientEmailCredentials = {
  connectionId: ID, accountScope: 'synthetic-account-A', credentialVersion: 'version-1', secretRef: 'PILOT_TEST_A',
  apiKey: 're_synthetic_client_only', webhookSecret: 'whsec_synthetic_client_only',
}
const payload = { from: 'Client Example <quotes@client.example>', to: ['customer@example.com'], reply_to: 'reply-token@reply.client.example', subject: 'Requested estimate', text: 'Please review your estimate.', html: '<p>Please review your estimate.</p>' }
const hash = (value: string) => createHash('sha256').update(value, 'utf8').digest('hex')
function frozen(patch: Partial<FrozenEmailRequest> = {}): FrozenEmailRequest {
  const payloadJson = patch.payloadJson ?? JSON.stringify(payload)
  return { connectionId: credentials.connectionId, accountScope: credentials.accountScope, credentialVersion: credentials.credentialVersion, secretRef: credentials.secretRef,
    payloadJson, payloadHash: hash(payloadJson), idempotencyKey: 'pilot/attempt-1/version-1', deadline: Date.now() + 60_000, ...patch }
}
function fake(reply: (init: RequestInit) => Response | Promise<Response>) {
  const calls: { url: string; init: RequestInit }[] = []
  const fetcher = (async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const url = String(input)
    assert.equal(new URL(url).origin, 'https://api.resend.com')
    assert.equal(init.redirect, 'error'); assert.equal(init.cache, 'no-store')
    assert.ok(init.signal instanceof AbortSignal)
    const headers = new Headers(init.headers)
    assert.equal(headers.get('Authorization'), 'Bearer ' + credentials.apiKey)
    calls.push({ url, init })
    return reply(init)
  }) as typeof fetch
  return { calls, fetcher }
}

export async function runTransportCases(): Promise<{ name: string; pass: boolean; error?: string }[]> {
  const results: { name: string; pass: boolean; error?: string }[] = []
  const check = async (name: string, fn: () => Promise<void>) => {
    try { await fn(); results.push({ name, pass: true }) }
    catch (error) { results.push({ name, pass: false, error: error instanceof Error ? error.message.slice(0, 1200) : 'Assertion failed' }) }
  }
  await check('transport: accepted send preserves exact frozen UTF-8 bytes, whitespace and idempotency key', async () => {
    const json = JSON.stringify({ ...payload, text: 'Bonjour café — C$66.95' }, null, 2) + '\n'
    const request = frozen({ payloadJson: json }), f = fake(() => Response.json({ id: ID }))
    assert.deepEqual(await sendClientEmail(request, credentials, { fetch: f.fetcher }), { code: 'accepted', providerEmailId: ID })
    assert.equal(f.calls.length, 1); assert.equal(f.calls[0].url, 'https://api.resend.com/emails')
    assert.equal(f.calls[0].init.method, 'POST'); assert.equal(f.calls[0].init.body, json)
    assert.equal(new Headers(f.calls[0].init.headers).get('Idempotency-Key'), request.idempotencyKey)
    assert.equal(new Headers(f.calls[0].init.headers).get('Content-Type'), 'application/json')
  })
  await check('transport: caller retries unknown acceptance with identical body/key; adapter never retries', async () => {
    let first = true
    const request = frozen(), f = fake(async () => { if (first) { first = false; throw new Error('synthetic accepted then response lost') } return Response.json({ id: ID }) })
    assert.deepEqual(await sendClientEmail(request, credentials, { fetch: f.fetcher }), { code: 'unknown' }); assert.equal(f.calls.length, 1)
    assert.deepEqual(await sendClientEmail(request, credentials, { fetch: f.fetcher }), { code: 'accepted', providerEmailId: ID })
    assert.equal(f.calls.length, 2); assert.equal(f.calls[0].init.body, f.calls[1].init.body)
    assert.equal(new Headers(f.calls[0].init.headers).get('Idempotency-Key'), new Headers(f.calls[1].init.headers).get('Idempotency-Key'))
  })
  for (const field of ['connectionId', 'accountScope', 'credentialVersion', 'secretRef'] as const) {
    await check(`transport: mismatched ${field} refuses before HTTP`, async () => {
      const f = fake(() => Response.json({ id: ID }))
      assert.deepEqual(await sendClientEmail(frozen({ [field]: 'another-client' }), credentials, { fetch: f.fetcher }), { code: 'unavailable' }); assert.equal(f.calls.length, 0)
    })
  }
  await check('transport: missing/invalid credentials never fall back to deployment identity', async () => {
    for (const c of [null, {}, { ...credentials, apiKey: '' }, { ...credentials, webhookSecret: '' }, { ...credentials, apiKey: 're_key\r\nInjected: value' }]) {
      const f = fake(() => Response.json({ id: ID }))
      assert.deepEqual(await sendClientEmail(frozen(), c as ClientEmailCredentials, { fetch: f.fetcher }), { code: 'unavailable' })
      assert.equal(await retrieveClientEmail(ID, c as ClientEmailCredentials, { fetch: f.fetcher }), null); assert.equal(f.calls.length, 0)
    }
  })
  await check('transport: hash mismatch and invalid idempotency header never dispatch', async () => {
    for (const patch of [{ payloadHash: '0'.repeat(64) }, { payloadHash: 'not-a-hash' }, { idempotencyKey: '' }, { idempotencyKey: 'x'.repeat(257) }, { idempotencyKey: 'key\r\nInjected: value' }]) {
      const f = fake(() => Response.json({ id: ID }))
      assert.deepEqual(await sendClientEmail(frozen(patch), credentials, { fetch: f.fetcher }), { code: 'refused' }); assert.equal(f.calls.length, 0)
    }
  })
  await check('transport: malformed/extra/duplicate envelope and multiple recipients never dispatch', async () => {
    const invalid = ['{', '[]', JSON.stringify({ ...payload, bcc: 'other@example.com' }), JSON.stringify({ ...payload, headers: { Bcc: 'other@example.com' } }), JSON.stringify({ ...payload, attachments: [] }),
      JSON.stringify({ ...payload, to: ['a@example.com', 'b@example.com'] }), JSON.stringify({ ...payload, to: 'a@example.com,b@example.com' }), JSON.stringify({ ...payload, reply_to: ['a@example.com'] }),
      JSON.stringify({ ...payload, subject: 'Subject\r\nBcc: other@example.com' }), JSON.stringify({ ...payload, from: 'a@example.com\nBcc: b@example.com' }), JSON.stringify({ ...payload, text: '' }),
      JSON.stringify(payload).replace('"subject":', '"subject":"duplicate","subject":')]
    for (const payloadJson of invalid) {
      const f = fake(() => Response.json({ id: ID }))
      assert.deepEqual(await sendClientEmail(frozen({ payloadJson }), credentials, { fetch: f.fetcher }), { code: 'refused' }); assert.equal(f.calls.length, 0)
    }
  })
  await check('transport: text-only and one string recipient remain valid', async () => {
    const { html: _html, ...textOnly } = payload
    const f = fake(() => Response.json({ id: ID }))
    assert.equal((await sendClientEmail(frozen({ payloadJson: JSON.stringify({ ...textOnly, from: 'quotes@client.example', to: 'customer@example.com' }) }), credentials, { fetch: f.fetcher })).code, 'accepted')
  })
  for (const status of [408, 409, 429, 500, 502, 503]) {
    await check(`transport: HTTP ${status} remains unknown with no retry`, async () => {
      const f = fake(() => Response.json({ message: 'synthetic failure' }, { status }))
      assert.deepEqual(await sendClientEmail(frozen(), credentials, { fetch: f.fetcher }), { code: 'unknown' }); assert.equal(f.calls.length, 1)
    })
  }
  for (const status of [400, 401, 403, 422]) {
    await check(`transport: bounded HTTP ${status} is a definitive refusal`, async () => {
      const f = fake(() => Response.json({ message: 'synthetic refusal' }, { status }))
      assert.deepEqual(await sendClientEmail(frozen(), credentials, { fetch: f.fetcher }), { code: 'refused' }); assert.equal(f.calls.length, 1)
    })
  }
  await check('transport: malformed success/unsafe id and redirects cannot claim acceptance', async () => {
    for (const response of [Response.json({}), Response.json({ id: '../../other' }), new Response('not JSON'), Response.json([], { status: 200 }), Response.json({ id: ID }, { status: 302, headers: { Location: 'https://evil.invalid' } })]) {
      const f = fake(() => response)
      assert.deepEqual(await sendClientEmail(frozen(), credentials, { fetch: f.fetcher }), { code: 'unknown' }); assert.equal(f.calls.length, 1)
    }
  })
  await check('transport: oversized streamed response is cancelled without reading the whole body', async () => {
    let cancelled = false, reads = 0
    const f = fake(() => new Response(new ReadableStream<Uint8Array>({ pull(c) { reads++; c.enqueue(new Uint8Array(70 * 1024).fill(32)) }, cancel() { cancelled = true } })))
    assert.deepEqual(await sendClientEmail(frozen(), credentials, { fetch: f.fetcher }), { code: 'unknown' })
    assert.equal(cancelled, true); assert.ok(reads <= 4)
  })
  await check('transport: declared response cap and UTF-8 decoding errors remain unknown', async () => {
    for (const response of [new Response('{}', { headers: { 'Content-Length': '131073' } }), new Response(new Uint8Array([0xff, 0xfe]))]) {
      const f = fake(() => response)
      assert.deepEqual(await sendClientEmail(frozen(), credentials, { fetch: f.fetcher }), { code: 'unknown' })
    }
  })
  await check('transport: expired/non-finite deadline makes zero HTTP calls', async () => {
    for (const deadline of [100, 99, NaN, Infinity]) {
      const f = fake(() => Response.json({ id: ID }))
      assert.deepEqual(await sendClientEmail(frozen({ deadline }), credentials, { fetch: f.fetcher, now: () => 100 }), { code: 'unavailable' }); assert.equal(f.calls.length, 0)
    }
  })
  await check('transport: caller deadline aborts stalled fetch even when transport ignores the signal', async () => {
    const f = fake(() => new Promise<Response>(() => {}))
    assert.deepEqual(await sendClientEmail(frozen({ deadline: Date.now() + 20 }), credentials, { fetch: f.fetcher }), { code: 'unknown' })
    assert.equal(f.calls.length, 1); assert.equal(f.calls[0].init.signal?.aborted, true)
  })
  await check('transport: timeout covers response streaming after accepted HTTP headers', async () => {
    let cancelled = false
    const f = fake(() => new Response(new ReadableStream<Uint8Array>({ start(c) { c.enqueue(new TextEncoder().encode('{"id":')) }, cancel() { cancelled = true } })))
    assert.deepEqual(await sendClientEmail(frozen({ deadline: Date.now() + 20 }), credentials, { fetch: f.fetcher }), { code: 'unknown' })
    assert.equal(cancelled, true); assert.equal(f.calls[0].init.signal?.aborted, true)
  })
  await check('transport: hard ten-second ceiling aborts a longer caller lease without retry', async () => {
    const f = fake(() => new Promise<Response>(() => {})), began = Date.now()
    assert.deepEqual(await sendClientEmail(frozen(), credentials, { fetch: f.fetcher }), { code: 'unknown' })
    assert.ok(Date.now() - began >= 9500); assert.ok(Date.now() - began < 20_000)
    assert.equal(f.calls.length, 1); assert.equal(f.calls[0].init.signal?.aborted, true)
  })
  await check('transport: received-email retrieval is a single fixed CID JSON request; URLs remain inert', async () => {
    const body = { id: ID, html_format: 'cid', text: 'Synthetic reply', raw: { download_url: 'https://evil.invalid/raw' }, attachments: [{ download_url: 'http://127.0.0.1/private' }] }
    const f = fake(() => Response.json(body))
    assert.deepEqual(await retrieveClientEmail(ID, credentials, { fetch: f.fetcher }), body)
    assert.equal(f.calls.length, 1); assert.equal(f.calls[0].url, `https://api.resend.com/emails/receiving/${ID}?html_format=cid`)
    assert.equal(f.calls[0].init.method, 'GET'); assert.equal(f.calls[0].init.body, undefined)
  })
  await check('transport: dangerous/missing received IDs never fetch and mismatched response ID is refused', async () => {
    const f = fake(() => Response.json({ id: ID }))
    for (const id of ['', '../../private', 'https://evil.invalid', ID + '?x=1', ID + '\r\n']) assert.equal(await retrieveClientEmail(id, credentials, { fetch: f.fetcher }), null)
    assert.equal(f.calls.length, 0)
    const mismatch = fake(() => Response.json({ id: '00000000-0000-4000-8000-000000000002' }))
    assert.equal(await retrieveClientEmail(ID, credentials, { fetch: mismatch.fetcher }), null)
  })
  return results
}
