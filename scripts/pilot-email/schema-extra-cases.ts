import assert from 'node:assert/strict'
import { createHash, randomBytes, randomUUID } from 'node:crypto'
import type { Database } from './database'

// Additional actual-SQL cases. The driver applies the real baseline/proposal and
// seeds native-fixtures.sql once before calling this module. Every case rolls back.
// Calling the service event RPC models already-verified transport metadata; this
// does NOT prove a raw webhook signature, provider identity or HTTP delivery.
// No triggers, policies, publication rules or application clocks are replaced.
const A = '00000000-0000-4000-8000-0000000000a1'
const B = '00000000-0000-4000-8000-0000000000b1'
const CA = '00000000-0000-4000-8000-0000000000a2'
const CB = '00000000-0000-4000-8000-0000000000b2'
const QA = '00000000-0000-4000-8000-0000000000a3'
const QA2 = '00000000-0000-4000-8000-0000000000a4'
const QB = '00000000-0000-4000-8000-0000000000b3'
const RECIPIENT = 'shared@customer.example.invalid'
type Verdict = { code: string; [key: string]: unknown }
type CaseResult = { name: string; pass: boolean; error?: string }
type Attempt = { attempt_id: string; fence: unknown }

export async function runExtraCases(db: Database): Promise<CaseResult[]> {
  const results: CaseResult[] = []
  const scalar = async (sql: string, params: unknown[] = []) => (await db.query<{ value: unknown }>(sql, params)).rows[0]?.value
  const count = async (sql: string, params: unknown[] = []) => Number(await scalar(sql, params))
  const rpc = async (sql: string, params: unknown[] = []): Promise<Verdict> => {
    await db.exec(`set local role service_role;
      select set_config('request.jwt.claim.sub','',true), set_config('request.jwt.claims','{"role":"service_role"}',true)`)
    try {
      const value = await scalar(sql, params)
      assert.ok(value && typeof value === 'object', 'Actual RPC must return a structured result')
      return value as Verdict
    } finally { await db.exec('reset role').catch(() => {}) }
  }
  const test = async (name: string, work: () => Promise<void>) => {
    await db.exec('begin')
    try {
      await db.exec(`update public.business_settings set timezone=case
        when extract(hour from clock_timestamp() at time zone 'UTC')::int=12 then 'Etc/UTC'
        when extract(hour from clock_timestamp() at time zone 'UTC')::int>12
          then 'Etc/GMT+'||(extract(hour from clock_timestamp() at time zone 'UTC')::int-12)::text
        else 'Etc/GMT'||(extract(hour from clock_timestamp() at time zone 'UTC')::int-12)::text end`)
      await work()
      results.push({ name, pass: true })
    } catch (error) {
      results.push({ name, pass: false, error: error instanceof Error ? error.message.slice(0, 1400) : 'Assertion failed' })
    } finally { await db.exec('rollback') }
  }
  const mustRejectSql = async (sql: string, params: unknown[] = [], allowedCodes = ['23503', '23514']) => {
    await db.exec('savepoint expected_refusal')
    let code: string | undefined
    try { await db.query(sql, params) } catch (error) {
      code = error && typeof error === 'object' && 'code' in error ? String(error.code) : 'missing_sqlstate'
    } finally {
      await db.exec('rollback to savepoint expected_refusal; release savepoint expected_refusal')
    }
    assert.ok(code && allowedCodes.includes(code), `Expected constrained refusal, received ${code ?? 'success'}`)
  }
  const connection = async (owner = A) => {
    const suffix = owner === A ? 'a' : 'b'
    const created = await rpc('select public.pilot_email_create_connection($1::uuid,$2,$3,$4,$5,$6) as value',
      [owner, `synthetic-${suffix}`, `quotes@business-${suffix}.example.invalid`, `reply-${suffix}.example.invalid`, `PILOT_FIXTURE_${suffix}`, 'version-1'])
    assert.equal(created.code, 'created')
    const id = String(created.connection_id)
    for (const state of ['verified', 'active']) {
      assert.equal((await rpc('select public.pilot_email_set_connection_state($1::uuid,$2) as value', [id, state])).code, 'updated')
    }
    return id
  }
  const copy = async (steps = 2) => {
    const due = String(await scalar("select (clock_timestamp()-interval '2 minutes')::text as value"))
    const later = String(await scalar("select (clock_timestamp()-interval '1 minute')::text as value"))
    return [
      { subject: 'Your requested estimate', text: 'Please review your requested estimate.', due_at: due },
      { subject: 'Any questions about your estimate?', text: 'Let us know if you have questions.', due_at: later },
    ].slice(0, steps)
  }
  const approve = (cid: string, customer: string, quote: string, steps: unknown, owner = A) =>
    rpc('select public.pilot_email_approve_workflow($1::uuid,$2::uuid,$3::uuid,$4::jsonb,$5::uuid) as value', [cid, customer, quote, JSON.stringify(steps), owner])
  const workflow = async (cid: string, customer = CA, quote = QA, owner = A) => {
    const result = await approve(cid, customer, quote, await copy(), owner)
    assert.equal(result.code, 'approved')
    return String(result.workflow_id)
  }
  const claim = async (wid: string, step = 1): Promise<Attempt> => {
    const result = await rpc('select public.pilot_email_claim($1::uuid,$2) as value', [wid, step])
    assert.equal(result.code, 'claimed')
    return { attempt_id: String(result.attempt_id), fence: result.fence }
  }
  const start = (attempt: Attempt) => rpc('select public.pilot_email_start($1::uuid,$2::bigint) as value', [attempt.attempt_id, attempt.fence])
  const finalize = (attempt: Attempt) => rpc('select public.pilot_email_finalize($1::uuid,$2::bigint) as value', [attempt.attempt_id, attempt.fence])
  const confirm = async (attempt: Attempt, id: string) => {
    assert.equal((await rpc('select public.pilot_email_confirm($1::uuid,$2::bigint,$3) as value', [attempt.attempt_id, attempt.fence, id])).code, 'confirmed')
  }
  const tokenFor = async (wid: string) => String(await scalar('select reply_token as value from public.pilot_email_send_attempts where workflow_id=$1::uuid and step=1', [wid]))
  const event = (cid: string, id: string, type: string, providerId: string, token: string | null = null) =>
    rpc('select public.pilot_email_claim_event($1::uuid,$2,$3,$4,$5) as value', [cid, id, type, providerId, token])
  const finishEvent = (evt: Verdict, sender: string | null = null, body: string | null = null, occurred: string | null = null) =>
    rpc('select public.pilot_email_finalize_event($1::uuid,$2::bigint,$3,$4,$5::timestamptz,$6) as value', [evt.event_id, evt.fence, sender, body, occurred, body === null ? null : '<fictional-reply@customer.example.invalid>'])
  const setup = async (owner = A, customer = CA, quote = QA) => {
    const cid = await connection(owner), wid = await workflow(cid, customer, quote, owner), attempt = await claim(wid)
    const started = await start(attempt)
    assert.equal(started.code, 'started')
    return { cid, wid, attempt, started, token: await tokenFor(wid) }
  }
  const sent = async () => {
    const state = await setup()
    await confirm(state.attempt, 'fictional-outbound-1')
    const receipt = await finalize(state.attempt)
    assert.equal(receipt.code, 'finalized')
    return { ...state, receipt }
  }
  const inboundCount = () => count("select count(*) as value from public.messages where direction='inbound'")
  const optIn = (customer = CA) => scalar('select email_opt_in as value from public.customers where id=$1::uuid', [customer])

  // Explicit historical fixture creation, NOT a clock override or immutable-field
  // UPDATE. A real RPC first supplies a valid connection/approved payload. New
  // historical identities are INSERTed with coherent creation/approval/due/start
  // times; all proposal/native constraints and triggers remain enabled. This
  // proves recovery from stored history, not the passage of 23 wall-clock hours.
  const historical = async (hours: number, confirmed: boolean) => {
    const origin = await setup()
    assert.equal((await rpc('select public.pilot_email_set_connection_state($1::uuid,$2) as value', [origin.cid, 'paused'])).code, 'updated')
    const cid = randomUUID(), wid = randomUUID(), aid = randomUUID()
    await db.query(`insert into public.pilot_email_connections
      (id,user_id,account_scope,credential_version,secret_ref,from_address,receiving_domain,state,created_at,verified_at)
      select $1::uuid,user_id,account_scope,credential_version,secret_ref,from_address,receiving_domain,'active',
        clock_timestamp()-interval '4 days',clock_timestamp()-interval '3 days'
      from public.pilot_email_connections where id=$2::uuid`, [cid, origin.cid])
    const due = String(await scalar("select (clock_timestamp()-interval '2 days')::text as value"))
    const historicalCopy = [{ subject: 'Your requested estimate', text: 'Please review your requested estimate.', due_at: due }]
    await db.query(`insert into public.pilot_quote_followup_workflows
      (id,user_id,connection_id,account_scope,credential_version,customer_id,quote_id,material_hash,terms_hash,quote_sent_at,
       recipient_email,approved_by,approved_at,approved_steps,step_count,created_at)
      select $1::uuid,c.user_id,c.id,c.account_scope,c.credential_version,q.customer_id,q.id,
        public.quote_material_fingerprint(q.id),public.quote_terms_fingerprint(c.user_id),q.sent_at,
        $4,c.user_id,clock_timestamp()-interval '60 hours',$5::jsonb,1,clock_timestamp()-interval '60 hours'
      from public.pilot_email_connections c join public.quotes q on q.user_id=c.user_id
      where c.id=$2::uuid and q.id=$3::uuid`, [wid, cid, QA2, RECIPIENT, JSON.stringify(historicalCopy)])
    const token = randomBytes(24).toString('hex')
    const originalPayload = origin.started.payload as Record<string, unknown>
    const payload = { ...originalPayload, reply_to: token + '@' + String(originalPayload.reply_to).split('@')[1] }
    await db.query(`insert into public.pilot_email_send_attempts
      (id,workflow_id,user_id,connection_id,customer_id,quote_id,step,due_at,payload,payload_hash,idempotency_key,reply_token,
       state,fence,lease_until,first_started_at,provider_email_id,confirmed_at,created_at)
      values($1::uuid,$3::uuid,$4::uuid,$2::uuid,$5::uuid,$6::uuid,1,clock_timestamp()-interval '2 days',$9::jsonb,
        encode(extensions.digest(($9::jsonb)::text,'sha256'),'hex'),'pilot-email/'||$1,
        $10,case when $8::boolean then 'confirmed' else 'started' end,1,
        clock_timestamp()-interval '1 minute',clock_timestamp()-($7::numeric*interval '1 hour'),
        case when $8::boolean then 'fictional-historical-receipt' else null end,
        case when $8::boolean then clock_timestamp()-($7::numeric*interval '1 hour')+interval '1 second' else null end,
        clock_timestamp()-interval '60 hours')`,
    [aid, cid, wid, A, CA, QA2, hours, confirmed, JSON.stringify(payload), token])
    const before = (await db.query<{ key: string; first: string; payload: string }>(
      'select idempotency_key as key,first_started_at::text as first,payload::text as payload from public.pilot_email_send_attempts where id=$1::uuid', [aid])).rows[0]
    return { cid, wid, aid, before }
  }

  await test('extra: SQL canonical payload bytes parse identically and match SHA256', async () => {
    const { started } = await setup()
    assert.equal(typeof started.payload_json, 'string')
    assert.deepEqual(JSON.parse(String(started.payload_json)), started.payload)
    assert.equal(createHash('sha256').update(String(started.payload_json)).digest('hex'), started.payload_hash)
  })
  await test('extra: verified route holds next step before content retrieval and survives fetch failure', async () => {
    const state = await sent(), second = await claim(state.wid, 2)
    const reply = await event(state.cid, 'reply-before-content', 'email.received', 'inbound-1', state.token)
    assert.equal(reply.code, 'claimed')
    assert.equal(await scalar('select state as value from public.pilot_quote_followup_workflows where id=$1::uuid', [state.wid]), 'held')
    assert.equal(await inboundCount(), 0)
    assert.equal((await start(second)).code, 'held')
    assert.equal((await rpc('select public.pilot_email_fail_event($1::uuid,$2::bigint,$3) as value', [reply.event_id, reply.fence, 'content_unavailable'])).code, 'released')
    assert.equal(await scalar('select state as value from public.pilot_email_webhook_events where id=$1::uuid', [reply.event_id]), 'pending')
    assert.equal((await start(second)).code, 'held')
    assert.equal(await inboundCount(), 0)
  })
  await test('extra: wrong connection or unknown token cannot hold a same-email customer', async () => {
    const a = await setup(), b = await setup(B, CB, QB)
    assert.equal((await event(b.cid, 'wrong-account', 'email.received', 'inbound-1', a.token)).code, 'needs_review')
    assert.equal((await event(a.cid, 'unknown-token', 'email.received', 'inbound-2', 'f'.repeat(48))).code, 'needs_review')
    assert.equal(await count("select count(*) as value from public.pilot_quote_followup_workflows where state='approved'"), 2)
    assert.equal(await count('select count(*) as value from public.pilot_email_webhook_events where attempt_id is not null'), 0)
    assert.equal(await inboundCount(), 0)
  })
  await test('extra: exact owner-B route writes only B despite identical email in A', async () => {
    await setup()
    const b = await setup(B, CB, QB), reply = await event(b.cid, 'b-reply', 'email.received', 'b-inbound', b.token)
    assert.equal(reply.code, 'claimed')
    assert.equal((await finishEvent(reply, RECIPIENT, 'A question about this quote.')).code, 'completed')
    assert.equal(await count('select count(*) as value from public.messages where user_id=$1::uuid and customer_id=$2::uuid', [B, CB]), 1)
    assert.equal(await count('select count(*) as value from public.messages where user_id=$1::uuid', [A]), 0)
    assert.equal(await scalar('select state as value from public.pilot_quote_followup_workflows where quote_id=$1::uuid', [QA]), 'approved')
  })
  await test('extra: event replay and second event for one received email create one native reply', async () => {
    const state = await sent(), first = await event(state.cid, 'reply-id-1', 'email.received', 'same-received-email', state.token)
    const done = await finishEvent(first, RECIPIENT, 'Please call me.')
    assert.equal(done.code, 'completed')
    assert.equal((await event(state.cid, 'reply-id-1', 'email.received', 'same-received-email', state.token)).code, 'completed')
    const second = await event(state.cid, 'reply-id-2', 'email.received', 'same-received-email', state.token)
    assert.equal((await finishEvent(second, RECIPIENT, 'Please call me.')).message_id, done.message_id)
    assert.equal(await inboundCount(), 1)
    assert.equal(await count("select count(*) as value from public.notifications where type='new_message'"), 1)
    assert.equal(await count('select unread as value from public.conversations where user_id=$1::uuid and customer_id=$2::uuid', [A, CA]), 1)
    assert.equal(await count('select count(*) as value from public.pilot_email_webhook_events where duplicate_of is not null'), 1)
    assert.equal((await event(state.cid, 'reply-id-1', 'email.received', 'changed-id', state.token)).code, 'event_conflict')
  })
  await test('extra: one received email cannot be attributed to two quote routes', async () => {
    const a = await setup(), wid2 = await workflow(a.cid, CA, QA2), token2 = await tokenFor(wid2)
    const first = await event(a.cid, 'route-one', 'email.received', 'same-provider-email', a.token)
    assert.equal((await finishEvent(first, RECIPIENT, 'Question.')).code, 'completed')
    const other = await event(a.cid, 'route-two', 'email.received', 'same-provider-email', token2)
    assert.equal((await finishEvent(other, RECIPIENT, 'Question.')).code, 'needs_review')
    assert.equal(await inboundCount(), 1)
    assert.equal(await scalar("select meta->>'quote_id' as value from public.messages where direction='inbound'"), QA)
  })
  await test('extra: delivery before confirmation and native finalization remains pending then reconciles', async () => {
    const state = await setup()
    let delivered = await event(state.cid, 'early-delivered', 'email.delivered', 'early-provider-id')
    assert.equal(delivered.code, 'awaiting_send')
    assert.equal(await count("select count(*) as value from public.pilot_email_webhook_events where state='completed'"), 0)
    await confirm(state.attempt, 'early-provider-id')
    delivered = await event(state.cid, 'early-delivered', 'email.delivered', 'early-provider-id')
    assert.equal(delivered.code, 'claimed')
    assert.equal((await finishEvent(delivered)).code, 'awaiting_send')
    assert.equal(await count('select count(*) as value from public.messages'), 0)
    assert.equal((await finalize(state.attempt)).code, 'finalized')
    delivered = await event(state.cid, 'early-delivered', 'email.delivered', 'early-provider-id')
    assert.equal((await finishEvent(delivered)).code, 'completed')
    assert.equal(await scalar('select status as value from public.messages'), 'delivered')
    assert.equal(await scalar('select status as value from public.notification_log'), 'delivered')
  })
  await test('extra: delivery events advance both native records monotonically', async () => {
    const state = await sent()
    for (const [index, type, expected] of [
      [1, 'email.opened', 'opened'], [2, 'email.delivered', 'opened'], [3, 'email.sent', 'opened'],
      [4, 'email.bounced', 'bounced'], [5, 'email.clicked', 'bounced'], [6, 'email.complained', 'spam'],
    ] as const) {
      const evt = await event(state.cid, `delivery-${index}`, type, 'fictional-outbound-1')
      assert.equal((await finishEvent(evt)).code, 'completed')
      assert.equal(await scalar('select status as value from public.messages'), expected)
      assert.equal(await scalar('select status as value from public.notification_log'), expected)
    }
    assert.equal(await count('select count(*) as value from public.messages'), 1)
    assert.equal(await count('select count(*) as value from public.notification_log'), 1)
  })
  await test('extra: exact matching unsubscribe changes only own consent once with native audit', async () => {
    const state = await setup(), reply = await event(state.cid, 'unsubscribe-1', 'email.received', 'unsubscribe-email', state.token)
    assert.equal((await finishEvent(reply, RECIPIENT.toUpperCase(), '  UNSUBSCRIBE  ')).code, 'completed')
    assert.equal(await optIn(), false)
    assert.equal(await optIn(CB), true)
    assert.equal(await count("select count(*) as value from public.consent_changes where user_id=$1::uuid and customer_id=$2::uuid and channel='email' and old_value=true and new_value=false and source='email'", [A, CA]), 1)
    const duplicate = await event(state.cid, 'unsubscribe-2', 'email.received', 'unsubscribe-email', state.token)
    assert.equal((await finishEvent(duplicate, RECIPIENT, 'unsubscribe')).code, 'completed')
    assert.equal(await count('select count(*) as value from public.consent_changes'), 1)
    assert.equal(await inboundCount(), 1)
  })
  await test('extra: mismatched sender cannot change consent or create a native reply', async () => {
    const state = await setup(), reply = await event(state.cid, 'mismatched-sender', 'email.received', 'untrusted-inbound', state.token)
    assert.equal((await finishEvent(reply, 'someone-else@customer.example.invalid', 'unsubscribe')).code, 'needs_review')
    assert.equal(await optIn(), true)
    assert.equal(await optIn(CB), true)
    assert.equal(await count('select count(*) as value from public.consent_changes'), 0)
    assert.equal(await inboundCount(), 0)
    assert.equal(await scalar('select hold_reason as value from public.pilot_quote_followup_workflows where id=$1::uuid', [state.wid]), 'reply_review')
  })
  await test('extra: arbitrary reply prose only holds and never infers consent or quote acceptance', async () => {
    const state = await setup(), reply = await event(state.cid, 'prose-reply', 'email.received', 'prose-email', state.token)
    assert.equal((await finishEvent(reply, RECIPIENT, 'Accepted, but please unsubscribe me from other offers.')).code, 'completed')
    assert.equal(await optIn(), true)
    assert.equal(await count('select count(*) as value from public.consent_changes'), 0)
    assert.equal(await count('select count(*) as value from public.quote_acceptances'), 0)
    assert.equal(await scalar('select status as value from public.quotes where id=$1::uuid', [QA]), 'sent')
    assert.equal(await scalar('select state as value from public.pilot_quote_followup_workflows where id=$1::uuid', [state.wid]), 'held')
  })
  await test('extra: failed native reply insertion rolls back unsubscribe and consent audit together', async () => {
    const state = await setup(), reply = await event(state.cid, 'reply-write-failure', 'email.received', 'reply-write-email', state.token)
    await db.exec(`create function public.pilot_test_extra_refuse_reply() returns trigger language plpgsql as $$
      begin if new.direction='inbound' then raise exception 'synthetic_reply_write_failure'; end if; return new; end $$;
      create trigger pilot_test_extra_refuse_reply before insert on public.messages for each row execute function public.pilot_test_extra_refuse_reply()`)
    await mustRejectSql('select public.pilot_email_finalize_event($1::uuid,$2::bigint,$3,$4) as value',
      [reply.event_id, reply.fence, RECIPIENT, 'unsubscribe'], ['P0001'])
    assert.equal(await optIn(), true)
    assert.equal(await count('select count(*) as value from public.consent_changes'), 0)
    assert.equal(await inboundCount(), 0)
    assert.equal(await scalar('select state as value from public.pilot_email_webhook_events where id=$1::uuid', [reply.event_id]), 'processing')
    assert.equal(await scalar('select state as value from public.pilot_quote_followup_workflows where id=$1::uuid', [state.wid]), 'held')
    await db.exec('drop trigger pilot_test_extra_refuse_reply on public.messages; drop function public.pilot_test_extra_refuse_reply()')
    assert.equal((await finishEvent(reply, RECIPIENT, 'unsubscribe')).code, 'completed')
    assert.equal(await optIn(), false)
    assert.equal(await count('select count(*) as value from public.consent_changes'), 1)
  })
  await test('extra: failed delivery log update cannot partially advance a native message', async () => {
    const state = await sent(), delivered = await event(state.cid, 'delivery-write-failure', 'email.delivered', 'fictional-outbound-1')
    await db.exec(`create function public.pilot_test_extra_refuse_delivery() returns trigger language plpgsql as $$
      begin raise exception 'synthetic_delivery_write_failure'; end $$;
      create trigger pilot_test_extra_refuse_delivery before update on public.notification_log for each row execute function public.pilot_test_extra_refuse_delivery()`)
    await mustRejectSql('select public.pilot_email_finalize_event($1::uuid,$2::bigint) as value', [delivered.event_id, delivered.fence], ['P0001'])
    assert.equal(await scalar('select status as value from public.messages'), 'sent')
    assert.equal(await scalar('select status as value from public.notification_log'), 'sent')
    assert.equal(await scalar('select state as value from public.pilot_email_webhook_events where id=$1::uuid', [delivered.event_id]), 'processing')
    await db.exec('drop trigger pilot_test_extra_refuse_delivery on public.notification_log; drop function public.pilot_test_extra_refuse_delivery()')
    assert.equal((await finishEvent(delivered)).code, 'completed')
    assert.equal(await scalar('select status as value from public.messages'), 'delivered')
    assert.equal(await scalar('select status as value from public.notification_log'), 'delivered')
  })
  await test('extra: pending old-version reply blocks revised approval without a native body', async () => {
    const state = await setup(), reply = await event(state.cid, 'pending-old-reply', 'email.received', 'pending-body', state.token)
    assert.equal((await rpc('select public.pilot_email_fail_event($1::uuid,$2::bigint,$3) as value', [reply.event_id, reply.fence, 'content_unavailable'])).code, 'released')
    await db.query('update public.quotes set notes=$2 where id=$1::uuid', [QA, 'An explicitly revised scope.'])
    assert.equal((await approve(state.cid, CA, QA, await copy())).code, 'reply_received')
    assert.equal(await inboundCount(), 0)
    assert.equal(await count('select count(*) as value from public.pilot_quote_followup_workflows'), 1)
    // The pending event is tied to this quote, not every quote sharing an email.
    assert.equal((await approve(state.cid, CA, QA2, await copy())).code, 'approved')
  })
  await test('extra: real owner-on-behalf acceptance blocks a claimed provider start', async () => {
    const cid = await connection(), wid = await workflow(cid), attempt = await claim(wid)
    await db.exec('set local role authenticated')
    await db.query("select set_config('request.jwt.claim.sub',$1,true),set_config('request.jwt.claims',$2,true)", [A, JSON.stringify({ role: 'authenticated', sub: A })])
    const accepted = await scalar('select public.owner_record_customer_acceptance($1::uuid,$2,null,null,$3) as value',
      [QA, 'text_message', 'Synthetic owner confirms the customer accepted this exact quote.'])
    await db.exec('reset role')
    assert.equal(typeof accepted, 'string')
    assert.equal((await start(attempt)).code, 'quote_decided')
    assert.equal(await scalar('select public.quote_acceptance_is_current($1::uuid) as value', [QA]), true)
    assert.equal(await count('select count(*) as value from public.messages'), 0)
  })
  await test('extra: new material quote service invalidates a previously claimed version', async () => {
    const cid = await connection(), wid = await workflow(cid), attempt = await claim(wid)
    await db.query(`insert into public.quote_services(user_id,quote_id,service_type,quantity,unit,unit_price)
      values($1::uuid,$2::uuid,'Additional fictional service',2,'visit',25)`, [A, QA])
    assert.equal((await start(attempt)).code, 'quote_changed')
  })
  await test('extra: current business terms changes invalidate a claimed version', async () => {
    const cid = await connection(), wid = await workflow(cid), attempt = await claim(wid)
    await db.query('update public.business_settings set terms_text=$2 where user_id=$1::uuid', [A, 'Scheduling changes require notice.'])
    assert.equal((await start(attempt)).code, 'quote_changed')
  })
  await test('extra: a real native invoice stops a claimed quote follow-up', async () => {
    const cid = await connection(), wid = await workflow(cid), attempt = await claim(wid)
    await db.query(`insert into public.invoices(user_id,customer_id,quote_id,invoice_number,customer_name,amount,status)
      values($1::uuid,$2::uuid,$3::uuid,'FIXTURE-INVOICE-A','Fictional Customer A',100,'unpaid')`, [A, CA, QA])
    assert.equal((await start(attempt)).code, 'invoiced')
  })
  await test('extra: retained pilot history explicitly restricts existing native deletion paths', async () => {
    const state = await sent()
    const conversation = await scalar('select conversation_id as value from public.messages where id=$1::uuid', [state.receipt.message_id])
    for (const [sql, id] of [
      ['delete from public.quotes where id=$1::uuid', QA],
      ['delete from public.customers where id=$1::uuid', CA],
      ['delete from public.messages where id=$1::uuid', state.receipt.message_id],
      ['delete from public.notification_log where id=$1::uuid', state.receipt.notification_log_id],
      ['delete from public.conversations where id=$1::uuid', conversation],
      ['delete from public.business_settings where user_id=$1::uuid', A],
      ['delete from public.pilot_email_send_attempts where id=$1::uuid', state.attempt.attempt_id],
    ]) await mustRejectSql(String(sql), [id])
    assert.equal((await finalize(state.attempt)).message_id, state.receipt.message_id)
    assert.equal(await count('select count(*) as value from public.messages'), 1)
    assert.equal(await count('select count(*) as value from public.notification_log'), 1)
  })
  await test('extra: historical unknown outcome past 23 hours is held without a fresh key', async () => {
    const old = await historical(23.1, false)
    const result = await rpc('select public.pilot_email_claim($1::uuid,1) as value', [old.wid])
    assert.equal(result.code, 'needs_review')
    assert.equal(await scalar('select idempotency_key as value from public.pilot_email_send_attempts where id=$1::uuid', [old.aid]), old.before.key)
    assert.equal(await scalar('select first_started_at::text as value from public.pilot_email_send_attempts where id=$1::uuid', [old.aid]), old.before.first)
    assert.notEqual((await start({ attempt_id: old.aid, fence: 1 })).code, 'started')
    assert.equal(await count('select count(*) as value from public.messages'), 0)
  })
  await test('extra: historical unknown retry inside window preserves exact payload key and first start', async () => {
    const old = await historical(22.9, false), retry = await claim(old.wid), result = await start(retry)
    assert.equal(result.code, 'started')
    assert.equal(result.idempotency_key, old.before.key)
    assert.equal(result.payload_json, old.before.payload)
    assert.equal(await scalar('select first_started_at::text as value from public.pilot_email_send_attempts where id=$1::uuid', [old.aid]), old.before.first)
    assert.equal(Number(retry.fence), 2)
  })
  await test('extra: historical confirmed receipt reconciles after cutoff hold disconnect and opt-out', async () => {
    const old = await historical(25, true)
    await rpc('select public.pilot_email_hold_workflow($1::uuid,$2) as value', [old.wid, 'owner_paused'])
    await rpc('select public.pilot_email_set_connection_state($1::uuid,$2) as value', [old.cid, 'disconnected'])
    await db.query('update public.customers set email_opt_in=false where id=$1::uuid', [CA])
    const claimed = await rpc('select public.pilot_email_claim($1::uuid,1) as value', [old.wid])
    assert.equal(claimed.code, 'reconcile')
    const attempt = { attempt_id: old.aid, fence: claimed.fence }
    assert.notEqual((await start(attempt)).code, 'started')
    const receipt = await finalize(attempt)
    assert.equal(receipt.code, 'finalized')
    assert.equal((await finalize(attempt)).message_id, receipt.message_id)
    assert.equal(await count('select count(*) as value from public.messages'), 1)
    assert.equal(await scalar('select provider_message_id as value from public.messages'), 'fictional-historical-receipt')
    assert.equal(await scalar('select idempotency_key as value from public.pilot_email_send_attempts where id=$1::uuid', [old.aid]), old.before.key)
  })
  await test('extra: null fence never starts or confirms an otherwise valid lease', async () => {
    const cid = await connection(), wid = await workflow(cid), attempt = await claim(wid)
    assert.equal((await start({ ...attempt, fence: null })).code, 'stale_lease')
    assert.equal((await rpc('select public.pilot_email_confirm($1::uuid,null,$2) as value', [attempt.attempt_id, 'fake-receipt'])).code, 'stale_lease')
    assert.equal((await start(attempt)).code, 'started')
  })
  return results
}
