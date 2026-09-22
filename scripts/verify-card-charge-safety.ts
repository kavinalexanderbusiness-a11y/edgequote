import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { PGlite } from '@electric-sql/pglite'

const migrationPath = 'supabase/migrations/20260921235900_card_charge_safety.sql'
const migration = readFileSync(migrationPath, 'utf8')
const baseline = readFileSync('supabase/migrations/20260830150001_baseline.sql', 'utf8')
let passed = 0

function check(name: string, condition: unknown): void {
  assert.ok(condition, name)
  passed += 1
  console.log(`  PASS ${name}`)
}

async function schemaDb(): Promise<PGlite> {
  const db = new PGlite()
  await db.exec(`
    create role anon;
    create role authenticated;
    create role service_role;

    create table customers (
      id uuid primary key,
      user_id uuid not null,
      autopay_enabled boolean not null default false,
      stripe_customer_id text,
      unique (user_id, id)
    );
    create table customer_portal_tokens (
      token text primary key,
      customer_id uuid not null,
      user_id uuid not null,
      revoked boolean not null default false
    );
    create table payment_methods (
      id uuid primary key default gen_random_uuid(),
      customer_id uuid not null,
      user_id uuid not null,
      stripe_payment_method_id text not null unique,
      stripe_customer_id text,
      is_default boolean not null default true,
      created_at timestamptz not null default now()
    );
    create table jobs (
      id uuid primary key,
      user_id uuid not null,
      customer_id uuid not null,
      recurrence_id uuid,
      status text not null
    );
    create table invoices (
      id uuid primary key,
      user_id uuid not null,
      customer_id uuid,
      status text not null check (status in ('draft','unpaid','sent','partial','paid','overpaid','cancelled')),
      job_id uuid,
      amount numeric(10,2) not null,
      amount_paid numeric(10,2) not null default 0,
      unique (user_id, id)
    );
    create table business_settings (
      user_id uuid primary key,
      gst_percent numeric
    );
    create table payments (
      id uuid primary key default gen_random_uuid(),
      invoice_id uuid,
      user_id uuid,
      amount numeric not null default 0,
      stripe_payment_intent text,
      stripe_session_id text unique,
      kind text not null default 'payment',
      provider text not null default 'stripe'
    );

    create function portal_set_autopay(p_token text, p_enabled boolean)
    returns boolean language sql security definer as $$ select true $$;
    grant execute on function portal_set_autopay(text, boolean) to public, anon, authenticated, service_role;
  `)
  return db
}

async function expectPreflightRollback(
  name: string,
  seed: (db: PGlite) => Promise<void>,
  message: RegExp,
): Promise<void> {
  const db = await schemaDb()
  await seed(db)
  let error = ''
  try {
    await db.exec(migration)
  } catch (cause) {
    error = cause instanceof Error ? cause.message : String(cause)
    await db.exec('rollback').catch(() => undefined)
  }
  check(`${name}: migration aborts with an actionable preflight error`, message.test(error))
  const target = await db.query<{ name: string | null }>("select to_regclass('public.card_charge_consents')::text as name")
  check(`${name}: failed preflight creates no consent table`, target.rows[0].name === null)
  await db.close()
}

