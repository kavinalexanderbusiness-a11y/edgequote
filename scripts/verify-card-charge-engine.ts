import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'
import ts from 'typescript'
const source=readFileSync('src/lib/payments/autopay.ts','utf8')
async function scenario(errorTable='',opts:{manual?:boolean;consent?:boolean;timeout?:boolean;claimError?:boolean;autopay?:boolean}={}) {
 let charges=0,claimed=false
 const row=(table:string)=> table==='invoices'?{id:'inv',customer_id:'customer',job_id:'job',status:'draft',amount:90,amount_paid:20,invoice_number:'test'}:
 table==='jobs'?{recurrence_id:'series'}:table==='customers'?{id:'customer',autopay_enabled:opts.autopay!==false,stripe_customer_id:'cus'}:
 table==='payment_methods'?{stripe_payment_method_id:'pm',stripe_customer_id:'cus'}:table==='business_settings'?{gst_percent:0,autopay_charge_mode:'auto'}:[]
 const sb={from(table:string){const q:any=new Proxy({}, {get(_,name){if(name==='then')return(resolve:any)=>resolve({data:table===errorTable?null:row(table),error:table===errorTable?{message:'failed'}:null});return()=>q}});return q},
 async rpc(){if(opts.claimError)return {error:{message:'failed'},data:null};if(claimed||opts.consent===false)return {data:null,error:null};claimed=true;return {data:'attempt',error:null}}}
 const exports:any={}
 const deps:any={stripeEnabled:()=>true,webhookConfigured:()=>true,tenantCapabilities:async()=>({onlinePayments:true}),invoiceBalance:()=>({balance:70}),
 chargeSavedCardOffSession:async(p:any)=>{assert.equal(p.attemptId,'attempt');charges++;if(opts.timeout)throw Error('network uncertain');return {ok:true,status:'processing'}}}
 runInNewContext(ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText,{exports,require:()=>deps,console:{log(){},warn(){}},Date,Number,Math})
 const run=()=>exports.attemptAutoPayCharge(sb,{invoiceId:'inv',userId:'owner',manual:opts.manual??true})
 return {run,charges:()=>charges}
}
async function main(){
 for(const table of ['invoices','jobs','customers','payment_methods','payments','business_settings']){
  const f=await scenario(table);assert.equal((await f.run()).result,'held');assert.equal(f.charges(),0)
 }
 for(const opts of [{consent:false},{claimError:true},{autopay:false}]){
  const f=await scenario('',opts);assert.notEqual((await f.run()).result,'charged');assert.equal(f.charges(),0)
 }
 const pending=await scenario();await Promise.all([pending.run(),pending.run()]);assert.equal(pending.charges(),1)
 const timeout=await scenario('',{timeout:true});assert.equal((await timeout.run()).result,'held');assert.equal((await timeout.run()).result,'held');assert.equal(timeout.charges(),1)
 console.log('Card charge engine: read errors/consent/claim failure/opt-out/concurrency/unknown outcome passed with no network.')
}
main().catch(e=>{console.error(e);process.exitCode=1})
