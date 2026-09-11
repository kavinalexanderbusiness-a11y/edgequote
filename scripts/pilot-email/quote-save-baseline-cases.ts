import assert from 'node:assert/strict'
import type { QuoteFormValues } from '../../src/types'
import { loadPilotQuoteSaveBaselineRequest, projectPilotQuoteSaveBaseline } from '../../src/lib/quotes/pilotQuoteSaveBaselineServer'
import { parsePilotQuoteSaveBaseline } from '../../src/lib/quotes/pilotQuoteSaveBaseline'
import type { PilotQuoteSaveAuth, PilotQuoteSaveStore } from '../../src/lib/quotes/pilotQuoteSave'
import { baselineBinding as binding, baselineId, baselineOption, baselineService, baselinePrivateSentinel, quoteSaveBaselineFixture } from './quote-save-baseline-fixtures'
import type { TestResult } from './database'

type Row = Record<string, unknown>
const origin='https://baseline.fixture.example.invalid'
export const quoteSaveBaselineEvidence: Row[]=[]
const request=(body:unknown={version:1,quoteId:binding.quoteId},init:RequestInit={})=>new Request(origin+'/dormant-baseline',{
  method:'POST',headers:{origin,'content-type':'application/json'},body:JSON.stringify(body),...init})
function harness() {
  const snapshot=quoteSaveBaselineFixture(),calls:string[]=[]
  const auth:PilotQuoteSaveAuth={async getUser(){calls.push('auth');return {data:{user:{id:binding.ownerId}},error:null}}}
  const store:PilotQuoteSaveStore={async snapshot(owner,quote,signal){calls.push('snapshot');assert.equal(owner,binding.ownerId);assert.equal(quote,binding.quoteId);assert.equal(signal.aborted,false);return structuredClone(snapshot)},
    async targets(){calls.push('FORBIDDEN_TARGETS');throw Error('Unexpected target read')},async commit(){calls.push('FORBIDDEN_WRITE');throw Error('Unexpected write')}}
  const run=(r=request(),ms=1000)=>loadPilotQuoteSaveBaselineRequest(store,auth,r,{trustedOrigin:origin,bodyTimeoutMs:ms,operationTimeoutMs:ms})
  return {snapshot,calls,auth,store,run}
}
async function responseIs(response:Response,code:string,status:number):Promise<Row> {
  assert.equal(response.status,status);assert.equal(response.headers.get('cache-control'),'no-store')
  const text=await response.text();assert.equal(text.includes(baselinePrivateSentinel),false)
  const value=JSON.parse(text) as Row;assert.equal(value.code,code)
  if(code!=='baseline')assert.deepEqual(value,{code})
  return value
}
export async function runQuoteSaveBaselineCases():Promise<TestResult[]> {
  const results:TestResult[]=[];quoteSaveBaselineEvidence.length=0
  const test=async(name:string,work:()=>Promise<void>|void)=>{try{await work();results.push({name:'Save baseline: '+name,pass:true})}
    catch(error){results.push({name:'Save baseline: '+name,pass:false,error:error instanceof Error?error.message.slice(0,1500):'Baseline assertion failed'})}}
  await test('one verified-owner snapshot produces only complete whitelisted defaults and measurement',async()=>{
    const h=harness(),result=await responseIs(await h.run(),'baseline',200),parsed=parsePilotQuoteSaveBaseline(result,binding)
    assert.ok(parsed);assert.deepEqual(h.calls,['auth','snapshot']);assert.equal(parsed.editorRevision,h.snapshot.editor_revision)
    assert.equal(parsed.values.initial_price,100);assert.equal(parsed.values.overgrowth_multiplier,1)
    assert.equal(parsed.values.customer_phone,'');assert.equal(parsed.values.value_grade,null);assert.equal(parsed.values.nearby_count,null)
    assert.equal(parsed.values.internal_notes,'Owner scope');assert.deepEqual(parsed.values.measurement_snapshot,h.snapshot.quote.row.measurement_snapshot)
    assert.equal(parsed.selectedOption,null);assert.deepEqual(parsed.acceptance,{hasRecord:false,current:false})
    quoteSaveBaselineEvidence.push({kind:'one-read-zero-write',calls:h.calls,privateSentinelReturned:false})
  })
  await test('selected option means actual selected ID, never recommended fallback',async()=>{
    const h=harness();h.snapshot.options=[baselineOption(0),baselineOption(1)]
    assert.equal((await responseIs(await h.run(),'baseline',200)).selectedOption,null)
    h.snapshot.quote.row.selected_option_id=baselineId(30)
    assert.deepEqual((await responseIs(await h.run(),'baseline',200)).selectedOption,{id:baselineId(30),name:'Synthetic option 0'})
    h.snapshot.quote.row.selected_option_id=baselineId(99)
    await responseIs(await h.run(),'invalid_baseline',503)
  })
  await test('native sort order plus ID determines primary and extras without repricing',async()=>{
    const h=harness();h.snapshot.services=[baselineService(0,0),baselineService(1,0)]
    const result=await responseIs(await h.run(),'baseline',200),values=result.values as QuoteFormValues
    assert.equal(values.initial_price,12.345);assert.equal(values.services.length,1)
    assert.equal(values.services[0].unit_price,12.345);assert.equal(values.services[0].quantity,1.25)
    h.snapshot.services.reverse();await responseIs(await h.run(),'invalid_baseline',503)
  })
  await test('missing initializer fields refuse before nullable defaults can erase evidence',async()=>{
    const quoteFields=['quote_number','customer_name','address','service_type','service_template_id','initial_price','weekly_price','biweekly_price','monthly_price',
      'measured_sqft','measurement_snapshot','suggested_price','hours','crew_size','rate','travel_fee','custom_travel_required','show_travel_separately',
      'notes','internal_notes','status','selected_option_id','deposit_type','deposit_value']
    for(const field of quoteFields){const h=harness();delete h.snapshot.quote.row[field];await responseIs(await h.run(),'invalid_baseline',503);assert.deepEqual(h.calls,['auth','snapshot'])}
    for(const field of ['name','description','price','is_recommended','created_at','updated_at']){
      const h=harness();h.snapshot.options=[baselineOption(0)];delete (h.snapshot.options[0].row as Row)[field];await responseIs(await h.run(),'invalid_baseline',503)}
    for(const field of ['service_type','service_template_id','quantity','unit','unit_price','est_minutes','kind','discount_type','discount_value','notes','created_at']){
      const h=harness();h.snapshot.services=[baselineService(0)];delete (h.snapshot.services[0].row as Row)[field];await responseIs(await h.run(),'invalid_baseline',503)}
  })
  await test('malformed source values are not coerced into valid zeros or booleans',async()=>{
    for(const [field,value] of [['initial_price','100'],['crew_size',1.5],['custom_travel_required','false'],['notes',false],['measurement_snapshot',{v:1}],['deposit_type','maybe']]){
      const h=harness();h.snapshot.quote.row[String(field)]=value;await responseIs(await h.run(),'invalid_baseline',503)}
    const h=harness();h.snapshot.options=[baselineOption(0)];h.snapshot.options[0].row.price='broken' as unknown as number
    await responseIs(await h.run(),'invalid_baseline',503)
  })
  await test('known nullable fields remain explicit valid absence',async()=>{
    const h=harness();for(const field of ['initial_price','weekly_price','biweekly_price','monthly_price','measured_sqft','measurement_snapshot','suggested_price','notes','internal_notes','deposit_type','deposit_value'])h.snapshot.quote.row[field]=null
    const values=(await responseIs(await h.run(),'baseline',200)).values as QuoteFormValues
    assert.equal(values.initial_price,0);assert.equal(values.notes,'');assert.equal(values.measurement_snapshot,null);assert.equal(values.deposit_type,'')
  })
  await test('wrong owner, quote, identity inventory, incomplete children and foreign rows all refuse',async()=>{
    const mutations:Array<(h:ReturnType<typeof harness>)=>void>=[h=>{h.snapshot.quote.row.user_id=baselineId(99)},h=>{h.snapshot.quote.row.id=baselineId(99)},
      h=>{h.snapshot.identity.customers[0].user_id=baselineId(99)},h=>{h.snapshot.identity.complete=false as true},
      h=>{h.snapshot.services=undefined as never},h=>{h.snapshot.options=[baselineOption(0)];h.snapshot.options[0].row.user_id=baselineId(99)},
      h=>{h.snapshot.complete=false as true},h=>{h.snapshot.addons[0].row.is_selected='false'},h=>{h.snapshot.services=[baselineService(0)];h.snapshot.options=[baselineOption(0)]},
      h=>{h.snapshot.quote.row.service_template_id=baselineId(99)},h=>{h.snapshot.services=[baselineService(0)];h.snapshot.services[0].row.service_template_id=baselineId(99)}]
    for(const mutate of mutations){const h=harness();mutate(h);await responseIs(await h.run(),'invalid_baseline',503);assert.deepEqual(h.calls,['auth','snapshot'])}
  })
  await test('auth, strict origin/body and not-found do not turn into editable defaults',async()=>{
    const h=harness()
    for(const body of [{version:1,quoteId:binding.quoteId,owner:binding.ownerId},{version:1},null])await responseIs(await h.run(request(body)),'invalid_request',400)
    await responseIs(await h.run(request(undefined,{headers:{origin:'https://foreign.invalid','content-type':'application/json'}})),'forbidden_origin',403)
    await responseIs(await h.run(request(undefined,{body:'broken json'})),'invalid_request',400);assert.deepEqual(h.calls,[])
    h.auth.getUser=async()=>({data:{user:null}});await responseIs(await h.run(),'unauthenticated',401);assert.deepEqual(h.calls,[])
    const missing=harness();missing.store.snapshot=async()=>({code:'not_found'});await responseIs(await missing.run(),'not_found',404)
    const unavailable=harness();unavailable.store.snapshot=async()=>{throw Error(baselinePrivateSentinel)};await responseIs(await unavailable.run(),'unavailable',503)
  })
  await test('response and complete maximum-generation intent caps are enforced without truncation',async()=>{
    const h=harness();h.snapshot.quote.row.notes=''
    const baseline=projectPilotQuoteSaveBaseline(h.snapshot,binding)
    const wire={version:1,quoteId:binding.quoteId,expectedEditorRevision:baseline.editorRevision,clientOperationId:'00000000-0000-4000-8000-000000000000',editorGeneration:'g'.repeat(128),values:baseline.values}
    const room=200_000-Math.max(Buffer.byteLength(JSON.stringify(baseline)),Buffer.byteLength(JSON.stringify(wire)))
    h.snapshot.quote.row.notes='x'.repeat(room);await responseIs(await h.run(),'baseline',200)
    h.snapshot.quote.row.notes+='x';await responseIs(await h.run(),'baseline_too_large',503)
    h.snapshot.quote.row.notes='é'.repeat(100_000);await responseIs(await h.run(),'baseline_too_large',503)
    const oversized=harness();await responseIs(await oversized.run(request(undefined,{body:' '.repeat(200_001)})),'request_too_large',413);assert.deepEqual(oversized.calls,[])
  })
  await test('read cancellation/late completion cannot create a baseline or invoke another capability',async()=>{
    const h=harness();let finish:((value:unknown)=>void)|undefined,signal:AbortSignal|undefined
    h.store.snapshot=(_o,_q,s)=>{h.calls.push('snapshot');signal=s;return new Promise(resolve=>{finish=resolve})}
    await responseIs(await h.run(request(),5),'unavailable',503);assert.equal(signal?.aborted,true)
    finish!(h.snapshot);await Promise.resolve();assert.deepEqual(h.calls,['auth','snapshot'])
    const aborted=harness(),controller=new AbortController();controller.abort()
    await responseIs(await aborted.run(request(undefined,{signal:controller.signal})),'unavailable',503);assert.deepEqual(aborted.calls,[])
  })
  await test('browser baseline parser binds owner, exact fields, selection and future intent bytes',()=>{
    const baseline=projectPilotQuoteSaveBaseline(quoteSaveBaselineFixture(),binding)
    for(const value of [{...baseline,ownerId:baselineId(99)},{...baseline,quoteId:baselineId(99)},{...baseline,private:baselinePrivateSentinel},
      {...baseline,complete:false},{...baseline,acceptance:{hasRecord:false,current:true}},{...baseline,selectedOption:{id:baselineId(99),name:'invented'}}])assert.equal(parsePilotQuoteSaveBaseline(value,binding),null)
    assert.ok(parsePilotQuoteSaveBaseline(baseline,binding))
  })
  return results
}
