// P30 Render-compatible staging relay protocol, loopback only; never deploy directly.
import {createServer} from 'node:http';
import {timingSafeEqual,randomBytes} from 'node:crypto';
import {createAuthenticatedIngress} from './staging-relay-authenticated-ingress.mjs';
import {createSignedRelayEnvelope} from './staging-relay-envelope-auth.mjs';
const validId=x=>typeof x==='string'&&/^[A-Za-z0-9_-]{1,80}$/.test(x);
export function createStagingRelayServer({token,signingSecret,maxBodyBytes=65536,durableQueue=null,exclusiveOwner=null,ingressPolicy=null,externalIngress=null}={}){
 if(typeof token!=='string'||token.length<32||typeof signingSecret!=='string'||signingSecret.length<32)throw Error('P30_CREDENTIALS_REQUIRED');
 const queue=[];const records=new Map();let bound=false;
 const ingressHandler=externalIngress?createAuthenticatedIngress({...externalIngress,enqueue:(body)=>enqueue(body)}):null;
 const server=createServer(async(req,res)=>{
  res.setHeader('content-type','application/json');res.setHeader('cache-control','no-store');
  if(req.url==='/enqueue'){if(!ingressHandler){res.writeHead(404);return res.end('{}')}return ingressHandler(req,res)}
  const supplied=req.headers.authorization||'';const expected='Bearer '+token;
  if(Buffer.byteLength(supplied)!==Buffer.byteLength(expected)||!timingSafeEqual(Buffer.from(supplied),Buffer.from(expected))){res.writeHead(401);return res.end('{}')}
  if(req.method!=='POST'||req.url!=='/relay'){res.writeHead(404);return res.end('{}')}
  let chunks=[],length=0;try{for await(const c of req){length+=c.length;if(length>maxBodyBytes)throw Error('BODY_LIMIT');chunks.push(c)}const body=JSON.parse(Buffer.concat(chunks).toString('utf8'));if(!validId(body.instanceId))throw Error('INSTANCE_REQUIRED');
   if(body.kind==='poll'){
    const item=durableQueue?await durableQueue.lease(body.instanceId):queue.find(x=>x.status==='queued'||x.status==='leased'&&x.instanceId===body.instanceId);
    if(!item)return res.end(JSON.stringify({kind:'idle'}));
    if(!durableQueue&&item.status==='queued'){item.status='leased';item.instanceId=body.instanceId}
    return res.end(JSON.stringify(createSignedRelayEnvelope(signingSecret,{kind:'request',id:item.id,instanceId:item.instanceId,timestamp:Date.now(),nonce:randomBytes(16).toString('hex'),tool:item.tool,...(item.projectKey?{projectKey:item.projectKey}:{}),arguments:item.arguments})));
   }
   if(body.kind==='result'&&validId(body.id)){
    const item=durableQueue?await durableQueue.inspect(body.id):records.get(body.id);if(!item||item.status!=='leased'&&item.status!=='completed'||item.instanceId!==body.instanceId){res.writeHead(409);return res.end('{}')}
    if(durableQueue)await durableQueue.complete(body.id,body.instanceId,body.result);else if(item.status==='leased'){item.result=body.result;item.status='completed'}
    return res.end(JSON.stringify(createSignedRelayEnvelope(signingSecret,{kind:'ack',id:item.id,instanceId:item.instanceId,timestamp:Date.now(),nonce:randomBytes(16).toString('hex')})));
   }
   res.writeHead(400);res.end('{}');
  }catch{res.writeHead(400);res.end('{}')}
 });
 function enqueue({id,tool,projectKey,arguments:args={}}){if(ingressPolicy){const authorized=ingressPolicy.authorize({id,tool,projectKey,arguments:args});({id,tool,projectKey,arguments:args}=authorized)}if(durableQueue)return durableQueue.enqueue({id,tool,projectKey,arguments:args});if(bound===false)throw Error('P30_NOT_LISTENING');if(!validId(id)||records.has(id)||!['health','fs.list','fs.read_text','fs.stat','fs.exists'].includes(tool))throw Error('P30_REQUEST_DENIED');const item={id,tool,projectKey,arguments:args,status:'queued'};records.set(id,item);queue.push(item);return id}
 async function listen({host='127.0.0.1',port=0}={}){if(host!=='127.0.0.1'&&host!=='0.0.0.0'||!Number.isInteger(port)||port<0||port>65535)throw Error('P38_BIND_DENIED');if(bound)throw Error('P30_ALREADY_LISTENING');if(exclusiveOwner)await exclusiveOwner.acquire();try{if(durableQueue)await durableQueue.initialize();await new Promise((resolve,reject)=>server.listen(port,host,e=>e?reject(e):resolve()));bound=true;return {host,port:server.address().port}}catch(e){if(exclusiveOwner)await exclusiveOwner.release();throw e}}
 async function close(){if(server.listening)await new Promise(resolve=>server.close(resolve));bound=false;if(exclusiveOwner)await exclusiveOwner.release()}
 return {listen,close,enqueue,server,getStatus:id=>(durableQueue?durableQueue.inspect(id):records.get(id))?.status,getResult:id=>(durableQueue?durableQueue.inspect(id):records.get(id))?.result};
}
