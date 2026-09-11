import assert from 'node:assert/strict'
import { buildSync } from 'esbuild'
import type { TestResult } from './database'
import { acceptanceCallerFixture, acceptanceCallerOwner, acceptanceCallerId } from './acceptance-caller-fixtures'
import { buildPilotAcceptanceCommitRequest, parsePilotAcceptancePreviewRequest, parsePilotAcceptanceCommitRequest,
  parsePilotAcceptancePreview, parsePilotAcceptanceCommitReply, canFitPilotAcceptanceCommit, PILOT_ACCEPTANCE_NATIVE_REFUSALS } from '../../src/lib/quotes/pilotQuoteAcceptance'
import { previewQuoteAcceptance, commitQuoteAcceptance, reconcileQuoteAcceptance, createPilotQuoteAcceptanceStore,
  type PilotQuoteAcceptanceStore } from '../../src/lib/quotes/pilotQuoteAcceptanceServer'
import type { SupabaseClient } from '@supabase/supabase-js'
import type { PilotQuoteIdentityAuth } from '../../src/lib/quotes/pilotQuoteSave'
type Row=Record<string,unknown>
export const acceptanceCallerServerEvidence:Row[]=[]
const origin='https://acceptance-caller.fixture.example.invalid'
const http=(value:unknown,init:RequestInit={})=>new Request(origin+'/dormant',{method:'POST',headers:{origin,'content-type':'application/json'},body:JSON.stringify(value),...init})
function harness(portal=false) {
  const f=acceptanceCallerFixture(portal),request=buildPilotAcceptanceCommitRequest(f.request,f.expected,f.choice),calls:string[]=[]
  const auth:PilotQuoteIdentityAuth={async getUser(){calls.push('auth');return {data:{user:{id:acceptanceCallerOwner}},error:null}}}
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
  await test('owner uses one verified auth and one native RPC per action; portal never borrows session authority',async()=>{
    for(const portal of [false,true]){const h=harness(portal),p=await previewQuoteAcceptance(h.store,h.auth,http(h.request),h.options)
      assert.equal(p.status,400,'A commit body cannot be used as a preview request');assert.deepEqual(h.calls,[])
      const preview=await previewQuoteAcceptance(h.store,h.auth,http(acceptanceCallerFixture(portal).request),h.options);assert.ok(parsePilotAcceptancePreview(await preview.json(),acceptanceCallerFixture(portal).request))
      const result=await commitQuoteAcceptance(h.store,h.auth,http(h.request),h.options);assert.equal(result.headers.get('cache-control'),'no-store')
      assert.ok(parsePilotAcceptanceCommitReply(await result.json(),h.request,portal?undefined:acceptanceCallerOwner))
      assert.deepEqual(h.calls,portal?['preview','commit']:['auth','preview','auth','commit'])
    }
  })
  await test('origin, method, media, encoding, oversized, malformed body fail before authority or writes',async()=>{
    for(const init of [{method:'GET',body:undefined},{headers:{origin:'https://foreign.invalid','content-type':'application/json'}},
      {headers:{origin,'content-type':'text/plain'}},{headers:{origin,'content-type':'application/json','content-encoding':'gzip'}},
      {headers:{origin,'content-type':'application/json','content-length':'200001'}},{body:'{'}] as RequestInit[]){const h=harness();const r=await commitQuoteAcceptance(h.store,h.auth,http(h.request,init),h.options);assert.ok(r.status>=400);assert.deepEqual(h.calls,[])}
  })
  await test('auth failure is a correlated pre-dispatch refusal; owner ID body never grants authority',async()=>{
    const h=harness();h.auth.getUser=async()=>({data:{user:null},error:null})
    const r=await commitQuoteAcceptance(h.store,h.auth,http(h.request),h.options);const raw=await r.json();assert.equal(raw.reason,'unauthenticated');assert.equal(raw.clientOperationId,h.request.clientOperationId);assert.deepEqual(h.calls,[])
  })
  await test('only exact six native pre-DML return objects are known refusals',async()=>{
    for(const code of PILOT_ACCEPTANCE_NATIVE_REFUSALS){const h=harness();h.store.commit=async()=>({code});const r=await commitQuoteAcceptance(h.store,h.auth,http(h.request),h.options)
      assert.deepEqual(await r.json(),{code:'refused',clientOperationId:h.request.clientOperationId,previewRevision:h.expected.previewRevision,reason:code})}
    for(const raw of [{code:'quote_changed',private:'SECRET'},{code:'unknown_code'},null,{code:'accepted'}]){const h=harness();h.store.commit=async()=>raw;assert.equal((await (await commitQuoteAcceptance(h.store,h.auth,http(h.request),h.options)).json()).code,'unknown')}
  })
  await test('lost, thrown and late commit replies stay unknown without automatic reconciliation or replay',async()=>{
    for(const late of [false,true]){const h=harness();h.store.commit=async()=>{h.calls.push('commit');if(late){await new Promise(r=>setTimeout(r,20));return h.receipt}throw Error('PRIVATE_SECRET_DB_ERROR')}
      const response=await commitQuoteAcceptance(h.store,h.auth,http(h.request),{...h.options,operationTimeoutMs:5});assert.equal((await response.json()).code,'unknown');assert.deepEqual(h.calls,['auth','commit'])}
  })
  await test('reconciliation remains unknown even if an injected store incorrectly returns accepted',async()=>{
    const h=harness();h.store.reconcile=async()=>{h.calls.push('reconcile');return h.receipt}
    const raw=await (await reconcileQuoteAcceptance(h.store,h.auth,http(h.request),h.options)).json();assert.equal(raw.code,'unknown');assert.deepEqual(h.calls,['auth','reconcile'])
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
    assert.equal(Object.keys(b.metafile!.inputs).some(x=>/AcceptanceServer|SaveHttp|SavePlan/.test(x)),false)
    acceptanceCallerServerEvidence.push({kind:'browser-wire-bundle',serverModules:false})
  })
  return tests
}
