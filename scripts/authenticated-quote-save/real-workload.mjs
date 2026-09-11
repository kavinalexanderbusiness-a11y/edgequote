import {execFileSync,spawn} from 'node:child_process'
import {createHash} from 'node:crypto'
import {createRequire} from 'node:module'
import {readFileSync,writeFileSync,mkdirSync,readdirSync,realpathSync,existsSync,appendFileSync,renameSync} from 'node:fs'
import {join,relative,isAbsolute} from 'node:path'
import {pathToFileURL} from 'node:url'
import assert from 'node:assert/strict'
import {seedFixtures,readFixture} from './fixtures.mjs'
import {generateMount} from './generate-mount.mjs'
import {runAuthenticatedQuoteSaveBrowser} from './browser-cases.mjs'
import {runLostAcknowledgementBrowser} from './lost-ack-browser-cases.mjs'
import {runVersionedAcceptanceBrowser,acceptanceFixtureTerms} from './versioned-acceptance-browser-cases.mjs'
import {runAcceptanceAuthorityBrowser} from './acceptance-authority-browser-cases.mjs'
import {runLockOrderBrowser} from './lock-order-browser-cases.mjs'
import {createLockOrderControl} from './lock-order-control.mjs'
import {runCustomerAcceptanceUIBrowser} from './customer-acceptance-ui-browser-cases.mjs'

const config=JSON.parse(readFileSync(process.argv[2],'utf8'))
const {source,taskRoot,output,marker}=config
const lostAck=config.proofCase==='lost-acknowledgement'
const versionedAcceptance=config.proofCase==='versioned-acceptance'
const lockOrder=config.proofCase==='acceptance-lock-order'
const customerUI=config.proofCase==='customer-acceptance-ui'
const usesAcceptance=versionedAcceptance||lockOrder||customerUI
assert(['acknowledged','lost-acknowledgement','versioned-acceptance','acceptance-lock-order','customer-acceptance-ui'].includes(config.proofCase),'Explicit proof case required')
const report={startedAt:new Date().toISOString(),pass:false,proofCase:config.proofCase,candidate:config.candidate,tree:config.tree,runId:config.runId,
  platformSubstitutions:[],schemaApplications:[],sqlConnections:[],cleanup:{},scope:'Real local Auth and PostgREST with actual canonical cookie/browser clients, source adapters and normally committed native Save; synthetic business identities only.'}
const hash=v=>createHash('sha256').update(v).digest('hex')
const req=createRequire(join(source,'package.json'))
const {createClient}=req('@supabase/supabase-js')
const {chromium}=createRequire(join(source,'scripts/authenticated-quote-save/tools/package.json'))('playwright-core')
const secret=[config.anonKey,config.serviceKey,config.dbPassword]
const scrub=value=>{
  let result=String(value)
  for(const s of secret)if(s?.length>5)result=result.replaceAll(s,'[local credential omitted]')
  return result.replace(/eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g,'[local JWT omitted]').slice(-7000)
}
let browser,app,appOutput='',fixture,inspectExternalIO
const lockFixtures=[],lockControls=[]
const customerFixtures=[]
const nativeDefinitionsSql="select p.oid::regprocedure::text as signature, pg_get_functiondef(p.oid) as definition "+
  "from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' "+
  "and (p.proname like 'pilot_quote_save%' or p.proname like '_pilot_qs%' or p.proname like 'pilot_quote_acceptance%' or p.proname like '_pilot_qva%' or p.proname in ('current_app_role','_pilot_quote_save_lock','quote_apply_choice','quote_record_acceptance')) order by p.oid::regprocedure::text"
