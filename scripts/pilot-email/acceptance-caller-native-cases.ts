import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import type { SupabaseClient } from '@supabase/supabase-js'
import type { Database, TestResult } from './database'
import { identityRows, identityValue, seedQuoteIdentity } from './quote-identity-fixtures'
import { termsClaimPatch } from '../../src/lib/payments/termsTimingConflict'
import { buildPilotAcceptanceCommitRequest, parsePilotAcceptancePreview, parsePilotAcceptanceCommitReply,
  type PilotAcceptancePreviewRequest, type PilotAcceptanceExpected, type PilotAcceptanceReceipt } from '../../src/lib/quotes/pilotQuoteAcceptance'
import { createPilotQuoteAcceptanceStore, previewQuoteAcceptance, commitQuoteAcceptance, reconcileQuoteAcceptance } from '../../src/lib/quotes/pilotQuoteAcceptanceServer'
import type { PilotQuoteSaveAuth } from '../../src/lib/quotes/pilotQuoteSaveAuth'

// Cloud-only bridge: synthetic verified Auth/Request, real service-only SQL.
// Owner role reads use the real bound-role RPC under the privileged fixture
// session with synthetic JWT claims; this is not an authenticated ACL proof.
// All fixture setup/write cases are outer ROLLBACK transactions. No new session
// is opened; there is no browser/PostgREST or durable-COMMIT claim here.
type Row=Record<string,unknown>
export type AcceptanceCallerResponseFixture={name:string;mode:'portal'|'owner';ownerId:string;quoteId:string;optionId:string|null;
  previewResponse:{code:'preview';expected:PilotAcceptanceExpected};commitResponse:{code:'accepted';clientOperationId:string;previewRevision:string;receipt:PilotAcceptanceReceipt};
  reason:'text_message'|null;note:string|null;termsAck:boolean}
export const acceptanceCallerResponseFixtures:AcceptanceCallerResponseFixture[]=[]
export const acceptanceCallerNativeEvidence:Row[]=[]
const origin='https://acceptance-native.fixture.example.invalid'
const hash=(value:unknown)=>createHash('sha256').update(JSON.stringify(value)).digest('hex')
const request=(value:unknown)=>new Request(origin+'/dormant',{method:'POST',headers:{origin,'content-type':'application/json'},body:JSON.stringify(value)})
async function rows(db:Database,owner:string){const result=await identityRows(db,owner)
  for(const table of ['business_settings','pricing_config_versions','property_measurements','property_measurement_events','quote_acceptances'])
    result[table]=(await db.query<{row:Row}>(`select to_jsonb(t) as row from public.${table} t where user_id=$1::uuid order by to_jsonb(t)::text`,[owner])).rows.map(r=>r.row)
  return result}
