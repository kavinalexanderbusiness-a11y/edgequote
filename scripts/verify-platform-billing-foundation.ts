// B1 applies only to disposable PostgreSQL. Never imports a Supabase/provider client.
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { loadPGlite, splitStatements, substitutePlatformStatements } from './lib/pg-sql'

const ROOT = join(__dirname, '..')
const read = (path: string) => readFileSync(join(ROOT, path), 'utf8')
const TABLES = ['platform_billing_accounts', 'platform_subscriptions', 'platform_billing_events']
const DRAFT = 'supabase/drafts/platform-billing-b1.sql'
let passed = 0
async function check(name: string, fn: () => unknown | Promise<unknown>) {
  await fn(); passed++; console.log(`PASS ${name}`)
}
function files(path: string): string[] {
  return readdirSync(join(ROOT, path), { withFileTypes: true }).flatMap(entry =>
    entry.isDirectory() ? files(`${path}/${entry.name}`) : [`${path}/${entry.name}`])
}

async function main() {
  await check('draft is outside migrations; existing application paths consult no billing state', () => {
    for (const file of files('supabase/migrations')) assert.doesNotMatch(read(file), /platform_billing_accounts|platform_subscriptions|platform_billing_events/)
    for (const file of files('src').filter(f => /\.(ts|tsx)$/.test(f) && !f.startsWith('src/lib/billing/'))) {
      assert.doesNotMatch(read(file), /platform_billing_accounts|platform_subscriptions|platform_billing_events|from\s*['"][^'"]*\/billing\//, file)
    }
    assert.deepEqual(files('src/lib/billing'), ['src/lib/billing/types.ts'])
    assert.doesNotMatch(read('src/lib/billing/types.ts'), /\b(import|function|const|class|process|fetch)\b/)
  })
  const pg = await loadPGlite()
  if (!pg) { console.log('SKIP PostgreSQL behavioral proof: optional PGlite is absent. B1 requires that proof before approval.'); return }
  const db = await pg.PGlite.create({ extensions: pg.contribs })
  const rows = async (sql: string, args: unknown[] = []): Promise<any[]> => (await db.query(sql, args)).rows
  const one = async (sql: string, args: unknown[] = []) => (await rows(sql, args))[0]
  async function apply(file: string) {
    const transformed = substitutePlatformStatements(read(file))
    for (const hit of transformed.hits) console.log(`Fixture substitution: ${hit}`)
    for (const statement of splitStatements(transformed.sql)) await db.exec(statement + ';')
  }
  async function refused(sql: string, args: unknown[], code: string) {
    await assert.rejects(() => db.query(sql, args), (error: any) => error.code === code, `Expected SQLSTATE ${code}`)
  }
  async function asRole<T>(role: 'authenticated' | 'anon' | 'service_role', uid: string | null, fn: () => Promise<T>): Promise<T> {
    await db.exec('begin')
    try {
      await db.query("select set_config('request.jwt.claim.sub', $1, true)", [uid ?? ''])
      await db.query("select set_config('request.jwt.claims', $1, true)", [JSON.stringify({ role, ...(uid ? { sub: uid } : {}) })])
      await db.exec(`set local role ${role}`)
      assert.equal((await one('select current_user as role')).role, role)
      return await fn()
    } finally { await db.exec('rollback') }
  }
  // Only columns/constraints/indexes/policies/triggers/ACL of the existing public
  // schema. The draft must add objects, never change any existing definition.
  const catalogue = async () => rows(`
    select c.relname, c.relrowsecurity, c.relacl::text,
      (select jsonb_agg(jsonb_build_array(a.attname, a.atttypid, a.attnotnull, pg_get_expr(d.adbin,d.adrelid)) order by a.attnum)
       from pg_attribute a left join pg_attrdef d on d.adrelid=a.attrelid and d.adnum=a.attnum where a.attrelid=c.oid and a.attnum>0 and not a.attisdropped) as columns,
      (select jsonb_agg(pg_get_constraintdef(co.oid) order by co.conname) from pg_constraint co where co.conrelid=c.oid) as constraints,
      (select jsonb_agg(pg_get_indexdef(i.indexrelid) order by i.indexrelid::regclass::text) from pg_index i where i.indrelid=c.oid) as indexes,
      (select jsonb_agg(jsonb_build_array(p.polname,p.polcmd,p.polroles,pg_get_expr(p.polqual,p.polrelid),pg_get_expr(p.polwithcheck,p.polrelid)) order by p.polname) from pg_policy p where p.polrelid=c.oid) as policies,
      (select jsonb_agg(pg_get_triggerdef(t.oid) order by t.tgname) from pg_trigger t where t.tgrelid=c.oid and not t.tgisinternal) as triggers
    from pg_class c join pg_namespace n on n.oid=c.relnamespace
    where n.nspname='public' and c.relkind='r' and not (c.relname=any($1::text[])) order by c.relname`, [TABLES])
  try {
    await apply('scripts/schema/platform-prelude.sql')
    for (const file of files('supabase/migrations').filter(f => f.endsWith('.sql')).sort()) await apply(file)
    // Reproduce the strongest standing Supabase table defaults; explicit REVOKE
    // must remove them even when the production project's defaults change.
    await db.exec('alter default privileges in schema public grant all on tables to anon, authenticated, service_role')
    const before = await catalogue()
    await apply(DRAFT)
    await check('baseline plus exact B1 draft applies; existing catalogue is unchanged', async () => assert.deepEqual(await catalogue(), before))
    // Make pg_get_expr spell the extension qualification consistently.
    await db.exec('set search_path to public')
    const columns = await rows(`select table_name,column_name,data_type,is_nullable,column_default from information_schema.columns where table_schema='public' and table_name=any($1::text[]) order by table_name,ordinal_position`, [TABLES])
    const expected: Record<string, string[]> = {
      platform_billing_accounts: ['id','user_id','stripe_account_id','livemode','stripe_customer_id','created_at','updated_at'],
      platform_subscriptions: ['id','billing_account_id','user_id','stripe_account_id','livemode','stripe_subscription_id','stripe_price_id','status','trial_start','trial_end','current_period_start','current_period_end','cancel_at_period_end','cancel_at','canceled_at','ended_at','last_synced_at','created_at','updated_at'],
      platform_billing_events: ['stripe_account_id','livemode','event_id','event_type','event_created_at','received_at','state','attempt_count','lease_until','processed_at','last_error_code'],
    }
    await check('exact columns and explicit provider facts: no plan, trial or access defaults', () => {
      for (const table of TABLES) assert.deepEqual(columns.filter(c => c.table_name === table).map(c => c.column_name), expected[table])
      for (const column of columns) {
        const defaults: Record<string, string> = { id: 'extensions.uuid_generate_v4()', created_at: 'now()', updated_at: 'now()', received_at: 'now()', state: "'received'::text", attempt_count: '0' }
        assert.equal(column.column_default, defaults[column.column_name] ?? null, `${column.table_name}.${column.column_name}`)
        const nullable = ['stripe_price_id','trial_start','trial_end','current_period_start','current_period_end','cancel_at','canceled_at','ended_at','last_synced_at','lease_until','processed_at','last_error_code']
        assert.equal(column.is_nullable, nullable.includes(column.column_name) ? 'YES' : 'NO')
        const type = ['id','user_id','billing_account_id'].includes(column.column_name) ? 'uuid'
          : ['livemode','cancel_at_period_end'].includes(column.column_name) ? 'boolean'
          : column.column_name === 'attempt_count' ? 'integer'
          : /_at$|_start$|_end$|^lease_until$/.test(column.column_name) ? 'timestamp with time zone' : 'text'
        assert.equal(column.data_type, type, `${column.table_name}.${column.column_name}`)
      }
    })
    await check('exact composite keys and cascading account relationship match the contract', async () => {
      const keys = await rows(`select c.relname,co.contype,co.conname,pg_get_constraintdef(co.oid) as definition
        from pg_constraint co join pg_class c on c.oid=co.conrelid
        where c.relname=any($1::text[]) and co.contype in ('p','u','f')`, [TABLES])
      assert.equal(keys.length,9)
      const definition = (name: string) => keys.find(k => k.conname === name)?.definition
      assert.equal(definition('platform_billing_accounts_owner_scope_key'),'UNIQUE (user_id, stripe_account_id, livemode)')
      assert.equal(definition('platform_billing_accounts_customer_scope_key'),'UNIQUE (stripe_account_id, livemode, stripe_customer_id)')
      assert.equal(definition('platform_billing_accounts_mapping_key'),'UNIQUE (id, user_id, stripe_account_id, livemode)')
      assert.equal(definition('platform_subscriptions_provider_key'),'UNIQUE (stripe_account_id, livemode, stripe_subscription_id)')
      assert.equal(definition('platform_subscriptions_account_fk'),'FOREIGN KEY (billing_account_id, user_id, stripe_account_id, livemode) REFERENCES platform_billing_accounts(id, user_id, stripe_account_id, livemode) ON DELETE CASCADE')
      assert.equal(definition('platform_billing_accounts_user_id_fkey'),'FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE')
      assert.equal(definition('platform_billing_events_pkey'),'PRIMARY KEY (stripe_account_id, livemode, event_id)')
    })
    await check('three RLS tables, exactly two authenticated SELECT policies, no event policies', async () => {
      assert.equal((await rows(`select relname from pg_class where relname=any($1::text[]) and relrowsecurity`, [TABLES])).length, 3)
      const policies = await rows(`select tablename,cmd,roles,qual,with_check from pg_policies where schemaname='public' and tablename=any($1::text[]) order by tablename`, [TABLES])
      assert.equal(policies.length, 2)
      for (const p of policies) {
        assert.notEqual(p.tablename, 'platform_billing_events'); assert.equal(p.cmd, 'SELECT'); assert.deepEqual(p.roles, ['authenticated']); assert.equal(p.with_check, null)
        assert.match(p.qual, /user_id = \( SELECT auth.uid\(\)/); assert.match(p.qual, /EXISTS[\s\S]*business_settings/)
      }
    })
    await check('exact ACL: anon/public none, authenticated read-only, service CRUD only', async () => {
      for (const table of TABLES) for (const role of ['anon', 'authenticated', 'service_role']) for (const privilege of ['SELECT','INSERT','UPDATE','DELETE','TRUNCATE','REFERENCES','TRIGGER']) {
        const allowed = role === 'service_role' ? ['SELECT','INSERT','UPDATE','DELETE'].includes(privilege) : role === 'authenticated' && table !== 'platform_billing_events' && privilege === 'SELECT'
        assert.equal((await one('select has_table_privilege($1,$2,$3) as allowed', [role, `public.${table}`, privilege])).allowed, allowed, `${role} ${table} ${privilege}`)
      }
      assert.equal((await rows(`select 1 from pg_class c cross join lateral aclexplode(c.relacl) a where c.relname=any($1::text[]) and a.grantee=0`, [TABLES])).length, 0)
    })
    await check('canonical update triggers and recovery/history indexes exist', async () => {
      const triggers = await rows(`select c.relname,p.proname from pg_trigger t join pg_class c on c.oid=t.tgrelid join pg_proc p on p.oid=t.tgfoid where c.relname=any($1::text[]) and not t.tgisinternal order by c.relname`, [TABLES])
      assert.deepEqual(triggers, [{ relname: 'platform_billing_accounts', proname: 'handle_updated_at' }, { relname: 'platform_subscriptions', proname: 'handle_updated_at' }])
      const indexes = await rows(`select indexname,indexdef from pg_indexes where schemaname='public' and tablename=any($1::text[])`, [TABLES])
      assert.match(indexes.find(i => i.indexname === 'platform_billing_events_recovery_idx').indexdef, /\(state, lease_until, received_at\)/)
      assert.match(indexes.find(i => i.indexname === 'platform_subscriptions_one_nonterminal_idx').indexdef, /UNIQUE[\s\S]*billing_account_id[\s\S]*WHERE/)
      assert.ok(indexes.some(i => i.indexname === 'platform_subscriptions_account_idx'))
      assert.ok(indexes.some(i => i.indexname === 'platform_subscriptions_owner_idx'))
    })

    const A = '00000000-0000-0000-0000-00000000b101', B = '00000000-0000-0000-0000-00000000b102', CREW = '00000000-0000-0000-0000-00000000b103'
    await db.query('insert into auth.users(id,email) values ($1,$4),($2,$5),($3,$6)', [A,B,CREW,'a@example.test','b@example.test','crew@example.test'])
    await db.query("insert into business_settings(user_id,company_name,owner_name,terms_text) values ($1,'Synthetic A','Owner A','Synthetic terms only'),($2,'Synthetic B','Owner B','Synthetic terms only')", [A,B])
    await check('new business creation seeds zero accounts, subscriptions or events', async () => {
      for (const table of TABLES) assert.equal((await one(`select count(*)::int as n from public.${table}`)).n, 0)
    })
    const account = async (uid: string, customer: string, scope = 'acct_platform_test', live = false) => one('insert into platform_billing_accounts(user_id,stripe_account_id,livemode,stripe_customer_id) values ($1,$2,$3,$4) returning *', [uid,scope,live,customer])
    const aa = await account(A,'cus_a'), bb = await account(B,'cus_b'), cc = await account(CREW,'cus_crew_invalid_server_fixture')
    const sub = async (acc: any, id: string, status = 'active') => one('insert into platform_subscriptions(billing_account_id,user_id,stripe_account_id,livemode,stripe_subscription_id,status,cancel_at_period_end) values ($1,$2,$3,$4,$5,$6,false) returning *', [acc.id,acc.user_id,acc.stripe_account_id,acc.livemode,id,status])
    const sa = await sub(aa,'sub_a'), sb = await sub(bb,'sub_b'); await sub(cc,'sub_crew_invalid_server_fixture')
    await check('A/B read only own mapping and history; crew with bad server fixture sees none', async () => {
      for (const uid of [A,B,CREW]) await asRole('authenticated',uid,async () => {
        for (const table of TABLES.slice(0,2)) assert.deepEqual((await rows(`select user_id from public.${table}`)).map(r => r.user_id), uid === CREW ? [] : [uid])
      })
      await asRole('authenticated',null, async () => assert.equal((await rows('select * from platform_billing_accounts')).length,0))
    })
    await check('anonymous cannot read any billing table; owners and crew cannot read events', async () => {
      for (const table of TABLES) await assert.rejects(() => asRole('anon',null,() => db.query(`select * from public.${table}`)), (e:any) => e.code === '42501')
      for (const uid of [A,B,CREW]) await assert.rejects(() => asRole('authenticated',uid,() => db.query('select * from platform_billing_events')), (e:any) => e.code === '42501')
    })
    await check('authenticated INSERT/UPDATE/DELETE is refused on all tables, even own rows', async () => {
      for (const table of TABLES) for (const sql of [`insert into public.${table} default values`, `update public.${table} set livemode=true`, `delete from public.${table}`]) {
        await assert.rejects(() => asRole('authenticated',A,() => db.query(sql)), (e:any) => e.code === '42501')
      }
    })
    await check('service role can read/write/update/delete privately, including canonical timestamps', async () => asRole('service_role',null,async () => {
      const c = await account(A,'cus_other_scope','acct_platform_other')
      const s = await sub(c,'sub_service')
      for (const [table,id] of [['platform_billing_accounts',c.id],['platform_subscriptions',s.id]]) {
        const updated = await one(`update public.${table} set updated_at='2000-01-01' where id=$1 returning updated_at`, [id])
        assert.ok(new Date(updated.updated_at).getUTCFullYear() > 2000)
      }
      await db.query("insert into platform_billing_events(stripe_account_id,livemode,event_id,event_type,event_created_at) values ('acct_platform_test',false,'evt_service','synthetic',now())")
      assert.equal((await rows('select * from platform_billing_events')).length,1)
      await db.query("update platform_billing_events set state='failed',last_error_code='retryable_db_error' where event_id='evt_service'")
      await db.query("delete from platform_billing_events where event_id='evt_service'")
      await db.query('delete from platform_billing_accounts where id=$1',[c.id])
      assert.equal((await rows('select * from platform_subscriptions where id=$1',[s.id])).length,0)
    }))
    await check('customer and owner mapping uniqueness is scoped by account AND mode', async () => {
      await assert.rejects(() => account(B,'cus_a'), (e:any) => e.code === '23505')
      await assert.rejects(() => account(A,'cus_replacement'), (e:any) => e.code === '23505')
      const live = await account(A,'cus_a','acct_platform_test',true), other = await account(A,'cus_a','acct_different',false)
      await sub(live,'sub_a'); await sub(other,'sub_a') // same provider ID is valid only in a different explicit scope
    })
    await check('composite FK refuses owner, provider account or mode mismatch', async () => {
      for (const bad of [{...aa,user_id:B},{...aa,stripe_account_id:'acct_other'},{...aa,livemode:true}]) await assert.rejects(() => sub(bad,'sub_mismatch','canceled'), (e:any) => e.code === '23503')
      await assert.rejects(() => sub(bb,'sub_a','canceled'), (e:any) => e.code === '23505')
      await refused('update platform_subscriptions set user_id=$1 where id=$2',[B,sa.id],'23503')
      await refused('update platform_billing_accounts set livemode=true where id=$1',[bb.id],'23503')
    })
    await check('all six nonterminal states conflict; scheduled cancellation reserves slot; terminal history retained', async () => {
      await db.query('update platform_subscriptions set cancel_at_period_end=true where id=$1',[sa.id])
      for (const status of ['incomplete','trialing','active','past_due','unpaid','paused']) await assert.rejects(() => sub(aa,`sub_${status}`,status), (e:any) => e.code === '23505')
      const history = await sub(aa,'sub_history','canceled'); await sub(aa,'sub_expired','incomplete_expired')
      await refused("update platform_subscriptions set status='active' where id=$1",[history.id],'23505')
      await db.query("update platform_subscriptions set status='canceled' where id=$1",[sa.id])
      await sub(aa,'sub_replacement')
      assert.equal((await one('select count(*)::int as n from platform_subscriptions where billing_account_id=$1',[aa.id])).n,4)
    })
    await check('blank identifiers, unknown status, absent required facts and inverted periods fail', async () => {
      for (const whitespace of ['', ' ', '\t\n']) {
        await assert.rejects(() => account(B,'cus_space',whitespace), (e:any) => e.code === '23514')
        await assert.rejects(() => account(B,whitespace,'acct_blank'), (e:any) => e.code === '23514')
        await refused('update platform_subscriptions set stripe_subscription_id=$1 where id=$2',[whitespace,sb.id],'23514')
        await refused('update platform_subscriptions set stripe_price_id=$1 where id=$2',[whitespace,sb.id],'23514')
      }
      await assert.rejects(() => sub(bb,'sub_unknown','future_provider_status'), (e:any) => e.code === '23514')
      for (const col of ['status','livemode','cancel_at_period_end']) await refused(`update platform_subscriptions set ${col}=null where id=$1`,[sb.id],'23502')
      for (const [start,end] of [['trial_start','trial_end'],['current_period_start','current_period_end']]) {
        await refused(`update platform_subscriptions set ${start}='2030-02-02', ${end}='2030-02-01' where id=$1`,[sb.id],'23514')
        await db.query(`update platform_subscriptions set ${start}='2030-02-02', ${end}='2030-02-02' where id=$1`,[sb.id])
        await db.query(`update platform_subscriptions set ${start}=null, ${end}=null where id=$1`,[sb.id])
      }
    })

    const eventSQL = "insert into platform_billing_events(stripe_account_id,livemode,event_id,event_type,event_created_at) values ($1,$2,$3,'synthetic.subscription',now()) on conflict do nothing returning *"
    const eventKey = ['acct_platform_test',false,'evt_retry']
    await check('duplicate receipt leaves unfinished event retryable; scope includes account/mode', async () => {
      const e = await one(eventSQL,eventKey)
      assert.equal(e.state,'received'); assert.equal(e.attempt_count,0); assert.equal(e.processed_at,null)
      assert.equal((await rows(eventSQL,eventKey)).length,0)
      assert.equal((await one('select state from platform_billing_events where event_id=$1',['evt_retry'])).state,'received')
      assert.ok(await one(eventSQL,['acct_platform_test',true,'evt_retry']))
      assert.ok(await one(eventSQL,['acct_other',false,'evt_retry']))
    })
    await check('invalid event lifecycle, raw errors and whitespace are refused', async () => {
      const scope = "where stripe_account_id='acct_platform_test' and livemode=false and event_id='evt_retry'"
      for (const assignment of ["state='unknown'", "attempt_count=-1", "state='processing',lease_until=null", "state='processed'", "state='ignored'", "processed_at=now()", "last_error_code='raw exception with private data'", `last_error_code='${'x'.repeat(129)}'`]) await refused(`update platform_billing_events set ${assignment} ${scope}`,[],'23514')
      for (const col of ['stripe_account_id','event_id','event_type']) await refused(`update platform_billing_events set ${col}=E'\\t\\n' ${scope}`,[],'23514')
    })
    await check('failed and expired processing leases can be reacquired; a stale attempt cannot finish the newer one', async () => {
      // Illustrative server SQL, not a production handler/RPC or concurrency proof.
      // A lease alone is insufficient: completion uses attempt_count as a fence.
      const claim = `update platform_billing_events set state='processing',attempt_count=attempt_count+1,lease_until=now()+interval '1 minute',last_error_code=null
        where stripe_account_id=$1 and livemode=$2 and event_id=$3
          and (state in ('received','failed') or (state='processing' and lease_until<=now())) returning attempt_count`
      const finish = `update platform_billing_events set state='processed',processed_at=now(),lease_until=null
        where stripe_account_id=$1 and livemode=$2 and event_id=$3 and state='processing' and attempt_count=$4 and lease_until>now() returning state`
      assert.equal((await one(claim,eventKey)).attempt_count,1)
      assert.equal((await rows(claim,eventKey)).length,0)
      await db.query("update platform_billing_events set state='failed',lease_until=null,last_error_code='db_retry' where stripe_account_id=$1 and livemode=$2 and event_id=$3",eventKey)
      assert.equal((await one(claim,eventKey)).attempt_count,2)
      await db.query("update platform_billing_events set lease_until=now()-interval '1 second' where stripe_account_id=$1 and livemode=$2 and event_id=$3",eventKey)
      assert.equal((await rows(finish,[...eventKey,2])).length,0)
      assert.equal((await one(claim,eventKey)).attempt_count,3)
      assert.equal((await rows(finish,[...eventKey,2])).length,0)
      assert.equal((await one(finish,[...eventKey,3])).state,'processed')
      assert.equal((await rows(claim,eventKey)).length,0)
      assert.equal((await rows(eventSQL,eventKey)).length,0)
      await refused("update platform_billing_events set state='failed' where stripe_account_id=$1 and livemode=$2 and event_id=$3",eventKey,'23514')
      await db.query("update platform_billing_events set state='ignored',processed_at=now() where stripe_account_id='acct_other' and event_id='evt_retry'")
      assert.equal((await rows(claim,['acct_other',false,'evt_retry'])).length,0)
    })
    console.log(`\n${passed} passed; 0 failed. Disposable PostgreSQL only; no provider retry/concurrency or live deployment claim.`)
  } finally { await db.close() }
}
main().catch(error => { console.error(error); process.exitCode=1 })