const appClosed=()=>!app||app.exitCode!==null||app.signalCode!==null
const connectionPids=[]
function rawSQL(text) {
  try{return execFileSync('psql',['--no-psqlrc','--no-password','--host='+config.dbHost,'--port=5432','--username=postgres',
    '--dbname=postgres','--set=ON_ERROR_STOP=on','--tuples-only','--no-align','--quiet','--command',text],
    {encoding:'utf8',timeout:120000,maxBuffer:16*1024*1024,stdio:['ignore','pipe','pipe'],env:{PATH:process.env.PATH,HOME:process.env.HOME,
      PGPASSWORD:config.dbPassword,PGCONNECT_TIMEOUT:'10',PGOPTIONS:'-c statement_timeout=30000 -c lock_timeout=15000'}})}
  catch(error){throw Error('Disposable SQL refused: '+scrub(error.stderr||error.message))}
}
async function sql(text) {
  if(/^\s*select\b/i.test(text)){
    const body=text.trim().replace(/;$/,'')
    const raw=rawSQL('select json_build_object(\'pid\',pg_backend_pid(),\'rows\',(select coalesce(json_agg(t),\'[]\'::json) from ('+body+') t))')
    const result=JSON.parse(raw.trim());connectionPids.push(result.pid);return result.rows
  }
  rawSQL(text);return []
}
async function waitFor(url,timeout=120000) {
  const deadline=Date.now()+timeout
  while(Date.now()<deadline){
    if(appClosed())throw Error('Temporary Next app exited: '+scrub(appOutput))
    try{const r=await fetch(url,{signal:AbortSignal.timeout(5000)});if(r.ok)return}catch{}
    await new Promise(r=>setTimeout(r,500))
  }
  throw Error('Temporary app readiness timeout: '+scrub(appOutput))
}
async function stopApp(){
  if(!app||appClosed())return
  try{process.kill(-app.pid,'SIGTERM')}catch{}
  for(let n=0;n<30&&!appClosed();n++)await new Promise(r=>setTimeout(r,100))
  if(!appClosed()){try{process.kill(-app.pid,'SIGKILL')}catch{};await new Promise(r=>app.once('exit',r))}
  report.cleanup.appClosed=appClosed()
}
process.on('SIGTERM',()=>{
  report.pass=false;report.error='Disposable workload received termination'
  void finish().finally(()=>process.exit(1))
})
async function main(){
  assert.equal(process.platform,'linux');assert.equal(process.env.GITHUB_ACTIONS,'true')
  assert.equal(marker,'EDGEHQ_DISPOSABLE_REAL_AUTH_SAVE_ONLY');assert.equal(process.env.PILOT_AUTH_SAVE_MARKER,marker)
  assert.equal(config.apiUrl,'http://127.0.0.1:8000');assert.equal(config.origin,'http://localhost:3000')
  assert.equal(process.env.GITHUB_SHA,config.candidate)
  assert(relative(realpathSync(source),realpathSync(taskRoot)).startsWith('..'))
  assert(/^172\.|^10\.|^192\.168\./.test(config.dbHost))
  report.networkRoutes=JSON.parse(execFileSync('ip',['-j','route'],{encoding:'utf8'}))
  let unreachable=false
  try{execFileSync('curl',['--noproxy','*','--silent','--show-error','--connect-timeout','2','--max-time','3','http://1.1.1.1'],
    {encoding:'utf8',timeout:4000,stdio:['ignore','pipe','pipe']})}
  catch(error){unreachable=error.status!==0;report.externalProbe={target:'public IP port80',failed:unreachable,exit:error.status}}
  assert(unreachable,'Network namespace must deny external access')
  const bootstrap=(await sql("select current_database() as database, version() as version, current_user as role, "+
    "to_regprocedure('auth.uid()')::text as uid_function,to_regprocedure('auth.role()')::text as role_function,"+
    "to_regprocedure('storage.foldername(text)')::text as storage_function,"+
    "to_regclass('auth.users')::text as auth_users,to_regclass('auth.identities')::text as auth_identities,"+
    "to_regclass('auth.refresh_tokens')::text as auth_refresh_tokens,to_regclass('storage.objects')::text as storage_objects,"+
    "(select json_agg(rolname order by rolname) from pg_roles where rolname in ('anon','authenticated','service_role','supabase_auth_admin','supabase_storage_admin')) as roles,"+
    "(select count(*)::int from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='public' and c.relkind in ('r','p','v','m')) as public_relations"))[0]
  report.platformBootstrap=bootstrap
  assert.equal(bootstrap.database,'postgres');assert.equal(bootstrap.role,'postgres');assert(bootstrap.version.includes('PostgreSQL 17.'))
  for(const key of ['uid_function','role_function','storage_function','auth_users','auth_identities','auth_refresh_tokens','storage_objects'])assert(bootstrap[key],key+' missing real platform bootstrap')
  assert.equal(bootstrap.roles.length,5);assert.equal(bootstrap.public_relations,0)
  await sql("comment on database postgres is 'edgequote disposable real auth quote save only'")
  // Exact checked-in SQL files, no synthetic platform prelude, substitutions or skipped statements.
  const schemaFiles=[...readdirSync(join(source,'supabase/migrations')).filter(f=>f.endsWith('.sql')).sort().map(f=>'supabase/migrations/'+f),
    'supabase/proposals/pilot-email-core.sql','supabase/proposals/pilot-quote-identity.sql','supabase/proposals/pilot-quote-save.sql',
    ...(usesAcceptance?['supabase/proposals/pilot-quote-versioned-acceptance.sql']:[])]
  for(const file of schemaFiles){
    const bytes=readFileSync(join(source,file))
    const entry={file,sha256:hash(bytes),applied:false};report.schemaApplications.push(entry)
    try{execFileSync('psql',['--no-psqlrc','--no-password','--host='+config.dbHost,'--port=5432','--username=postgres','--dbname=postgres',
      '--set=ON_ERROR_STOP=on','--quiet','--file',join(source,file)],{encoding:'utf8',timeout:180000,maxBuffer:10*1024*1024,stdio:['ignore','pipe','pipe'],
      env:{PATH:process.env.PATH,HOME:process.env.HOME,PGPASSWORD:config.dbPassword,PGCONNECT_TIMEOUT:'10'}});entry.applied=true}
    catch(error){entry.error=scrub(error.stderr||error.message);throw Error('Exact schema application failed at '+file+': '+entry.error)}
  }
  await sql("notify pgrst, 'reload schema'")
  report.nativeDefinitions=await sql(nativeDefinitionsSql)
  const sideEffects=async()=>{
    const tables=(await sql("select to_regclass('cron.job')::text as cron,to_regclass('net.http_request_queue')::text as queue,to_regclass('net._http_response')::text as responses"))[0]
    const counts={}
    for(const [key,table] of Object.entries(tables)){
      if(table)counts[key]=(await sql('select count(*)::int as count from '+table))[0].count
      else counts[key]=0
    }
    for(const table of ['pilot_email_connections','pilot_email_send_attempts','webhook_deliveries']){
      if((await sql("select to_regclass('public."+table+"')::text as name"))[0].name)counts[table]=(await sql('select count(*)::int as count from public.'+table))[0].count
    }
    return counts
  }
  inspectExternalIO=sideEffects
  report.beforeExternalIO=await sideEffects()
  assert(Object.values(report.beforeExternalIO).every(v=>v===0),'Unexpected scheduled/provider work before fixture')
  const admin=createClient(config.apiUrl,config.serviceKey,{auth:{persistSession:false,autoRefreshToken:false}})
  const termsFixture=usesAcceptance?await acceptanceFixtureTerms():null
  const seed=async sharedUnitId=>seedFixtures({sql,sharedUnitId,...(termsFixture?{acceptanceFixture:{...termsFixture,onPrivateValue:value=>secret.push(value)}}:{}),createUser:async(email,password)=>{
    secret.push(password)
    const result=await admin.auth.admin.createUser({email,password,email_confirm:true})
    if(result.error||!result.data.user?.id)throw Error('Actual local GoTrue createUser failed: '+scrub(result.error?.message||'missing ID'))
    return result.data.user.id
  }})
  if(lockOrder){
    for(const id of ['P1','P2','O1','O2','R1','R2'])lockFixtures.push({id,...await seed(lockFixtures[0]?.unitId)})
    fixture=lockFixtures[0]
    report.lockOrderBeforeRows=Object.fromEntries(lockFixtures.map(f=>[f.id,f.before]))
    report.lockOrderFixtureOwners=lockFixtures.map(f=>({id:f.id,ownerA:f.ownerA,ownerB:f.ownerB,denied:f.denied,quoteA:f.quoteA}))
  }else if(customerUI){
    for(const id of ['U1','U2'])customerFixtures.push({id,...await seed(customerFixtures[0]?.unitId)})
    fixture=customerFixtures[0]
    report.customerUIBeforeRows=Object.fromEntries(customerFixtures.map(f=>[f.id,f.before]))
    report.customerUIFixtureOwners=customerFixtures.map(f=>({id:f.id,ownerA:f.ownerA,ownerB:f.ownerB,denied:f.denied,quoteA:f.quoteA}))
  }else fixture=await seed()
  report.fixtureOwners={ownerA:fixture.ownerA,ownerB:fixture.ownerB,denied:fixture.denied}
  report.beforeRows=fixture.before
  const faultDirectory=join(taskRoot,'private-response-fault')
  if(lostAck)mkdirSync(faultDirectory,{mode:0o700})
  const authorityDirectory=join(taskRoot,'private-acceptance-authority')
  if(versionedAcceptance)mkdirSync(authorityDirectory,{mode:0o700})
  const mounted=await generateMount({source,directory:join(taskRoot,'app'),marker,
    ...(lostAck?{lostAcknowledgement:{directory:faultDirectory,ownerId:fixture.ownerA,quoteId:fixture.quoteA}}:{}),
    ...(versionedAcceptance?{versionedAcceptance:{directory:authorityDirectory,ownerId:fixture.ownerB,quoteId:fixture.quoteB}}:{}),
    ...(lockOrder?{lockOrderAcceptance:true}:{}),...(customerUI?{customerAcceptanceUI:true}:{})})
  report.mount=mounted
  const nextConfig=(await import(pathToFileURL(join(mounted.directory,'next.config.mjs')).href)).default
  for(const phase of ['phase-production-build','phase-production-server']){
    let refused=false
    try{nextConfig(phase,{defaultConfig:{}})}catch{refused=true}
    assert(refused,'Temporary app accepted '+phase)
  }
  report.productionPhasesRejected=true
  const generatedPins={}
  function pin(dir, pins=generatedPins){
    for(const name of readdirSync(dir,{withFileTypes:true})){
      if(name.name==='node_modules'||name.name==='.next')continue
      const file=join(dir,name.name)
      if(name.isDirectory())pin(file,pins)
      else if(name.isFile())pins[relative(mounted.directory,file)]=hash(readFileSync(file))
    }
  }
  pin(mounted.directory);report.generatedSourcePins=generatedPins
  try{
    execFileSync(process.execPath,[join(source,'node_modules/typescript/bin/tsc'),'--project',join(mounted.directory,'tsconfig.json')],
      {cwd:mounted.directory,env:process.env,encoding:'utf8',timeout:120000,maxBuffer:2*1024*1024,stdio:['ignore','pipe','pipe']})
    report.focusedTypecheck='passed'
  }catch(error){throw Error('Generated mount typecheck failed: '+scrub(error.stdout||error.stderr||error.message))}
  // Same locked dependency tree. This does not launch any production app/layout.
  app=spawn(process.execPath,[mounted.nextBin,'dev','--hostname','127.0.0.1','--port','3000'],{
    cwd:mounted.directory,env:{...process.env},detached:true,stdio:['ignore','pipe','pipe']})
  app.stdout.on('data',b=>appOutput=(appOutput+b).slice(-16000))
  app.stderr.on('data',b=>appOutput=(appOutput+b).slice(-16000))
  await waitFor(config.origin+'/login')
  browser=await chromium.launch({executablePath:config.chrome,headless:true,
    env:{PATH:process.env.PATH,HOME:process.env.HOME,LANG:'C.UTF-8',DO_NOT_TRACK:'1'},
    args:['--no-sandbox','--disable-dev-shm-usage','--disable-background-networking','--disable-component-update','--disable-sync','--no-first-run']})
  report.browserVersion=browser.version()
  const readFaultEvents=()=>existsSync(join(faultDirectory,'events.jsonl'))
    ?readFileSync(join(faultDirectory,'events.jsonl'),'utf8').trim().split('\n').filter(Boolean).map(line=>JSON.parse(line)):[]
  let held
  const fault=lostAck?{
    waitCommitted:async()=>{
      const deadline=Date.now()+60000
      while(Date.now()<deadline){
        if(existsSync(join(faultDirectory,'committed.json'))){
          held=JSON.parse(readFileSync(join(faultDirectory,'committed.json'),'utf8'))
          assert.equal(held.receipt.code,'committed');assert.equal(held.receipt.owner_id,fixture.ownerA)
          assert.equal(held.intent.quoteId,fixture.quoteA)
          return {...held,events:readFaultEvents()}
        }
        if(appClosed())throw Error('Temporary app exited before held response')
        await new Promise(resolve=>setTimeout(resolve,25))
      }
      throw Error('Canonical committed response hold timed out')
    },
    releaseAfterReadback:async observedRows=>{
      assert(held,'No canonical committed response held')
      const actual=await readFixture(sql,fixture)
      assert.deepEqual(actual,observedRows,'Independent SQL observation changed before release')
      assert.equal(actual.ownerA.quotes[0].notes,held.intent.values.notes)
      assert.equal(actual.ownerA.quotes[0].updated_at,held.receipt.quote.updated_at)
      assert.notEqual(held.receipt.after_revision,held.receipt.before_revision)
      const barrier={operationId:held.intent.clientOperationId,observedDigest:hash(JSON.stringify(actual))}
      appendFileSync(join(faultDirectory,'events.jsonl'),JSON.stringify({kind:'sql-commit-observed',at:new Date().toISOString(),...barrier})+'\n',{mode:0o600})
      writeFileSync(join(faultDirectory,'release.tmp'),JSON.stringify(barrier),{flag:'wx',mode:0o600})
      renameSync(join(faultDirectory,'release.tmp'),join(faultDirectory,'release.json'))
      const deadline=Date.now()+20000
      while(!readFaultEvents().some(event=>event.kind==='response-dropped')){
        if(Date.now()>=deadline)throw Error('Actual response drop was not observed after SQL barrier')
        await new Promise(resolve=>setTimeout(resolve,25))
      }
    },
    readEvents:async()=>readFaultEvents(),
  }:undefined
  if(versionedAcceptance){
    const events=()=>existsSync(join(authorityDirectory,'events.jsonl'))?readFileSync(join(authorityDirectory,'events.jsonl'),'utf8').trim().split('\n').filter(Boolean).map(line=>JSON.parse(line)):[]
    const authorityGate={
      waitHeld:async()=>{
        const deadline=Date.now()+12000
        while(Date.now()<deadline){
          if(existsSync(join(authorityDirectory,'held.json')))return JSON.parse(readFileSync(join(authorityDirectory,'held.json'),'utf8'))
          if(appClosed())throw Error('Acceptance app exited before authority barrier')
          await new Promise(resolve=>setTimeout(resolve,20))
        }
        throw Error('Actual owner-authority barrier not reached')
      },
      revokeAndRelease:async operationId=>{
        const held=JSON.parse(readFileSync(join(authorityDirectory,'held.json'),'utf8'))
        assert.equal(held.operationId,operationId);assert.equal(held.ownerId,fixture.ownerB);assert.equal(held.quoteId,fixture.quoteB)
        // Explicit test-only mutation, confined to the freshly seeded owner B.
        await sql("begin; delete from public.business_settings where user_id='"+fixture.ownerB+"'::uuid; set constraints all immediate; commit;")
        const after=await readFixture(sql,fixture)
        assert.equal(after.ownerB.business_settings.length,0)
        appendFileSync(join(authorityDirectory,'events.jsonl'),JSON.stringify({kind:'owner-settings-revocation-committed',at:new Date().toISOString(),
          ownerId:fixture.ownerB,quoteId:fixture.quoteB,operationId})+'\n',{mode:0o600})
        writeFileSync(join(authorityDirectory,'release.tmp'),JSON.stringify({operationId}),{flag:'wx',mode:0o600})
        renameSync(join(authorityDirectory,'release.tmp'),join(authorityDirectory,'release.json'))
        return after
      },
      readEvents:async()=>events(),
      directNative:async(mode,request)=>{
        assert(['preview','commit','reconcile'].includes(mode));assert.equal(request.quoteId,fixture.quoteB)
        const args={p_owner:fixture.ownerB,p_portal_token:null,p_quote:fixture.quoteB,p_option:request.optionId,
          ...(mode==='preview'?{}:{p_expected:request.expected,p_addons:request.addonIds,p_reason:request.reason,p_note:request.note}),
          ...(mode==='commit'?{p_terms_ack:request.termsAck}:{})}
        const result=await admin.rpc('pilot_quote_acceptance_'+mode,args)
        if(result.error)throw Error('Actual native owner prerequisite RPC failed: '+scrub(result.error.message))
        return result.data
      },
    }
    report.ownerAuthority=await runAcceptanceAuthorityBrowser({browser,baseURL:config.origin,fixture,readIndependentRows:()=>readFixture(sql,fixture),authorityGate})
    if(report.ownerAuthority?.pass!==true)throw Error('Real owner acceptance authority prerequisite did not pass')
    // Portal case starts from the observed post-prerequisite state. Preserve both
    // snapshots and reports; do not disguise the explicit synthetic revocation.
    report.afterOwnerAuthorityRows=await readFixture(sql,fixture)
    fixture.before=report.afterOwnerAuthorityRows
  }
  const readFacts=async(f=fixture)=>{
    assert(usesAcceptance,'Native acceptance facts belong only to acceptance cases')
    assert(f===fixture||lockFixtures.includes(f)||customerFixtures.includes(f),'Unknown proof fixture')
    return (await sql("select public.quote_material_fingerprint('"+f.quoteA+"'::uuid) as \"documentFingerprint\", public.quote_terms_fingerprint('"+f.ownerA+"'::uuid) as \"termsFingerprint\", public.quote_acceptance_is_current('"+f.quoteA+"'::uuid) as \"acceptanceCurrent\""))[0]
  }
  const readFreshOwnerRows=async(f=fixture)=>{
      assert(f===fixture||lockFixtures.includes(f)||customerFixtures.includes(f),'Unknown proof fixture')
      // New client + new actual password session; never reuse browser tokens or service role.
      const fresh=createClient(config.apiUrl,config.anonKey,{auth:{persistSession:false,autoRefreshToken:false}})
      let signed=false
      try{
        const sign=await fresh.auth.signInWithPassword({email:f.emailA,password:f.password})
        if(sign.error||sign.data.user?.id!==f.ownerA)throw Error('Fresh actual Auth sign-in failed')
        signed=true
        const verified=await fresh.auth.getUser()
        if(verified.error||verified.data.user?.id!==f.ownerA)throw Error('Fresh actual Auth verification failed')
        const quote=await fresh.from('quotes').select('*').eq('id',f.quoteA).eq('user_id',f.ownerA).single()
        const services=await fresh.from('quote_services').select('*').eq('quote_id',f.quoteA).eq('user_id',f.ownerA).order('sort_order').order('id')
        if(quote.error||services.error)throw Error('Fresh owner PostgREST readback failed')
        return{ownerId:verified.data.user.id,quote:quote.data,services:services.data}
      }finally{if(signed){const out=await fresh.auth.signOut({scope:'local'});if(out.error)throw Error('Fresh session sign-out failed')}}
  }
  const runBrowser=versionedAcceptance?runVersionedAcceptanceBrowser:lostAck?runLostAcknowledgementBrowser:runAuthenticatedQuoteSaveBrowser
  const browserResult=customerUI?await runCustomerAcceptanceUIBrowser({browser,baseURL:config.origin,fixtures:customerFixtures,outputDirectory:output,
    readRows:async f=>{assert(customerFixtures.includes(f),'Unknown customer UI fixture');return readFixture(sql,f)},
    readFacts,readFreshOwnerRows,
  }):lockOrder?await runLockOrderBrowser({browser,baseURL:config.origin,fixtures:lockFixtures,
    createControl:async f=>{
      assert(lockFixtures.includes(f),'Unknown lock-order fixture')
      const control=await createLockOrderControl({config,fixture:f,readIndependentRows:()=>readFixture(sql,f)})
      lockControls.push(control);return control
    },
    readRows:async f=>{assert(lockFixtures.includes(f),'Unknown lock-order fixture');return readFixture(sql,f)},
    readFacts,readFreshOwnerRows,
  }):await runBrowser({browser,baseURL:config.origin,fixture,fault,
    readIndependentRows:()=>readFixture(sql,fixture),readNativeAcceptanceFacts:()=>readFacts(),readFreshOwnerRows:()=>readFreshOwnerRows()})
  report.browser=browserResult
  if(customerUI){
    report.customerUIAfterRows={}
    for(const f of customerFixtures)report.customerUIAfterRows[f.id]=await readFixture(sql,f)
  }
  if(lockOrder){
    report.lockOrderAfterRows={}
    for(const f of lockFixtures)report.lockOrderAfterRows[f.id]=await readFixture(sql,f)
    report.lockOrderControls=lockControls.map(control=>control.snapshotEvidence())
  }
  if(lostAck)report.responseFaultEvents=readFaultEvents()
  report.generatedSourcePinsAfterRun={};pin(mounted.directory,report.generatedSourcePinsAfterRun)
  if(browserResult?.pass!==true)throw Error('Actual browser cases did not pass')
  report.afterRows=await readFixture(sql,fixture)
  report.afterExternalIO=await sideEffects()
  assert(Object.values(report.afterExternalIO).every(v=>v===0),'Unexpected scheduled/provider I/O')
  const nativeAfter=await sql(nativeDefinitionsSql)
  assert.deepEqual(nativeAfter,report.nativeDefinitions,'Native definitions changed during proof')
  report.nativeDefinitionsUnchanged=true
  report.pass=true
}
let finishing
function finish(){
  if(finishing)return finishing
  finishing=(async()=>{
  try{if(browser)await browser.close();report.cleanup.browserClosed=!browser?.isConnected()}
  catch(error){report.cleanup.browserError=scrub(error.message);report.pass=false}
  await stopApp();report.cleanup.appClosed=appClosed()
  if(lockOrder){
    report.cleanup.lockOrderControlErrors=[]
    for(const control of lockControls){try{const closed=await control.close();if(closed?.pass!==true){report.cleanup.lockOrderControlErrors.push('Owned lock-order control cleanup was incomplete');report.pass=false}}catch(error){report.cleanup.lockOrderControlErrors.push(scrub(error.message));report.pass=false}}
    report.lockOrderControls=lockControls.map(control=>control.snapshotEvidence())
    report.lockOrderFinalObservedRows={}
    for(const f of lockFixtures){
      try{report.lockOrderFinalObservedRows[f.id]=await readFixture(sql,f)}
      catch(error){report.lockOrderFinalObservedRows[f.id]={unavailable:scrub(error.message)};report.pass=false}
    }
    try{
      if(inspectExternalIO){report.lockOrderFinalExternalIO=await inspectExternalIO();assert(Object.values(report.lockOrderFinalExternalIO).every(value=>value===0))}
      if(report.nativeDefinitions){assert.deepEqual(await sql(nativeDefinitionsSql),report.nativeDefinitions);report.lockOrderFinalNativeDefinitionsUnchanged=true}
    }catch(error){report.cleanup.lockOrderFinalObservationError=scrub(error.message);report.pass=false}
  }
  if(customerUI){
    report.customerUIFinalObservedRows={}
    for(const f of customerFixtures){
      try{report.customerUIFinalObservedRows[f.id]=await readFixture(sql,f)}
      catch(error){report.customerUIFinalObservedRows[f.id]={unavailable:scrub(error.message)};report.pass=false}
    }
    try{
      if(inspectExternalIO){report.customerUIFinalExternalIO=await inspectExternalIO();assert(Object.values(report.customerUIFinalExternalIO).every(value=>value===0))}
      if(report.nativeDefinitions){assert.deepEqual(await sql(nativeDefinitionsSql),report.nativeDefinitions);report.customerUIFinalNativeDefinitionsUnchanged=true}
    }catch(error){report.cleanup.customerUIFinalObservationError=scrub(error.message);report.pass=false}
  }
  report.sqlConnections=connectionPids
  try{
    if(connectionPids.length){
      const active=(await sql("select pid from pg_stat_activity where pid in ("+[...new Set(connectionPids)].join(',')+")"))
      assert.equal(active.length,0);report.cleanup.independentSqlConnectionsClosed=true
    }
  }catch(error){report.cleanup.sqlError=scrub(error.message);report.pass=false}
  report.completedAt=new Date().toISOString()
  mkdirSync(output,{recursive:true});writeFileSync(join(output,'browser-proof.json'),JSON.stringify(report,null,2))
  console.log(JSON.stringify({pass:report.pass,candidate:report.candidate,error:report.error,cleanup:report.cleanup}))
  if(!report.pass)process.exitCode=1
  })()
  return finishing
}
try{await main()}catch(error){report.error=scrub(error.stack||error.message);report.appOutput=scrub(appOutput)}
finally{await finish()}
