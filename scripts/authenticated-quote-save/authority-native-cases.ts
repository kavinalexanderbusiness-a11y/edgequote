import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import { DisposableSession, type Database, type TestResult } from '../pilot-email/database'
import { quoteSaveSnapshot, quoteSaveTargets, quoteSaveWrite } from '../pilot-email/quote-save-native-cases'
import { quoteSaveIntentFixture } from '../pilot-email/quote-save-plan-cases'
import { buildPilotQuoteSavePlan, type PilotQuoteSaveEditorSnapshot, type PilotQuoteSaveIntent,
  type PilotQuoteSavePlan, type PilotQuoteSaveTargetRequest } from '../../src/lib/quotes/pilotQuoteSavePlan'
import { savePilotQuoteSaveRequest, type PilotQuoteSaveStore } from '../../src/lib/quotes/pilotQuoteSave'
import { loadPilotQuoteSaveBaselineRequest } from '../../src/lib/quotes/pilotQuoteSaveBaselineServer'
import { parsePilotQuoteSaveBaseline } from '../../src/lib/quotes/pilotQuoteSaveBaseline'

// PREREQUISITE ONLY: native PG17 and real application SQL/server adapters with
// platform-prelude stub auth, synthetic getUser and SQL-bound role evidence.
// This is NOT GoTrue, JWT verification, PostgREST, browser or production proof.
// fixtures.mjs belongs to that separate, still-blocked authenticated milestone.
type Row = Record<string, unknown>
type Rows = Record<string, Row[]>
export type AuthorityFixture = { owner: string; customer: string; property: string; quote: string }
export const authorityNativeEvidence: Row[] = []
const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex')
const origin = 'https://authority-prerequisite.fixture.invalid'
const tables = ['business_settings','customers','properties','quotes','quote_services','quote_options','quote_addons',
  'quote_acceptances','service_templates','pricing_config_versions','property_measurements','property_measurement_events',
  'pilot_email_connections','pilot_quote_followup_workflows','pilot_email_send_attempts','messages','notification_log',
  'audit_events','integration_events','webhook_deliveries','notifications'] as const

/** Minimal native fixture: no retained email connection whose settings FK
 * would mask revocation. The caller owns BEGIN/COMMIT/ROLLBACK. */
export async function seedAuthorityFixture(db: Database): Promise<AuthorityFixture> {
  const f = { owner: randomUUID(), customer: randomUUID(), property: randomUUID(), quote: randomUUID() }
  await db.query('insert into auth.users(id,email,email_confirmed_at) values($1::uuid,$2,clock_timestamp())',
    [f.owner, `authority-${f.owner}@fixture.example.invalid`])
  await db.query(`insert into public.business_settings(user_id,company_name,business_type,timezone,default_rate,gst_percent)
    values($1::uuid,'Synthetic authority business','general','Etc/UTC',50,0)`, [f.owner])
  await db.query(`insert into public.customers(id,user_id,name,address)
    values($1::uuid,$2::uuid,'Synthetic authority customer','10 Authority Road')`, [f.customer,f.owner])
  await db.query(`insert into public.properties(id,user_id,customer_id,address,is_primary)
    values($1::uuid,$2::uuid,$3::uuid,'10 Authority Road',true)`, [f.property,f.owner,f.customer])
  await db.query(`insert into public.quotes(id,user_id,customer_id,property_id,quote_number,customer_name,address,
    service_type,initial_price,hours,rate,crew_size,travel_fee,measured_sqft,status,notes,internal_notes)
    values($1::uuid,$2::uuid,$3::uuid,$4::uuid,$5,'Synthetic authority customer','10 Authority Road',
      'General visit',101.23,1.13,37.17,1,0,1234.56,'draft','Original public scope','Original private scope')`,
  [f.quote,f.owner,f.customer,f.property,`AUTHORITY-${f.quote}`])
  return f
}

/** One independent SELECT includes whole row values and native audit effects.
 * Read-only; neither a receipt nor a reconstructed pricing result is its input. */
