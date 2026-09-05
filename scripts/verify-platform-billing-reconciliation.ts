// Actual core + draft RPCs in disposable PostgreSQL. Controlled provider promises
// exercise overlapping deliveries, not real provider I/O or multi-backend lock waits.
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { loadPGlite, splitStatements, substitutePlatformStatements } from './lib/pg-sql'
import { reconcilePlatformSubscriptionEvent as reconcile } from '../src/lib/billing/reconcile'
import type { CanonicalPlatformSubscription, PlatformBillingStore, VerifiedPlatformSubscriptionEvent } from '../src/lib/billing/reconcileTypes'

const ROOT = join(__dirname,'..')
const read = (p: string) => readFileSync(join(ROOT,p),'utf8')
const scope = { platformAccountId:'acct_platform',merchantAccountId:'acct_merchant',livemode:false }
const A='00000000-0000-0000-0000-00000000b201', B='00000000-0000-0000-0000-00000000b202'
const CREW='00000000-0000-0000-0000-00000000b203', D='00000000-0000-0000-0000-00000000b204'
const event = (id: string, subscription='sub_a', customer='cus_a'): VerifiedPlatformSubscriptionEvent => ({
  stripeAccountId:scope.platformAccountId,livemode:false,eventId:id,eventType:'customer.subscription.updated',
  eventCreatedAt:'2026-09-05T12:00:00.000Z',stripeCustomerId:customer,stripeSubscriptionId:subscription,
})
const subscription = (id='sub_a', status: CanonicalPlatformSubscription['status']='active', customer='cus_a'): CanonicalPlatformSubscription => ({
  stripeSubscriptionId:id,stripeCustomerId:customer,livemode:false,stripePriceId:null,status,
  trialStart:null,trialEnd:null,currentPeriodStart:null,currentPeriodEnd:null,
  cancelAtPeriodEnd:false,cancelAt:null,canceledAt:null,endedAt:null,
})
const envelope = (subscriptions: CanonicalPlatformSubscription[], customer='cus_a') => ({
  stripeAccountId:scope.platformAccountId,livemode:false,stripeCustomerId:customer,complete:true,subscriptions,
})
function deferred<T>() { let resolve!: (value:T)=>void; const promise=new Promise<T>(r=>{resolve=r}); return { promise,resolve } }
let passed=0
async function check(name:string, fn:()=>Promise<unknown>) { await fn();passed++;console.log(`PASS ${name}`) }

