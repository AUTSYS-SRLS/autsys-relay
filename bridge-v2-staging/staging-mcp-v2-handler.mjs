// AUTSYS V2 independent stateless MCP endpoint (staging only).
// Requests are read-only, authenticated with an external OAuth access token,
// and dispatched exclusively through the isolated V2 Redis relay queue.
import {randomUUID} from 'node:crypto';

const READ_TOOLS = new Set(['health','fs.exists','fs.stat','fs.list','fs.read_text']);
const MAX_BODY_BYTES = 8192;
const DEFAULT_WAIT_MS = 12000;
const json=(res,status,body,headers={})=>{
  res.writeHead(status,{'content-type':'application/json','cache-control':'no-store',...headers});
  res.end(JSON.stringify(body));
};
const rpc=(id,result)=>({jsonrpc:'2.0',id,result});
const rpcError=(id,code,message)=>({jsonrpc:'2.0',id,error:{code,message}});
const schemas = {
  health:{type:'object',properties:{},additionalProperties:false},
  fs:{type:'object',properties:{projectKey:{type:'string'},path:{type:'string'}},required:['projectKey','path'],additionalProperties:false},
  request_status:{type:'object',properties:{requestId:{type:'string'},projectKey:{type:'string'}},required:['requestId','projectKey'],additionalProperties:false}
};
const info=(name)=>({name,description:'AUTSYS PC Bridge V2 isolated read-only '+name,
  inputSchema:name==='health'?schemas.health:name==='request_status'?schemas.request_status:schemas.fs,
  annotations:{readOnlyHint:true,destructiveHint:false,openWorldHint:false}});
