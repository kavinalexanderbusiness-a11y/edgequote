import { execFileSync, spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, readFileSync, writeFileSync, mkdirSync, mkdtempSync, realpathSync, rmSync, chmodSync } from 'node:fs'
import { join, resolve, relative, isAbsolute } from 'node:path'
import { fileURLToPath } from 'node:url'

const source = realpathSync(fileURLToPath(new URL('../../', import.meta.url)))
const output = join(source, 'outputs/authenticated-quote-save-real-20260911')
const marker = 'EDGEHQ_DISPOSABLE_REAL_AUTH_SAVE_ONLY'
const project = 'edgequote-auth-save-disposable'
const network = 'edgequote-auth-save-internal-' + process.env.GITHUB_RUN_ID
const report = {startedAt: new Date().toISOString(), pass: false, sourcePins: {}, events: [], cleanup: {},
  scope: 'Disposable real GoTrue/PostgREST/PG and source-bound Next browser Save. No production or provider activation.'}
const digest = value => createHash('sha256').update(value).digest('hex')
let taskRoot, cli, platform, child, netCreated = false
const sensitive = []
const scrub = value => {
  let text = String(value)
  for (const secret of sensitive) if (secret.length > 5) text = text.replaceAll(secret, '[local credential omitted]')
  return text.replace(/eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g, '[local JWT omitted]')
    .replace(/postgres(?:ql)?:\/\/[^\s'"]+/g, '[local database URL omitted]').slice(-7000)
}
let env
function command(bin, args, timeout = 120000) {
  try {return execFileSync(bin, args, {cwd: platform || source, env, encoding:'utf8', timeout, maxBuffer: 16 * 1024 * 1024,stdio:['ignore','pipe','pipe']})}
  catch(error) {throw new Error(bin + ' failed: ' + scrub(error.stderr || error.message))}
}
const docker = (...args) => command('docker', args)
function save() {mkdirSync(output,{recursive:true});writeFileSync(join(output,'platform-proof.json'),JSON.stringify(report,null,2))}
function safeRemove(path) {
  const rel = relative(realpathSync(process.env.RUNNER_TEMP), realpathSync(path))
  if (!rel || rel.startsWith('..') || isAbsolute(rel)) throw Error('Cleanup escaped owned runner temporary directory')
  rmSync(path,{recursive:true,force:true})
}
async function main() {
  if(process.platform!=='linux'||process.env.GITHUB_ACTIONS!=='true'||!/^\d+$/.test(process.env.GITHUB_RUN_ID||'')) throw Error('Existing disposable Linux GitHub CI only')
  if(!process.env.RUNNER_TEMP || !isAbsolute(process.env.RUNNER_TEMP)) throw Error('Missing runner temporary root')
  report.candidate = execFileSync('git',['rev-parse','HEAD'],{cwd:source,encoding:'utf8'}).trim()
  report.tree = execFileSync('git',['rev-parse','HEAD^{tree}'],{cwd:source,encoding:'utf8'}).trim()
  report.runId = process.env.GITHUB_RUN_ID
  if(report.candidate!==process.env.GITHUB_SHA) throw Error('Actual runner differs from candidate')
  if(execFileSync('git',['status','--porcelain','--untracked-files=no'],{cwd:source,encoding:'utf8'}).trim()) throw Error('Tracked checkout must be clean')
  const files=execFileSync('git',['ls-files','-z'],{cwd:source}).toString().split('\0').filter(f=>/\.(tsx?|mjs|json|sql|ya?ml|toml)$/.test(f))
  for(const f of files)report.sourcePins[f]=digest(readFileSync(join(source,f)))
  taskRoot=mkdtempSync(join(realpathSync(process.env.RUNNER_TEMP),'edgequote-auth-save-'))
  if(!relative(source,taskRoot).startsWith('..')) throw Error('Disposable root must be outside entire source checkout')
  platform=join(taskRoot,'platform');mkdirSync(join(platform,'supabase'),{recursive:true})
  const home=join(taskRoot,'home');mkdirSync(home)
  env={PATH:process.env.PATH,HOME:home,CI:'true',GITHUB_ACTIONS:'true',SUPABASE_TELEMETRY_DISABLED:'1',DO_NOT_TRACK:'1',NEXT_TELEMETRY_DISABLED:'1'}
  writeFileSync(join(platform,'supabase/config.toml'),readFileSync(join(source,'scripts/authenticated-quote-save/disposable-config.toml')))
  report.configSha256=digest(readFileSync(join(platform,'supabase/config.toml')))
  report.sourceDirectory=source;report.disposableDirectory=taskRoot
  if(docker('ps','-a','--format','{{.Names}}').split('\n').some(n=>n.includes(project))) throw Error('Existing matching platform containers; refusing')
  if(docker('volume','ls','--format','{{.Name}}').split('\n').some(n=>n.includes(project))) throw Error('Existing matching platform volumes; refusing')
  const archive=join(taskRoot,'supabase.tar.gz')
  const response=await fetch('https://github.com/supabase/cli/releases/download/v2.117.0/supabase_linux_amd64.tar.gz')
  if(!response.ok)throw Error('Pinned CLI archive download failed')
  const bytes=Buffer.from(await response.arrayBuffer())
  report.cliArchiveSha256=digest(bytes)
  if(report.cliArchiveSha256!=='69c05f85b9e47ee706d30f1a6ca8a526b4e337bfd12c7ef1ef522d24e7280d24')throw Error('Pinned CLI archive mismatch')
  writeFileSync(archive,bytes)
  command('tar',['-xzf',archive,'-C',taskRoot]);cli=join(taskRoot,'supabase');chmodSync(cli,0o755)
  report.cliVersion=command(cli,['--version']).trim()
  if(report.cliVersion!=='2.117.0')throw Error('CLI version mismatch')
  report.cliHelp={}
  for(const verb of ['', 'start','status','stop'])report.cliHelp[verb||'root']=command(cli,[...(verb?[verb]:[]),'--help'])
  if(!report.cliHelp.start.includes('--network-id')||!report.cliHelp.stop.includes('--no-backup'))throw Error('Reviewed CLI flags unavailable')
  const images=['supabase/postgres:17.6.1.167','kong:2.8.1','supabase/gotrue:v2.196.0','postgrest/postgrest:v16.2','supabase/storage-api:v1.72.1']
  report.expectedImages=images
  for(const img of images) docker('pull',img)
  docker('network','create','--internal','--label','edgequote.auth-save='+process.env.GITHUB_RUN_ID,network);netCreated=true
  report.events.push({event:'internal network created',at:new Date().toISOString()})
  // CLI output includes local keys; capture silently and never place it in artifacts.
  command(cli,['start','--network-id',network,'--exclude','realtime,imgproxy,mailpit,postgres-meta,studio,edge-runtime,logflare,vector,supavisor'],480000)
  const names=docker('ps','--format','{{.Names}}').trim().split('\n').filter(n=>n.includes(project))
  const expected=['db','kong','auth','rest','storage'].map(s=>'supabase_'+s+'_'+project)
  if(names.length!==expected.length||expected.some(n=>!names.includes(n)))throw Error('Unexpected running platform container set: '+names.join(','))
  const inspect=JSON.parse(docker('inspect',...names))
  const networkInfo=JSON.parse(docker('network','inspect',network))[0]
  if(networkInfo.Internal!==true)throw Error('Platform network is not internal')
  report.network={id:networkInfo.Id,name:network,internal:networkInfo.Internal}
  report.containers=inspect.map(c=>({name:c.Name.slice(1),pid:c.State.Pid,running:c.State.Running,health:c.State.Health?.Status,
    image:c.Config.Image,imageId:c.Image,networks:Object.keys(c.NetworkSettings.Networks),
    digests:JSON.parse(docker('image','inspect',c.Image))[0].RepoDigests}))
  for(const c of report.containers){
    if(!c.running||(c.health&&c.health!=='healthy')||c.networks.length!==1||c.networks[0]!==network)throw Error('Unhealthy or externally attached container '+c.name)
    const suffix=c.name.replace('supabase_','').replace('_'+project,'')
    const idx={db:0,kong:1,auth:2,rest:3,storage:4}[suffix]
    // Official CLI may add docker.io/library to the same pinned image reference.
    const normalized=c.image.replace(/^docker.io\//,'').replace(/^library\//,'')
    if(normalized!==images[idx])throw Error('Platform image override: '+c.image)
  }
  const status=JSON.parse(command(cli,['status','--output','json']))
  const api=new URL(status.API_URL),dbURL=new URL(status.DB_URL)
  if(!['127.0.0.1','localhost'].includes(api.hostname)||api.port!=='8000'||!['127.0.0.1','localhost'].includes(dbURL.hostname)||dbURL.port!=='54322'||dbURL.pathname!=='/postgres')throw Error('CLI returned unexpected disposable targets')
  if(!status.ANON_KEY||!status.SERVICE_ROLE_KEY||!dbURL.password)throw Error('Actual local platform credentials missing')
  sensitive.push(status.ANON_KEY,status.SERVICE_ROLE_KEY,decodeURIComponent(dbURL.password))
  const gateway=inspect.find(c=>c.Name==='/supabase_kong_'+project)
  const db=inspect.find(c=>c.Name==='/supabase_db_'+project)
  const dbHost=db.NetworkSettings.Networks[network].IPAddress
  if(!/^172\.|^10\.|^192\.168\./.test(dbHost))throw Error('Unexpected internal DB address')
  const input={source,taskRoot,output,marker,apiUrl:'http://127.0.0.1:8000',origin:'http://127.0.0.1:3000',
    anonKey:status.ANON_KEY,serviceKey:status.SERVICE_ROLE_KEY,dbHost,dbPassword:decodeURIComponent(dbURL.password),
    gatewayPid:gateway.State.Pid,candidate:report.candidate,tree:report.tree,runId:report.runId,
    chrome:command('which',['google-chrome']).trim()}
  const inputPath=join(taskRoot,'private-workload.json');writeFileSync(inputPath,JSON.stringify(input),{mode:0o600})
  const childEnv={...env,HOME:home,NODE_ENV:'development',GITHUB_RUN_ID:report.runId,GITHUB_SHA:report.candidate,
    PILOT_AUTH_SAVE_MARKER:marker,NEXT_PUBLIC_APP_URL:input.origin,NEXT_PUBLIC_SUPABASE_URL:input.apiUrl,
    NEXT_PUBLIC_SUPABASE_ANON_KEY:input.anonKey,SUPABASE_SERVICE_ROLE_KEY:input.serviceKey}
  // Enter only the verified gateway network namespace. Files/processes remain disposable runner-owned.
  const args=['-n','nsenter','--target',String(gateway.State.Pid),'--net','setpriv',
    '--reuid='+process.getuid(),'--regid='+process.getgid(),'--clear-groups','env','-i',
    ...Object.entries(childEnv).map(([k,v])=>k+'='+v),process.execPath,join(source,'scripts/authenticated-quote-save/real-workload.mjs'),inputPath]
  let childOutput=''
  await new Promise((done,reject)=>{
    child=spawn('sudo',args,{cwd:source,env,detached:true,stdio:['ignore','pipe','pipe']})
    let timedOut=false,hardStop
    const terminate=signal=>{try{command('sudo',['-n','kill','-'+signal,'--','-'+child.pid],10000)}catch{}}
    const timer=setTimeout(()=>{
      timedOut=true;terminate('TERM')
      hardStop=setTimeout(()=>terminate('KILL'),30000)
    },720000)
    child.stdout.on('data',b=>{childOutput=(childOutput+b).slice(-10000)})
    child.stderr.on('data',b=>{childOutput=(childOutput+b).slice(-10000)})
    child.on('error',error=>{clearTimeout(timer);clearTimeout(hardStop);reject(error)})
    child.on('exit',(code)=>{clearTimeout(timer);clearTimeout(hardStop);code===0&&!timedOut?done():reject(Error('Disposable workload exit '+code+(timedOut?' after bounded timeout':'')+': '+scrub(childOutput)))})
  })
  const proof=JSON.parse(readFileSync(join(output,'browser-proof.json'),'utf8'))
  report.workloadSha256=digest(readFileSync(join(output,'browser-proof.json')))
  if(proof.pass!==true||proof.candidate!==report.candidate||proof.tree!==report.tree)throw Error('Workload proof failed or source mismatch')
  if(execFileSync('git',['rev-parse','HEAD'],{cwd:source,encoding:'utf8'}).trim()!==report.candidate
    ||execFileSync('git',['rev-parse','HEAD^{tree}'],{cwd:source,encoding:'utf8'}).trim()!==report.tree
    ||execFileSync('git',['status','--porcelain','--untracked-files=no'],{cwd:source,encoding:'utf8'}).trim())throw Error('Source checkout changed during workload')
  for(const [file,pin] of Object.entries(report.sourcePins))if(digest(readFileSync(join(source,file)))!==pin)throw Error('Source pin changed during workload: '+file)
  report.sourceUnchangedAfterWorkload=true
  report.pass=true
}
try{await main()}catch(error){report.error=scrub(error.message)}
finally{
  if(cli&&platform){
    try{command(cli,['stop','--no-backup'],180000);report.cleanup.cliStopped=true}
    catch(error){report.cleanup.error=scrub(error.message);report.pass=false}
  }
  if(env&&taskRoot){
    try{
      const remaining=docker('ps','-a','--format','{{.Names}}').split('\n').filter(n=>n.includes(project))
      report.cleanup.remainingContainers=remaining
      if(remaining.length)throw Error('Owned containers remain after stop')
      report.cleanup.remainingVolumes=docker('volume','ls','--format','{{.Name}}').split('\n').filter(n=>n.includes(project))
      if(report.cleanup.remainingVolumes.length)throw Error('Owned volumes remain after stop')
      if(netCreated){docker('network','rm',network);report.cleanup.networkRemoved=true}
    }catch(error){report.cleanup.error=scrub(error.message);report.pass=false}
    try{safeRemove(taskRoot);report.cleanup.temporaryDirectoryRemoved=!existsSync(taskRoot)}
    catch(error){report.cleanup.privateTemporaryError=scrub(error.message);report.pass=false}
  }
  report.completedAt=new Date().toISOString();save()
  console.log(JSON.stringify({pass:report.pass,candidate:report.candidate,error:report.error,cleanup:report.cleanup,output:join(output,'platform-proof.json')}))
  if(!report.pass)process.exitCode=1
}
