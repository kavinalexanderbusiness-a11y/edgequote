import { readFileSync, mkdtempSync, rmSync } from 'node:fs'
import { resolve, join, sep } from 'node:path'
import { tmpdir } from 'node:os'
import { createServer } from 'node:http'
import { spawn } from 'node:child_process'
import { build } from 'esbuild'
import ts from 'typescript'
import type { TestResult } from './database'

// Real React + react-hook-form + production hook/controller in an isolated
// headless browser. Source extraction is TEST ONLY. This is the actual builder
// submit/autosave seam, not the full mounted QuoteBuilder or app E2E. No auth,
// env files, SDK, database, actual fetch route, customer data or external site.
function builderSeams(): { autosave: string; submit: string; cancel: string; lifetime: string } {
  const path = resolve('src/components/quotes/QuoteBuilder.tsx')
  const source = ts.createSourceFile(path, readFileSync(path,'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
  const builder = source.statements.find(s => ts.isFunctionDeclaration(s) && s.name?.text === 'QuoteBuilder') as ts.FunctionDeclaration
  if (!builder?.body) throw new Error('QuoteBuilder source unavailable')
  const initializer = (name: string) => {
    for (const s of builder.body!.statements) if (ts.isVariableStatement(s)) {
      const found = s.declarationList.declarations.find(d => ts.isIdentifier(d.name) && d.name.text === name)
      if (found?.initializer) return found.initializer.getText(source)
    }
    throw new Error('Missing actual builder seam: '+name)
  }
  const lifetime = builder.body.statements.filter(s => {
    const text = s.getText(source)
    return text.startsWith('const pilotSaveCurrent') || text.startsWith('pilotSaveCurrent.current =')
      || text.startsWith('const pilotSaveMounted') || text.startsWith('const [pilotSaveMessage,')
      || text.startsWith('useEffect(() => { pilotSaveMounted.current')
  }).map(s => s.getText(source)).join('\n')
  if (!lifetime.includes('pilotSaveMounted.current = false')) throw new Error('Missing builder unmount fence')
  return { autosave: initializer('autosave'), submit: initializer('submit'), cancel: initializer('cancelPilotSave'), lifetime }
}

function browserSource(): string {
  const seam = builderSeams()
  return `
import React, {useEffect,useRef,useState} from 'react';
import {createRoot} from 'react-dom/client';
import {flushSync} from 'react-dom';
import {useForm} from 'react-hook-form';
import {useAutosave} from '@/hooks/useAutosave';
import {setCacheOwner} from '@/lib/clientCache';
import {PilotQuoteSaveCaller,parsePilotQuoteSaveReceipt} from '@/lib/quotes/pilotQuoteSaveCaller';
import {optionSetProblem,optionsConflictWithLines,optionProblemMessage,OPTIONS_VS_LINES_MESSAGE} from '@/lib/quoteOptions';
const results=[]; const delay=ms=>new Promise(r=>setTimeout(r,ms));
const uuid=n=>'81000000-0000-4000-8000-'+String(n).padStart(12,'0');
const OWNER=uuid(1),OTHER=uuid(2),QUOTE=uuid(3),REV='a'.repeat(32),STAMP='2026-09-10T12:00:00.000Z';
const blank={customer_id:'__manual',customer_name:'Synthetic owner',address:'Synthetic property',service_type:'Synthetic service',service_template_id:'',
overgrowth_multiplier:1,distance_km:0,hours:1,crew_size:1,rate:100,travel_fee:0,notes:'baseline',internal_notes:'synthetic private',
initial_price:100,weekly_price:0,biweekly_price:0,monthly_price:0,custom_travel_required:false,show_travel_separately:false,status:'draft',
measured_sqft:0,measurement_snapshot:null,suggested_price:0,value_grade:null,nearby_count:null,services:[],has_options:false,options:[],deposit_type:'',deposit_value:0};
const clone=v=>JSON.parse(JSON.stringify(v));
// Required injected recovery validator for this synthetic form; never a shipping
// default. Production adapter must supply its reviewed full form schema.
const validate=v=>v&&Object.keys(v).length===Object.keys(blank).length&&Object.keys(blank).every(k=>Object.hasOwn(v,k))
&&Object.keys(blank).every(k=>blank[k]===null?v[k]===null:Array.isArray(blank[k])?Array.isArray(v[k])&&v[k].length===0:typeof v[k]===typeof blank[k])?v:null;
const assert=(b,m)=>{if(!b)throw new Error(m)};
const keys=prefix=>Object.keys(localStorage).filter(k=>k.startsWith(prefix));
const draftKey=c=>'eq:autosave:owner:'+encodeURIComponent(OWNER)+':'+c.autosaveKey;
const pendingKeys=()=>keys('eq:quote-save:pending:'+OWNER+':'+QUOTE+':');
const receipt=i=>({code:'committed',owner_id:OWNER,quote_id:QUOTE,client_operation_id:i.clientOperationId,editor_generation:i.editorGeneration,
before_revision:i.expectedEditorRevision,after_revision:'b'.repeat(32),quote:{id:QUOTE,user_id:OWNER,quote_number:'SYN-1',updated_at:STAMP,customer_id:null,
customer_name:i.values.customer_name,property_id:null,address:i.values.address,service_type:i.values.service_type,service_template_id:null,
initial_price:100,weekly_price:0,biweekly_price:0,monthly_price:0,hours:1,crew_size:1,rate:100,travel_fee:0,overgrowth_multiplier:1,
custom_travel_required:false,show_travel_separately:false,notes:i.values.notes,internal_notes:i.values.internal_notes,measured_sqft:0,measurement_snapshot:null,
suggested_price:0,value_grade:null,nearby_count:null,price_source:null,pricing_config_version_id:null,deposit_type:null,deposit_value:null,status:'draft',
selected_option_id:null,accepted_price:null,total:100,subtotal:100,man_hours:1},options:[],services:[],measurement:null,acceptance_current:false,
identity:{code:'unchanged',quote_id:QUOTE,customer_id:null,customer_name:i.values.customer_name,property_id:null,updated_at:STAMP,created_customer:false,created_property:false,matched_by:null}});
let counter=0,roots=[],ioCount=0;
function controller(write,extra={}) { return new PilotQuoteSaveCaller({quoteId:QUOTE,expectedEditorRevision:REV,editorGeneration:'instance_'+(++counter),validateValues:validate,
write:async i=>{ioCount++;return write(i)},readReconciliation:async()=>({code:'matching_saved_values'}),onRecoveryRequested:()=>{},...extra}); }
function Fixture({config}) {
const pilotSave=config.controller;
${seam.lifetime}
const {handleSubmit,watch,getValues,reset,setValue,register}=useForm({defaultValues:clone(blank)});
const [hasUserEdited,setEdited]=useState(false); const formValues=watch(); const isEdit=true;
const autosaveKey='quote:'+QUOTE; const autosaveBaselineUpdatedAt=config.baseline??null;
const autosave=${seam.autosave};
const effectiveTotal=100,zeroTotalArmed=false; const noop=()=>{};
const setServicesOpen=noop,setMaterialsOpen=noop,setZeroTotalArmed=noop,setLaborOpen=noop,setPlanOpen=noop,setTravelOpen=noop,setFocus=noop;
const LABOR_FIELDS=[],PLAN_FIELDS=[],TRAVEL_FIELDS=[];const toast={error:noop};
const onSubmit=config.onSubmit??(async()=>true);
const submit=${seam.submit};
const onCancel=config.onCancel;const router={back:config.onCancel??noop};const cancelPilotSave=${seam.cancel};
config.api={autosave,submit,cancelPilotSave,getValues,reset,setValue,setEdited,pilotSaveMessage};
return <form onSubmit={submit}><input aria-label="notes" {...register('notes')} /><button type="submit">Save</button></form>;
}
async function mount(c,extra={}) { const config={controller:c,...extra};const el=document.createElement('div');document.body.append(el);const root=createRoot(el);
flushSync(()=>root.render(<React.StrictMode><Fixture config={config}/></React.StrictMode>));await delay(25);
const handle={config,root,el,unmount(){flushSync(()=>root.unmount());el.remove();roots=roots.filter(x=>x!==handle)}};roots.push(handle);return handle; }
async function type(h,text){flushSync(()=>{h.config.api.setEdited(true);h.config.api.setValue('notes',text,{shouldDirty:true});});await delay(5);}
async function test(name,fn){ try{await fn();results.push({name,pass:true});}catch(e){results.push({name,pass:false,error:String(e.message).slice(0,1000)});}finally{
for(const r of [...roots])r.unmount();setCacheOwner(null);localStorage.clear();setCacheOwner(OWNER);ioCount=0;}}
setCacheOwner(OWNER);
await test('browser seam: committed Save clears only exact staged owned draft; stale timer cannot recreate',async()=>{
const c=controller(i=>receipt(i));const h=await mount(c);await type(h,'submitted');await h.config.api.submit();await delay(900);
assert(ioCount===1,'one dispatch');assert(localStorage.getItem(draftKey(c))===null,'exact draft cleared');assert(pendingKeys().length===0,'operation resolved');
assert(keys('eq:quote-save:committed:').length===1,'committed acknowledgement durably stored');h.unmount();assert(localStorage.getItem(draftKey(c))===null,'unmount does not recreate');});
await test('browser seam: response loss keeps submitted and editable copies; read-only match never retries',async()=>{
const c=controller(()=>{throw Error('lost')});const h=await mount(c);await type(h,'submitted lost');await h.config.api.submit();
assert(ioCount===1&&pendingKeys().length===1,'one unresolved dispatch');const r=c.listRecovery();assert(r.length===1&&r[0].pending.state==='unknown','unknown recovery');
assert(JSON.parse(localStorage.getItem(draftKey(c))).value.notes==='submitted lost','editable copy');
assert((await c.reconcile(r[0].pending)).code==='matching_saved_values','read-only match');await h.config.api.submit();assert(ioCount===1&&pendingKeys().length===1,'matching server state does not clear or retry');});
await test('browser seam: server-newer reopen preserves pending instance and requires explicit recovery',async()=>{
const c=controller(()=>{throw Error('lost')});const h=await mount(c);await type(h,'lost then reopened');await h.config.api.submit();h.unmount();
const reopened=controller(()=>{throw Error('unexpected')},{editorGeneration:c.editorGeneration});const second=await mount(reopened,{baseline:'2099-01-01T00:00:00Z'});
assert(second.config.api.autosave.draft?.notes==='lost then reopened','pending protects older timestamp');assert(second.config.api.getValues().notes==='baseline','no automatic restore');
await second.config.api.submit();assert(ioCount===1,'no remapping to new baseline');});
await test('browser seam: new typing during in-flight Save survives after-await getValues and exit',async()=>{
let finish;const c=controller(i=>new Promise(r=>{finish=()=>r(receipt(i))}));const h=await mount(c);await type(h,'submitted');const p=h.config.api.submit();await delay(20);
await type(h,'newer typing');finish();await p;assert(h.config.api.getValues().notes==='newer typing','form remains newer');
assert(JSON.parse(localStorage.getItem(draftKey(c))).value.notes==='newer typing','newer draft flushed');assert(pendingKeys().length===0,'only completed op removed');
h.unmount();assert(JSON.parse(localStorage.getItem(draftKey(c))).value.notes==='newer typing','exit retains newer');});
await test('browser seam: getValues sees newer RHF input before watched rerender publishes',async()=>{
let finish;const c=controller(i=>new Promise(r=>{finish=()=>r(receipt(i))}));const h=await mount(c);await type(h,'submitted');const p=h.config.api.submit();await delay(20);
h.config.api.setValue('notes','newer before render',{shouldDirty:true});finish();await p;
assert(JSON.parse(localStorage.getItem(draftKey(c))).value.notes==='newer before render','fresh form serialization protects unpublished input');});
await test('browser seam: reverting to mount baseline during Save is a newer durable edit',async()=>{
let finish;const c=controller(i=>new Promise(r=>{finish=()=>r(receipt(i))}));const h=await mount(c);await type(h,'submitted B');const p=h.config.api.submit();await delay(20);await type(h,'baseline');finish();await p;
assert(JSON.parse(localStorage.getItem(draftKey(c))).value.notes==='baseline','newer A persisted despite matching mount baseline');assert(pendingKeys().length===0,'acknowledged operation alone resolved');h.unmount();assert(JSON.parse(localStorage.getItem(draftKey(c))).value.notes==='baseline','newer A survives exit');});
await test('browser seam: return-to-baseline edit is flushed on pending exit before response loss',async()=>{
let finish;const c=controller(()=>new Promise((_,reject)=>{finish=()=>reject(Error('lost'))}));const h=await mount(c);await type(h,'submitted B');const p=h.config.api.submit();await delay(20);await type(h,'baseline');h.unmount();finish();await p;
assert(JSON.parse(localStorage.getItem(draftKey(c))).value.notes==='baseline','unmount protects newer A before debounce');assert(c.listRecovery()[0].pending.submittedValues.notes==='submitted B','immutable B remains separately');});
await test('browser seam: pending Cancel and reopen flushes newer typing before debounce',async()=>{
let finish;const c=controller(i=>new Promise(r=>{finish=()=>r(receipt(i))}));const h=await mount(c);await type(h,'submitted');const p=h.config.api.submit();await delay(20);await type(h,'cancelled newer');h.unmount();finish();await p;
assert(JSON.parse(localStorage.getItem(draftKey(c))).value.notes==='cancelled newer','unmount flush');assert(pendingKeys().length===1,'unmounted builder does not finalize');
const reopen=controller(()=>null,{editorGeneration:c.editorGeneration});const r=await mount(reopen,{baseline:'2099-01-01T00:00:00Z'});assert(r.config.api.autosave.draft?.notes==='cancelled newer','newer saved quote cannot purge pending copy');});
await test('browser seam: acknowledged Save cannot navigate or remove recovery when newer-draft flush fails',async()=>{
let finish,notified=0;const c=controller(i=>new Promise(r=>{finish=()=>r(receipt(i))}),{onCommitted:()=>notified++});const h=await mount(c);await type(h,'submitted');const p=h.config.api.submit();await delay(20);await type(h,'newer undurable');
const original=Storage.prototype.setItem;try{Storage.prototype.setItem=function(k,v){if(k===draftKey(c))throw new DOMException('synthetic quota','QuotaExceededError');return original.call(this,k,v)};finish();await p;
assert(notified===0,'navigation callback suppressed');assert(pendingKeys().length===1,'pending recovery retained');assert(h.config.api.getValues().notes==='newer undurable','newer form retained');
assert(keys('eq:quote-save:committed:').length===1,'acknowledgement stored separately');}finally{Storage.prototype.setItem=original}});
await test('browser seam: explicit Cancel refuses navigation if current-draft storage fails',async()=>{
let cancelled=0;const c=controller(i=>receipt(i));const h=await mount(c,{onCancel:()=>cancelled++});await type(h,'cancel draft');const original=Storage.prototype.setItem;
try{Storage.prototype.setItem=function(){throw new DOMException('synthetic quota','QuotaExceededError')};h.config.api.cancelPilotSave();await delay(20);
assert(cancelled===0,'Cancel must not navigate');assert(h.config.api.getValues().notes==='cancel draft','current edits remain visible');assert(h.config.api.pilotSaveMessage.includes('Keep this editor open'),'storage failure explained');}
finally{Storage.prototype.setItem=original}h.config.api.cancelPilotSave();assert(cancelled===1,'explicit Cancel resumes once durable');assert(JSON.parse(localStorage.getItem(draftKey(c))).value.notes==='cancel draft','exit copy verified');});
await test('browser seam: owner switch fences late response, stale timers and foreign recovery',async()=>{
let finish;const c=controller(i=>new Promise(r=>{finish=()=>r(receipt(i))}));const h=await mount(c);await type(h,'owner A');const p=h.config.api.submit();await delay(20);const before=localStorage.getItem(draftKey(c));setCacheOwner(OTHER);await delay(25);
finish();await p;await delay(850);assert(localStorage.getItem(draftKey(c))===before,'late A callback inert');assert(c.listRecovery().length===0,'old owner cannot render recovery');
const foreign=controller(()=>null);assert(foreign.listRecovery().length===0,'B never lists A record');h.unmount();assert(localStorage.getItem(draftKey(c))===before,'lost lease cannot flush');});
await test('browser seam: two instances never overwrite drafts or clear each other',async()=>{
let finish;const a=controller(i=>new Promise(r=>{finish=()=>r(receipt(i))}));const b=controller(i=>receipt(i));const x=await mount(a),y=await mount(b);
await type(x,'instance A');await type(y,'instance B');y.config.api.autosave.flushCurrent(y.config.api.getValues());const bBytes=localStorage.getItem(draftKey(b));const p=x.config.api.submit();await delay(20);
await y.config.api.submit();assert(ioCount===1,'second instance requires explicit pending review');finish();await p;assert(localStorage.getItem(draftKey(b))===bBytes,'B draft unchanged by A completion');});
await test('browser seam: corrupt and foreign recovery entries are not rendered or adopted',async()=>{
const c=controller(i=>receipt(i));localStorage.setItem('eq:autosave:quote:'+QUOTE,JSON.stringify({value:{notes:'legacy private'},savedAt:Date.now()}));
localStorage.setItem('eq:quote-save:pending:'+OWNER+':'+QUOTE+':'+uuid(20),'corrupt');
localStorage.setItem('eq:quote-save:pending:'+OTHER+':'+QUOTE+':'+uuid(21),JSON.stringify({submittedValues:{notes:'foreign private'}}));
localStorage.setItem(draftKey(c),JSON.stringify({owner:OTHER,value:blank,savedAt:Date.now(),generation:c.editorGeneration,serialization:JSON.stringify(blank)}));
const h=await mount(c);assert(c.listRecovery().length===0&&h.config.api.autosave.draft===null,'corrupt/foreign not renderable');await h.config.api.submit();assert(ioCount===0,'corrupt own namespace fails closed');
assert(localStorage.getItem('eq:autosave:quote:'+QUOTE)!==null,'legacy untouched');});
await test('browser seam: storage quota before stage prevents all network dispatch',async()=>{
const c=controller(i=>receipt(i));const h=await mount(c);await type(h,'quota copy');const original=Storage.prototype.setItem;
try{Storage.prototype.setItem=function(){throw new DOMException('synthetic quota','QuotaExceededError')};await h.config.api.submit();assert(ioCount===0,'no dispatch');assert(h.config.api.getValues().notes==='quota copy','form retained');}
finally{Storage.prototype.setItem=original}});
await test('browser seam: unavailable storage refuses before dispatch',async()=>{
const c=controller(i=>receipt(i),{storage:()=>{throw Error('denied')}});const h=await mount(c);await type(h,'denied copy');await h.config.api.submit();assert(ioCount===0,'storage denied before network');assert(h.config.api.getValues().notes==='denied copy','form retained');});
await test('browser seam: failed pending readback refuses before dispatch',async()=>{
const c=controller(i=>receipt(i),{storage:()=>({get length(){return localStorage.length},key:i=>localStorage.key(i),getItem:k=>k.startsWith('eq:quote-save:pending:')?null:localStorage.getItem(k),setItem:(k,v)=>localStorage.setItem(k,v),removeItem:k=>localStorage.removeItem(k)})});
const h=await mount(c);await type(h,'readback copy');await h.config.api.submit();assert(ioCount===0,'no dispatch without exact readback');assert(localStorage.getItem(draftKey(c))!==null,'editable recovery retained');});
await test('browser seam: malformed acknowledgement keeps recovery and never runs boolean clear',async()=>{
const c=controller(i=>({...receipt(i),client_operation_id:uuid(99)}));let legacy=0;const h=await mount(c,{onSubmit:async()=>{legacy++;return true}});await type(h,'malformed');await h.config.api.submit();assert(legacy===0&&ioCount===1,'opt-in bypasses legacy submit');
assert(pendingKeys().length===1&&localStorage.getItem(draftKey(c))!==null,'malformed acknowledgement retained');});
await test('browser seam: old submit cannot clear a replacement controller generation',async()=>{
let finish;const a=controller(i=>new Promise(r=>{finish=()=>r(receipt(i))}));const h=await mount(a);await type(h,'old generation');const p=h.config.api.submit();await delay(20);const b=controller(i=>receipt(i));
h.config.controller=b;flushSync(()=>h.root.render(<React.StrictMode><Fixture config={h.config}/></React.StrictMode>));await delay(20);finish();await p;
assert(pendingKeys().length===1,'old completion cannot finalize new editor');assert(localStorage.getItem(draftKey(a))!==null,'old submitted copy retained');});
await test('browser seam: default legacy false/true draft behavior remains unchanged',async()=>{
let accept=false;const h=await mount(undefined,{onSubmit:async()=>accept});await type(h,'legacy edited');await delay(850);const key='eq:autosave:quote:'+QUOTE;
assert(localStorage.getItem(key)!==null,'default legacy draft written');await h.config.api.submit();assert(localStorage.getItem(key)!==null,'false retains draft');accept=true;await h.config.api.submit();assert(localStorage.getItem(key)===null,'true clears default draft');});
await test('strict receipt parser binds all request fields and rejects unknown/incomplete payload',async()=>{
const intent={quoteId:QUOTE,clientOperationId:uuid(40),expectedEditorRevision:REV,editorGeneration:'parser',values:blank};const r=receipt(intent);
const p={version:1,owner:OWNER,quoteId:QUOTE,clientOperationId:intent.clientOperationId,editorGeneration:'parser',originalEditorRevision:REV,submittedValues:blank,submittedSerialization:JSON.stringify(blank),stagedAt:1,state:'pending'};
assert(parsePilotQuoteSaveReceipt(r,p)!==null,'complete actual wire shape accepted');
for(const field of ['owner_id','quote_id','client_operation_id','editor_generation','before_revision'])assert(parsePilotQuoteSaveReceipt({...r,[field]:'wrong'},p)===null,'correlation '+field);
assert(parsePilotQuoteSaveReceipt({...r,extra:true},p)===null,'unknown top key');assert(parsePilotQuoteSaveReceipt({...r,quote:{...r.quote,extra:true}},p)===null,'unknown quote key');
assert(parsePilotQuoteSaveReceipt({...r,after_revision:r.before_revision},p)===null,'real Save must change tuple revision');
assert(parsePilotQuoteSaveReceipt({...r,options:[{id:uuid(41)}]},p)===null,'incomplete option');assert(parsePilotQuoteSaveReceipt({...r,services:[{id:uuid(42)}]},p)===null,'incomplete service');
assert(parsePilotQuoteSaveReceipt({...r,quote:{...r.quote,total:NaN}},p)===null,'nonfinite JSON rejected');});
window.__pilotResults=results;
`
}

/** Explicit focused browser proof. Caller owns presentation of these results. */
export async function runQuoteSaveCallerCases(chrome = 'C:/Program Files/Google/Chrome/Application/chrome.exe'): Promise<TestResult[]> {
  const bundle = await build({ stdin: { contents: browserSource(), sourcefile: 'quote-save-caller-fixture.tsx', resolveDir: process.cwd(), loader: 'tsx' },
    write: false, bundle: true, platform: 'browser', format: 'esm', target: 'chrome120', jsx: 'automatic', tsconfig: resolve('tsconfig.json'),
    define: { 'process.env.NODE_ENV': '"development"' }, logLevel: 'silent' })
  const server = createServer((req,res) => {
    res.setHeader('Content-Security-Policy', "default-src 'none'; script-src 'self'; connect-src 'none'; style-src 'unsafe-inline'")
    res.setHeader('Content-Type', req.url === '/fixture.js' ? 'text/javascript' : 'text/html')
    res.end(req.url === '/fixture.js' ? bundle.outputFiles[0].text : '<!doctype html><title>Isolated quote Save proof</title><script type="module" src="/fixture.js"></script>')
  })
  await new Promise<void>(r=>server.listen(0,'127.0.0.1',r))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('No isolated loopback port')
  const profileRoot = resolve(tmpdir()), profile = mkdtempSync(join(profileRoot,'edgehq-save-proof-'))
  const child = spawn(chrome,['--headless=new','--disable-gpu','--no-first-run','--no-default-browser-check','--disable-background-networking',
    '--disable-component-update','--disable-sync','--remote-debugging-port=0','--user-data-dir='+profile,'about:blank'],{stdio:'ignore',windowsHide:true})
  let socket: WebSocket | null = null
  const wait = (ms:number)=>new Promise(r=>setTimeout(r,ms))
  try {
    let port = ''
    for (let attempt=0;attempt<100;attempt++) { try { port=readFileSync(join(profile,'DevToolsActivePort'),'utf8').split('\n')[0];break } catch { await wait(100) } }
    if (!port) throw new Error('Isolated Chrome did not start')
    const tabs = await fetch('http://127.0.0.1:'+port+'/json/list').then(r=>r.json()) as {type:string;webSocketDebuggerUrl:string}[]
    const target = tabs.find(t=>t.type==='page')
    if (!target) throw new Error('Isolated browser page unavailable')
    socket = new WebSocket(target.webSocketDebuggerUrl)
    await new Promise<void>((res,rej)=>{socket!.addEventListener('open',()=>res(),{once:true});socket!.addEventListener('error',()=>rej(new Error('CDP failed')),{once:true})})
    let nextId=0
    const pending = new Map<number,{resolve:(value:any)=>void;reject:(error:Error)=>void}>()
    const errors:string[]=[]
    socket.addEventListener('message',event=>{const m=JSON.parse(String(event.data));if(m.id){const p=pending.get(m.id);pending.delete(m.id);if(m.error)p?.reject(new Error(m.error.message));else p?.resolve(m.result)}
      else if(m.method==='Runtime.exceptionThrown')errors.push(m.params.exceptionDetails.exception?.description??m.params.exceptionDetails.text)})
    const send=(method:string,params:Record<string,unknown>={})=>new Promise<any>((res,rej)=>{const id=++nextId;pending.set(id,{resolve:res,reject:rej});socket!.send(JSON.stringify({id,method,params}))})
    await send('Runtime.enable');await send('Page.enable');await send('Page.navigate',{url:'http://127.0.0.1:'+address.port})
    for(let attempt=0;attempt<180;attempt++) {
      if(errors.length)throw new Error(errors.join('\n').slice(0,3000))
      const result=await send('Runtime.evaluate',{expression:'window.__pilotResults ?? null',returnByValue:true})
      if(Array.isArray(result.result?.value))return result.result.value as TestResult[]
      await wait(100)
    }
    throw new Error('Isolated browser proof timed out')
  } finally {
    socket?.close(); child.kill();await new Promise<void>(r=>server.close(()=>r()));await wait(300)
    // Delete only the fresh, verified task-owned profile; never the user's Chrome profile.
    if(resolve(profile).startsWith(profileRoot+sep)&&profile.includes('edgehq-save-proof-')) {
      try { rmSync(profile,{recursive:true,force:true,maxRetries:3,retryDelay:100}) } catch { /* Chrome can briefly retain profile locks */ }
    }
  }
}