export async function readAuthorityRows(db: Database, owner: string): Promise<Rows> {
  const fields = tables.map(table => `'${table}',(select coalesce(jsonb_agg(to_jsonb(t) order by t.id),'[]'::jsonb)
    from public.${table} t where t.user_id=$1::uuid)`)
  const result = await db.query<{ value: Rows }>(`select jsonb_build_object(${fields.join(',')},
    'linked_technicians',(select coalesce(jsonb_agg(to_jsonb(t) order by t.id),'[]'::jsonb)
      from public.technicians t where t.auth_user_id=$1::uuid)) as value`, [owner])
  assert.equal(result.rows.length,1)
  return result.rows[0].value
}

export async function readAuthorityRole(db: Database, owner: string): Promise<string> {
  await db.exec('savepoint authority_role_probe; set local role authenticated')
  try {
    await db.query("select set_config('request.jwt.claim.sub',$1,true)", [owner])
    const result = await db.query<{ role: string }>('select public.current_app_role() as role')
    assert.equal(result.rows.length,1)
    return result.rows[0].role
  } finally {
    // Restore the exact previous role/claims before the native service transport,
    // which independently asserts NULL JWT subject for every RPC.
    await db.exec('rollback to savepoint authority_role_probe; release savepoint authority_role_probe')
  }
}

async function boundRoleRpc(db: Database, caller: string, expectedOwner: string): Promise<Row> {
  await db.exec('savepoint authority_bound_role; set local role authenticated')
  try {
    await db.query("select set_config('request.jwt.claim.sub',$1,true)",[caller])
    const result=await db.query<{value:Row}>('select public.pilot_quote_save_owner_role($1::uuid) as value',[expectedOwner])
    assert.equal(result.rows.length,1);return result.rows[0].value
  } finally {await db.exec('rollback to savepoint authority_bound_role; release savepoint authority_bound_role')}
}

const request = (body: unknown) => new Request(origin + '/dormant', { method:'POST',
  headers:{ origin,'content-type':'application/json' }, body:JSON.stringify(body) })
function serverPorts(db: Database, owner: string, calls: string[]) {
  const auth = {
    async getUser() { calls.push('getUser:synthetic'); return { data:{ user:{ id:owner } }, error:null } },
    async readOwnerRole(expectedOwner: string, signal: AbortSignal) {
      calls.push('readOwnerRole:actual-SQL-stub-auth'); assert.equal(expectedOwner,owner)
      if (signal.aborted) throw Error('Aborted role read')
      return { data:{ owner_id:owner, role:await readAuthorityRole(db,owner) }, error:null }
    },
  }
  const store: PilotQuoteSaveStore = {
    async snapshot(who,quote,signal) { calls.push('snapshot'); assert.equal(who,owner); assert.ok(!signal.aborted); return quoteSaveSnapshot(db,{owner:who,quote}) },
    async targets(selection,signal) { calls.push('targets'); assert.equal(selection.owner,owner); assert.ok(!signal.aborted); return quoteSaveTargets(db,selection) },
    async commit(who,quote,plan,signal) { calls.push('commit'); assert.equal(who,owner); assert.ok(!signal.aborted); return quoteSaveWrite(db,{owner:who,quote},plan) },
  }
  return { auth,store }
}
async function nativePlan(db: Database, f: AuthorityFixture, notes: string) {
  const snapshot = await quoteSaveSnapshot(db,f)
  assert.equal(snapshot.code,'snapshot')
  const intent: PilotQuoteSaveIntent = { ...quoteSaveIntentFixture(snapshot as unknown as PilotQuoteSaveEditorSnapshot,{notes}),
    clientOperationId:randomUUID(),editorGeneration:'authority-prerequisite' }
  const plan = await buildPilotQuoteSavePlan(snapshot,intent,selection=>quoteSaveTargets(db,selection))
  assert.equal(plan.provenance.mode,'preserve'); assert.equal(plan.measurement,null)
  return { snapshot,intent,plan }
}
const targetSelection = (f: AuthorityFixture, plan: PilotQuoteSavePlan): PilotQuoteSaveTargetRequest => ({
  owner:f.owner,quote_id:f.quote,expected_editor_revision:plan.expected_editor_revision,
  identity:plan.identity,template_ids:plan.expected.targets.templates.map(t=>String(t.row.id)).sort(),provenance_mode:plan.provenance.mode,
})
const withoutSettings = (rows: Rows) => Object.fromEntries(Object.entries(rows).filter(([table])=>table!=='business_settings'))
function quoteHas(rows: Rows, f: AuthorityFixture, notes: string) {
  assert.equal(rows.quotes.length,1)
  const q=rows.quotes[0]
  assert.equal(q.id,f.quote); assert.equal(q.user_id,f.owner); assert.equal(q.customer_id,f.customer); assert.equal(q.property_id,f.property)
  assert.equal(q.notes,notes); assert.equal(q.internal_notes,'Original private scope')
  assert.equal(q.initial_price,101.23); assert.equal(q.rate,37.17); assert.equal(q.hours,1.13); assert.equal(q.measured_sqft,1234.56)
  for(const table of ['quote_services','quote_options','quote_addons','quote_acceptances','property_measurements','property_measurement_events']) assert.equal(rows[table].length,0)
}
async function transaction<T>(db: Database, work:()=>Promise<T>): Promise<T> {
  await db.exec('begin isolation level read committed')
  try { const value=await work(); await db.exec('commit'); return value }
  catch(error) { await db.exec('rollback'); throw error }
}