async function main(): Promise<void> {
  console.log('\nSchema compatibility')
  check('migration is ordered after every current migration', migrationPath.split('/').pop()! > '20260921235500_portal_request_mute_exception.sql')
  check('baseline has tenant-composite customer identity', baseline.includes('"customers_user_id_id_key" UNIQUE (user_id, id)'))
  check('baseline has tenant-composite invoice identity', baseline.includes('"invoices_user_id_id_key" UNIQUE (user_id, id)'))
  check('baseline recognizes unpaid as a stored invoice status', baseline.includes("'unpaid'::text"))
  check('migration claims only real payable stored statuses', migration.includes("i.status not in ('draft', 'unpaid', 'sent', 'partial')") && !migration.includes("'overdue'"))

  console.log('\nFail-closed legacy preflight')
  await expectPreflightRollback('duplicate PaymentIntent', async db => {
    await db.exec(`
      insert into payments(amount,stripe_payment_intent,stripe_session_id)
      values (10,'pi_duplicate','checkout:a'),(10,'pi_duplicate','checkout:b')
    `)
  }, /duplicated positive Stripe PaymentIntent/i)
  await expectPreflightRollback('normalized session collision', async db => {
    await db.exec(`
      insert into payments(amount,stripe_payment_intent,stripe_session_id)
      values (10,'pi_legacy','autopay:invoice'),(10,'pi_other','autopay-pi:pi_legacy')
    `)
  }, /would collide with an existing normalized session key/i)
  await expectPreflightRollback('invalid PaymentIntent', async db => {
    await db.exec(`
      insert into payments(amount,stripe_payment_intent,stripe_session_id)
      values (10,'  ','checkout:blank')
    `)
  }, /missing, blank or untrimmed Stripe PaymentIntent/i)
  await expectPreflightRollback('legacy AutoPay without PaymentIntent', async db => {
    await db.exec(`
      insert into payments(amount,stripe_payment_intent,stripe_session_id)
      values (10,null,'autopay:missing-intent')
    `)
  }, /missing, blank or untrimmed Stripe PaymentIntent/i)

  console.log('\nClean migration and authorization contract')
  const db = await schemaDb()
  const owner = '00000000-0000-0000-0000-000000000001'
  const customer = '00000000-0000-0000-0000-000000000002'
  const invoice = '00000000-0000-0000-0000-000000000003'
  const job = '00000000-0000-0000-0000-000000000004'
  const otherOwner = '00000000-0000-0000-0000-000000000005'
  const otherCustomer = '00000000-0000-0000-0000-000000000006'
  await db.exec(`
    insert into customers values
      ('${customer}','${owner}',true,'cus_one'),
      ('${otherCustomer}','${otherOwner}',false,'cus_other');
    insert into customer_portal_tokens values ('token','${customer}','${owner}',false);
    insert into payment_methods(customer_id,user_id,stripe_payment_method_id,stripe_customer_id)
      values ('${customer}','${owner}','pm_one','cus_one');
    insert into jobs values ('${job}','${owner}','${customer}','${job}','completed');
    insert into invoices values ('${invoice}','${owner}','${customer}','unpaid','${job}',90,20);
    insert into business_settings values ('${owner}',null);
    insert into payments(amount,stripe_payment_intent,stripe_session_id)
      values (10,'pi_legacy','autopay:legacy');
  `)
  await db.exec(migration)
  check('migration applies cleanly to the current schema contract', true)

  const normalized = await db.query<{ stripe_session_id: string }>("select stripe_session_id from payments where stripe_payment_intent='pi_legacy'")
  check('legacy AutoPay evidence is normalized to the webhook key', normalized.rows[0].stripe_session_id === 'autopay-pi:pi_legacy')
  const legacyFlag = await db.query<{ autopay_enabled: boolean }>('select autopay_enabled from customers where id=$1', [customer])
  check('legacy boolean authorization is reset', legacyFlag.rows[0].autopay_enabled === false)

  await assert.rejects(() => db.exec(`update customers set autopay_enabled=true where id='${customer}'`))
  check('direct writes cannot revive AutoPay without active consent', true)

  const claim = async (opts: { user?: string; method?: string; cents?: number } = {}) =>
    (await db.query<{ id: string | null }>(
      'select claim_card_charge($1,$2,$3,$4,$5,$6) as id',
      [invoice, opts.user ?? owner, customer, opts.method ?? 'pm_one', 'cus_one', opts.cents ?? 7000],
    )).rows[0].id
  const consent = async (enabled: boolean, terms = 'recurring-balance-v1') =>
    (await db.query<{ ok: boolean }>(
      'select record_card_charge_consent($1,$2,$3) as ok',
      ['token', enabled, terms],
    )).rows[0].ok

  check('legacy boolean state alone cannot claim a charge', await claim() === null)
  check('unreviewed terms cannot create consent', await consent(true, 'unreviewed') === false)
  await db.exec(`update customers set stripe_customer_id=null where id='${customer}'`)
  check('missing Stripe customer identity cannot create consent', await consent(true) === false)
  await db.exec(`update customers set stripe_customer_id='cus_one' where id='${customer}'`)

  await db.exec('set role authenticated')
  const legacyEnable = await db.query<{ ok: boolean }>("select portal_set_autopay('token',true) as ok")
  check('legacy portal RPC cannot enable AutoPay', legacyEnable.rows[0].ok === false)
  const legacyDisable = await db.query<{ ok: boolean }>("select portal_set_autopay('token',false) as ok")
  check('legacy portal RPC may still revoke AutoPay', legacyDisable.rows[0].ok === true)
  await assert.rejects(() => db.query("select record_card_charge_consent('token',true,'recurring-balance-v1')"))
  check('authenticated callers cannot invoke the privileged consent writer', true)
  await assert.rejects(() => db.query('select * from card_charge_consents'))
  check('authenticated callers cannot read consent evidence', true)
  await db.exec('reset role')

  check('reviewed portal terms create consent', await consent(true) === true)
  await assert.rejects(() => db.exec(`
    insert into card_charge_consents(
      user_id,customer_id,payment_method_id,terms_version,scope,terms_text,amount_rule,evidence_source
    ) values (
      '${owner}','${otherCustomer}','pm_one','recurring-balance-v1','recurring_invoice_balance','terms','rule','customer_portal'
    )
  `))
  check('tenant-composite consent foreign key rejects owner/customer mismatch', true)

  check('foreign owner cannot claim', await claim({ user: otherOwner }) === null)
  check('different card cannot claim', await claim({ method: 'pm_other' }) === null)
  check('stale or altered amount cannot claim', await claim({ cents: 9000 }) === null)
  await db.exec(`update jobs set status='scheduled' where id='${job}'`)
  check('unfinished recurring job cannot claim', await claim() === null)
  await db.exec(`update jobs set status='completed' where id='${job}'; update invoices set status='cancelled' where id='${invoice}'`)
  check('cancelled invoice cannot claim', await claim() === null)
  await db.exec(`update invoices set status='unpaid' where id='${invoice}'`)

  // PGlite serializes execution; this verifies the unique durable-claim contract,
  // while the invoice/customer locks are what serialize separate PostgreSQL sessions.
  const attempts = await Promise.all(Array.from({ length: 20 }, () => claim()))
  check('exactly one durable claim wins for a real unpaid invoice', attempts.filter(Boolean).length === 1)
  await db.exec("update card_charge_attempts set created_at=now()-interval '3 days'")
  check('a charge claim never expires automatically', await claim() === null)

  check('portal revocation succeeds', await consent(false) === true)
  await db.exec(`update customers set autopay_enabled=true where id='${customer}'`).then(
    () => assert.fail('revoked consent unexpectedly enabled AutoPay'),
    () => undefined,
  )
  check('revoked consent cannot be revived by a direct boolean write', true)
  check('fresh reviewed consent can be granted after revocation', await consent(true) === true)
  const history = await db.query<{ n: number }>('select count(*)::int as n from card_charge_consents')
  check('consent history remains append-only across revocation and re-grant', history.rows[0].n === 2)

  await db.exec(`delete from payments`)
  await db.exec(`
    insert into payments(invoice_id,user_id,amount,stripe_payment_intent,stripe_session_id)
    values ('${invoice}','${owner}',70,'pi_one','autopay-pi:pi_one')
  `)
  await assert.rejects(() => db.exec(`
    insert into payments(amount,stripe_payment_intent,stripe_session_id)
    values (70,'pi_one','other-session')
  `))
  check('positive Stripe PaymentIntent evidence is globally unique', true)
  await db.exec(`
    insert into payments(amount,stripe_payment_intent,stripe_session_id,kind,provider)
    values
      (70,'pi_one','credit:one','credit','credit'),
      (-70,'pi_one','refund:one','payment','stripe'),
      (70,'pi_two','autopay-pi:pi_two','payment','stripe')
  `)
  const mirrors = await db.query<{ n: number }>('select count(*)::int as n from payments')
  check('credit/refund mirrors and distinct charges remain representable', mirrors.rows[0].n === 4)

  await db.close()
  console.log(`\nverify:card-charge-safety — ${passed} passed, 0 failed`)
}

main().catch(error => {
  console.error(error)
  process.exitCode = 1
})
