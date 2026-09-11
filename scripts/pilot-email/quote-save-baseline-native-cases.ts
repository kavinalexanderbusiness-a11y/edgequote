import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import type { Database, TestResult } from './database'
import { identityRows, seedQuoteIdentity } from './quote-identity-fixtures'
import { quoteSaveSnapshot } from './quote-save-native-cases'
import { loadPilotQuoteSaveBaselineRequest } from '../../src/lib/quotes/pilotQuoteSaveBaselineServer'
import { parsePilotQuoteSaveBaseline } from '../../src/lib/quotes/pilotQuoteSaveBaseline'
import type { PilotQuoteSaveStore } from '../../src/lib/quotes/pilotQuoteSave'

// Cloud-only marked native fixture. Auth/Request are synthetic; existing actual
// service-role NULL-JWT snapshot transport is reused. No sessions opened here.
// All fixture setup is inside outer rollback transactions; loader writes none.
type Row=Record<string,unknown>
const origin='https://baseline-native.fixture.example.invalid'
const hash=(v:unknown)=>createHash('sha256').update(JSON.stringify(v)).digest('hex')
export const quoteSaveBaselineNativeEvidence:Row[]=[]
async function rows(db:Database,owner:string){const result=await identityRows(db,owner)
  for(const table of ['business_settings','pricing_config_versions','property_measurements','property_measurement_events','quote_acceptances'])
    result[table]=(await db.query<{row:Row}>(`select to_jsonb(t) as row from public.${table} t where user_id=$1::uuid order by to_jsonb(t)::text`,[owner])).rows.map(r=>r.row)
  return result}
