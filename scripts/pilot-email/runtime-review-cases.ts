import assert from 'node:assert/strict'
import { createHmac } from 'node:crypto'
import type { Database, TestResult } from './database'
import { sqlSupabase } from './runtime-cases'
import { createPilotStore, type PilotConnection, type PilotRecord } from '../../src/lib/comms/pilotEmailStore'
import { dispatchApprovedPilotEmail, type PilotEmailRuntime } from '../../src/lib/comms/pilotEmailAttempt'
import { processPilotEmailWebhook } from '../../src/lib/comms/pilotEmailEvents'
import { approvePilotEmailRequest } from '../../src/lib/comms/pilotEmailOwner'

// Independent actual-handler assertions. SQL responses come from the baseline +
// proposal through the author's explicit Supabase transport fixture. Only auth,
// provider HTTP and additive transaction-scoped write faults are synthetic.
const A = '00000000-0000-4000-8000-0000000000a1'
const CA = '00000000-0000-4000-8000-0000000000a2'
const QA = '00000000-0000-4000-8000-0000000000a3'
const QA2 = '00000000-0000-4000-8000-0000000000a4'
const SENT = '00000000-0000-4000-8000-0000000000e1'
const RECEIVED = '00000000-0000-4000-8000-0000000000f1'
const SECRET = 'whsec_' + Buffer.alloc(32, 73).toString('base64')
const MAILBOX = 'shared@customer.example.invalid'

