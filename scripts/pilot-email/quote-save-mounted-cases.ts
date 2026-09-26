import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { dirname, extname, relative, resolve } from 'node:path'
import { build, type Loader, type Plugin } from 'esbuild'
import type { TestResult } from './database'
import { runIsolatedQuoteBrowser } from './quote-save-caller-cases'
import { mountedShellFixture } from './quote-save-mounted-shell-fixture'

// TEST ONLY: the actual entire QuoteBuilder and its normal descendants mount in
// React StrictMode beside the real CacheOwner. No AST extraction, replacement
// pricing/Save policy, visible browser profile, Supabase, Auth or provider I/O.
// Foundation characterization and dormant shell policy assertions have separate
// labels; default string inputs are not reported as successful pilot numeric I/O.
export const quoteSaveMountedHarnessEvidence: Record<string, unknown> = {}

const aliases: Record<string, string> = {
  'next/navigation': `export function useRouter(){return window.__mountedQuoteIO.router}`,
  'next/link': `import React from 'react'; export default function Link({href,children,prefetch,replace,scroll,shallow,locale,...props}){
    return <a {...props} href={typeof href==='string'?href:'#'} onClick={e=>{e.preventDefault();window.__mountedQuoteIO.navigation.push(String(href))}}>{children}</a>}`,
  '@/lib/supabase/client': `export function createClient(){return window.__mountedQuoteIO.client()}`,
}

