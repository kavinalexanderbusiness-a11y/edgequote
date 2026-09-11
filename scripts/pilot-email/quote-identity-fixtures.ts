import assert from 'node:assert/strict'
import type { SupabaseClient } from '@supabase/supabase-js'
import type { Database } from './database'

export type IdentityVerdict = { code: string; [key: string]: unknown }
export const identityValue = async (db: Database, sql: string, params: unknown[] = []) =>
  (await db.query<{ value: unknown }>(sql, params)).rows[0]?.value

// Existing disposable Database only. One RPC/savepoint, actual service grants
// and native verdict; a failed RPC rolls back all of its SQL, not its caller's
// already-committed baseline REST requests. No HTTP or credential fallback.
export function identitySupabase(db: Database): SupabaseClient {
  return { rpc: async (name: string, args: Record<string, unknown>) => {
    assert.match(name, /^(pilot_quote_identity_(snapshot|save)|pilot_email_(create_connection|set_connection_state|approve_workflow|hold_workflow|claim|start|confirm|finalize))$/)
    const keys = Object.keys(args)
    keys.forEach(key => assert.match(key, /^p_[a-z_]+$/))
    const parameters = keys.map(key => args[key] !== null && typeof args[key] === 'object' ? JSON.stringify(args[key]) : args[key])
    const sql = `select public.${name}(${keys.map((key, i) => `"${key}" => $${i + 1}${['p_plan', 'p_steps'].includes(key) ? '::jsonb' : ''}`).join(',')}) as value`
    await db.exec('savepoint identity_transport; set local role service_role')
    try {
      const data = await identityValue(db, sql, parameters)
      await db.exec('reset role; release savepoint identity_transport')
      return { data, error: null }
    } catch (error) {
      await db.exec('rollback to savepoint identity_transport; reset role; release savepoint identity_transport')
      return { data: null, error }
    }
  } } as unknown as SupabaseClient
}

export async function identityRpc(db: Database, name: string, args: Record<string, unknown>): Promise<IdentityVerdict> {
  const result = await identitySupabase(db).rpc(name, args)
  if (result.error) throw result.error
  assert.ok(result.data && typeof result.data === 'object' && typeof result.data.code === 'string')
  return result.data as IdentityVerdict
}