function bridge(db:Database,loseCommit=false) {
  const calls:string[]=[],receipts:unknown[]=[]
  const sb={rpc(name:string,args:Row){return {async abortSignal(signal:AbortSignal){
    assert.equal(signal.aborted,false);assert.ok(['pilot_quote_acceptance_preview','pilot_quote_acceptance_commit','pilot_quote_acceptance_reconcile'].includes(name))
    calls.push(name);await db.exec('savepoint acceptance_caller_transport; set local role service_role')
    try {
      const context=await identityValue(db,`select jsonb_build_object('role',current_user,'sub',nullif(current_setting('request.jwt.claim.sub',true),''),
        'claims_sub',nullif(current_setting('request.jwt.claims',true),'')::jsonb->>'sub') as value`)
      assert.deepEqual(context,{role:'service_role',sub:null,claims_sub:null})
      let result:unknown
      if(name==='pilot_quote_acceptance_preview'){
        assert.deepEqual(Object.keys(args).sort(),['p_option','p_owner','p_portal_token','p_quote'])
        result=await identityValue(db,'select public.pilot_quote_acceptance_preview($1::uuid,$2,$3::uuid,$4::uuid) as value',[args.p_owner,args.p_portal_token,args.p_quote,args.p_option])
      } else {
        const keys=['p_addons','p_expected','p_note','p_option','p_owner','p_portal_token','p_quote','p_reason',...(name==='pilot_quote_acceptance_commit'?['p_terms_ack']:[])].sort()
        assert.deepEqual(Object.keys(args).sort(),keys)
        const params=[args.p_owner,args.p_portal_token,args.p_quote,JSON.stringify(args.p_expected),args.p_option,'{'+(args.p_addons as string[]).join(',')+'}',args.p_reason,args.p_note]
        if(name==='pilot_quote_acceptance_commit')params.push(args.p_terms_ack)
        result=await identityValue(db,`select public.${name}($1::uuid,$2,$3::uuid,$4::jsonb,$5::uuid,$6::uuid[],$7,$8${name==='pilot_quote_acceptance_commit'?',$9::boolean':''}) as value`,params)
      }
      await db.exec('reset role; release savepoint acceptance_caller_transport')
      if(name==='pilot_quote_acceptance_commit'){receipts.push(result);if(loseCommit)throw Error('Synthetic loss after actual RPC write; outer fixture remains uncommitted')}
      return {data:result,error:null}
    } catch(error) {
      // The loss injection is after releasing the successful RPC savepoint.
      if(!(loseCommit&&name==='pilot_quote_acceptance_commit'&&receipts.length))await db.exec('rollback to savepoint acceptance_caller_transport; reset role; release savepoint acceptance_caller_transport')
      throw error
    }
  }}}} as unknown as SupabaseClient
  return {store:createPilotQuoteAcceptanceStore(sb),calls,receipts}
}
export async function runAcceptanceCallerNativeCases(db:Database):Promise<TestResult[]> {
  const tests:TestResult[]=[];acceptanceCallerNativeEvidence.length=0;acceptanceCallerResponseFixtures.length=0
  const test=async(name:string,work:()=>Promise<void>)=>{await db.exec('begin isolation level read committed')
    try{await work();await db.exec('set constraints all immediate');tests.push({name:'Acceptance caller native: '+name,pass:true})}
    catch(error){tests.push({name:'Acceptance caller native: '+name,pass:false,error:error instanceof Error?error.message.slice(0,1600):'Native acceptance caller assertion failed'})}
    finally{await db.exec('rollback')}}
  async function setup(tag:number,mode:'portal'|'owner',shape:'plain'|'services'|'options'|'no_charge') {
    const f=await seedQuoteIdentity(db,tag,false,shape==='services'||shape==='options'?shape:undefined)
    const token='SYNTHETIC_ACCEPTANCE_CALLER_'+tag+'_NOT_A_CREDENTIAL'
    await db.query('insert into public.customer_portal_tokens(token,user_id,customer_id) values($1,$2::uuid,$3::uuid)',[token,f.owner,f.customer])
    if(shape==='services'||shape==='options')await db.query('update public.quote_addons set is_selected=true where quote_id=$1::uuid',[f.quote])
    if(shape==='options'){
      await db.query(`insert into public.quote_options(user_id,quote_id,name,description,price,sort_order,is_recommended)
        values($1::uuid,$2::uuid,'Extended fixture option','An alternative that is not chosen',245,1,false)`,[f.owner,f.quote])
      await db.query(`insert into public.quote_addons(user_id,quote_id,name,price,is_selected,sort_order)
        values($1::uuid,$2::uuid,'Excluded fixture extra',27,false,1)`,[f.owner,f.quote])
      const terms='A deposit is required before scheduling.',patch=termsClaimPatch(terms)
      await db.query(`update public.business_settings set terms_text=$2,terms_payment_claim=$3,terms_payment_claim_fingerprint=$4,
        terms_payment_claim_version=$5,gst_percent=5 where user_id=$1::uuid`,[f.owner,terms,patch.terms_payment_claim,patch.terms_payment_claim_fingerprint,patch.terms_payment_claim_version])
      await db.query(`update public.quotes set deposit_type='percent',deposit_value=50,weekly_price=50,biweekly_price=80,monthly_price=120 where id=$1::uuid`,[f.quote])
    }
    if(shape==='no_charge'){
      // Fixture setup chooses zero amounts explicitly. The native declaration
      // records accountable no-charge evidence; it does not change pricing.
      await db.query('update public.quotes set initial_price=0,travel_fee=0 where id=$1::uuid',[f.quote])
      await db.query("select set_config('request.jwt.claim.sub',$1,true)",[f.owner]);await db.exec('set local role authenticated')
      assert.equal(await identityValue(db,"select public.quote_set_no_charge($1::uuid,'Synthetic declared no charge') as value",[f.quote]),true)
      await db.exec('reset role');await db.query("select set_config('request.jwt.claim.sub','',true),set_config('request.jwt.claims','',true)")
    }
    const option=shape==='options'?String(await identityValue(db,'select id as value from public.quote_options where quote_id=$1::uuid order by sort_order,id limit 1',[f.quote])):null
    const previewRequest:PilotAcceptancePreviewRequest={version:1,quoteId:f.quote,optionId:option,...(mode==='portal'?{portalToken:token}:{})}
    const roleReads:string[]=[]
    const auth:PilotQuoteSaveAuth={getUser:async()=>({data:{user:{id:f.owner}},error:null}),
      async readOwnerRole(expectedOwner,signal){
        assert.equal(signal.aborted,false);assert.equal(expectedOwner,f.owner);roleReads.push(expectedOwner)
        await db.exec('savepoint acceptance_caller_role')
        try {
          assert.equal(await identityValue(db,'select current_user as value'),'postgres')
          await db.query("select set_config('request.jwt.claim.sub',$1,true),set_config('request.jwt.claims',$2,true)",
            [f.owner,JSON.stringify({sub:f.owner,role:'authenticated'})])
          return {data:await identityValue(db,'select public.pilot_quote_save_owner_role($1::uuid) as value',[expectedOwner]),error:null}
        } finally {
          await db.exec('rollback to savepoint acceptance_caller_role; release savepoint acceptance_caller_role')
        }
      }},options={trustedOrigin:origin}
    return {f,token,previewRequest,auth,options,roleReads}
  }
  for(const [index,mode,shape] of [[1,'portal','services'],[2,'owner','options'],[3,'portal','no_charge'],[4,'owner','plain']] as const)
    await test(mode+' '+shape+' actual preview and accepted HTTP response match native ledger',async()=>{
      const {f,token,previewRequest,auth,options,roleReads}=await setup(8300+index,mode,shape),b=bridge(db),before=await rows(db,f.owner)
      const p=await previewQuoteAcceptance(b.store,auth,request(previewRequest),options);assert.equal(p.status,200)
      const previewResponse=await p.json(),preview=parsePilotAcceptancePreview(previewResponse,previewRequest);assert.ok(preview&&preview.code==='preview')
      assert.deepEqual(await rows(db,f.owner),before)
      const reason=mode==='owner'?'text_message':null,note=mode==='owner'?'Actual fixture attestation':null
      const intent=buildPilotAcceptanceCommitRequest(previewRequest,preview.expected,{addonIds:preview.expected.offered.public.included_addon_ids,
        reason,note,termsAck:true,clientOperationId:`85000000-0000-4000-8000-${String(8300+index).padStart(12,'0')}`})
      const response=await commitQuoteAcceptance(b.store,auth,request(intent),options);assert.equal(response.status,200);assert.equal(response.headers.get('cache-control'),'no-store')
      const commitResponse=await response.json(),parsed=parsePilotAcceptanceCommitReply(commitResponse,intent,mode==='owner'?f.owner:undefined);assert.ok(parsed&&parsed.code==='accepted')
      const after=await rows(db,f.owner),ledger=after.quote_acceptances[0]
      assert.equal(after.quote_acceptances.length,1);assert.equal(ledger.id,parsed.receipt.acceptance_id);assert.equal(ledger.accepted_amount,parsed.receipt.accepted_amount)
      assert.equal(ledger.kind,parsed.receipt.kind);assert.equal(ledger.actor_id,parsed.receipt.actor_id);assert.equal(ledger.customer_id,f.customer)
      assert.equal(ledger.document_fingerprint,parsed.receipt.document_fingerprint);assert.equal(ledger.terms_fingerprint,parsed.receipt.terms_fingerprint)
      assert.equal(after.quotes[0].accepted_price,preview.expected.offered.public.accepted_amount)
      assert.deepEqual(after.quote_addons.filter(x=>x.is_selected).map(x=>String(x.id)).sort(),intent.addonIds)
      if(shape==='no_charge'){assert.equal(preview.expected.offered.public.no_charge,true);assert.equal(parsed.receipt.accepted_amount,0)}
      assert.deepEqual(b.calls,['pilot_quote_acceptance_preview','pilot_quote_acceptance_commit'])
      assert.deepEqual(roleReads,mode==='owner'?[f.owner,f.owner]:[])
      const capture:AcceptanceCallerResponseFixture={name:mode+'-'+shape,mode,ownerId:f.owner,quoteId:f.quote,optionId:previewRequest.optionId,previewResponse,commitResponse,reason,note,termsAck:true}
      const serialized=JSON.stringify(capture);for(const forbidden of [token,'Private fixture note','Synthetic declared no charge','terms_payment_claim','no_charge_reason','no_charge_by'])assert.equal(serialized.includes(forbidden),false)
      acceptanceCallerResponseFixtures.push(capture)
      acceptanceCallerNativeEvidence.push({name:capture.name,calls:b.calls,previewZeroWrites:true,rowsBefore:hash(before),rowsAfter:hash(after),
        previewResponseSha256:hash(previewResponse),commitResponseSha256:hash(commitResponse),nativeWriteCount:1,
        transport:'acceptance RPC: actual service_role NULL-JWT SQL',authority:'synthetic verified Auth/Request',
        ownerRoleRead:mode==='owner'?'actual expected-owner RPC under privileged fixture SQL with synthetic JWT claims; not Auth/ACL evidence':null,
        ownerRoleReads:roleReads.length,
        noChargeSetup:shape==='no_charge'?'native quote_set_no_charge under authenticated synthetic fixture owner JWT':null,
        outerTransaction:'rolled back fixture',durableOuterCommitProved:false})
    })
  await test('stale native preview produces bound quote_changed and no row mutation',async()=>{
    const h=await setup(8310,'portal','plain'),b=bridge(db),p=parsePilotAcceptancePreview(await (await previewQuoteAcceptance(b.store,h.auth,request(h.previewRequest),h.options)).json(),h.previewRequest)
    assert.ok(p&&p.code==='preview');const intent=buildPilotAcceptanceCommitRequest(h.previewRequest,p.expected,{addonIds:p.expected.offered.public.included_addon_ids,reason:null,note:null,termsAck:false,clientOperationId:'85000000-0000-4000-8000-000000008310'})
    await db.query("update public.quotes set notes='Changed actual scope' where id=$1::uuid",[h.f.quote]);const before=await rows(db,h.f.owner)
    const raw=await (await commitQuoteAcceptance(b.store,h.auth,request(intent),h.options)).json();assert.deepEqual(raw,{code:'refused',clientOperationId:intent.clientOperationId,previewRevision:intent.expected.previewRevision,reason:'quote_changed'})
    assert.deepEqual(await rows(db,h.f.owner),before);acceptanceCallerNativeEvidence.push({name:'stale',nativeWrites:0,rowsBefore:hash(before),rowsAfter:hash(await rows(db,h.f.owner)),response:raw})
  })
  await test('lost native accepted reply stays UNKNOWN through one read-only reconcile with no replay',async()=>{
    const h=await setup(8311,'owner','plain'),b=bridge(db,true),p=parsePilotAcceptancePreview(await (await previewQuoteAcceptance(b.store,h.auth,request(h.previewRequest),h.options)).json(),h.previewRequest)
    assert.ok(p&&p.code==='preview');const intent=buildPilotAcceptanceCommitRequest(h.previewRequest,p.expected,{addonIds:p.expected.offered.public.included_addon_ids,reason:'text_message',note:'Synthetic lost result',termsAck:true,clientOperationId:'85000000-0000-4000-8000-000000008311'})
    const raw=await (await commitQuoteAcceptance(b.store,h.auth,request(intent),h.options)).json();assert.equal(raw.code,'unknown')
    const after=await rows(db,h.f.owner);assert.equal(after.quote_acceptances.length,1)
    const reconciled=await (await reconcileQuoteAcceptance(b.store,h.auth,request(intent),h.options)).json();assert.equal(reconciled.code,'unknown');assert.deepEqual(await rows(db,h.f.owner),after)
    assert.deepEqual(b.calls,['pilot_quote_acceptance_preview','pilot_quote_acceptance_commit','pilot_quote_acceptance_reconcile']);assert.equal(b.receipts.length,1)
    assert.deepEqual(h.roleReads,[h.f.owner,h.f.owner,h.f.owner])
    acceptanceCallerNativeEvidence.push({name:'lost-native-result',nativeWriteCount:1,httpCode:raw.code,reconcileCode:reconciled.code,automaticReplay:false,
      rowsAfterWrite:hash(after),rowsAfterReconcile:hash(await rows(db,h.f.owner)),outerTransaction:'rolled back fixture',durableOuterCommitProved:false})
  })
  return tests
}