export async function runQuoteSaveBaselineNativeCases(db:Database):Promise<TestResult[]> {
  const tests:TestResult[]=[];quoteSaveBaselineNativeEvidence.length=0
  const test=async(name:string,work:()=>Promise<void>)=>{await db.exec('begin isolation level read committed')
    try{await work();await db.exec('set constraints all immediate');tests.push({name:'Baseline native: '+name,pass:true})}
    catch(error){tests.push({name:'Baseline native: '+name,pass:false,error:error instanceof Error?error.message.slice(0,1800):'Native baseline assertion failed'})}
    finally{await db.exec('rollback')}}
  for(const kind of ['plain','services','options'] as const)await test(kind+' native baseline projects actual source with one snapshot and zero mutations',async()=>{
    const f=await seedQuoteIdentity(db,{plain:8201,services:8202,options:8203}[kind],false,kind==='plain'?undefined:kind)
    const first=`33333333-3333-4333-8333-${kind==='services'?'000000820211':'000000820311'}`
    const second=`33333333-3333-4333-8333-${kind==='services'?'000000820212':'000000820312'}`
    const last=`11111111-1111-4111-8111-${kind==='services'?'000000820213':'000000820313'}`
    // Arrival order and identityRows' id order both differ from commercial
    // order. The first two children tie on sort_order and must use id next.
    if(kind==='services') {
      await db.query(`update public.quote_services set id=$2::uuid,sort_order=20,quantity=3,unit=null,unit_price=24.5,
        est_minutes=null,discount_type=null,discount_value=null,notes=null where quote_id=$1::uuid`,[f.quote,last])
      await db.query(`insert into public.quote_services(id,user_id,quote_id,service_type,quantity,unit,unit_price,
        est_minutes,discount_type,discount_value,notes,sort_order,kind) values
        ($1::uuid,$3::uuid,$4::uuid,'Native material extra',2.5,'bag',8.765,15,'amount',1.25,'Deliver and spread',3,'material'),
        ($2::uuid,$3::uuid,$4::uuid,'Native tied primary',1,'visit',12.345,null,null,null,null,3,'service')`,
      [second,first,f.owner,f.quote])
    }
    if(kind==='options') {
      await db.query('update public.quote_options set id=$2::uuid,sort_order=20,description=null where quote_id=$1::uuid',[f.quote,last])
      await db.query(`insert into public.quote_options(id,user_id,quote_id,name,description,price,is_recommended,sort_order) values
        ($1::uuid,$3::uuid,$4::uuid,'Native tied second','Includes the native extra',123.45,false,3),
        ($2::uuid,$3::uuid,$4::uuid,'Native tied first',null,67.89,false,3)`,[second,first,f.owner,f.quote])
    }
    const frozen={v:2,type:'area',unit:'sqft',value:1234.5,parts:[{label:'Native saved lawn',value:1234.5}],
      measuredAt:'2026-09-10T12:00:00.000Z',serviceTemplateId:null,serviceName:'Native service',term:'one_time',basis:'flat',rate:100,price:100}
    await db.query('update public.quotes set measurement_snapshot=$2::jsonb where id=$1::uuid',[f.quote,JSON.stringify(frozen)])
    const before=await rows(db,f.owner),snapshot=await quoteSaveSnapshot(db,f),calls:string[]=[]
    const commercialOrder=(children:Row[])=>[...children].sort((a,b)=>Number(a.sort_order)-Number(b.sort_order)
      || (String(a.id)<String(b.id)?-1:String(a.id)>String(b.id)?1:0))
    const orderedServices=commercialOrder(before.quote_services),orderedOptions=commercialOrder(before.quote_options)
    if(kind!=='plain') {
      const source=kind==='services'?before.quote_services:before.quote_options,ordered=kind==='services'?orderedServices:orderedOptions
      assert.equal(ordered.length,3);assert.deepEqual(ordered.map(r=>r.id),[first,second,last])
      assert.deepEqual(ordered.map(r=>r.sort_order),[3,3,20]);assert.notDeepEqual(ordered.map(r=>r.id),source.map(r=>r.id))
    }
    assert.ok(Array.isArray(snapshot.services));assert.ok(Array.isArray(snapshot.options))
    assert.deepEqual(snapshot.services.map(r=>r.row.id),orderedServices.map(r=>r.id))
    assert.deepEqual(snapshot.options.map(r=>r.row.id),orderedOptions.map(r=>r.id))
    const store:PilotQuoteSaveStore={async snapshot(owner,quote){calls.push('snapshot');assert.equal(owner,f.owner);assert.equal(quote,f.quote);return quoteSaveSnapshot(db,f)},
      async targets(){calls.push('FORBIDDEN_TARGETS');throw Error('Unexpected target read')},async commit(){calls.push('FORBIDDEN_WRITE');throw Error('Unexpected write')}}
    const response=await loadPilotQuoteSaveBaselineRequest(store,{getUser:async()=>({data:{user:{id:f.owner}},error:null})},
      new Request(origin+'/dormant',{method:'POST',headers:{origin,'content-type':'application/json'},body:JSON.stringify({version:1,quoteId:f.quote})}),{trustedOrigin:origin})
    assert.equal(response.status,200);assert.equal(response.headers.get('cache-control'),'no-store')
    const raw=await response.json(),baseline=parsePilotQuoteSaveBaseline(raw,{ownerId:f.owner,quoteId:f.quote})
    assert.ok(baseline);assert.equal(baseline.editorRevision,snapshot.editor_revision);assert.equal(baseline.quoteNumber,before.quotes[0].quote_number)
    assert.equal(baseline.quoteUpdatedAt,before.quotes[0].updated_at);assert.deepEqual(baseline.values.measurement_snapshot,frozen)
    assert.equal(baseline.values.customer_name,before.quotes[0].customer_name);assert.equal(baseline.values.internal_notes,before.quotes[0].internal_notes)
    assert.equal(baseline.selectedOption,null,'An unchosen recommended option is not an approved selection')
    assert.deepEqual(baseline.values.options,orderedOptions.map(o=>({id:o.id,name:o.name,description:o.description??'',price:o.price,is_recommended:o.is_recommended})))
    assert.deepEqual(baseline.values.services,orderedServices.slice(1).map(s=>({service_type:s.service_type,service_template_id:s.service_template_id??'',
      quantity:s.quantity,unit:s.unit??'each',unit_price:s.unit_price,est_minutes:s.est_minutes??0,kind:s.kind,
      discount_type:s.discount_type??'',discount_value:s.discount_value??0,notes:s.notes??''})))
    assert.equal(baseline.values.initial_price,kind==='services'?orderedServices[0].unit_price:before.quotes[0].initial_price)
    if(kind==='services') {
      assert.equal(baseline.values.initial_price,12.345);assert.equal(baseline.values.services.length,2)
      assert.deepEqual(baseline.values.services[0],{service_type:'Native material extra',service_template_id:'',quantity:2.5,unit:'bag',unit_price:8.765,
        est_minutes:15,kind:'material',discount_type:'amount',discount_value:1.25,notes:'Deliver and spread'})
      assert.deepEqual(baseline.values.services[1],{service_type:'Protected fixture service',service_template_id:'',quantity:3,unit:'each',unit_price:24.5,
        est_minutes:0,kind:'service',discount_type:'',discount_value:0,notes:''})
    }
    assert.deepEqual(calls,['snapshot']);assert.deepEqual(await rows(db,f.owner),before);assert.deepEqual(await quoteSaveSnapshot(db,f),snapshot)
    quoteSaveBaselineNativeEvidence.push({kind,owner:f.owner,quote:f.quote,adapterCalls:calls,rowsBefore:hash(before),rowsAfter:hash(await rows(db,f.owner)),
      snapshotBefore:hash(snapshot),snapshotAfter:hash(await quoteSaveSnapshot(db,f)),responseKeys:Object.keys(raw as Row).sort(),
      commercialServiceIds:orderedServices.map(r=>r.id),commercialOptionIds:orderedOptions.map(r=>r.id),projectedExtraLines:baseline.values.services.length,
      tieOrderExercised:kind!=='plain',nullableSourceDefaultsExercised:kind!=='plain',
      nativeWrites:0,auth:'synthetic verified user',transport:'actual service_role NULL-JWT SQL',outerTransaction:'rolled back fixture'})
  })
  await test('foreign verified owner cannot load another native owner quote',async()=>{
    const f=await seedQuoteIdentity(db,8204),other=await seedQuoteIdentity(db,8205),before=await rows(db,f.owner)
    let reads=0
    const response=await loadPilotQuoteSaveBaselineRequest({snapshot:async(owner,quote)=>{reads++;return quoteSaveSnapshot(db,{owner,quote})}},
      {getUser:async()=>({data:{user:{id:other.owner}},error:null})},new Request(origin+'/dormant',{method:'POST',headers:{origin,'content-type':'application/json'},
        body:JSON.stringify({version:1,quoteId:f.quote})}),{trustedOrigin:origin})
    assert.equal(response.status,404);assert.deepEqual(await response.json(),{code:'not_found'});assert.equal(reads,1)
    assert.deepEqual(await rows(db,f.owner),before)
  })
  return tests
}