function fixtureSource(): string {
  return `
import React,{useEffect,useRef} from 'react';
import {createRoot} from 'react-dom/client';
import {flushSync} from 'react-dom';
import {QuoteBuilder} from '@/components/quotes/QuoteBuilder';
import {PilotQuoteSaveEditorShell} from '@/components/quotes/PilotQuoteSaveEditorShell';
import {CacheOwner} from '@/components/layout/CacheOwner';
import {ConfirmHost} from '@/components/ui/ConfirmHost';
import {Toaster} from '@/components/ui/Toaster';
import {SYSTEM_UNITS} from '@/lib/units';
import {cacheLease,isCurrentLease,getCacheOwner,getCacheGeneration} from '@/lib/clientCache';
const clone=v=>JSON.parse(JSON.stringify(v)),delay=ms=>new Promise(r=>setTimeout(r,ms));
const assert=(ok,message)=>{if(!ok)throw Error(message)};
const uuid=n=>'82000000-0000-4000-8000-'+String(n).padStart(12,'0');
const OWNER=uuid(1),CUSTOMER=uuid(2),TEMPLATE=uuid(3),STAMP='2026-09-10T12:00:00.000Z';
const customers=[{id:CUSTOMER,user_id:OWNER,created_at:STAMP,updated_at:STAMP,name:'Synthetic Customer',email:null,phone:null,
address:'Synthetic property',city:null,province:null,postal_code:null,notes:null,tags:[],acquisition_source:null,referred_by_customer_id:null,
preferred_days:null,avoid_days:null,pref_time_start:null,pref_time_end:null,sms_opt_in:false,email_opt_in:false}];
const templates=[{id:TEMPLATE,user_id:OWNER,created_at:STAMP,updated_at:STAMP,name:'Synthetic repair',category:'Synthetic',default_rate:100,
pricing_display_type:'hourly',default_description:null,notes:null,is_active:true,published_at:null,sort_order:0,unit_cost:null,material_cost:null,
is_favorite:false,recurrence:'one_time',form_template_id:null,measured_by:null}];
const blank={customer_id:CUSTOMER,customer_name:'Synthetic Customer',customer_phone:'',customer_email:'',acquisition_source:'',
address:'Synthetic property',service_type:'Synthetic repair',service_template_id:TEMPLATE,initial_price:200,weekly_price:0,biweekly_price:0,monthly_price:0,
measured_sqft:0,measurement_snapshot:null,suggested_price:0,value_grade:null,nearby_count:null,overgrowth_multiplier:1,distance_km:0,hours:2,crew_size:1,rate:100,
travel_fee:0,custom_travel_required:false,show_travel_separately:false,notes:'Synthetic public scope',internal_notes:'Synthetic internal note',
status:'draft',services:[],has_options:false,options:[],deposit_type:'',deposit_value:0};
const observations={reads:[],auth:[],fetches:[],navigation:[],blocked:[],leases:[],numeric:[]};
const deny=message=>{observations.blocked.push(message);throw Error(message)};
const normalize=columns=>columns.replace(/\\s/g,'');
// Each completed read must match its actual caller's SELECT and scoping shape.
// Unknown tables, operations, projections or writes fail even when a production
// caller catches the thrown error: the final no-unexpected-I/O assertion sees it.
function client(){
 const capturedOwner=getCacheOwner();
 return {auth:{getUser:async()=>{observations.auth.push('getUser');return {data:{user:{id:capturedOwner}},error:null}},
 getSession:async()=>{observations.auth.push('getSession');return {data:{session:{user:{id:capturedOwner}}},error:null}}},
 from:table=>{
   const calls=[];let projection=null;let query;
   const finish=()=>{
     const sig=JSON.stringify(calls);const cols=normalize(projection||'');let data;
     if(table==='service_units'&&cols==='id,user_id,code,label,abbrev,step,decimals,sort_order,active'
       &&sig===JSON.stringify([['eq','active',true],['order','sort_order',{ascending:true}]]))data=clone(SYSTEM_UNITS);
     else if(table==='service_pricing_plans'&&cols==='*'
       &&sig===JSON.stringify([['eq','user_id',capturedOwner],['order','sort_order',{ascending:true}]]))data=[];
     else if(table==='properties'&&cols==='lawn_sqft,measurement_history,address,city,province'
       &&sig===JSON.stringify([['eq','customer_id',CUSTOMER],['order','is_primary',{ascending:false}],['limit',1],['maybeSingle']]))
       data={lawn_sqft:null,measurement_history:[],address:'Synthetic property',city:null,province:null};
     else if(table==='labor_observations'&&cols==='job_id,property_id,service_date,sqft,service_type,crew_size,frequency,is_initial_visit,overgrowth,estimated_minutes,actual_minutes'
       &&sig===JSON.stringify([['eq','user_id',capturedOwner]]))data=[];
     else if(table==='business_settings'&&cols==='smart_labor_enabled,crew_cost_per_hour'
       &&sig===JSON.stringify([['eq','user_id',capturedOwner],['maybeSingle']]))data={smart_labor_enabled:false,crew_cost_per_hour:null};
     else return deny('Unapproved synthetic read '+table+' '+cols+' '+sig);
     assert(capturedOwner===OWNER,'read fixture owner');observations.reads.push({table,columns:cols,calls,owner:capturedOwner});return {data,error:null};
   };
   query=new Proxy({}, {get:(_,method)=>{
     if(method==='then')return (ok,bad)=>Promise.resolve().then(finish).then(ok,bad);
     if(method==='select')return columns=>{if(projection!==null)return deny('Repeated select');projection=columns;return query};
     if(['eq','order','limit','maybeSingle'].includes(method))return (...args)=>{calls.push([method,...args]);return query};
     return ()=>deny('Unapproved synthetic operation '+table+'.'+String(method));
   }});return query;
 },rpc:()=>deny('Synthetic fixture forbids RPC'),storage:new Proxy({}, {get:()=>()=>deny('Synthetic fixture forbids storage')})};
}
window.__mountedQuoteIO={client,navigation:observations.navigation,router:{back:()=>observations.navigation.push('back'),push:x=>observations.navigation.push(x),replace:x=>observations.navigation.push(x),refresh:()=>observations.navigation.push('refresh')}};
window.fetch=async(input,init)=>{
 const url=typeof input==='string'?input:input instanceof Request?input.url:String(input);
 const method=init?.method??(input instanceof Request?input.method:'GET');
 if(url==='/api/ai/assist'&&method==='GET'){observations.fetches.push({url,method,synthetic:true});return new Response(JSON.stringify({aiEnabled:false}),{headers:{'content-type':'application/json'}})}
 return deny('External request refused '+method+' '+url);
};
// CSP independently refuses fetch/XHR/socket/provider scripts; these guards make
// attempted requests observable even if the component swallows its failure.
const originalOpen=XMLHttpRequest.prototype.open;
XMLHttpRequest.prototype.open=function(){return deny('XHR refused')};
window.addEventListener('securitypolicyviolation',e=>observations.blocked.push('CSP '+e.violatedDirective));
window.addEventListener('unhandledrejection',e=>{observations.blocked.push('Unhandled '+String(e.reason));e.preventDefault()});
let roots=[];const results=[];
function LeaseObserver({trace}){
 const first=useRef(null);if(first.current===null)first.current=cacheLease();
 useEffect(()=>{trace.push({phase:'setup',owner:getCacheOwner(),generation:getCacheGeneration(),initialCurrent:isCurrentLease(first.current)});
 return()=>trace.push({phase:'cleanup',owner:getCacheOwner(),generation:getCacheGeneration()})},[]);return null;
}
async function mount(extra={}){
 const state={submitted:null,cancelled:0,trace:[],...extra};const el=document.createElement('section');document.body.append(el);const root=createRoot(el);
 flushSync(()=>root.render(<React.StrictMode><CacheOwner id={OWNER}/><LeaseObserver trace={state.trace}/><ConfirmHost/><Toaster/>
 <QuoteBuilder customers={customers} templates={templates} tiers={[]} settings={null} defaultValues={clone(blank)} isEdit autosaveKey={'quote:mounted:'+uuid(10+roots.length)}
 onSubmit={async values=>{state.submitted=clone(values);return false}} onCancel={()=>state.cancelled++}/></React.StrictMode>));
 const handle={state,el,root,unmount(){flushSync(()=>root.unmount());el.remove();roots=roots.filter(r=>r!==handle)}};roots.push(handle);
 await delay(60);return handle;
}
function field(h,name){const el=h.el.querySelector('[name="'+name+'"]');assert(el instanceof HTMLInputElement||el instanceof HTMLTextAreaElement,'Actual input '+name);return el}
// Native DOM input events go through the real Input -> register -> RHF path.
// Never call RHF setValue, dispatch a copied handler, or replace form arithmetic.
async function inputElement(el,value){assert(el instanceof HTMLInputElement||el instanceof HTMLTextAreaElement,'Actual editable DOM field');el.focus();const proto=el instanceof HTMLTextAreaElement?HTMLTextAreaElement.prototype:HTMLInputElement.prototype;
 Object.getOwnPropertyDescriptor(proto,'value').set.call(el,value);el.dispatchEvent(new InputEvent('input',{bubbles:true,inputType:'insertText',data:value}));el.dispatchEvent(new Event('change',{bubbles:true}));await delay(20)}
async function input(h,name,value){await inputElement(field(h,name),value)}
async function submit(h){const button=h.el.querySelector('button[type="submit"]');assert(button,'Actual Save control');button.click();await delay(35);assert(h.state.submitted,'Actual RHF handler reached synthetic callback')}
async function test(name,fn){try{await fn();results.push({name,pass:true})}catch(e){results.push({name,pass:false,error:String(e.message).slice(0,1200)})}
 finally{for(const h of [...roots])h.unmount();localStorage.clear();sessionStorage.clear()}}
await test('full builder foundation: actual CacheOwner StrictMode replays and invalidates the initial lease',async()=>{
 const h=await mount();assert(h.el.querySelector('form'),'Full builder form mounted');assert(field(h,'initial_price').value==='200','Existing baseline price displayed');
 assert(h.state.trace.filter(x=>x.phase==='setup').length===2,'Real StrictMode effect replay');assert(h.state.trace.filter(x=>x.phase==='cleanup').length===1,'Real StrictMode cleanup');
 const setup=h.state.trace.filter(x=>x.phase==='setup');assert(setup[1].generation>setup[0].generation,'CacheOwner advanced lease generation');assert(setup[1].initialCurrent===false,'Initial controller lease would be stale');
 assert(getCacheOwner()===OWNER,'Owner re-adopted');observations.leases.push(...h.state.trace);await submit(h);assert(h.state.submitted.initial_price===200,'Untouched baseline remains number');
 assert(h.state.submitted.notes===blank.notes&&h.state.submitted.internal_notes===blank.internal_notes,'Public and internal form content remains distinct');
});
await test('full builder foundation: actual default numeric controls currently submit typed strings',async()=>{
 const h=await mount();await input(h,'initial_price','275');await input(h,'hours','3.5');await input(h,'crew_size','2');await input(h,'rate','125');await submit(h);
 for(const [name,value] of [['initial_price','275'],['hours','3.5'],['crew_size','2'],['rate','125']]){
  assert(h.state.submitted[name]===value,'Default DOM -> RHF string observed '+name);observations.numeric.push({field:name,value:h.state.submitted[name],type:typeof h.state.submitted[name]});}
});
await test('full builder foundation: blank numeric draft remains blank through actual default form autosave',async()=>{
 const h=await mount();await input(h,'hours','');await delay(850);const entries=Object.keys(localStorage).filter(k=>k.startsWith('eq:autosave:quote:mounted:'));
 assert(entries.length===1,'One default edit draft');const draft=JSON.parse(localStorage.getItem(entries[0]));assert(draft.value.hours==='','Blank is retained without NaN or invented hours');
 await submit(h);assert(h.state.submitted.hours==='','Untouched raw blank reaches default callback');assert(localStorage.getItem(entries[0])!==null,'Default false callback keeps draft');
});
${mountedShellFixture()}
await test('full mounted editor: all auxiliary I/O used the strict synthetic read-only boundary',async()=>{
 assert(observations.blocked.length===0,observations.blocked.join('; '));assert(observations.navigation.length===0,'No navigation/provider flow');
 for(const table of ['properties','service_units','service_pricing_plans','labor_observations','business_settings'])assert(observations.reads.some(r=>r.table===table),'Actual read exercised '+table);
 assert(observations.fetches.length===1&&observations.fetches[0].synthetic,'Only synthetic AI capability response, cached by actual hook');assert(getCacheOwner()===null,'Final actual CacheOwner unmount cleared owner');
});
XMLHttpRequest.prototype.open=originalOpen;
window.__pilotEvidence={...observations,scope:'actual dormant editor shell + full QuoteBuilder + CacheOwner; synthetic context and transport',
 excluded:['production routes','live Auth/PostgREST','SQL','maps/scanning','schedule providers','visual app layout'],inputMethod:'native DOM input events, not trusted OS keystrokes'};
window.__pilotResults=results;
`
}

