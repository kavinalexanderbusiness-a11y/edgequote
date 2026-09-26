// TEST ONLY. The imported components, controller, validators, modal, quote model
// and money helpers are actual application source. Only external I/O is replaced.
// Exact native response replay and synthetic fault/lifecycle variants are labeled
// separately; no variant claims that its modified document was authorized by SQL.
export function acceptanceCallerMountedFixture(responseFixtures: unknown[], basis: 'native-http-capture' | 'synthetic-local'): string {
  return `
import React from 'react';
import {createRoot} from 'react-dom/client';
import {flushSync} from 'react-dom';
import {PortalClient} from '@/app/portal/[token]/PortalClient';
import {RecordAcceptanceDialog} from '@/components/quotes/RecordAcceptanceDialog';
import {PilotQuoteSaveEditorShell} from '@/components/quotes/PilotQuoteSaveEditorShell';
import {CacheOwner} from '@/components/layout/CacheOwner';
import {ConfirmHost} from '@/components/ui/ConfirmHost';
import {Toaster} from '@/components/ui/Toaster';
import {getCacheOwner} from '@/lib/clientCache';
import {formatCurrency} from '@/lib/utils';
import {ON_BEHALF_REASONS,TERMS_ACK_LABEL} from '@/lib/quoteAcceptance';
import {SYSTEM_UNITS} from '@/lib/units';
const NATIVE=${JSON.stringify(responseFixtures)};
const RESPONSE_BASIS=${JSON.stringify(basis)};
const clone=v=>JSON.parse(JSON.stringify(v)),delay=ms=>new Promise(r=>setTimeout(r,ms));
const assert=(ok,message)=>{if(!ok)throw Error(message)};
const same=(a,b,message)=>assert(JSON.stringify(a)===JSON.stringify(b),message);
const uuid=n=>'85000000-0000-4000-8000-'+String(n).padStart(12,'0');
const STAMP='2026-09-10T12:00:00.000Z',REV='c'.repeat(32);
const observations={reads:[],auth:[],fetches:[],navigation:[],blocked:[],cases:[],requests:[],fixtureReplay:[],storageWrites:[],preCleanupStorageChecks:0};
const deny=message=>{observations.blocked.push(message);throw Error(message)};
const text=el=>el.textContent.replace(/\\s+/g,' ').trim();
let serial=100,roots=[],activeState=null,operationQueue=[];const knownTokens=new Set();
const originalSetItem=Storage.prototype.setItem;
function acceptanceStorageLeak(key,value){return [...knownTokens].some(token=>String(key).includes(token)||String(value).includes(token))
 || /"(?:portalToken|previewRevision|authorityFence)"\\s*:/.test(String(value))}
Storage.prototype.setItem=function(key,value){if(acceptanceStorageLeak(key,value))return deny('Acceptance authority/preview persistence attempted');
 observations.storageWrites.push({namespace:String(key).split(':').slice(0,3).join(':'),containsAcceptanceAuthority:false});return originalSetItem.call(this,key,value)};
function inspectStorage(){for(const storage of [localStorage,sessionStorage])for(let i=0;i<storage.length;i++){
 const key=storage.key(i);assert(!acceptanceStorageLeak(key,storage.getItem(key)),'No token or acceptance expected object before cleanup')};observations.preCleanupStorageChecks++}
const originalRandomUUID=crypto.randomUUID.bind(crypto);
Object.defineProperty(crypto,'randomUUID',{configurable:true,value:()=>operationQueue.shift()??originalRandomUUID()});
async function waitFor(fn,message,ms=2500){const end=Date.now()+ms;while(Date.now()<end){if(fn())return;await delay(10)}throw Error(message)}
function defer(){let resolve,reject;const promise=new Promise((a,b)=>{resolve=a;reject=b});return {promise,resolve,reject}}
function documentOf(entry){return entry.previewResponse.expected.offered.public}
function capture(mode){const value=NATIVE.find(e=>e.mode===mode);assert(value,'Native '+mode+' response capture');return value}
for(const entry of NATIVE){
 assert(['portal','owner'].includes(entry.mode)&&entry.previewResponse?.code==='preview'&&entry.commitResponse?.code==='accepted','Strict successful native response-only fixture');
 assert(entry.quoteId===entry.previewResponse.expected.quoteId&&entry.quoteId===documentOf(entry).quote_id,'Native quote binding');
 assert(entry.optionId===documentOf(entry).offered_option_id,'Native option binding');
 assert(!Object.hasOwn(entry,'portalToken'),'Native capture must not include a raw token');
}
function variant(mode,mutate,base=capture(mode)){
 const e=clone(base),n=serial++;e.mode=mode;e.name='Synthetic browser variant '+n;e.basis='synthetic fault/lifecycle response; not native authorization';
 e.ownerId=uuid(n*100+1);e.quoteId=uuid(n*100+2);e.previewResponse.expected.quoteId=e.quoteId;documentOf(e).quote_id=e.quoteId;documentOf(e).quote_number='SYN-VARIANT-'+n;
 e.commitResponse.clientOperationId=uuid(n*100+3);e.commitResponse.receipt.quote_id=e.quoteId;e.commitResponse.receipt.acceptance_id=uuid(n*100+4);
 e.commitResponse.receipt.kind=mode==='owner'?'owner_on_behalf':'customer';e.commitResponse.receipt.source=mode==='owner'?'dashboard':'portal';
 e.commitResponse.receipt.actor_id=mode==='owner'?e.ownerId:e.commitResponse.receipt.customer_id;
 e.reason=mode==='owner'?'text_message':null;e.note=mode==='owner'?'Synthetic explicit attestation note':null;e.termsAck=mode==='owner';
 if(mutate)mutate(e,documentOf(e));return e;
}
function portalData(e,patch={}){
 const p=documentOf(e),customer=e.commitResponse.receipt.customer_id;assert(typeof customer==='string','Synthetic portal customer identity');
 return {customer:{id:customer,name:p.customer_name,email:'synthetic@example.invalid',phone:'4035550100',address:p.address,city:null,sms_opt_in:false,email_opt_in:false},
 business:{company_name:p.company_name,owner_name:null,phone:null,email_primary:null,email_secondary:null,website:null,logo_url:null,logo_scale:null,base_address:null,
 terms_text:p.terms_text,review_url:null,gst_percent:p.gst_percent,gst_number:null},property:null,properties:[],
 quotes:[{id:e.quoteId,quote_number:p.quote_number,service_type:p.service_type,address:p.address,property_id:null,total:p.total,initial_price:p.initial_price,subtotal:p.total,
 weekly_price:p.weekly_price,biweekly_price:p.biweekly_price,monthly_price:p.monthly_price,notes:p.notes,status:'sent',created_at:STAMP,issued_date:'2026-09-10',valid_until:p.valid_until,
 crew_size:1,hours:1,travel_fee:p.travel_fee,services:clone(p.services),options:clone(p.options),selected_option_id:null,accepted_price:null,deposit_type:p.deposit_type,deposit_value:p.deposit_value,...patch}],
 invoices:[],jobs:[],recurrences:[],photos:[],payments:[],change_orders:[],services:[]};
}
function observeRequest(phase,request){
 observations.requests.push({phase,mode:Object.hasOwn(request,'portalToken')?'portal':'owner',quoteId:request.quoteId,optionId:request.optionId,
 clientOperationId:request.clientOperationId??null,previewRevision:request.expected?.previewRevision??null});
}
function client(){
 const capturedOwner=getCacheOwner();return {
 auth:{getUser:async()=>{observations.auth.push({method:'getUser',owner:capturedOwner});return {data:{user:capturedOwner?{id:capturedOwner}:null},error:null}},
 getSession:async()=>{observations.auth.push({method:'getSession',owner:capturedOwner});return {data:{session:capturedOwner?{user:{id:capturedOwner}}:null},error:null}}},
 rpc:async(name,args)=>{
   if(name==='get_portal_data'&&activeState&&Object.keys(args).length===1&&args.p_token===activeState.token){observations.reads.push({kind:'portal',name});return {data:clone(activeState.data),error:null}}
   if(name==='portal_get_prefs'&&activeState&&Object.keys(args).length===1&&args.p_token===activeState.token){observations.reads.push({kind:'portal',name});return {data:{reminders:false,estimates:false,invoices:false,seasonal:false,marketing:false},error:null}}
   return deny('Unapproved RPC '+String(name));
 },
 from:table=>{
   const calls=[];let projection=null;let query;
   const finish=()=>{
     const state=activeState;assert(state&&state.save,'Auxiliary reads only from actual coupled Save editor');
     const sig=JSON.stringify(calls),cols=(projection||'').replace(/\\s/g,'');let data;
     if(table==='service_units'&&cols==='id,user_id,code,label,abbrev,step,decimals,sort_order,active'&&sig===JSON.stringify([['eq','active',true],['order','sort_order',{ascending:true}]]))data=clone(SYSTEM_UNITS);
     else if(table==='service_pricing_plans'&&cols==='*'&&sig===JSON.stringify([['eq','user_id',capturedOwner],['order','sort_order',{ascending:true}]]))data=[];
     else if(table==='properties'&&cols==='lawn_sqft,measurement_history,address,city,province'&&sig===JSON.stringify([['eq','customer_id',state.customerId],['order','is_primary',{ascending:false}],['limit',1],['maybeSingle']]))data={lawn_sqft:null,measurement_history:[],address:'Synthetic property',city:null,province:null};
     else if(table==='labor_observations'&&cols==='job_id,property_id,service_date,sqft,service_type,crew_size,frequency,is_initial_visit,overgrowth,estimated_minutes,actual_minutes'&&sig===JSON.stringify([['eq','user_id',capturedOwner]]))data=[];
     else if(table==='business_settings'&&cols==='smart_labor_enabled,crew_cost_per_hour'&&sig===JSON.stringify([['eq','user_id',capturedOwner],['maybeSingle']]))data={smart_labor_enabled:false,crew_cost_per_hour:null};
     else return deny('Unapproved synthetic read '+table+' '+cols);
     assert(capturedOwner===state.ownerId,'Synthetic Save read owner');observations.reads.push({kind:'save',table,columns:cols,calls});return {data,error:null};
   };
   query=new Proxy({}, {get:(_,method)=>{if(method==='then')return (ok,bad)=>Promise.resolve().then(finish).then(ok,bad);
     if(method==='select')return columns=>{if(projection!==null)return deny('Repeated select');projection=columns;return query};
     if(['eq','order','limit','maybeSingle'].includes(method))return (...args)=>{calls.push([method,...args]);return query};
     return ()=>deny('Unapproved synthetic operation '+table+'.'+String(method))}});return query;
 },storage:new Proxy({}, {get:()=>()=>deny('Storage/provider flow forbidden')})};
}
window.__acceptanceTestIO={client,navigation:observations.navigation,router:{back:()=>observations.navigation.push('back'),push:()=>deny('Navigation'),replace:()=>deny('Navigation'),refresh:()=>deny('Navigation')}};
window.fetch=async(input,init)=>{
 const raw=typeof input==='string'?input:input instanceof Request?input.url:String(input),url=new URL(raw,location.origin),method=init?.method??(input instanceof Request?input.method:'GET');
 if(url.origin===location.origin&&url.pathname==='/api/payments/status'&&method==='GET'&&activeState&&url.searchParams.get('portal')===activeState.token){
   observations.fetches.push({path:url.pathname,method,synthetic:true,enabled:false});return new Response(JSON.stringify({enabled:false}),{headers:{'content-type':'application/json'}})}
 if(url.origin===location.origin&&url.pathname==='/api/ai/assist'&&!url.search&&method==='GET'&&activeState?.save){
   observations.fetches.push({path:url.pathname,method,synthetic:true,enabled:false});return new Response(JSON.stringify({aiEnabled:false}),{headers:{'content-type':'application/json'}})}
 return deny('External or unapproved request '+method+' '+url.pathname);
};
const originalXHR=XMLHttpRequest.prototype.open;
XMLHttpRequest.prototype.open=function(){return deny('XHR forbidden')};
window.addEventListener('securitypolicyviolation',e=>observations.blocked.push('CSP '+e.violatedDirective));
window.addEventListener('unhandledrejection',e=>{observations.blocked.push('Unhandled '+String(e.reason));e.preventDefault()});
async function inputElement(el,value){assert(el instanceof HTMLInputElement||el instanceof HTMLTextAreaElement,'Actual editable control');el.focus();
 const proto=el instanceof HTMLTextAreaElement?HTMLTextAreaElement.prototype:HTMLInputElement.prototype;
 Object.getOwnPropertyDescriptor(proto,'value').set.call(el,value);el.dispatchEvent(new InputEvent('input',{bubbles:true,inputType:'insertText',data:value}));el.dispatchEvent(new Event('change',{bubbles:true}));await delay(0)}
function buttons(scope){return [...scope.querySelectorAll('button')]}
function button(scope,label){const found=buttons(scope).filter(b=>text(b)===label);assert(found.length===1,'One actual button '+label);return found[0]}
function dialog(h){const d=h.el.querySelector('[role="dialog"]');assert(d,'Actual acceptance modal');return d}
async function click(scope,label){const b=button(scope,label);await waitFor(()=>!b.disabled,'Enabled '+label);b.click();await delay(0)}
async function mount(entry,config={}){
 const e=clone(entry),p=documentOf(e),state={entry:e,ownerId:e.ownerId,customerId:e.commitResponse.receipt.customer_id,token:'synthetic-browser-'+serial+++'-not-a-credential',
   open:true,recorded:0,recordedEvents:[],callbackLabel:'original-opening',closed:0,previews:[],commits:[],reconciles:[],saveWrites:[],saveClosed:0,...config};
 state.data=config.data??portalData(e);state.props={quoteNumber:'CACHED-NUMBER',customerName:'Cached customer',total:909,travelFee:999,
   options:clone(p.options),presetOptionId:e.optionId,termsText:'CACHED TERMS NOT FOR CONFIRMATION',selectedAddonsTotal:999,...config.props};
 const transport={
   preview:async(request,signal)=>{state.previews.push(clone(request));observeRequest('preview',request);assert(request.quoteId===state.entry.quoteId,'Exact requested quote');
     return state.preview?state.preview(request,signal):clone(state.entry.previewResponse)},
   commit:async(request,signal)=>{state.commits.push(clone(request));observeRequest('commit',request);
     same(request.expected,state.entry.previewResponse.expected,'Immutable exact displayed native expected');same(request.addonIds,documentOf(state.entry).included_addon_ids,'Exact included addon IDs');
     assert(request.optionId===state.entry.optionId,'Exact offered choice');assert(request.clientOperationId===state.entry.commitResponse.clientOperationId,'Captured operation correlation');
     return state.commit?state.commit(request,signal):clone(state.entry.commitResponse)},
   reconcile:async(request,signal)=>{state.reconciles.push(clone(request));observeRequest('reconcile',request);same(request,state.commits[0],'Reconcile uses complete immutable dispatched request');
     return state.reconcile?state.reconcile(request,signal):{code:'unknown',clientOperationId:request.clientOperationId,previewRevision:request.expected.previewRevision}},
 };
 const el=document.createElement('section');document.body.append(el);const root=createRoot(el);
 const render=()=>{activeState=state;knownTokens.add(state.token);const callback={label:state.callbackLabel,quoteId:state.entry.quoteId,ownerId:state.ownerId};flushSync(()=>root.render(<React.StrictMode>
   {(e.mode==='owner'||state.save)&&!state.withoutOwner&&<CacheOwner key={state.ownerId} id={state.ownerId}/>}<Toaster/>
   {e.mode==='portal'?<PortalClient key={state.portalKey??'portal'} token={state.token} initialData={state.data} pilotAcceptance={state.capability===false?undefined:transport}/>
    :<><ConfirmHost/><RecordAcceptanceDialog open={state.open} quoteId={state.entry.quoteId} {...state.props}
       onClose={()=>{state.closed++;state.open=false;render()}} onRecorded={()=>{state.recorded++;state.recordedEvents.push(callback)}} pilotAcceptance={state.capability===false?undefined:{ownerId:state.ownerId,transport}}/></>}
   {state.save&&<div data-save-editor><PilotQuoteSaveEditorShell quoteId={state.entry.quoteId} context={saveContext(state)}
     loadBaseline={async()=>saveBaseline(state)} write={async intent=>{state.saveWrites.push(clone(intent));return state.saveWrite?state.saveWrite(intent):{code:'stale_editor'}}}
     readReconciliation={async()=>({code:'conflict'})} onClose={()=>state.saveClosed++}/></div>}
 </React.StrictMode>))};
 const h={el,root,state,render,unmount(){flushSync(()=>root.unmount());el.remove();roots=roots.filter(x=>x!==h);if(activeState===state)activeState=null}};
 roots.push(h);render();await delay(0);return h;
}
async function launch(h,{home=false,reuse=false}={}){
 if(h.state.entry.mode==='owner'){await waitFor(()=>h.el.querySelector('[role="dialog"]'),'Owner modal opens');return}
 if(!home){const nav=h.el.querySelector('#porttab-billing');assert(nav,'Actual Billing navigation');nav.click();await delay(0)}
 const p=documentOf(h.state.entry);
 if(!home&&p.options.length){const choices=buttons(h.el).filter(b=>b.hasAttribute('aria-pressed'));if(!reuse)assert(choices.every(b=>b.getAttribute('aria-pressed')==='false'),'No recommended option preselected');
   const choice=choices.find(b=>text(b).includes(p.options.find(o=>o.id===h.state.entry.optionId).name));assert(choice,'Actual chosen option control');choice.click();await delay(0)}
 if(!home){const old=h.el.querySelector('input[type="checkbox"]');if(old&&!old.checked){old.click();await delay(0)}}
 const launchButton=buttons(h.el).find(b=>/^Accept(?: |—)/.test(text(b)));assert(launchButton,'Actual portal accept entry');await waitFor(()=>!launchButton.disabled,'Portal launch enabled');launchButton.click();
 await waitFor(()=>h.el.querySelector('[role="dialog"]'),'Actual portal modal opens');
}
async function review(h){await waitFor(()=>h.el.querySelector('[role="dialog"]')?.textContent.includes(documentOf(h.state.entry).quote_number),'Native preview displayed');return dialog(h)}
function primary(d){const candidates=buttons(d).filter(b=>['Accept this quote','Record this acceptance'].includes(text(b)));assert(candidates.length===1,'Single actual confirmation action');return candidates[0]}
function hasAcceptedUi(h){const d=h.el.querySelector('[role="dialog"]');if(!d)return false;
 const message=h.state.entry.mode==='owner'?'This customer acceptance is recorded by you.':'Your acceptance is recorded.';
 return [...d.querySelectorAll('[role="status"]')].some(p=>text(p)===message)
   && [...d.querySelectorAll('p')].some(p=>text(p)==='Recorded amount: '+formatCurrency(h.state.entry.commitResponse.receipt.accepted_amount))
   && !buttons(d).some(b=>['Accept this quote','Record this acceptance'].includes(text(b)));
}
function accepted(h){return hasAcceptedUi(h)&&(h.state.entry.mode!=='owner'||h.state.recorded===1)}
async function consent(h){const d=await review(h);
 if(h.state.entry.mode==='owner'){const label=ON_BEHALF_REASONS.find(r=>r.value===(h.state.entry.reason??'text_message')).label;await click(d,label);
   const note=d.querySelector('textarea');if(note&&h.state.entry.note)await inputElement(note,h.state.entry.note)}
 else {const checkbox=d.querySelector('input[type="checkbox"]');if(checkbox&&!checkbox.checked){checkbox.click();await delay(0)}}
 return d;
}
async function dispatch(h){const d=await consent(h),b=primary(d);await waitFor(()=>!b.disabled,'Explicit confirmation ready');
 operationQueue.push(h.state.entry.commitResponse.clientOperationId);b.click();await waitFor(()=>h.state.commits.length===1,'One actual acceptance dispatch');return d}
function assertDocument(h){const d=dialog(h),p=documentOf(h.state.entry),content=d.textContent;
 for(const value of [p.customer_name,p.quote_number,p.address,p.service_type,p.notes,p.terms_text,p.company_name].filter(v=>typeof v==='string'&&v.length))assert(content.includes(value),'Native public text shown: '+String(value).slice(0,60));
 assert(content.includes(formatCurrency(p.accepted_amount)),'Native accepted amount shown');
 const serviceRows=[...d.querySelectorAll('[aria-label="Quoted service and material lines"] > li')];assert(serviceRows.length===p.services.length,'Every ordered native service displayed');
 p.services.forEach((line,index)=>{const row=serviceRows[index].textContent;assert(row.includes(line.service_type),'Native service order/name');if(line.notes)assert(row.includes(line.notes),'Native service note');
   assert(row.includes(String(line.quantity))&&row.includes(formatCurrency(line.unit_price)),'Native quantity/unit price');if(line.unit)assert(row.includes(line.unit),'Native unit');
   if(line.est_minutes!==null)assert(row.includes(String(line.est_minutes)),'Native duration');if(line.kind==='material')assert(row.includes('material'),'Material classification');
   if(line.discount_type!==null)assert(row.includes('Discount'),'Native discount displayed')});
 const included=d.querySelector('[aria-label="Included extras"]');assert(included,'Explicit included extras section');
 for(const a of p.addons.filter(a=>a.is_selected)){assert(included.textContent.includes(a.name)&&included.textContent.includes(formatCurrency(a.price)),'Included native extra itemized')}
 for(const a of p.addons.filter(a=>!a.is_selected)){assert(!included.textContent.includes(a.name),'Unselected extra not represented as included');assert(d.querySelector('[aria-label="Not included"]')?.textContent.includes(a.name),'Unselected extra explicitly excluded')}
 if(p.offered_option_id){const chosen=p.options.find(o=>o.id===p.offered_option_id);assert(content.includes(chosen.name),'Native chosen option');if(chosen.description)assert(content.includes(chosen.description),'Chosen option scope')}
 for(const o of p.options.filter(o=>o.id!==p.offered_option_id))assert(d.querySelector('[aria-label="Not included"]')?.textContent.includes(o.name),'Unchosen option explicitly excluded');
 if(p.gst_percent>0)assert(content.includes('GST ('+p.gst_percent+'%)'),'Native GST displayed');
 for(const [cadence,amount] of [['weekly',p.weekly_price],['bi-weekly',p.biweekly_price],['monthly',p.monthly_price]])if(amount>0)assert(content.includes(formatCurrency(amount)+' per '+cadence+' visit'),'Native recurring price is per visit');
 if(p.valid_until)assert(content.includes(p.valid_until),'Bound validity date shown');
 for(const forbidden of ['CACHED-NUMBER','CACHED TERMS NOT FOR CONFIRMATION','Cached customer','PRIVATE_SENTINEL_NOT_FOR_PREVIEW','internal_notes','no_charge_reason','terms_payment_claim',h.state.token])assert(!content.includes(forbidden),'Forbidden/cached content absent');
}
const results=[];
async function test(name,fn){let failure=null;try{await fn();inspectStorage()}catch(e){failure=e}
 finally{for(const h of [...roots])h.unmount();try{inspectStorage()}catch(e){failure??=e}operationQueue=[];localStorage.clear();sessionStorage.clear();await delay(0)}
 if(failure){results.push({name,pass:false,error:String(failure.message).slice(0,1200)});observations.cases.push({name,pass:false})}
 else{results.push({name,pass:true});observations.cases.push({name,pass:true})}}

// The following controls consume literal successful native HTTP response bodies.
// Token authority is synthetic in this browser. No browser-to-database claim.
for(const native of NATIVE)await test('actual acceptance '+RESPONSE_BASIS+' response replay: '+native.name,async()=>{
 const h=await mount(native);await launch(h);await review(h);assertDocument(h);
 if(h.state.entry.mode==='owner')assert(primary(dialog(h)).disabled,'Owner reason is never defaulted');
 else if(documentOf(h.state.entry).terms_text?.trim()){const checkbox=dialog(h).querySelector('input[type="checkbox"]');assert(checkbox&&!checkbox.checked,'Old card assent does not authorize native terms');assert(dialog(h).textContent.includes(TERMS_ACK_LABEL),'Canonical terms wording');assert(primary(dialog(h)).disabled,'Explicit native terms required')}
 await dispatch(h);await waitFor(()=>accepted(h),'Bound direct receipt and recorded amount');
 same(h.state.commits[0].expected,native.previewResponse.expected,'Literal native preview survived actual full caller');
 same(h.state.commits[0].addonIds,documentOf(native).included_addon_ids,'Exact native selected addon set survived caller');
 assert(h.state.reconciles.length===0,'Direct bound receipt needs no reconciliation');assert(h.state.closed===0,'Accepted document remains visible');
 if(native.mode==='owner')assert(h.state.recorded===1,'Originating owner callback once');
 observations.fixtureReplay.push({name:native.name,mode:native.mode,quoteId:native.quoteId,exactPreview:true,exactCommitReply:true,syntheticBrowserAuthority:true,basis:RESPONSE_BASIS});
});

for(const mode of ['portal','owner'])for(const failure of ['null','refused','throw'])await test('actual '+mode+' acceptance: '+failure+' preview never uses cached document',async()=>{
 const h=await mount(variant(mode),{preview:()=>{if(failure==='throw')throw Error('Synthetic preview loss');return failure==='null'?null:{code:'refused',reason:'not_found'}}});
 await launch(h);await waitFor(()=>dialog(h).querySelector('[role="alert"]'),'Explicit preview refusal');
 assert(!dialog(h).querySelector('[data-pilot-acceptance-document]'),'No cached confirmation document');
 assert(!buttons(dialog(h)).some(b=>['Accept this quote','Record this acceptance'].includes(text(b))),'No confirmation after failed preview');
 assert(h.state.commits.length===0&&h.state.reconciles.length===0,'Read failure cannot write or reconcile');
});
for(const mode of ['portal','owner'])await test('actual '+mode+' acceptance: double input dispatches once and freezes controls',async()=>{
 const noCharge=NATIVE.find(e=>documentOf(e).no_charge&&documentOf(e).accepted_amount===0);assert(noCharge,'Declared no-charge fixture');
 const pending=defer(),h=await mount(variant(mode,null,noCharge),{commit:()=>pending.promise});await launch(h);const d=await dispatch(h);
 assert(!hasAcceptedUi(h)&&!accepted(h),'No-charge wording is not an acceptance acknowledgement while write is pending');
 assert(primary(d).disabled,'Confirmation disabled during write');primary(d).click();document.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',ctrlKey:true,bubbles:true}));
 for(const control of d.querySelectorAll('textarea,input,fieldset button'))assert(control.matches(':disabled'),'Consent controls disabled during write');
 assert(h.state.commits.length===1,'Synchronous single-operation guard');pending.resolve(clone(h.state.entry.commitResponse));
 await waitFor(()=>accepted(h),'Bound direct recorded state');assert(h.state.commits.length===1&&h.state.reconciles.length===0,'No replay or unnecessary read');
});
for(const mode of ['portal','owner'])await test('actual '+mode+' acceptance: lost response survives close and remount without replay',async()=>{
 const entry=variant(mode),h=await mount(entry,{commit:()=>Promise.reject(Error('Synthetic lost response'))});await launch(h);await dispatch(h);
 await waitFor(()=>h.state.reconciles.length===1,'One immediate read-only reconciliation');assert(!hasAcceptedUi(h),'Unknown is not success');
 const token=h.state.token,counts={writes:h.state.commits.length,previews:h.state.previews.length};await click(dialog(h),'Close');h.unmount();
 const reopened=await mount(entry,{token});await launch(reopened);await waitFor(()=>dialog(reopened).querySelector('[role="alert"]'),'Remounted unresolved tombstone');
 assert(reopened.state.previews.length===0&&reopened.state.commits.length===0&&reopened.state.reconciles.length===0,'Remount cannot read a new actionable preview or replay');
 assert(counts.writes===1&&counts.previews>=1,'Original operation dispatched once');
 assert(!buttons(dialog(reopened)).some(b=>['Accept this quote','Record this acceptance'].includes(text(b))),'Unknown has no write action');
});
for(const mode of ['portal','owner'])for(const fault of ['wrong_amount','wrong_operation','wrong_actor'])await test('actual '+mode+' acceptance: '+fault+' reply stays unknown',async()=>{
 const entry=variant(mode),response=clone(entry.commitResponse);
 if(fault==='wrong_amount')response.receipt.accepted_amount=99999;
 if(fault==='wrong_operation')response.clientOperationId=uuid(serial++);
 if(fault==='wrong_actor')response.receipt.actor_id=uuid(serial++);
 const h=await mount(entry,{commit:()=>response});await launch(h);await dispatch(h);await waitFor(()=>h.state.reconciles.length===1,'Malformed write reply reconciled once');
 assert(!hasAcceptedUi(h),'Malformed receipt cannot report success');assert(h.state.recorded===0&&h.state.closed===0,'No success callback or dismissal');
});
await test('actual owner acceptance: ordinary parent refresh cannot replace the displayed review or opening callback',async()=>{
 const h=await mount(variant('owner'));await launch(h);await consent(h);const before=dialog(h).querySelector('[data-pilot-acceptance-document]').textContent;
 const reads=h.state.previews.length;h.state.props={...h.state.props,quoteNumber:'UNRELATED-NEW-NUMBER',customerName:'Unrelated name',termsText:'UNRELATED NEW TERMS',total:90909,presetOptionId:null};h.state.callbackLabel='later-render-callback';h.render();await delay(0);
 assert(dialog(h).querySelector('[data-pilot-acceptance-document]').textContent===before,'Unrelated props cannot replace immutable preview');assert(h.state.previews.length===reads,'No implicit preview rebase');
 assert(dialog(h).querySelector('[aria-pressed="true"]'),'Attestation still belongs to unchanged displayed preview');
 await dispatch(h);await waitFor(()=>accepted(h),'Direct acceptance after parent refresh');same(h.state.recordedEvents,[{label:'original-opening',quoteId:h.state.entry.quoteId,ownerId:h.state.ownerId}],'Only captured opening callback notified');
});
for(const mode of ['portal','owner'])await test('actual '+mode+' acceptance: option reload hides old review and resets assent',async()=>{
 const base=NATIVE.find(e=>documentOf(e).options.length>=2);assert(base,'Native options fixture with alternatives');
 const entry=variant(mode,null,base),h=await mount(entry);await launch(h);await consent(h);
 const old=documentOf(entry),alternative=old.options.find(o=>o.id!==entry.optionId);assert(alternative,'Other real option');
 const next=clone(entry);next.optionId=alternative.id;documentOf(next).offered_option_id=alternative.id;documentOf(next).terms_text='Synthetic replacement terms requiring fresh assent';
 next.previewResponse.expected.previewRevision='d'.repeat(32);next.commitResponse.previewRevision='d'.repeat(32);next.commitResponse.receipt.selected_option_id=alternative.id;
 const waiting=defer();h.state.preview=()=>waiting.promise;await click(dialog(h),alternative.name);
 await waitFor(()=>/Loading the current quote/.test(dialog(h).textContent),'Choice reload began');assert(!dialog(h).querySelector('[data-pilot-acceptance-document]'),'Old document hidden during choice reload');
 h.state.entry=next;waiting.resolve(clone(next.previewResponse));await review(h);
 assert(dialog(h).textContent.includes(documentOf(next).terms_text),'New exact terms shown');assert(primary(dialog(h)).disabled,'New preview needs new assent or owner reason');
 if(mode==='portal')assert(!dialog(h).querySelector('input[type="checkbox"]').checked,'New terms unchecked');
 else assert(!dialog(h).querySelector('[aria-pressed="true"]'),'Reason reset on replacement preview');
 assert(h.state.commits.length===0,'Changing choice never commits');
});
await test('actual portal acceptance: Home shortcut cannot acknowledge newly appeared terms',async()=>{
 const base=NATIVE.find(e=>documentOf(e).options.length===0);assert(base,'Native no-option fixture');
 const entry=variant('portal',(e,p)=>{p.terms_text='Synthetic terms appeared after the Home card loaded'},base),data=portalData(entry);data.business.terms_text=null;
 const h=await mount(entry,{data});await launch(h,{home:true});await review(h);
 const checkbox=dialog(h).querySelector('input[type="checkbox"]');assert(checkbox&&!checkbox.checked,'Home true hint is not consent to new terms');
 assert(primary(dialog(h)).disabled&&h.state.commits.length===0,'Must explicitly acknowledge new native terms');
});
for(const mode of ['portal','owner'])await test('actual '+mode+' acceptance: expired preview has no confirmation action',async()=>{
 const entry=variant(mode,(e,p)=>{p.valid_until='2000-01-01'}),h=await mount(entry,{data:portalData(entry,{valid_until:null})});
 await launch(h);await waitFor(()=>dialog(h).textContent.includes('expired'),'Bound validity refusal');
 assert(!buttons(dialog(h)).some(b=>['Accept this quote','Record this acceptance'].includes(text(b))),'Expired preview cannot confirm');assert(h.state.commits.length===0,'No expired write');
});
for(const mode of ['portal','owner'])await test('actual '+mode+' acceptance: price absent is not a no-charge declaration',async()=>{
 const base=NATIVE.find(e=>documentOf(e).options.length===0),entry=variant(mode,(e,p)=>{p.initial_price=null;p.no_charge=false},base);
 const h=await mount(entry);await launch(h);await consent(h);
 assert(dialog(h).querySelector('[aria-label="Quote amount"]').textContent.includes('Price needed'),'Null base explicitly needs a price even with extras');
 assert(!dialog(h).textContent.includes('Recorded as no charge'),'No invented no-charge declaration');assert(primary(dialog(h)).disabled&&h.state.commits.length===0,'Unpriced cannot commit');
});

for(const mode of ['portal','owner'])await test('actual '+mode+' acceptance: losing the capability never falls through to legacy writes',async()=>{
 const h=await mount(variant(mode));await launch(h);await review(h);const reads=h.state.previews.length;
 h.state.capability=false;h.render();await delay(0);
 assert(h.state.commits.length===0,'Capability removal did not submit');
 const d=h.el.querySelector('[role="dialog"]');if(d)for(const b of buttons(d))if(['Accept this quote','Record this acceptance'].includes(text(b)))assert(b.disabled,'Unavailable capability cannot confirm');
 if(mode==='portal'){const launchButton=buttons(h.el).find(b=>/^Accept(?: |—)/.test(text(b)));if(launchButton)launchButton.click();await delay(0)}
 assert(h.state.previews.length===reads&&h.state.commits.length===0,'No fallback preview/write while unavailable');
});
for(const mode of ['portal','owner'])await test('actual '+mode+' acceptance: a second preopened confirmation cannot dispatch around the first',async()=>{
 const entry=variant(mode),pending=defer(),first=await mount(entry,{commit:()=>pending.promise});await launch(first);await consent(first);
 const second=await mount(entry,{token:first.state.token,withoutOwner:mode==='owner'});await launch(second);await consent(second);
 await dispatch(first);const b=primary(dialog(second));b.click();await waitFor(()=>/Another confirmation|already submitted|not sent/i.test(dialog(second).textContent),'Second review explains pending authority');
 assert(first.state.commits.length===1&&second.state.commits.length===0,'Shared authority/quote registry blocks second preopened dispatch');
 pending.resolve(clone(first.state.entry.commitResponse));await waitFor(()=>accepted(first),'First acceptance acknowledged');
 assert(second.state.recorded===0,'Second caller cannot borrow first success');
});
for(const mode of ['portal','owner'])await test('actual '+mode+' acceptance: authority change rejects late preview',async()=>{
 const pending=defer(),h=await mount(variant(mode),{preview:()=>pending.promise});await launch(h);await waitFor(()=>h.state.previews.length>0,'Original preview dispatched');
 h.state.preview=()=>({code:'refused',reason:'not_found'});
 if(mode==='owner')h.state.ownerId=uuid(serial++);else h.state.token='synthetic-replacement-'+serial++;
 h.render();pending.resolve(clone(h.state.entry.previewResponse));await delay(30);
 assert(!h.el.querySelector('[data-pilot-acceptance-document]'),'Late old-authority document not shown');assert(h.state.commits.length===0&&h.state.recorded===0,'No stale authority callbacks');
});
for(const mode of ['portal','owner'])await test('actual '+mode+' acceptance: leaving and returning during a write retains unknown protection',async()=>{
 const pending=defer(),entry=variant(mode),h=await mount(entry,{commit:()=>pending.promise});await launch(h);await dispatch(h);
 const originalOwner=h.state.ownerId,originalToken=h.state.token,reads=h.state.previews.length;
 if(mode==='owner'){h.state.open=false;h.render();h.state.ownerId=uuid(serial++);h.render()}
 else {h.state.token='synthetic-other-authority-'+serial++;h.render()}
 pending.resolve(clone(entry.commitResponse));await delay(30);
 assert(h.state.recorded===0,'A late response cannot notify a retired owner dialog');assert(!hasAcceptedUi(h),'Late result cannot update another authority');
 h.state.ownerId=originalOwner;h.state.token=originalToken;h.state.open=true;h.render();await launch(h);
 await waitFor(()=>dialog(h).querySelector('[role="alert"]'),'Returning authority sees unresolved protection');
 assert(h.state.previews.length===reads&&h.state.commits.length===1,'Return cannot mint a new actionable preview or acceptance');
 assert(!buttons(dialog(h)).some(b=>['Accept this quote','Record this acceptance'].includes(text(b))),'No confirmation action after retired dispatch');
});
await test('actual owner acceptance: changing quote during a write cannot invoke a new quote callback',async()=>{
 const pending=defer(),entry=variant('owner'),h=await mount(entry,{commit:()=>pending.promise});await launch(h);await dispatch(h);
 const next=variant('owner');next.ownerId=h.state.ownerId;next.commitResponse.receipt.actor_id=h.state.ownerId;
 h.state.entry=next;h.state.props={...h.state.props,presetOptionId:next.optionId};h.render();pending.resolve(clone(entry.commitResponse));await review(h);
 assert(h.state.recorded===0,'Old quote result cannot call new dialog callback');assert(dialog(h).textContent.includes(documentOf(next).quote_number),'New quote review remains current');
 assert(!hasAcceptedUi(h),'New quote never borrows old acceptance');
});
for(const mode of ['portal','owner'])await test('actual '+mode+' acceptance: midnight expiry is checked again before dispatch',async()=>{
 const entry=variant(mode,(e,p)=>{p.valid_until='2099-01-01'}),h=await mount(entry);await launch(h);const d=await consent(h),NativeDate=Date;
 try{globalThis.Date=class extends NativeDate{constructor(...args){super(...(args.length?args:['2100-01-01T12:00:00Z']))}static now(){return new NativeDate('2100-01-01T12:00:00Z').getTime()}};
   primary(d).click();await delay(0);assert(h.state.commits.length===0,'Expiry rechecked immediately before sending');assert(/expired/i.test(d.textContent),'Expiry explanation shown');
 }finally{globalThis.Date=NativeDate}
});
await test('actual owner acceptance: oversized optional note stays editable and refuses before dispatch',async()=>{
 const h=await mount(variant('owner'));await launch(h);const d=await consent(h),note=d.querySelector('textarea');assert(note,'Actual owner note');
 await inputElement(note,'Synthetic note '.repeat(16000));primary(d).click();await waitFor(()=>/too large or incomplete/i.test(d.textContent),'Bounded complete-request refusal');
 assert(h.state.commits.length===0&&note.value.length>200000,'Oversized note retained without truncation');
 await inputElement(note,'A short explicit note');assert(!primary(d).disabled,'No pending tombstone before any actual dispatch');
});

// Fixed $200, note-only synthetic Save document. This supplies complete transport
// fixtures, not a Save planner or pricing engine. Native race ordering remains a
// separate source-bound database proof with real blocking observations.
function coupledEntry(mode){return variant(mode,(e,p)=>{
 Object.assign(p,{initial_price:200,travel_fee:0,addons_total:0,total:200,accepted_amount:200,weekly_price:0,biweekly_price:0,monthly_price:0,
 deposit_type:null,deposit_value:null,options:[],services:[],addons:[],included_addon_ids:[],offered_option_id:null,selected_option_id:null,no_charge:false,terms_text:null});
 e.optionId=null;Object.assign(e.commitResponse.receipt,{accepted_amount:200,selected_option_id:null,addon_ids:[]});
})}
function saveValues(state){const p=documentOf(state.entry);return {customer_id:state.customerId,customer_name:p.customer_name,customer_phone:'',customer_email:'',acquisition_source:'',
 address:p.address,service_type:p.service_type,service_template_id:uuid(8),initial_price:200,weekly_price:0,biweekly_price:0,monthly_price:0,measured_sqft:0,measurement_snapshot:null,
 suggested_price:0,value_grade:null,nearby_count:null,overgrowth_multiplier:1,distance_km:0,hours:2,crew_size:1,rate:100,travel_fee:0,custom_travel_required:false,
 show_travel_separately:false,notes:p.notes??'',internal_notes:'Synthetic internal Save note',status:'sent',services:[],has_options:false,options:[],deposit_type:'',deposit_value:0}}
function saveContext(state){const p=documentOf(state.entry);return {code:'ready',complete:true,ownerId:state.ownerId,settings:null,tiers:[],
 customers:[{id:state.customerId,user_id:state.ownerId,created_at:STAMP,updated_at:STAMP,name:p.customer_name,email:null,phone:null,address:p.address,city:null,province:null,postal_code:null,
 notes:null,tags:[],acquisition_source:null,referred_by_customer_id:null,preferred_days:null,avoid_days:null,pref_time_start:null,pref_time_end:null,sms_opt_in:false,email_opt_in:false}],
 templates:[{id:uuid(8),user_id:state.ownerId,created_at:STAMP,updated_at:STAMP,name:p.service_type,category:'Synthetic',default_rate:100,pricing_display_type:'hourly',default_description:null,
 notes:null,is_active:true,published_at:null,sort_order:0,unit_cost:null,material_cost:null,is_favorite:false,recurrence:'one_time',form_template_id:null,measured_by:null}]}}
function saveBaseline(state){return {version:1,code:'baseline',complete:true,ownerId:state.ownerId,quoteId:state.entry.quoteId,editorRevision:REV,
 quoteNumber:documentOf(state.entry).quote_number,quoteUpdatedAt:STAMP,selectedOption:null,acceptance:{hasRecord:false,current:false},values:saveValues(state)}}
function saveReceipt(state,intent){const p=documentOf(state.entry);return {code:'committed',owner_id:state.ownerId,quote_id:state.entry.quoteId,
 client_operation_id:intent.clientOperationId,editor_generation:intent.editorGeneration,before_revision:REV,after_revision:'e'.repeat(32),
 quote:{id:state.entry.quoteId,user_id:state.ownerId,quote_number:p.quote_number,updated_at:STAMP,customer_id:state.customerId,customer_name:p.customer_name,property_id:null,
 address:p.address,service_type:p.service_type,service_template_id:uuid(8),initial_price:200,weekly_price:0,biweekly_price:0,monthly_price:0,hours:2,crew_size:1,rate:100,travel_fee:0,
 overgrowth_multiplier:1,custom_travel_required:false,show_travel_separately:false,notes:intent.values.notes,internal_notes:'Synthetic internal Save note',measured_sqft:0,measurement_snapshot:null,
 suggested_price:0,value_grade:null,nearby_count:null,price_source:null,pricing_config_version_id:null,deposit_type:null,deposit_value:null,status:'sent',selected_option_id:null,accepted_price:null,
 total:200,subtotal:200,man_hours:2},options:[],services:[],measurement:null,acceptance_current:false,
 identity:{code:'unchanged',quote_id:state.entry.quoteId,customer_id:state.customerId,customer_name:p.customer_name,property_id:null,updated_at:STAMP,created_customer:false,created_property:false,matched_by:null}}}
async function typeSaveNote(h,note){await waitFor(()=>h.el.querySelector('[data-save-editor] form'),'Actual Save editor mounted');
 const field=h.el.querySelector('[data-save-editor] [name="notes"]');assert(field,'Actual public Save note');await inputElement(field,note)}
async function submitSave(h){const b=h.el.querySelector('[data-save-editor] button[type="submit"]');assert(b,'Actual Save action');await waitFor(()=>!b.disabled,'Save enabled');b.click();await waitFor(()=>h.state.saveWrites.length===1,'Actual Save transport reached')}
for(const mode of ['portal','owner'])await test('actual '+mode+' confirmation plus Save: Save acknowledgement leaves old preview stale',async()=>{
 const entry=coupledEntry(mode),h=await mount(entry,{save:true});h.state.saveWrite=intent=>saveReceipt(h.state,intent);
 await launch(h);await review(h);const original=clone(h.state.entry.previewResponse.expected),shown=dialog(h).querySelector('[data-pilot-acceptance-document]').textContent;
 await typeSaveNote(h,'Synthetic changed scope while acceptance modal remained open');await submitSave(h);
 await waitFor(()=>Object.keys(localStorage).some(k=>k.startsWith('eq:quote-save:committed:')),'Actual Save acknowledged and preserved receipt');
 assert(dialog(h).querySelector('[data-pilot-acceptance-document]').textContent===shown,'Save cannot silently replace acceptance preview');
 h.state.commit=request=>({code:'refused',clientOperationId:request.clientOperationId,previewRevision:request.expected.previewRevision,reason:'quote_changed'});
 await dispatch(h);await waitFor(()=>dialog(h).textContent.includes('quote changed'),'Explicit stale-confirmation refusal');
 same(h.state.commits[0].expected,original,'Original immutable confirmation sent after Save');assert(h.state.previews.length===1,'No silent preview refresh/rebase');
 assert(h.state.recorded===0&&h.state.reconciles.length===0,'Known stale refusal is not recorded or retried');
});
for(const mode of ['portal','owner'])await test('actual '+mode+' confirmation plus Save: accepted receipt cannot authorize stale editor overwrite',async()=>{
 const stale=defer(),h=await mount(coupledEntry(mode),{save:true,saveWrite:()=>stale.promise});await typeSaveNote(h,'Synthetic unsaved scope before customer acceptance');await launch(h);await dispatch(h);
 await waitFor(()=>accepted(h),'Acceptance acknowledged');await submitSave(h);
 stale.resolve({code:'stale_editor'});await waitFor(()=>{
   const entries=Object.keys(localStorage).filter(k=>k.startsWith('eq:quote-save:pending:')).map(k=>JSON.parse(localStorage.getItem(k)));
   return entries.length===1&&entries[0].state==='unknown';
 },'Stale response handled and unresolved Save recovery retained');
 await waitFor(()=>h.el.querySelector('[data-save-editor]').textContent.includes('We could not confirm this Save. Your submitted copy and current edits are kept. Review recovery before saving again.'),'Actual Save recovery UI after handled response');
 assert(!Object.keys(localStorage).some(k=>k.startsWith('eq:quote-save:committed:')),'No committed Save receipt after stale response');
 assert(!h.el.querySelector('[data-save-editor]').textContent.includes('Submitted version saved'),'No successful Save claim after stale response');
 assert(h.state.saveWrites[0].expectedEditorRevision===REV,'Original editor revision preserved');
 assert(h.el.querySelector('[data-save-editor] [name="notes"]').value==='Synthetic unsaved scope before customer acceptance','Stale Save retains current typing');
 assert(h.state.saveWrites.length===1&&h.state.commits.length===1,'No acceptance or Save replay');
});
for(const mode of ['portal','owner'])await test('actual '+mode+' acceptance: explicit reopen reviews a separately saved new version after acknowledgement',async()=>{
 const entry=variant(mode),h=await mount(entry);await launch(h);await dispatch(h);await waitFor(()=>accepted(h),'First direct receipt');
 const reads=h.state.previews.length,old=clone(h.state.entry),next=clone(old);documentOf(next).notes='Synthetic separately saved new public scope';
 next.previewResponse.expected.previewRevision='f'.repeat(32);next.previewResponse.expected.priorAcceptanceId=old.commitResponse.receipt.acceptance_id;
 next.previewResponse.expected.priorAcceptanceSeq=old.commitResponse.receipt.acceptance_seq;
 next.commitResponse.previewRevision='f'.repeat(32);next.commitResponse.clientOperationId=uuid(serial++);next.commitResponse.receipt.acceptance_id=uuid(serial++);
 next.commitResponse.receipt.previous_acceptance_id=old.commitResponse.receipt.acceptance_id;next.commitResponse.receipt.acceptance_seq=old.commitResponse.receipt.acceptance_seq+1;
 h.state.entry=next;h.render();assert(h.state.previews.length===reads,'Saved version notification cannot silently replace acknowledged document');
 assert(!dialog(h).textContent.includes(documentOf(next).notes),'Acknowledged document remains immutable');
 await click(dialog(h),'Close');h.state.open=true;h.render();await launch(h,{reuse:true});await review(h);
 await waitFor(()=>dialog(h).textContent.includes(documentOf(next).notes),'Explicit reopen obtains new saved preview');
 assert(h.state.previews.length===reads+1,'Exactly one explicit new preview');assert(!hasAcceptedUi(h),'New version is not pre-accepted');
 assert(h.state.commits.length===1,'Explicit review does not write');
});
await test('actual owner acceptance: capability and lease recovery preserve the acknowledged document until explicit reopen',async()=>{
 const h=await mount(variant('owner'));await launch(h);await dispatch(h);await waitFor(()=>accepted(h),'Direct receipt');
 const content=dialog(h).querySelector('[data-pilot-acceptance-document]').textContent,reads=h.state.previews.length,callbacks=h.state.recorded;
 h.state.capability=false;h.render();await delay(0);h.state.capability=true;h.render();await review(h);
 assert(h.state.previews.length===reads&&h.state.recorded===callbacks,'Capability recovery neither previews nor fires callback');
 assert(dialog(h).querySelector('[data-pilot-acceptance-document]').textContent===content&&accepted(h),'Acknowledged document retained after capability recovery');
 h.state.withoutOwner=true;h.render();await delay(0);h.state.withoutOwner=false;h.render();await review(h);
 assert(h.state.previews.length===reads&&h.state.recorded===callbacks,'Same-owner lease recovery neither previews nor fires callback');
 assert(dialog(h).querySelector('[data-pilot-acceptance-document]').textContent===content&&accepted(h),'Acknowledged document retained after new lease');
});
await test('actual acceptance full-component boundary: no legacy writes, providers, token persistence or leaked owner',async()=>{
 assert(observations.blocked.length===0,observations.blocked.join('; '));assert(observations.navigation.length===0,'No external navigation');
 assert(observations.fixtureReplay.length===NATIVE.length,'Every response-only fixture actually displayed and accepted');
 assert(observations.preCleanupStorageChecks>=results.length,'Every completed case inspected storage before cleanup');
 assert(getCacheOwner()===null,'Actual final CacheOwner unmount cleared owner');assert(localStorage.length===0&&sessionStorage.length===0,'Owned isolated browser storage cleaned');
});

XMLHttpRequest.prototype.open=originalXHR;
Storage.prototype.setItem=originalSetItem;
Object.defineProperty(crypto,'randomUUID',{configurable:true,value:originalRandomUUID});
window.__pilotEvidence={...observations,scope:'Full actual dormant acceptance callers and modal; synthetic transports; native HTTP response replay separately labeled',
 excluded:['production routes','live Auth/PostgREST','browser-to-database transport','durable outer-COMMIT attribution','providers','visual layout'],inputMethod:'native DOM input events, not trusted OS keystrokes'};
window.__pilotResults=results;
`
}
