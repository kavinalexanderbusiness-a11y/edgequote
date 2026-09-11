import type { PilotQuoteSaveBaseline } from '../../src/lib/quotes/pilotQuoteSaveBaseline'

/** TEST ONLY generated browser entrypoint. The public baseline argument is
 * produced by the actual server projector over the existing synthetic snapshot
 * before bundling. Auxiliary context is never injected: the real SDK loader,
 * owner hook, Shell, Builder and CacheOwner all execute unchanged. */
export function quoteAuxiliaryMountedFixture(baselines: PilotQuoteSaveBaseline[]): string {
  return `
import React, {useEffect} from 'react';
import {createRoot} from 'react-dom/client';
import {flushSync} from 'react-dom';
import {CacheOwner} from './src/components/layout/CacheOwner';
import {PilotQuoteSaveOwnerEditor} from './src/components/quotes/PilotQuoteSaveOwnerEditor';
import {ConfirmHost} from './src/components/ui/ConfirmHost';
import {Toaster} from './src/components/ui/Toaster';
import {cacheLease,getCacheOwner,getCacheGeneration,isCurrentLease} from './src/lib/clientCache';
import {createAuxiliaryHarness,auxiliaryId,auxiliaryRows,auxiliaryJsonResponse,auxiliaryExpectedSelects} from './scripts/pilot-email/quote-auxiliary-loader-cases';
const baselines=${JSON.stringify(baselines)};
const clone=v=>JSON.parse(JSON.stringify(v)),assert=(v,m)=>{if(!v)throw Error(m)};
const delay=ms=>new Promise(r=>setTimeout(r,ms));
async function waitFor(fn,message,ms=3500){const end=Date.now()+ms;while(Date.now()<end){if(fn())return;await delay(10)}throw Error(typeof message==='function'?message():message)}
const textOf=el=>el.textContent.replace(/\\s+/g,' ').trim();
const observed={blocked:[],navigation:[],draftChecks:[],lifetimes:[],clients:[],writes:[],baselineReads:[],reconciliations:[],strictMode:[],barriers:[],formDiagnostics:[]};
const roots=[],clients=[],results=[],gates=[];
function deny(reason){observed.blocked.push(reason);throw Error(reason)}
window.__auxiliaryIO={client:()=>{const h=roots.at(-1);if(!h)return deny('Unexpected SDK outside mounted fixture');return h.state.sdk.client},
 router:{back:()=>observed.navigation.push('back'),push:x=>observed.navigation.push(x),replace:x=>observed.navigation.push(x),refresh:()=>observed.navigation.push('refresh')}};
window.fetch=async()=>deny('Unexpected global fetch/provider action');
const nativeXhr=XMLHttpRequest.prototype.open;
XMLHttpRequest.prototype.open=function(){return deny('Unexpected XHR')};
window.addEventListener('securitypolicyviolation',e=>observed.blocked.push('CSP '+e.violatedDirective));
window.addEventListener('unhandledrejection',e=>{observed.blocked.push('Unhandled '+String(e.reason));e.preventDefault()});
async function sdk(owner=auxiliaryId(1)){const h=await createAuxiliaryHarness(owner);clients.push(h);return h}
function LeaseTrace(){useEffect(()=>{const captured=cacheLease();observed.strictMode.push({phase:'setup',generation:captured?.gen,owner:captured?.owner});return()=>observed.strictMode.push({phase:'cleanup',generation:getCacheGeneration(),priorCurrent:isCurrentLease(captured)})},[]);return null}
async function mount(config={}){
 const state={sdk:config.sdk??await sdk(),owner:auxiliaryId(1),ownerKey:0,quoteId:auxiliaryId(2),attempt:0,writes:[],loads:[],closed:0,formEvents:{submit:0,invalid:[]},...config};
 const el=document.createElement('section');document.body.append(el);const root=createRoot(el);
 el.addEventListener('submit',()=>{state.formEvents.submit++},true);
 el.addEventListener('invalid',event=>{if(state.formEvents.invalid.length<20)state.formEvents.invalid.push(controlValidity(event.target))},true);
 const loadBaseline=async(id,signal)=>{const lease=cacheLease();state.loads.push({id,lease});observed.baselineReads.push({id,owner:lease?.owner,generation:lease?.gen});
  if(state.load)return state.load(id,signal);const value=baselines.find(b=>b.quoteId===id&&b.ownerId===lease?.owner);assert(value,'Actual projected baseline exists');return clone(value)};
 const write=async intent=>{state.writes.push(clone(intent));observed.writes.push({owner:state.owner,quoteId:intent.quoteId,revision:intent.expectedEditorRevision});
  if(state.write)return state.write(intent);throw Error('Synthetic lost Save response')};
 const readReconciliation=async pending=>{observed.reconciliations.push({quoteId:pending.quoteId});return {code:'unknown'}};
 const render=()=>flushSync(()=>root.render(<React.StrictMode><CacheOwner key={state.ownerKey} id={state.owner}/><LeaseTrace/><ConfirmHost/><Toaster/>
  <PilotQuoteSaveOwnerEditor client={state.sdk.client} quoteId={state.quoteId} loadAttempt={state.attempt} loadBaseline={loadBaseline} write={write} readReconciliation={readReconciliation} onClose={()=>state.closed++}/></React.StrictMode>));
 const h={state,el,root,render,unmount(){flushSync(()=>root.unmount());el.remove();const i=roots.indexOf(h);if(i>=0)roots.splice(i,1)}};
 roots.push(h);render();await delay(0);return h;
}
function optionalField(h,name){return h.el.querySelector('[name="'+name+'"]')}
function field(h,name){const el=optionalField(h,name);assert(el instanceof HTMLInputElement||el instanceof HTMLTextAreaElement,'Actual input '+name);return el}
function controlValidity(el){const v=el.validity;return {name:el.name,type:el.type,value:el.type==='number'?el.value:undefined,min:el.min,max:el.max,step:el.step,
 disabled:el.matches(':disabled'),valid:!!v?.valid,stepMismatch:!!v?.stepMismatch,rangeUnderflow:!!v?.rangeUnderflow,rangeOverflow:!!v?.rangeOverflow,
 valueMissing:!!v?.valueMissing,badInput:!!v?.badInput,typeMismatch:!!v?.typeMismatch,customError:!!v?.customError,message:String(el.validationMessage??'').slice(0,250)}}
function formDiagnostics(h){return {formPresent:!!h.el.querySelector('form'),events:clone(h.state.formEvents),
 invalid:[...h.el.querySelectorAll('input,textarea,select')].filter(el=>el.validity&&!el.validity.valid).slice(0,20).map(controlValidity),
 status:[...h.el.querySelectorAll('[role="status"],[role="alert"]')].map(textOf).join(' | ').slice(0,900),
 saveButtons:[...h.el.querySelectorAll('button[type="submit"]')].map(b=>({text:textOf(b),disabled:b.matches(':disabled'),concealed:!!b.closest('[hidden],[inert]')}))}}
const ready=h=>{const f=h.el.querySelector('form'),b=h.el.querySelector('button[type="submit"]'),n=optionalField(h,'notes');return !!f&&!!b&&!!n&&!f.closest('[hidden],[inert]')&&!b.matches(':disabled')&&!n.matches(':disabled')};
async function editor(h){await waitFor(()=>ready(h),()=> 'Actual verified editor did not become ready: '+textOf(h.el).slice(0,500));return h}
function button(h,label){const b=[...h.el.querySelectorAll('button')].find(x=>textOf(x)===label);assert(b,'Actual button '+label);return b}
async function click(h,label){await waitFor(()=>!button(h,label).matches(':disabled'),'Control ready '+label);button(h,label).click();await delay(0)}
async function input(h,name,value){if(name==='internal_notes'&&!optionalField(h,name)){const section=[...h.el.querySelectorAll('button[aria-expanded]')].find(b=>textOf(b).startsWith('More options'));assert(section,'Actual More options disclosure');section.click();await waitFor(()=>!!optionalField(h,name),'Private notes disclosure opened')}
 const el=field(h,name);assert(!el.matches(':disabled'),'Field editable '+name);el.focus();const proto=el instanceof HTMLTextAreaElement?HTMLTextAreaElement.prototype:HTMLInputElement.prototype;
 Object.getOwnPropertyDescriptor(proto,'value').set.call(el,value);el.dispatchEvent(new InputEvent('input',{bubbles:true,inputType:'insertText',data:value}));el.dispatchEvent(new Event('change',{bubbles:true}));await delay(15)}
function pending(){return Object.keys(localStorage).filter(k=>k.startsWith('eq:quote-save:pending:')).map(key=>({key,bytes:localStorage.getItem(key),value:JSON.parse(localStorage.getItem(key))}))}
function drafts(){return Object.keys(localStorage).filter(k=>k.startsWith('eq:autosave:owner:')).map(key=>({key,bytes:localStorage.getItem(key),value:JSON.parse(localStorage.getItem(key))}))}
function barrier(table='customers'){let open=false;const waiting=[],evidence={table,entered:0,completed:0,releaseCalls:0};observed.barriers.push(evidence);
 const gate={waiting,evidence,hook:async r=>{if(r.table===table&&!open){evidence.entered++;await new Promise(resolve=>waiting.push({resolve,signal:r.signal}));evidence.completed++}},release(){open=true;evidence.releaseCalls++;for(const x of waiting)x.resolve()}};gates.push(gate);return gate}
async function test(name,work){try{await work();results.push({name:'Auxiliary mounted: '+name,pass:true})}catch(error){const diagnostics=roots.map(formDiagnostics);observed.formDiagnostics.push({name,diagnostics});results.push({name:'Auxiliary mounted: '+name,pass:false,error:(String(error.message)+' '+JSON.stringify(diagnostics)).slice(0,1900)})}
 finally{for(const h of [...roots])h.unmount();for(const gate of gates.splice(0))gate.release();await delay(0);for(const c of clients.splice(0)){await c.close();observed.clients.push({requests:c.state.observations,blocked:c.state.blocked,activeSubscriptions:c.state.activeSubscriptions,subscriptions:c.state.subscriptions,unsubscribed:c.state.unsubscribed,sdkStopped:c.state.closed})}localStorage.clear();sessionStorage.clear()}}
await test('all seven complete second-pass catalogues precede first editable Save mount',async()=>{
 const c=await sdk(),gate=barrier('service_pricing_plans');c.state.hook=gate.hook;const h=await mount({sdk:c});
 await waitFor(()=>gate.waiting.length>0,'Actual last collection read held');assert(!h.el.querySelector('form')&&h.state.loads.length===0,'No baseline or editable document from partial first pass');
 gate.release();await editor(h);assert(c.state.observations.filter(r=>r.table==='service_pricing_plans').length===2,'Both complete passes');
 assert(h.state.writes.length===0,'Reads do not save');assert(observed.strictMode.filter(x=>x.phase==='setup').length>=2,'Actual StrictMode effect replay');
});
for(const table of Object.keys(auxiliaryExpectedSelects))await test(table+' denial gates the actual wrapper before baseline/Builder',async()=>{
 const c=await sdk();c.state.hook=r=>r.table===table?auxiliaryJsonResponse({message:'Synthetic denial',code:'42501'},403):undefined;const h=await mount({sdk:c});
 await waitFor(()=>textOf(h.el).includes('could not be verified'),'Explicit unavailable state');assert(!h.el.querySelector('form')&&h.state.loads.length===0&&h.state.writes.length===0,'No empty or substituted document');
});
await test('partial, unknown shape and missing settings responses never mount editable defaults',async()=>{
 for(const kind of ['partial','shape','settings']){const c=await sdk();if(kind==='partial')c.state.hook=r=>r.table==='customers'?auxiliaryJsonResponse([],200,1):undefined;
 if(kind==='shape')delete c.state.data.properties[0].customer_id;if(kind==='settings')c.state.data.business_settings=[];
 const h=await mount({sdk:c});await waitFor(()=>textOf(h.el).includes('could not be verified'),'Failure presented '+kind);assert(!h.el.querySelector('form')&&h.state.loads.length===0,'No baseline on '+kind);h.unmount()}
});
await test('denied and unknown roles remain unavailable without quote reads',async()=>{
 for(const role of ['crew','unexpected']){const c=await sdk();c.state.role=role;const h=await mount({sdk:c});await waitFor(()=>textOf(h.el).includes(role==='crew'?'requires a verified business owner':'could not be verified'),'Role gate');
 assert(!h.el.querySelector('form')&&h.state.loads.length===0&&c.state.observations.every(r=>r.kind!=='page'),'No catalogue/baseline after role refusal');h.unmount()}
});
await test('complete empty catalogues cannot turn a saved linked customer into manual identity',async()=>{
 const c=await sdk();for(const table of ['customers','properties','service_templates','travel_fee_tiers','service_pricing_plans'])c.state.data[table]=[];
 const h=await mount({sdk:c});await waitFor(()=>h.state.loads.length>0,'Ready empty catalogue allows canonical baseline read');
 await waitFor(()=>textOf(h.el).includes('could not be verified'),'Missing baseline link refused');
 assert(!h.el.querySelector('form')&&h.state.writes.length===0,'No substituted empty/manual editable quote');
});
await test('verified catalogue values do not replace the saved document or original revision',async()=>{
 const h=await editor(await mount());const b=baselines[0];
 assert(field(h,'address').value===b.values.address&&field(h,'initial_price').value===String(b.values.initial_price),'Saved address and price retained');
 assert(field(h,'rate').value===String(b.values.rate)&&field(h,'notes').value===b.values.notes,'Catalogue rate and scope did not replace baseline');
 assert(field(h,'measured_sqft').value===String(b.values.measured_sqft),'Saved fractional measurement remains exact');
 assert(field(h,'measured_sqft').validity.valid,'Stored fractional measurement passes actual native input validity');
 await input(h,'notes','Verified loader draft');h.el.querySelector('button[type="submit"]').click();await waitFor(()=>h.state.writes.length===1,'Actual submit reached bounded transport');
 assert(h.state.formEvents.submit===1&&h.state.formEvents.invalid.length===0,'Actual browser form submitted once without bypassing native validation');
 const intent=h.state.writes[0];assert(intent.expectedEditorRevision===b.editorRevision&&intent.values.initial_price===b.values.initial_price,'Original full revision and amount submitted');
 assert(intent.values.customer_name===b.values.customer_name,'Saved customer name remains in actual form submission despite changed picker catalogue label');
 assert(intent.values.measurement_snapshot.value===b.values.measurement_snapshot.value,'Original measurement preserved');
});
await test('same-owner refresh preserves exact dirty form while storage is unavailable',async()=>{
 const h=await editor(await mount());await input(h,'notes','Dirty before auxiliary refresh');const node=field(h,'notes'),loads=h.state.loads.length,gate=barrier();h.state.sdk.state.hook=gate.hook;
 const original=Storage.prototype.setItem;Storage.prototype.setItem=function(k,v){if(k.startsWith('eq:autosave:'))throw new DOMException('Synthetic quota','QuotaExceededError');return original.call(this,k,v)};
 try{await click(h,'Refresh customer and pricing data');await waitFor(()=>gate.waiting.length>0,'Refresh held');assert(field(h,'notes')===node&&node.value==='Dirty before auxiliary refresh'&&node.matches(':disabled'),'Same form paused, no replacement or forced checkpoint');
 gate.release();await editor(h);assert(field(h,'notes')===node&&node.value==='Dirty before auxiliary refresh'&&h.state.loads.length===loads,'Same editor resumes without fresh baseline');}
 finally{Storage.prototype.setItem=original;gate.release()}
 await click(h,'Cancel');assert(h.state.closed===1,'Explicit cancel checkpoints current draft');const d=drafts();assert(d.length===1&&d[0].value.value.notes==='Dirty before auxiliary refresh'&&d[0].value.originalRevision===baselines[0].editorRevision,'Exact bound draft kept');
 observed.draftChecks.push({kind:'refresh-storage-failure',sameNode:true,originalRevision:true,retained:true});
});
await test('old same-owner attempt cannot re-enable editor after newer failed attempt',async()=>{
 const c=await sdk(),gate=barrier();c.state.hook=gate.hook;const h=await mount({sdk:c});await waitFor(()=>gate.waiting.length>0,'First attempt pending');
 c.state.hook=r=>r.table==='customers'?auxiliaryJsonResponse({message:'Synthetic newer refusal'},403):undefined;h.state.attempt++;h.render();
 await waitFor(()=>textOf(h.el).includes('could not be verified'),'New attempt failed');gate.release();await waitFor(()=>gate.evidence.completed===gate.evidence.entered,'Retired HTTP reads actually returned');await delay(0);
 assert(!h.el.querySelector('form')&&h.state.loads.length===0,'Ignored-abort old result cannot publish');
});
await test('real same-owner CacheOwner generation change rejects old held results',async()=>{
 const c=await sdk(),gate=barrier();c.state.hook=gate.hook;const h=await mount({sdk:c});await waitFor(()=>gate.waiting.length>0,'Old lease pending');const prior=cacheLease();
 h.state.ownerKey++;h.render();await waitFor(()=>!isCurrentLease(prior),'Real CacheOwner generation changed');
 c.state.hook=null;gate.release();await editor(h);assert(cacheLease().owner===prior.owner&&cacheLease().gen>prior.gen,'Same UUID different generation');
 assert(h.state.loads.every(x=>x.lease.gen===cacheLease().gen),'Only new lease can request baseline');observed.lifetimes.push({kind:'same-owner',before:prior.gen,after:cacheLease().gen});
});
await test('owner A to B to A cannot publish a retired account response',async()=>{
 const a=await sdk(),b=await sdk(auxiliaryId(81)),gate=barrier();a.state.hook=gate.hook;const h=await mount({sdk:a});await waitFor(()=>gate.waiting.length>0,'A read pending');
 h.state.owner=auxiliaryId(81);h.state.quoteId=auxiliaryId(82);h.state.sdk=b;h.render();await editor(h);assert(h.state.loads.every(x=>x.lease.owner===auxiliaryId(81)),'Only B baseline read');
 gate.release();await waitFor(()=>gate.evidence.completed===gate.evidence.entered,'Retired A HTTP reads returned');await delay(0);assert(field(h,'address').value===baselines[1].values.address,'Late A cannot replace B');
 a.state.hook=null;h.state.owner=auxiliaryId(1);h.state.quoteId=auxiliaryId(2);h.state.sdk=a;h.render();await editor(h);
 assert(field(h,'address').value===baselines[0].values.address,'Returning A receives new verified baseline');observed.lifetimes.push({kind:'A-B-A',noRetiredPublication:true});
});
await test('actual SDK auth event invalidates ready Save synchronously before reload',async()=>{
 const h=await editor(await mount());await input(h,'notes','Auth event retained draft');const gate=barrier();h.state.sdk.state.hook=gate.hook;
 await h.state.sdk.setSessionOwner(h.state.owner);await waitFor(()=>gate.waiting.length>0,'Auth-triggered reload held');
 const submit=h.el.querySelector('button[type="submit"]');if(submit)submit.click();assert(h.state.writes.length===0&&!ready(h),'Auth transition cannot dispatch');
 gate.release();await editor(h);assert(field(h,'notes').value==='Auth event retained draft','Same-owner auth refresh preserves draft');
});
await test('different SDK account conceals old private form before CacheOwner catches up',async()=>{
 const h=await editor(await mount());await input(h,'internal_notes','Private dirty A scope');const node=field(h,'internal_notes'),prior=cacheLease(),loads=h.state.loads.length;
 await h.state.sdk.setSessionOwner(auxiliaryId(81));await waitFor(()=>!!node.closest('[hidden][aria-hidden="true"][inert]'),'Prior account editor hidden and inert');
 assert(cacheLease().owner===prior.owner&&cacheLease().gen===prior.gen,'Fixture deliberately retains old CacheOwner');
 assert(!ready(h)&&h.state.loads.length===loads&&h.state.writes.length===0,'Different SDK account cannot read or Save old quote');
 assert(node.value==='Private dirty A scope','Unpersisted private draft retained in concealed original component');
 h.state.sdk.state.data=auxiliaryRows();await h.state.sdk.setSessionOwner(auxiliaryId(1));await editor(h);
 assert(field(h,'internal_notes')===node&&node.value==='Private dirty A scope','Only fresh matching verification reveals same draft');
 observed.lifetimes.push({kind:'auth-before-cache-owner',hiddenInert:true,retainedSameNode:true});
});
await test('fresh authentication rejection conceals prior editor without erasing its draft',async()=>{
 const h=await editor(await mount());await input(h,'notes','Draft before auth rejection');const node=field(h,'notes');
 h.state.sdk.state.hook=r=>r.kind==='auth'?auxiliaryJsonResponse({message:'Synthetic rejected JWT',code:'bad_jwt'},401):undefined;
 await click(h,'Refresh customer and pricing data');await waitFor(()=>textOf(h.el).includes('Sign in to verify'),'Signed-out status from fresh actual Auth rejection');
 assert(node.closest('[hidden][inert]')&&node.value==='Draft before auth rejection'&&h.state.writes.length===0,'Prior private form concealed; draft not erased');
 h.state.sdk.state.hook=null;await h.state.sdk.setSessionOwner(auxiliaryId(1));await editor(h);assert(field(h,'notes')===node,'Recovery preserves same mounted draft');
});
await test('unknown Save stays exactly preserved and never retries on auxiliary refresh',async()=>{
 const h=await editor(await mount());await input(h,'notes','Unknown operation draft');h.el.querySelector('button[type="submit"]').click();
 await waitFor(()=>pending().some(p=>p.value.state==='unknown'),'Lost response recorded as unknown');const copy=pending()[0];
 assert(h.state.writes.length===1,'One actual Save dispatch');assert(textOf(h.el).includes('We could not confirm this Save.'),'Unknown outcome is not success');await click(h,'Refresh customer and pricing data');await editor(h);
 assert(localStorage.getItem(copy.key)===copy.bytes,'Refresh preserves exact submitted unknown bytes');
 const save=h.el.querySelector('button[type="submit"]');if(save&&!save.matches(':disabled'))save.click();await delay(20);
 assert(h.state.writes.length===1&&localStorage.getItem(copy.key)===copy.bytes,'No automatic or duplicate Save');
 observed.draftChecks.push({kind:'unknown-refresh',exactPendingBytes:true,writes:1});
});
await test('unmounted owner never publishes an ignored-abort response',async()=>{
 const c=await sdk(),gate=barrier();c.state.hook=gate.hook;const h=await mount({sdk:c});await waitFor(()=>gate.waiting.length>0,'Pending read before unmount');h.unmount();gate.release();await waitFor(()=>gate.evidence.completed===gate.evidence.entered,'Unmounted HTTP reads actually returned');await delay(0);
 assert(h.state.loads.length===0&&h.state.writes.length===0&&getCacheOwner()===null,'No publication or transport after unmount');
});
await test('verified pilot descendants make no hidden SDK, provider or measurement request',async()=>{
 const h=await editor(await mount());const before=h.state.sdk.state.observations.length;await input(h,'address','Edited synthetic address');await input(h,'notes','No hidden I/O');
 // The legacy measurement/provider suggestion effects used to trigger on these
 // actual fields. Give their existing bounded debounce time to fire if present.
 await delay(800);assert(h.state.sdk.state.observations.length===before,'Only loader owns auxiliary reads');
 assert(!h.el.querySelector('iframe'),'No map/provider embedded');assert(h.state.writes.length===0,'No pre-Save measurement mutation');
});
await test('all SDK lifetimes close and all attempted I/O stayed inside strict synthetic boundary',async()=>{
 assert(observed.blocked.length===0,observed.blocked.join('; '));assert(observed.navigation.length===0,'No router/provider navigation');
 assert(observed.clients.length>0&&observed.clients.every(c=>c.sdkStopped&&c.activeSubscriptions===0&&c.subscriptions===c.unsubscribed),'Every real SDK listener and visibility callback closed');
 assert(observed.clients.every(c=>c.blocked.length===0),'No hidden request swallowed by product catch');assert(getCacheOwner()===null,'Final actual CacheOwner released');
 assert(observed.barriers.every(b=>b.entered>0&&b.completed===b.entered&&b.releaseCalls>0),'All measured held HTTP responses released and completed');
});
XMLHttpRequest.prototype.open=nativeXhr;
window.__pilotEvidence={...observed,scope:'actual SDK HTTP boundary + loader + owner hook + full Shell/Builder/CacheOwner; synthetic baseline/read/write boundaries',
 baselineSource:'projectPilotQuoteSaveBaseline(quoteSaveBaselineFixture())',readyContextInjected:false,externalCalls:0,
 exclusions:['live Auth/PostgREST','native SQL execution','production route wiring','maps/providers','visual styling certification'],inputMethod:'native DOM events, not trusted OS keystrokes'};
window.__pilotResults=results;
`
}