export async function runQuoteSaveMountedCases(chrome?: string): Promise<TestResult[]> {
  const fixture = fixtureSource()
  const loadedBytes = new Map<string, Buffer>()
  const plugin: Plugin = {
    name: 'strict-synthetic-quote-io',
    setup(context) {
      context.onResolve({ filter: /^(next\/navigation|next\/link|@\/lib\/supabase\/client)$/ }, args => ({ path: args.path, namespace: 'quote-test-io' }))
      context.onLoad({ filter: /.*/, namespace: 'quote-test-io' }, args => ({ contents: aliases[args.path], loader: 'tsx', resolveDir: process.cwd() }))
      context.onLoad({ filter: /\.(?:[cm]?js|jsx|ts|tsx|json)$/, namespace: 'file' }, args => {
        // Hash the exact bytes passed to esbuild, not a later filesystem reread
        // that could have changed while another author works in this checkout.
        const contents = readFileSync(args.path)
        loadedBytes.set(resolve(args.path), contents)
        const extension = extname(args.path).slice(1)
        const loader = (extension === 'mjs' || extension === 'cjs' ? 'js' : extension) as Loader
        return { contents, loader, resolveDir: dirname(args.path) }
      })
    },
  }
  const bundle = await build({ stdin: { contents: fixture, sourcefile: 'quote-save-mounted-fixture.tsx', resolveDir: process.cwd(), loader: 'tsx' },
    write: false, bundle: true, metafile: true, platform: 'browser', format: 'esm', target: 'chrome120', jsx: 'automatic',
    tsconfig: resolve('tsconfig.json'), define: { 'process.env.NODE_ENV': '"development"' }, plugins: [plugin], logLevel: 'silent' })
  const sha = (bytes: string | Buffer) => createHash('sha256').update(bytes).digest('hex')
  const pins: Record<string, string> = {}
  for (const path of Object.keys(bundle.metafile.inputs).sort()) {
    if (path === 'quote-save-mounted-fixture.tsx') pins[path] = sha(fixture)
    else if (path.startsWith('quote-test-io:')) pins[path] = sha(aliases[path.slice('quote-test-io:'.length)])
    else {
      const bytes = loadedBytes.get(resolve(path))
      if (!bytes) throw new Error('Uncaptured mounted-browser dependency: ' + path)
      pins[relative(process.cwd(), resolve(path)).replaceAll('\\', '/')] = sha(bytes)
    }
  }
  // Include harness/build configuration as well as every bundled dependency.
  for (const path of ['scripts/pilot-email/quote-save-mounted-cases.ts', 'scripts/pilot-email/quote-save-mounted-shell-fixture.ts', 'scripts/pilot-email/quote-save-caller-cases.ts', 'tsconfig.json', 'package.json', 'package-lock.json']) pins[path] = sha(readFileSync(path))
  for (const key of Object.keys(quoteSaveMountedHarnessEvidence)) delete quoteSaveMountedHarnessEvidence[key]
  Object.assign(quoteSaveMountedHarnessEvidence, { sourcePins: pins, bundleSha256: sha(bundle.outputFiles[0].text), bundleBytes: bundle.outputFiles[0].contents.length,
    replacements: Object.keys(aliases), browser: {} })
  return runIsolatedQuoteBrowser(bundle.outputFiles[0].text, quoteSaveMountedHarnessEvidence.browser as Record<string, unknown>, chrome)
}
