/** Focused actual-component regression. Only auxiliary I/O and acceptance
 * transport are synthetic; this never claims Auth, native SQL or COMMIT proof. */
export function portalRefreshMountedFixture(responseFixtures: unknown[]): string {
  return String.raw`
import React from 'react';
import {createRoot} from 'react-dom/client';
import {flushSync} from 'react-dom';
import {PortalClient} from '@/app/portal/[token]/PortalClient';
import {formatCurrency} from '@/lib/utils';
const INPUT=${JSON.stringify(responseFixtures)};
const base=INPUT.find(value=>value.mode==='portal');
const clone=value=>JSON.parse(JSON.stringify(value));
const assert=(value,message)=>{if(!value)throw Error(message)};
const equal=(a,b,message)=>assert(JSON.stringify(a)===JSON.stringify(b),message);
const tick=()=>new Promise(resolve=>setTimeout(resolve,0));
const originalNow=Date.now,originalFetch=window.fetch,originalOpen=XMLHttpRequest.prototype.open;
const scopes=new Map(),roots=new Set(),knownTokens=new Set();
const observed={reads:[],commits:[],previews:[],fetches:[],blocked:[],unhandled:[],cases:[],cleanup:[]};
let serial=0;
const deny=message=>{observed.blocked.push(message);throw Error(message)};
const errorText=error=>{let value=String(error?.message??error);for(const token of knownTokens)value=value.replaceAll(token,'[synthetic scope]');return value.slice(0,700)};
function deferred(){let resolve,reject;const promise=new Promise((yes,no)=>{resolve=yes;reject=no});return{promise,resolve,reject}}
async function waitFor(predicate,message){const end=originalNow()+2000;while(originalNow()<end){if(predicate())return;await tick()}throw Error(message)}
const text=element=>element.textContent.replace(/\s+/g,' ').trim();
const buttons=element=>[...element.querySelectorAll('button')];
const cardButtons=h=>buttons(h.el).filter(button=>!button.closest('[role="dialog"]')&&/^Accept(?: |—)/.test(text(button)));
const warning=h=>h.el.textContent.includes('We couldn’t refresh your account just now');
const dialog=h=>h.el.querySelector('[role="dialog"]');
function receiptShown(h){
 const modal=dialog(h);
 return !!modal&&[...modal.querySelectorAll('[role="status"]')].some(node=>text(node)==='Your acceptance is recorded.')
  &&[...modal.querySelectorAll('p')].some(node=>text(node)==='Recorded amount: '+formatCurrency(base.commitResponse.receipt.accepted_amount))
  &&!buttons(modal).some(node=>text(node)==='Accept this quote');
}
function portalData(label,status='sent'){
 const p=base.previewResponse.expected.offered.public,r=base.commitResponse.receipt;
 return {customer:{id:r.customer_id,name:label,email:'fixture@example.invalid',phone:'4035550100',address:p.address,city:null,sms_opt_in:false,email_opt_in:false},
 business:{company_name:p.company_name,owner_name:null,phone:null,email_primary:null,email_secondary:null,website:null,logo_url:null,logo_scale:null,
 base_address:null,terms_text:p.terms_text,review_url:null,gst_percent:p.gst_percent,gst_number:null},property:null,properties:[],
 quotes:[{id:base.quoteId,quote_number:p.quote_number,service_type:p.service_type,address:p.address,property_id:null,total:p.total,initial_price:p.initial_price,
 subtotal:p.total,weekly_price:p.weekly_price,biweekly_price:p.biweekly_price,monthly_price:p.monthly_price,notes:p.notes,status,
 created_at:'2026-09-11T12:00:00.000Z',issued_date:'2026-09-11',valid_until:p.valid_until,crew_size:1,hours:1,travel_fee:p.travel_fee,
 services:clone(p.services),options:clone(p.options),selected_option_id:null,accepted_price:status==='accepted'?r.accepted_amount:null,
 deposit_type:p.deposit_type,deposit_value:p.deposit_value}],
 invoices:[],jobs:[],recurrences:[],photos:[],payments:[],change_orders:[],services:[]};
}
function client(){return{
 rpc:async(name,args)=>{
  const scope=scopes.get(args?.p_token);
  if(!scope||Object.keys(args).length!==1)return deny('Unexpected synthetic RPC authority');
  if(name==='portal_get_prefs')return{data:{reminders:false,estimates:false,invoices:false,seasonal:false,marketing:false},error:null};
  if(name!=='get_portal_data')return deny('Legacy or unexpected RPC '+String(name));
  const number=++scope.reads,read=scope.read;
  observed.reads.push({scope:scope.label,number});
  // Capture both authority and handler before awaiting. A later render cannot
  // silently retarget a read that is already dispatched.
  return read?await read(number):{data:clone(scope.data),error:null};
 },
 from:()=>deny('Unexpected table query'),
 storage:new Proxy({},{get:()=>()=>deny('Unexpected storage operation')}),
 auth:{getUser:()=>deny('Unexpected portal authentication'),getSession:()=>deny('Unexpected portal session')},
}}
window.__acceptanceTestIO={client,navigation:[],router:{back:()=>deny('Unexpected navigation'),push:()=>deny('Unexpected navigation'),replace:()=>deny('Unexpected navigation'),refresh:()=>deny('Unexpected navigation')}};
window.fetch=async(input,init)=>{
 const url=new URL(typeof input==='string'?input:input instanceof Request?input.url:String(input),location.origin);
 const method=init?.method??(input instanceof Request?input.method:'GET');
 if(url.origin===location.origin&&url.pathname==='/api/payments/status'&&method==='GET'&&scopes.has(url.searchParams.get('portal'))){
  observed.fetches.push({path:url.pathname,method,synthetic:true});return new Response(JSON.stringify({enabled:false}),{headers:{'content-type':'application/json'}})
 }
 return deny('Unexpected fetch '+method+' '+url.pathname);
};
XMLHttpRequest.prototype.open=function(){return deny('Unexpected XHR')};
const unhandled=event=>{observed.unhandled.push(errorText(event.reason));event.preventDefault()};
const csp=event=>observed.blocked.push('CSP '+event.violatedDirective);
window.addEventListener('unhandledrejection',unhandled);window.addEventListener('securitypolicyviolation',csp);
function scopeFor(label,data){
 const token='synthetic-refresh-'+(++serial)+'-not-a-credential';
 const scope={token,label,data,read:null,reads:0};scopes.set(token,scope);knownTokens.add(token);return scope;
}
async function mount(label,read){
 const a=scopeFor(label+'-A',portalData(label+'A'));a.read=read;
 const state={scope:a,data:a.data,capability:true,commits:0,previews:0};
 const transport={
  preview:async request=>{assert(request.portalToken===state.scope.token,'Preview current authority');state.previews++;observed.previews.push({scope:state.scope.label,quoteId:request.quoteId});
   return clone(base.previewResponse)},
  commit:async request=>{assert(request.portalToken===state.scope.token,'Commit current authority');equal(request.expected,base.previewResponse.expected,'Exact reviewed expected object');
   state.commits++;observed.commits.push({scope:state.scope.label,quoteId:request.quoteId,operationId:request.clientOperationId});
   return{code:'accepted',clientOperationId:request.clientOperationId,previewRevision:request.expected.previewRevision,receipt:clone(base.commitResponse.receipt)}},
  reconcile:async()=>deny('Unexpected acceptance reconciliation'),
 };
 const el=document.createElement('section');document.body.append(el);const root=createRoot(el);
 const h={el,state,a,render(){flushSync(()=>root.render(<React.StrictMode><PortalClient token={state.scope.token} initialData={state.data}
  pilotAcceptance={state.capability?transport:undefined}/></React.StrictMode>))},
 unmount(){if(!roots.has(h))return;flushSync(()=>root.unmount());el.remove();roots.delete(h);observed.cleanup.push({scope:a.label,unmounted:true})}};
 roots.add(h);h.render();await tick();return h;
}
async function billing(h){
 const button=h.el.querySelector('#porttab-billing');assert(button,'Actual Billing tab');button.click();await tick();
}
async function accept(h){
 await billing(h);assert(cardButtons(h).length===1,'Actual quote acceptance entry');const launch=cardButtons(h)[0];
 assert(!launch.disabled,'Quote entry enabled');launch.click();
 await waitFor(()=>dialog(h)?.querySelector('[data-pilot-acceptance-document]'),'Actual reviewed document');
 const modal=dialog(h),checkbox=modal.querySelector('input[type="checkbox"]');if(checkbox&&!checkbox.checked)checkbox.click();
 const submit=buttons(modal).find(button=>text(button)==='Accept this quote');assert(submit&&!submit.disabled,'Actual confirmation enabled');submit.click();
 await waitFor(()=>receiptShown(h),'Direct correlated receipt displayed');
 assert(h.state.commits===1,'Exactly one explicit acceptance');await waitFor(()=>h.a.reads>=1,'Post-receipt canonical read dispatched');
}
async function wake(){
 // This only crosses the existing wake throttle; deferred completion order
 // below is explicit and never inferred from elapsed time.
 Date.now=()=>originalNow()+61000;
 try{window.dispatchEvent(new Event('focus'))}finally{Date.now=originalNow}
 await tick();
}
function inspectStorage(){
 for(const storage of[localStorage,sessionStorage])for(let i=0;i<storage.length;i++){
  const key=storage.key(i),value=storage.getItem(key);
  for(const token of knownTokens)assert(!String(key).includes(token)&&!String(value).includes(token),'No authority persisted');
  assert(!/"(?:portalToken|previewRevision|authorityFence)"\s*:/.test(String(value)),'No acceptance expected document persisted');
 }
}
const results=[];
async function test(name,work){
 let pass=false,error;
 try{await work();await tick();assert(observed.blocked.length===0,'No unapproved I/O');assert(observed.unhandled.length===0,'No unhandled rejection');inspectStorage();pass=true}
 catch(failure){error=errorText(failure)}
 finally{Date.now=originalNow;for(const h of[...roots])h.unmount();await tick()}
 results.push({name,pass,...(error?{error}:{})});observed.cases.push({name,pass});
}
assert(base?.previewResponse?.code==='preview'&&base?.commitResponse?.code==='accepted','Explicit synthetic portal fixtures required');
await test('portal refresh: resolved RPC error preserves direct receipt and previous card',async()=>{
 const pending=deferred(),h=await mount('Resolved',()=>pending.promise);await accept(h);
 assert(h.a.reads===1&&cardButtons(h).length===1,'One refresh and no optimistic card patch');
 pending.resolve({data:null,error:{message:'Synthetic unavailable'}});await waitFor(()=>warning(h),'Friendly read failure');
 assert(receiptShown(h)&&cardButtons(h).length===1,'Receipt and previous card preserved');assert(h.a.reads===1&&h.state.commits===1,'No replay');
});
await test('portal refresh: rejected read is handled without replacing accepted receipt',async()=>{
 const pending=deferred(),h=await mount('Rejected',()=>pending.promise);await accept(h);pending.reject(Error('Synthetic rejected auxiliary read'));
 await waitFor(()=>warning(h),'Rejected refresh handled');assert(receiptShown(h)&&cardButtons(h).length===1,'Direct receipt and old card retained');
 assert(h.a.reads===1&&h.state.commits===1,'No retry or acceptance replay');
});
await test('portal refresh: newer canonical read updates card and older wake read cannot overwrite it',async()=>{
 const old=deferred(),fresh=deferred(),h=await mount('Ordering',number=>number===1?old.promise:fresh.promise);
 await wake();await waitFor(()=>h.a.reads===1,'Older wake read dispatched');await accept(h);await waitFor(()=>h.a.reads===2,'Acceptance refresh dispatched second');
 assert(cardButtons(h).length===1&&receiptShown(h),'Pending read does not manufacture accepted card');
 fresh.resolve({data:portalData('NewestCanonical','accepted'),error:null});
 await waitFor(()=>h.el.textContent.includes('NewestCanonical')&&cardButtons(h).length===0,'Canonical accepted card refreshed');
 old.resolve({data:portalData('ObsoleteWake','sent'),error:null});await tick();await tick();
 assert(h.el.textContent.includes('NewestCanonical')&&!h.el.textContent.includes('ObsoleteWake')&&cardButtons(h).length===0,'Late stale rows ignored');
 assert(receiptShown(h)&&!warning(h)&&h.state.commits===1&&h.a.reads===2,'Receipt preserved without automatic replay');
 const close=buttons(dialog(h)).find(button=>text(button)==='Close');assert(close,'Receipt can be closed');close.click();await tick();
 assert(!dialog(h)&&cardButtons(h).length===0&&h.el.textContent.includes('Approved'),'Actual card stays approved after closing receipt');
});
await test('portal refresh: token A to B to A discards old read and preserves no-legacy latch',async()=>{
 const pending=deferred(),h=await mount('Scope',()=>pending.promise);await accept(h);
 const b=scopeFor('Scope-B',portalData('ScopeB'));h.state.scope=b;h.state.data=b.data;h.state.capability=false;h.render();await tick();
 assert(h.el.textContent.includes('ScopeB')&&!receiptShown(h),'New token has its own page and no old receipt');
 await billing(h);assert(cardButtons(h).length===1,'New scope quote entry');cardButtons(h)[0].click();await tick();
 assert(!dialog(h)&&h.state.commits===1,'Removed capability does not enable legacy acceptance');
 h.state.scope=h.a;h.state.data=portalData('ReturnA');h.state.capability=true;h.render();await tick();
 pending.resolve({data:portalData('ObsoleteScopeA','accepted'),error:null});await tick();await tick();
 assert(h.el.textContent.includes('ReturnA')&&!h.el.textContent.includes('ObsoleteScopeA')&&!receiptShown(h),'Old A lifetime cannot publish into returned A');
 assert(h.a.reads===1&&!warning(h)&&h.state.commits===1,'No late callback, warning or retry');
});
await test('portal refresh: unmount consumes pending read rejection without new work',async()=>{
 const pending=deferred(),h=await mount('Unmount',()=>pending.promise);await accept(h);const reads=h.a.reads,commits=h.state.commits;
 h.unmount();pending.reject(Error('Synthetic rejection after unmount'));await tick();await tick();await wake();
 assert(h.a.reads===reads&&h.state.commits===commits&&roots.size===0,'Unmount prevents late read work or replay');
 assert(observed.unhandled.length===0,'Retired refresh rejection consumed');
});
for(const h of[...roots])h.unmount();
Date.now=originalNow;window.fetch=originalFetch;XMLHttpRequest.prototype.open=originalOpen;
window.removeEventListener('unhandledrejection',unhandled);window.removeEventListener('securitypolicyviolation',csp);
window.__pilotEvidence={...observed,allRootsUnmounted:roots.size===0,scope:'Five focused actual PortalClient/React/controller regressions with synthetic acceptance and auxiliary I/O only.',
 exclusions:['No native SQL or durable COMMIT proof','No real Auth/PostgREST transport','No predecessor suite rerun','No production or provider writes'],
 sourceOfCardStatus:'Synthetic canonical read response, never receipt-value inference',inputMethod:'Actual DOM buttons and React lifetimes; synthetic auxiliary I/O'};
window.__pilotResults=results;
`
}
