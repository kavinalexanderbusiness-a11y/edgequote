import assert from 'node:assert/strict'
import { buildSync } from 'esbuild'
import type { TestResult } from './database'
import { acceptanceCallerFixture, acceptanceCallerOwner, acceptanceCallerId } from './acceptance-caller-fixtures'
import { buildPilotAcceptanceCommitRequest, parsePilotAcceptancePreviewRequest, parsePilotAcceptanceCommitRequest,
  parsePilotAcceptancePreview, parsePilotAcceptanceCommitReply, canFitPilotAcceptanceCommit, PILOT_ACCEPTANCE_NATIVE_REFUSALS } from '../../src/lib/quotes/pilotQuoteAcceptance'
import { previewQuoteAcceptance, commitQuoteAcceptance, reconcileQuoteAcceptance, createPilotQuoteAcceptanceStore,
  type PilotQuoteAcceptanceStore } from '../../src/lib/quotes/pilotQuoteAcceptanceServer'
import type { SupabaseClient } from '@supabase/supabase-js'
import type { PilotQuoteSaveAuth } from '../../src/lib/quotes/pilotQuoteSaveAuth'
import { PilotQuoteSaveHttpRefusal } from '../../src/lib/quotes/pilotQuoteSaveHttp'
type Row=Record<string,unknown>
export const acceptanceCallerServerEvidence:Row[]=[]
const origin='https://acceptance-caller.fixture.example.invalid'
const http=(value:unknown,init:RequestInit={})=>new Request(origin+'/dormant',{method:'POST',headers:{origin,'content-type':'application/json'},body:JSON.stringify(value),...init})
function harness(portal=false) {
  const f=acceptanceCallerFixture(portal),request=buildPilotAcceptanceCommitRequest(f.request,f.expected,f.choice),calls:string[]=[]
  // Synthetic authority contract only; real Auth and the SQL-bound role RPC are
  // covered by the separate disposable platform prerequisite.
  const auth:PilotQuoteSaveAuth={async getUser(){calls.push('auth');return {data:{user:{id:acceptanceCallerOwner}},error:null}},
    async readOwnerRole(expectedOwner,signal){calls.push('role');assert.equal(expectedOwner,acceptanceCallerOwner);assert.equal(signal.aborted,false)
      return {data:{owner_id:expectedOwner,role:'owner'},error:null}}}
  const store:PilotQuoteAcceptanceStore={async preview(a,r,s){calls.push('preview');assert.equal(a.owner,portal?null:acceptanceCallerOwner);assert.equal(s.aborted,false);assert.equal(r.quoteId,request.quoteId);return {code:'preview',expected:f.expected}},
    async commit(a,r,s){calls.push('commit');assert.equal(s.aborted,false);assert.deepEqual(r,request);return f.receipt},async reconcile(){calls.push('reconcile');return {code:'unknown'}}}
  const options={trustedOrigin:origin,bodyTimeoutMs:1000,operationTimeoutMs:1000}
  return {...f,request,calls,auth,store,options}
}
export async function runAcceptanceCallerServerCases():Promise<TestResult[]> {
  const tests:TestResult[]=[];acceptanceCallerServerEvidence.length=0
  const test=async(name:string,work:()=>unknown|Promise<unknown>)=>{try{await work();tests.push({name:'Acceptance caller: '+name,pass:true})}
    catch(error){tests.push({name:'Acceptance caller: '+name,pass:false,error:error instanceof Error?error.message.slice(0,1400):'Caller assertion failed'})}}
  await test('strict request modes, exact selected set and immutable numeric/null document',()=>{
    for(const portal of [false,true]){const f=acceptanceCallerFixture(portal),before=JSON.stringify(f.expected),r=buildPilotAcceptanceCommitRequest(f.request,f.expected,f.choice)
      assert.deepEqual(parsePilotAcceptanceCommitRequest(JSON.stringify(r)),r);assert.equal(JSON.stringify(f.expected),before)
      for(const changed of [{...r,ownerId:acceptanceCallerOwner},{...r,addonIds:[]},{...r,addonIds:[...r.addonIds,...r.addonIds]},
        {...r,termsAck:null},{...r,expected:{...r.expected,previewRevision:'bad'}},{...r,reason:portal?'phone':'invalid'}])assert.throws(()=>parsePilotAcceptanceCommitRequest(changed))
      if(portal)assert.throws(()=>parsePilotAcceptanceCommitRequest({...r,note:'Forged owner note'}))
    }
    assert.throws(()=>parsePilotAcceptancePreviewRequest({...acceptanceCallerFixture().request,portalToken:null}))
  })
  await test('complete preview shape rejects missing/private fields and inconsistent child order without getters',()=>{
    const f=acceptanceCallerFixture(),good={code:'preview',expected:f.expected};assert.ok(parsePilotAcceptancePreview(good,f.request))
    for(const key of Object.keys(f.expected.offered.public)){const e=structuredClone(f.expected);delete (e.offered.public as unknown as Row)[key];assert.equal(parsePilotAcceptancePreview({code:'preview',expected:e},f.request),null)}
    for(const field of ['internal_notes','no_charge_reason','token','terms_payment_claim'])assert.equal(parsePilotAcceptancePreview({code:'preview',expected:{...f.expected,offered:{...f.expected.offered,public:{...f.expected.offered.public,[field]:'PRIVATE'}}}},f.request),null)
    let invoked=false;const hidden={...good};Object.defineProperty(hidden,'toJSON',{get(){invoked=true;return ()=>good}})
    assert.equal(parsePilotAcceptancePreview(hidden,f.request),null);assert.equal(invoked,false)
    const poisoned={...f.expected};Object.defineProperty(poisoned,'offered',{get(){invoked=true;return f.expected.offered}})
    assert.equal(canFitPilotAcceptanceCommit(f.request,poisoned),false);assert.equal(invoked,false)
    const p=structuredClone(f.expected);p.offered.public.addons.push({...p.offered.public.addons[0]});assert.equal(parsePilotAcceptancePreview({code:'preview',expected:p},f.request),null)
    for(const portal of [false,true])for(const status of ['draft','sent','accepted','completed']){
      const mode=acceptanceCallerFixture(portal),e=structuredClone(mode.expected);(e.offered.public as unknown as Row).status=status
      assert.equal(parsePilotAcceptancePreview({code:'preview',expected:e},mode.request)!==null,status==='sent'||!portal&&status==='draft')
    }
  })
  await test('zero, unpriced null and declared no-charge stay distinct without amount arithmetic',()=>{
    const f=acceptanceCallerFixture()
    for(const base of [null,0])for(const declared of [false,true]){const e=structuredClone(f.expected);Object.assign(e.offered.public,{initial_price:base,accepted_amount:0,no_charge:declared})
      const p=parsePilotAcceptancePreview({code:'preview',expected:e},f.request);assert.equal(p?.code,'preview');if(p?.code==='preview'){assert.equal(p.expected.offered.public.initial_price,base);assert.equal(p.expected.offered.public.no_charge,declared);assert.equal(p.expected.offered.public.accepted_amount,0)}}
    const e=structuredClone(f.expected);(e.offered.public as unknown as Row).accepted_amount=null;assert.equal(parsePilotAcceptancePreview({code:'preview',expected:e},f.request),null)
  })
  await test('future commit cap reserves actual token and required metadata; optional note is never truncated',()=>{
    const f=acceptanceCallerFixture(true);f.request.portalToken='é'.repeat(5000);assert.ok(parsePilotAcceptancePreviewRequest(f.request))
    assert.throws(()=>parsePilotAcceptancePreviewRequest({...f.request,portalToken:'é'.repeat(5001)}))
    const r=buildPilotAcceptanceCommitRequest(f.request,f.expected,f.choice);const spare=200000-new TextEncoder().encode(JSON.stringify(r)).length
    f.expected.offered.public.notes='x'.repeat(spare+f.expected.offered.public.notes!.length)
    assert.equal(canFitPilotAcceptanceCommit(f.request,f.expected),false,'false boolean reserve is one byte wider than true')
    f.expected.offered.public.notes=f.expected.offered.public.notes.slice(0,-1);assert.equal(canFitPilotAcceptanceCommit(f.request,f.expected),true)
    f.expected.offered.public.notes+='x';assert.equal(parsePilotAcceptancePreview({code:'preview',expected:f.expected},f.request),null)
    const owner=acceptanceCallerFixture(),large={...owner.choice,note:'é'.repeat(100001)};assert.throws(()=>buildPilotAcceptanceCommitRequest(owner.request,owner.expected,large),{code:'request_too_large'})
  })
  await test('strict receipt binds every correlation, monetary, identity, sequence and selected-set field',()=>{
    const h=harness(),good={code:'accepted',clientOperationId:h.request.clientOperationId,previewRevision:h.expected.previewRevision,receipt:h.receipt}
    assert.ok(parsePilotAcceptanceCommitReply(good,h.request,acceptanceCallerOwner))
    for(const changes of [{accepted_amount:999},{actor_id:acceptanceCallerId(99)},{acceptance_seq:2},{previous_acceptance_id:acceptanceCallerId(99)},
      {quote_id:acceptanceCallerId(99)},{selected_option_id:acceptanceCallerId(99)},{addon_ids:[]},{document_fingerprint:null},{terms_fingerprint:'bad'},{extra:'PRIVATE'},
      {kind:'customer'},{source:'portal'}])assert.equal(parsePilotAcceptanceCommitReply({...good,receipt:{...h.receipt,...changes}},h.request,acceptanceCallerOwner),null)
    assert.equal(parsePilotAcceptanceCommitReply({...good,clientOperationId:acceptanceCallerId(9)},h.request,acceptanceCallerOwner),null)
    assert.equal(parsePilotAcceptanceCommitReply({...good,previewRevision:'d'.repeat(32)},h.request,acceptanceCallerOwner),null)
    const portal=harness(true);assert.ok(parsePilotAcceptanceCommitReply({...good,receipt:portal.receipt},portal.request))
    assert.equal(parsePilotAcceptanceCommitReply({...good,receipt:{...portal.receipt,actor_id:acceptanceCallerId(99)}},portal.request),null)
  })
  await test('owner verifies identity and bound role before each native action; portal never borrows session authority',async()=>{
    for(const portal of [false,true]){const h=harness(portal),p=await previewQuoteAcceptance(h.store,h.auth,http(h.request),h.options)
      assert.equal(p.status,400,'A commit body cannot be used as a preview request');assert.deepEqual(h.calls,[])
      if(portal){h.auth.getUser=async()=>{throw Error('Portal must not read session identity')};h.auth.readOwnerRole=async()=>{throw Error('Portal must not read session role')}}
      const preview=await previewQuoteAcceptance(h.store,h.auth,http(acceptanceCallerFixture(portal).request),h.options);assert.ok(parsePilotAcceptancePreview(await preview.json(),acceptanceCallerFixture(portal).request))
      const result=await commitQuoteAcceptance(h.store,h.auth,http(h.request),h.options);assert.equal(result.headers.get('cache-control'),'no-store')
      assert.ok(parsePilotAcceptanceCommitReply(await result.json(),h.request,portal?undefined:acceptanceCallerOwner))
      assert.deepEqual(h.calls,portal?['preview','commit']:['auth','role','preview','auth','role','commit'])
      if(portal){const result=await reconcileQuoteAcceptance(h.store,h.auth,http(h.request),h.options);assert.equal((await result.json()).code,'unknown');assert.deepEqual(h.calls,['preview','commit','reconcile'])}
    }
  })
  await test('origin, method, media, encoding, oversized, malformed body fail before authority or writes',async()=>{
    for(const init of [{method:'GET',body:undefined},{headers:{origin:'https://foreign.invalid','content-type':'application/json'}},
      {headers:{origin,'content-type':'text/plain'}},{headers:{origin,'content-type':'application/json','content-encoding':'gzip'}},
      {headers:{origin,'content-type':'application/json','content-length':'200001'}},{body:'{'}] as RequestInit[]){const h=harness();const r=await commitQuoteAcceptance(h.store,h.auth,http(h.request,init),h.options);assert.ok(r.status>=400);assert.deepEqual(h.calls,[])}
  })
  await test('auth failure is a correlated pre-dispatch refusal; owner ID body never grants authority',async()=>{
    for(const mode of ['preview','commit'] as const){const h=harness();h.auth.getUser=async()=>({data:{user:null},error:null})
      const r=await (mode==='preview'?previewQuoteAcceptance(h.store,h.auth,http(acceptanceCallerFixture().request),h.options):commitQuoteAcceptance(h.store,h.auth,http(h.request),h.options))
      const raw=await r.json();assert.equal(r.status,401);assert.equal(raw.reason,'unauthenticated')
      if(mode==='commit')assert.equal(raw.clientOperationId,h.request.clientOperationId);assert.deepEqual(h.calls,[])
    }
  })
  for(const [label,data,reason,status] of [
    ['none',{owner_id:acceptanceCallerOwner,role:'none'},'forbidden',403],
    ['crew',{owner_id:acceptanceCallerOwner,role:'crew'},'forbidden',403],
    ['bound denial',{code:'forbidden'},'forbidden',403],
    ['different identity',{owner_id:acceptanceCallerId(99),role:'owner'},'unavailable',503],
    ['unknown role',{owner_id:acceptanceCallerOwner,role:'admin'},'unavailable',503],
    ['malformed role',{role:'owner'},'unavailable',503],
    ['extra role fields',{owner_id:acceptanceCallerOwner,role:'owner',extra:true},'unavailable',503],
  ] as const)await test('synthetic owner '+label+' refuses preview and commit before store dispatch',async()=>{
    for(const mode of ['preview','commit'] as const){const h=harness();h.auth.readOwnerRole=async(expectedOwner,signal)=>{
      h.calls.push('role');assert.equal(expectedOwner,acceptanceCallerOwner);assert.equal(signal.aborted,false);return {data,error:null}}
      const response=await (mode==='preview'?previewQuoteAcceptance(h.store,h.auth,http(acceptanceCallerFixture().request),h.options):commitQuoteAcceptance(h.store,h.auth,http(h.request),h.options))
      const raw=await response.json();assert.equal(response.status,status);assert.equal(response.headers.get('cache-control'),'no-store')
      assert.deepEqual(raw,{code:'refused',...(mode==='commit'?{clientOperationId:h.request.clientOperationId,previewRevision:h.expected.previewRevision}:{}),reason})
      assert.ok(mode==='preview'?parsePilotAcceptancePreview(raw,acceptanceCallerFixture().request):parsePilotAcceptanceCommitReply(raw,h.request,acceptanceCallerOwner))
      assert.deepEqual(h.calls,['auth','role'])
    }
    acceptanceCallerServerEvidence.push({kind:'synthetic-owner-authority',case:label,status,reason,storeCalls:0})
  })
  await test('missing capability, role errors and empty results are unavailable before store dispatch',async()=>{
    for(const failure of ['missing','error','throw','empty'] as const)for(const mode of ['preview','commit'] as const){const h=harness()
      if(failure==='missing')Reflect.deleteProperty(h.auth,'readOwnerRole')
      else h.auth.readOwnerRole=async()=>{h.calls.push('role');if(failure==='throw')throw Error('PRIVATE_ROLE_ERROR')
        return {data:failure==='error'?{owner_id:acceptanceCallerOwner,role:'owner'}:null,error:failure==='error'?Error('PRIVATE_ROLE_ERROR'):null}}
      const response=await (mode==='preview'?previewQuoteAcceptance(h.store,h.auth,http(acceptanceCallerFixture().request),h.options):commitQuoteAcceptance(h.store,h.auth,http(h.request),h.options))
      const raw=await response.json();assert.equal(response.status,503);assert.equal(raw.code,'refused');assert.equal(raw.reason,'unavailable');assert.equal(JSON.stringify(raw).includes('PRIVATE'),false)
      if(mode==='commit')assert.equal(raw.clientOperationId,h.request.clientOperationId)
      assert.deepEqual(h.calls,failure==='missing'?['auth']:['auth','role'])
    }
  })
  await test('role timeout and cancellation refuse before dispatch and abort the role read',async()=>{
    for(const cancelled of [false,true])for(const mode of ['preview','commit'] as const){const h=harness(),abort=new AbortController();let roleSignal:AbortSignal|undefined
      h.auth.readOwnerRole=async(_owner,signal)=>{h.calls.push('role');roleSignal=signal;if(cancelled)abort.abort();return new Promise(()=>{})}
      const request=http(mode==='preview'?acceptanceCallerFixture().request:h.request,{signal:abort.signal}),options={...h.options,operationTimeoutMs:5}
      const response=await (mode==='preview'?previewQuoteAcceptance(h.store,h.auth,request,options):commitQuoteAcceptance(h.store,h.auth,request,options))
      assert.equal(response.status,503);const raw=await response.json();assert.equal(raw.code,'refused');assert.equal(raw.reason,'unavailable');assert.equal(roleSignal?.aborted,true);assert.deepEqual(h.calls,['auth','role'])
    }
  })
  await test('owner role is read again at commit after an earlier authorized preview',async()=>{
    const h=harness();const p=await previewQuoteAcceptance(h.store,h.auth,http(acceptanceCallerFixture().request),h.options);assert.equal(p.status,200)
    h.auth.readOwnerRole=async()=>{h.calls.push('role');return {data:{owner_id:acceptanceCallerOwner,role:'none'},error:null}}
    const response=await commitQuoteAcceptance(h.store,h.auth,http(h.request),h.options);assert.equal(response.status,403);assert.equal((await response.json()).reason,'forbidden')
    assert.deepEqual(h.calls,['auth','role','preview','auth','role'])
  })
  await test('only exact native pre-DML return objects are known refusals, including forbidden403',async()=>{
    for(const code of PILOT_ACCEPTANCE_NATIVE_REFUSALS){const h=harness();h.store.commit=async()=>({code});const r=await commitQuoteAcceptance(h.store,h.auth,http(h.request),h.options)
      if(code==='forbidden')assert.equal(r.status,403)
      assert.deepEqual(await r.json(),{code:'refused',clientOperationId:h.request.clientOperationId,previewRevision:h.expected.previewRevision,reason:code})}
    const denied=harness();denied.store.preview=async()=>({code:'forbidden'});const p=await previewQuoteAcceptance(denied.store,denied.auth,http(acceptanceCallerFixture().request),denied.options)
    assert.equal(p.status,403);assert.deepEqual(await p.json(),{code:'refused',reason:'forbidden'})
    for(const raw of [{code:'quote_changed',private:'SECRET'},{code:'forbidden',private:'SECRET'},{code:'unknown_code'},null,{code:'accepted'}]){const h=harness();h.store.commit=async()=>raw;assert.equal((await (await commitQuoteAcceptance(h.store,h.auth,http(h.request),h.options)).json()).code,'unknown')}
  })
  await test('lost, thrown and late commit replies stay unknown without automatic reconciliation or replay',async()=>{
    for(const late of [false,true]){const h=harness();h.store.commit=async()=>{h.calls.push('commit');if(late){await new Promise(r=>setTimeout(r,20));return h.receipt}throw Error('PRIVATE_SECRET_DB_ERROR')}
      const response=await commitQuoteAcceptance(h.store,h.auth,http(h.request),{...h.options,operationTimeoutMs:5});assert.equal((await response.json()).code,'unknown');assert.deepEqual(h.calls,['auth','role','commit'])}
    const h=harness();h.store.commit=async()=>{h.calls.push('commit');throw new PilotQuoteSaveHttpRefusal('forbidden',403)}
    const response=await commitQuoteAcceptance(h.store,h.auth,http(h.request),h.options);assert.equal(response.status,503);assert.equal((await response.json()).code,'unknown');assert.deepEqual(h.calls,['auth','role','commit'])
  })
  await test('reconciliation remains unknown even if an injected store incorrectly returns accepted',async()=>{
    const h=harness();h.store.reconcile=async()=>{h.calls.push('reconcile');return h.receipt}
    const raw=await (await reconcileQuoteAcceptance(h.store,h.auth,http(h.request),h.options)).json();assert.equal(raw.code,'unknown');assert.deepEqual(h.calls,['auth','role','reconcile'])
  })
  await test('reconciliation authority denial cannot settle an earlier unknown write',async()=>{
    for(const failure of ['unauthenticated','none','crew','unavailable','native-forbidden'] as const){const h=harness()
      if(failure==='unauthenticated')h.auth.getUser=async()=>{h.calls.push('auth');return {data:{user:null},error:null}}
      else if(failure!=='native-forbidden')h.auth.readOwnerRole=async()=>{h.calls.push('role');return failure==='unavailable'?{data:null,error:Error('PRIVATE_ROLE_ERROR')}:{data:{owner_id:acceptanceCallerOwner,role:failure},error:null}}
      else h.store.reconcile=async()=>{h.calls.push('reconcile');return {code:'forbidden'}}
      const response=await reconcileQuoteAcceptance(h.store,h.auth,http(h.request),h.options);assert.equal(response.status,503)
      assert.deepEqual(await response.json(),{code:'unknown',clientOperationId:h.request.clientOperationId,previewRevision:h.expected.previewRevision})
      assert.deepEqual(h.calls,failure==='unauthenticated'?['auth']:failure==='native-forbidden'?['auth','role','reconcile']:['auth','role'])
    }
  })
  await test('Supabase adapter emits exact native signatures, no operation metadata or extra write',async()=>{
    const calls:{name:string;args:Row}[]=[],h=harness(true)
    const sb={rpc(name:string,args:Row){calls.push({name,args});return {async abortSignal(signal:AbortSignal){
      assert.equal(signal.aborted,false);return {data:{code:'unknown'},error:null}
    }}}} as unknown as SupabaseClient
    const store=createPilotQuoteAcceptanceStore(sb),a={owner:null,portalToken:h.request.portalToken!},signal=new AbortController().signal
    await store.preview(a,h.request,signal);await store.commit(a,h.request,signal);await store.reconcile(a,h.request,signal)
    assert.deepEqual(calls.map(c=>c.name),['pilot_quote_acceptance_preview','pilot_quote_acceptance_commit','pilot_quote_acceptance_reconcile'])
    assert.deepEqual(Object.keys(calls[0].args).sort(),['p_option','p_owner','p_portal_token','p_quote'])
    assert.deepEqual(Object.keys(calls[1].args).sort(),['p_addons','p_expected','p_note','p_option','p_owner','p_portal_token','p_quote','p_reason','p_terms_ack'])
    assert.deepEqual(Object.keys(calls[2].args).sort(),['p_addons','p_expected','p_note','p_option','p_owner','p_portal_token','p_quote','p_reason'])
  })
  await test('browser wire module bundles without server or Node runtime',()=>{
    const b=buildSync({entryPoints:['src/lib/quotes/pilotQuoteAcceptance.ts'],bundle:true,write:false,platform:'browser',format:'esm',metafile:true,logLevel:'silent'})
    assert.equal(Object.keys(b.metafile!.inputs).some(x=>/AcceptanceServer|SaveAuth|SaveHttp|SavePlan/.test(x)),false)
    acceptanceCallerServerEvidence.push({kind:'browser-wire-bundle',serverModules:false})
  })
  return tests
}
