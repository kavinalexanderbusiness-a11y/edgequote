// TEST ONLY source composed into the full-component browser fixture. All form
// interactions cross actual DOM controls. Injected load/write functions observe
// transport boundaries only; no validator, planner, Save controller or hook is
// replaced. This source has no runtime use outside the isolated proof.
export function mountedShellFixture(): string {
  return `
const QUOTE=uuid(4),REV='a'.repeat(32);
const baseline=(values=blank,revision=REV)=>({version:1,code:'baseline',complete:true,ownerId:OWNER,quoteId:QUOTE,editorRevision:revision,
quoteNumber:'SYN-MOUNT-1',quoteUpdatedAt:STAMP,selectedOption:null,acceptance:{hasRecord:false,current:false},values:clone(values)});
const readyContext=()=>({code:'ready',complete:true,ownerId:OWNER,customers,templates,tiers:[],settings:null});
async function waitFor(fn,message,ms=1500){const until=Date.now()+ms;while(Date.now()<until){if(fn())return;await delay(10)}throw Error(typeof message==='function'?message():message)}
const textOf=el=>el.textContent.replace(/\\s+/g,' ').trim();
function button(h,label){const el=[...h.el.querySelectorAll('button')].find(b=>textOf(b)===label);assert(el,'Actual button '+label);return el}
async function click(h,label){await waitFor(()=>!button(h,label).disabled,'Actual button not ready: '+label);button(h,label).click();
 // A stateful control may start an asynchronous read. Wait for its actual
 // enabled state before a following action instead of guessing a 25ms budget.
 await delay(0);if(label==='Refresh saved version')await waitFor(()=>!button(h,label).disabled,'Read did not settle: '+label)}
async function section(h,label){const el=[...h.el.querySelectorAll('button[aria-expanded]')].find(b=>textOf(b).startsWith(label));assert(el,'Actual section '+label);if(el.getAttribute('aria-expanded')!=='true'){el.click();await delay(20)}}
async function draftAction(h,note,label){
 // Storage enumeration is not ordered. Multiple editors add several identically
 // labelled action buttons, so select the exact reviewed content, never index 0.
 const entries=[...h.el.querySelectorAll('[aria-label="Recovery review"] article')].filter(x=>x.textContent.includes(note));
 assert(entries.length===1,'One uniquely identified source draft: '+note);const action=[...entries[0].querySelectorAll('button')].find(x=>textOf(x)===label);
 assert(action,'Selected draft action '+label);await waitFor(()=>!action.disabled,'Selected source action ready');action.click();await delay(0);
}
const pilotDrafts=()=>Object.keys(localStorage).filter(k=>k.startsWith('eq:autosave:owner:'+OWNER+':quote:'+QUOTE+':pilot:')).map(key=>({key,bytes:localStorage.getItem(key),draft:JSON.parse(localStorage.getItem(key))}));
const pendingCopies=()=>Object.keys(localStorage).filter(k=>k.startsWith('eq:quote-save:pending:'+OWNER+':'+QUOTE+':')).map(key=>({key,pending:JSON.parse(localStorage.getItem(key))}));
async function mountShell(config={}){
 const state={writes:[],loads:[],closed:0,context:readyContext(),owner:OWNER,baseline:baseline(),...config};
 const el=document.createElement('section');document.body.append(el);const root=createRoot(el);
 const loadBaseline=async(id,signal)=>{state.loads.push({id,signal});return state.load?state.load(id,signal):clone(state.baseline)};
 const write=async intent=>{state.writes.push(clone(intent));return state.write?state.write(intent):Promise.reject(Error('Synthetic lost response'))};
 const readReconciliation=async()=>({code:'matching_saved_values'});
 const render=()=>flushSync(()=>root.render(<React.StrictMode>{!state.withoutOwner&&<CacheOwner key={state.ownerKey??0} id={state.owner}/>}<ConfirmHost/><Toaster/>
 <PilotQuoteSaveEditorShell quoteId={QUOTE} context={state.context} loadBaseline={loadBaseline} write={write} readReconciliation={readReconciliation} onClose={()=>state.closed++}/></React.StrictMode>));
 const h={state,root,el,render,unmount(){flushSync(()=>root.unmount());el.remove();roots=roots.filter(x=>x!==h)}};roots.push(h);render();await delay(50);return h;
}
async function editor(h){await waitFor(()=>h.el.querySelector('form'),'Actual shell did not mount full builder');return h}
async function save(h){const b=h.el.querySelector('button[type="submit"]');assert(b,'Actual Save button');b.click();await delay(30)}
// Fixed receipt fixture for note-only edits of the known $200 baseline. These
// constants are not a pricing engine and are never used to assert money logic.
function noteReceipt(i){return {code:'committed',owner_id:OWNER,quote_id:QUOTE,client_operation_id:i.clientOperationId,editor_generation:i.editorGeneration,
before_revision:i.expectedEditorRevision,after_revision:'b'.repeat(32),quote:{id:QUOTE,user_id:OWNER,quote_number:'SYN-MOUNT-1',updated_at:STAMP,
customer_id:CUSTOMER,customer_name:'Synthetic Customer',property_id:null,address:'Synthetic property',service_type:'Synthetic repair',service_template_id:TEMPLATE,
initial_price:200,weekly_price:0,biweekly_price:0,monthly_price:0,hours:2,crew_size:1,rate:100,travel_fee:0,overgrowth_multiplier:1,
custom_travel_required:false,show_travel_separately:false,notes:i.values.notes,internal_notes:i.values.internal_notes,measured_sqft:0,measurement_snapshot:null,
suggested_price:0,value_grade:null,nearby_count:null,price_source:null,pricing_config_version_id:null,deposit_type:null,deposit_value:null,status:'draft',
selected_option_id:null,accepted_price:null,total:200,subtotal:200,man_hours:2},options:[],services:[],measurement:null,acceptance_current:false,
identity:{code:'unchanged',quote_id:QUOTE,customer_id:CUSTOMER,customer_name:'Synthetic Customer',property_id:null,updated_at:STAMP,created_customer:false,created_property:false,matched_by:null}}}
await test('full editor shell: delayed baseline stays noneditable until the real StrictMode owner lease settles',async()=>{
 const waiting=[];const h=await mountShell({load:(id,signal)=>new Promise(resolve=>waiting.push({signal,resolve}))});
 assert(!h.el.querySelector('form'),'No empty editable quote during load');assert(h.state.writes.length===0,'Loading never writes');
 assert(waiting.length>0,'Baseline transport invoked');for(const read of waiting)read.resolve(baseline());await editor(h);
 assert(field(h,'initial_price').value==='200','Authoritative price displayed');assert(getCacheOwner()===OWNER,'Actual owner settled');
 assert(h.state.loads.every(r=>r.id===QUOTE),'Only requested quote loaded');
});
for(const [label,response] of [['not found',{code:'not_found'}],['malformed',{...baseline(),unexpected:'private sentinel'}],['foreign owner',{...baseline(),ownerId:uuid(80)}]]){
 await test('full editor shell: '+label+' baseline cannot become an editable quote',async()=>{
  const h=await mountShell({baseline:response});await delay(50);assert(!h.el.querySelector('form'),'Read failure must not mount empty builder');assert(h.state.writes.length===0,'No write from failed baseline');
  assert(!h.el.textContent.includes('private sentinel'),'No malformed private payload rendered');
 });
}
await test('full editor shell: unavailable auxiliary context is distinct from an empty catalogue',async()=>{
 const h=await mountShell({context:{code:'unavailable',ownerId:OWNER}});assert(!h.el.querySelector('form'),'No editor without explicit complete context');assert(h.state.writes.length===0,'No write');
});
await test('full editor shell: actual opt-in number controls dispatch finite parent/service/deposit values',async()=>{
 const values={...clone(blank),deposit_type:'percent',deposit_value:50,services:[{service_type:'Synthetic extra',service_template_id:'',quantity:2,unit:'each',unit_price:10,est_minutes:0,discount_type:'',discount_value:0,notes:'',kind:'service'}]};
 const h=await editor(await mountShell({baseline:baseline(values)}));await input(h,'initial_price','275');await input(h,'hours','3.5');await input(h,'crew_size','2');await input(h,'rate','125');
 await input(h,'services.0.quantity','3');await input(h,'services.0.unit_price','15');await section(h,'More options');await input(h,'deposit_value','35');await save(h);
 assert(h.state.writes.length===1,'One canonical validated dispatch');const v=h.state.writes[0].values;
 for(const [name,value] of [['initial_price',275],['hours',3.5],['crew_size',2],['rate',125],['deposit_value',35]])assert(v[name]===value&&Number.isFinite(v[name]),'Finite actual input '+name);
 assert(v.services[0].quantity===3&&v.services[0].unit_price===15,'Actual service numeric paths');assert(pendingCopies().length===1,'Lost transport preserved submitted snapshot');
});
await test('full editor shell: clearing a required field retains an incomplete draft and refuses Save',async()=>{
 const h=await editor(await mountShell());await input(h,'service_type','');await input(h,'hours','');await save(h);assert(h.state.writes.length===0,'Incomplete form never dispatches');
 await click(h,'Cancel');assert(h.state.closed===1,'Explicit Cancel can preserve incomplete draft');const drafts=pilotDrafts();assert(drafts.length===1,'Owned draft retained');
 assert(drafts[0].draft.value.service_type===''&&drafts[0].draft.value.hours==='','Raw incomplete fields preserved');assert(drafts[0].draft.version===2&&drafts[0].draft.originalRevision===REV,'Original revision-bound draft');
});
await test('full editor shell: blank numeric submission keeps exact raw blank in immutable pending and editable copies',async()=>{
 const h=await editor(await mountShell());await input(h,'hours','');await save(h);assert(h.state.writes.length===1,'Valid blank numeric form dispatches');
 const p=pendingCopies()[0].pending;assert(h.state.writes[0].values.hours===''&&p.submittedValues.hours==='','Validation copy normalization never replaces raw wire snapshot');
 assert(pilotDrafts()[0].draft.value.hours==='','Editable copy remains raw blank');
});
await test('full editor shell: response loss preserves recovery and a second Save cannot retry automatically',async()=>{
 const h=await editor(await mountShell());await input(h,'notes','Unknown submission');await save(h);await save(h);
 assert(h.state.writes.length===1,'No second dispatch while prior result unknown');assert(pendingCopies().length===1,'Immutable unknown submission preserved');
 assert(pilotDrafts().some(x=>x.draft.value.notes==='Unknown submission'),'Editable local copy preserved');await click(h,'Review saved and local copies');
 assert(h.el.textContent.includes('Unknown submission'),'Explicit recovery displays owned submitted/draft text');assert(h.state.writes.length===1,'Review does not write');
});
await test('full editor shell: quota failure before staging refuses transport and Cancel keeps the form open',async()=>{
 const h=await editor(await mountShell());await input(h,'notes','Unstored newer note');const original=Storage.prototype.setItem;
 try{Storage.prototype.setItem=function(key,value){if(key.startsWith('eq:autosave:')||key.startsWith('eq:quote-save:'))throw new DOMException('Synthetic full storage','QuotaExceededError');return original.call(this,key,value)};
 await save(h);assert(h.state.writes.length===0,'No dispatch without durable stage');await click(h,'Cancel');assert(h.state.closed===0,'Cancel cannot navigate on storage failure');
 assert(field(h,'notes').value==='Unstored newer note','Current form retained');assert(h.el.textContent.includes('Keep this editor open'),'Storage failure has keep-open explanation');
 }finally{Storage.prototype.setItem=original}
});
await test('full editor shell: exact direct acknowledgement clears only the submitted draft',async()=>{
 const h=await editor(await mountShell({write:i=>noteReceipt(i)}));await input(h,'notes','Acknowledged note');await save(h);
 assert(h.state.writes.length===1&&pendingCopies().length===0,'Exactly acknowledged operation resolved');assert(pilotDrafts().length===0,'Exact draft cleared');
 assert(Object.keys(localStorage).some(k=>k.startsWith('eq:quote-save:committed:')),'Direct receipt preserved');
});
await test('full editor shell: newer typing during acknowledged Save stays mounted and remains draft-only recoverable',async()=>{
 let finish;const h=await editor(await mountShell({write:i=>new Promise(resolve=>{finish=()=>resolve(noteReceipt(i))})}));
 await input(h,'notes','Submitted note');await save(h);assert(finish,'Transport in flight');await input(h,'notes','Newer local note');const inputNode=field(h,'notes');finish();await delay(60);
 assert(field(h,'notes')===inputNode&&inputNode.value==='Newer local note','Builder and newer edits remain mounted');assert(pendingCopies().length===0,'Acknowledged pending removed');
 assert(pilotDrafts().some(x=>x.draft.value.notes==='Newer local note'),'Newer draft durably retained');await click(h,'Review saved and local copies');
 assert(h.el.textContent.includes('Newer local note'),'Draft-only recovery is discoverable');assert(h.state.writes.length===1,'Review never rebases or resubmits');
});
for(const trigger of ['Review saved and local copies','Review recovery']){
 await test('full editor shell: '+trigger+' captures typing newer than the pending stored copy',async()=>{
  const h=await editor(await mountShell());await input(h,'notes','Submitted A');await save(h);await input(h,'notes','Newer B before debounce');await click(h,trigger);
  const review=h.el.querySelector('[aria-label="Recovery review"]');assert(review?.textContent.includes('Newer B before debounce'),'Recovery must show fresh B, not label stored A as the current working copy');
  assert(pendingCopies()[0].pending.submittedValues.notes==='Submitted A','Immutable pending remains A');assert(pilotDrafts().some(x=>x.draft.value.notes==='Newer B before debounce'),'Fresh B durably protected');
 });
}
await test('full editor shell: failed pending readback prevents the write and preserves current values',async()=>{
 const h=await editor(await mountShell());await input(h,'notes','Readback test');const original=Storage.prototype.getItem;
 try{Storage.prototype.getItem=function(key){if(key.startsWith('eq:quote-save:pending:'))return null;return original.call(this,key)};await save(h);assert(h.state.writes.length===0,'No write without exact pending readback');assert(field(h,'notes').value==='Readback test','Visible values remain');}
 finally{Storage.prototype.getItem=original}assert(pilotDrafts().some(x=>x.draft.value.notes==='Readback test'),'Draft retained');
});
await test('full editor shell: actual option prices are finite and unfinished option names remain recoverable',async()=>{
 const values={...clone(blank),has_options:true,options:[{id:uuid(31),name:'Standard',description:'Synthetic standard',price:200,is_recommended:true},{id:uuid(32),name:'Extended',description:'Synthetic extended',price:300,is_recommended:false}]};
 const h=await editor(await mountShell({baseline:baseline(values)}));const byLabel=label=>{const l=[...h.el.querySelectorAll('label')].find(x=>textOf(x)===label);assert(l,'Actual option label '+label);return document.getElementById(l.htmlFor)};
 await inputElement(byLabel('Price ($)'),'250');await save(h);assert(h.state.writes.length===1&&h.state.writes[0].values.options[0].price===250,'Actual options editor numeric callback');
 await inputElement(byLabel('Option 1 name'),'');await click(h,'Cancel');assert(h.state.closed===1,'Incomplete option draft permits durable Cancel');assert(pilotDrafts().some(x=>x.draft.value.options[0].name===''),'Empty option name retained for recovery');
});
await test('full editor shell: same-owner CacheOwner remount fences late Save and creates a fresh editor',async()=>{
 let finish;const h=await editor(await mountShell({write:i=>new Promise(resolve=>{finish=()=>resolve(noteReceipt(i))})}));await input(h,'notes','Old lease submission');await save(h);
 const before=pilotDrafts()[0];const oldInput=field(h,'notes');const generation=getCacheGeneration();h.state.ownerKey=1;h.render();await editor(h);await delay(40);
 assert(getCacheGeneration()>generation,'Actual owner boundary advanced generation');assert(field(h,'notes')!==oldInput,'Obsolete editor replaced after verified fresh load');finish();await delay(40);
 assert(pendingCopies().length===1,'Old-lease pending never finalized');assert(localStorage.getItem(before.key)===before.bytes,'Old-lease callback did not modify recovery');assert(!h.el.textContent.includes('Submitted version saved'),'No late success authority');
});
await test('full editor shell: owner switch refuses a late baseline from the prior owner',async()=>{
 const waiting=[];const h=await mountShell({load:()=>new Promise(resolve=>waiting.push(resolve))});h.state.owner=uuid(80);h.state.context={code:'unavailable',ownerId:uuid(80)};h.render();
 for(const resolve of waiting)resolve(baseline());await delay(60);assert(!h.el.querySelector('form'),'Prior-owner late quote stays hidden');assert(!h.el.textContent.includes('Synthetic internal note'),'Prior-owner private contents never render');assert(h.state.writes.length===0,'No stale-owner write');
});
await test('full editor shell: typing during Open saved version prevents replacement after the read',async()=>{
 const h=await editor(await mountShell());await input(h,'notes','Checkpoint A');let finish;h.state.load=()=>new Promise(resolve=>{finish=resolve});await click(h,'Open saved version');
 assert(finish,'Refresh read in flight');const existing=field(h,'notes');await input(h,'notes','Newer B during read');finish(baseline({...clone(blank),notes:'Server replacement'},'b'.repeat(32)));await delay(50);
 assert(field(h,'notes')===existing&&existing.value==='Newer B during read','Fresh post-read checkpoint prevents reset');assert(h.state.writes.length===0,'Refresh was read-only');
});
async function seedUnsentDraft(note){const seed=await editor(await mountShell());await input(seed,'notes',note);await click(seed,'Cancel');const source=pilotDrafts().find(x=>x.draft.value.notes===note);assert(source,'Seed came from actual builder/autosave Cancel');seed.unmount();return source}
await test('full editor shell: explicit same-revision continuation uses a fresh generation and preserves exact source bytes',async()=>{
 const source=await seedUnsentDraft('Owned unsent draft');const h=await editor(await mountShell());assert(field(h,'notes').value===blank.notes,'No automatic local restore');
 await click(h,'Review saved and local copies');await click(h,'Refresh saved version');assert(!button(h,'Continue this draft').disabled,'Proven same-revision source can be continued explicitly');await click(h,'Continue this draft');
 await waitFor(()=>field(h,'notes').value==='Owned unsent draft','Explicit continuation did not adopt source');assert(localStorage.getItem(source.key)===source.bytes,'Exact source preserved');
 const target=pilotDrafts().find(x=>x.key!==source.key&&x.draft.value.notes==='Owned unsent draft');assert(target&&target.draft.generation!==source.draft.generation,'New live generation/key');assert(target.draft.originalRevision===REV,'Original revision preserved');assert(h.state.writes.length===0,'Local adoption never performs Save');
});
await test('full editor shell: two editors continuing one source receive independent durable working copies',async()=>{
 const source=await seedUnsentDraft('Shared source draft');const a=await editor(await mountShell()),b=await editor(await mountShell({withoutOwner:true}));
 for(const h of [a,b]){await click(h,'Review saved and local copies');await click(h,'Refresh saved version')}
 for(const [index,h] of [a,b].entries()){
  const previous=field(h,'notes');await draftAction(h,'Shared source draft','Continue this draft');
  // The new keyed builder intentionally renders only a status while its real
  // autosave adoption is pending. Neither the predicate nor a diagnostic may
  // assert a field exists before that gate has produced an editable form.
  await waitFor(()=>{const current=h.el.querySelector('[name="notes"]'),form=h.el.querySelector('form'),submit=form?.querySelector('button[type="submit"]');
   return (current instanceof HTMLInputElement||current instanceof HTMLTextAreaElement)&&current.isConnected&&current!==previous
    &&current.value==='Shared source draft'&&form?.contains(current)&&submit instanceof HTMLButtonElement&&!submit.matches(':disabled')},
   ()=>'Explicit continuation did not become ready, editor '+index+'; current='+(h.el.querySelector('[name="notes"]')?.value??'<not mounted>')
    +'; statuses='+[...h.el.querySelectorAll('[role="status"]')].map(textOf).join(' | '));
 }
 await input(a,'notes','Editor A working');await input(b,'notes','Editor B working');
 await waitFor(()=>{const drafts=pilotDrafts();return drafts.some(x=>x.draft.value.notes==='Editor A working')&&drafts.some(x=>x.draft.value.notes==='Editor B working')},'Both editors did not durably store their current values');
 const drafts=pilotDrafts(),aa=drafts.find(x=>x.draft.value.notes==='Editor A working'),bb=drafts.find(x=>x.draft.value.notes==='Editor B working');
 assert(aa&&bb&&aa.key!==bb.key&&aa.draft.generation!==bb.draft.generation,'Two live draft keys and generations');assert(localStorage.getItem(source.key)===source.bytes,'Neither editor overwrote original source');assert(a.state.writes.length+b.state.writes.length===0,'No Save during continuation');
});
await test('full editor shell: stale original-revision draft stays review-only after a fresh baseline',async()=>{
 const source=await seedUnsentDraft('Stale local draft');const h=await editor(await mountShell({baseline:baseline(blank,'b'.repeat(32))}));await click(h,'Review saved and local copies');await click(h,'Refresh saved version');
 assert(button(h,'Continue this draft').disabled,'Cannot rebase stale draft silently');assert(field(h,'notes').value===blank.notes,'Current authoritative form untouched');assert(localStorage.getItem(source.key)===source.bytes,'Stale source preserved');assert(h.state.writes.length===0,'No stale Save');
});
await test('full editor shell: selected source-byte change after review refuses continuation',async()=>{
 const source=await seedUnsentDraft('Reviewed source A');const h=await editor(await mountShell());await click(h,'Review saved and local copies');await click(h,'Refresh saved version');
 const changed=clone(source.draft);changed.value.notes='Changed elsewhere B';changed.serialization=JSON.stringify(changed.value);localStorage.setItem(source.key,JSON.stringify(changed));await click(h,'Continue this draft');
 assert(field(h,'notes').value===blank.notes,'Stale reviewed bytes did not replace current editor');assert(JSON.parse(localStorage.getItem(source.key)).value.notes==='Changed elsewhere B','Changed source retained');assert(h.state.writes.length===0,'No transport');
});
await test('full editor shell: recommended unselected option stays editable and only actual selected label locks',async()=>{
 const values={...clone(blank),has_options:true,options:[{id:uuid(31),name:'Recommended only',description:'Synthetic first',price:200,is_recommended:true},{id:uuid(32),name:'Actually selected',description:'Synthetic second',price:300,is_recommended:false}]};
 const open=await editor(await mountShell({baseline:baseline(values)}));const optionInputs=h=>[...h.el.querySelectorAll('input[type="number"]')].filter(x=>[...h.el.querySelectorAll('label')].some(l=>l.htmlFor===x.id&&textOf(l)==='Price ($)'));
 assert(optionInputs(open).length===2&&optionInputs(open).every(x=>!x.disabled),'Recommendation alone never settles options');open.unmount();
 const selected={...baseline(values),selectedOption:{id:uuid(32),name:'Actually selected'},acceptance:{hasRecord:true,current:true}};const locked=await editor(await mountShell({baseline:selected}));
 assert(locked.el.textContent.includes('Actually selected was approved.'),'Actual selected name displayed');assert(!locked.el.textContent.includes('Recommended only was approved.'),'Recommendation not mislabelled as selected');assert(optionInputs(locked).length===2&&optionInputs(locked).every(x=>x.disabled),'Both settled option prices locked');assert(locked.state.writes.length===0,'Read-only selected presentation');
});
await test('full editor shell: passive catalogue arrival preserves baseline and explicit service selection fills its rate',async()=>{
 const h=await editor(await mountShell());const original=field(h,'service_type');const second={...templates[0],id:uuid(34),name:'Explicit new service',default_rate:175};
 h.state.context={...readyContext(),customers:[{...customers[0],name:'Changed catalogue customer'}],templates:[{...templates[0],name:'Changed catalogue service',default_rate:999},second]};h.render();await delay(35);
 assert(field(h,'service_type')===original&&original.value===blank.service_type,'Catalogue refresh did not remount or rename baseline');assert(field(h,'rate').value==='100','Passive hourly rate stayed original');
 await click(h,'Review saved and local copies');const saved=pilotDrafts().find(x=>x.draft.value.service_type===blank.service_type);assert(saved?.draft.value.customer_name===blank.customer_name,'Hidden canonical customer name stayed baseline');await click(h,'Close review');
 original.focus();original.click();await waitFor(()=>[...h.el.querySelectorAll('[role="option"]')].some(x=>textOf(x).includes('Explicit new service')),'Actual catalogue menu');
 [...h.el.querySelectorAll('[role="option"]')].find(x=>textOf(x).includes('Explicit new service')).click();await waitFor(()=>field(h,'service_type').value==='Explicit new service','Explicit service picked');
 assert(field(h,'rate').value==='175','Deliberate selection filled actual template rate');assert(h.state.writes.length===0,'Selection is local');
});
await test('full editor shell: unavailable localStorage prevents Save and explicit Cancel',async()=>{
 const h=await editor(await mountShell());await input(h,'notes','Unavailable storage edit');const descriptor=Object.getOwnPropertyDescriptor(window,'localStorage');assert(descriptor?.configurable,'Synthetic browser storage descriptor');
 try{Object.defineProperty(window,'localStorage',{configurable:true,get(){throw Error('Synthetic storage denied')}});await save(h);assert(h.state.writes.length===0,'Unavailable storage blocks write');await click(h,'Cancel');assert(h.state.closed===0,'Unavailable storage blocks navigation');assert(field(h,'notes').value==='Unavailable storage edit','Form retained')}
 finally{Object.defineProperty(window,'localStorage',descriptor)}
});
for(const target of ['source','destination']){
 await test('full editor shell: '+target+' changed after adoption preparation is refused before editable mount',async()=>{
  const source=await seedUnsentDraft('Adoption checkpoint');const h=await editor(await mountShell());await click(h,'Review saved and local copies');await click(h,'Refresh saved version');
  let injected=false,mutated=false;const original=Storage.prototype.setItem;
  try{Storage.prototype.setItem=function(key,value){original.call(this,key,value);let parsed;try{parsed=JSON.parse(value)}catch{return}
   if(!injected&&key!==source.key&&key.startsWith('eq:autosave:')&&parsed?.version===2&&parsed.value?.notes==='Adoption checkpoint'){
    injected=true;queueMicrotask(()=>{const mutation=JSON.parse(target==='source'?source.bytes:value);mutation.value.notes='Changed before mount';mutation.serialization=JSON.stringify(mutation.value);original.call(localStorage,target==='source'?source.key:key,JSON.stringify(mutation));mutated=true})}
  };await click(h,'Continue this draft');await waitFor(()=>mutated,'Pre-mount storage mutation injected');await delay(35);
  const activeInput=h.el.querySelector('form [name="notes"]');assert(!activeInput||activeInput.value===blank.notes,'Neither unproven source nor tampered values became editable');assert(h.state.writes.length===0,'Refused adoption never writes');
  }finally{Storage.prototype.setItem=original}
 });
}
await test('full editor shell: same-owner context refresh cannot unmount undurable newer edits',async()=>{
 const h=await editor(await mountShell());await input(h,'notes','Latest undurable context edit');const current=field(h,'notes'),loads=h.state.loads.length;const original=Storage.prototype.setItem;
 try{Storage.prototype.setItem=function(key,value){if(key.startsWith('eq:autosave:'))throw new DOMException('Synthetic quota','QuotaExceededError');return original.call(this,key,value)};
 h.state.context={code:'loading',ownerId:OWNER};h.render();await delay(30);assert(current.isConnected&&current.value==='Latest undurable context edit','Same-owner unavailable context must retain mounted draft');
 assert(h.state.loads.length===loads,'Context refresh cannot silently acquire new baseline');h.state.context=readyContext();h.render();await delay(35);
 assert(field(h,'notes')===current&&current.value==='Latest undurable context edit','Ready context restores same editor instance');assert(h.state.loads.length===loads,'No automatic rebase on context recovery');
 }finally{Storage.prototype.setItem=original}
});
for(const [label,properties] of [['object instead of list',{}],['nontext nested address',[{id:uuid(54),user_id:OWNER,customer_id:CUSTOMER,address:42,city:null,province:null,is_primary:true}]],
 ['foreign nested property',[{id:uuid(54),user_id:uuid(80),customer_id:CUSTOMER,address:'Synthetic foreign property',city:null,province:null,is_primary:true}]]]){
 await test('full editor shell: '+label+' auxiliary data fails before the actual builder mounts',async()=>{
  const h=await mountShell({context:{...readyContext(),customers:[{...customers[0],properties}]}});await delay(30);assert(!h.el.querySelector('form'),'Malformed nested customer context must not enter builder');assert(h.state.writes.length===0,'No transport from invalid context');assert(!h.el.textContent.includes('Synthetic foreign property'),'Foreign context payload not rendered');
 });
}
await test('full editor shell: changed raw pending bytes during local-removal confirmation preserve the record',async()=>{
 const h=await editor(await mountShell());await input(h,'notes','Pending exact bytes');await save(h);const selected=pendingCopies()[0];await click(h,'Review saved and local copies');await click(h,'Remove local Save record');
 await waitFor(()=>document.querySelector('[role="dialog"]'),'Actual confirmation dialog mounted');const changed=JSON.stringify(selected.pending,null,2);localStorage.setItem(selected.key,changed);
 const dialog=document.querySelector('[role="dialog"]'),approve=[...dialog.querySelectorAll('button')].find(x=>textOf(x)==='Remove local record');assert(approve,'Actual local-only confirmation control');approve.click();await delay(35);
 assert(localStorage.getItem(selected.key)===changed,'Whitespace-only raw-byte change invalidates selected record confirmation');assert(h.state.writes.length===1,'Local removal never retries business write');assert(field(h,'notes').value==='Pending exact bytes','Current editor retained');
});
`
}
