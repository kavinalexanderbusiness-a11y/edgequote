// C1: actual pure resolver + exact offline SQL, synthetic identities only.
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { resolveMerchantEventIdentity, resolveMerchantOwnerIdentity } from '../src/lib/merchantConnections/resolve'
import type { MerchantConnection, MerchantConnectionReader, MerchantProviderObject, MerchantResolution } from '../src/lib/merchantConnections/types'
import { loadPGlite, splitStatements, substitutePlatformStatements } from './lib/pg-sql'

const ROOT = join(__dirname, '..'), DRAFT = 'supabase/drafts/merchant-connections-c1.sql'
const TABLES = ['merchant_connections', 'merchant_provider_objects']
const A = '00000000-0000-0000-0000-00000000c101', B = '00000000-0000-0000-0000-00000000c102', CREW = '00000000-0000-0000-0000-00000000c103'
const CID = '00000000-0000-0000-0000-00000000c111', INV = '00000000-0000-0000-0000-00000000c121'
const read = (p: string) => readFileSync(join(ROOT, p), 'utf8')
const files = (p: string): string[] => readdirSync(join(ROOT, p), { withFileTypes: true }).flatMap(e => e.isDirectory() ? files(`${p}/${e.name}`) : [`${p}/${e.name}`])
let passed = 0
async function check(name: string, fn: () => unknown | Promise<unknown>) { await fn(); passed++; console.log(`PASS ${name}`) }
function reason(result: MerchantResolution<unknown>, expected: string) { assert.equal(result.ok, false); if (!result.ok) assert.equal(result.reason, expected) }

const connection: MerchantConnection = { id: CID, user_id: A, stripe_platform_account_id: 'acct_platform', stripe_account_id: 'acct_merchantA', livemode: false, disconnected_at: null }
const binding: MerchantProviderObject = { connection_id: CID, user_id: A, stripe_platform_account_id: 'acct_platform', stripe_account_id: 'acct_merchantA', livemode: false, object_type: 'payment_intent', object_id: 'pi_owned', customer_id: null, invoice_id: INV, quote_id: null }
const ownerScope = { ownerId: A, platformAccountId: 'acct_platform', livemode: false }
const eventScope = { platformAccountId: 'acct_platform', stripeAccountId: 'acct_merchantA', livemode: false, objectType: 'payment_intent' as const, objectId: 'pi_owned' }
function fixture(overrides: Partial<MerchantConnectionReader> = {}): MerchantConnectionReader {
  return {
    owner: async uid => ({ ok: true, rows: uid === A ? [{ user_id: A }] : [] }),
    byOwner: async () => ({ ok: true, rows: [connection] }),
    byAccount: async () => ({ ok: true, rows: [connection] }),
    object: async () => ({ ok: true, rows: [binding] }), ...overrides,
  }
}