async function main() {
  const pg=await loadPGlite()
  if (!pg) { console.log('SKIP behavioral proof: optional PGlite is absent; B2 approval requires a completed run.');return }
  const db=await pg.PGlite.create({extensions:pg.contribs})
  const rows=async(sql:string,args:unknown[]=[]):Promise<any[]> => (await db.query(sql,args)).rows
  const one=async(sql:string,args:unknown[]=[]) => (await rows(sql,args))[0]
  const rpcNames=['platform_billing_claim_event','platform_billing_commit_event','platform_billing_fail_event']
  let rpcCalls=0
  const store:PlatformBillingStore={async rpc(name,args) {
    assert.ok(rpcNames.includes(name));rpcCalls++
    const keys=Object.keys(args);keys.forEach(k=>assert.match(k,/^p_[a-z_]+$/))
    return db.transaction(async(tx:any)=>{
      await tx.exec('set local role service_role')
      assert.equal((await tx.query('select current_user as role')).rows[0].role,'service_role')
      const values=keys.map(k=>k==='p_subscriptions'?JSON.stringify(args[k]):args[k])
      const result=await tx.query(`select public.${name}(${keys.map((k,i)=>`${k} => $${i+1}`).join(',')}) as result`,values)
      return {data:result.rows[0].result,error:null}
    })
  }}
  const eRow=(id:string)=>one('select * from platform_billing_events where event_id=$1 and stripe_account_id=$2 and not livemode',[id,scope.platformAccountId])
  const aRow=()=>one('select * from platform_billing_accounts where user_id=$1',[A])
  const subRows=()=>rows('select stripe_subscription_id,status,last_synced_at from platform_subscriptions where user_id=$1 order by stripe_subscription_id',[A])
  async function reset() {
    await db.exec('delete from public.platform_billing_events; delete from public.platform_subscriptions; delete from public.platform_billing_accounts;')
    await db.query(`insert into platform_billing_accounts(user_id,stripe_account_id,livemode,stripe_customer_id)
      values($1,'acct_platform',false,'cus_a'),($2,'acct_platform',false,'cus_b'),($3,'acct_platform',false,'cus_crew')`,[A,B,CREW])
  }
  async function expire(id:string) {
    await db.query("update platform_billing_events set lease_until=clock_timestamp()-interval '1 second' where event_id=$1",[id])
    await db.query("update platform_billing_accounts set reconcile_lease_until=clock_timestamp()-interval '1 second' where reconcile_event_id=$1",[id])
  }
  async function apply(path:string) {
    const transformed=substitutePlatformStatements(read(path))
    for(const hit of transformed.hits) console.log(`Fixture substitution: ${hit}`)
    for(const statement of splitStatements(transformed.sql)) await db.exec(statement+';')
  }
  async function providerClaimed(id:string) {
    const entered=deferred<void>(), response=deferred<unknown>()
    const result=reconcile(event(id),{scope,store,readCanonicalSubscriptions:async()=>{entered.resolve();return response.promise}})
    await entered.promise
    return {response,result}
  }
  try {
    await apply('scripts/schema/platform-prelude.sql')
    for(const file of readdirSync(join(ROOT,'supabase/migrations')).filter(f=>f.endsWith('.sql')).sort()) await apply(`supabase/migrations/${file}`)
    await apply('supabase/drafts/platform-billing-b1.sql')
    await apply('supabase/drafts/platform-billing-b2.sql')
    globalThis.fetch=async()=>{throw new Error('Network forbidden in synthetic billing proof')}
    await db.query('insert into auth.users(id,email) values($1,$5),($2,$6),($3,$7),($4,$8)',[A,B,CREW,D,'a@example.test','b@example.test','crew@example.test','d@example.test'])
    await db.query("insert into business_settings(user_id,company_name,owner_name,terms_text) values($1,'Synthetic A','A','Synthetic terms'),($2,'Synthetic B','B','Synthetic terms'),($3,'Synthetic D','D','Synthetic terms')",[A,B,D])
    await reset()
    await check('B1 then B2 applies; account lease is all-or-none and positive',async()=>{
      await assert.rejects(()=>db.query("update platform_billing_accounts set reconcile_event_id='evt_partial' where user_id=$1",[A]),(e:any)=>e.code==='23514')
      await assert.rejects(()=>db.query("update platform_billing_accounts set reconcile_event_id='evt_bad',reconcile_attempt=0,reconcile_lease_until=now() where user_id=$1",[A]),(e:any)=>e.code==='23514')
    })
    await check('RPCs are invoker/service-only; owners cannot see coordination fields or events',async()=>{
      const funcs=await rows("select proname,prosecdef,proconfig,oid from pg_proc where proname=any($1::text[])",[rpcNames])
      assert.equal(funcs.length,3)
      for(const f of funcs){
        assert.equal(f.prosecdef,false);assert.ok(f.proconfig.includes('search_path=""'));assert.ok(f.proconfig.includes('lock_timeout=1s'))
        for(const role of ['anon','authenticated','service_role']) assert.equal((await one('select has_function_privilege($1,$2::oid,$3) as permitted',[role,f.oid,'EXECUTE'])).permitted,role==='service_role')
      }
      for(const role of ['anon','authenticated']) for(const name of rpcNames) {
        const fn=funcs.find(f=>f.proname===name)
        assert.equal((await one("select has_function_privilege($1,$2::oid,'EXECUTE') as permitted",[role,fn.oid])).permitted,false)
        await assert.rejects(()=>db.transaction(async(tx:any)=>{
          await tx.exec(`set local role ${role}`)
          await tx.query(`select public.${name}(${Array(name==='platform_billing_commit_event'?8:7).fill('null').join(',')})`)
        }),(e:any)=>e.code==='42501')
      }
      for(const uid of [A,B,CREW]) await db.transaction(async(tx:any)=>{
        await tx.query("select set_config('request.jwt.claim.sub',$1,true)",[uid]);await tx.exec('set local role authenticated')
        const visible=(await tx.query('select id,user_id,stripe_account_id,livemode,stripe_customer_id,created_at,updated_at from platform_billing_accounts')).rows
        assert.deepEqual(visible.map((r:any)=>r.user_id),uid===CREW?[]:[uid])
      })
      for(const column of ['reconcile_event_id','reconcile_attempt','reconcile_lease_until']) assert.equal((await one("select has_column_privilege('authenticated','platform_billing_accounts',$1,'SELECT') as permitted",[column])).permitted,false)
      await assert.rejects(()=>db.transaction(async(tx:any)=>{await tx.exec('set local role authenticated');await tx.query('select reconcile_event_id from platform_billing_accounts')}),(e:any)=>e.code==='42501')
      await assert.rejects(()=>db.transaction(async(tx:any)=>{await tx.exec('set local role authenticated');await tx.query('select * from platform_billing_accounts')}),(e:any)=>e.code==='42501')
      await assert.rejects(()=>db.transaction(async(tx:any)=>{await tx.exec('set local role authenticated');await tx.query('select * from platform_billing_events')}),(e:any)=>e.code==='42501')
    })
    await check('same merchant account, wrong platform account or mode refuse before DB/provider I/O',async()=>{
      const before=rpcCalls
      for(const [ev,s] of [[event('evt_scope'),{...scope,merchantAccountId:scope.platformAccountId}],[{...event('evt_scope'),livemode:true},scope],[{...event('evt_scope'),stripeAccountId:'acct_other'},scope]] as const) {
        assert.deepEqual(await reconcile(ev,{scope:s,store,readCanonicalSubscriptions:async()=>{throw Error('must not read')}}),{kind:'retry',code:'invalid_scope'})
      }
      assert.equal(rpcCalls,before)
    })
    await check('unknown/crew mapping stays unfinished; later trusted mapping allows retry',async()=>{
      for(const customer of ['cus_unknown','cus_crew']) {
        const result=await reconcile(event(`evt_${customer}`,'sub_new',customer),{scope,store,readCanonicalSubscriptions:async()=>{throw Error('must not read')}})
        assert.equal(result.code,'unknown_account');assert.equal((await eRow(`evt_${customer}`)).state,'received')
      }
      await db.query("insert into platform_billing_accounts(user_id,stripe_account_id,livemode,stripe_customer_id) values($1,'acct_platform',false,'cus_unknown')",[D])
      const result=await reconcile(event('evt_cus_unknown','sub_new','cus_unknown'),{scope,store,readCanonicalSubscriptions:async()=>envelope([subscription('sub_new','active','cus_unknown')],'cus_unknown')})
      assert.equal(result.kind,'processed')
    })
    await reset()
    await check('healthy reconciliation is atomic; duplicate completion performs no provider read',async()=>{
      let reads=0
      const deps={scope,store,readCanonicalSubscriptions:async()=>{reads++;return envelope([subscription()])}}
      assert.equal((await reconcile(event('evt_healthy'),deps)).kind,'processed')
      assert.equal((await eRow('evt_healthy')).state,'processed');assert.ok((await subRows())[0].last_synced_at)
      assert.equal((await aRow()).reconcile_event_id,null)
      assert.equal((await reconcile(event('evt_healthy'),deps)).kind,'already_completed');assert.equal(reads,1)
    })
    await reset()
    await check('overlapping duplicate is busy while first canonical read is held',async()=>{
      const first=await providerClaimed('evt_duplicate')
      assert.equal((await reconcile(event('evt_duplicate'),{scope,store,readCanonicalSubscriptions:async()=>{throw Error('must not read')}})).code,'busy')
      first.response.resolve(envelope([subscription()]));assert.equal((await first.result).kind,'processed')
      assert.equal((await eRow('evt_duplicate')).attempt_count,1)
    })
    await reset()
    await check('different events serialize across canonical reads and replacement preserves history',async()=>{
      const first=await providerClaimed('evt_first')
      const secondEvent={...event('evt_replacement','sub_new'),eventCreatedAt:'2020-01-01T00:00:00.000Z'}
      assert.equal((await reconcile(secondEvent,{scope,store,readCanonicalSubscriptions:async()=>{throw Error('must not read')}})).code,'busy')
      first.response.resolve(envelope([subscription()]));await first.result
      let required:string[]=[]
      const result=await reconcile(secondEvent,{scope,store,readCanonicalSubscriptions:async(request)=>{
        required=request.requiredSubscriptionIds;return envelope([subscription('sub_new'),subscription('sub_a','canceled')])
      }})
      assert.equal(result.kind,'processed');assert.deepEqual(required,['sub_a','sub_new'])
      assert.deepEqual((await subRows()).map(r=>[r.stripe_subscription_id,r.status]),[['sub_a','canceled'],['sub_new','active']])
    })
    await reset()
    await check('expired same-event attempt cannot overwrite a newer canonical reconciliation',async()=>{
      const first=await providerClaimed('evt_takeover');await expire('evt_takeover')
      const second=await providerClaimed('evt_takeover')
      first.response.resolve(envelope([subscription('sub_a','active')]))
      assert.equal((await first.result).code,'stale_attempt')
      assert.equal((await eRow('evt_takeover')).state,'processing');assert.equal((await aRow()).reconcile_attempt,2)
      assert.equal((await subRows()).length,0)
      second.response.resolve(envelope([subscription('sub_a','past_due')]))
      assert.equal((await second.result).kind,'processed')
      assert.equal((await subRows())[0].status,'past_due');assert.equal((await eRow('evt_takeover')).attempt_count,2)
      assert.equal((await eRow('evt_takeover')).state,'processed')
    })
    await reset()
    await check('expired different-event worker cannot fail or clear the newer account lease',async()=>{
      const first=await providerClaimed('evt_old');await expire('evt_old')
      const second=await providerClaimed('evt_new')
      first.response.resolve(envelope([subscription()]))
      assert.equal((await first.result).code,'stale_attempt')
      assert.equal((await aRow()).reconcile_event_id,'evt_new');assert.equal((await eRow('evt_new')).state,'processing')
      second.response.resolve(envelope([subscription('sub_a','paused')]))
      assert.equal((await second.result).kind,'processed');assert.equal((await subRows())[0].status,'paused')
    })
    await reset()
    await check('failure RPC refuses token-shaped unknown codes without persisting or releasing its lease',async()=>{
      const first=await providerClaimed('evt_error_code')
      const a=await aRow(),e=await eRow('evt_error_code')
      const result=await store.rpc('platform_billing_fail_event',{
        p_billing_account_id:a.id,p_stripe_account_id:scope.platformAccountId,p_livemode:false,
        p_stripe_customer_id:'cus_a',p_event_id:'evt_error_code',p_attempt:e.attempt_count,
        p_error_code:'sk_test_synthetic_fixture_only',
      })
      assert.equal((result.data as any).code,'invalid_error_code')
      assert.equal((await eRow('evt_error_code')).last_error_code,null)
      assert.equal((await eRow('evt_error_code')).state,'processing');assert.equal((await aRow()).reconcile_event_id,'evt_error_code')
      first.response.resolve(envelope([subscription()]));assert.equal((await first.result).kind,'processed')
    })
    await reset()
    await check('provider failure releases only its own live attempt; replay can complete',async()=>{
      const result=await reconcile(event('evt_read_failure'),{scope,store,readCanonicalSubscriptions:async()=>{throw Error('PRIVATE PROVIDER DETAIL')}})
      assert.deepEqual(result,{kind:'retry',code:'provider_read_failed'})
      assert.equal((await eRow('evt_read_failure')).state,'failed');assert.equal((await aRow()).reconcile_event_id,null)
      assert.equal((await reconcile(event('evt_read_failure'),{scope,store,readCanonicalSubscriptions:async()=>envelope([subscription()])})).kind,'processed')
      assert.equal((await eRow('evt_read_failure')).attempt_count,2)
    })
    await check('malformed, incomplete or mismatched provider state never becomes subscription state',async()=>{
      const snapshots:unknown[]=[
        {...envelope([subscription()]),complete:false},envelope([]),{...envelope([subscription()]),stripeAccountId:'acct_other'},
        {...envelope([subscription()]),livemode:true},envelope([{...subscription(),stripeCustomerId:'cus_b'}]),
        envelope([{...subscription(),status:'future_status' as any}]),envelope([{...subscription(),trialStart:'2030-02-02T00:00:00Z',trialEnd:'2030-02-01T00:00:00Z'}]),
        envelope([subscription(),subscription('sub_extra')]),envelope([{...subscription(),cancelAtPeriodEnd:undefined as any}]),
      ]
      for(let i=0;i<snapshots.length;i++) {
        await reset()
        assert.equal((await reconcile(event(`evt_bad_${i}`),{scope,store,readCanonicalSubscriptions:async()=>snapshots[i]})).code,'invalid_snapshot')
        assert.equal((await subRows()).length,0);assert.equal((await eRow(`evt_bad_${i}`)).state,'failed')
      }
    })
    await reset()
    await check('missing known nonterminal ID refuses replacement, even with complete=true',async()=>{
      await reconcile(event('evt_seed'),{scope,store,readCanonicalSubscriptions:async()=>envelope([subscription()])})
      assert.equal((await reconcile(event('evt_incomplete','sub_new'),{scope,store,readCanonicalSubscriptions:async()=>envelope([subscription('sub_new')])})).code,'invalid_snapshot')
      assert.deepEqual((await subRows()).map(r=>r.status),['active'])
    })
    await reset()
    await check('late cross-account mapping conflict rolls back earlier terminal update and completion',async()=>{
      await reconcile(event('evt_seed'),{scope,store,readCanonicalSubscriptions:async()=>envelope([subscription()])})
      await reconcile(event('evt_b_seed','sub_b','cus_b'),{scope,store,readCanonicalSubscriptions:async()=>envelope([subscription('sub_b','active','cus_b')],'cus_b')})
      const before=await subRows()
      const result=await reconcile(event('evt_collision','sub_new'),{scope,store,readCanonicalSubscriptions:async()=>envelope([
        subscription('sub_a','canceled'),subscription('sub_b','canceled'),subscription('sub_new'),
      ])})
      assert.equal(result.code,'commit_failed');assert.deepEqual(await subRows(),before)
      assert.equal((await eRow('evt_collision')).state,'failed');assert.equal((await one("select user_id from platform_subscriptions where stripe_subscription_id='sub_b'")).user_id,B)
    })
    await reset()
    await check('failure at the event-completion write rolls back all subscription changes; retry completes once',async()=>{
      await db.exec(`create function public.synthetic_reject_completion() returns trigger language plpgsql as $$ begin
        if new.state='processed' then raise exception 'synthetic_completion_failure';end if;return new;end;$$;
        create trigger synthetic_reject_completion before update on public.platform_billing_events for each row execute function public.synthetic_reject_completion();`)
      const result=await reconcile(event('evt_atomic'),{scope,store,readCanonicalSubscriptions:async()=>envelope([subscription()])})
      assert.equal(result.code,'commit_failed');assert.equal((await subRows()).length,0);assert.equal((await eRow('evt_atomic')).state,'failed')
      await db.exec('drop trigger synthetic_reject_completion on public.platform_billing_events;drop function public.synthetic_reject_completion();')
      assert.equal((await reconcile(event('evt_atomic'),{scope,store,readCanonicalSubscriptions:async()=>envelope([subscription()])})).kind,'processed')
      assert.equal((await subRows()).length,1);assert.equal((await eRow('evt_atomic')).attempt_count,2)
    })
    await reset()
    await check('lease expiring during the subscription write rolls back the whole transaction',async()=>{
      await db.exec(`create function public.synthetic_expire_lease() returns trigger language plpgsql as $$ begin
        update public.platform_billing_accounts set reconcile_lease_until=clock_timestamp()-interval '1 second' where id=new.billing_account_id;return new;end;$$;
        create trigger synthetic_expire_lease after insert or update on public.platform_subscriptions for each row execute function public.synthetic_expire_lease();`)
      const result=await reconcile(event('evt_late_expiry'),{scope,store,readCanonicalSubscriptions:async()=>envelope([subscription()])})
      assert.equal(result.code,'commit_failed');assert.equal((await subRows()).length,0);assert.equal((await eRow('evt_late_expiry')).state,'failed')
      await db.exec('drop trigger synthetic_expire_lease on public.platform_subscriptions;drop function public.synthetic_expire_lease();')
    })
    console.log(`\n${passed} passed; 0 failed. Actual draft RPC/core interleavings in disposable PostgreSQL; no live I/O or multi-backend lock-wait claim.`)
  } finally {await db.close()}
}
main().catch(error=>{console.error(error);process.exitCode=1})
