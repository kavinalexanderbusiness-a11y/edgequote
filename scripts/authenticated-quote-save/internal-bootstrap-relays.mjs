import {createServer,connect} from 'node:net'

// Host-facing compatibility for CLI bootstrap only. Docker internal networks
// allow host->container IP, but do not publish the localhost ports used by CLI.
// Forward raw bytes only; never manufacture a SQL/API reply or log payloads.
export function internalBootstrapRelays({network,project,inspect,evidence}) {
  const owned=[]
  let closing=false
  const targets=[{kind:'db',listen:54322,target:5432,image:'supabase/postgres:17.6.1.167'},
    {kind:'kong',listen:8000,target:8000,image:'kong:2.8.1'}]
  async function discover(){
    if(closing)return
    for(const target of targets){
      if(owned.some(p=>p.kind===target.kind))continue
      const name='supabase_'+target.kind+'_'+project
      const container=inspect(name)
      if(!container?.State?.Running)continue
      const image=container.Config.Image.replace(/^docker.io\//,'').replace(/^library\//,'')
      if(image!==target.image)throw Error('Bootstrap relay target image differs from reviewed version')
      if(container.Name!=='/'+name||Object.keys(container.NetworkSettings.Networks).length!==1
        ||!container.NetworkSettings.Networks[network])throw Error('Bootstrap relay target escaped expected internal network')
      const host=container.NetworkSettings.Networks[network].IPAddress
      if(!/^(?:172\.|10\.|192\.168\.)/.test(host))throw Error('Bootstrap relay target is not inspected private IP')
      const sockets=new Set()
      const entry={kind:target.kind,containerId:container.Id,containerName:name,image:container.Config.Image,imageId:container.Image,network,host,
        listenHost:'127.0.0.1',listenPort:target.listen,targetPort:target.target,connections:0,opened:false,closed:false}
      evidence.push(entry)
      const server=createServer(downstream=>{
        entry.connections++;sockets.add(downstream)
        const upstream=connect({host,port:target.target});sockets.add(upstream)
        const clear=()=>{downstream.destroy();upstream.destroy();sockets.delete(downstream);sockets.delete(upstream)}
        downstream.on('error',clear);upstream.on('error',clear)
        downstream.on('close',clear);upstream.on('close',clear)
        downstream.setTimeout(120000,clear);upstream.setTimeout(120000,clear)
        const dial=setTimeout(clear,5000)
        upstream.once('connect',()=>{clearTimeout(dial);downstream.pipe(upstream);upstream.pipe(downstream)})
        upstream.once('close',()=>clearTimeout(dial))
      })
      const relay={kind:target.kind,server,sockets,entry};owned.push(relay)
      // Do not reuse or replace an existing listener. EADDRINUSE is a hard failure.
      await new Promise((done,reject)=>{
        server.once('error',reject)
        server.listen({host:'127.0.0.1',port:target.listen,exclusive:true},()=>{
          server.removeListener('error',reject)
          server.on('error',error=>{entry.listenerError=error.code||'listener-error'})
          entry.opened=true;done()
        })
      })
    }
  }
  async function close(){
    closing=true
    for(const {server,sockets,entry} of owned){
      for(const socket of sockets)socket.destroy()
      sockets.clear()
      if(server.listening)await new Promise((done,reject)=>server.close(error=>error?reject(error):done()))
      entry.closed=!server.listening
    }
  }
  return{discover,close}
}
