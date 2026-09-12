import assert from 'node:assert/strict'
import { createHmac } from 'node:crypto'
import type { SupabaseClient } from '@supabase/supabase-js'
import type { Database, TestResult } from './database'
import { createPilotStore, type PilotConnection, type PilotRecord } from '../../src/lib/comms/pilotEmailStore'
import { dispatchApprovedPilotEmail, type PilotEmailRuntime } from '../../src/lib/comms/pilotEmailAttempt'
import { processPilotEmailWebhook, verifyClientEmailSignature } from '../../src/lib/comms/pilotEmailEvents'
import { approvePilotEmailRequest, pausePilotEmailRequest } from '../../src/lib/comms/pilotEmailOwner'
import { dispatchToCustomer } from '../../src/lib/comms/dispatch'
import { SKIP_REASON } from '../../src/lib/comms/skipReasons'

const A = '00000000-0000-4000-8000-0000000000a1', B = '00000000-0000-4000-8000-0000000000b1'
const CA = '00000000-0000-4000-8000-0000000000a2', CB = '00000000-0000-4000-8000-0000000000b2'
const QA = '00000000-0000-4000-8000-0000000000a3', QB = '00000000-0000-4000-8000-0000000000b3'
const SENT = '00000000-0000-4000-8000-0000000000e1', RECEIVED = '00000000-0000-4000-8000-0000000000f1'
const syntheticSecret = (owner: string) => 'whsec_' + Buffer.alloc(32, owner === A ? 65 : 66).toString('base64')

// Exercise createPilotStore and native governCheck against real SQL. This tiny
// Supabase-shaped fixture replaces REST transport only; SELECTs and RPC verdicts
// run in PostgreSQL with actual baseline/proposal functions and service grants.
// Supabase HTTP/JWT validation itself is explicitly outside this fixture.
export function sqlSupabase(db: Database): SupabaseClient {
  const identifier = (s: string) => { assert.match(s, /^[a-z_]+$/); return '"' + s + '"' }
  const execute = async (sql: string, params: unknown[]) => {
    await db.exec('savepoint runtime_transport; set local role service_role')
    try {
      const result = await db.query(sql, params)
      await db.exec('reset role; release savepoint runtime_transport')
      return { rows: result.rows, error: null }
    } catch (error) {
      await db.exec('rollback to savepoint runtime_transport; reset role; release savepoint runtime_transport')
      return { rows: [], error }
    }
  }
  const client = {
    async rpc(name: string, args: PilotRecord) {
      assert.match(name, /^pilot_email_[a-z_]+$/)
      const values = Object.values(args).map(v => v !== null && typeof v === 'object' ? JSON.stringify(v) : v)
      const argumentsSql = Object.keys(args).map((key, i) => identifier(key) + ' => $' + (i + 1) + (key === 'p_steps' ? '::jsonb' : '')).join(',')
      const r = await execute(`select public.${identifier(name)}(${argumentsSql}) as value`, values)
      return { data: r.rows[0]?.value ?? null, error: r.error }
    },
    from(table: string) {
      const predicates: string[] = [], params: unknown[] = []
      let fields = 'id', count = false
      const add = (column: string, operator: string, value: unknown) => {
        params.push(value); predicates.push(`${identifier(column)} ${operator} $${params.length}`)
      }
      const run = async (single: boolean) => {
        const columns = count ? 'count(*)::int as count' : fields.split(',').map(s => identifier(s.trim())).join(',')
        const r = await execute(`select ${columns} from public.${identifier(table)}${predicates.length ? ' where ' + predicates.join(' and ') : ''}`, params)
        return { data: count ? null : single ? r.rows[0] ?? null : r.rows, count: count ? r.rows[0]?.count ?? null : null, error: r.error }
      }
      const builder = {
        select(value: string, options?: { count?: string }) { fields = value; count = options?.count === 'exact'; return builder },
        eq(column: string, value: unknown) { add(column, '=', value); return builder },
        gte(column: string, value: unknown) { add(column, '>=', value); return builder },
        in(column: string, values: unknown[]) {
          assert.ok(values.length > 0)
          const refs = values.map(v => { params.push(v); return '$' + params.length })
          predicates.push(`${identifier(column)} in (${refs.join(',')})`); return builder
        },
        maybeSingle() { return run(true) },
        then(resolve: (value: unknown) => unknown, reject: (reason: unknown) => unknown) { return run(false).then(resolve, reject) },
      }
      return builder
    },
  }
  return client as unknown as SupabaseClient
}