export async function seedQuoteIdentity(db: Database, tag: number, retained = false, child?: 'services' | 'options') {
  const id = (n: number) => `22222222-2222-4222-8222-${String(tag * 100 + n).padStart(12, '0')}`
  const owner = id(1), customer = id(2), target = id(3), quote = id(4), property = id(5), targetProperty = id(6)
  await db.query('insert into auth.users(id,email,email_confirmed_at) values($1::uuid,$2,clock_timestamp())', [owner, `identity-owner-${tag}@fixture.example.invalid`])
  await db.query(`insert into public.business_settings(user_id,company_name,owner_name,email_primary,business_type,timezone)
    values($1::uuid,'Fictional identity business','Fixture owner',$2,'general',case
      when extract(hour from clock_timestamp() at time zone 'UTC')::int=12 then 'Etc/UTC'
      when extract(hour from clock_timestamp() at time zone 'UTC')::int>12 then 'Etc/GMT+'||(extract(hour from clock_timestamp() at time zone 'UTC')::int-12)::text
      else 'Etc/GMT'||(extract(hour from clock_timestamp() at time zone 'UTC')::int-12)::text end)`, [owner, `identity-owner-${tag}@fixture.example.invalid`])
  for (const [cid, name, address] of [[customer, 'Original Customer', '100 Original Road'], [target, 'Target Customer', '200 Existing Road']]) {
    await db.query(`insert into public.customers(id,user_id,name,email,email_opt_in,message_prefs,address)
      values($1::uuid,$2::uuid,$3,$4,true,'{"estimates":true}',$5)`, [cid, owner, name, `${cid}@fixture.example.invalid`, address])
  }
  for (const [pid, cid, address] of [[property, customer, '100 Original Road'], [targetProperty, target, '200 Existing Road']]) {
    await db.query(`insert into public.properties(id,user_id,customer_id,address,is_primary) values($1::uuid,$2::uuid,$3::uuid,$4,true)`, [pid, owner, cid, address])
  }
  await db.query(`insert into public.quotes(id,user_id,customer_id,property_id,quote_number,customer_name,address,service_type,
    initial_price,travel_fee,status,sent_at,issued_date,valid_until,notes,internal_notes)
    values($1::uuid,$2::uuid,$3::uuid,$4::uuid,$5,'Original Customer','100 Original Road','General visit',100,5,
      'sent',clock_timestamp()-interval '7 days',current_date-7,current_date+30,'Public fixture note','Private fixture note')`,
  [quote, owner, customer, property, `IDENTITY-${tag}`])
  // Alternatives and additive lines are mutually exclusive in the real schema.
  // Two preserve variants cover both without disabling that native constraint.
  if (child === 'services') await db.query(`insert into public.quote_services(user_id,quote_id,service_type,quantity,unit,unit_price,kind)
    values($1::uuid,$2::uuid,'Protected fixture service',1,'each',100,'service')`, [owner, quote])
  if (child === 'options') await db.query(`insert into public.quote_options(user_id,quote_id,name,price,is_recommended)
    values($1::uuid,$2::uuid,'Protected fixture option',100,true)`, [owner, quote])
  if (child) await db.query(`insert into public.quote_addons(user_id,quote_id,name,price,is_selected)
    values($1::uuid,$2::uuid,'Protected optional fixture',15,false)`, [owner, quote])
  const connection = await identityRpc(db, 'pilot_email_create_connection', { p_owner: owner, p_account_scope: `identity-${tag}`,
    p_from_address: `sender-${tag}@fixture.example.invalid`, p_receiving_domain: `identity-${tag}.example.invalid`,
    p_secret_ref: `PILOT_IDENTITY_${tag}`, p_credential_version: 'v1' })
  assert.equal(connection.code, 'created')
  const cid = String(connection.connection_id)
  for (const state of ['verified', 'active']) assert.equal((await identityRpc(db, 'pilot_email_set_connection_state', { p_connection: cid, p_state: state })).code, 'updated')
  const due = String(await identityValue(db, "select (clock_timestamp()-interval '2 days')::text as value"))
  const steps = [{ subject: 'Approved identity fixture', text: 'Approved fixture follow-up', due_at: due }]
  const fixture = { owner, customer, target, quote, property, targetProperty, cid, steps }
  if (retained) assert.equal((await approveIdentityFixture(db, fixture)).code, 'approved')
  return fixture
}
export type IdentityFixture = Awaited<ReturnType<typeof seedQuoteIdentity>>
export const approveIdentityFixture = (db: Database, f: { owner: string; customer: string; quote: string; cid: string; steps: unknown }) =>
  identityRpc(db, 'pilot_email_approve_workflow', { p_connection: f.cid, p_customer: f.customer, p_quote: f.quote, p_steps: f.steps, p_approved_by: f.owner })

export async function identityRows(db: Database, owner: string) {
  // Full row snapshots, including transaction-created native audit/integration
  // side effects. These fictional owners have no webhook destinations.
  const tables = ['customers', 'properties', 'quotes', 'quote_services', 'quote_options', 'quote_addons',
    'pilot_quote_followup_workflows', 'pilot_email_send_attempts', 'messages', 'notification_log', 'audit_events', 'integration_events', 'webhook_deliveries']
  const fields = tables.map(table => `'${table}',(select coalesce(jsonb_agg(to_jsonb(t) order by id),'[]'::jsonb) from public.${table} t where user_id=$1::uuid)`)
  return await identityValue(db, `select jsonb_build_object(${fields.join(',')}) as value`, [owner]) as Record<string, Record<string, unknown>[]>
}
