import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {generateKeyPairSync,createSign} from 'node:crypto';
import {createV2McpHandler} from './staging-mcp-v2-handler.mjs';
import {createV2OAuthJwtVerifier} from './staging-mcp-v2-oauth.mjs';

const resourceUrl='https://bridge-v2.example.test/mcp';
const body=(id,method,params)=>({jsonrpc:'2.0',id,method,...(params?{params}:{})});
const fakeQueue=()=>{
 const records=new Map();
 return {records,async enqueue(req){records.set(req.id,{...req,status:'completed',result:{ok:true,tool:req.tool}});return req.id},async inspect(id){return records.get(id)||null}};
};
async function mockServer(handler){
 const server=createServer((req,res)=>{Promise.resolve(handler(req,res)).then(handled=>{if(!handled){res.writeHead(404);res.end()}}).catch(e=>{res.writeHead(500);res.end(String(e))})});
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 return {server,url:'http://127.0.0.1:'+server.address().port,close:()=>new Promise(resolve=>server.close(resolve))};
}
const headers={authorization:'Bearer goodtoken',accept:'application/json, text/event-stream','content-type':'application/json'};
test('MCP V2 authorization, list, direct health, project access and status',async()=>{
 const queue=fakeQueue();
 const handle=createV2McpHandler({queue,resourceUrl,authorizationServer:'https://auth.example.test',
  projectKeys:['demo'],allowedOrigins:[],verifyAccessToken:async token=>token==='goodtoken'?{sub:'test-user',scopes:['autsys.v2.read'],projectKeys:['demo']}:null});
 const ctx=await mockServer(handle);
 try{
  const post=(payload,h=headers)=>fetch(ctx.url+'/mcp',{method:'POST',headers:h,body:JSON.stringify(payload)});
  let res=await post(body(1,'initialize'),{...headers,authorization:'Bearer invalid'});
  assert.equal(res.status,401);
  res=await fetch(ctx.url+'/.well-known/oauth-protected-resource/mcp');
  assert.equal(res.status,200);
  assert.equal((await res.json()).resource,resourceUrl);
  res=await post(body(2,'initialize'));
  assert.equal(res.status,200);
  assert.equal((await res.json()).result.serverInfo.name,'AUTSYS-PC-BRIDGE-V2');
  res=await post(body(3,'tools/list'));
  assert.deepEqual((await res.json()).result.tools.map(x=>x.name),['health','fs.exists','fs.stat','fs.list','fs.read_text','request_status']);
  res=await post(body(4,'tools/call',{name:'health',arguments:{}}));
  let reply=await res.json();
  assert.equal(res.status,200);assert.equal(reply.result.isError,false);
  const health=JSON.parse(reply.result.content[0].text);
  assert.equal(health.result.tool,'health');
  res=await post(body(5,'tools/call',{name:'fs.exists',arguments:{projectKey:'unknown',path:'file.txt'}}));
  assert.equal((await res.json()).error.code,-32602);
  res=await post(body(6,'tools/call',{name:'fs.exists',arguments:{projectKey:'demo',path:'file.txt'}}));
  reply=await res.json();
  const valid=JSON.parse(reply.result.content[0].text);
  assert.equal(valid.result.tool,'fs.exists');
  res=await post(body(7,'tools/call',{name:'request_status',arguments:{requestId:valid.requestId,projectKey:'demo'}}));
  assert.equal(JSON.parse((await res.json()).result.content[0].text).status,'completed');
  res=await post(body(8,'tools/call',{name:'request_status',arguments:{requestId:valid.requestId}}));
  assert.equal(JSON.parse((await res.json()).result.content[0].text).status,'not_found');
  res=await post(body(9,'tools/call',{name:'request_status',arguments:{requestId:health.requestId}}));
  assert.equal(JSON.parse((await res.json()).result.content[0].text).status,'completed');
  res=await post(body(10,'tools/call',{name:'fs.exists',arguments:{projectKey:'demo',path:'../private'}}));
  assert.equal((await res.json()).error.code,-32602);
 }finally{await ctx.close()}
});
test('OAuth RS256 verifier denies unsigned/wrong audience and verifies scopes',async()=>{
 const {privateKey,publicKey}=generateKeyPairSync('rsa',{modulusLength:2048});
 const kid='testkey';const jwk=publicKey.export({format:'jwk'});jwk.kid=kid;jwk.use='sig';
 const now=Math.floor(Date.now()/1000);
 const sign=(claim,header={alg:'RS256',kid,typ:'JWT'})=>{
  const p=[header,claim].map(x=>Buffer.from(JSON.stringify(x)).toString('base64url')).join('.');
  const signature=createSign('RSA-SHA256').update(p).end().sign(privateKey).toString('base64url');
  return p+'.'+signature;
 };
 const verify=createV2OAuthJwtVerifier({issuer:'https://auth.example.test',jwksUri:'https://auth.example.test/jwks',audience:resourceUrl,
  fetchImpl:async()=>({ok:true,json:async()=>({keys:[jwk]})})});
 const claims={iss:'https://auth.example.test',aud:resourceUrl,sub:'operator-1',exp:now+3600,iat:now,scope:'autsys.v2.read',autsys_projects:['demo']};
 const valid=await verify(sign(claims));
 assert.equal(valid.sub,'operator-1');assert.deepEqual(valid.projectKeys,['demo']);
 assert.equal(await verify(sign({...claims,aud:'https://wrong.test'})),null);
 assert.equal(await verify(sign({...claims,exp:now-100})),null);
 assert.equal(await verify(sign(claims,{alg:'none',kid})),null);
});
