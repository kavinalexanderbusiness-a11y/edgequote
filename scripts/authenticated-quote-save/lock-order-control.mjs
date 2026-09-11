// Test-only observed database barriers. Competing HTTP requests still execute
// unchanged PostgREST transactions; the quote gate calls no advisory helper.
import assert from 'node:assert/strict'
import {createHash,randomUUID} from 'node:crypto'
import {isDeepStrictEqual} from 'node:util'
import {LockSqlSession,sqlLiteral,validateLockConfig} from './lock-order-sql-session.mjs'

const copy=value=>JSON.parse(JSON.stringify(value))
const digest=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex')
const uuid=value=>{assert.match(value??'',/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/,'Fixture UUID required');return value}
const id=value=>sqlLiteral(uuid(value))+'::uuid'
const kinds=new Set(['save','acceptance'])
const sameIdentity=(a,b)=>!!a&&!!b&&a.pid===b.pid&&a.backend_start===b.backend_start
const sameStatement=(a,b)=>sameIdentity(a,b)&&a.query_start===b.query_start&&a.kind===b.kind
const tagEqual=(a,b)=>['database','classid','objid','objsubid'].every(k=>String(a[k])===String(b[k]))
const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms))

export async function createLockOrderControl({config,fixture,readIndependentRows}){
  validateLockConfig(config)
  assert.equal(typeof readIndependentRows,'function','Independent SQL readback required')
  const owner=uuid(fixture.ownerA),quote=uuid(fixture.quoteA)
  const suffix=randomUUID().slice(0,8)
  const sessions=[]
  const evidence={version:1,ownerId:owner,quoteId:quote,observations:[],events:[],openAttempts:[],cleanup:null,
    limits:['Main pairs have a pre-release and final snapshot; no guaranteed intermediate winner/loser snapshot.',
      'R2 native function return is provisional until its explicit outer COMMIT.',
      'PostgREST pooled backends may remain idle; cleanup checks transaction/lock absence, not pooled process disappearance.']}
  let observer,gate,native,deletion,mode=null,deadline=0,initialRows,firstIdentity,secondIdentity
  let gateOpen=false,nativeOpen=false,deletionOpen=false,gateReleased=false,nativeCommitted=false
  let deletePending=null,deleteSettled=false,deleteResult=null,deleteFailure=null,pendingCheck=null
  let pairChecked=false,firstChecked=false,deletionChecked=false,closed=false,closePromise
  const event=(kind,fields={})=>{const e={kind,at:new Date().toISOString(),...fields};evidence.events.push(e);return copy(e)}
  const open=async name=>{
    const attempt={name,at:new Date().toISOString(),opened:false};evidence.openAttempts.push(attempt)
    try{
      const s=await LockSqlSession.open(config,name+'-'+suffix);sessions.push(s);attempt.opened=true;return s
    }catch(error){attempt.cleanup=error.sessionCleanup??null;throw error}
  }
  try{observer=await open('observer')}catch(error){for(const s of sessions)await s.close();throw error}
  const budget=()=>{assert(deadline>0&&Date.now()<deadline,'Observed lock barrier exceeded its single 8-second budget')}
  const pending=fn=>{assert.equal(typeof fn,'function','Live request-pending predicate required');assert.equal(fn(),true,'A competing request settled before the lock barrier')}
  const beginBudget=()=>{deadline=Date.now()+8000}
  const assertNew=()=>{assert(!closed&&!mode,'One fresh control is required per schedule')}
  const sessionIds=()=>sessions.map(s=>s.identity.pid)

  async function observe(){
    const pids=[...new Set([...sessionIds(),firstIdentity?.pid,secondIdentity?.pid].filter(Boolean))].join(',')
    // Classify only inside PostgreSQL. Neither raw activity SQL nor any RPC
    // argument is returned, hashed or included in thrown diagnostics.
    const result=await observer.query(`with k as (
      select hashtextextended('pilot-email:'||${id(owner)}::text,0) as value,
        (select oid::bigint from pg_database where datname=current_database()) as database
    ), owner_key as (select database,((value>>32)&4294967295::bigint) as classid,
      (value&4294967295::bigint) as objid,1 as objsubid from k),
    activity as (select a.pid,a.backend_start::text,a.query_start::text,a.state,a.wait_event_type,a.wait_event,
      a.backend_xid::text,pg_blocking_pids(a.pid) as blockers,
      case when lower(replace(a.query,'"',''))
        ~ '(^|[^a-z0-9_])public[[:space:]]*[.][[:space:]]*pilot_quote_save[[:space:]]*[(]' then 'save'
      when lower(replace(a.query,'"',''))
        ~ '(^|[^a-z0-9_])public[[:space:]]*[.][[:space:]]*pilot_quote_acceptance_commit[[:space:]]*[(]' then 'acceptance'
      else 'other' end as kind
      from pg_stat_activity a where a.datid=(select oid from pg_database where datname=current_database())
        and a.backend_type='client backend' and a.pid<>pg_backend_pid()),
    chosen as (select a.* from activity a where a.pid in (${pids}) or a.kind<>'other'
      or exists(select 1 from pg_locks l,owner_key k where l.pid=a.pid and l.locktype='advisory'
        and l.database::bigint=k.database and l.classid::bigint=k.classid and l.objid::bigint=k.objid and l.objsubid=k.objsubid))
    select clock_timestamp()::text as observed_at,(select row_to_json(owner_key) from owner_key) as owner_key,
      coalesce((select json_agg(json_build_object('pid',a.pid,'backend_start',a.backend_start,'query_start',a.query_start,
        'state',a.state,'wait_event_type',a.wait_event_type,'wait_event',a.wait_event,'backend_xid',a.backend_xid,
        'blockers',a.blockers,'kind',a.kind,'locks',coalesce((select json_agg(json_build_object(
          'locktype',l.locktype,'mode',l.mode,'granted',l.granted,'transactionid',l.transactionid::text,
          'database',l.database::bigint,'classid',l.classid::bigint,'objid',l.objid::bigint,'objsubid',l.objsubid)
          order by l.locktype,l.mode,l.granted,l.transactionid::text,l.classid,l.objid)
          from pg_locks l where l.pid=a.pid and l.locktype in ('advisory','transactionid')),'[]'::json)) order by a.pid)
        from chosen a),'[]'::json) as activity`)
    assert.equal(result.length,1,'Observer result unavailable')
    return result[0]
  }
  const ownRow=(o,s)=>o.activity.find(a=>sameIdentity(a,s.identity))
  const canonicalLocks=(o,a,granted)=>a.locks.filter(l=>l.locktype==='advisory'&&l.mode==='ExclusiveLock'
    &&l.granted===granted&&tagEqual(l,o.owner_key))
  function candidates(o,kind){
    return o.activity.filter(a=>a.kind===kind&&a.state==='active'&&!sessionIds().includes(a.pid)
      &&a.locks.some(l=>l.locktype==='advisory'&&tagEqual(l,o.owner_key)))
  }
  function hardTransaction(waiter,holder){
    return waiter?.wait_event_type==='Lock'&&waiter.blockers.length===1&&waiter.blockers[0]===holder?.pid
      &&waiter.locks.some(w=>w.locktype==='transactionid'&&w.mode==='ShareLock'&&!w.granted&&w.transactionid
        &&holder.locks.some(h=>h.locktype==='transactionid'&&h.mode==='ExclusiveLock'&&h.granted&&h.transactionid===w.transactionid))
  }
  function hardAdvisory(o,waiter,holder){
    return waiter?.wait_event_type==='Lock'&&waiter.blockers.length===1&&waiter.blockers[0]===holder?.pid
      &&canonicalLocks(o,waiter,false).length===1&&canonicalLocks(o,holder,true).length===1
      &&tagEqual(canonicalLocks(o,waiter,false)[0],canonicalLocks(o,holder,true)[0])
  }
  function noOtherOwnerLocks(o,allowed){
    return o.activity.every(a=>allowed.includes(a.pid)||!a.locks.some(l=>l.locktype==='advisory'&&tagEqual(l,o.owner_key)))
  }
  function firstGraph(o,kind){
    const all=candidates(o,kind)
    assert(all.length<=1,'Ambiguous native waiter identity')
    const f=all[0],g=ownRow(o,gate)
    if(!f||!g)return null
    if(firstIdentity)assert(sameStatement(firstIdentity,f),'Native first statement identity changed')
    assert(!g.locks.some(l=>l.locktype==='advisory'),'Gate unexpectedly acquired an advisory lock')
    if(g.state!=='idle in transaction'||g.blockers.length||!hardTransaction(f,g)||canonicalLocks(o,f,true).length!==1)return null
    return {first:f,gate:g}
  }
  async function poll(label,check,isPending){
    for(;;){
      budget();if(isPending)pending(isPending)
      const o=await observe();budget();if(isPending)pending(isPending)
      evidence.lastBarrierObservation={label,...o}
      const graph=check(o)
      if(graph){evidence.observations.push({label,...o,graph});return {o,graph}}
      // Yield only. Elapsed time never establishes ordering or release.
      await pause(Math.min(20,Math.max(1,deadline-Date.now())))
    }
  }
  async function compareWhileBlocked(check,isPending,label){
    const rows=await readIndependentRows();budget();pending(isPending)
    assert(isDeepStrictEqual(rows,initialRows),'Business rows changed while the barrier was held')
    const {o,graph}=await poll(label,check,isPending)
    event('pre-release-rows-unchanged',{sha256:digest(rows),observedAt:o.observed_at})
    return graph
  }
  async function beginQuoteGate(){
    assertNew();mode='quote';initialRows=await readIndependentRows();gate=await open('quote-gate')
    await gate.exec('begin isolation level read committed');gateOpen=true
    const rows=await gate.query(`select id,user_id from public.quotes where id=${id(quote)} and user_id=${id(owner)} for update`)
    assert.equal(rows.length,1,'Quote gate must lock exactly one fixture row');beginBudget()
    return event('quote-gate-acquired',{identity:gate.identity,beforeRowsSha256:digest(initialRows)})
  }
  async function beginSettingsDeletion(){
    assertNew();mode='settings';initialRows=await readIndependentRows();gate=await open('settings-gate')
    await gate.exec('begin isolation level read committed');gateOpen=true
    const rows=await gate.returning(`delete from public.business_settings where user_id=${id(owner)} returning user_id`)
    assert.equal(rows.length,1,'Settings gate must delete exactly one fixture row');beginBudget()
    return event('settings-deletion-held',{identity:gate.identity,committed:false,beforeRowsSha256:digest(initialRows)})
  }
  async function waitFirst(kind,isPending){
    assert(kinds.has(kind)&&gateOpen&&!gateReleased,'An open gate and exact native kind are required')
    if(mode==='settings')assert.equal(kind,'acceptance')
    const check=o=>{const g=firstGraph(o,kind);return g&&noOtherOwnerLocks(o,[g.first.pid])?g:null}
    const {graph}=await poll('first-hard-blocker',check,isPending)
    firstIdentity=graph.first;pendingCheck=isPending
    if(mode==='settings')await compareWhileBlocked(check,isPending,'settings-pre-release-hard-blocker')
    firstChecked=true
    return copy(graph)
  }
  async function waitPair(firstKind,secondKind,isPending){
    assert(mode==='quote'&&firstChecked&&firstIdentity&&kinds.has(firstKind)&&kinds.has(secondKind)&&firstKind!==secondKind,
      'Observe the first native waiter before dispatching the second')
    assert.equal(firstIdentity.kind,firstKind)
    const check=o=>{
      const first=firstGraph(o,firstKind);if(!first)return null
      const all=candidates(o,secondKind);assert(all.length<=1,'Ambiguous opposing native waiter')
      const second=all[0];if(!second)return null
      if(secondIdentity)assert(sameStatement(secondIdentity,second),'Native second statement identity changed')
      if(!hardAdvisory(o,second,first.first)||!noOtherOwnerLocks(o,[first.first.pid,second.pid]))return null
      assert.equal(new Set([observer.identity.pid,first.gate.pid,first.first.pid,second.pid]).size,4,'Four distinct backends required')
      return {...first,second}
    }
    const {graph}=await poll('pair-hard-blocker',check,isPending);secondIdentity=graph.second
    await compareWhileBlocked(check,isPending,'pair-pre-release-hard-blocker')
    pairChecked=true;pendingCheck=isPending
    return copy(graph)
  }
  async function releaseGate(){
    assert(gateOpen&&!gateReleased&&(mode==='quote'?pairChecked:firstChecked),'No observed release authority')
    budget();pending(pendingCheck)
    // Re-read identities and actual hard conflicts immediately before COMMIT.
    const o=await observe();budget();pending(pendingCheck)
    const f=firstGraph(o,firstIdentity.kind)
    assert(f&&sameStatement(f.first,firstIdentity),'First hard blocker disappeared before release')
    if(mode==='quote'){
      const s=o.activity.find(a=>sameStatement(a,secondIdentity))
      assert(s&&hardAdvisory(o,s,f.first)&&noOtherOwnerLocks(o,[f.first.pid,s.pid]),'Pair hard blocker disappeared before release')
    }else assert(noOtherOwnerLocks(o,[f.first.pid]),'Unexpected owner lock before deletion release')
    evidence.observations.push({label:'release-authorized',...o})
    await gate.exec('commit');gateOpen=false;gateReleased=true
    return event(mode==='quote'?'quote-gate-committed':'settings-deletion-committed',{identity:gate.identity})
  }
  async function beginNativeAcceptance(request){
    assertNew();mode='native';initialRows=await readIndependentRows()
    assert(request&&Object.getPrototypeOf(request)===Object.prototype,'Actual canonical owner request required')
    const submitted=JSON.stringify(request)
    assert(Buffer.byteLength(submitted)<=200000,'Bounded canonical owner request required')
    request=JSON.parse(submitted) // Freeze caller values before awaiting any SQL.
    assert(!Object.hasOwn(request,'portalToken'),'Native R2 is owner acceptance only')
    assert.equal(request.version,1);assert.equal(request.quoteId,quote)
    uuid(request.clientOperationId)
    if(request.optionId!==null)uuid(request.optionId)
    assert(Array.isArray(request.addonIds));request.addonIds.forEach(uuid)
    assert.equal(typeof request.termsAck,'boolean')
    assert(typeof request.reason==='string'&&(request.note===null||typeof request.note==='string'))
    const expected=JSON.stringify(request.expected)
    assert(expected&&Buffer.byteLength(expected)<=200000,'Bounded native expected document required')
    assert.equal(request.expected.quoteId,quote)
    native=await open('native-acceptance');await native.exec('begin isolation level read committed');nativeOpen=true
    await native.exec("set local role service_role")
    await native.query("select set_config('request.jwt.claims','{}',true),set_config('request.jwt.claim.sub','',true)")
    const authority=(await native.query("select current_user as role,auth.uid() as uid,current_setting('request.jwt.claims',true) as claims,current_setting('request.jwt.claim.sub',true) as sub"))[0]
    assert.equal(authority.role,'service_role');assert.equal(authority.uid,null);assert.equal(authority.claims,'{}');assert.equal(authority.sub,'')
    beginBudget()
    const addons='array['+request.addonIds.map(id).join(',')+']::uuid[]'
    const rows=await native.query(`select public.pilot_quote_acceptance_commit(${id(owner)},null,${id(quote)},
      ${sqlLiteral(expected)}::jsonb,${request.optionId===null?'null':id(request.optionId)},${addons},
      ${sqlLiteral(request.reason)},${sqlLiteral(request.note)},${sqlLiteral(request.termsAck)}) as receipt`)
    assert.equal(rows.length,1);assert.equal(rows[0].receipt?.code,'accepted')
    assert.equal(rows[0].receipt.quote_id,quote);assert.equal(rows[0].receipt.actor_id,owner)
    const stillBefore=await readIndependentRows();budget()
    assert(isDeepStrictEqual(stillBefore,initialRows),'Native return became visible before explicit COMMIT')
    event('native-acceptance-returned',{identity:native.identity,committed:false,receiptSha256:digest(rows[0].receipt),
      nullEndUserClaims:true,role:'service_role',beforeRowsSha256:digest(initialRows)})
    return rows[0].receipt
  }
  async function startDeletionBehindNative(){
    assert(mode==='native'&&nativeOpen&&!nativeCommitted&&!deletePending,'Provisional native transaction required');budget()
    deletion=await open('deletion');await deletion.exec('begin isolation level read committed');deletionOpen=true
    deletePending=deletion.returning(`delete from public.business_settings where user_id=${id(owner)} returning user_id`).then(rows=>{
        deleteSettled=true;deleteResult=rows;return rows
      },error=>{deleteSettled=true;deleteFailure=error;throw error})
    // Observe rejection explicitly even when a failed barrier goes directly to cleanup.
    void deletePending.catch(()=>undefined)
    return event('settings-deletion-dispatched',{identity:deletion.identity,committed:false})
  }
  async function waitDeletionLock(){
    assert(deletePending&&nativeOpen&&deletionOpen,'Both native/deletion transactions required')
    const isPending=()=>!deleteSettled
    const check=o=>{
      const n=ownRow(o,native),d=ownRow(o,deletion)
      if(!n||!d)return null
      if(n.state!=='idle in transaction'||!hardTransaction(d,n)||canonicalLocks(o,n,true).length!==1||n.blockers.length)return null
      if(!noOtherOwnerLocks(o,[n.pid])||d.locks.some(l=>l.locktype==='advisory'))return null
      return {native:n,deletion:d}
    }
    const {graph}=await poll('deletion-hard-blocker',check,isPending)
    await compareWhileBlocked(check,isPending,'native-pre-commit-hard-blocker')
    deletionChecked=true
    return copy(graph)
  }
  async function commitNative(){
    assert(nativeOpen&&!nativeCommitted&&deletionChecked&&!deleteSettled,'Observed waiting deletion required');budget()
    const o=await observe();budget()
    const n=ownRow(o,native),d=ownRow(o,deletion)
    assert(n&&d&&n.state==='idle in transaction'&&hardTransaction(d,n)&&canonicalLocks(o,n,true).length===1&&!deleteSettled,'Deletion wait changed before COMMIT')
    evidence.observations.push({label:'native-commit-authorized',...o})
    await native.exec('commit');nativeOpen=false;nativeCommitted=true
    return event('native-acceptance-committed',{identity:native.identity,committed:true})
  }
  async function finishDeletion(){
    assert(nativeCommitted&&deletePending&&deletionOpen,'Native COMMIT must precede deletion completion')
    const rows=await deletePending
    assert.equal(rows.length,1,'Exactly one settings row must be deleted');assert.equal(rows[0].user_id,owner)
    event('settings-deletion-returned',{identity:deletion.identity,deletedRows:1,committed:false})
    return {deletedRows:1,committed:false}
  }
  async function commitDeletion(){
    assert(nativeCommitted&&deletionOpen&&deleteSettled&&!deleteFailure&&deleteResult?.length===1,'Completed uncommitted DELETE required')
    await deletion.exec('commit');deletionOpen=false
    return event('settings-deletion-committed',{identity:deletion.identity,committed:true})
  }
  function snapshotEvidence(){return copy({...evidence,sessions:sessions.map(s=>s.evidence())})}

  async function cancelKnown(o){
    const known=[firstIdentity,secondIdentity,...sessions.filter(s=>s!==observer).map(s=>s.identity)].filter(Boolean)
    const results=[]
    for(const identity of known){
      const actual=o.activity.find(a=>sameIdentity(a,identity))
      if(!actual||actual.state!=='active')continue
      // For pool sessions, query_start+exact enum prevent cancellation of a
      // later unrelated use of the same PID. Owned psql sessions have no reuse.
      const owned=sessions.some(s=>sameIdentity(s.identity,identity))
      if(!owned&&!sameStatement(actual,identity))continue
      const row=(await observer.query(`select pg_cancel_backend(a.pid) as cancelled from pg_stat_activity a
        where a.pid=${identity.pid} and a.backend_start=${sqlLiteral(identity.backend_start)}::timestamptz
        ${owned?'':`and a.query_start=${sqlLiteral(identity.query_start)}::timestamptz`}
        and a.state='active'`))[0]
      results.push({pid:identity.pid,ownedProcess:owned,cancelled:row?.cancelled===true})
    }
    return results
  }
  async function close(){
    if(closePromise)return closePromise
    closed=true
    closePromise=(async()=>{
      const cleanup={pass:false,cancellations:[],sessions:[],poolTransactionsClear:false,ownedBackendsAbsent:false,
        failures:[],limitations:[]}
      try{
        const before=await observe()
        cleanup.cancellations=await cancelKnown(before)
      }catch{cleanup.failures.push('Could not observe/cancel positively identified statements')}
      // Roll back still-open gates only after cancellation was requested. This
      // may nevertheless release a committing HTTP operation: never infer undo.
      for(const s of sessions.filter(s=>s!==observer).reverse()){
        try{cleanup.sessions.push(await s.close())}catch{cleanup.failures.push('Owned SQL session close failed')}
      }
      gateOpen=false;nativeOpen=false;deletionOpen=false
      if(deletePending)await Promise.race([deletePending.catch(()=>undefined),pause(1000)])
      const until=Date.now()+5000
      try{
        for(;;){
          const o=await observe()
          const ids=sessions.filter(s=>s!==observer).map(s=>s.identity)
          cleanup.ownedBackendsAbsent=ids.every(identity=>!o.activity.some(a=>sameIdentity(a,identity)))
          const pool=[firstIdentity,secondIdentity].filter(Boolean)
          cleanup.poolTransactionsClear=pool.every(identity=>{
            const a=o.activity.find(a=>sameIdentity(a,identity))
            return !a||(a.state==='idle'&&a.backend_xid===null&&!a.locks.some(l=>l.locktype==='advisory'&&tagEqual(l,o.owner_key)))
          })&&noOtherOwnerLocks(o,[])
          if(cleanup.ownedBackendsAbsent&&cleanup.poolTransactionsClear)break
          if(Date.now()>=until){cleanup.failures.push('Owned transaction/lock drain deadline exceeded');break}
          await pause(20)
        }
      }catch{cleanup.failures.push('Final transaction/lock observation failed')}
      try{cleanup.sessions.push(await observer.close())}catch{cleanup.failures.push('Observer close failed')}
      cleanup.allOpenedProcessesClosed=sessions.every(s=>s.ended)
        &&evidence.openAttempts.filter(a=>!a.opened).every(a=>a.cleanup?.processClosed===true)
      // Closing the observer process implies disconnect; no third session is
      // invented to claim a server-side observer-PID absence observation.
      cleanup.observerProcessClosed=observer.ended
      cleanup.limitations.push('Observer backend absence is inferred from its confirmed client process closure; other owned backend absence was read independently.')
      cleanup.pass=cleanup.failures.length===0&&cleanup.allOpenedProcessesClosed&&cleanup.ownedBackendsAbsent&&cleanup.poolTransactionsClear
      evidence.cleanup=cleanup;return copy(cleanup)
    })()
    return closePromise
  }
  return {beginQuoteGate,beginSettingsDeletion,waitFirst,waitPair,releaseGate,beginNativeAcceptance,
    startDeletionBehindNative,waitDeletionLock,commitNative,finishDeletion,commitDeletion,snapshotEvidence,close}
}
