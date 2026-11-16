import test from 'node:test';
import assert from 'node:assert/strict';
import {createStagingRelayServer} from './staging-render-relay-protocol.mjs';
import {createV2McpHandler} from './staging-mcp-v2-handler.mjs';

test('MCP endpoint on existing V2 relay preserves private relay security',async()=>{
 const queue={async enqueue(){throw Error('UNEXPECTED_ENQUEUE')},async inspect(){return null}};
 const handler=createV2McpHandler({
  queue,verifyAccessToken:async token=>token==='authorized'?{sub:'integration-user',scopes:['autsys.v2.read'],projectKeys:['demo']}:null,
  resourceUrl:'https://bridge.example.test/mcp',authorizationServer:'https://idp.example.test',
  projectKeys:['demo'],allowedOrigins:[]});
 const relay=createStagingRelayServer({token:'r'.repeat(48),signingSecret:'s'.repeat(48),mcpHandler:handler});
 const bound=await relay.listen({host:'127.0.0.1',port:0});
 const base='http://127.0.0.1:'+bound.port;
 try{
  let r=await fetch(base+'/relay',{method:'POST',headers:{'content-type':'application/json'},body:'{}'});
  assert.equal(r.status,401);
  r=await fetch(base+'/enqueue',{method:'POST',headers:{'content-type':'application/json'},body:'{}'});
  assert.equal(r.status,404);
  r=await fetch(base+'/mcp',{method:'POST',headers:{authorization:'Bearer authorized',accept:'application/json','content-type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id:1,method:'initialize',params:{protocolVersion:'2025-03-26',capabilities:{},clientInfo:{name:'test',version:'1'}}})});
  assert.equal(r.status,200);
  const payload=await r.json();
  assert.equal(payload.result.serverInfo.name,'AUTSYS-PC-BRIDGE-V2');
  r=await fetch(base+'/mcp',{method:'POST',headers:{authorization:'Bearer authorized',origin:'https://untrusted.example',accept:'application/json','content-type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id:2,method:'tools/list'})});
  assert.equal(r.status,403);
 }finally{await relay.close()}
});
