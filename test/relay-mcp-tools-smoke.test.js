import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { spawn } from "node:child_process";

const expectedTools = [
  "relay_get_diagnostics", "relay_events_inspect", "relay_commands_inspect",
  "relay_auth_status", "relay_redis_status", "autsys_http_authenticated_read"
];
const diagHash="d4581386154206142b0ee9c51d5491ea1baa1864fa1dfd30fc91bf6bc909273f";
const eventsHash="659db4d0071727e6fc2aff17182b237c336f7bd7d2318ccc0031e54c6162d221";
const auth="test-control-token-only";
const diagResult=(run)=>JSON.stringify({
  run,timestamp_utc:"2026-10-21T10:00:0"+run+"Z",
  service:"autsys-central-relay",version:"0.3.1",protocol:2,
  manager_events_queued:0,commands_queued:1,manager_installations_with_commands:1,
  persistence:"durable_key_value_binding_registry+ephemeral_transport",
  manager_binding_mode:"TOFU",manager_license_enforcement:"ON",
  relay_ts:1792576800+run,http_status:200,elapsed_ms:10
});
async function getFreePort() {
  const s=createServer();
  await new Promise(resolve=>s.listen(0,"127.0.0.1",resolve));
  const n=s.address().port;
  await new Promise(resolve=>s.close(resolve));
  return n;
}
async function shutdown(child) {
  if (!child || child.exitCode!==null) return;
  child.kill("SIGTERM");
  await Promise.race([
    new Promise(resolve=>child.once("exit",resolve)),
    new Promise(resolve=>setTimeout(resolve,2000))
  ]);
  if (child.exitCode===null) child.kill("SIGKILL");
}
function fakeBridge(operations) {
  return createServer(async(req,res)=>{
    try {
      if(req.url!=="/api/execute"||req.method!=="POST"||req.headers.authorization!=="Bearer "+auth){
        res.writeHead(403);res.end(JSON.stringify({error:"TEST_AUTH_FAILED"}));return;
      }
      const chunks=[];
      for await(const chunk of req) chunks.push(chunk);
      const reqObj=JSON.parse(Buffer.concat(chunks).toString());
      const {tool,arguments:args}=reqObj;
      operations.push({tool,args});
      let result;
      if(tool==="fs.hash"){
        const name=String(args.path);
        if(!name.endsWith(".ps1")) throw new Error("TEST_SCRIPT_PATH_NOT_FIXED");
        result={sha256:name.includes("DIAG_READONLY")?diagHash:eventsHash,sizeBytes:123};
      }else if(tool==="process.start"){
        if(args.kind!=="powershell"||!String(args.target).endsWith(".ps1"))
          throw new Error("TEST_START_DENIED");
        result={processId:String(args.target).includes("DIAG_READONLY")?"test-diag":"test-events"};
      }else if(tool==="process.status"){
        const diag=args.processId==="test-diag";
        result={processId:args.processId,running:false,exitCode:0,
          stdout:diag ? "RELAY_DIAG_JSON "+diagResult(1)+"\r\n"+
              "RELAY_DIAG_JSON "+diagResult(2)+"\r\n" :
              "RELAY_EVENTS_JSON "+JSON.stringify({
                ok:true,timestamp_utc:"2026-10-21T10:00:00Z",
                count:0,items:[],http_status:200,elapsed_ms:10,payloads_returned:false
              })+"\r\n",stderr:""};
      }else{
        throw new Error("FORBIDDEN_TEST_BRIDGE_OPERATION_"+tool);
      }
      res.writeHead(200,{"content-type":"application/json"});
      res.end(JSON.stringify({ok:true,bridgeResponse:{ok:true,result}}));
    }catch(e){
      res.writeHead(500,{"content-type":"application/json"});
      res.end(JSON.stringify({ok:false,error:String(e.message)}));
    }
  });
}
async function rpc(port,method,params,id) {
  const response=await fetch("http://127.0.0.1:"+port+"/mcp",{
    method:"POST",
    headers:{"content-type":"application/json","accept":"application/json, text/event-stream",
      "mcp-protocol-version":"2025-03-26"},
    body:JSON.stringify({jsonrpc:"2.0",id,method,params})
  });
  const raw=await response.text();
  if(response.status!==200)
    throw new Error("MCP HTTP "+response.status+": "+raw.slice(0,1300));
  if(raw.startsWith("event:")){
    const line=raw.split(/\r?\n/).find(x=>x.startsWith("data: "));
    if(!line)throw new Error("MCP event-stream missing data");
    return JSON.parse(line.slice(6));
  }
  return JSON.parse(raw);
}
function content(result){
  if(result.error)throw new Error("MCP RPC error "+JSON.stringify(result.error));
  const text=result.result?.content?.find(x=>x.type==="text")?.text;
  if(!text)throw new Error("MCP result missing text");
  return JSON.parse(text);
}
test("MCP Relay tools available and tested end-to-end with isolated fake Bridge",async()=>{
  const port=await getFreePort();
  const bridgePort=await getFreePort();
  const operations=[];
  const backend=fakeBridge(operations);
  await new Promise(resolve=>backend.listen(bridgePort,"127.0.0.1",resolve));
  const child=spawn(process.execPath,["mcp-full-front-v3.js"],{
    cwd:process.cwd(),
    env:{...process.env,PORT:String(port),GATEWAY_INTERNAL_PORT:String(bridgePort),
      CONTROL_TOKEN:auth,RENDER_API_KEY:"",AUTSYS_RELAY_MCP_SMOKE_DELAY_MS:"300"},
    stdio:["ignore","pipe","pipe"]
  });
  let startupOutput="";
  child.stdout.on("data",chunk=>{startupOutput+=String(chunk);});
  child.stderr.on("data",chunk=>{startupOutput+=String(chunk);});
  try {
    let ready=false;
    for(let i=0;i<120;i++){
      if(child.exitCode!==null)throw new Error("MCP child exited");
      try{
        const health=await fetch("http://127.0.0.1:"+port+"/health");
        if(health.ok){ready=true;break;}
      }catch{}
      await new Promise(resolve=>setTimeout(resolve,50));
    }
    assert.equal(ready,true);
    const init=await rpc(port,"initialize",{
      protocolVersion:"2025-03-26",
      capabilities:{},
      clientInfo:{name:"autsys-relay-mcp-smoke",version:"1.0"}
    },1);
    assert.ok(!init.error,"MCP initialize succeeded");
    const listed=await rpc(port,"tools/list",{},2);
    if(listed.error)throw new Error("tools/list failed "+JSON.stringify(listed.error));
    const names=new Set((listed.result?.tools||[]).map(x=>x.name));
    for(const n of expectedTools) assert.ok(names.has(n),"Missing tool "+n);
    const diag=content(await rpc(port,"tools/call",{
      name:"relay_get_diagnostics",arguments:{}
    },3));
    assert.equal(diag.ok,true);
    assert.equal(diag.commands_queued,1);
    assert.equal(diag.manager_events_queued,0);
    assert.equal(diag.readings.length,2);
    assert.equal(diag.stable,true);
    assert.equal(diag.no_ack_sent,true);
    const events=content(await rpc(port,"tools/call",{
      name:"relay_events_inspect",arguments:{limit:20}
    },4));
    assert.equal(events.ok,true);
    assert.equal(events.count,0);
    assert.equal(events.payloads_returned,false);
    const commands=content(await rpc(port,"tools/call",{
      name:"relay_commands_inspect",arguments:{}
    },5));
    assert.equal(commands.ok,true);
    assert.equal(commands.commands_queued,1);
    assert.equal(commands.items,null);
    assert.equal(commands.no_ack_sent,true);
    const authStatus=content(await rpc(port,"tools/call",{
      name:"relay_auth_status",arguments:{}
    },6));
    assert.equal(authStatus.ok,true);
    assert.equal(authStatus.credentials_exposed,false);
    const generic=content(await rpc(port,"tools/call",{
      name:"autsys_http_authenticated_read",
      arguments:{service:"autsys-central-relay",resource:"events",limit:10}
    },7));
    assert.equal(generic.ok,true);
    assert.equal(generic.count,0);
    assert.ok(operations.length>=10,"Native mocked operations executed");
    assert.ok(operations.every(x=>["fs.hash","process.start","process.status"].includes(x.tool)));
    assert.ok(!operations.some(x=>/ack|redis\.set|delete|write/i.test(x.tool)));
    let bootChecked=false;
    for(let i=0;i<120;i++){
      if(startupOutput.includes("AUTSYS_RELAY_MCP_TYPED_SMOKE_OK")){bootChecked=true;break;}
      await new Promise(resolve=>setTimeout(resolve,50));
    }
    assert.equal(bootChecked,true,"Gateway boot MCP typed smoke must succeed: "+startupOutput.slice(-1500));
  }finally{
    await shutdown(child);
    await new Promise(resolve=>backend.close(resolve));
  }
});
