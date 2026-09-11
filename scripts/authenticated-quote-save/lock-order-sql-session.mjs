// Test infrastructure only: a persistent session on the already marked real
// disposable Auth stack. This never loads the older synthetic Auth prelude.
import {spawn} from 'node:child_process'
import {randomUUID} from 'node:crypto'
import {isIP} from 'node:net'
import assert from 'node:assert/strict'

export const LOCK_DATABASE_MARKER='edgequote disposable real auth quote save only'
const ENV_MARKER='EDGEHQ_DISPOSABLE_REAL_AUTH_SAVE_ONLY'
const MAX_OUTPUT=16*1024*1024

export function validateLockConfig(config){
  assert.equal(process.platform,'linux','Only the isolated Linux workload is supported')
  assert.equal(process.env.GITHUB_ACTIONS,'true','GitHub disposable workload required')
  assert.equal(config?.marker,ENV_MARKER,'Explicit real-stack marker required')
  assert.equal(process.env.PILOT_AUTH_SAVE_MARKER,ENV_MARKER,'Workload marker mismatch')
  assert.match(config.candidate??'',/^[a-f0-9]{40}$/,'Pinned candidate required')
  assert.equal(process.env.GITHUB_SHA,config.candidate,'Candidate mismatch')
  assert.equal(config.apiUrl,'http://127.0.0.1:8000')
  assert.equal(config.origin,'http://localhost:3000')
  assert.equal(isIP(config.dbHost??''),4,'Numeric internal database IPv4 required')
  const [a,b]=config.dbHost.split('.').map(Number)
  assert(a===10||(a===172&&b>=16&&b<=31)||(a===192&&b===168),'Private database IPv4 required')
  assert(typeof config.dbPassword==='string'&&config.dbPassword.length>0&&!config.dbPassword.includes('\0'),'Disposable database credential required')
  return Object.freeze({dbHost:config.dbHost,dbPassword:config.dbPassword})
}

// Values are data, never SQL fragments. Callers use only fixed, reviewed SQL.
export function sqlLiteral(value){
  if(value===null)return 'null'
  if(typeof value==='boolean')return value?'true':'false'
  if(typeof value==='number'){
    assert(Number.isFinite(value),'Nonfinite SQL value')
    return String(value)
  }
  assert(typeof value==='string'&&!value.includes('\0'),'Invalid SQL string')
  return "'"+value.replaceAll("'","''")+"'"
}