async function nativeDefinitions(db: Database) {
  const names=['public.pilot_quote_save_snapshot(uuid,uuid)','public.pilot_quote_save_targets(uuid,uuid,text,jsonb,uuid[],text)',
    'public.pilot_quote_save(uuid,uuid,jsonb)','public._pilot_quote_save_lock(uuid,uuid,uuid[],uuid[])',
    'public._pilot_qs_snapshot(uuid,uuid)','public._pilot_qs_targets(uuid,uuid,text,jsonb,uuid[])',
    'public._pilot_qs_pricing(uuid)','public._pilot_qs_is_owner(uuid)','public.pilot_quote_identity_save(uuid,uuid,jsonb)',
    'public.pilot_quote_save_owner_role(uuid)','public.current_app_role()','public.quote_terms_fingerprint(uuid)','auth.uid()']
  return (await db.query<Row>(`select signature,case when to_regprocedure(signature) is null then null
    else md5(pg_get_functiondef(to_regprocedure(signature))) end as definition_md5,
    case when to_regprocedure(signature) is null then null else pg_get_userbyid(p.proowner) end as function_owner
    from unnest(array(select jsonb_array_elements_text($1::jsonb))) signature
    left join pg_proc p on p.oid=to_regprocedure(signature) order by signature`,[JSON.stringify(names)])).rows
}

/** Positive barrier: independent backend observes an actual wait on the other
 * transaction. There is no fixed-delay claim that an operation "probably ran". */
async function rowBarrier(observer: Database, waiter: number, holder: number) {
  const deadline=Date.now()+8000
  while(Date.now()<deadline) {
    const result=(await observer.query<Row>(`select pg_backend_pid() as observer,$1::int as waiter,$2::int as holder,
      $2::int=any(pg_blocking_pids($1::int)) as blocked,
      (select coalesce(jsonb_agg(jsonb_build_object('type',locktype,'mode',mode,'transaction',transactionid::text,'granted',granted)
        order by locktype,mode),'[]'::jsonb) from pg_locks where pid=$1::int and not granted and locktype in ('transactionid','tuple')) as waiting_locks,
      (select coalesce(jsonb_agg(jsonb_build_object('type',locktype,'mode',mode,'transaction',transactionid::text,'granted',granted)
        order by locktype,mode),'[]'::jsonb) from pg_locks where pid=$2::int and granted and locktype in ('transactionid','tuple')) as holder_locks`,[waiter,holder])).rows[0]
    if(result?.blocked===true&&Array.isArray(result.waiting_locks)&&result.waiting_locks.length>0) {
      assert.notEqual(result.observer,waiter); assert.notEqual(result.observer,holder)
      return result
    }
    await new Promise(resolve=>setTimeout(resolve,25))
  }
  throw Error('Native row-lock ordering was not observed')
}