export async function runRuntimeCases(db: Database): Promise<TestResult[]> {
  const results: TestResult[] = []
  const sb = sqlSupabase(db), store = createPilotStore(sb)
  const value = async (sql: string, params: unknown[] = []) => (await db.query<{ value: unknown }>(sql, params)).rows[0]?.value
  const count = (table: string) => { assert.match(table, /^[a-z_]+$/); return value(`select count(*)::int as value from public.${table}`) }
  const test = async (name: string, action: () => Promise<void>) => {
    await db.exec('begin')
    try {
      await db.exec(`update public.business_settings set timezone=case when extract(hour from clock_timestamp() at time zone 'UTC')::int=12 then 'Etc/UTC'
        when extract(hour from clock_timestamp() at time zone 'UTC')::int>12 then 'Etc/GMT+'||(extract(hour from clock_timestamp() at time zone 'UTC')::int-12)::text
        else 'Etc/GMT'||(extract(hour from clock_timestamp() at time zone 'UTC')::int-12)::text end`)
      await action(); results.push({ name, pass: true })
    } catch (error) { results.push({ name, pass: false, error: error instanceof Error ? error.message.slice(0, 1000) : 'Runtime assertion failed' }) }
    finally { await db.exec('rollback') }
  }
  const credentials = async (c: PilotConnection) => ({ connectionId: c.id, accountScope: c.account_scope,
    credentialVersion: c.credential_version, secretRef: c.secret_ref, apiKey: 're_synthetic_not_a_real_key', webhookSecret: syntheticSecret(c.user_id) })
  const setup = async (owner = A) => {
    const label = owner === A ? 'a' : 'b'
    const c = await store.rpc('pilot_email_create_connection', { p_owner: owner, p_account_scope: 'synthetic-' + label,
      p_from_address: `quotes@business-${label}.example.invalid`, p_receiving_domain: `reply-${label}.example.invalid`, p_secret_ref: 'PILOT_TEST_' + label, p_credential_version: 'v1' })
    assert.equal(c.code, 'created')
    const cid = String(c.connection_id)
    await store.rpc('pilot_email_set_connection_state', { p_connection: cid, p_state: 'verified' })
    await store.rpc('pilot_email_set_connection_state', { p_connection: cid, p_state: 'active' })
    const steps = [{ subject: 'Your estimate', text: 'Please review your requested estimate.', due_at: await value("select (clock_timestamp()-interval '1 second')::text as value") }]
    const body = { connectionId: cid, customerId: owner === A ? CA : CB, quoteId: owner === A ? QA : QB, steps }
    return { cid, body }
  }
  const auth = (owner: string | null) => ({ getUser: async () => ({ data: { user: owner ? { id: owner } : null }, error: null }) })
  const ownerRequest = (body: unknown, origin = 'https://example.invalid') => new Request('https://example.invalid/pilot/approve', {
    method: 'POST', headers: { 'content-type': 'application/json', origin }, body: JSON.stringify(body),
  })
  const approved = async (owner = A) => {
    const { cid, body } = await setup(owner)
    const response = await approvePilotEmailRequest(store, auth(owner), ownerRequest(body))
    assert.equal(response.status, 200)
    return { cid, wid: String(response.body.workflowId), body }
  }
  const attempt = async (wid: string) => (await db.query<Record<string, unknown>>('select id,payload,reply_token,first_started_at,provider_email_id from public.pilot_email_send_attempts where workflow_id=$1::uuid', [wid])).rows[0]
  const signedRequest = (cid: string, owner: string, payload: unknown, id = 'msg_fixture_event') => {
    const raw = JSON.stringify(payload), ts = String(Math.floor(Date.now() / 1000))
    const signature = createHmac('sha256', Buffer.from(syntheticSecret(owner).slice(6), 'base64')).update(`${id}.${ts}.${raw}`).digest('base64')
    return new Request(`https://example.invalid/pilot/events/${cid}`, { method: 'POST', headers: {
      'content-type': 'application/json', 'svix-id': id, 'svix-timestamp': ts, 'svix-signature': 'v1,' + signature,
    }, body: raw })
  }
  const emailEvent = (type: string, providerId: string, to?: string) => ({ type, created_at: new Date().toISOString(), data: {
    email_id: providerId, from: 'Customer <shared@customer.example.invalid>', ...(to ? { to: [to] } : {}),
  } })
  const receivedContent = (to: string, text = 'Thanks, I have a question.') => ({ id: RECEIVED, from: 'Customer <shared@customer.example.invalid>',
    to: [to], text, html: null, created_at: new Date().toISOString(), message_id: '<synthetic@example.invalid>' })
  const okaySend = (calls: string[]) => (async (_url: unknown, init?: RequestInit) => { calls.push(String(init?.body)); return Response.json({ id: SENT }) }) as typeof fetch

  await test('owner request refuses unauthenticated, other owner, crew and cross-origin approval', async () => {
    const { body } = await setup()
    for (const who of [null, B, '00000000-0000-4000-8000-0000000000c1']) {
      assert.notEqual((await approvePilotEmailRequest(store, auth(who), ownerRequest(body))).status, 200)
    }
    assert.equal((await approvePilotEmailRequest(store, auth(A), ownerRequest(body, 'https://attacker.invalid'))).status, 400)
    assert.equal(await count('pilot_quote_followup_workflows'), 0)
  })
  await test('owner request cannot supply approver, recipient or From; approval itself never sends', async () => {
    const { body } = await setup()
    for (const extra of [{ approved_by: A }, { ownerId: A }, { to: 'elsewhere@example.invalid' }, { from: 'elsewhere@example.invalid' }]) {
      assert.equal((await approvePilotEmailRequest(store, auth(A), ownerRequest({ ...body, ...extra }))).status, 400)
    }
    assert.equal((await approvePilotEmailRequest(store, auth(A), ownerRequest(body))).status, 200)
    assert.equal(await count('messages'), 0); assert.equal(await count('notification_log'), 0)
    assert.equal(await value('select approved_by::text as value from public.pilot_quote_followup_workflows'), A)
  })
  await test('owner replay cannot resume a paused workflow or reset its step budget', async () => {
    const { wid, body } = await approved()
    assert.equal((await pausePilotEmailRequest(store, auth(B), ownerRequest({ workflowId: wid }))).status, 404)
    assert.equal((await pausePilotEmailRequest(store, auth(A), ownerRequest({ workflowId: wid }))).status, 200)
    assert.equal((await approvePilotEmailRequest(store, auth(A), ownerRequest(body))).status, 409)
    assert.equal(await count('pilot_email_send_attempts'), 1)
  })
  await test('worker sends frozen approved bytes and finalizes one native bubble/log; replay never calls provider', async () => {
    const { wid } = await approved(), calls: string[] = []
    const runtime: PilotEmailRuntime = { store, credentials, http: okaySend(calls) }
    const first = await dispatchApprovedPilotEmail(runtime, wid, 1)
    assert.equal(first.code, 'finalized')
    assert.deepEqual(await dispatchApprovedPilotEmail(runtime, wid, 1), first)
    assert.equal(calls.length, 1)
    assert.equal(calls[0], await value('select payload::text as value from public.pilot_email_send_attempts'))
    assert.equal(await count('messages'), 1); assert.equal(await count('notification_log'), 1)
  })
  await test('unknown provider outcome retries identical bytes/key and creates only one native message', async () => {
    const { wid } = await approved(), calls: { body: string; key: string | null }[] = []
    const http = (async (_url: unknown, init?: RequestInit) => {
      calls.push({ body: String(init?.body), key: new Headers(init?.headers).get('idempotency-key') })
      if (calls.length === 1) throw new Error('simulated response lost after provider accepted')
      return Response.json({ id: SENT })
    }) as typeof fetch
    const runtime = { store, credentials, http }
    assert.equal((await dispatchApprovedPilotEmail(runtime, wid, 1)).code, 'pending')
    assert.equal(await count('messages'), 0)
    assert.equal((await dispatchApprovedPilotEmail(runtime, wid, 1)).code, 'finalized')
    assert.deepEqual(calls[0], calls[1]); assert.equal(await count('messages'), 1)
  })
  await test('missing or mismatched client credentials cause zero transport and no founder fallback', async () => {
    const { wid } = await approved(), calls: string[] = []
    assert.equal((await dispatchApprovedPilotEmail({ store, credentials: async () => null, http: okaySend(calls) }, wid, 1)).code, 'unavailable')
    const wrong = async (c: PilotConnection) => ({ ...await credentials(c), accountScope: 'another-client' })
    assert.equal((await dispatchApprovedPilotEmail({ store, credentials: wrong, http: okaySend(calls) }, wid, 1)).code, 'unavailable')
    assert.equal(calls.length, 0); assert.equal(await count('messages'), 0)
  })
  await test('SQL start still refuses consent revoked after shared reach/govern reads', async () => {
    const { wid } = await approved(), calls: string[] = []
    const racingStore = { ...store, govern: async (owner: string, customer: string) => {
      const allowed = await store.govern(owner, customer)
      await db.query('update public.customers set email_opt_in=false where id=$1::uuid', [CA])
      return allowed
    } }
    assert.equal((await dispatchApprovedPilotEmail({ store: racingStore, credentials, http: okaySend(calls) }, wid, 1)).code, 'blocked')
    assert.equal(calls.length, 0)
  })
  await test('confirmed native-store failure reconciles after disconnect with no second provider call', async () => {
    const { cid, wid } = await approved(), calls: string[] = []
    await db.exec(`create function public.runtime_fail_log() returns trigger language plpgsql as $$begin raise exception 'synthetic_native_fault'; end$$;
      create trigger runtime_fail_log before insert on public.notification_log for each row execute function public.runtime_fail_log()`)
    const runtime = { store, credentials, http: okaySend(calls) }
    assert.equal((await dispatchApprovedPilotEmail(runtime, wid, 1)).code, 'pending')
    assert.equal(await count('messages'), 0)
    assert.equal((await attempt(wid)).provider_email_id, SENT)
    await db.exec('drop trigger runtime_fail_log on public.notification_log; drop function public.runtime_fail_log()')
    await store.rpc('pilot_email_set_connection_state', { p_connection: cid, p_state: 'disconnected' })
    assert.equal((await dispatchApprovedPilotEmail({ ...runtime, credentials: async () => null }, wid, 1)).code, 'finalized')
    assert.equal(calls.length, 1); assert.equal(await count('messages'), 1)
  })
  await test('official Svix vector verifies raw bytes, v1, rotation list and replay time', async () => {
    const raw = Buffer.from('{"event_type":"ping","data":{"success":true}}')
    const h = new Headers({ 'svix-id': 'msg_loFOjxBNrRLzqYUf', 'svix-timestamp': '1731705121', 'svix-signature': 'v1,rAvfW3dJ/X/qxhsaXPOyyCGmRKsaKWcsNccKXlIktD0=' })
    const secret = 'whsec_plJ3nmyCDGBKInavdOK15jsl'
    assert.equal(verifyClientEmailSignature(raw, h, secret, 1731705121000), true)
    assert.equal(verifyClientEmailSignature(Buffer.concat([raw, Buffer.from(' ')]), h, secret, 1731705121000), false)
    assert.equal(verifyClientEmailSignature(raw, h, secret, 1731705422000), false)
    h.set('svix-signature', h.get('svix-signature')!.replace('v1,', 'v2,'))
    assert.equal(verifyClientEmailSignature(raw, h, secret, 1731705121000), false)
  })
  await test('wrong connection signature performs no event writes or content retrieval', async () => {
    const { cid } = await approved(), calls: string[] = []
    const request = signedRequest(cid, B, emailEvent('email.received', RECEIVED, 'f'.repeat(48) + '@reply-a.example.invalid'))
    assert.equal((await processPilotEmailWebhook({ store, credentials, http: okaySend(calls) }, request, cid)).status, 403)
    assert.equal(await count('pilot_email_webhook_events'), 0); assert.equal(calls.length, 0)
  })
  await test('received event durably holds the quote before a failing content fetch', async () => {
    const { cid, wid } = await approved(), a = await attempt(wid), to = (a.payload as PilotRecord).reply_to as string
    let observedHold = false
    const http = (async () => { observedHold = await value('select state as value from public.pilot_quote_followup_workflows where id=$1::uuid', [wid]) === 'held'; throw new Error('simulated receiving outage') }) as typeof fetch
    const event = emailEvent('email.received', RECEIVED, to)
    assert.equal((await processPilotEmailWebhook({ store, credentials, http }, signedRequest(cid, A, event), cid)).status, 503)
    assert.equal(observedHold, true)
    assert.equal((await dispatchApprovedPilotEmail({ store, credentials, http }, wid, 1)).code, 'blocked')
    assert.equal(await count('messages'), 0)
  })
  await test('same event and duplicate received-email IDs create one native inbound message', async () => {
    const { cid, wid } = await approved(), a = await attempt(wid), to = (a.payload as PilotRecord).reply_to as string
    let fetched = 0
    const http = (async () => { fetched++; return Response.json(receivedContent(to)) }) as typeof fetch
    const event = emailEvent('email.received', RECEIVED, to), runtime = { store, credentials, http }
    for (const id of ['msg_one', 'msg_one', 'msg_two']) {
      assert.equal((await processPilotEmailWebhook(runtime, signedRequest(cid, A, event, id), cid)).status, 204)
    }
    assert.equal(await count('messages'), 1); assert.equal(await count('pilot_email_webhook_events'), 2)
    assert.equal(fetched, 2)
  })
  await test('forged fetched sender does not mutate consent or create a native bubble', async () => {
    const { cid, wid } = await approved(), a = await attempt(wid), to = (a.payload as PilotRecord).reply_to as string
    const http = (async () => Response.json({ ...receivedContent(to, 'unsubscribe'), from: 'someoneelse@example.invalid' })) as typeof fetch
    assert.equal((await processPilotEmailWebhook({ store, credentials, http }, signedRequest(cid, A, emailEvent('email.received', RECEIVED, to)), cid)).status, 503)
    assert.equal(await count('messages'), 0)
    assert.equal(await value('select email_opt_in as value from public.customers where id=$1::uuid', [CA]), true)
  })
  await test('verified exact unsubscribe changes only the routed owner/customer and audits once', async () => {
    const { cid, wid } = await approved(), a = await attempt(wid), to = (a.payload as PilotRecord).reply_to as string
    const http = (async () => Response.json(receivedContent(to, 'unsubscribe'))) as typeof fetch
    assert.equal((await processPilotEmailWebhook({ store, credentials, http }, signedRequest(cid, A, emailEvent('email.received', RECEIVED, to)), cid)).status, 204)
    assert.equal(await value('select email_opt_in as value from public.customers where id=$1::uuid', [CA]), false)
    assert.equal(await value('select email_opt_in as value from public.customers where id=$1::uuid', [CB]), true)
    assert.equal(await value("select count(*)::int as value from public.consent_changes where channel='email' and new_value=false"), 1)
  })
  await test('delivery callback before local receipt is retryable, then reconciles and never downgrades', async () => {
    const { cid, wid } = await approved(), calls: string[] = []
    const runtime = { store, credentials, http: okaySend(calls) }
    const delivered = emailEvent('email.delivered', SENT)
    assert.equal((await processPilotEmailWebhook(runtime, signedRequest(cid, A, delivered, 'msg_delivery'), cid)).status, 503)
    assert.equal((await dispatchApprovedPilotEmail(runtime, wid, 1)).code, 'finalized')
    assert.equal((await processPilotEmailWebhook(runtime, signedRequest(cid, A, delivered, 'msg_delivery'), cid)).status, 204)
    assert.equal((await processPilotEmailWebhook(runtime, signedRequest(cid, A, emailEvent('email.sent', SENT), 'msg_sent_late'), cid)).status, 204)
    assert.equal(await value('select status as value from public.messages'), 'delivered')
    assert.equal(await value('select status as value from public.notification_log'), 'delivered')
    assert.equal(calls.length, 1)
  })
  await test('native legacy dispatch still denies the founder email identity for a second owner', async () => {
    const result = await dispatchToCustomer(sb, { userId: B, customer: { id: CB, phone: null,
      email: 'shared@customer.example.invalid', sms_opt_in: false, email_opt_in: true }, channels: ['email'],
      smsText: 'Synthetic', emailSubject: 'Synthetic', emailHtml: '<p>Synthetic</p>', emailText: 'Synthetic', template: 'estimate_followup' })
    assert.deepEqual(result.sentChannels, []); assert.equal(result.attempts[0].sent, false)
    assert.equal(result.attempts[0].status, 'skipped'); assert.equal(result.attempts[0].detail, SKIP_REASON.NOT_ENABLED)
    assert.equal(await count('messages'), 0); assert.equal(await count('platform_capabilities'), 0)
  })
  return results
}