export class LockSqlSession {
  #child; #pending=null; #buffer=''; #queue=Promise.resolve(); #ended=false
  #closing=false; #closePromise; #exitPromise; #stderrBytes=0; #terminalFailure=null
  identity=null
  constructor(config,name){
    const target=validateLockConfig(config)
    assert.match(name,/^[a-z0-9-]{1,36}$/,'Fixed session label required')
    this.name=name
    this.#child=spawn('psql',['--no-psqlrc','--no-password','--quiet','--no-align','--tuples-only',
      '--host='+target.dbHost,'--port=5432','--username=postgres','--dbname=postgres',
      '--set=ON_ERROR_STOP=off','--set=VERBOSITY=sqlstate','--pset=pager=off'],{
      detached:true,windowsHide:true,stdio:['pipe','pipe','pipe'],
      env:{PATH:process.env.PATH,HOME:'/nonexistent',LANG:'C.UTF-8',PGPASSWORD:target.dbPassword,
        PGPASSFILE:'/dev/null',PGSSLMODE:'disable',PGCONNECT_TIMEOUT:'5',PGCLIENTENCODING:'UTF8',
        PGAPPNAME:'edgehq-lock-'+name,PGOPTIONS:'-c statement_timeout=15000 -c lock_timeout=10000 -c standard_conforming_strings=on'},
    })
    this.#exitPromise=new Promise(resolve=>{
      this.#child.once('exit',(code,signal)=>{
        this.#ended=true;this.exit={code,signal};this.#fail(Error('Owned SQL session exited'))
        resolve()
      })
      this.#child.once('error',()=>{
        this.#terminalFailure='Owned SQL process failed'
        this.#fail(Error(this.#terminalFailure))
        if(!this.#child.pid){this.#ended=true;this.exit={code:null,signal:null,spawnFailed:true};resolve()}
      })
    })
    this.#child.stdout.setEncoding('utf8')
    this.#child.stdout.on('data',chunk=>this.#output(chunk))
    // PostgreSQL diagnostics can contain function arguments/private tokens.
    // Drain them, but retain neither text nor a potentially revealing hash.
    this.#child.stderr.on('data',chunk=>{this.#stderrBytes+=chunk.length})
    this.#child.stdin.on('error',()=>this.#fail(Error('Owned SQL input closed')))
  }
  static async open(config,name){
    const session=new LockSqlSession(config,name)
    try{
      const rows=await session.query(`select current_database() as database,current_user as role,
        current_setting('server_version_num')::int as version,
        (select shobj_description(oid,'pg_database') from pg_database where datname=current_database()) as marker,
        pg_backend_pid() as pid,(select backend_start::text from pg_stat_activity where pid=pg_backend_pid()) as backend_start,
        (select oid::bigint from pg_database where datname=current_database()) as database_oid,
        to_regclass('auth.identities')::text as identities,to_regclass('auth.refresh_tokens')::text as refresh_tokens,
        to_regprocedure('auth.uid()')::text as uid_function`)
      const r=rows[0]
      assert.equal(rows.length,1);assert.equal(r.database,'postgres');assert.equal(r.role,'postgres')
      assert(r.version>=170000&&r.version<180000,'PostgreSQL17 required')
      assert.equal(r.marker,LOCK_DATABASE_MARKER,'Unmarked database refused')
      assert(r.identities&&r.refresh_tokens&&r.uid_function,'Real Auth platform objects required')
      assert(Number.isSafeInteger(r.pid)&&r.pid>0&&r.backend_start,'SQL backend identity unavailable')
      session.identity=Object.freeze({pid:r.pid,backend_start:r.backend_start,database_oid:r.database_oid,name})
      return session
    }catch(error){
      const cleanup=await session.close()
      const failure=Error('Marked disposable SQL session could not be opened')
      failure.sessionCleanup=cleanup
      throw failure
    }
  }
  get busy(){return this.#pending!==null}
  get ended(){return this.#ended}
  #fail(error){
    if(this.#pending){clearTimeout(this.#pending.timer);this.#pending.reject(error);this.#pending=null}
  }
  #kill(signal){
    if(this.#ended||!this.#child.pid)return
    try{process.kill(-this.#child.pid,signal)}catch{}
  }
  #output(chunk){
    this.#buffer+=chunk
    if(this.#buffer.length>MAX_OUTPUT){this.#terminalFailure='Owned SQL framing limit';this.#fail(Error(this.#terminalFailure));this.#kill('SIGTERM');return}
    let index
    while((index=this.#buffer.indexOf('\n'))>=0){
      const line=this.#buffer.slice(0,index).replace(/\r$/,'');this.#buffer=this.#buffer.slice(index+1)
      const p=this.#pending
      if(!p)continue
      if(line.startsWith(p.marker+' ')){
        clearTimeout(p.timer);this.#pending=null
        const match=/^(true|false) ([0-9A-Z]{5})$/.exec(line.slice(p.marker.length+1).trim())
        if(match?.[1]==='false'&&match[2]==='00000')p.resolve(p.lines)
        else if(match?.[1]==='true')p.reject(Error('Owned SQL statement refused ('+match[2]+')'))
        else p.reject(Error('Owned SQL result framing invalid'))
      }else{
        p.bytes+=line.length
        if(p.bytes>MAX_OUTPUT){this.#terminalFailure='Owned SQL result limit';this.#fail(Error(this.#terminalFailure));this.#kill('SIGTERM');return}
        p.lines.push(line)
      }
    }
  }
  #raw(statement){
    const operation=this.#queue.then(()=>new Promise((resolve,reject)=>{
      if(this.#ended||this.#closing||this.#terminalFailure){reject(Error('Owned SQL session unavailable'));return}
      const marker='EDGEHQ_LOCK_'+randomUUID().replaceAll('-','')
      const timer=setTimeout(()=>{
        this.#terminalFailure='Owned SQL command deadline exceeded';this.#fail(Error(this.#terminalFailure));this.#kill('SIGTERM')
      },18000)
      this.#pending={marker,timer,resolve,reject,lines:[],bytes:0}
      this.#child.stdin.write(statement.trim().replace(/;+\s*$/,'')+';\n\\echo '+marker+' :ERROR :SQLSTATE\n')
    }))
    this.#queue=operation.catch(()=>undefined)
    return operation
  }
  async exec(statement){await this.#raw(statement)}
  #parseRows(lines){
    lines=lines.filter(line=>line.trim())
    assert.equal(lines.length,1,'Owned SQL JSON framing invalid')
    let result
    try{result=JSON.parse(lines[0])}catch{throw Error('Owned SQL result was not JSON')}
    assert(Array.isArray(result),'Owned SQL row array required')
    return result
  }
  async query(statement){
    const body=statement.trim().replace(/;+\s*$/,'')
    assert(/^(select|with)\b/i.test(body),'SELECT result statement required')
    return this.#parseRows(await this.#raw("select coalesce(json_agg(row_to_json(lock_rows)),'[]'::json)::text from ("+body+') lock_rows'))
  }
  async returning(statement){
    const body=statement.trim().replace(/;+\s*$/,'')
    assert(/^delete\b/i.test(body)&&/\breturning\b/i.test(body),'Reviewed DELETE RETURNING required')
    // PostgreSQL data-modifying CTEs must remain at the top statement level.
    return this.#parseRows(await this.#raw('with lock_rows as ('+body+
      ") select coalesce(json_agg(row_to_json(lock_rows)),'[]'::json)::text from lock_rows"))
  }
  evidence(){return {identity:this.identity,processStarted:!!this.#child.pid,processClosed:this.#ended,
    busy:this.busy,stderrBytes:this.#stderrBytes,terminalFailure:this.#terminalFailure,exit:this.exit??null}}
  async close(){
    if(this.#closePromise)return this.#closePromise
    this.#closePromise=(async()=>{
      // The controller first cancels/drains positively identified statements.
      // A remaining busy process is killed and must be reported as incomplete.
      const busyAtClose=this.busy
      let rollbackConfirmed=false
      if(!this.#ended&&!busyAtClose&&!this.#terminalFailure){
        try{await this.exec('rollback');rollbackConfirmed=true}catch{}
      }
      this.#closing=true
      if(!this.#ended){try{this.#child.stdin.end('\\q\n')}catch{}}
      const wait=ms=>Promise.race([this.#exitPromise,new Promise(r=>{const t=setTimeout(r,ms);t.unref()})])
      if(!this.#ended)await wait(1500)
      if(!this.#ended){this.#kill('SIGTERM');await wait(1500)}
      if(!this.#ended){this.#kill('SIGKILL');await wait(1500)}
      return {...this.evidence(),busyAtClose,rollbackConfirmed}
    })()
    return this.#closePromise
  }
}