export async function runAuthorityCases(observer: Database, expected: 'vulnerable'|'corrected') {
  assert.ok(expected==='vulnerable'||expected==='corrected')
  const tests:TestResult[]=[],evidence:Row[]=[],barriers:Row[]=[],closureErrors:string[]=[]
  authorityNativeEvidence.length=0
  const owned:{name:string;attempted:boolean;opened:boolean;closed:boolean;pid:number|null;db?:DisposableSession}[]=[]
  let observerReleased=true
  const record=(value:Row)=>{evidence.push(value);authorityNativeEvidence.push(value)}
  const test=async(name:string,work:()=>Promise<void>,cleanup:()=>Promise<void>)=>{
    let failure:unknown
    try{await work()}catch(error){failure=error}
    try{await cleanup()}catch(error){failure=error;closureErrors.push(error instanceof Error?error.message.slice(0,500):'Cleanup failed')}
    tests.push({name,pass:!failure,...(failure?{error:failure instanceof Error?failure.message.slice(0,1800):'Authority assertion failed'}:{})})
  }
  const rollbackObserver=async()=>{try{await observer.exec('rollback');observerReleased=true}catch(error){observerReleased=false;throw error}}
  const beforeDefinitions=await nativeDefinitions(observer)
  try {
    assert.equal(beforeDefinitions.find(row=>row.signature==='public.pilot_quote_save_owner_role(uuid)')?.definition_md5===null,expected==='vulnerable',
      'The new role RPC is absent in the vulnerable source and present only in the correction')
    await test('authority: valid owner native plan and actual HTTP Save remain available',async()=>{
      await observer.exec('begin isolation level read committed');observerReleased=false
      const f=await seedAuthorityFixture(observer),before=await readAuthorityRows(observer,f.owner)
      assert.equal(await readAuthorityRole(observer,f.owner),'owner')
      const prepared=await nativePlan(observer,f,'Valid owner saved scope')
      assert.deepEqual(await readAuthorityRows(observer,f.owner),before,'Actual snapshot/planner/targets are read-only')
      const calls:string[]=[],ports=serverPorts(observer,f.owner,calls)
      const baseline=await loadPilotQuoteSaveBaselineRequest(ports.store,ports.auth,request({version:1,quoteId:f.quote}),{trustedOrigin:origin})
      assert.equal(baseline.status,200)
      assert.ok(parsePilotQuoteSaveBaseline(await baseline.json(),{ownerId:f.owner,quoteId:f.quote}))
      const response=await savePilotQuoteSaveRequest(ports.store,ports.auth,request(prepared.intent),{trustedOrigin:origin})
      assert.equal(response.status,200);const receipt=await response.json();assert.equal(receipt.code,'committed')
      const after=await readAuthorityRows(observer,f.owner);quoteHas(after,f,'Valid owner saved scope')
      assert.equal(calls.filter(v=>v==='commit').length,1)
      if(expected==='corrected')assert.equal(calls.filter(v=>v.startsWith('readOwnerRole')).length,2)
      record({kind:'valid-owner',expected,owner:f.owner,quote:f.quote,calls,before,after,receipt,
        transaction:'outer fixture rolled back; no durable-commit claim'})
    },rollbackObserver)

    if(expected==='corrected')await test('authority: authenticated role RPC binds identity and preserves exact role grants',async()=>{
      await observer.exec('begin isolation level read committed');observerReleased=false
      const f=await seedAuthorityFixture(observer),other=await seedAuthorityFixture(observer)
      const permissions=(await observer.query<Row>(`select r as role,
        has_function_privilege(r,'public.pilot_quote_save_owner_role(uuid)','execute') as bound_role,
        has_function_privilege(r,'public.pilot_quote_save_snapshot(uuid,uuid)','execute') as snapshot,
        has_function_privilege(r,'public.pilot_quote_save_targets(uuid,uuid,text,jsonb,uuid[],text)','execute') as targets,
        has_function_privilege(r,'public.pilot_quote_save(uuid,uuid,jsonb)','execute') as save
        from unnest(array['anon','authenticated','service_role']) r order by r`)).rows
      assert.deepEqual(permissions,[
        {role:'anon',bound_role:false,snapshot:false,targets:false,save:false},
        {role:'authenticated',bound_role:true,snapshot:false,targets:false,save:false},
        {role:'service_role',bound_role:false,snapshot:true,targets:true,save:true},
      ])
      const owner=await boundRoleRpc(observer,f.owner,f.owner)
      assert.deepEqual(owner,{owner_id:f.owner,role:'owner'})
      const mismatch=await boundRoleRpc(observer,f.owner,other.owner);assert.deepEqual(mismatch,{code:'forbidden'})
      const unowned=await seedAuthorityFixture(observer)
      await observer.query('delete from public.business_settings where user_id=$1::uuid',[unowned.owner])
      const none=await boundRoleRpc(observer,unowned.owner,unowned.owner);assert.deepEqual(none,{owner_id:unowned.owner,role:'none'})
      // Synthetic postgres setup links the technician AFTER the owner's settings
      // exist. Canonical current_app_role gives that settings row precedence;
      // the correction must not invent a stronger crew exclusion while it exists.
      await observer.query("insert into public.technicians(user_id,auth_user_id,name,is_active,archived_at) values($1::uuid,$2::uuid,'Synthetic role transition',true,null)",[other.owner,f.owner])
      const ownerWithCrewLink=await boundRoleRpc(observer,f.owner,f.owner)
      assert.deepEqual(ownerWithCrewLink,{owner_id:f.owner,role:'owner'})
      await observer.query('delete from public.business_settings where user_id=$1::uuid',[f.owner])
      const crew=await boundRoleRpc(observer,f.owner,f.owner);assert.deepEqual(crew,{owner_id:f.owner,role:'crew'})
      record({kind:'corrected-bound-role-rpc',permissions,owner,mismatch,none,ownerWithCrewLink,crew,
        auth:'actual native RPC with explicit platform-prelude SET LOCAL subject; not real JWT authentication',transaction:'outer fixture rolled back'})
    },rollbackObserver)

    for(const role of ['none','crew'] as const)await test(`authority: revoked ${role} owner fresh baseline and preserve Save`,async()=>{
      await observer.exec('begin isolation level read committed');observerReleased=false
      const f=await seedAuthorityFixture(observer),prepared=await nativePlan(observer,f,'Forbidden prepared scope')
      await observer.query('delete from public.business_settings where user_id=$1::uuid',[f.owner])
      if(role==='crew') {
        const employer=randomUUID()
        await observer.query('insert into auth.users(id,email,email_confirmed_at) values($1::uuid,$2,clock_timestamp())',[employer,`employer-${employer}@fixture.example.invalid`])
        await observer.query("insert into public.business_settings(user_id,company_name) values($1::uuid,'Synthetic employer')",[employer])
        await observer.query("insert into public.technicians(user_id,auth_user_id,name,is_active,archived_at) values($1::uuid,$2::uuid,'Synthetic former owner',true,null)",[employer,f.owner])
      }
      assert.equal(await readAuthorityRole(observer,f.owner),role)
      const before=await readAuthorityRows(observer,f.owner);assert.equal(before.business_settings.length,0)
      const calls:string[]=[],ports=serverPorts(observer,f.owner,calls)
      const baselineResponse=await loadPilotQuoteSaveBaselineRequest(ports.store,ports.auth,request({version:1,quoteId:f.quote}),{trustedOrigin:origin})
      const baselineBody=await baselineResponse.json()
      let intent=prepared.intent
      if(expected==='vulnerable') {
        assert.equal(baselineResponse.status,200)
        const baseline=parsePilotQuoteSaveBaseline(baselineBody,{ownerId:f.owner,quoteId:f.quote});assert.ok(baseline)
        intent={...prepared.intent,expectedEditorRevision:baseline.editorRevision,values:{...baseline.values,notes:'HTTP accepted revoked owner'}}
      } else {assert.equal(baselineResponse.status,403);assert.deepEqual(baselineBody,{code:'forbidden'})}
      const response=await savePilotQuoteSaveRequest(ports.store,ports.auth,request(intent),{trustedOrigin:origin})
      const receipt=await response.json(),afterServer=await readAuthorityRows(observer,f.owner)
      assert.equal(response.status,expected==='vulnerable'?200:403)
      assert.equal(receipt.code,expected==='vulnerable'?'committed':'forbidden')
      if(expected==='corrected') {
        assert.deepEqual(receipt,{code:'forbidden'});assert.deepEqual(afterServer,before)
        assert.ok(!calls.some(v=>['snapshot','targets','commit'].includes(v)),'Forbidden role stops before store access')
      } else quoteHas(afterServer,f,'HTTP accepted revoked owner')
      const snapshot=await quoteSaveSnapshot(observer,f)
      let targets:Row,native:Row
      if(expected==='vulnerable') {
        assert.equal(snapshot.code,'snapshot');assert.equal(snapshot.pricing_inputs,null)
        const fresh=await nativePlan(observer,f,'Native accepted revoked owner')
        assert.equal(fresh.plan.expected.targets.pricing_inputs,null)
        targets=await quoteSaveTargets(observer,targetSelection(f,fresh.plan));assert.equal(targets.code,'targets')
        native=await quoteSaveWrite(observer,f,fresh.plan);assert.equal(native.code,'committed')
      } else {
        assert.deepEqual(snapshot,{code:'forbidden'})
        targets=await quoteSaveTargets(observer,targetSelection(f,prepared.plan));assert.deepEqual(targets,{code:'forbidden'})
        native=await quoteSaveWrite(observer,f,prepared.plan);assert.deepEqual(native,{code:'forbidden'})
      }
      const after=await readAuthorityRows(observer,f.owner)
      if(expected==='corrected')assert.deepEqual(after,before,'No business, audit or integration changes on refusal')
      else quoteHas(after,f,'Native accepted revoked owner')
      record({kind:'fresh-revoked-owner',expected,role,owner:f.owner,quote:f.quote,calls,baselineStatus:baselineResponse.status,
        baselineCode:baselineBody.code,httpStatus:response.status,httpReceipt:receipt,snapshotCode:snapshot.code,targetsCode:targets.code,
        nativeReceipt:native,before,afterServer,after,transaction:'outer fixture rolled back; vulnerable PASS means reproduced defect'})
    },rollbackObserver)

    const open=async(name:string)=>{
      const item:{name:string;attempted:boolean;opened:boolean;closed:boolean;pid:number|null;db?:DisposableSession}={name,attempted:true,opened:false,closed:false,pid:null};owned.push(item)
      item.db=await DisposableSession.open(name);item.opened=true;item.pid=item.db.pid;return item.db
    }
    const left=await open('authority-left'),right=await open('authority-right')
    assert.notEqual(left.pid,right.pid)
    const pending:Promise<unknown>[]=[]
    const track=<T,>(work:Promise<T>)=>{pending.push(work.catch(()=>undefined));return work}
    const cleanup=async()=>{
      const results=await Promise.allSettled([left.exec('rollback'),right.exec('rollback'),rollbackObserver()])
      await Promise.allSettled(pending.splice(0))
      if(results.some(r=>r.status==='rejected'))throw Error('A native authority transaction did not confirm rollback')
    }
    await test('authority: revocation row lock wins before waiting Save',async()=>{
      const f=await transaction(observer,()=>seedAuthorityFixture(observer))
      const prepared=await transaction(observer,()=>nativePlan(observer,f,'Must not save after revocation'))
      const before=await readAuthorityRows(observer,f.owner)
      await left.exec('begin isolation level read committed')
      assert.equal((await left.query('delete from public.business_settings where user_id=$1::uuid returning user_id',[f.owner])).rows.length,1)
      await right.exec('begin isolation level read committed')
      const waiting=track(quoteSaveWrite(right,f,prepared.plan))
      const barrier=await rowBarrier(observer,right.pid,left.pid);barriers.push(barrier)
      assert.deepEqual(await readAuthorityRows(observer,f.owner),before,'Observer sees neither uncommitted deletion nor Save')
      await left.exec('commit')
      const revoked=await readAuthorityRows(observer,f.owner);assert.equal(revoked.business_settings.length,0)
      const verdict=await waiting
      assert.deepEqual(verdict,{code:expected==='corrected'?'forbidden':'stale_editor'})
      await right.exec('commit')
      const after=await readAuthorityRows(observer,f.owner);assert.deepEqual(after,revoked,'Waiting Save wrote no rows')
      record({kind:'revocation-first',expected,owner:f.owner,quote:f.quote,barrier,before,revoked,verdict,after,
        observerDigests:{before:digest(before),revoked:digest(revoked),after:digest(after)},transaction:'independent native transactions committed in marked disposable DB'})
    },cleanup)
    await test('authority: Save row lock wins and later revocation waits',async()=>{
      const f=await transaction(observer,()=>seedAuthorityFixture(observer))
      const prepared=await transaction(observer,()=>nativePlan(observer,f,'Save won before revocation'))
      const before=await readAuthorityRows(observer,f.owner)
      await left.exec('begin isolation level read committed')
      const receipt=await quoteSaveWrite(left,f,prepared.plan);assert.equal(receipt.code,'committed')
      await right.exec('begin isolation level read committed')
      const deletion=track(right.query('delete from public.business_settings where user_id=$1::uuid returning user_id',[f.owner]))
      const barrier=await rowBarrier(observer,right.pid,left.pid);barriers.push(barrier)
      assert.deepEqual(await readAuthorityRows(observer,f.owner),before,'Observer cannot see uncommitted Save')
      await left.exec('commit')
      assert.equal((await deletion).rows.length,1)
      const saved=await readAuthorityRows(observer,f.owner);quoteHas(saved,f,'Save won before revocation')
      assert.equal(saved.business_settings.length,1,'Deletion is still uncommitted on the other connection')
      await right.exec('commit')
      const after=await readAuthorityRows(observer,f.owner);assert.equal(after.business_settings.length,0)
      assert.deepEqual(withoutSettings(after),withoutSettings(saved),'Later deletion does not retroactively refuse or change completed Save')
      record({kind:'save-first',expected,owner:f.owner,quote:f.quote,barrier,receipt,before,saved,after,
        observerDigests:{before:digest(before),saved:digest(saved),after:digest(after)},transaction:'independent native transactions committed in marked disposable DB'})
    },cleanup)
  } catch(error) {
    tests.push({name:'authority: native orchestration completed',pass:false,error:error instanceof Error?error.message.slice(0,1800):'Native orchestration failure'})
  } finally {
    try{await rollbackObserver()}catch(error){closureErrors.push(error instanceof Error?error.message.slice(0,500):'Observer rollback failed')}
    const closed=await Promise.allSettled(owned.map(async item=>{if(item.db){await item.db.close();item.closed=true}}))
    for(const result of closed)if(result.status==='rejected')closureErrors.push(result.reason instanceof Error?result.reason.message.slice(0,500):'Owned psql close failed')
  }
  let definitionsUnchanged=false,afterDefinitions:Row[]=[]
  try{afterDefinitions=await nativeDefinitions(observer);definitionsUnchanged=JSON.stringify(beforeDefinitions)===JSON.stringify(afterDefinitions)}
  catch(error){closureErrors.push(error instanceof Error?error.message.slice(0,500):'Definition readback failed')}
  const allSessionsClosed=owned.every(item=>item.opened&&item.closed)&&observerReleased&&closureErrors.length===0
  return { tests,evidence,barriers,expected,beforeDefinitions,afterDefinitions,definitionsUnchanged,
    pass:tests.length===(expected==='corrected'?6:5)&&tests.every(test=>test.pass)&&definitionsUnchanged&&allSessionsClosed,
    roleRpcCasesExecuted:expected==='corrected',
    sessions:owned.map(({name,attempted,opened,closed,pid})=>({name,attempted,opened,closed,pid})),allSessionsClosed,closureErrors,
    closure:'Only owned psql sessions are closed here; supplied observer remains caller-owned and its transaction is released',
    scope:'Actual native application functions and canonical server adapters, synthetic verified-user seam and platform-prelude stub auth; not authenticated milestone',
    resultMeaning:expected==='vulnerable'?'PASS establishes that the missing-owner authorization defect is reproducible':'PASS establishes the bounded native/server authority correction and both observed lock orders' }
}