async function main() {
  await check('offline only: no runtime consumer, migration, credentials, capability grant or provider I/O', () => {
    for (const p of files('src').filter(p => /\.(ts|tsx)$/.test(p) && !p.startsWith('src/lib/merchantConnections/'))) assert.doesNotMatch(read(p), /merchant_connections|merchant_provider_objects|merchantConnections/, p)
    for (const p of files('supabase/migrations')) assert.doesNotMatch(read(p), /merchant_connections|merchant_provider_objects/, p)
    for (const p of files('src/lib/merchantConnections')) assert.doesNotMatch(read(p), /process\.env|\bfetch\s*\(|supabase-js|from ['"]@\/lib\/stripe/, p)
    assert.doesNotMatch(read(DRAFT), /if not exists|create (or replace )?function|on delete cascade|insert into|platform_capabilities|business_settings\s+(add|alter)|secret|token/i)
  })
  await check('owner identity returns explicit merchant/account/mode, no enabled state or extra row fields', async () => {
    const r = await resolveMerchantOwnerIdentity(fixture({ byOwner: async () => ({ ok: true, rows: [{ ...connection, extra: 'must not escape' }] }) }), ownerScope)
    assert.deepEqual(r, { ok: true, value: { connectionId: CID, ownerId: A, platformAccountId: 'acct_platform', stripeAccountId: 'acct_merchantA', livemode: false } })
  })
  await check('crew with a deliberately bad server mapping still fails current business-owner resolution', async () => {
    const bad = { ...connection, user_id: CREW }
    reason(await resolveMerchantOwnerIdentity(fixture({ byOwner: async () => ({ ok: true, rows: [bad] }) }), { ...ownerScope, ownerId: CREW }), 'not_owner')
    reason(await resolveMerchantEventIdentity(fixture({ byAccount: async () => ({ ok: true, rows: [bad] }) }), eventScope), 'not_owner')
  })
  for (const patch of [{ user_id: B }, { stripe_platform_account_id: 'acct_foreign' }, { livemode: true }, { stripe_account_id: 'acct_platform' }]) await check(`owner lookup refuses wrong stored scope ${JSON.stringify(patch)}`, async () => reason(await resolveMerchantOwnerIdentity(fixture({ byOwner: async () => ({ ok: true, rows: [{ ...connection, ...patch }] }) }), ownerScope), 'scope_mismatch'))
  await check('owner read error, missing row, duplicate row and disconnection never resolve', async () => {
    reason(await resolveMerchantOwnerIdentity(fixture({ owner: async () => ({ ok: false }) }), ownerScope), 'read_failed')
    reason(await resolveMerchantOwnerIdentity(fixture({ byOwner: async () => ({ ok: false }) }), ownerScope), 'read_failed')
    reason(await resolveMerchantOwnerIdentity(fixture({ byOwner: async () => ({ ok: true, rows: [] }) }), ownerScope), 'not_found')
    reason(await resolveMerchantOwnerIdentity(fixture({ byOwner: async () => ({ ok: true, rows: [connection, connection] }) }), ownerScope), 'ambiguous')
    reason(await resolveMerchantOwnerIdentity(fixture({ byOwner: async () => ({ ok: true, rows: [{ ...connection, disconnected_at: '2026-09-05T00:00:00Z' }] }) }), ownerScope), 'disconnected')
  })
  await check('event resolves stored object owner; conflicting supplied metadata is ignored', async () => {
    const request = { ...eventScope, metadata: { user_id: B, invoice_id: 'forged_invoice' } }
    const r = await resolveMerchantEventIdentity(fixture(), request)
    assert.equal(r.ok, true)
    if (r.ok) { assert.equal(r.value.identity.ownerId, A); assert.deepEqual(r.value.target, { kind: 'invoice', id: INV }) }
  })
  await check('historical disconnected merchant still resolves a known event target', async () => {
    const r = await resolveMerchantEventIdentity(fixture({ byAccount: async () => ({ ok: true, rows: [{ ...connection, disconnected_at: '2026-09-05T00:00:00Z' }] }) }), eventScope)
    assert.equal(r.ok, true)
  })
  for (const patch of [{ connection_id: B }, { user_id: B }, { stripe_platform_account_id: 'acct_wrong' }, { stripe_account_id: 'acct_wrong' }, { livemode: true }, { object_id: 'pi_foreign' }, { object_type: 'charge' as const }]) await check(`event rejects mismatched stored object ${JSON.stringify(patch)}`, async () => reason(await resolveMerchantEventIdentity(fixture({ object: async () => ({ ok: true, rows: [{ ...binding, ...patch }] }) }), eventScope), 'scope_mismatch'))
  await check('event rejects missing/ambiguous binding, malformed targets, and mismatched account/mode', async () => {
    for (const rows of [[], [binding, binding]]) reason(await resolveMerchantEventIdentity(fixture({ object: async () => ({ ok: true, rows }) }), eventScope), rows.length ? 'ambiguous' : 'not_found')
    for (const patch of [{ invoice_id: null }, { customer_id: A }, { invoice_id: 'not-a-uuid' }]) reason(await resolveMerchantEventIdentity(fixture({ object: async () => ({ ok: true, rows: [{ ...binding, ...patch }] }) }), eventScope), 'invalid_binding')
    for (const patch of [{ stripe_account_id: 'acct_foreign' }, { stripe_platform_account_id: 'acct_otherPlatform' }, { livemode: true }]) reason(await resolveMerchantEventIdentity(fixture({ byAccount: async () => ({ ok: true, rows: [{ ...connection, ...patch }] }) }), eventScope), 'scope_mismatch')
  })
  for (const method of ['owner', 'byAccount', 'object'] as const) await check(`event fails closed on returned or thrown ${method} read failure`, async () => {
    reason(await resolveMerchantEventIdentity(fixture({ [method]: async () => ({ ok: false }) }), eventScope), 'read_failed')
    reason(await resolveMerchantEventIdentity(fixture({ [method]: async () => { throw new Error('synthetic private detail') } }), eventScope), 'read_failed')
  })
  await check('invalid account/IDs, test-mode strings, platform-owned events refused before reads', async () => {
    const fail = async (): Promise<never> => { throw new Error('unexpected read') }
    const reader = fixture({ owner: fail, byAccount: fail })
    for (const scope of [{ ...ownerScope, ownerId: 'crew' }, { ...ownerScope, platformAccountId: '../accounts' }, { ...ownerScope, livemode: 'false' as unknown as boolean }]) reason(await resolveMerchantOwnerIdentity(reader, scope), 'invalid_scope')
    for (const scope of [{ ...eventScope, stripeAccountId: 'acct_platform' }, { ...eventScope, livemode: 'false' as unknown as boolean }, { ...eventScope, objectId: '../pi_other' }, { ...eventScope, objectType: 'constructor' as never }]) reason(await resolveMerchantEventIdentity(reader, scope), 'invalid_scope')
  })

  const pg = await loadPGlite()
  if (!pg) { console.log(`SKIP PostgreSQL proof: optional PGlite absent. ${passed} contract checks passed; schema approval requires completed PostgreSQL proof.`); return }
  const db = await pg.PGlite.create({ extensions: pg.contribs })
  const rows = async (sql: string, args: unknown[] = []): Promise<any[]> => (await db.query(sql, args)).rows
  const oneRow = async (sql: string, args: unknown[] = []) => (await rows(sql, args))[0]
  const refused = (sql: string, args: unknown[], code: string) => assert.rejects(() => db.query(sql, args), (e: any) => {
    assert.equal(e.code, code, `${e.message}; ${e.detail ?? ''}`); return true
  })
  async function apply(p: string) {
    const transformed = substitutePlatformStatements(read(p))
    for (const hit of transformed.hits) console.log(`Fixture substitution: ${hit}`)
    for (const sql of splitStatements(transformed.sql)) await db.exec(`${sql};`)
  }
  async function asRole<T>(role: string, uid: string | null, fn: () => Promise<T>): Promise<T> {
    await db.exec('begin')
    try {
      await db.query("select set_config('request.jwt.claim.sub',$1,true)", [uid ?? ''])
      await db.query("select set_config('request.jwt.claims',$1,true)", [JSON.stringify({ role, ...(uid ? { sub: uid } : {}) })])
      await db.exec(`set local role ${role}`)
      assert.equal((await oneRow('select current_user as role')).role, role)
      return await fn()
    } finally { await db.exec('rollback') }
  }
  const catalogue = () => rows(`select c.relname,c.relrowsecurity,c.relacl::text,
    (select jsonb_agg(jsonb_build_array(a.attname,a.atttypid,a.attnotnull,pg_get_expr(d.adbin,d.adrelid)) order by a.attnum) from pg_attribute a left join pg_attrdef d on d.adrelid=a.attrelid and d.adnum=a.attnum where a.attrelid=c.oid and a.attnum>0 and not a.attisdropped) as columns,
    (select jsonb_agg(pg_get_constraintdef(co.oid) order by co.conname) from pg_constraint co where co.conrelid=c.oid) as constraints,
    (select jsonb_agg(pg_get_indexdef(i.indexrelid) order by i.indexrelid::regclass::text) from pg_index i where i.indrelid=c.oid) as indexes,
    (select jsonb_agg(jsonb_build_array(p.polname,p.polcmd,p.polroles,pg_get_expr(p.polqual,p.polrelid),pg_get_expr(p.polwithcheck,p.polrelid)) order by p.polname) from pg_policy p where p.polrelid=c.oid) as policies,
    (select jsonb_agg(pg_get_triggerdef(t.oid) order by t.tgname) from pg_trigger t where t.tgrelid=c.oid and not t.tgisinternal) as triggers
    from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='public' and c.relkind='r' and not(c.relname=any($1::text[])) order by c.relname`, [TABLES])
  try {
    await apply('scripts/schema/platform-prelude.sql')
    for (const p of files('supabase/migrations').filter(p => p.endsWith('.sql')).sort()) await apply(p)
    await db.query('insert into auth.users(id,email) values ($1,$4),($2,$5),($3,$6)', [A, B, CREW, 'a@example.test', 'b@example.test', 'crew@example.test'])
    await db.query("insert into business_settings(user_id,company_name,owner_name,terms_text) values ($1,'Synthetic A','A','Synthetic terms'),($2,'Synthetic B','B','Synthetic terms')", [A, B])
    const local: Record<string, any> = {}
    for (const [key, uid] of [['a', A], ['b', B]]) {
      const c = await oneRow("insert into customers(user_id,name) values ($1,'Synthetic customer') returning id", [uid])
      const i = await oneRow("insert into invoices(user_id,customer_id,invoice_number,customer_name,status) values ($1,$2,$3,'Synthetic customer','draft') returning id", [uid, c.id, `INV-${key}`])
      const q = await oneRow("insert into quotes(user_id,customer_id,quote_number,customer_name,address,service_type) values ($1,$2,$3,'Synthetic customer','Synthetic address','Synthetic service') returning id", [uid, c.id, `QUOTE-${key}`])
      local[key] = { customer: c.id, invoice: i.id, quote: q.id }
    }
    const fingerprint = async () => Object.fromEntries(await Promise.all(['customers','invoices','quotes','payments','payment_methods','platform_capabilities'].map(async t => [t, await rows(`select to_jsonb(t) as row from public.${t} t order by to_jsonb(t)::text`)])))
    const beforeRows = await fingerprint(), beforeSchema = await catalogue()
    await db.exec('alter default privileges in schema public grant all on tables to anon,authenticated,service_role')
    await apply(DRAFT)
    await check('exact draft applies to current complete baseline; existing schema and business rows unchanged', async () => {
      assert.deepEqual(await catalogue(), beforeSchema); assert.deepEqual(await fingerprint(), beforeRows)
      for (const t of TABLES) assert.equal((await oneRow(`select count(*)::int as n from ${t}`)).n, 0)
    })
    await check('exact private table shape, explicit mode and no credentials/provider-enabled defaults', async () => {
      const columns = await rows("select table_name,column_name,is_nullable,column_default from information_schema.columns where table_schema='public' and table_name=any($1::text[]) order by table_name,ordinal_position", [TABLES])
      assert.deepEqual(columns.filter(c => c.table_name === TABLES[0]).map(c => c.column_name), ['id','user_id','stripe_platform_account_id','stripe_account_id','livemode','disconnected_at','created_at','updated_at'])
      assert.deepEqual(columns.filter(c => c.table_name === TABLES[1]).map(c => c.column_name), ['id','connection_id','user_id','stripe_platform_account_id','stripe_account_id','livemode','object_type','object_id','customer_id','invoice_id','quote_id','created_at'])
      for (const c of columns) {
        assert.equal(c.is_nullable, ['disconnected_at','customer_id','invoice_id','quote_id'].includes(c.column_name) ? 'YES' : 'NO')
        if (!['id','created_at','updated_at'].includes(c.column_name)) assert.equal(c.column_default, null)
      }
      assert.equal((await rows('select 1 from pg_class where relname=any($1::text[]) and relrowsecurity', [TABLES])).length, 2)
      assert.equal((await rows('select 1 from pg_policies where tablename=any($1::text[])', [TABLES])).length, 0)
    })
    await check('standing default grants removed; browser none, service append-only and disconnect-column only', async () => {
      for (const t of TABLES) for (const role of ['anon','authenticated','service_role']) for (const priv of ['SELECT','INSERT','UPDATE','DELETE','TRUNCATE','REFERENCES','TRIGGER']) {
        assert.equal((await oneRow('select has_table_privilege($1,$2,$3) as allowed', [role, t, priv])).allowed, role === 'service_role' && ['SELECT','INSERT'].includes(priv), `${role} ${t} ${priv}`)
      }
      const cols = await rows("select table_name,column_name from information_schema.columns where table_schema='public' and table_name=any($1::text[])", [TABLES])
      for (const c of cols) assert.equal((await oneRow("select has_column_privilege('service_role',$1,$2,'UPDATE') as allowed", [c.table_name, c.column_name])).allowed, c.table_name === TABLES[0] && c.column_name === 'disconnected_at')
      assert.equal((await rows('select 1 from pg_class c cross join lateral aclexplode(c.relacl) a where c.relname=any($1::text[]) and a.grantee=0', [TABLES])).length, 0)
    })
    const addConnection = (uid: string, acct: string, live = false, platform = 'acct_platform') => oneRow('insert into merchant_connections(user_id,stripe_platform_account_id,stripe_account_id,livemode) values ($1,$2,$3,$4) returning *', [uid, platform, acct, live])
    const ca = await addConnection(A, 'acct_A'), cb = await addConnection(B, 'acct_B')
    const addObject = (c: any, id: string, kind = 'payment_intent', target = 'invoice', targetId = local.a.invoice) => oneRow(`insert into merchant_provider_objects(connection_id,user_id,stripe_platform_account_id,stripe_account_id,livemode,object_type,object_id,${target}_id) values ($1,$2,$3,$4,$5,$6,$7,$8) returning *`, [c.id,c.user_id,c.stripe_platform_account_id,c.stripe_account_id,c.livemode,kind,id,targetId])
    const oa = await addObject(ca, 'pi_A')
    await addObject(ca, 'cus_A', 'customer', 'customer', local.a.customer)
    await addObject(ca, 'cs_quoteA', 'checkout_session', 'quote', local.a.quote)
    await check('owner existence FK rejects crew mapping even for trusted service insert', async () => asRole('service_role', null, () => assert.rejects(() => addConnection(CREW, 'acct_crew'), (e: any) => e.code === '23503')))
    await check('same-owner existing customer/invoice/quote FKs reject cross-tenant targets', async () => {
      for (const [type, prefix] of [['customer','cus_'],['invoice','pi_'],['quote','cs_']]) await assert.rejects(() => addObject(ca, `${prefix}foreign`, type === 'customer' ? 'customer' : type === 'invoice' ? 'payment_intent' : 'checkout_session', type, local.b[type]), (e: any) => e.code === '23503')
    })
    await check('composite relationship rejects connection/owner/platform/account/mode mismatch', async () => {
      for (const patch of [{ id: cb.id }, { user_id: B }, { stripe_platform_account_id: 'acct_foreign' }, { stripe_account_id: 'acct_foreign' }, { livemode: true }]) await assert.rejects(() => addObject({ ...ca, ...patch }, 'pi_mismatch'), (e: any) => e.code === '23503')
    })
    await check('provider identity cannot be reassigned; identical object IDs isolate account and mode', async () => {
      await assert.rejects(() => addConnection(B, 'acct_A'), (e: any) => e.code === '23505')
      await assert.rejects(() => addConnection(A, 'acct_extra'), (e: any) => e.code === '23505')
      await assert.rejects(() => addObject(ca, 'pi_A'), (e: any) => e.code === '23505')
      await addObject(cb, 'pi_A', 'payment_intent', 'invoice', local.b.invoice)
      const live = await addConnection(A, 'acct_A', true)
      await addObject(live, 'pi_A')
    })
    await check('all provider object kinds and target restrictions match current payment paths', async () => {
      for (const [kind,prefix] of [['payment_method','pm_'],['setup_intent','seti_'],['checkout_session','cs_']]) await addObject(ca, `${prefix}customer`, kind, 'customer', local.a.customer)
      await addObject(ca, 'ch_quote', 'charge', 'quote', local.a.quote)
      for (const [kind,prefix,target,tid] of [['customer','cus_','invoice',local.a.invoice],['setup_intent','seti_','quote',local.a.quote],['payment_intent','pi_','customer',local.a.customer],['charge','ch_','customer',local.a.customer]]) await assert.rejects(() => addObject(ca, `${prefix}bad`, kind, target, tid), (e: any) => e.code === '23514')
      await assert.rejects(() => addObject(ca, 'pm_wrongprefix'), (e: any) => e.code === '23514')
      await assert.rejects(() => addObject(ca, '../pi_unsafe'), (e: any) => e.code === '23514')
      await refused('update merchant_provider_objects set customer_id=$1 where id=$2', [local.a.customer, oa.id], '23514')
      await refused('update merchant_provider_objects set invoice_id=null where id=$1', [oa.id], '23514')
    })
    await check('owners, other owners, crew and anon cannot read or mutate even their own identities', async () => {
      for (const [role,uid] of [['authenticated',A],['authenticated',B],['authenticated',CREW],['anon',null]]) for (const t of TABLES) for (const sql of [`select * from ${t}`,`insert into ${t} default values`,`update ${t} set livemode=true`,`delete from ${t}`]) await assert.rejects(() => asRole(role!, uid, () => db.query(sql)), (e: any) => e.code === '42501')
    })
    await check('service can insert/read and disconnect with canonical timestamp; no identity edits/deletion', async () => asRole('service_role', null, async () => {
      const created = await oneRow("insert into merchant_connections(user_id,stripe_platform_account_id,stripe_account_id,livemode,updated_at) values ($1,'acct_otherPlatform','acct_otherPlatformMerchant',false,'2000-01-01') returning *", [A])
      await addObject(created, 'pi_service')
      assert.ok((await rows('select * from merchant_provider_objects')).length > 0)
      const disconnected = await oneRow('update merchant_connections set disconnected_at=now() where id=$1 returning *', [created.id])
      assert.ok(disconnected.disconnected_at); assert.ok(new Date(disconnected.updated_at).getTime() > new Date(created.updated_at).getTime())
      await db.query('update merchant_connections set disconnected_at=null where id=$1', [created.id])
    }))
    for (const sql of ["update merchant_connections set stripe_account_id='acct_reassigned'",`update merchant_connections set user_id='${B}'`,"update merchant_connections set updated_at='2000-01-01'",'delete from merchant_connections','update merchant_provider_objects set livemode=true','delete from merchant_provider_objects']) await check(`service refuses immutable history write: ${sql.split(' ').slice(0,3).join(' ')}`, () => assert.rejects(() => asRole('service_role', null, () => db.query(sql)), (e: any) => e.code === '42501'))
    await check('disconnect keeps old bindings and allows a replacement; old account cannot change owner', async () => {
      await db.query('update merchant_connections set disconnected_at=now() where id=$1', [ca.id])
      const replacement = await addConnection(A, 'acct_replacement')
      assert.notEqual(replacement.id, ca.id)
      assert.equal((await rows('select * from merchant_provider_objects where connection_id=$1', [ca.id])).length > 0, true)
      await assert.rejects(() => addConnection(B, 'acct_A'), (e: any) => e.code === '23505')
      await refused('update merchant_connections set disconnected_at=null where id=$1', [ca.id], '23505')
    })
    await check('FK retention refuses business/customer/invoice/quote/connection deletion without cascading', async () => {
      // Explicit ON DELETE RESTRICT uses restrict_violation (23001), distinct
      // from missing-parent foreign_key_violation (23503) on INSERT above.
      // PGlite's PostgreSQL publication validation otherwise rejects customer
      // DELETE first (42P10: unpublished generated column in replica identity).
      // Remove only the disposable publication inside each rollback transaction
      // to reach the real FK; no existing table/constraint/trigger is changed.
      console.log('Fixture substitution: retention test temporarily drops disposable supabase_realtime publication; every transaction rolls back.')
      for (const [table,col,id] of [['business_settings','user_id',A],['customers','id',local.a.customer],['invoices','id',local.a.invoice],['quotes','id',local.a.quote],['merchant_connections','id',ca.id]]) {
        await db.exec('begin')
        try { await db.exec('drop publication supabase_realtime'); await refused(`delete from ${table} where ${col}=$1`, [id], '23001') }
        finally { await db.exec('rollback') }
        assert.equal((await oneRow("select count(*)::int as n from pg_publication where pubname='supabase_realtime'")).n, 1)
      }
    })
    await check('real PostgreSQL reader resolves current owner plus historical event and isolates account/mode', async () => {
      const reader: MerchantConnectionReader = {
        owner: async uid => ({ ok: true, rows: await rows('select user_id from business_settings where user_id=$1', [uid]) }),
        byOwner: async s => ({ ok: true, rows: await rows('select * from merchant_connections where user_id=$1 and stripe_platform_account_id=$2 and livemode=$3 and disconnected_at is null', [s.ownerId,s.platformAccountId,s.livemode]) }),
        byAccount: async s => ({ ok: true, rows: await rows('select * from merchant_connections where stripe_platform_account_id=$1 and stripe_account_id=$2 and livemode=$3', [s.platformAccountId,s.stripeAccountId,s.livemode]) }),
        object: async s => ({ ok: true, rows: await rows('select * from merchant_provider_objects where stripe_platform_account_id=$1 and stripe_account_id=$2 and livemode=$3 and object_type=$4 and object_id=$5', [s.platformAccountId,s.stripeAccountId,s.livemode,s.objectType,s.objectId]) }),
      }
      // PostgreSQL returns timestamptz as Date in this harness; production reader
      // contract uses ISO strings (matching JSON/PostgREST), so normalize it.
      const original = reader.byAccount
      reader.byAccount = async s => { const r = await original(s); return r.ok ? { ok: true, rows: r.rows.map(c => ({ ...c, disconnected_at: c.disconnected_at === null ? null : new Date(c.disconnected_at).toISOString() })) } : r }
      const active = await resolveMerchantOwnerIdentity(reader, ownerScope)
      assert.equal(active.ok, true); if (active.ok) assert.equal(active.value.stripeAccountId, 'acct_replacement')
      const historical = await resolveMerchantEventIdentity(reader, { ...eventScope, stripeAccountId: 'acct_A', objectId: 'pi_A' })
      assert.equal(historical.ok, true); if (historical.ok) assert.equal(historical.value.target.id, local.a.invoice)
      const foreign = await resolveMerchantEventIdentity(reader, { ...eventScope, stripeAccountId: 'acct_B', objectId: 'pi_A' })
      assert.equal(foreign.ok, true); if (foreign.ok) { assert.equal(foreign.value.identity.ownerId,B); assert.equal(foreign.value.target.id,local.b.invoice) }
      reason(await resolveMerchantEventIdentity(reader, { ...eventScope, stripeAccountId: 'acct_B', livemode: true, objectId: 'pi_A' }), 'not_found')
    })
    await check('synthetic merchant inserts never grant capabilities or alter prior business records', async () => assert.deepEqual(await fingerprint(), beforeRows))
    console.log(`\n${passed} passed; 0 failed. Pure resolver and disposable PostgreSQL only. No provider, live RLS token, runtime activation or deployment claim.`)
  } finally { await db.close() }
}
main().catch(error => { console.error(error); process.exitCode = 1 })