const validId=(v)=>typeof v==='string'&&/^[A-Za-z0-9_-]{1,80}$/.test(v);
const allowedTool=(name,args,projects)=>{
  if(name==='health') return Object.keys(args).length===0?{tool:'health',arguments:{}}:null;
  if(!READ_TOOLS.has(name))return null;
  if(!validId(args.projectKey)||!projects.includes(args.projectKey))return null;
  if(typeof args.path!=='string'||!args.path||args.path.length>512||Object.keys(args).some(k=>!['projectKey','path'].includes(k)))return null;
  if(args.path.includes('\\')||args.path.includes('..')||args.path.includes('\0'))return null;
  return {tool:name,projectKey:args.projectKey,arguments:{path:args.path}};
};
const sleep=(ms)=>new Promise(resolve=>setTimeout(resolve,ms));
async function bodyJson(req,maxBody){
  if(Number(req.headers['content-length'])>maxBody)throw Error('BODY_LIMIT');
  let count=0,buf=[];
  for await(const chunk of req){count+=chunk.length;if(count>maxBody)throw Error('BODY_LIMIT');buf.push(chunk)}
  return JSON.parse(Buffer.concat(buf).toString('utf8'));
}
export function createV2McpHandler({queue,verifyAccessToken,resourceUrl,authorizationServer,projectKeys=[],allowedOrigins=[],waitMs=DEFAULT_WAIT_MS,now=()=>Date.now()}={}){
 if(!queue||typeof queue.enqueue!=='function'||typeof queue.inspect!=='function'||typeof verifyAccessToken!=='function')throw Error('MCP_V2_DEPENDENCIES_REQUIRED');
 if(!resourceUrl?.startsWith('https://')||!authorizationServer?.startsWith('https://'))throw Error('MCP_V2_OAUTH_REQUIRED');
 if(!Array.isArray(projectKeys)||!projectKeys.every(validId)||waitMs<100||waitMs>20000)throw Error('MCP_V2_CONFIG_DENIED');
 const resource=new URL(resourceUrl);
 const metadataPath='/.well-known/oauth-protected-resource'+resource.pathname;
 const protectedMetadata={resource:resourceUrl,authorization_servers:[authorizationServer],scopes_supported:['autsys.v2.read']};
 const tools=['health','fs.exists','fs.stat','fs.list','fs.read_text','request_status'].map(info);
 return async function handle(req,res){
  const path=(req.url||'').split('?')[0];
  if(path!==resource.pathname&&path!==metadataPath)return false;
  const origin=req.headers.origin;
  if(origin&&(!allowedOrigins.includes(origin))) {json(res,403,{error:'ORIGIN_DENIED'});return true}
  if(path===metadataPath){if(req.method!=='GET'){json(res,405,{error:'METHOD_NOT_ALLOWED'});return true}json(res,200,protectedMetadata);return true}
  if(req.method!=='POST'){json(res,405,{error:'MCP_POST_REQUIRED'});return true}
  const auth=String(req.headers.authorization||'');
  const token=auth.startsWith('Bearer ')?auth.slice(7):'';
  let identity;
  try{identity=token?await verifyAccessToken(token):null}catch{identity=null}
  if(!identity||!Array.isArray(identity.scopes)||!identity.scopes.includes('autsys.v2.read')){
   json(res,401,{error:'OAUTH_TOKEN_REQUIRED'},{'WWW-Authenticate':'Bearer resource_metadata="'+new URL(metadataPath,resource).href+'"'});
   return true;
  }
  if(!String(req.headers.accept||'').includes('application/json')){json(res,406,{error:'MCP_ACCEPT_REQUIRED'});return true}
  let msg;
  try{msg=await bodyJson(req,MAX_BODY_BYTES)}catch{json(res,400,rpcError(null,-32700,'Invalid JSON'));return true}
  if(!msg||Array.isArray(msg)||msg.jsonrpc!=='2.0'||typeof msg.method!=='string'||(Object.hasOwn(msg,'id')&&!['string','number'].includes(typeof msg.id))){
   json(res,400,rpcError(null,-32600,'Invalid Request'));return true;
  }
  if(!Object.hasOwn(msg,'id')){res.writeHead(202,{'cache-control':'no-store'});res.end();return true}
  const id=msg.id;
  if(msg.method==='initialize'){
   json(res,200,rpc(id,{protocolVersion:'2026-07-28',capabilities:{tools:{}},serverInfo:{name:'AUTSYS-PC-BRIDGE-V2',version:'0.1.0'}}));return true;
  }
  if(msg.method==='ping'){json(res,200,rpc(id,{}));return true}
  if(msg.method==='tools/list'){json(res,200,rpc(id,{tools}));return true}
  if(msg.method!=='tools/call'){json(res,200,rpcError(id,-32601,'Method not found'));return true}
  const p=msg.params;
  if(!p||Array.isArray(p)||typeof p!=='object'||typeof p.name!=='string'||!p.arguments||typeof p.arguments!=='object'||Array.isArray(p.arguments)){
   json(res,200,rpcError(id,-32602,'Invalid params'));return true;
  }
  const args=p.arguments;
  const readable=identity.projectKeys===undefined?projectKeys:projectKeys.filter(k=>identity.projectKeys.includes(k));
  if(p.name==='request_status'){
   if(!validId(args.requestId)||!validId(args.projectKey)||!readable.includes(args.projectKey)||Object.keys(args).some(k=>!['requestId','projectKey'].includes(k))){
    json(res,200,rpcError(id,-32602,'Invalid request status'));return true;
   }
   try{
    const item=await queue.inspect(args.requestId);
    const safe=item&&item.projectKey===args.projectKey?{status:item.status,result:item.status==='completed'?item.result:undefined}:null;
    json(res,200,rpc(id,{content:[{type:'text',text:JSON.stringify(safe??{status:'not_found'})}],isError:false}));
   }catch{json(res,200,rpc(id,{content:[{type:'text',text:JSON.stringify({error:'STATUS_UNAVAILABLE'})}],isError:true}))}
   return true;
  }
  const request=allowedTool(p.name,args,readable);
  if(!request){json(res,200,rpcError(id,-32602,'Read-only tool or project denied'));return true}
  const requestId='mcp'+randomUUID().replaceAll('-','');
  try{
   await queue.enqueue({...request,id:requestId});
   const deadline=now()+waitMs;
   do{
    const item=await queue.inspect(requestId);
    if(item?.status==='completed'){
      json(res,200,rpc(id,{content:[{type:'text',text:JSON.stringify({requestId,status:'completed',result:item.result})}],isError:false}));
      return true;
    }
    await sleep(Math.min(200,Math.max(1,deadline-now())));
   }while(now()<deadline);
   // Never re-enqueue uncertain outcomes. Client can explicitly inspect request status.
   json(res,200,rpc(id,{content:[{type:'text',text:JSON.stringify({requestId,status:'pending',advice:'Use request_status; do not repeat a mutation'})}],isError:true}));
  }catch{
   json(res,200,rpc(id,{content:[{type:'text',text:JSON.stringify({requestId,error:'BRIDGE_V2_UNAVAILABLE'})}],isError:true}));
  }
  return true;
 };
}