export async function runRuntimeReviewCases(db: Database): Promise<TestResult[]> {
  const results: TestResult[] = [], store = createPilotStore(sqlSupabase(db))
  const value = async (sql: string, params: unknown[] = []) => (await db.query<{ value: unknown }>(sql, params)).rows[0]?.value
  const count = (table: string) => { assert.match(table, /^[a-z_]+$/); return value(`select count(*)::int as value from public.${table}`) }
  const credentials = async (c: PilotConnection) => ({ connectionId: c.id, accountScope: c.account_scope,
    credentialVersion: c.credential_version, secretRef: c.secret_ref, apiKey: 're_synthetic_not_a_real_key', webhookSecret: SECRET })
  const auth = { getUser: async () => ({ data: { user: { id: A } }, error: null }) }
  const request = (body: unknown) => new Request('https://example.invalid/approve', {
    method: 'POST', headers: { 'content-type': 'application/json', origin: 'https://example.invalid' }, body: JSON.stringify(body),
  })
  const test = async (name: string, action: () => Promise<void>) => {
    await db.exec('begin')
    try {
      await db.exec(`update public.business_settings set timezone=case when extract(hour from clock_timestamp() at time zone 'UTC')::int=12 then 'Etc/UTC'
        when extract(hour from clock_timestamp() at time zone 'UTC')::int>12 then 'Etc/GMT+'||(extract(hour from clock_timestamp() at time zone 'UTC')::int-12)::text
        else 'Etc/GMT'||(extract(hour from clock_timestamp() at time zone 'UTC')::int-12)::text end`)
      await action(); results.push({ name, pass: true })
    } catch (error) { results.push({ name, pass: false, error: error instanceof Error ? error.message.slice(0, 1200) : 'Review assertion failed' }) }
    finally { await db.exec('rollback') }
  }
  const setup = async () => {
    const c = await store.rpc('pilot_email_create_connection', { p_owner: A, p_account_scope: 'review-synthetic-a',
      p_from_address: 'quotes@business-a.example.invalid', p_receiving_domain: 'reply-a.example.invalid',
      p_secret_ref: 'PILOT_REVIEW_A', p_credential_version: 'v1' })
    assert.equal(c.code, 'created')
    const cid = String(c.connection_id)
    for (const state of ['verified', 'active']) assert.equal((await store.rpc('pilot_email_set_connection_state', { p_connection: cid, p_state: state })).code, 'updated')
    const body = { connectionId: cid, customerId: CA, quoteId: QA, steps: [
      { subject: 'Your estimate', text: 'Please review your requested estimate.', due_at: await value("select (clock_timestamp()-interval '2 minutes')::text as value") },
      { subject: 'Questions about your estimate?', text: 'Let us know if you have a question.', due_at: await value("select (clock_timestamp()-interval '1 minute')::text as value") },
    ] }
    const approved = await approvePilotEmailRequest(store, auth, request(body))
    assert.equal(approved.status, 200)
    const wid = String(approved.body.workflowId)
    const attempts = (await db.query<{ payload: PilotRecord; reply_token: string }>(
      'select payload,reply_token from public.pilot_email_send_attempts where workflow_id=$1::uuid order by step', [wid])).rows
    return { cid, wid, body, attempts, to: String(attempts[0].payload.reply_to) }
  }
  const signature = (raw: Uint8Array, id: string, timestamp: string) => createHmac('sha256', Buffer.from(SECRET.slice(6), 'base64'))
    .update(`${id}.${timestamp}.`).update(raw).digest('base64')
  const signedBytes = (cid: string, raw: Uint8Array, id = 'msg_review', extraHeaders: Record<string, string> = {}) => {
    const timestamp = String(Math.floor(Date.now() / 1000))
    return new Request(`https://example.invalid/events/${cid}`, { method: 'POST', headers: {
      'content-type': 'application/json', 'svix-id': id, 'svix-timestamp': timestamp,
      'svix-signature': 'v1,' + signature(raw, id, timestamp), ...extraHeaders,
    }, body: Buffer.from(raw) })
  }
  const signed = (cid: string, event: unknown, id = 'msg_review') => signedBytes(cid, Buffer.from(JSON.stringify(event)), id)
  const event = (to: string, from = MAILBOX) => ({ type: 'email.received', created_at: new Date().toISOString(),
    data: { email_id: RECEIVED, from, to: [to] } })
  const content = (to: string, text = 'I have a question.') => ({ id: RECEIVED, from: MAILBOX, to: [to], text,
    created_at: new Date().toISOString(), message_id: '<review@example.invalid>' })
  const workflowState = (wid: string) => value('select state as value from public.pilot_quote_followup_workflows where id=$1::uuid', [wid])
  const httpFixture = (result: () => unknown, calls: string[]) => (async (url: unknown) => {
    calls.push(String(url)); return Response.json(result())
  }) as typeof fetch
  const invoke = (runtime: PilotEmailRuntime, cid: string, body: unknown, id = 'msg_review') => processPilotEmailWebhook(runtime, signed(cid, body, id), cid)

  await test('review: replay after first of two sends never claims unsent or replaces frozen approval', async () => {
    const state = await setup(), calls: string[] = []
    assert.equal((await dispatchApprovedPilotEmail({ store, credentials, http: httpFixture(() => ({ id: SENT }), calls) }, state.wid, 1)).code, 'finalized')
    assert.equal(await workflowState(state.wid), 'approved')
    const replay = await approvePilotEmailRequest(store, auth, request(state.body))
    assert.equal(replay.status, 200); assert.equal(replay.body.workflowId, state.wid)
    assert.equal(Object.hasOwn(replay.body, 'sent'), false)
    const changed = structuredClone(state.body); changed.steps[1].text = 'A different message the owner has not previously frozen.'
    assert.equal((await approvePilotEmailRequest(store, auth, request(changed))).status, 409)
    assert.equal(await count('pilot_quote_followup_workflows'), 1); assert.equal(await count('pilot_email_send_attempts'), 2)
    assert.equal(await count('messages'), 1); assert.equal(calls.length, 1)
    assert.equal(await value("select approved_steps->1->>'text' as value from public.pilot_quote_followup_workflows"), state.body.steps[1].text)
  })
  await test('review: blank copy and control-character subject cannot become approved unsendable work', async () => {
    const state = await setup()
    for (const changes of [{ subject: '   ' }, { text: ' \t\n ' }, { subject: 'Estimate\r\nInjected: value' }]) {
      const body = { ...structuredClone(state.body), quoteId: QA2 }
      body.steps[0] = { ...body.steps[0], ...changes }
      assert.equal((await approvePilotEmailRequest(store, auth, request(body))).status, 400)
      assert.equal(await value('select count(*)::int as value from public.pilot_quote_followup_workflows where quote_id=$1::uuid', [QA2]), 0)
    }
    assert.equal(await count('pilot_quote_followup_workflows'), 1)
    assert.equal(await count('messages'), 0)
  })
  await test('review: signed malformed event data is refused before durable event writes', async () => {
    const state = await setup(), calls: string[] = [], valid = event(state.to)
    for (const [index, bad] of [
      { ...valid, data: [] }, { ...valid, data: null }, { ...valid, data: { ...valid.data, email_id: 'not-an-id' } },
      { ...valid, created_at: 'not-a-time' }, { ...valid, type: null },
    ].entries()) {
      assert.equal((await invoke({ store, credentials, http: httpFixture(() => content(state.to), calls) }, state.cid, bad, `msg_bad_${index}`)).status, 400)
    }
    assert.equal(await count('pilot_email_webhook_events'), 0); assert.equal(calls.length, 0)
    assert.equal(await workflowState(state.wid), 'approved')
  })
  await test('review: correctly signed invalid UTF8 is refused without replacement-character parsing', async () => {
    const state = await setup(), calls: string[] = []
    const raw = Buffer.concat([Buffer.from('{"type":"'), Buffer.from([0xc3, 0x28]), Buffer.from('"}')])
    assert.equal((await processPilotEmailWebhook({ store, credentials, http: httpFixture(() => content(state.to), calls) }, signedBytes(state.cid, raw), state.cid)).status, 400)
    assert.equal(await count('pilot_email_webhook_events'), 0); assert.equal(calls.length, 0)
  })
  await test('review: altered raw bytes do not pass the original request signature', async () => {
    const state = await setup(), raw = Buffer.from(JSON.stringify(event(state.to))), calls: string[] = []
    const validRequest = signedBytes(state.cid, raw)
    const altered = new Request(validRequest.url, { method: 'POST', headers: validRequest.headers, body: Buffer.concat([raw, Buffer.from(' ')]) })
    assert.equal((await processPilotEmailWebhook({ store, credentials, http: httpFixture(() => content(state.to), calls) }, altered, state.cid)).status, 403)
    assert.equal(await count('pilot_email_webhook_events'), 0); assert.equal(calls.length, 0)
  })
  await test('review: ambiguous real reply tokens cannot pick one workflow route', async () => {
    const state = await setup(), calls: string[] = [], body = event(state.to)
    body.data.to.push(String(state.attempts[1].payload.reply_to))
    assert.equal((await invoke({ store, credentials, http: httpFixture(() => content(state.to), calls) }, state.cid, body)).status, 204)
    assert.equal(await workflowState(state.wid), 'approved'); assert.equal(calls.length, 0)
    assert.equal(await value('select error_code as value from public.pilot_email_webhook_events'), 'unknown_route')
    assert.equal(await count('messages'), 0)
  })
  await test('review: fetched wrong route stays held without storing body or following URLs', async () => {
    const state = await setup(), calls: string[] = []
    const fetched = { ...content(String(state.attempts[1].payload.reply_to), 'unsubscribe'),
      html: '<img src="https://tracking.example.invalid/pixel">', raw: 'https://raw.example.invalid/message',
      attachments: [{ url: 'https://attachment.example.invalid/file' }] }
    assert.equal((await invoke({ store, credentials, http: httpFixture(() => fetched, calls) }, state.cid, event(state.to))).status, 503)
    assert.equal(await workflowState(state.wid), 'held'); assert.equal(await count('messages'), 0)
    assert.equal(await count('consent_changes'), 0)
    assert.deepEqual(calls, [`https://api.resend.com/emails/receiving/${RECEIVED}?html_format=cid`])
  })
  await test('review: HTML-only provider content is held for review without executing remote content', async () => {
    const state = await setup(), calls: string[] = []
    const fetched = { ...content(state.to), text: null, html: '<img src="https://tracking.example.invalid/pixel"><script>fetch("https://script.example.invalid")</script>' }
    assert.equal((await invoke({ store, credentials, http: httpFixture(() => fetched, calls) }, state.cid, event(state.to))).status, 503)
    assert.equal(await workflowState(state.wid), 'held'); assert.equal(await count('messages'), 0)
    assert.equal(await value('select state as value from public.pilot_email_webhook_events'), 'pending')
    assert.deepEqual(calls, [`https://api.resend.com/emails/receiving/${RECEIVED}?html_format=cid`])
  })
  await test('review: fetched email ID mismatch cannot write another message under the signed ID', async () => {
    const state = await setup(), calls: string[] = []
    assert.equal((await invoke({ store, credentials, http: httpFixture(() => ({ ...content(state.to), id: SENT }), calls) }, state.cid, event(state.to))).status, 503)
    assert.equal(await count('messages'), 0); assert.equal(await workflowState(state.wid), 'held')
    assert.equal(await value('select error_code as value from public.pilot_email_webhook_events'), 'content_unavailable')
  })
  await test('review: matching signed and fetched sender still cannot replace the approved recipient', async () => {
    const state = await setup(), calls: string[] = [], stranger = 'another@customer.example.invalid'
    assert.equal((await invoke({ store, credentials, http: httpFixture(() => ({ ...content(state.to, 'unsubscribe'), from: stranger }), calls) }, state.cid, event(state.to, stranger))).status, 204)
    assert.equal(await value('select error_code as value from public.pilot_email_webhook_events'), 'sender_mismatch')
    assert.equal(await count('messages'), 0); assert.equal(await count('consent_changes'), 0)
    assert.equal(await workflowState(state.wid), 'held')
  })
  await test('review: auth exceptions disclose no raw details or private connection fields', async () => {
    const state = await setup()
    const response = await approvePilotEmailRequest(store, { getUser: async () => { throw new Error('synthetic_private_auth_detail') } }, request(state.body))
    assert.equal(response.status, 503)
    assert.equal(JSON.stringify(response).includes('synthetic_private_auth_detail'), false)
    assert.equal(JSON.stringify(response).includes('PILOT_REVIEW_A'), false)
    assert.equal(await count('pilot_quote_followup_workflows'), 1)
  })
  await test('review: actual private-table read denial stops worker with zero provider fallback', async () => {
    const state = await setup(), calls: string[] = []
    await db.exec('revoke select on public.pilot_email_connections from service_role')
    const result = await dispatchApprovedPilotEmail({ store, credentials, http: httpFixture(() => ({ id: SENT }), calls) }, state.wid, 1)
    assert.notEqual(result.code, 'finalized'); assert.equal(calls.length, 0); assert.equal(await count('messages'), 0)
    assert.equal(await value('select count(*)::int as value from public.pilot_email_send_attempts where first_started_at is not null'), 0)
  })
  await test('review: native reply fault returns retryable HTTP while preserving route hold and atomic consent', async () => {
    const state = await setup(), calls: string[] = [], runtime = { store, credentials, http: httpFixture(() => content(state.to, 'unsubscribe'), calls) }
    await db.exec(`create function public.pilot_review_reply_fault() returns trigger language plpgsql as $$begin
      if new.direction='inbound' then raise exception 'synthetic_private_write_failure'; end if; return new; end$$;
      create trigger pilot_review_reply_fault before insert on public.messages for each row execute function public.pilot_review_reply_fault()`)
    assert.deepEqual(await invoke(runtime, state.cid, event(state.to)), { status: 503 })
    assert.equal(await workflowState(state.wid), 'held'); assert.equal(await count('messages'), 0); assert.equal(await count('consent_changes'), 0)
    assert.equal(await value('select state as value from public.pilot_email_webhook_events'), 'pending')
    await db.exec('drop trigger pilot_review_reply_fault on public.messages; drop function public.pilot_review_reply_fault()')
    assert.equal((await invoke(runtime, state.cid, event(state.to))).status, 204)
    assert.equal(await count('messages'), 1); assert.equal(await count('consent_changes'), 1)
  })
  await test('review: oversized declared webhook content cannot reach private event mutation', async () => {
    const state = await setup(), calls: string[] = [], raw = Buffer.from(JSON.stringify(event(state.to)))
    const response = await processPilotEmailWebhook({ store, credentials, http: httpFixture(() => content(state.to), calls) },
      signedBytes(state.cid, raw, 'msg_oversized', { 'content-length': '131073' }), state.cid)
    assert.equal(response.status, 413); assert.equal(await count('pilot_email_webhook_events'), 0); assert.equal(calls.length, 0)
  })
  await test('review: confirmation write failure retries original provider key and bytes without a false native receipt', async () => {
    const state = await setup(), sends: { body: string; key: string | null }[] = []
    const http = (async (_url: unknown, init?: RequestInit) => {
      sends.push({ body: String(init?.body), key: new Headers(init?.headers).get('idempotency-key') }); return Response.json({ id: SENT })
    }) as typeof fetch
    await db.exec(`create function public.pilot_review_confirm_fault() returns trigger language plpgsql as $$begin
      if new.provider_email_id is not null and old.provider_email_id is null then raise exception 'synthetic_confirm_failure'; end if; return new; end$$;
      create trigger pilot_review_confirm_fault before update on public.pilot_email_send_attempts for each row execute function public.pilot_review_confirm_fault()`)
    assert.equal((await dispatchApprovedPilotEmail({ store, credentials, http }, state.wid, 1)).code, 'pending')
    assert.equal(await count('messages'), 0); assert.equal(await count('notification_log'), 0)
    await db.exec('drop trigger pilot_review_confirm_fault on public.pilot_email_send_attempts; drop function public.pilot_review_confirm_fault()')
    assert.equal((await dispatchApprovedPilotEmail({ store, credentials, http }, state.wid, 1)).code, 'finalized')
    assert.equal(sends.length, 2); assert.deepEqual(sends[0], sends[1]); assert.equal(await count('messages'), 1)
  })
  return results
}
